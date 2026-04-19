import crypto, { randomBytes } from "crypto";
import { GraphQLError } from "graphql";
import { getDB, getWalletsDB, getCatalogsDB } from "../../db.js";
import type { User, Balance, Deposit, Transaction, Order, Product, Store, Review } from "../../types.js";
import type { Context } from "../../index.js";

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
      return { code: 404, success: false, message: "Order not found", order: null };
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
        buyerName: "gameketstore",
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
        codes: order.status === "completed" ? order.codes.map(decrypt) : [],
        amount: order.amount,
        fee: order.fee,
        totalAmount: order.totalAmount,
        status: order.status,
        type: order.type,
        action: "buy",
        isReviewed: order.isReviewed,
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

      return {
        code: 200,
        success: true,
        message: "Order retrieved successfully",
        user,
        order: {
          orderId: order.orderId,
          buyerId: order.buyerId,
          buyerName: buyer?.username || "",
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
          codes: action === "buy" ? order.codes.map(decrypt) : order.codes,
          amount: order.amount,
          fee: order.fee,
          totalAmount: order.totalAmount,
          status: order.status,
          type: order.type,
          action,
          isReviewed: order.isReviewed,
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
          transaction: txn ? {
            id: txn.id,
            type: txn.type,
            status: txn.status,
            method: txn.method,
            amount: txn.amount,
            createdAt: txn.createdAt,
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

    const edges = sliced.map((order, i) => {
      const product = productMap.get(order.productId);
      const store = storeMap.get(order.storeId);
      const action = order.buyerId === userId ? "buy" : "sell";
      const txn = txnMap.get(action === "buy" ? order.buyerTransactionId : order.sellerTransactionId);
      const buyerUser = userMap.get(order.buyerId);
      const sellerUser = userMap.get(order.sellerId);

      return {
        cursor: encodeCursor(start + i),
        node: {
          orderId: order.orderId,
          buyerId: order.buyerId,
          buyerName: buyerUser?.username || "",
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
          codes: action === "buy" ? order.codes.map(decrypt) : order.codes,
          amount: order.amount,
          fee: order.fee,
          totalAmount: order.totalAmount,
          status: order.status,
          type: order.type,
          action,
          isReviewed: order.isReviewed,
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
          transaction: txn ? {
            id: txn.id,
            type: txn.type,
            status: txn.status,
            method: txn.method,
            amount: txn.amount,
            createdAt: txn.createdAt,
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

    // Check enough codes available
    if (product.availableCodes.length < quantity) {
      return { code: 400, success: false, message: `Only ${product.availableCodes.length} code(s) available`, order: null, transaction: null };
    }

    const amount = parseFloat((product.price * quantity).toFixed(2));
    const fee = parseFloat((amount * 0.005).toFixed(2));
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
        sellerId: order.sellerId,
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
        reviewType: order.reviewType ?? null,
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

    // Create order
    const orderId = randomBytes(36).toString("base64").replace(/[+/=]/g, "");

    const order: Order = {
      orderId,
      buyerId: "anon-gameket-id",
      sellerId: product.userId,
      storeId: product.storeId,
      productId,
      buyerTransactionId: "",
      sellerTransactionId: "",
      codes: [],
      quantity,
      amount,
      fee,
      totalAmount,
      status: "pending",
      type: "anonpurchase",
      isReviewed: false,
      reviewType: null,
      isReleased: false,
      createdAt: now,
      releasedAt,
    };

    await walletsDB.collection<Order>("Orders").insertOne(order);

    // Create deposit record
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
    };

    await walletsDB.collection<Deposit>("Deposits").insertOne(depositRecord);

    return {
      code: 200,
      success: true,
      message: "Payment initiated",
      order: {
        orderId: order.orderId,
        buyerId: order.buyerId,
        buyerName: "gameketstore",
        sellerId: order.sellerId,
        sellerName: store.storeName,
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
        amount: order.amount,
        fee: order.fee,
        totalAmount: order.totalAmount,
        status: order.status,
        type: order.type,
        action: "buy",
        isReviewed: order.isReviewed,
        reviewType: order.reviewType ?? null,
        createdAt: order.createdAt,
        releasedAt: order.releasedAt,
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
      review,
    };
  },
};
