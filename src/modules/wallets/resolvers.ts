import crypto, { randomBytes } from "crypto";
import { GraphQLError } from "graphql";
import { getDB, getWalletsDB, getCatalogsDB } from "../../db.js";
import type { User, Balance, Deposit, Transaction, Order, Product, Store, Review, Dispute, DisputeMessage, RefundOffer, Blacklist, Withdrawal } from "../../types.js";
import type { Context } from "../../index.js";

function getRankFromSales(totalSales: number): number {
  if (totalSales >= 10000) return 10;
  if (totalSales >= 9000) return 9;
  if (totalSales >= 7500) return 8;
  if (totalSales >= 5000) return 7;
  if (totalSales >= 3500) return 6;
  if (totalSales >= 2500) return 5;
  if (totalSales >= 1000) return 4;
  if (totalSales >= 500) return 3;
  if (totalSales >= 100) return 2;
  return 1;
}

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY!;
const ALGORITHM = "aes-256-gcm";

function decrypt(encryptedText: string): string {
  const [ivHex, authTagHex, ciphertext] = encryptedText.split(":");
  const decipher = crypto.createDecipheriv(ALGORITHM, Buffer.from(ENCRYPTION_KEY, "hex"), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  let decrypted = decipher.update(ciphertext, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

function encodeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`).toString("base64");
}

function decodeCursor(cursor: string): number {
  const decoded = Buffer.from(cursor, "base64").toString("utf-8");
  return parseInt(decoded.replace("cursor:", ""), 10);
}

function buildMessagesConnection(messages: DisputeMessage[]) {
  const reversed = [...messages].reverse();
  const edges = reversed.map((m, i) => ({
    cursor: encodeCursor(i),
    node: {
      senderId: m.senderId,
      senderName: m.senderName,
      message: m.message,
      sentAt: m.sentAt,
    },
  }));
  return {
    edges,
    pageInfo: {
      hasNextPage: false,
      hasPreviousPage: false,
      startCursor: edges.length ? edges[0].cursor : null,
      endCursor: edges.length ? edges[edges.length - 1].cursor : null,
      fetchedCount: edges.length,
      remainingCount: 0,
    },
  };
}

function getUTCDateKey(value: string): string | null {
  const date = new Date(value);
  if (isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function addDailyDelta(map: Map<string, number>, key: string, delta: number) {
  const current = map.get(key) || 0;
  map.set(key, parseFloat((current + delta).toFixed(2)));
}

function getTransactionBalanceDelta(txn: Transaction): number {
  switch (txn.type) {
    case "Deposit":
    case "Refund":
    case "PartialRefund":
      return txn.status === "completed" ? txn.amount : 0;
    case "PremiumSubscription":
    case "ProductPromotion":
    case "StorePromotion":
      return txn.status === "completed" ? -txn.amount : 0;
    case "ProductPurchase":
      if (txn.status === "failed" || txn.status === "refunded") return 0;
      return txn.status === "completed" ? -txn.amount : 0;
    case "SoldCodes":
      if (txn.status === "failed" || txn.status === "refunded") return 0;
      return txn.amount;
    default:
      return 0;
  }
}

function buildBalanceChangeSeries(
  dailyDelta: Map<string, number>,
  startDate: Date,
  endDate: Date
) {
  const points: Array<{ date: string; value: number }> = [];
  const cursor = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate()));
  const end = new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate()));

  let running = 0;
  while (cursor <= end) {
    const key = cursor.toISOString().slice(0, 10);
    running = parseFloat((running + (dailyDelta.get(key) || 0)).toFixed(2));
    points.push({ date: key, value: running });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return points;
}

function buildMonthlyBalanceChangeSeries(
  dailyDelta: Map<string, number>,
  endDate: Date,
  monthCount = 12
) {
  const endMonthStart = new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), 1));
  const startMonthStart = new Date(endMonthStart);
  startMonthStart.setUTCMonth(startMonthStart.getUTCMonth() - (monthCount - 1));

  const monthlyDelta = new Map<string, number>();
  for (const [dayKey, delta] of dailyDelta.entries()) {
    const day = new Date(`${dayKey}T00:00:00.000Z`);
    if (isNaN(day.getTime())) continue;
    if (day < startMonthStart || day > endDate) continue;

    const monthKey = dayKey.slice(0, 7);
    const current = monthlyDelta.get(monthKey) || 0;
    monthlyDelta.set(monthKey, parseFloat((current + delta).toFixed(2)));
  }

  const points: Array<{ date: string; value: number }> = [];
  const cursor = new Date(startMonthStart);
  let running = 0;

  for (let i = 0; i < monthCount; i += 1) {
    const monthKey = cursor.toISOString().slice(0, 7);
    running = parseFloat((running + (monthlyDelta.get(monthKey) || 0)).toFixed(2));
    points.push({ date: `${monthKey}-01`, value: running });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }

  return points;
}

export const walletsQueries = {
  getUserWallets: async (_: unknown, __: unknown, context: Context) => {
    if (!context.user) {
      throw new GraphQLError(context.authError || "Authentication required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const { userId } = context.user;
    const db = getDB();
    const walletsDB = getWalletsDB();

    const user = await db.collection<User>("users").findOne({ id: userId });

    const balance = await walletsDB
      .collection<Balance>("Balances")
      .findOne({ userId });

    if (!balance) {
      return { code: 404, success: false, message: "Wallet not found", wallet: null };
    }

    return {
      code: 200,
      success: true,
      message: "Wallet details retrieved successfully",
      user,
      wallet: {
        availableBalance: parseFloat(balance.availableBalance.toFixed(2)),
        suspendedBalance: parseFloat(balance.suspendedBalance.toFixed(2)),
        methods: balance.methods,
      },
    };
  },

  getUserTransactions: async (
    _: unknown,
    { id, first, after, last, before }: { id?: string; first?: number; after?: string; last?: number; before?: string },
    context: Context
  ) => {
    if (!context.user) {
      throw new GraphQLError(context.authError || "Authentication required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    if (context.user.role === "admin") {
      return { code: 403, success: false, message: "Admin accounts cannot buy products", order: null, transaction: null };
    }

    const { userId } = context.user;
    const db = getDB();
    const walletsDB = getWalletsDB();

    const user = await db.collection<User>("users").findOne({ id: userId });

    // Single transaction lookup
    if (id) {
      const txn = await walletsDB.collection<Transaction>("Transactions").findOne({ id, userId });
      if (!txn) {
        return { code: 404, success: false, message: "Transaction not found", transaction: null, transactions: null };
      }
      return {
        code: 200,
        success: true,
        message: "Transaction retrieved successfully",
        user,
        transaction: {
          id: txn.id,
          type: txn.type,
          status: txn.status,
          method: txn.method,
          amount: txn.amount,
          createdAt: txn.createdAt,
        },
        transactions: null,
      };
    }

    const allTransactions = await walletsDB
      .collection<Transaction>("Transactions")
      .find({ userId })
      .sort({ createdAt: -1 })
      .toArray();

    const total = allTransactions.length;
    let start = 0;
    let end = total;

    if (first != null && after) {
      start = decodeCursor(after) + 1;
      end = Math.min(start + first, total);
    } else if (first != null) {
      end = Math.min(first, total);
    } else if (last != null && before) {
      end = decodeCursor(before);
      start = Math.max(end - last, 0);
    } else if (last != null) {
      start = Math.max(total - last, 0);
    }

    const sliced = allTransactions.slice(start, end);

    const edges = sliced.map((t, i) => ({
      cursor: encodeCursor(start + i),
      node: {
        id: t.id,
        type: t.type,
        status: t.status,
        method: t.method,
        amount: t.amount,
        createdAt: t.createdAt,
      },
    }));

    return {
      code: 200,
      success: true,
      message: `${total} transaction(s) found`,
      user,
      transactions: {
        edges,
        pageInfo: {
          hasNextPage: end < total,
          hasPreviousPage: start > 0,
          startCursor: edges.length ? edges[0].cursor : null,
          endCursor: edges.length ? edges[edges.length - 1].cursor : null,
          fetchedCount: edges.length,
          remainingCount: total - end,
        },
      },
    };
  },

  getOrder: async (
    _: unknown,
    { id }: { id: string }
  ) => {
    const walletsDB = getWalletsDB();
    const catalogsDB = getCatalogsDB();

    const order = await walletsDB.collection<Order>("Orders").findOne({
      orderId: id,
      type: "anonpurchase",
    });

    if (!order) {
      // Order not yet created — check if there's a pending deposit for this orderId
      const deposit = await walletsDB.collection<Deposit>("Deposits").findOne({
        orderId: id,
        type: "codepurchase",
      });

      if (!deposit) {
        return { code: 404, success: false, message: "Order not found", order: null };
      }

      const product = deposit.productId
        ? await catalogsDB.collection<Product>("Products").findOne({ productId: deposit.productId })
        : null;
      const store = deposit.storeId
        ? await catalogsDB.collection<Store>("Stores").findOne({ storeId: deposit.storeId })
        : null;

      return {
        code: 200,
        success: true,
        message: "Order retrieved successfully",
        order: {
          orderId: deposit.orderId,
          buyerId: "anon-gameket-id",
          buyerName: deposit.buyerName || "",
          sellerId: deposit.sellerId || "",
          sellerName: store?.storeName || "",
          storeId: deposit.storeId || "",
          product: product ? {
            productId: product.productId,
            catalog: product.catalog,
            category: product.category,
            region: product.region,
            name: product.name,
            description: product.description,
            marketPrice: product.marketPrice,
            price: product.price,
            discount: product.discount,
            isActive: product.isActive,
            isPromoted: product.isPromoted,
            available: product.available,
            sold: product.sold,
            type: product.type,
            createdAt: product.createdAt,
            store: store ? {
              storeId: store.storeId,
              storeName: store.storeName,
              isActive: store.isActive,
              isApproved: store.isApproved,
              approveStatus: store.approveStatus,
              isPromoted: store.isPromoted,
              type: store.type,
              totalSales: store.totalSales,
              positiveReviews: store.positiveReviews,
              negativeReviews: store.negativeReviews,
              registered: store.createdAt,
              requestCount: store.requestCount,
            } : null,
          } : null,
          codes: [],
          amount: deposit.amount,
          fee: deposit.fee,
          totalAmount: deposit.totalCharged,
          status: deposit.status,
          type: "anonpurchase",
          action: "buy",
          isReviewed: false,
          reviewType: null,
          createdAt: "",
          releasedAt: "",
          store: store ? {
            storeId: store.storeId,
            storeName: store.storeName,
            isActive: store.isActive,
            isApproved: store.isApproved,
            approveStatus: store.approveStatus,
            isPromoted: store.isPromoted,
            type: store.type,
            totalSales: store.totalSales,
            positiveReviews: store.positiveReviews,
            negativeReviews: store.negativeReviews,
            registered: store.createdAt,
            requestCount: store.requestCount,
          } : null,
          transaction: null,
        },
      };
    }

    const product = await catalogsDB.collection<Product>("Products").findOne({ productId: order.productId });
    const store = await catalogsDB.collection<Store>("Stores").findOne({ storeId: order.storeId });

    return {
      code: 200,
      success: true,
      message: "Order retrieved successfully",
      order: {
        orderId: order.orderId,
        buyerId: order.buyerId,
        buyerName: order.buyerName || "",
        sellerId: order.sellerId,
        sellerName: store?.storeName || "",
        storeId: order.storeId,
        product: product ? {
          productId: product.productId,
          catalog: product.catalog,
          category: product.category,
          region: product.region,
          name: product.name,
          description: product.description,
          marketPrice: product.marketPrice,
          price: product.price,
          discount: product.discount,
          isActive: product.isActive,
          isPromoted: product.isPromoted,
          available: product.available,
          sold: product.sold,
          type: product.type,
          createdAt: product.createdAt,
          store: store ? {
            storeId: store.storeId,
            storeName: store.storeName,
            isActive: store.isActive,
            isApproved: store.isApproved,
            approveStatus: store.approveStatus,
            isPromoted: store.isPromoted,
            type: store.type,
            totalSales: store.totalSales,
            positiveReviews: store.positiveReviews,
            negativeReviews: store.negativeReviews,
            registered: store.createdAt,
            requestCount: store.requestCount,
          } : null,
        } : null,
        codes: order.codes.map(decrypt),
        amount: order.amount,
        fee: order.fee,
        totalAmount: order.totalAmount,
        status: order.status,
        type: order.type,
        action: "buy",
        isReviewed: order.isReviewed,
        isReleased: order.isReleased,
        reviewType: order.reviewType ?? null,
        createdAt: order.createdAt,
        releasedAt: order.releasedAt,
        store: store ? {
          storeId: store.storeId,
          storeName: store.storeName,
          isActive: store.isActive,
          isApproved: store.isApproved,
          approveStatus: store.approveStatus,
          isPromoted: store.isPromoted,
          type: store.type,
          totalSales: store.totalSales,
          positiveReviews: store.positiveReviews,
          negativeReviews: store.negativeReviews,
          registered: store.createdAt,
          requestCount: store.requestCount,
        } : null,
        transaction: null,
      },
    };
  },

  getUserOrders: async (
    _: unknown,
    { id, first, after, last, before }: { id?: string; first?: number; after?: string; last?: number; before?: string },
    context: Context
  ) => {
    if (!context.user) {
      throw new GraphQLError(context.authError || "Authentication required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const { userId } = context.user;
    const db = getDB();
    const walletsDB = getWalletsDB();
    const catalogsDB = getCatalogsDB();

    const user = await db.collection<User>("users").findOne({ id: userId });

    // Single order lookup
    if (id) {
      const order = await walletsDB.collection<Order>("Orders").findOne({
        orderId: id,
        $or: [{ buyerId: userId }, { sellerId: userId }],
      });

      if (!order) {
        return { code: 404, success: false, message: "Order not found", user, order: null, orders: null };
      }

      const product = await catalogsDB.collection<Product>("Products").findOne({ productId: order.productId });
      const store = await catalogsDB.collection<Store>("Stores").findOne({ storeId: order.storeId });
      const action = order.buyerId === userId ? "buy" : "sell";
      const txn = await walletsDB.collection<Transaction>("Transactions").findOne({
        id: action === "buy" ? order.buyerTransactionId : order.sellerTransactionId,
      });
      const buyer = await db.collection<User>("users").findOne({ id: order.buyerId });
      const seller = await db.collection<User>("users").findOne({ id: order.sellerId });

      const refundOffer = await walletsDB.collection<RefundOffer>("RefundOffers").findOne({ orderId: id, status: "pending" });

      return {
        code: 200,
        success: true,
        message: "Order retrieved successfully",
        user,
        order: {
          orderId: order.orderId,
          buyerId: order.buyerId,
          buyerName: order.buyerName || buyer?.username || "",
          sellerId: order.sellerId,
          sellerName: seller?.username || "",
          storeId: order.storeId,
          product: product ? {
            productId: product.productId,
            catalog: product.catalog,
            category: product.category,
            region: product.region,
            name: product.name,
            description: product.description,
            marketPrice: product.marketPrice,
            price: product.price,
            discount: product.discount,
            isActive: product.isActive,
            isPromoted: product.isPromoted,
            available: product.available,
            sold: product.sold,
            type: product.type,
            createdAt: product.createdAt,
            store: store ? {
              storeId: store.storeId,
              storeName: store.storeName,
              isActive: store.isActive,
              isApproved: store.isApproved,
              approveStatus: store.approveStatus,
              isPromoted: store.isPromoted,
              type: store.type,
              totalSales: store.totalSales,
              positiveReviews: store.positiveReviews,
              negativeReviews: store.negativeReviews,
              registered: store.createdAt,
              requestCount: store.requestCount,
            } : null,
          } : null,
          codes: order.codes.map(decrypt),
          amount: order.amount,
          fee: order.fee,
          totalAmount: order.totalAmount,
          status: order.status,
          type: order.type,
          action,
          isReviewed: order.isReviewed,
          isReleased: order.isReleased,
          reviewType: order.reviewType ?? null,
          disputeReason: order.disputeReason ?? null,
          createdAt: order.createdAt,
          releasedAt: order.releasedAt,
          store: store ? {
            storeId: store.storeId,
            storeName: store.storeName,
            isActive: store.isActive,
            isApproved: store.isApproved,
            approveStatus: store.approveStatus,
            isPromoted: store.isPromoted,
            type: store.type,
            totalSales: store.totalSales,
            positiveReviews: store.positiveReviews,
            negativeReviews: store.negativeReviews,
            registered: store.createdAt,
            requestCount: store.requestCount,
          } : null,
          transaction: txn ? {
            id: txn.id,
            type: txn.type,
            status: txn.status,
            method: txn.method,
            amount: txn.amount,
            createdAt: txn.createdAt,
          } : null,
          refundOffer: refundOffer ? {
            refundId: refundOffer.refundId,
            orderId: refundOffer.orderId,
            buyerId: refundOffer.buyerId,
            sellerId: refundOffer.sellerId,
            storeId: refundOffer.storeId,
            quantity: refundOffer.quantity,
            refundAmount: refundOffer.refundAmount,
            sellerDeduction: refundOffer.sellerDeduction,
            status: refundOffer.status,
            createdAt: refundOffer.createdAt,
            order: null,
          } : null,
        },
        orders: null,
      };
    }

    // Paginated list of all user orders (as buyer or seller)
    const allOrders = await walletsDB
      .collection<Order>("Orders")
      .find({ $or: [{ buyerId: userId }, { sellerId: userId }] })
      .sort({ createdAt: -1 })
      .toArray();

    const total = allOrders.length;
    let start = 0;
    let end = total;

    if (first != null && after) {
      start = decodeCursor(after) + 1;
      end = Math.min(start + first, total);
    } else if (first != null) {
      end = Math.min(first, total);
    } else if (last != null && before) {
      end = decodeCursor(before);
      start = Math.max(end - last, 0);
    } else if (last != null) {
      start = Math.max(total - last, 0);
    }

    const sliced = allOrders.slice(start, end);

    // Batch fetch products and stores
    const productIds = [...new Set(sliced.map((o) => o.productId))];
    const storeIds = [...new Set(sliced.map((o) => o.storeId))];

    const products = await catalogsDB.collection<Product>("Products").find({ productId: { $in: productIds } }).toArray();
    const stores = await catalogsDB.collection<Store>("Stores").find({ storeId: { $in: storeIds } }).toArray();

    const productMap = new Map(products.map((p) => [p.productId, p]));
    const storeMap = new Map(stores.map((s) => [s.storeId, s]));

    // Batch fetch users (buyers and sellers)
    const userIds = [...new Set(sliced.flatMap((o) => [o.buyerId, o.sellerId]))];
    const users = await db.collection<User>("users").find({ id: { $in: userIds } }).toArray();
    const userMap = new Map(users.map((u) => [u.id, u]));

    // Batch fetch transactions (both buyer and seller)
    const buyerTxnIds = [...new Set(sliced.filter((o) => o.buyerId === userId).map((o) => o.buyerTransactionId))];
    const sellerTxnIds = [...new Set(sliced.filter((o) => o.sellerId === userId).map((o) => o.sellerTransactionId))];
    const allTxnIds = [...buyerTxnIds, ...sellerTxnIds];
    const transactions = await walletsDB.collection<Transaction>("Transactions").find({ id: { $in: allTxnIds } }).toArray();
    const txnMap = new Map(transactions.map((t) => [t.id, t]));

    // Batch fetch pending refund offers
    const orderIdsForOffers = [...new Set(sliced.map((o) => o.orderId))];
    const refundOffers = await walletsDB.collection<RefundOffer>("RefundOffers").find({ orderId: { $in: orderIdsForOffers }, status: "pending" }).toArray();
    const refundOfferMap = new Map(refundOffers.map((r) => [r.orderId, r]));

    const edges = sliced.map((order, i) => {
      const product = productMap.get(order.productId);
      const store = storeMap.get(order.storeId);
      const action = order.buyerId === userId ? "buy" : "sell";
      const txn = txnMap.get(action === "buy" ? order.buyerTransactionId : order.sellerTransactionId);
      const buyerUser = userMap.get(order.buyerId);
      const sellerUser = userMap.get(order.sellerId);
      const ro = refundOfferMap.get(order.orderId);

      return {
        cursor: encodeCursor(start + i),
        node: {
          orderId: order.orderId,
          buyerId: order.buyerId,
          buyerName: order.buyerName || buyerUser?.username || "",
          sellerId: order.sellerId,
          sellerName: sellerUser?.username || "",
          storeId: order.storeId,
          product: product ? {
            productId: product.productId,
            catalog: product.catalog,
            category: product.category,
            region: product.region,
            name: product.name,
            description: product.description,
            marketPrice: product.marketPrice,
            price: product.price,
            discount: product.discount,
            isActive: product.isActive,
            isPromoted: product.isPromoted,
            available: product.available,
            sold: product.sold,
            type: product.type,
            createdAt: product.createdAt,
            store: store ? {
              storeId: store.storeId,
              storeName: store.storeName,
              isActive: store.isActive,
              isApproved: store.isApproved,
              approveStatus: store.approveStatus,
              isPromoted: store.isPromoted,
              type: store.type,
              totalSales: store.totalSales,
              positiveReviews: store.positiveReviews,
              negativeReviews: store.negativeReviews,
              registered: store.createdAt,
              requestCount: store.requestCount,
            } : null,
          } : null,
          codes: order.codes.map(decrypt),
          amount: order.amount,
          fee: order.fee,
          totalAmount: order.totalAmount,
          status: order.status,
          type: order.type,
          action,
          isReviewed: order.isReviewed,
          isReleased: order.isReleased,
          reviewType: order.reviewType ?? null,
          disputeReason: order.disputeReason ?? null,
          createdAt: order.createdAt,
          releasedAt: order.releasedAt,
          store: store ? {
            storeId: store.storeId,
            storeName: store.storeName,
            isActive: store.isActive,
            isApproved: store.isApproved,
            approveStatus: store.approveStatus,
            isPromoted: store.isPromoted,
            type: store.type,
            totalSales: store.totalSales,
            positiveReviews: store.positiveReviews,
            negativeReviews: store.negativeReviews,
            registered: store.createdAt,
            requestCount: store.requestCount,
          } : null,
          transaction: txn ? {
            id: txn.id,
            type: txn.type,
            status: txn.status,
            method: txn.method,
            amount: txn.amount,
            createdAt: txn.createdAt,
          } : null,
          refundOffer: ro ? {
            refundId: ro.refundId,
            orderId: ro.orderId,
            buyerId: ro.buyerId,
            sellerId: ro.sellerId,
            storeId: ro.storeId,
            quantity: ro.quantity,
            refundAmount: ro.refundAmount,
            sellerDeduction: ro.sellerDeduction,
            status: ro.status,
            createdAt: ro.createdAt,
            order: null,
          } : null,
        },
      };
    });

    return {
      code: 200,
      success: true,
      message: `${total} order(s) found`,
      user,
      order: null,
      orders: {
        edges,
        pageInfo: {
          hasNextPage: end < total,
          hasPreviousPage: start > 0,
          startCursor: edges.length ? edges[0].cursor : null,
          endCursor: edges.length ? edges[edges.length - 1].cursor : null,
          fetchedCount: edges.length,
          remainingCount: total - end,
        },
      },
    };
  },

  getUserAnalysis: async (_: unknown, __: unknown, context: Context) => {
    if (!context.user) {
      throw new GraphQLError(context.authError || "Authentication required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const { userId } = context.user;
    const db = getDB();
    const walletsDB = getWalletsDB();
    const catalogsDB = getCatalogsDB();

    const user = await db.collection<User>("users").findOne({ id: userId });
    if (!user) {
      return {
        code: 404,
        success: false,
        message: "User not found",
        user: null,
        topProducts: [],
        topCountries: [],
        profitAnalysis: { last7Days: [], last30Days: [], allTime: [] },
        releasableFunds: {
          unlockNext24Hours: 0,
          unlockNext3Days: 0,
          unlockNext7Days: 0,
          orders: [],
        },
      };
    }

    if (!user.isPremium) {
      return {
        code: 403,
        success: false,
        message: "Premium users only",
        user,
        topProducts: [],
        topCountries: [],
        profitAnalysis: { last7Days: [], last30Days: [], allTime: [] },
        releasableFunds: {
          unlockNext24Hours: 0,
          unlockNext3Days: 0,
          unlockNext7Days: 0,
          orders: [],
        },
      };
    }

    const orders = await walletsDB
      .collection<Order>("Orders")
      .find({
        $or: [{ buyerId: userId }, { sellerId: userId }],
        status: { $ne: "failed" },
      })
      .toArray();

    type Action = "sold" | "purchased";
    type AggregateNode = { productId: string; quantity: number; action: Action };
    const aggregateMap = new Map<string, AggregateNode>();

    for (const order of orders) {
      const rawQuantity = Number(order.quantity);
      const fallbackQuantity = Array.isArray(order.codes) ? order.codes.length : 0;
      const normalizedQuantity = Number.isFinite(rawQuantity) && rawQuantity > 0
        ? Math.floor(rawQuantity)
        : fallbackQuantity;

      if (normalizedQuantity <= 0) {
        continue;
      }

      if (order.buyerId === userId) {
        const key = `${order.productId}:purchased`;
        const current = aggregateMap.get(key);
        if (current) {
          current.quantity += normalizedQuantity;
        } else {
          aggregateMap.set(key, { productId: order.productId, quantity: normalizedQuantity, action: "purchased" });
        }
      }

      if (order.sellerId === userId) {
        const key = `${order.productId}:sold`;
        const current = aggregateMap.get(key);
        if (current) {
          current.quantity += normalizedQuantity;
        } else {
          aggregateMap.set(key, { productId: order.productId, quantity: normalizedQuantity, action: "sold" });
        }
      }
    }

    const ranked = [...aggregateMap.values()]
      .sort((a, b) => b.quantity - a.quantity)
      .slice(0, 10);

    const now = new Date();
    const nowMs = now.getTime();
    const oneDayMs = 24 * 60 * 60 * 1000;
    const threeDaysMs = 3 * oneDayMs;
    const sevenDaysMs = 7 * oneDayMs;

    const rawReleasableOrders = orders
      .filter((order) => order.sellerId === userId && !order.isReleased && order.status === "completed")
      .map((order) => {
        const releaseDate = new Date(order.releasedAt);
        if (isNaN(releaseDate.getTime())) return null;

        const rawAmount = Number(order.amount);
        const amount = Number.isFinite(rawAmount) && rawAmount > 0 ? parseFloat(rawAmount.toFixed(2)) : 0;

        const rawQuantity = Number(order.quantity);
        const fallbackQuantity = Array.isArray(order.codes) ? order.codes.length : 0;
        const quantity = Number.isFinite(rawQuantity) && rawQuantity > 0
          ? Math.floor(rawQuantity)
          : fallbackQuantity;

        return {
          orderId: order.orderId,
          productId: order.productId,
          quantity: Math.max(0, quantity),
          amount,
          releaseAt: releaseDate.toISOString(),
          msUntilRelease: releaseDate.getTime() - nowMs,
        };
      })
      .filter((entry): entry is {
        orderId: string;
        productId: string;
        quantity: number;
        amount: number;
        releaseAt: string;
        msUntilRelease: number;
      } => entry !== null && entry.amount > 0);

    const productIds = [...new Set([
      ...ranked.map((r) => r.productId),
      ...rawReleasableOrders.map((r) => r.productId),
    ])];
    const products = productIds.length
      ? await catalogsDB.collection<Product>("Products").find({ productId: { $in: productIds } }).toArray()
      : [];
    const productMap = new Map(products.map((p) => [
      p.productId,
      {
        name: p.name,
        category: p.category,
      },
    ]));

    const counterpartIdSet = new Set<string>();
    for (const order of orders) {
      const counterpartyId = order.buyerId === userId ? order.sellerId : order.buyerId;
      if (!counterpartyId || counterpartyId === userId || counterpartyId === "anon-gameket-id") continue;
      counterpartIdSet.add(counterpartyId);
    }

    const counterpartIds = [...counterpartIdSet];
    const counterpartUsers = counterpartIds.length
      ? await db.collection<User>("users").find({ id: { $in: counterpartIds } }).toArray()
      : [];
    const counterpartCountryMap = new Map(counterpartUsers.map((u) => [u.id, (u.country || "Unknown").trim() || "Unknown"]));

    const countryInteractionMap = new Map<string, number>();
    for (const order of orders) {
      const counterpartyId = order.buyerId === userId ? order.sellerId : order.buyerId;
      if (!counterpartyId || counterpartyId === userId || counterpartyId === "anon-gameket-id") continue;

      const country = counterpartCountryMap.get(counterpartyId) || "Unknown";
      const current = countryInteractionMap.get(country) || 0;
      countryInteractionMap.set(country, current + 1);
    }

    const topCountries = [...countryInteractionMap.entries()]
      .map(([country, interactionCount]) => ({ country, interactionCount }))
      .sort((a, b) => {
        if (b.interactionCount !== a.interactionCount) return b.interactionCount - a.interactionCount;
        return a.country.localeCompare(b.country);
      })
      .slice(0, 10);

    const unlockNext24Hours = parseFloat(
      rawReleasableOrders
        .filter((order) => order.msUntilRelease <= oneDayMs)
        .reduce((sum, order) => sum + order.amount, 0)
        .toFixed(2)
    );

    const unlockNext3Days = parseFloat(
      rawReleasableOrders
        .filter((order) => order.msUntilRelease <= threeDaysMs)
        .reduce((sum, order) => sum + order.amount, 0)
        .toFixed(2)
    );

    const unlockNext7Days = parseFloat(
      rawReleasableOrders
        .filter((order) => order.msUntilRelease <= sevenDaysMs)
        .reduce((sum, order) => sum + order.amount, 0)
        .toFixed(2)
    );

    const releasableOrders = rawReleasableOrders
      .filter((order) => order.msUntilRelease <= sevenDaysMs)
      .sort((a, b) => a.releaseAt.localeCompare(b.releaseAt))
      .map((order) => ({
        orderId: order.orderId,
        productId: order.productId,
        productName: productMap.get(order.productId)?.name || "Unknown product",
        category: productMap.get(order.productId)?.category || "Unknown",
        quantity: order.quantity,
        amount: order.amount,
        releaseAt: order.releaseAt,
        hoursUntilRelease: parseFloat((Math.max(order.msUntilRelease, 0) / (60 * 60 * 1000)).toFixed(2)),
      }));

    const releasableFunds = {
      unlockNext24Hours,
      unlockNext3Days,
      unlockNext7Days,
      orders: releasableOrders,
    };

    const transactions = await walletsDB
      .collection<Transaction>("Transactions")
      .find({ userId })
      .toArray();

    const approvedWithdrawals = await walletsDB
      .collection<Withdrawal>("Withdrawals")
      .find({ userId, status: "approved" })
      .toArray();

    const dailyDelta = new Map<string, number>();

    for (const txn of transactions) {
      // Withdrawal outflow is charted using processedAt from the withdrawal record.
      if (txn.type === "Withdrawal") continue;
      const delta = getTransactionBalanceDelta(txn);
      if (delta === 0) continue;

      const dayKey = getUTCDateKey(txn.createdAt);
      if (!dayKey) continue;
      addDailyDelta(dailyDelta, dayKey, delta);
    }

    for (const withdrawal of approvedWithdrawals) {
      const eventDate = withdrawal.processedAt || withdrawal.createdAt;
      const dayKey = getUTCDateKey(eventDate);
      if (!dayKey) continue;
      addDailyDelta(dailyDelta, dayKey, -withdrawal.amount);
    }

    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

    const last7Start = new Date(today);
    last7Start.setUTCDate(last7Start.getUTCDate() - 6);

    const last30Start = new Date(today);
    last30Start.setUTCDate(last30Start.getUTCDate() - 29);

    const profitAnalysis = {
      last7Days: buildBalanceChangeSeries(dailyDelta, last7Start, today),
      last30Days: buildBalanceChangeSeries(dailyDelta, last30Start, today),
      allTime: buildMonthlyBalanceChangeSeries(dailyDelta, today, 12),
    };

    return {
      code: 200,
      success: true,
      message: "User analysis retrieved successfully",
      user,
      topProducts: ranked.map((item) => ({
        productId: item.productId,
        productName: productMap.get(item.productId)?.name || "Unknown product",
        category: productMap.get(item.productId)?.category || "Unknown",
        quantity: Math.max(0, Math.floor(Number(item.quantity) || 0)),
        action: item.action,
      })),
      topCountries,
      profitAnalysis,
      releasableFunds,
    };
  },

  getUserReviews: async (
    _: unknown,
    { first, after, last, before }: { first?: number; after?: string; last?: number; before?: string },
    context: Context
  ) => {
    if (!context.user) throw new GraphQLError("Not authenticated");
    const db = getDB();
    const catalogsDB = getCatalogsDB();
    const userId = context.user.userId;
    const user = await db.collection<User>("users").findOne({ id: userId });
    if (!user) throw new GraphQLError("User not found");

    // Aggregate all reviews by this user across all stores
    const pipeline = [
      { $unwind: "$reviews" },
      { $match: { "reviews.reviewerId": userId } },
      { $sort: { "reviews.date": -1 as const } },
      { $replaceRoot: { newRoot: "$reviews" } },
    ];
    const allReviews = await catalogsDB.collection<Store>("Stores").aggregate<Review>(pipeline).toArray();

    const total = allReviews.length;
    const defaultPageSize = 30;
    const pageFirst = first ?? (last == null ? defaultPageSize : undefined);
    let start = 0;
    let end = total;

    if (pageFirst != null && after) {
      start = decodeCursor(after) + 1;
      end = Math.min(start + pageFirst, total);
    } else if (pageFirst != null) {
      end = Math.min(pageFirst, total);
    } else if (last != null && before) {
      end = decodeCursor(before);
      start = Math.max(end - last, 0);
    } else if (last != null) {
      start = Math.max(total - last, 0);
    }

    const sliced = allReviews.slice(start, end);

    const edges = sliced.map((r, i) => ({
      cursor: encodeCursor(start + i),
      node: {
        reviewerName: user.username,
        orderId: r.orderId,
        type: r.type,
        review: r.review,
        date: r.date,
      },
    }));

    return {
      code: 200,
      success: true,
      message: `${total} review(s) found`,
      user,
      reviews: {
        edges,
        pageInfo: {
          hasNextPage: end < total,
          hasPreviousPage: start > 0,
          startCursor: edges.length ? edges[0].cursor : null,
          endCursor: edges.length ? edges[edges.length - 1].cursor : null,
          fetchedCount: edges.length,
          remainingCount: total - end,
        },
      },
    };
  },

  getStoreReviews: async (
    _: unknown,
    { storeId, category, first, after, last, before }: { storeId: string; category: string; first?: number; after?: string; last?: number; before?: string }
  ) => {
    const db = getDB();
    const catalogsDB = getCatalogsDB();
    const walletsDB = getWalletsDB();

    const store = await catalogsDB.collection<Store>("Stores").findOne({ storeId });
    if (!store) {
      return { code: 404, success: false, message: "Store not found", reviews: null };
    }

    const reviews = store.reviews ?? [];
    if (reviews.length === 0) {
      return {
        code: 200,
        success: true,
        message: "0 review(s) found",
        reviews: { edges: [], pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null, fetchedCount: 0, remainingCount: 0 } },
      };
    }

    // Get all orderIds from reviews, then find matching orders, then filter by product category
    const orderIds = reviews.map((r) => r.orderId);
    const orders = await walletsDB.collection<Order>("Orders").find({ orderId: { $in: orderIds } }).toArray();
    const orderMap = new Map(orders.map((o) => [o.orderId, o]));

    const productIds = [...new Set(orders.map((o) => o.productId))];
    const products = await catalogsDB.collection<Product>("Products").find({ productId: { $in: productIds } }).toArray();
    const productMap = new Map(products.map((p) => [p.productId, p]));

    // Filter reviews where the order's product matches the requested category
    const filtered = reviews.filter((r) => {
      const order = orderMap.get(r.orderId);
      if (!order) return false;
      const product = productMap.get(order.productId);
      return product?.category === category;
    });

    // Sort by date descending
    filtered.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    const total = filtered.length;
    const defaultPageSize = 30;
    const pageFirst = first ?? (last == null ? defaultPageSize : undefined);
    let start = 0;
    let end = total;

    if (pageFirst != null && after) {
      start = decodeCursor(after) + 1;
      end = Math.min(start + pageFirst, total);
    } else if (pageFirst != null) {
      end = Math.min(pageFirst, total);
    } else if (last != null && before) {
      end = decodeCursor(before);
      start = Math.max(end - last, 0);
    } else if (last != null) {
      start = Math.max(total - last, 0);
    }

    const sliced = filtered.slice(start, end);

    // Batch-fetch reviewer usernames
    const reviewerIds = [...new Set(sliced.map((r) => r.reviewerId))];
    const reviewers = await db.collection<User>("users").find({ id: { $in: reviewerIds } }).toArray();
    const reviewerMap = new Map(reviewers.map((u) => [u.id, u.username]));

    const edges = sliced.map((r, i) => ({
      cursor: encodeCursor(start + i),
      node: {
        reviewerName: reviewerMap.get(r.reviewerId) ?? "Unknown",
        orderId: r.orderId,
        type: r.type,
        review: r.review,
        date: r.date,
      },
    }));

    return {
      code: 200,
      success: true,
      message: `${total} review(s) found`,
      reviews: {
        edges,
        pageInfo: {
          hasNextPage: end < total,
          hasPreviousPage: start > 0,
          startCursor: edges.length ? edges[0].cursor : null,
          endCursor: edges.length ? edges[edges.length - 1].cursor : null,
          fetchedCount: edges.length,
          remainingCount: total - end,
        },
      },
    };
  },

  getUserStoreReviews: async (
    _: unknown,
    { first, after, last, before }: { first?: number; after?: string; last?: number; before?: string },
    context: Context
  ) => {
    if (!context.user) {
      throw new GraphQLError(context.authError || "Authentication required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const { userId } = context.user;
    const db = getDB();
    const catalogsDB = getCatalogsDB();

    const user = await db.collection<User>("users").findOne({ id: userId });
    if (!user) throw new GraphQLError("User not found");

    const store = await catalogsDB.collection<Store>("Stores").findOne({ userId });
    if (!store) {
      return { code: 404, success: false, message: "Store not found", user, reviews: null };
    }

    const reviews = (store.reviews ?? []).slice().sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
    );

    const total = reviews.length;
    if (total === 0) {
      return {
        code: 200,
        success: true,
        message: "0 review(s) found",
        user,
        reviews: { edges: [], pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null, fetchedCount: 0, remainingCount: 0 } },
      };
    }

    const defaultPageSize = 30;
    const pageFirst = first ?? (last == null ? defaultPageSize : undefined);
    let start = 0;
    let end = total;

    if (pageFirst != null && after) {
      start = decodeCursor(after) + 1;
      end = Math.min(start + pageFirst, total);
    } else if (pageFirst != null) {
      end = Math.min(pageFirst, total);
    } else if (last != null && before) {
      end = decodeCursor(before);
      start = Math.max(end - last, 0);
    } else if (last != null) {
      start = Math.max(total - last, 0);
    }

    const sliced = reviews.slice(start, end);

    // Batch-fetch reviewer usernames
    const reviewerIds = [...new Set(sliced.map((r) => r.reviewerId))];
    const reviewers = await db.collection<User>("users").find({ id: { $in: reviewerIds } }).toArray();
    const reviewerMap = new Map(reviewers.map((u) => [u.id, u.username]));

    const edges = sliced.map((r, i) => ({
      cursor: encodeCursor(start + i),
      node: {
        reviewerName: reviewerMap.get(r.reviewerId) ?? "Unknown",
        orderId: r.orderId,
        type: r.type,
        review: r.review,
        date: r.date,
      },
    }));

    return {
      code: 200,
      success: true,
      message: `${total} review(s) found`,
      user,
      reviews: {
        edges,
        pageInfo: {
          hasNextPage: end < total,
          hasPreviousPage: start > 0,
          startCursor: edges.length ? edges[0].cursor : null,
          endCursor: edges.length ? edges[edges.length - 1].cursor : null,
          fetchedCount: edges.length,
          remainingCount: total - end,
        },
      },
    };
  },

  getUserDisputes: async (
    _: unknown,
    { first, after, last, before }: { first?: number; after?: string; last?: number; before?: string },
    context: Context
  ) => {
    if (!context.user) {
      throw new GraphQLError(context.authError || "Authentication required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const { userId } = context.user;
    const db = getDB();
    const walletsDB = getWalletsDB();

    const user = await db.collection<User>("users").findOne({ id: userId });
    if (!user) throw new GraphQLError("User not found");

    const allDisputes = await walletsDB
      .collection<Dispute>("Disputes")
      .find({ $or: [{ buyerId: userId }, { sellerId: userId }] })
      .sort({ createdAt: -1 })
      .toArray();

    const total = allDisputes.length;
    if (total === 0) {
      return {
        code: 200,
        success: true,
        message: "0 dispute(s) found",
        user,
        disputes: { edges: [], pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null, fetchedCount: 0, remainingCount: 0 } },
      };
    }

    const defaultPageSize = 30;
    const pageFirst = first ?? (last == null ? defaultPageSize : undefined);
    let start = 0;
    let end = total;

    if (pageFirst != null && after) {
      start = decodeCursor(after) + 1;
      end = Math.min(start + pageFirst, total);
    } else if (pageFirst != null) {
      end = Math.min(pageFirst, total);
    } else if (last != null && before) {
      end = decodeCursor(before);
      start = Math.max(end - last, 0);
    } else if (last != null) {
      start = Math.max(total - last, 0);
    }

    const sliced = allDisputes.slice(start, end);

    // Batch fetch orders for the disputes
    const orderIds = [...new Set(sliced.map((d) => d.orderId))];
    const orders = await walletsDB.collection<Order>("Orders").find({ orderId: { $in: orderIds } }).toArray();
    const orderMap = new Map(orders.map((o) => [o.orderId, o]));

    // Batch fetch stores and products
    const catalogsDB = getCatalogsDB();
    const storeIds = [...new Set(sliced.map((d) => d.storeId))];
    const stores = await catalogsDB.collection<Store>("Stores").find({ storeId: { $in: storeIds } }).toArray();
    const storeMap = new Map(stores.map((s) => [s.storeId, s]));

    const productIds = [...new Set(orders.map((o) => o.productId))];
    const products = await catalogsDB.collection<Product>("Products").find({ productId: { $in: productIds } }).toArray();
    const productMap = new Map(products.map((p) => [p.productId, p]));

    // Batch fetch users (buyers and sellers)
    const userIds = [...new Set(sliced.flatMap((d) => [d.buyerId, d.sellerId]))];
    const users = await db.collection<User>("users").find({ id: { $in: userIds } }).toArray();
    const userMap = new Map(users.map((u) => [u.id, u]));

    const edges = sliced.map((d, i) => {
      const order = orderMap.get(d.orderId);
      const store = storeMap.get(d.storeId);
      const product = order ? productMap.get(order.productId) : null;
      const buyer = userMap.get(d.buyerId);
      const seller = userMap.get(d.sellerId);

      return {
        cursor: encodeCursor(start + i),
        node: {
          disputeId: d.disputeId,
          orderId: d.orderId,
          buyerId: d.buyerId,
          sellerId: d.sellerId,
          storeId: d.storeId,
          reason: d.reason,
          status: d.status,
          messages: buildMessagesConnection(d.messages || []),
          createdAt: d.createdAt,
          order: order ? {
            orderId: order.orderId,
            buyerId: order.buyerId,
            buyerName: order.buyerName || buyer?.username || "",
            sellerId: order.sellerId,
            sellerName: seller?.username || "",
            storeId: order.storeId,
            product: product ? {
              productId: product.productId,
              catalog: product.catalog,
              category: product.category,
              region: product.region,
              name: product.name,
              description: product.description,
              marketPrice: product.marketPrice,
              price: product.price,
              discount: product.discount,
              isActive: product.isActive,
              isPromoted: product.isPromoted,
              available: product.available,
              sold: product.sold,
              type: product.type,
              createdAt: product.createdAt,
              store: store ? {
                storeId: store.storeId,
                storeName: store.storeName,
                isActive: store.isActive,
                isApproved: store.isApproved,
                approveStatus: store.approveStatus,
                isPromoted: store.isPromoted,
                type: store.type,
                totalSales: store.totalSales,
                positiveReviews: store.positiveReviews,
                negativeReviews: store.negativeReviews,
                registered: store.createdAt,
                requestCount: store.requestCount,
              } : null,
            } : null,
            codes: [],
            amount: order.amount,
            fee: order.fee,
            totalAmount: order.totalAmount,
            status: order.status,
            type: order.type,
            action: d.buyerId === userId ? "buy" : "sell",
            isReviewed: order.isReviewed,
            isReleased: order.isReleased,
            reviewType: order.reviewType ?? null,
            disputeReason: order.disputeReason ?? null,
            createdAt: order.createdAt,
            releasedAt: order.releasedAt,
            store: store ? {
              storeId: store.storeId,
              storeName: store.storeName,
              isActive: store.isActive,
              isApproved: store.isApproved,
              approveStatus: store.approveStatus,
              isPromoted: store.isPromoted,
              type: store.type,
              totalSales: store.totalSales,
              positiveReviews: store.positiveReviews,
              negativeReviews: store.negativeReviews,
              registered: store.createdAt,
              requestCount: store.requestCount,
            } : null,
            transaction: null,
            refundOffer: null,
          } : null,
        },
      };
    });

    return {
      code: 200,
      success: true,
      message: `${total} dispute(s) found`,
      user,
      disputes: {
        edges,
        pageInfo: {
          hasNextPage: end < total,
          hasPreviousPage: start > 0,
          startCursor: edges.length ? edges[0].cursor : null,
          endCursor: edges.length ? edges[edges.length - 1].cursor : null,
          fetchedCount: edges.length,
          remainingCount: total - end,
        },
      },
    };
  },

  getUserDisputeDetails: async (
    _: unknown,
    { disputeId, first, after, last, before }: { disputeId: string; first?: number; after?: string; last?: number; before?: string },
    context: Context
  ) => {
    if (!context.user) {
      throw new GraphQLError(context.authError || "Authentication required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const { userId } = context.user;
    const db = getDB();
    const walletsDB = getWalletsDB();
    const catalogsDB = getCatalogsDB();

    const user = await db.collection<User>("users").findOne({ id: userId });
    if (!user) throw new GraphQLError("User not found");

    const dispute = await walletsDB.collection<Dispute>("Disputes").findOne({ disputeId });
    if (!dispute) {
      return { code: 404, success: false, message: "Dispute not found", user, dispute: null };
    }

    if (dispute.buyerId !== userId && dispute.sellerId !== userId) {
      return { code: 403, success: false, message: "You are not a participant in this dispute", user, dispute: null };
    }

    const order = await walletsDB.collection<Order>("Orders").findOne({ orderId: dispute.orderId });
    const store = await catalogsDB.collection<Store>("Stores").findOne({ storeId: dispute.storeId });
    const buyer = await db.collection<User>("users").findOne({ id: dispute.buyerId });
    const seller = await db.collection<User>("users").findOne({ id: dispute.sellerId });

    // Paginate messages newest-first
    const allMessages = [...(dispute.messages || [])].reverse();
    const total = allMessages.length;

    const defaultPageSize = 30;
    const pageFirst = first ?? (last == null ? defaultPageSize : undefined);
    let start = 0;
    let end = total;

    if (pageFirst != null && after) {
      start = decodeCursor(after) + 1;
      end = Math.min(start + pageFirst, total);
    } else if (pageFirst != null) {
      end = Math.min(pageFirst, total);
    } else if (last != null && before) {
      end = decodeCursor(before);
      start = Math.max(end - last, 0);
    } else if (last != null) {
      start = Math.max(total - last, 0);
    }

    const sliced = allMessages.slice(start, end);

    const messageEdges = sliced.map((m, i) => ({
      cursor: encodeCursor(start + i),
      node: {
        senderId: m.senderId,
        senderName: m.senderName,
        message: m.message,
        sentAt: m.sentAt,
      },
    }));

    return {
      code: 200,
      success: true,
      message: "Dispute retrieved successfully",
      user,
      dispute: {
        disputeId: dispute.disputeId,
        orderId: dispute.orderId,
        buyerId: dispute.buyerId,
        sellerId: dispute.sellerId,
        storeId: dispute.storeId,
        reason: dispute.reason,
        status: dispute.status,
        messages: {
          edges: messageEdges,
          pageInfo: {
            hasNextPage: end < total,
            hasPreviousPage: start > 0,
            startCursor: messageEdges.length ? messageEdges[0].cursor : null,
            endCursor: messageEdges.length ? messageEdges[messageEdges.length - 1].cursor : null,
            fetchedCount: messageEdges.length,
            remainingCount: total - end,
          },
        },
        createdAt: dispute.createdAt,
        order: order ? {
          orderId: order.orderId,
          buyerId: order.buyerId,
          buyerName: order.buyerName || buyer?.username || "",
          sellerId: order.sellerId,
          sellerName: seller?.username || "",
          storeId: order.storeId,
          product: null,
          codes: [],
          amount: order.amount,
          fee: order.fee,
          totalAmount: order.totalAmount,
          status: order.status,
          type: order.type,
          action: order.buyerId === userId ? "buy" : "sell",
          isReviewed: order.isReviewed,
          isReleased: order.isReleased,
          reviewType: order.reviewType ?? null,
          disputeReason: order.disputeReason ?? null,
          createdAt: order.createdAt,
          releasedAt: order.releasedAt,
          store: store ? {
            storeId: store.storeId,
            storeName: store.storeName,
            isActive: store.isActive,
            isApproved: store.isApproved,
            approveStatus: store.approveStatus,
            isPromoted: store.isPromoted,
            type: store.type,
            totalSales: store.totalSales,
            positiveReviews: store.positiveReviews,
            negativeReviews: store.negativeReviews,
            registered: store.createdAt,
            requestCount: store.requestCount,
          } : null,
          transaction: null,
        } : null,
      },
    };
  },

  getUserRefundOffers: async (
    _: unknown,
    { first, after, last, before }: { first?: number; after?: string; last?: number; before?: string },
    context: Context
  ) => {
    if (!context.user) {
      throw new GraphQLError(context.authError || "Authentication required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const { userId } = context.user;
    const db = getDB();
    const walletsDB = getWalletsDB();
    const catalogsDB = getCatalogsDB();

    const user = await db.collection<User>("users").findOne({ id: userId });
    if (!user) throw new GraphQLError("User not found");

    const allOffers = await walletsDB.collection<RefundOffer>("RefundOffers")
      .find({ $or: [{ buyerId: userId }, { sellerId: userId }] })
      .sort({ createdAt: -1 })
      .toArray();

    const total = allOffers.length;
    const defaultPageSize = 30;
    const pageFirst = first ?? (last == null ? defaultPageSize : undefined);
    let start = 0;
    let end = total;

    if (pageFirst != null && after) {
      start = decodeCursor(after) + 1;
      end = Math.min(start + pageFirst, total);
    } else if (pageFirst != null) {
      end = Math.min(pageFirst, total);
    } else if (last != null && before) {
      end = decodeCursor(before);
      start = Math.max(end - last, 0);
    } else if (last != null) {
      start = Math.max(total - last, 0);
    }

    const sliced = allOffers.slice(start, end);

    const edges = sliced.map((o, i) => ({
      cursor: encodeCursor(start + i),
      node: {
        refundId: o.refundId,
        orderId: o.orderId,
        buyerId: o.buyerId,
        sellerId: o.sellerId,
        storeId: o.storeId,
        quantity: o.quantity,
        refundAmount: o.refundAmount,
        sellerDeduction: o.sellerDeduction,
        status: o.status,
        createdAt: o.createdAt,
        order: null,
      },
    }));

    return {
      code: 200,
      success: true,
      message: `${total} refund offer(s) found`,
      user,
      refundOffers: {
        edges,
        pageInfo: {
          hasNextPage: end < total,
          hasPreviousPage: start > 0,
          startCursor: edges.length ? edges[0].cursor : null,
          endCursor: edges.length ? edges[edges.length - 1].cursor : null,
          fetchedCount: edges.length,
          remainingCount: total - end,
        },
      },
    };
  },
};

export const walletsMutations = {
  userDeposit: async (
    _: unknown,
    { input }: { input: { amount: number } },
    context: Context
  ) => {
    if (!context.user) {
      throw new GraphQLError(context.authError || "Authentication required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const { userId } = context.user;
    const { amount } = input;

    if (context.user.isSuspended) {
      return { code: 403, success: false, message: "Your account is suspended. You cannot make deposits.", deposit: null, payId: null, paymentLink: null };
    }

    if (amount <= 0) {
      return { code: 400, success: false, message: "Amount must be greater than 0", deposit: null, payId: null, paymentLink: null };
    }

    const db = getDB();
    const user = await db.collection<User>("users").findOne({ id: userId });

    if (!user) {
      return { code: 404, success: false, message: "User not found", deposit: null, payId: null, paymentLink: null };
    }

    if (!user.isVerified) {
      return { code: 403, success: false, message: "Please verify your account before making a deposit", deposit: null, payId: null, paymentLink: null };
    }

    // 0.2% fee for regular users, 0% for premium (minimum 0.1 for non-premium)
    const feeRate = user.isPremium ? 0 : 0.002;
    const rawFee = Math.round(amount * feeRate * 100) / 100;
    const fee = user.isPremium ? 0 : Math.max(rawFee, 0.1);
    const totalCharged = Math.round((amount + fee) * 100) / 100;

    const apiKey = process.env.GAMEKET_PAY_API_KEY;
    if (!apiKey) {
      throw new Error("Server configuration error");
    }

    let paymentResponse;
    try {
      const res = await fetch("https://api.pay.gameket.io/create-payment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey, amount: totalCharged }),
      });

      paymentResponse = await res.json();

      if (!res.ok) {
        return {
          code: res.status,
          success: false,
          message: "Payment service error",
          deposit: null,
          payId: null,
          paymentLink: null,
        };
      }
    } catch {
      return {
        code: 502,
        success: false,
        message: "Unable to reach payment service",
        deposit: null,
        payId: null,
        paymentLink: null,
      };
    }

    // Generate base64 transaction ID without special characters
    const transactionId = randomBytes(24)
      .toString("base64")
      .replace(/[+/=]/g, "");

    const payId = String(paymentResponse.transaction?.txnid || "");
    const paymentLink = String(paymentResponse.paymentLink || "");

    const walletsDB = getWalletsDB();
    const now = new Date().toISOString();

    const depositRecord: Deposit = {
      userId,
      payId,
      transactionId,
      paymentMethod: "Webcheckout",
      paymentLink,
      amount,
      fee,
      totalCharged,
      status: "pending",
      type: "deposit",
    };

    const transactionRecord: Transaction = {
      userId,
      id: transactionId,
      type: "Deposit",
      status: "pending",
      method: "Webcheckout",
      amount,
      createdAt: now,
    };

    await walletsDB.collection<Deposit>("Deposits").insertOne(depositRecord);
    await walletsDB.collection<Transaction>("Transactions").insertOne(transactionRecord);

    return {
      code: 200,
      success: true,
      message: "Deposit initiated successfully",
      id: transactionId,
      user,
      deposit: {
        amount,
        fee,
        totalCharged,
      },
      payId,
      paymentLink,
    };
  },

  addWalletOptions: async (
    _: unknown,
    { input }: { input: { value: string } },
    context: Context
  ) => {
    if (!context.user) {
      throw new GraphQLError(context.authError || "Authentication required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const { userId } = context.user;
    const value = input.value.trim();

    const name = "USDT";
    const network = "BSC";

    if (value.length === 0) {
      return { code: 400, success: false, message: "Value is required", method: null };
    }
    if (value.length > 200) {
      return { code: 400, success: false, message: "Value must be at most 200 characters", method: null };
    }

    const db = getDB();
    const walletsDB = getWalletsDB();
    const user = await db.collection<User>("users").findOne({ id: userId });
    const balances = walletsDB.collection<Balance>("Balances");

    const balance = await balances.findOne({ userId });
    if (!balance) {
      return { code: 404, success: false, message: "Wallet not found", method: null };
    }

    const method = { name, value, network, isActive: true };

    const exists = balance.methods.length > 0;
    if (exists) {
      await balances.updateOne(
        { userId },
        { $set: { "methods.0": method } }
      );
      return { code: 200, success: true, message: "Payment method updated successfully", user, method };
    }

    await balances.updateOne(
      { userId },
      { $push: { methods: method } }
    );

    return { code: 201, success: true, message: "Payment method added successfully", user, method };
  },

  userWithdraw: async (
    _: unknown,
    { amount }: { amount: number },
    context: Context
  ) => {
    if (!context.user) {
      throw new GraphQLError(context.authError || "Authentication required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    if (context.user.isSuspended) {
      return { code: 403, success: false, message: "Your account is suspended. You cannot make withdrawals.", withdrawal: null };
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      return { code: 400, success: false, message: "Amount must be greater than 0", withdrawal: null };
    }

    const withdrawalAmount = parseFloat(amount.toFixed(2));
    const serviceFee = parseFloat((withdrawalAmount * 0.01).toFixed(2));
    const networkFee = parseFloat((withdrawalAmount * 0.005).toFixed(2));
    const totalFee = parseFloat((serviceFee + networkFee).toFixed(2));
    const payoutAmount = parseFloat((withdrawalAmount - totalFee).toFixed(2));

    if (payoutAmount <= 0) {
      return { code: 400, success: false, message: "Amount is too low after fees", withdrawal: null };
    }

    const { userId } = context.user;
    const db = getDB();
    const walletsDB = getWalletsDB();

    const user = await db.collection<User>("users").findOne({ id: userId });
    if (!user) {
      return { code: 404, success: false, message: "User not found", withdrawal: null };
    }

    const balances = walletsDB.collection<Balance>("Balances");
    const balance = await balances.findOne({ userId });
    if (!balance) {
      return { code: 404, success: false, message: "Wallet not found", user, withdrawal: null };
    }

    const activeMethod = balance.methods.find((method) => method.isActive);
    if (!activeMethod) {
      return { code: 400, success: false, message: "Add an active wallet option before making a withdrawal", user, withdrawal: null };
    }

    if (balance.availableBalance < withdrawalAmount) {
      return { code: 400, success: false, message: "Insufficient balance", user, withdrawal: null };
    }

    const balanceUpdate = await balances.updateOne(
      { userId, availableBalance: { $gte: withdrawalAmount } },
      { $inc: { availableBalance: -withdrawalAmount, suspendedBalance: withdrawalAmount } }
    );

    if (balanceUpdate.modifiedCount === 0) {
      return { code: 400, success: false, message: "Insufficient balance", user, withdrawal: null };
    }

    const now = new Date().toISOString();
    const transactionId = randomBytes(24).toString("base64").replace(/[+/=]/g, "");
    const withdrawalId = randomBytes(24).toString("base64").replace(/[+/=]/g, "");

    const transactionRecord: Transaction = {
      userId,
      id: transactionId,
      type: "Withdrawal",
      status: "pending",
      method: "balance",
      amount: withdrawalAmount,
      createdAt: now,
    };

    const withdrawalRecord: Withdrawal = {
      withdrawalId,
      transactionId,
      userId,
      amount: withdrawalAmount,
      serviceFee,
      networkFee,
      totalFee,
      payoutAmount,
      wallet: {
        name: activeMethod.name,
        value: activeMethod.value,
        network: activeMethod.network,
        isActive: activeMethod.isActive,
      },
      status: "pending",
      createdAt: now,
      processedAt: null,
      processedBy: null,
    };

    await walletsDB.collection<Transaction>("Transactions").insertOne(transactionRecord);
    await walletsDB.collection<Withdrawal>("Withdrawals").insertOne(withdrawalRecord);

    return {
      code: 201,
      success: true,
      message: "Withdrawal request submitted successfully",
      user,
      withdrawal: {
        withdrawalId,
        transactionId,
        userId,
        amount: withdrawalAmount,
        serviceFee,
        networkFee,
        totalFee,
        payoutAmount,
        status: "pending",
        wallet: withdrawalRecord.wallet,
        createdAt: now,
        processedAt: null,
      },
    };
  },

  buyCodesbyUser: async (
    _: unknown,
    { productId, quantity }: { productId: string; quantity: number },
    context: Context
  ) => {
    if (!context.user) {
      throw new GraphQLError(context.authError || "Authentication required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const { userId } = context.user;

    if (context.user.isSuspended) {
      return { code: 403, success: false, message: "Your account is suspended. You cannot make purchases.", order: null, transaction: null };
    }

    if (!Number.isInteger(quantity) || quantity <= 0) {
      return { code: 400, success: false, message: "Quantity must be a positive integer", order: null, transaction: null };
    }

    const db = getDB();
    const walletsDB = getWalletsDB();
    const catalogsDB = getCatalogsDB();

    const user = await db.collection<User>("users").findOne({ id: userId });
    if (!user) {
      return { code: 404, success: false, message: "User not found", order: null, transaction: null };
    }

    if (!user.isVerified) {
      return { code: 403, success: false, message: "Please verify your account before making a purchase", order: null, transaction: null };
    }

    const product = await catalogsDB.collection<Product>("Products").findOne({ productId });
    if (!product) {
      return { code: 404, success: false, message: "Product not found", order: null, transaction: null };
    }

    if (!product.isActive) {
      return { code: 400, success: false, message: "Product is not available", order: null, transaction: null };
    }

    // Check store is active and approved
    const store = await catalogsDB.collection<Store>("Stores").findOne({ storeId: product.storeId });
    if (!store || !store.isActive) {
      return { code: 400, success: false, message: "This store is currently unavailable", order: null, transaction: null };
    }

    if (!store.isApproved) {
      return { code: 400, success: false, message: "This store is not approved", order: null, transaction: null };
    }

    // Prevent buying own product
    if (product.userId === userId) {
      return { code: 403, success: false, message: "You cannot purchase your own product", order: null, transaction: null };
    }

    // Check if buyer is blacklisted by the store
    const isBlacklisted = await catalogsDB.collection<Blacklist>("Blacklists").findOne({ storeId: product.storeId, userId });
    if (isBlacklisted) {
      return { code: 403, success: false, message: "You are blocked from purchasing from this store", order: null, transaction: null };
    }

    // Check enough codes available
    if (product.availableCodes.length < quantity) {
      return { code: 400, success: false, message: `Only ${product.availableCodes.length} code(s) available`, order: null, transaction: null };
    }

    const amount = parseFloat((product.price * quantity).toFixed(2));
    const fee = parseFloat(Math.max(amount * 0.005, 0.1).toFixed(2));
    const totalAmount = parseFloat((amount + fee).toFixed(2));

    // Check buyer balance
    const buyerBalance = await walletsDB.collection<Balance>("Balances").findOne({ userId });
    if (!buyerBalance || buyerBalance.availableBalance < totalAmount) {
      return { code: 400, success: false, message: "Insufficient balance", order: null, transaction: null };
    }

    // Take the codes from the front of availableCodes (still encrypted)
    const purchasedCodes = product.availableCodes.slice(0, quantity);
    const remainingCodes = product.availableCodes.slice(quantity);

    // Debit buyer (total including fee)
    await walletsDB.collection<Balance>("Balances").updateOne(
      { userId },
      { $inc: { availableBalance: -totalAmount } }
    );

    // Credit store owner's suspended balance (released after 24hrs)
    await walletsDB.collection<Balance>("Balances").updateOne(
      { userId: product.userId },
      { $inc: { suspendedBalance: amount } }
    );

    // Update product: move codes from available to sold, update counts
    await catalogsDB.collection<Product>("Products").updateOne(
      { productId },
      {
        $set: { availableCodes: remainingCodes },
        $push: { soldCodes: { $each: purchasedCodes } },
        $inc: { available: -quantity, sold: quantity },
      }
    );

    // Update store total sales
    const updatedStore = await catalogsDB.collection<Store>("Stores").findOneAndUpdate(
      { storeId: product.storeId },
      { $inc: { totalSales: quantity } },
      { returnDocument: "after" }
    );

    // Update seller rank based on new total sales
    if (updatedStore) {
      const newRank = getRankFromSales(updatedStore.totalSales);
      await db.collection<User>("users").updateOne(
        { id: product.userId },
        { $set: { rank: newRank } }
      );
    }

    // Create transaction for buyer
    const now = new Date().toISOString();
    const releasedAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const transactionId = randomBytes(24).toString("base64").replace(/[+/=]/g, "");

    const transaction: Transaction = {
      userId,
      id: transactionId,
      type: "ProductPurchase",
      status: "completed",
      method: "balance",
      amount: totalAmount,
      createdAt: now,
    };

    await walletsDB.collection<Transaction>("Transactions").insertOne(transaction);

    // Create transaction for seller
    const sellerTransactionId = randomBytes(24).toString("base64").replace(/[+/=]/g, "");

    const sellerTransaction: Transaction = {
      userId: product.userId,
      id: sellerTransactionId,
      type: "SoldCodes",
      status: "pending",
      method: "balance",
      amount,
      createdAt: now,
    };

    await walletsDB.collection<Transaction>("Transactions").insertOne(sellerTransaction);

    // Create order
    const orderId = randomBytes(36).toString("base64").replace(/[+/=]/g, "");

    const order: Order = {
      orderId,
      buyerId: userId,
      buyerName: user.username,
      sellerId: product.userId,
      storeId: product.storeId,
      productId,
      buyerTransactionId: transactionId,
      sellerTransactionId,
      codes: purchasedCodes,
      quantity,
      amount,
      fee,
      totalAmount,
      status: "completed",
      type: "userpurchase",
      isReviewed: false,
      reviewType: null,
      isReleased: false,
      disputeReason: null,
      createdAt: now,
      releasedAt,
    };

    await walletsDB.collection<Order>("Orders").insertOne(order);

    return {
      code: 200,
      success: true,
      message: "Purchase successful",
      user,
      order: {
        orderId: order.orderId,
        buyerId: order.buyerId,
        buyerName: user.username,
        sellerId: order.sellerId,
        sellerName: store?.storeName || "",
        storeId: order.storeId,
        product: {
          productId: product.productId,
          catalog: product.catalog,
          category: product.category,
          region: product.region,
          name: product.name,
          description: product.description,
          marketPrice: product.marketPrice,
          price: product.price,
          discount: product.discount,
          isActive: product.isActive,
          isPromoted: product.isPromoted,
          available: product.available - quantity,
          sold: product.sold + quantity,
          type: product.type,
          createdAt: product.createdAt,
          store: updatedStore ? {
            storeId: updatedStore.storeId,
            storeName: updatedStore.storeName,
            isActive: updatedStore.isActive,
            isApproved: updatedStore.isApproved,
            approveStatus: updatedStore.approveStatus,
            isPromoted: updatedStore.isPromoted,
            type: updatedStore.type,
            totalSales: updatedStore.totalSales,
            positiveReviews: updatedStore.positiveReviews,
            negativeReviews: updatedStore.negativeReviews,
            registered: updatedStore.createdAt,
            requestCount: updatedStore.requestCount,
          } : null,
        },
        codes: order.codes.map(decrypt),
        amount: order.amount,
        fee: order.fee,
        totalAmount: order.totalAmount,
        status: order.status,
        type: order.type,
        action: "buy",
        isReviewed: order.isReviewed,
        isReleased: order.isReleased,
        reviewType: order.reviewType ?? null,
        disputeReason: order.disputeReason ?? null,
        createdAt: order.createdAt,
        releasedAt: order.releasedAt,
        store: updatedStore ? {
          storeId: updatedStore.storeId,
          storeName: updatedStore.storeName,
          isActive: updatedStore.isActive,
          isApproved: updatedStore.isApproved,
          approveStatus: updatedStore.approveStatus,
          isPromoted: updatedStore.isPromoted,
          type: updatedStore.type,
          totalSales: updatedStore.totalSales,
          positiveReviews: updatedStore.positiveReviews,
          negativeReviews: updatedStore.negativeReviews,
          registered: updatedStore.createdAt,
          requestCount: updatedStore.requestCount,
        } : null,
        transaction: {
          id: transaction.id,
          type: transaction.type,
          status: transaction.status,
          method: transaction.method,
          amount: transaction.amount,
          createdAt: transaction.createdAt,
        },
      },
      transaction: {
        id: transaction.id,
        type: transaction.type,
        status: transaction.status,
        method: transaction.method,
        amount: transaction.amount,
        createdAt: transaction.createdAt,
      },
    };
  },

  buyCodesbyAnon: async (
    _: unknown,
    { productId, quantity, email }: { productId: string; quantity: number; email: string }
  ) => {
    const errorResponse = { order: null, deposit: null, payId: null, paymentLink: null };

    if (!Number.isInteger(quantity) || quantity <= 0) {
      return { code: 400, success: false, message: "Quantity must be a positive integer", ...errorResponse };
    }

    if (quantity > 2) {
      return { code: 400, success: false, message: "Maximum quantity is 2", ...errorResponse };
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return { code: 400, success: false, message: "Invalid email address", ...errorResponse };
    }

    const walletsDB = getWalletsDB();
    const catalogsDB = getCatalogsDB();

    const product = await catalogsDB.collection<Product>("Products").findOne({ productId });
    if (!product) {
      return { code: 404, success: false, message: "Product not found", ...errorResponse };
    }

    if (!product.isActive) {
      return { code: 400, success: false, message: "Product is not available", ...errorResponse };
    }

    const store = await catalogsDB.collection<Store>("Stores").findOne({ storeId: product.storeId });
    if (!store || !store.isActive) {
      return { code: 400, success: false, message: "This store is currently unavailable", ...errorResponse };
    }

    if (!store.isApproved) {
      return { code: 400, success: false, message: "This store is not approved", ...errorResponse };
    }

    if (product.availableCodes.length < quantity) {
      return { code: 400, success: false, message: `Only ${product.availableCodes.length} code(s) available`, ...errorResponse };
    }

    const amount = parseFloat((product.price * quantity).toFixed(2));
    const networkFee = parseFloat((amount * 0.002).toFixed(2));
    const serviceFee = parseFloat(Math.max(amount * 0.005, 0.1).toFixed(2));
    const fee = parseFloat((serviceFee + networkFee).toFixed(2));
    const totalAmount = parseFloat((amount + fee).toFixed(2));

    const apiKey = process.env.GAMEKET_PAY_API_KEY;
    if (!apiKey) {
      throw new Error("Server configuration error");
    }

    let paymentResponse;
    try {
      const res = await fetch("https://api.pay.gameket.io/create-payment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey, amount: totalAmount }),
      });

      paymentResponse = await res.json();

      if (!res.ok) {
        return { code: res.status, success: false, message: "Payment service error", ...errorResponse };
      }
    } catch {
      return { code: 502, success: false, message: "Unable to reach payment service", ...errorResponse };
    }

    const now = new Date().toISOString();
    const releasedAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const transactionId = randomBytes(24).toString("base64").replace(/[+/=]/g, "");
    const payId = String(paymentResponse.transaction?.txnid || "");
    const paymentLink = String(paymentResponse.paymentLink || "");

    const orderId = randomBytes(36).toString("base64").replace(/[+/=]/g, "");
    const buyerName = `Guest-${randomBytes(3).toString("hex")}`;

    // Create deposit record (order is created in webhook after payment completes)
    const depositRecord: Deposit = {
      userId: email,
      payId,
      transactionId,
      orderId,
      paymentMethod: "Webcheckout",
      paymentLink,
      amount,
      fee,
      totalCharged: totalAmount,
      status: "pending",
      type: "codepurchase",
      sellerId: product.userId,
      storeId: product.storeId,
      productId,
      quantity,
      buyerName,
    };

    await walletsDB.collection<Deposit>("Deposits").insertOne(depositRecord);

    return {
      code: 200,
      success: true,
      message: "Payment initiated",
      order: {
        orderId,
        buyerId: "anon-gameket-id",
        buyerName,
        sellerId: product.userId,
        sellerName: store.storeName,
        storeId: product.storeId,
        product: {
          productId: product.productId,
          catalog: product.catalog,
          category: product.category,
          region: product.region,
          name: product.name,
          description: product.description,
          marketPrice: product.marketPrice,
          price: product.price,
          discount: product.discount,
          isActive: product.isActive,
          isPromoted: product.isPromoted,
          available: product.available,
          sold: product.sold,
          type: product.type,
          createdAt: product.createdAt,
          store: {
            storeId: store.storeId,
            storeName: store.storeName,
            isActive: store.isActive,
            isApproved: store.isApproved,
            approveStatus: store.approveStatus,
            isPromoted: store.isPromoted,
            type: store.type,
            totalSales: store.totalSales,
            positiveReviews: store.positiveReviews,
            negativeReviews: store.negativeReviews,
            registered: store.createdAt,
            requestCount: store.requestCount,
          },
        },
        codes: [],
        amount,
        fee,
        totalAmount,
        status: "pending",
        type: "anonpurchase",
        action: "buy",
        isReviewed: false,
        reviewType: null,
        createdAt: now,
        releasedAt,
        store: {
          storeId: store.storeId,
          storeName: store.storeName,
          isActive: store.isActive,
          isApproved: store.isApproved,
          approveStatus: store.approveStatus,
          isPromoted: store.isPromoted,
          type: store.type,
          totalSales: store.totalSales,
          positiveReviews: store.positiveReviews,
          negativeReviews: store.negativeReviews,
          registered: store.createdAt,
          requestCount: store.requestCount,
        },
        transaction: null,
      },
      deposit: {
        amount,
        fee,
        totalCharged: totalAmount,
      },
      payId,
      paymentLink,
    };
  },

  reviewOrder: async (
    _: unknown,
    { orderId, type }: { orderId: string; type: "positive" | "negative" },
    context: Context
  ) => {
    if (!context.user) {
      throw new GraphQLError(context.authError || "Authentication required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const { userId } = context.user;
    const db = getDB();
    const walletsDB = getWalletsDB();
    const catalogsDB = getCatalogsDB();

    const user = await db.collection<User>("users").findOne({ id: userId });
    if (!user) {
      return { code: 404, success: false, message: "User not found", user: null, review: null };
    }

    const order = await walletsDB.collection<Order>("Orders").findOne({ orderId });
    if (!order) {
      return { code: 404, success: false, message: "Order not found", user, review: null };
    }

    if (order.buyerId !== userId) {
      return { code: 403, success: false, message: "Only the buyer can review an order", user, review: null };
    }

    if (order.status !== "completed") {
      return { code: 400, success: false, message: "Only completed orders can be reviewed", user, review: null };
    }

    if (order.isReviewed) {
      return { code: 409, success: false, message: "This order has already been reviewed", user, review: null };
    }

    const product = await catalogsDB.collection<Product>("Products").findOne({ productId: order.productId });
    const productName = product?.name || "product";

    const positiveTemplates = [
      `Swift delivery. Successfully redeemed ${productName} code. Thumbs up for the seller! Looking forward to more competitive prices ahead.`,
      `Fast and smooth transaction for ${productName}. Code worked instantly. Highly recommended seller!`,
      `Great experience purchasing ${productName}. Quick delivery and the code was valid. Will buy again!`,
      `${productName} code delivered in seconds. Everything worked as expected. Excellent service!`,
      `Impressed with the speed of delivery for ${productName}. Code redeemed without any issues. Top seller!`,
      `Purchased ${productName} and received the code immediately. Smooth process from start to finish.`,
      `${productName} was exactly as described. Instant delivery and easy redemption. Five stars!`,
      `Reliable seller! ${productName} code arrived quickly and worked perfectly. Would recommend to anyone.`,
      `Seamless purchase of ${productName}. The code was delivered fast and redeemed without problems.`,
      `Very satisfied with my ${productName} purchase. Quick turnaround and genuine code. Great seller!`,
      `${productName} delivered promptly. No issues at all. Will definitely return for more purchases.`,
      `Bought ${productName} and the code was valid right away. Fast, easy, and trustworthy seller.`,
      `Excellent transaction for ${productName}. Instant code delivery and it worked on the first try.`,
      `${productName} purchase went perfectly. Speedy delivery and legitimate code. Couldn't ask for more.`,
      `Happy with my ${productName} order. The seller was fast and the code worked flawlessly.`,
      `Smooth and quick delivery of ${productName}. Code activated without any hassle. Recommended!`,
      `${productName} code was genuine and delivered instantly. Outstanding service from this seller.`,
      `Fantastic experience buying ${productName}. Everything was quick, easy, and the code was legit.`,
      `Got my ${productName} code within seconds. Worked perfectly. This seller is dependable!`,
      `${productName} delivered as promised. Fast service, valid code, great value. Will shop here again.`,
    ];

    const negativeTemplates = [
      `Disappointed with ${productName} purchase. Code did not work upon redemption. Not satisfied with this seller.`,
      `${productName} code was invalid. Delivery was slow and the experience was frustrating overall.`,
      `Had issues with my ${productName} order. The code failed to redeem. Would not recommend this seller.`,
      `Poor experience with ${productName}. Code was already used. Very disappointed with the purchase.`,
      `${productName} code didn't work as expected. Wasted my time trying to redeem it. Not happy.`,
      `Unsatisfied with ${productName} purchase. The code was rejected during redemption. Needs improvement.`,
      `${productName} was not as described. Code redemption failed. This seller needs to do better.`,
      `Frustrating transaction for ${productName}. The code was invalid and support was unhelpful.`,
      `Bought ${productName} but the code was defective. Took too long and still unresolved. Avoid this seller.`,
      `${productName} code arrived late and didn't even work. Very poor service from this seller.`,
      `Not a good experience with ${productName}. Invalid code and no resolution offered. Disappointed.`,
      `${productName} purchase was a letdown. Code failed to activate. Would not buy from here again.`,
      `Terrible experience with ${productName}. The code was unusable and I feel misled by the listing.`,
      `${productName} code was a dud. Slow delivery and invalid redemption. Stay away from this seller.`,
      `Regret purchasing ${productName}. Code did not work and the process was a hassle from the start.`,
      `${productName} order was problematic. Code was expired or already redeemed. Very unsatisfactory.`,
      `Had a bad experience buying ${productName}. The code was rejected and I couldn't get a refund.`,
      `${productName} didn't live up to expectations. Invalid code received. Will not be returning.`,
      `Unpleasant transaction for ${productName}. Code redemption failed repeatedly. Not trustworthy.`,
      `${productName} purchase was a waste. Code didn't work and the seller was unresponsive. Avoid.`,
    ];

    const templates = type === "positive" ? positiveTemplates : negativeTemplates;
    const reviewText = templates[Math.floor(Math.random() * templates.length)];
    const now = new Date().toISOString();

    const review: Review = {
      reviewerId: userId,
      orderId,
      type,
      review: reviewText,
      date: now,
    };

    // Mark order as reviewed
    await walletsDB.collection<Order>("Orders").updateOne(
      { orderId },
      { $set: { isReviewed: true, reviewType: type } }
    );

    // Update store review counts and push review
    const updateField = type === "positive" ? "positiveReviews" : "negativeReviews";
    await catalogsDB.collection<Store>("Stores").updateOne(
      { storeId: order.storeId },
      {
        $inc: { [updateField]: 1 },
        $push: { reviews: review },
      }
    );

    return {
      code: 200,
      success: true,
      message: "Review submitted successfully",
      user,
      review: {
        reviewerName: user.username,
        orderId: review.orderId,
        type: review.type,
        review: review.review,
        date: review.date,
      },
    };
  },

  refundOrder: async (_: unknown, { orderId, quantity }: { orderId: string; quantity: number }, context: Context) => {
    if (!context.user) {
      throw new GraphQLError(context.authError || "Not authenticated");
    }

    const userId = context.user.userId;
    const db = getDB();
    const walletsDB = getWalletsDB();
    const catalogsDB = getCatalogsDB();

    const user = await db.collection<User>("users").findOne({ id: userId });
    if (!user) {
      return { code: 404, success: false, message: "User not found", user: null, order: null, refundOffer: null };
    }

    const order = await walletsDB.collection<Order>("Orders").findOne({ orderId });
    if (!order) {
      return { code: 404, success: false, message: "Order not found", user, order: null, refundOffer: null };
    }

    // Only the seller (store owner) can refund
    if (order.sellerId !== userId) {
      return { code: 403, success: false, message: "Only the store owner can refund this order", user, order: null, refundOffer: null };
    }

    // No refunds for anonymous purchases
    if (order.buyerId === "anon-gameket-id") {
      return { code: 400, success: false, message: "Refunds are not available for guest purchases", user, order: null, refundOffer: null };
    }

    // Cannot refund already released or refunded orders
    if (order.isReleased) {
      return { code: 400, success: false, message: "Cannot refund an already released order", user, order: null, refundOffer: null };
    }

    if (order.status === "refunded") {
      return { code: 400, success: false, message: "This order has already been refunded", user, order: null, refundOffer: null };
    }

    const now = new Date().toISOString();
    if (order.releasedAt <= now) {
      return { code: 400, success: false, message: "Cannot refund, the release period has already passed", user, order: null, refundOffer: null };
    }

    if (quantity <= 0 || quantity > order.quantity) {
      return { code: 400, success: false, message: `Quantity must be between 1 and ${order.quantity}`, user, order: null, refundOffer: null };
    }

    // Check for existing pending refund offer on this order
    const existingOffer = await walletsDB.collection<RefundOffer>("RefundOffers").findOne({ orderId, status: "pending" });
    if (existingOffer) {
      return { code: 400, success: false, message: "There is already a pending refund offer for this order", user, order: null, refundOffer: null };
    }

    // Limit to 3 refund offers per order (declined offers count toward the limit)
    const declinedCount = await walletsDB.collection<RefundOffer>("RefundOffers").countDocuments({ orderId, status: "declined" });
    if (declinedCount >= 3) {
      return { code: 400, success: false, message: "Maximum of 3 refund offers reached for this order", user, order: null, refundOffer: null };
    }

    // Calculate refund amounts based on per-unit price at time of order
    const pricePerUnit = order.amount / order.quantity;
    const feePerUnit = order.fee / order.quantity;
    const sellerDeduction = parseFloat((pricePerUnit * quantity).toFixed(2));
    const refundAmount = parseFloat(((pricePerUnit + feePerUnit) * quantity).toFixed(2));

    const store = await catalogsDB.collection<Store>("Stores").findOne({ storeId: order.storeId });

    // Full refund (quantity === order.quantity): process immediately
    if (quantity === order.quantity) {
      // Refund buyer
      await walletsDB.collection<Balance>("Balances").updateOne(
        { userId: order.buyerId },
        { $inc: { availableBalance: refundAmount } }
      );

      // Deduct seller from the correct balance depending on release status
      if (order.isReleased) {
        await walletsDB.collection<Balance>("Balances").updateOne(
          { userId: order.sellerId },
          { $inc: { availableBalance: -sellerDeduction } }
        );
      } else {
        await walletsDB.collection<Balance>("Balances").updateOne(
          { userId: order.sellerId },
          { $inc: { suspendedBalance: -sellerDeduction } }
        );
      }

      // Decrement store totalSales and recalculate rank
      const updatedStore = await catalogsDB.collection<Store>("Stores").findOneAndUpdate(
        { storeId: order.storeId },
        { $inc: { totalSales: -order.quantity } },
        { returnDocument: "after" }
      );

      if (updatedStore) {
        const newRank = getRankFromSales(updatedStore.totalSales);
        await db.collection<User>("users").updateOne(
          { id: order.sellerId },
          { $set: { rank: newRank } }
        );
      }

      // Mark transactions as refunded
      await walletsDB.collection<Transaction>("Transactions").updateOne(
        { id: order.buyerTransactionId },
        { $set: { status: "refunded" } }
      );
      await walletsDB.collection<Transaction>("Transactions").updateOne(
        { id: order.sellerTransactionId },
        { $set: { status: "refunded" } }
      );

      // Mark order as refunded
      await walletsDB.collection<Order>("Orders").updateOne(
        { orderId },
        { $set: { status: "refunded", isReleased: true } }
      );

      // If order was disputed, close the dispute
      if (order.status === "disputed") {
        await walletsDB.collection<Dispute>("Disputes").updateOne(
          { orderId },
          { $set: { status: "closed" } }
        );
      }

      const finalStore = updatedStore || store;
      return {
        code: 200,
        success: true,
        message: "Full refund processed successfully",
        user,
        order: {
          orderId: order.orderId,
          buyerId: order.buyerId,
          buyerName: order.buyerName,
          sellerId: order.sellerId,
          sellerName: user.username,
          storeId: order.storeId,
          product: null,
          codes: [],
          amount: order.amount,
          fee: order.fee,
          totalAmount: order.totalAmount,
          status: "refunded",
          type: order.type,
          action: "sell",
          isReviewed: order.isReviewed,
          isReleased: true,
          reviewType: order.reviewType ?? null,
          disputeReason: order.disputeReason ?? null,
          createdAt: order.createdAt,
          releasedAt: order.releasedAt,
          store: finalStore ? {
            storeId: finalStore.storeId,
            storeName: finalStore.storeName,
            isActive: finalStore.isActive,
            isApproved: finalStore.isApproved,
            approveStatus: finalStore.approveStatus,
            isPromoted: finalStore.isPromoted,
            type: finalStore.type,
            totalSales: finalStore.totalSales,
            positiveReviews: finalStore.positiveReviews,
            negativeReviews: finalStore.negativeReviews,
            registered: finalStore.createdAt,
            requestCount: finalStore.requestCount,
          } : null,
          transaction: null,
        },
        refundOffer: null,
      };
    }

    // Partial refund: create an offer for the buyer to accept/decline
    const refundId = randomBytes(24).toString("base64").replace(/[+/=]/g, "");

    const refundOffer: RefundOffer = {
      refundId,
      orderId: order.orderId,
      buyerId: order.buyerId,
      sellerId: order.sellerId,
      storeId: order.storeId,
      quantity,
      refundAmount,
      sellerDeduction,
      status: "pending",
      createdAt: now,
    };

    await walletsDB.collection<RefundOffer>("RefundOffers").insertOne(refundOffer);

    const seller = await db.collection<User>("users").findOne({ id: order.sellerId });

    return {
      code: 200,
      success: true,
      message: `Partial refund offer created for ${quantity} of ${order.quantity} item(s). Awaiting buyer approval.`,
      user,
      order: null,
      refundOffer: {
        refundId,
        orderId: order.orderId,
        buyerId: order.buyerId,
        sellerId: order.sellerId,
        storeId: order.storeId,
        quantity,
        refundAmount,
        sellerDeduction,
        status: "pending",
        createdAt: now,
        order: {
          orderId: order.orderId,
          buyerId: order.buyerId,
          buyerName: order.buyerName,
          sellerId: order.sellerId,
          sellerName: seller?.username || "",
          storeId: order.storeId,
          product: null,
          codes: [],
          amount: order.amount,
          fee: order.fee,
          totalAmount: order.totalAmount,
          status: order.status,
          type: order.type,
          action: "sell",
          isReviewed: order.isReviewed,
          isReleased: order.isReleased,
          reviewType: order.reviewType ?? null,
          disputeReason: order.disputeReason ?? null,
          createdAt: order.createdAt,
          releasedAt: order.releasedAt,
          store: store ? {
            storeId: store.storeId,
            storeName: store.storeName,
            isActive: store.isActive,
            isApproved: store.isApproved,
            approveStatus: store.approveStatus,
            isPromoted: store.isPromoted,
            type: store.type,
            totalSales: store.totalSales,
            positiveReviews: store.positiveReviews,
            negativeReviews: store.negativeReviews,
            registered: store.createdAt,
            requestCount: store.requestCount,
          } : null,
          transaction: null,
        },
      },
    };
  },

  disputeOrder: async (_: unknown, { orderId, reason }: { orderId: string; reason?: string }, context: Context) => {
    if (!context.user) {
      throw new GraphQLError(context.authError || "Not authenticated");
    }

    const userId = context.user.userId;
    const db = getDB();
    const walletsDB = getWalletsDB();
    const catalogsDB = getCatalogsDB();

    const user = await db.collection<User>("users").findOne({ id: userId });
    if (!user) {
      return { code: 404, success: false, message: "User not found", user: null, dispute: null };
    }

    const order = await walletsDB.collection<Order>("Orders").findOne({ orderId });
    if (!order) {
      return { code: 404, success: false, message: "Order not found", user, dispute: null };
    }

    // Only the buyer can dispute
    if (order.buyerId !== userId) {
      return { code: 403, success: false, message: "Only the buyer can dispute this order", user, dispute: null };
    }

    if (order.isReleased) {
      return { code: 400, success: false, message: "Cannot dispute an already released order", user, dispute: null };
    }

    if (order.status === "disputed") {
      return { code: 400, success: false, message: "This order is already disputed", user, dispute: null };
    }

    if (order.status === "refunded") {
      return { code: 400, success: false, message: "Cannot dispute a refunded order", user, dispute: null };
    }

    const now = new Date().toISOString();
    if (order.releasedAt <= now) {
      return { code: 400, success: false, message: "Cannot dispute, the release period has already passed", user, dispute: null };
    }

    // Create dispute record with initial message
    const disputeId = randomBytes(24).toString("base64").replace(/[+/=]/g, "");
    const messages: DisputeMessage[] = reason ? [{
      senderId: userId,
      senderName: user.username,
      message: reason,
      sentAt: now,
    }] : [];

    const dispute: Dispute = {
      disputeId,
      orderId: order.orderId,
      buyerId: order.buyerId,
      sellerId: order.sellerId,
      storeId: order.storeId,
      reason: reason || null,
      status: "open",
      messages,
      createdAt: now,
    };

    await walletsDB.collection<Dispute>("Disputes").insertOne(dispute);

    // Mark order as disputed
    await walletsDB.collection<Order>("Orders").updateOne(
      { orderId },
      { $set: { status: "disputed", disputeReason: reason || null } }
    );

    const store = await catalogsDB.collection<Store>("Stores").findOne({ storeId: order.storeId });
    const seller = await db.collection<User>("users").findOne({ id: order.sellerId });

    return {
      code: 200,
      success: true,
      message: "Order disputed successfully",
      user,
      dispute: {
        disputeId,
        orderId: order.orderId,
        buyerId: order.buyerId,
        sellerId: order.sellerId,
        storeId: order.storeId,
        reason: reason || null,
        status: "open",
        messages: buildMessagesConnection(messages),
        createdAt: now,
        order: {
          orderId: order.orderId,
          buyerId: order.buyerId,
          buyerName: order.buyerName || user.username,
          sellerId: order.sellerId,
          sellerName: seller?.username || "",
          storeId: order.storeId,
          product: null,
          codes: [],
          amount: order.amount,
          fee: order.fee,
          totalAmount: order.totalAmount,
          status: "disputed",
          type: order.type,
          action: "buy",
          isReviewed: order.isReviewed,
          isReleased: order.isReleased,
          reviewType: order.reviewType ?? null,
          disputeReason: reason || null,
          createdAt: order.createdAt,
          releasedAt: order.releasedAt,
          store: store ? {
            storeId: store.storeId,
            storeName: store.storeName,
            isActive: store.isActive,
            isApproved: store.isApproved,
            approveStatus: store.approveStatus,
            isPromoted: store.isPromoted,
            type: store.type,
            totalSales: store.totalSales,
            positiveReviews: store.positiveReviews,
            negativeReviews: store.negativeReviews,
            registered: store.createdAt,
            requestCount: store.requestCount,
          } : null,
          transaction: null,
        },
      },
    };
  },

  updateDispute: async (_: unknown, { disputeId, message }: { disputeId: string; message: string }, context: Context) => {
    if (!context.user) {
      throw new GraphQLError(context.authError || "Not authenticated");
    }

    const userId = context.user.userId;
    const db = getDB();
    const walletsDB = getWalletsDB();
    const catalogsDB = getCatalogsDB();

    const user = await db.collection<User>("users").findOne({ id: userId });
    if (!user) {
      return { code: 404, success: false, message: "User not found", user: null, dispute: null };
    }

    const dispute = await walletsDB.collection<Dispute>("Disputes").findOne({ disputeId });
    if (!dispute) {
      return { code: 404, success: false, message: "Dispute not found", user, dispute: null };
    }

    // Only buyer or seller can update
    if (dispute.buyerId !== userId && dispute.sellerId !== userId) {
      return { code: 403, success: false, message: "You are not a participant in this dispute", user, dispute: null };
    }

    if (dispute.status === "closed") {
      return { code: 400, success: false, message: "Cannot update a closed dispute", user, dispute: null };
    }

    const now = new Date().toISOString();
    const newMessage: DisputeMessage = {
      senderId: userId,
      senderName: user.username,
      message,
      sentAt: now,
    };

    await walletsDB.collection<Dispute>("Disputes").updateOne(
      { disputeId },
      { $push: { messages: newMessage } }
    );

    const updatedMessages = [...(dispute.messages || []), newMessage];

    const order = await walletsDB.collection<Order>("Orders").findOne({ orderId: dispute.orderId });
    const store = await catalogsDB.collection<Store>("Stores").findOne({ storeId: dispute.storeId });
    const buyer = await db.collection<User>("users").findOne({ id: dispute.buyerId });
    const seller = await db.collection<User>("users").findOne({ id: dispute.sellerId });

    return {
      code: 200,
      success: true,
      message: "Dispute updated successfully",
      user,
      dispute: {
        disputeId: dispute.disputeId,
        orderId: dispute.orderId,
        buyerId: dispute.buyerId,
        sellerId: dispute.sellerId,
        storeId: dispute.storeId,
        reason: dispute.reason,
        status: dispute.status,
        messages: buildMessagesConnection(updatedMessages),
        createdAt: dispute.createdAt,
        order: order ? {
          orderId: order.orderId,
          buyerId: order.buyerId,
          buyerName: order.buyerName || buyer?.username || "",
          sellerId: order.sellerId,
          sellerName: seller?.username || "",
          storeId: order.storeId,
          product: null,
          codes: [],
          amount: order.amount,
          fee: order.fee,
          totalAmount: order.totalAmount,
          status: order.status,
          type: order.type,
          action: order.buyerId === userId ? "buy" : "sell",
          isReviewed: order.isReviewed,
          isReleased: order.isReleased,
          reviewType: order.reviewType ?? null,
          disputeReason: order.disputeReason ?? null,
          createdAt: order.createdAt,
          releasedAt: order.releasedAt,
          store: store ? {
            storeId: store.storeId,
            storeName: store.storeName,
            isActive: store.isActive,
            isApproved: store.isApproved,
            approveStatus: store.approveStatus,
            isPromoted: store.isPromoted,
            type: store.type,
            totalSales: store.totalSales,
            positiveReviews: store.positiveReviews,
            negativeReviews: store.negativeReviews,
            registered: store.createdAt,
            requestCount: store.requestCount,
          } : null,
          transaction: null,
        } : null,
      },
    };
  },

  closeDispute: async (_: unknown, { disputeId }: { disputeId: string }, context: Context) => {
    if (!context.user) {
      throw new GraphQLError(context.authError || "Not authenticated");
    }

    const userId = context.user.userId;
    const db = getDB();
    const walletsDB = getWalletsDB();
    const catalogsDB = getCatalogsDB();

    const user = await db.collection<User>("users").findOne({ id: userId });
    if (!user) {
      return { code: 404, success: false, message: "User not found", user: null, dispute: null };
    }

    const dispute = await walletsDB.collection<Dispute>("Disputes").findOne({ disputeId });
    if (!dispute) {
      return { code: 404, success: false, message: "Dispute not found", user, dispute: null };
    }

    if (dispute.buyerId !== userId) {
      return { code: 403, success: false, message: "Only the buyer can close a dispute", user, dispute: null };
    }

    if (dispute.status === "closed") {
      return { code: 400, success: false, message: "This dispute is already closed", user, dispute: null };
    }

    await walletsDB.collection<Dispute>("Disputes").updateOne(
      { disputeId },
      { $set: { status: "closed" } }
    );

    const order = await walletsDB.collection<Order>("Orders").findOne({ orderId: dispute.orderId });
    const store = await catalogsDB.collection<Store>("Stores").findOne({ storeId: dispute.storeId });
    const buyer = await db.collection<User>("users").findOne({ id: dispute.buyerId });
    const seller = await db.collection<User>("users").findOne({ id: dispute.sellerId });

    return {
      code: 200,
      success: true,
      message: "Dispute closed successfully",
      user,
      dispute: {
        disputeId: dispute.disputeId,
        orderId: dispute.orderId,
        buyerId: dispute.buyerId,
        sellerId: dispute.sellerId,
        storeId: dispute.storeId,
        reason: dispute.reason,
        status: "closed",
        messages: buildMessagesConnection(dispute.messages || []),
        createdAt: dispute.createdAt,
        order: order ? {
          orderId: order.orderId,
          buyerId: order.buyerId,
          buyerName: order.buyerName || buyer?.username || "",
          sellerId: order.sellerId,
          sellerName: seller?.username || "",
          storeId: order.storeId,
          product: null,
          codes: [],
          amount: order.amount,
          fee: order.fee,
          totalAmount: order.totalAmount,
          status: order.status,
          type: order.type,
          action: "buy",
          isReviewed: order.isReviewed,
          isReleased: order.isReleased,
          reviewType: order.reviewType ?? null,
          disputeReason: order.disputeReason ?? null,
          createdAt: order.createdAt,
          releasedAt: order.releasedAt,
          store: store ? {
            storeId: store.storeId,
            storeName: store.storeName,
            isActive: store.isActive,
            isApproved: store.isApproved,
            approveStatus: store.approveStatus,
            isPromoted: store.isPromoted,
            type: store.type,
            totalSales: store.totalSales,
            positiveReviews: store.positiveReviews,
            negativeReviews: store.negativeReviews,
            registered: store.createdAt,
            requestCount: store.requestCount,
          } : null,
          transaction: null,
        } : null,
      },
    };
  },

  acceptRefund: async (_: unknown, { refundId }: { refundId: string }, context: Context) => {
    if (!context.user) {
      throw new GraphQLError(context.authError || "Not authenticated");
    }

    const userId = context.user.userId;
    const db = getDB();
    const walletsDB = getWalletsDB();
    const catalogsDB = getCatalogsDB();

    const user = await db.collection<User>("users").findOne({ id: userId });
    if (!user) {
      return { code: 404, success: false, message: "User not found", user: null, refundOffer: null };
    }

    const offer = await walletsDB.collection<RefundOffer>("RefundOffers").findOne({ refundId });
    if (!offer) {
      return { code: 404, success: false, message: "Refund offer not found", user, refundOffer: null };
    }

    // Only the buyer can accept
    if (offer.buyerId !== userId) {
      return { code: 403, success: false, message: "Only the buyer can accept a refund offer", user, refundOffer: null };
    }

    if (offer.status !== "pending") {
      return { code: 400, success: false, message: `This refund offer has already been ${offer.status}`, user, refundOffer: null };
    }

    const order = await walletsDB.collection<Order>("Orders").findOne({ orderId: offer.orderId });
    if (!order) {
      return { code: 404, success: false, message: "Associated order not found", user, refundOffer: null };
    }

    // Process the partial refund
    // Refund buyer
    await walletsDB.collection<Balance>("Balances").updateOne(
      { userId: offer.buyerId },
      { $inc: { availableBalance: offer.refundAmount } }
    );

    // Deduct seller and release remaining funds immediately
    const remainingAmount = parseFloat((order.amount - offer.sellerDeduction).toFixed(2));

    if (order.isReleased) {
      // Funds already in availableBalance, just deduct the refund portion
      await walletsDB.collection<Balance>("Balances").updateOne(
        { userId: offer.sellerId },
        { $inc: { availableBalance: -offer.sellerDeduction } }
      );
    } else {
      // Deduct full amount from suspended, release remaining to available immediately
      await walletsDB.collection<Balance>("Balances").updateOne(
        { userId: offer.sellerId },
        {
          $inc: {
            suspendedBalance: -order.amount,
            availableBalance: remainingAmount,
          },
        }
      );
    }

    // Update seller transaction: adjust amount to what they actually receive, mark completed
    await walletsDB.collection<Transaction>("Transactions").updateOne(
      { id: order.sellerTransactionId },
      { $set: { amount: remainingAmount, status: "completed" } }
    );

    // Create a refund transaction for the buyer
    const buyerRefundTxnId = randomBytes(24).toString("base64").replace(/[+/=]/g, "");
    const now = new Date().toISOString();

    await walletsDB.collection<Transaction>("Transactions").insertOne({
      userId: offer.buyerId,
      id: buyerRefundTxnId,
      type: "PartialRefund",
      status: "completed",
      method: "balance",
      amount: offer.refundAmount,
      createdAt: now,
    });

    // Decrement store totalSales by the refunded quantity
    const updatedStore = await catalogsDB.collection<Store>("Stores").findOneAndUpdate(
      { storeId: offer.storeId },
      { $inc: { totalSales: -offer.quantity } },
      { returnDocument: "after" }
    );

    if (updatedStore) {
      const newRank = getRankFromSales(updatedStore.totalSales);
      await db.collection<User>("users").updateOne(
        { id: offer.sellerId },
        { $set: { rank: newRank } }
      );
    }

    // Mark refund offer as accepted
    await walletsDB.collection<RefundOffer>("RefundOffers").updateOne(
      { refundId },
      { $set: { status: "accepted" } }
    );

    // Update order to reflect partial refund and mark as released
    await walletsDB.collection<Order>("Orders").updateOne(
      { orderId: offer.orderId },
      { $set: { status: "partially_refunded", isReleased: true } }
    );

    // If order was disputed, close the dispute
    if (order.status === "disputed") {
      await walletsDB.collection<Dispute>("Disputes").updateOne(
        { orderId: offer.orderId },
        { $set: { status: "closed" } }
      );
    }

    const store = updatedStore || await catalogsDB.collection<Store>("Stores").findOne({ storeId: offer.storeId });
    const buyer = await db.collection<User>("users").findOne({ id: offer.buyerId });
    const seller = await db.collection<User>("users").findOne({ id: offer.sellerId });

    return {
      code: 200,
      success: true,
      message: "Refund offer accepted and processed successfully",
      user,
      refundOffer: {
        refundId: offer.refundId,
        orderId: offer.orderId,
        buyerId: offer.buyerId,
        sellerId: offer.sellerId,
        storeId: offer.storeId,
        quantity: offer.quantity,
        refundAmount: offer.refundAmount,
        sellerDeduction: offer.sellerDeduction,
        status: "accepted",
        createdAt: offer.createdAt,
        order: {
          orderId: order.orderId,
          buyerId: order.buyerId,
          buyerName: order.buyerName || buyer?.username || "",
          sellerId: order.sellerId,
          sellerName: seller?.username || "",
          storeId: order.storeId,
          product: null,
          codes: [],
          amount: order.amount,
          fee: order.fee,
          totalAmount: order.totalAmount,
          status: "partially_refunded",
          type: order.type,
          action: "buy",
          isReviewed: order.isReviewed,
          isReleased: true,
          reviewType: order.reviewType ?? null,
          disputeReason: order.disputeReason ?? null,
          createdAt: order.createdAt,
          releasedAt: order.releasedAt,
          store: store ? {
            storeId: store.storeId,
            storeName: store.storeName,
            isActive: store.isActive,
            isApproved: store.isApproved,
            approveStatus: store.approveStatus,
            isPromoted: store.isPromoted,
            type: store.type,
            totalSales: store.totalSales,
            positiveReviews: store.positiveReviews,
            negativeReviews: store.negativeReviews,
            registered: store.createdAt,
            requestCount: store.requestCount,
          } : null,
          transaction: null,
          refundOffer: null,
        },
      },
    };
  },

  declineRefund: async (_: unknown, { refundId }: { refundId: string }, context: Context) => {
    if (!context.user) {
      throw new GraphQLError(context.authError || "Not authenticated");
    }

    const userId = context.user.userId;
    const db = getDB();
    const walletsDB = getWalletsDB();
    const catalogsDB = getCatalogsDB();

    const user = await db.collection<User>("users").findOne({ id: userId });
    if (!user) {
      return { code: 404, success: false, message: "User not found", user: null, refundOffer: null };
    }

    const offer = await walletsDB.collection<RefundOffer>("RefundOffers").findOne({ refundId });
    if (!offer) {
      return { code: 404, success: false, message: "Refund offer not found", user, refundOffer: null };
    }

    // Only the buyer can decline
    if (offer.buyerId !== userId) {
      return { code: 403, success: false, message: "Only the buyer can decline a refund offer", user, refundOffer: null };
    }

    if (offer.status !== "pending") {
      return { code: 400, success: false, message: `This refund offer has already been ${offer.status}`, user, refundOffer: null };
    }

    // Mark refund offer as declined
    await walletsDB.collection<RefundOffer>("RefundOffers").updateOne(
      { refundId },
      { $set: { status: "declined" } }
    );

    const order = await walletsDB.collection<Order>("Orders").findOne({ orderId: offer.orderId });
    const store = await catalogsDB.collection<Store>("Stores").findOne({ storeId: offer.storeId });
    const buyer = await db.collection<User>("users").findOne({ id: offer.buyerId });
    const seller = await db.collection<User>("users").findOne({ id: offer.sellerId });

    return {
      code: 200,
      success: true,
      message: "Refund offer declined",
      user,
      refundOffer: {
        refundId: offer.refundId,
        orderId: offer.orderId,
        buyerId: offer.buyerId,
        sellerId: offer.sellerId,
        storeId: offer.storeId,
        quantity: offer.quantity,
        refundAmount: offer.refundAmount,
        sellerDeduction: offer.sellerDeduction,
        status: "declined",
        createdAt: offer.createdAt,
        order: order ? {
          orderId: order.orderId,
          buyerId: order.buyerId,
          buyerName: order.buyerName || buyer?.username || "",
          sellerId: order.sellerId,
          sellerName: seller?.username || "",
          storeId: order.storeId,
          product: null,
          codes: [],
          amount: order.amount,
          fee: order.fee,
          totalAmount: order.totalAmount,
          status: order.status,
          type: order.type,
          action: "buy",
          isReviewed: order.isReviewed,
          isReleased: order.isReleased,
          reviewType: order.reviewType ?? null,
          disputeReason: order.disputeReason ?? null,
          createdAt: order.createdAt,
          releasedAt: order.releasedAt,
          store: store ? {
            storeId: store.storeId,
            storeName: store.storeName,
            isActive: store.isActive,
            isApproved: store.isApproved,
            approveStatus: store.approveStatus,
            isPromoted: store.isPromoted,
            type: store.type,
            totalSales: store.totalSales,
            positiveReviews: store.positiveReviews,
            negativeReviews: store.negativeReviews,
            registered: store.createdAt,
            requestCount: store.requestCount,
          } : null,
          transaction: null,
        } : null,
      },
    };
  },
};
