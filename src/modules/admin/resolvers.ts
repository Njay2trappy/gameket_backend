import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { GraphQLError } from "graphql";
import { v4 as uuidv4 } from "uuid";
import { getDB, getWalletsDB, getCatalogsDB } from "../../db.js";
import type { User, Store, Premium, Transaction, Product, Order, Account, VerificationRequest, Support, Balance, Dispute, DisputeMessage } from "../../types.js";
import type { Context } from "../../index.js";
import { catalogsMutations } from "../catalogs/resolvers.js";

const MAX_ADMIN_ATTEMPTS = 5;
const ADMIN_LOCKOUT_DURATION = 15 * 60 * 1000; // 15 minutes
const adminLoginAttempts = new Map<string, { count: number; lockedUntil: number }>();

function encodeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`).toString("base64");
}

function decodeCursor(cursor: string): number {
  const decoded = Buffer.from(cursor, "base64").toString("utf-8");
  return parseInt(decoded.replace("cursor:", ""), 10);
}

function toSupportNode(support: Support) {
  return {
    supportId: support.supportId,
    email: support.email,
    username: support.username,
    isActive: support.isActive,
    isSuspended: support.isSuspended,
    hasSupportPrivileges: support.hasSupportPrivileges,
    createdAt: support.createdAt,
    lastLogin: support.lastLogin,
  };
}

function buildDisputeMessagesConnection(messages: DisputeMessage[]) {
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

async function buildAdminUsersConnection(
  filter: Partial<Pick<User, "isStore" | "isSuspended">>,
  first?: number,
  after?: string,
  last?: number,
  before?: string
) {
  const db = getDB();
  const allUsers = await db
    .collection<User>("users")
    .find(filter)
    .sort({ registered: -1 })
    .toArray();

  const total = allUsers.length;
  const defaultPageSize = 50;
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

  const sliced = allUsers.slice(start, end);

  const edges = sliced.map((u, i) => ({
    cursor: encodeCursor(start + i),
    node: u,
  }));

  return {
    total,
    connection: {
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
}

export const adminQueries = {
  adminGetDetails: async (
    _: unknown,
    { filter }: { filter?: "DAY" | "WEEK" | "MONTH" | "ALL" },
    context: Context
  ) => {
    if (!context.user || context.user.role !== "admin") {
      throw new GraphQLError("Admin access required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const db = getDB();
    const walletsDB = getWalletsDB();
    const catalogsDB = getCatalogsDB();

    // Build date filter
    let dateFilter: string | null = null;
    if (filter && filter !== "ALL") {
      const now = new Date();
      if (filter === "DAY") now.setHours(now.getHours() - 24);
      else if (filter === "WEEK") now.setDate(now.getDate() - 7);
      else if (filter === "MONTH") now.setDate(now.getDate() - 30);
      dateFilter = now.toISOString();
    }

    const dateQuery = dateFilter ? { $gte: dateFilter } : undefined;

    const [totalRevenue, totalOrders, totalRegisteredUsers, totalProducts, totalSellers, premiumUsers, totalProductsSold, totalTransactions] = await Promise.all([
      // Total revenue (sum of order fees)
      Promise.all([
        // Order fees (platform cut on purchases)
        walletsDB
          .collection<Order>("Orders")
          .aggregate<{ total: number }>([
            ...(dateQuery ? [{ $match: { createdAt: dateQuery } }] : []),
            { $match: { status: { $in: ["completed", "partially_refunded"] } } },
            { $group: { _id: null, total: { $sum: "$fee" } } },
          ])
          .toArray()
          .then((r) => r[0]?.total ?? 0),

        // Premium subscriptions + ads revenue (full amount, non-refunded)
        walletsDB
          .collection<Transaction>("Transactions")
          .aggregate<{ total: number }>([
            ...(dateQuery ? [{ $match: { createdAt: dateQuery } }] : []),
            {
              $match: {
                type: { $in: ["PremiumSubscription", "ProductPromotion", "StorePromotion"] },
                status: "completed",
              },
            },
            { $group: { _id: null, total: { $sum: "$amount" } } },
          ])
          .toArray()
          .then((r) => r[0]?.total ?? 0),
      ]).then(([orderFees, otherRevenue]) => orderFees + otherRevenue),

      // Total orders
      dateQuery
        ? walletsDB.collection<Order>("Orders").countDocuments({ createdAt: dateQuery })
        : walletsDB.collection<Order>("Orders").countDocuments(),

      // Total registered users
      dateQuery
        ? db.collection<User>("users").countDocuments({ registered: dateQuery })
        : db.collection<User>("users").countDocuments(),

      // Total products
      dateQuery
        ? catalogsDB.collection<Product>("Products").countDocuments({ createdAt: dateQuery })
        : catalogsDB.collection<Product>("Products").countDocuments(),

      // Total sellers (stores)
      dateQuery
        ? catalogsDB.collection<Store>("Stores").countDocuments({ isApproved: true, createdAt: dateQuery })
        : catalogsDB.collection<Store>("Stores").countDocuments({ isApproved: true }),

      // Premium users
      dateQuery
        ? walletsDB.collection<Premium>("Premium").countDocuments({ isActive: true, subscribedAt: dateQuery })
        : walletsDB.collection<Premium>("Premium").countDocuments({ isActive: true }),

      // Total products sold (sum of quantity from completed orders)
      walletsDB
        .collection<Order>("Orders")
        .aggregate<{ total: number }>([
          ...(dateQuery ? [{ $match: { createdAt: dateQuery } }] : []),
          { $match: { status: { $in: ["completed", "partially_refunded"] } } },
          { $group: { _id: null, total: { $sum: "$quantity" } } },
        ])
        .toArray()
        .then((r) => r[0]?.total ?? 0),

      // Total transactions
      dateQuery
        ? walletsDB.collection<Transaction>("Transactions").countDocuments({ createdAt: dateQuery })
        : walletsDB.collection<Transaction>("Transactions").countDocuments(),
    ]);

    return {
      code: 200,
      success: true,
      message: "Admin details retrieved successfully",
      stats: {
        totalRevenue: parseFloat(totalRevenue.toFixed(2)),
        totalOrders,
        totalRegisteredUsers,
        totalProducts,
        totalSellers,
        premiumUsers,
        totalProductsSold,
        totalTransactions,
      },
    };
  },

  AdmingetTransactions: async (
    _: unknown,
    { type, first, after, last, before }: { type?: string; first?: number; after?: string; last?: number; before?: string },
    context: Context
  ) => {
    if (!context.user || context.user.role !== "admin") {
      throw new GraphQLError("Admin access required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const walletsDB = getWalletsDB();
    const query = type ? { type } : {};

    const allTransactions = await walletsDB
      .collection<Transaction>("Transactions")
      .find(query)
      .sort({ createdAt: -1 })
      .toArray();

    const total = allTransactions.length;
    const defaultPageSize = 50;
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

    const sliced = allTransactions.slice(start, end);

    const edges = sliced.map((t, i) => ({
      cursor: encodeCursor(start + i),
      node: {
        userId: t.userId,
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
      message: type ? `${total} transaction(s) found for type ${type}` : `${total} transaction(s) found`,
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

  AdmingetUsers: async (
    _: unknown,
    { first, after, last, before }: { first?: number; after?: string; last?: number; before?: string },
    context: Context
  ) => {
    if (!context.user || context.user.role !== "admin") {
      throw new GraphQLError("Admin access required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const { total, connection } = await buildAdminUsersConnection({}, first, after, last, before);

    return {
      code: 200,
      success: true,
      message: `${total} user(s) found`,
      users: connection,
    };
  },

  AdmingetBuyers: async (
    _: unknown,
    { first, after, last, before }: { first?: number; after?: string; last?: number; before?: string },
    context: Context
  ) => {
    if (!context.user || context.user.role !== "admin") {
      throw new GraphQLError("Admin access required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const { total, connection } = await buildAdminUsersConnection({ isStore: false }, first, after, last, before);

    return {
      code: 200,
      success: true,
      message: `${total} buyer(s) found`,
      buyers: connection,
    };
  },

  AdmingetStores: async (
    _: unknown,
    { first, after, last, before }: { first?: number; after?: string; last?: number; before?: string },
    context: Context
  ) => {
    if (!context.user || context.user.role !== "admin") {
      throw new GraphQLError("Admin access required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const { total, connection } = await buildAdminUsersConnection({ isStore: true }, first, after, last, before);

    return {
      code: 200,
      success: true,
      message: `${total} store user(s) found`,
      stores: connection,
    };
  },

  AdmingetVerifications: async (
    _: unknown,
    { first, after, last, before }: { first?: number; after?: string; last?: number; before?: string },
    context: Context
  ) => {
    if (!context.user || context.user.role !== "admin") {
      throw new GraphQLError("Admin access required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const db = getDB();
    const allVerifications = await db
      .collection<VerificationRequest>("Verification")
      .find({})
      .sort({ submittedAt: -1 })
      .toArray();

    const total = allVerifications.length;
    const defaultPageSize = 50;
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

    const sliced = allVerifications.slice(start, end);
    const userIds = [...new Set(sliced.map((v) => v.userId))];
    const users = await db.collection<User>("users").find({ id: { $in: userIds } }).toArray();
    const userMap = new Map(users.map((u) => [u.id, u]));

    const edges = sliced.map((v, i) => ({
      cursor: encodeCursor(start + i),
      node: {
        user: userMap.get(v.userId) || null,
        verification: v,
      },
    }));

    return {
      code: 200,
      success: true,
      message: `${total} verification request(s) found`,
      verifications: {
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

  AdmingetSuspendedUSers: async (
    _: unknown,
    { first, after, last, before }: { first?: number; after?: string; last?: number; before?: string },
    context: Context
  ) => {
    if (!context.user || context.user.role !== "admin") {
      throw new GraphQLError("Admin access required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const { total, connection } = await buildAdminUsersConnection({ isSuspended: true }, first, after, last, before);

    return {
      code: 200,
      success: true,
      message: `${total} suspended user(s) found`,
      suspendedUsers: connection,
    };
  },

  AdmingetSupports: async (
    _: unknown,
    { first, after, last, before }: { first?: number; after?: string; last?: number; before?: string },
    context: Context
  ) => {
    if (!context.user || context.user.role !== "admin") {
      throw new GraphQLError("Admin access required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const db = getDB();
    const allSupports = await db
      .collection<Support>("Support")
      .find({})
      .sort({ createdAt: -1 })
      .toArray();

    const total = allSupports.length;
    const defaultPageSize = 50;
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

    const sliced = allSupports.slice(start, end);

    const edges = sliced.map((support, i) => ({
      cursor: encodeCursor(start + i),
      node: toSupportNode(support),
    }));

    return {
      code: 200,
      success: true,
      message: `${total} support account(s) found`,
      supports: {
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

  AdmingetOrders: async (
    _: unknown,
    { status, first, after, last, before }: { status?: string; first?: number; after?: string; last?: number; before?: string },
    context: Context
  ) => {
    if (!context.user || context.user.role !== "admin") {
      throw new GraphQLError("Admin access required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const db = getDB();
    const walletsDB = getWalletsDB();
    const catalogsDB = getCatalogsDB();

    const query = status ? { status } : {};

    const allOrders = await walletsDB
      .collection<Order>("Orders")
      .find(query)
      .sort({ createdAt: -1 })
      .toArray();

    const total = allOrders.length;
    const defaultPageSize = 50;
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

    const sliced = allOrders.slice(start, end);

    const productIds = [...new Set(sliced.map((o) => o.productId))];
    const storeIds = [...new Set(sliced.map((o) => o.storeId))];
    const userIds = [...new Set(sliced.flatMap((o) => [o.buyerId, o.sellerId]))];

    const [products, stores, users] = await Promise.all([
      catalogsDB.collection<Product>("Products").find({ productId: { $in: productIds } }).toArray(),
      catalogsDB.collection<Store>("Stores").find({ storeId: { $in: storeIds } }).toArray(),
      db.collection<User>("users").find({ id: { $in: userIds } }).toArray(),
    ]);

    const productMap = new Map(products.map((p) => [p.productId, p]));
    const storeMap = new Map(stores.map((s) => [s.storeId, s]));
    const userMap = new Map(users.map((u) => [u.id, u]));

    const edges = sliced.map((order, i) => {
      const product = productMap.get(order.productId);
      const store = storeMap.get(order.storeId);
      const buyer = userMap.get(order.buyerId);
      const seller = userMap.get(order.sellerId);

      return {
        cursor: encodeCursor(start + i),
        node: {
          orderId: order.orderId,
          buyerId: order.buyerId,
          buyerName: order.buyerName || buyer?.username || "",
          sellerId: order.sellerId,
          sellerName: seller?.username || "",
          storeId: order.storeId,
          product: product
            ? {
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
                store: store
                  ? {
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
                      requestCount: store.requestCount ?? 0,
                    }
                  : null,
              }
            : null,
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
          store: store
            ? {
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
                requestCount: store.requestCount ?? 0,
              }
            : null,
          transaction: null,
          refundOffer: null,
        },
      };
    });

    return {
      code: 200,
      success: true,
      message: status ? `${total} order(s) found with status "${status}"` : `${total} order(s) found`,
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

  AdmingetDisputes: async (
    _: unknown,
    { first, after, last, before }: { first?: number; after?: string; last?: number; before?: string },
    context: Context
  ) => {
    if (!context.user || context.user.role !== "admin") {
      throw new GraphQLError("Admin access required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const db = getDB();
    const walletsDB = getWalletsDB();
    const catalogsDB = getCatalogsDB();

    const allDisputes = await walletsDB
      .collection<Dispute>("Disputes")
      .find({})
      .sort({ createdAt: -1 })
      .toArray();

    const total = allDisputes.length;
    if (total === 0) {
      return {
        code: 200,
        success: true,
        message: "0 dispute(s) found",
        disputes: {
          edges: [],
          pageInfo: {
            hasNextPage: false,
            hasPreviousPage: false,
            startCursor: null,
            endCursor: null,
            fetchedCount: 0,
            remainingCount: 0,
          },
        },
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

    const orderIds = [...new Set(sliced.map((d) => d.orderId))];
    const orders = await walletsDB.collection<Order>("Orders").find({ orderId: { $in: orderIds } }).toArray();
    const orderMap = new Map(orders.map((o) => [o.orderId, o]));

    const storeIds = [...new Set(sliced.map((d) => d.storeId))];
    const stores = await catalogsDB.collection<Store>("Stores").find({ storeId: { $in: storeIds } }).toArray();
    const storeMap = new Map(stores.map((s) => [s.storeId, s]));

    const productIds = [...new Set(orders.map((o) => o.productId))];
    const products = await catalogsDB.collection<Product>("Products").find({ productId: { $in: productIds } }).toArray();
    const productMap = new Map(products.map((p) => [p.productId, p]));

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
          messages: buildDisputeMessagesConnection(d.messages || []),
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
            refundOffer: null,
          } : null,
        },
      };
    });

    return {
      code: 200,
      success: true,
      message: `${total} dispute(s) found`,
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
};

export const adminMutations = {
  adminLogin: async (
    _: unknown,
    { input }: { input: { email: string; password: string } }
  ) => {
    const ip = input.email.trim().toLowerCase();

    // Rate limiting
    const now = Date.now();
    const attempt = adminLoginAttempts.get(ip);
    if (attempt) {
      if (attempt.lockedUntil > now) {
        const minutesLeft = Math.ceil((attempt.lockedUntil - now) / 60000);
        return { code: 429, success: false, message: `Too many attempts. Try again in ${minutesLeft} minute(s)`, token: null };
      }
      if (attempt.lockedUntil <= now && attempt.count >= MAX_ADMIN_ATTEMPTS) {
        adminLoginAttempts.delete(ip);
      }
    }

    const db = getDB();

    const adminDoc = await db.collection("Admin").findOne({ key: "admin" });
    if (!adminDoc) {
      return { code: 500, success: false, message: "Admin configuration missing", token: null };
    }

    const emailValid = await bcrypt.compare(ip, adminDoc.email);
    if (!emailValid) {
      const current = adminLoginAttempts.get(ip) || { count: 0, lockedUntil: 0 };
      current.count += 1;
      if (current.count >= MAX_ADMIN_ATTEMPTS) {
        current.lockedUntil = now + ADMIN_LOCKOUT_DURATION;
      }
      adminLoginAttempts.set(ip, current);
      return { code: 401, success: false, message: "Invalid credentials", token: null };
    }

    const passwordValid = await bcrypt.compare(input.password, adminDoc.password);
    if (!passwordValid) {
      const current = adminLoginAttempts.get(ip) || { count: 0, lockedUntil: 0 };
      current.count += 1;
      if (current.count >= MAX_ADMIN_ATTEMPTS) {
        current.lockedUntil = now + ADMIN_LOCKOUT_DURATION;
      }
      adminLoginAttempts.set(ip, current);
      return { code: 401, success: false, message: "Invalid credentials", token: null };
    }

    // Clear attempts on success
    adminLoginAttempts.delete(ip);

    const adminSecret = process.env.ADMIN_JWT_SECRET;
    if (!adminSecret) {
      throw new Error("Server configuration error");
    }

    const newTokenVersion = (adminDoc.tokenVersion ?? 0) + 1;

    await db.collection("Admin").updateOne(
      { key: "admin" },
      { $set: { tokenVersion: newTokenVersion, lastLogin: new Date().toISOString() } }
    );

    const token = jwt.sign(
      { adminId: "admin", email: input.email.trim().toLowerCase(), role: "admin", tokenVersion: newTokenVersion },
      adminSecret,
      { expiresIn: "15m" }
    );

    return { code: 200, success: true, message: "Admin login successful", token };
  },

  supportLogin: async (
    _: unknown,
    { input }: { input: { email: string; password: string } }
  ) => {
    const db = getDB();
    const supports = db.collection<Support>("Support");

    const email = input.email.trim().toLowerCase();
    const password = input.password;

    if (!email || !password) {
      return { code: 400, success: false, message: "Email and password are required", token: null, support: null };
    }

    const support = await supports.findOne({ email });
    if (!support) {
      return { code: 401, success: false, message: "Invalid email or password", token: null, support: null };
    }

    const valid = await bcrypt.compare(password, support.password || "");
    if (!valid) {
      return { code: 401, success: false, message: "Invalid email or password", token: null, support: null };
    }

    if (support.isSuspended || !support.isActive || !support.hasSupportPrivileges) {
      return { code: 403, success: false, message: "Support account is suspended or inactive", token: null, support: null };
    }

    const secret = process.env.SUPPORT_JWT_SECRET;
    if (!secret) {
      throw new Error("Server configuration error");
    }

    const newTokenVersion = (support.tokenVersion ?? 0) + 1;
    const loginAt = new Date().toISOString();

    await supports.updateOne(
      { supportId: support.supportId },
      { $set: { tokenVersion: newTokenVersion, lastLogin: loginAt } }
    );

    const token = jwt.sign(
      { supportId: support.supportId, email: support.email, role: "support", tokenVersion: newTokenVersion },
      secret,
      { expiresIn: "8h" }
    );

    return {
      code: 200,
      success: true,
      message: "Support login successful",
      token,
      support: toSupportNode({ ...support, tokenVersion: newTokenVersion, lastLogin: loginAt }),
    };
  },

  AdminSuspendUser: async (
    _: unknown,
    { userId }: { userId: string },
    context: Context
  ) => {
    if (!context.user || context.user.role !== "admin") {
      throw new GraphQLError("Admin access required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const db = getDB();
    const users = db.collection<User>("users");
    const accounts = db.collection<Account>("accounts");

    const existingUser = await users.findOne({ id: userId });
    if (!existingUser) {
      return { code: 404, success: false, message: "User not found", user: null };
    }

    if (existingUser.isSuspended && !existingUser.isActive) {
      return { code: 200, success: true, message: "User is already suspended", user: existingUser };
    }

    await users.updateOne(
      { id: userId },
      { $set: { isSuspended: true, isActive: false } }
    );

    const account = await accounts.findOne({ userId });
    if (account) {
      const newTokenVersion = (account.tokenVersion ?? 0) + 1;
      await accounts.updateOne(
        { userId },
        { $set: { tokenVersion: newTokenVersion } }
      );
    }

    // Deactivate the user's store and all their products
    if (existingUser.isStore) {
      const catalogsDB = getCatalogsDB();
      await catalogsDB.collection<Store>("Stores").updateOne(
        { userId },
        { $set: { isActive: false } }
      );
      await catalogsDB.collection<Product>("Products").updateMany(
        { userId },
        { $set: { isActive: false } }
      );
    }

    const updatedUser = await users.findOne({ id: userId });

    return {
      code: 200,
      success: true,
      message: "User suspended successfully",
      user: updatedUser,
    };
  },

  AdminActivativeUser: async (
    _: unknown,
    { userId }: { userId: string },
    context: Context
  ) => {
    if (!context.user || context.user.role !== "admin") {
      throw new GraphQLError("Admin access required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const db = getDB();
    const users = db.collection<User>("users");

    const existingUser = await users.findOne({ id: userId });
    if (!existingUser) {
      return { code: 404, success: false, message: "User not found", user: null };
    }

    if (!existingUser.isSuspended && existingUser.isActive) {
      return { code: 200, success: true, message: "User is already active", user: existingUser };
    }

    await users.updateOne(
      { id: userId },
      { $set: { isSuspended: false, isActive: true } }
    );

    // Re-activate the user's store and all their products
    if (existingUser.isStore) {
      const catalogsDB = getCatalogsDB();
      await catalogsDB.collection<Store>("Stores").updateOne(
        { userId },
        { $set: { isActive: true } }
      );
      await catalogsDB.collection<Product>("Products").updateMany(
        { userId },
        { $set: { isActive: true } }
      );
    }

    const updatedUser = await users.findOne({ id: userId });

    return {
      code: 200,
      success: true,
      message: "User activated successfully",
      user: updatedUser,
    };
  },

  AdminaddSupport: async (
    _: unknown,
    { email, password, username }: { email: string; password: string; username: string },
    context: Context
  ) => {
    if (!context.user || context.user.role !== "admin") {
      throw new GraphQLError("Admin access required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const db = getDB();
    const supports = db.collection<Support>("Support");

    const normalizedEmail = email.trim().toLowerCase();
    const cleanUsername = username.trim();

    if (!normalizedEmail || !password || !cleanUsername) {
      return { code: 400, success: false, message: "Email, username and password are required", support: null };
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      return { code: 400, success: false, message: "Invalid email format", support: null };
    }

    if (password.length < 8) {
      return { code: 400, success: false, message: "Password must be at least 8 characters", support: null };
    }

    if (cleanUsername.length > 30) {
      return { code: 400, success: false, message: "Username must be at most 30 characters", support: null };
    }

    if (/\s/.test(cleanUsername)) {
      return { code: 400, success: false, message: "Username must not contain spaces", support: null };
    }

    const existingByEmail = await supports.findOne({ email: normalizedEmail });
    if (existingByEmail) {
      return { code: 409, success: false, message: "Support email already exists", support: null };
    }

    const existingByUsername = await supports.findOne({ username: cleanUsername });
    if (existingByUsername) {
      return { code: 409, success: false, message: "Support username already exists", support: null };
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    const support: Support = {
      supportId: uuidv4(),
      email: normalizedEmail,
      username: cleanUsername,
      password: hashedPassword,
      isActive: true,
      isSuspended: false,
      hasSupportPrivileges: true,
      tokenVersion: 0,
      createdAt: new Date().toISOString(),
      lastLogin: null,
    };

    await supports.insertOne(support);

    return {
      code: 201,
      success: true,
      message: "Support account created successfully",
      support: toSupportNode(support),
    };
  },

  AdminSuspendSupport: async (
    _: unknown,
    { supportId }: { supportId: string },
    context: Context
  ) => {
    if (!context.user || context.user.role !== "admin") {
      throw new GraphQLError("Admin access required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const db = getDB();
    const supports = db.collection<Support>("Support");

    const existingSupport = await supports.findOne({ supportId });
    if (!existingSupport) {
      return { code: 404, success: false, message: "Support account not found", support: null };
    }

    if (existingSupport.isSuspended && !existingSupport.isActive && !existingSupport.hasSupportPrivileges) {
      return { code: 200, success: true, message: "Support account is already suspended", support: toSupportNode(existingSupport) };
    }

    const newTokenVersion = (existingSupport.tokenVersion ?? 0) + 1;

    await supports.updateOne(
      { supportId },
      {
        $set: {
          isSuspended: true,
          isActive: false,
          hasSupportPrivileges: false,
          tokenVersion: newTokenVersion,
        },
      }
    );

    const updatedSupport = await supports.findOne({ supportId });

    return {
      code: 200,
      success: true,
      message: "Support account suspended successfully",
      support: updatedSupport ? toSupportNode(updatedSupport) : null,
    };
  },

  AdminCreateOfficialStore: async (
    _: unknown,
    __: unknown,
    context: Context
  ) => {
    if (!context.user || context.user.role !== "admin") {
      throw new GraphQLError("Admin access required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const db = getDB();
    const catalogsDB = getCatalogsDB();
    const walletsDB = getWalletsDB();

    const users = db.collection<User>("users");
    const stores = catalogsDB.collection<Store>("Stores");
    const balances = walletsDB.collection<Balance>("Balances");

    const adminEmail = context.user.email.trim().toLowerCase();
    const now = new Date().toISOString();
    const registered = now.split("T")[0];

    const existingOwnerUser = await users.findOne({ email: adminEmail });
    let ownerUser: User;

    if (!existingOwnerUser) {
      let username = "GAMEKET";
      let suffix = 1;

      while (await users.findOne({ username: { $regex: `^${username}$`, $options: "i" } })) {
        username = `GAMEKET_${suffix}`;
        suffix += 1;
      }

      const newOwnerUser: User = {
        id: uuidv4(),
        username,
        email: adminEmail,
        country: "Unknown",
        isActive: true,
        isSuspended: false,
        isVerified: true,
        isPremium: false,
        rank: 1,
        registered,
        isStore: true,
        avatar: null,
      };

      await users.insertOne(newOwnerUser);
      ownerUser = newOwnerUser;
    } else {
      ownerUser = existingOwnerUser;
      if (!ownerUser.isStore) {
        await users.updateOne({ id: ownerUser.id }, { $set: { isStore: true } });
        ownerUser = { ...ownerUser, isStore: true };
      }
    }

    const existingBalance = await balances.findOne({ userId: ownerUser.id });
    if (!existingBalance) {
      await balances.insertOne({
        userId: ownerUser.id,
        availableBalance: 0,
        suspendedBalance: 0,
        methods: [],
      });
    }

    const existingStore = await stores.findOne({ storeName: { $regex: "^GAMEKET$", $options: "i" } });
    if (existingStore && existingStore.userId !== ownerUser.id) {
      return {
        code: 409,
        success: false,
        message: "A GAMEKET store already exists under another owner",
        user: ownerUser,
        store: null,
      };
    }

    let finalStore: Store;

    if (existingStore) {
      await stores.updateOne(
        { storeId: existingStore.storeId },
        {
          $set: {
            isActive: true,
            isApproved: true,
            approveStatus: "success",
            type: "official",
            storeName: "GAMEKET",
          },
        }
      );

      const refreshed = await stores.findOne({ storeId: existingStore.storeId });
      finalStore = refreshed || existingStore;

      return {
        code: 200,
        success: true,
        message: "Official GAMEKET store already existed and has been updated",
        user: ownerUser,
        store: {
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
          reviews: finalStore.reviews,
          registered: finalStore.createdAt?.split("T")[0] || finalStore.createdAt,
          requestCount: finalStore.requestCount ?? 0,
        },
      };
    }

    finalStore = {
      userId: ownerUser.id,
      storeId: uuidv4(),
      storeName: "GAMEKET",
      isActive: true,
      isApproved: true,
      approveStatus: "success",
      isPromoted: false,
      type: "official",
      totalSales: 0,
      positiveReviews: 0,
      negativeReviews: 0,
      reviews: [],
      createdAt: now,
      requestCount: 0,
    };

    await stores.insertOne(finalStore);

    return {
      code: 201,
      success: true,
      message: "Official GAMEKET store created successfully",
      user: ownerUser,
      store: {
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
        reviews: finalStore.reviews,
        registered: finalStore.createdAt?.split("T")[0] || finalStore.createdAt,
        requestCount: finalStore.requestCount ?? 0,
      },
    };
  },

  AdminAddProduct: async (_: unknown, { input }: { input: { catalog: string; category: string; region: string; name: string; description: string; marketPrice: number; price: number; discount: number; type: "Auto" | "Manual"; codes?: string[] } }, context: Context) => {
    if (!context.user || context.user.role !== "admin") {
      throw new GraphQLError("Admin access required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }
    return catalogsMutations.addProduct(_, { input }, context);
  },

  AdminUpdateProduct: async (_: unknown, { input }: { input: { productId: string; category?: string; region?: string; name?: string; description?: string; marketPrice?: number; price?: number; discount?: number; type?: "Auto" | "Manual"; isActive?: boolean } }, context: Context) => {
    if (!context.user || context.user.role !== "admin") {
      throw new GraphQLError("Admin access required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }
    return catalogsMutations.updateProduct(_, { input }, context);
  },

  AdminDeleteProduct: async (_: unknown, { productId }: { productId: string }, context: Context) => {
    if (!context.user || context.user.role !== "admin") {
      throw new GraphQLError("Admin access required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }
    return catalogsMutations.deleteProduct(_, { productId }, context);
  },

  AdminDisableProduct: async (_: unknown, { productId }: { productId: string }, context: Context) => {
    if (!context.user || context.user.role !== "admin") {
      throw new GraphQLError("Admin access required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }
    return catalogsMutations.disableProduct(_, { productId }, context);
  },

  AdminEnableProduct: async (_: unknown, { productId }: { productId: string }, context: Context) => {
    if (!context.user || context.user.role !== "admin") {
      throw new GraphQLError("Admin access required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }
    return catalogsMutations.enableProduct(_, { productId }, context);
  },

  AdminAddProductCodes: async (_: unknown, { input }: { input: { productId: string; codes: string[] } }, context: Context) => {
    if (!context.user || context.user.role !== "admin") {
      throw new GraphQLError("Admin access required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }
    return catalogsMutations.addProductCodes(_, { input }, context);
  },

  AdminDeleteProductCodes: async (_: unknown, { input }: { input: { productId: string; codes: string[] } }, context: Context) => {
    if (!context.user || context.user.role !== "admin") {
      throw new GraphQLError("Admin access required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }
    return catalogsMutations.deleteProductCodes(_, { input }, context);
  },

  AdminAdvertiseProduct: async (_: unknown, { input }: { input: { productId: string; amount: number; campaignStart: string; campaignEnd: string } }, context: Context) => {
    if (!context.user || context.user.role !== "admin") {
      throw new GraphQLError("Admin access required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }
    return catalogsMutations.advertiseProduct(_, { input }, context);
  },

  AdminAdvertiseStore: async (_: unknown, { input }: { input: { amount: number; campaignStart: string; campaignEnd: string } }, context: Context) => {
    if (!context.user || context.user.role !== "admin") {
      throw new GraphQLError("Admin access required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }
    return catalogsMutations.advertiseStore(_, { input }, context);
  },
};
