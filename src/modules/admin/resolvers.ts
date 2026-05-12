import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { randomBytes, createHash } from "crypto";
import { GraphQLError } from "graphql";
import { v4 as uuidv4 } from "uuid";
import nodemailer from "nodemailer";
import { readFileSync } from "fs";
import { join } from "path";
import { getDB, getWalletsDB, getCatalogsDB } from "../../db.js";
import { recordAuditEvent, recordAdminLog } from "../../audit.js";
import type { User, Store, Premium, Transaction, Product, Order, Account, VerificationRequest, Support, Balance, Dispute, DisputeMessage, Withdrawal } from "../../types.js";
import type { Context } from "../../index.js";
import { catalogsMutations, catalogsQueries } from "../catalogs/resolvers.js";

const MAX_ADMIN_ATTEMPTS = 5;
const ADMIN_LOCKOUT_DURATION = 15 * 60 * 1000; // 15 minutes
const adminLoginAttempts = new Map<string, { count: number; lockedUntil: number }>();

const smtpTransporter = nodemailer.createTransport({
  host: "gameket.io",
  port: 465,
  secure: true,
  auth: {
    user: process.env.SMTP_EMAIL,
    pass: process.env.SMTP_PASSWORD,
  },
});

const escapeHtml = (value: string): string => value
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/\"/g, "&quot;")
  .replace(/'/g, "&#39;");

const renderWelcomeEmail = (user: User): string => {
  const template = readFileSync(join(process.cwd(), "src", "emails", "welcome-email.html"), "utf-8");
  const firstName = user.username.trim() || "there";

  return template
    .replace(/\{\{firstName\}\}/g, escapeHtml(firstName))
    .replace(/\{\{year\}\}/g, String(new Date().getFullYear()));
};

const formatUsd = (amount: number): string => {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);
};

const formatDateTime = (iso: string): string => {
  return new Date(iso).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
};

const shouldSendEmailForUser = (user: User): boolean => {
  return (user.deliveryOption || "email") === "email";
};

const renderIfBlock = (template: string, key: string, include: boolean): string => {
  const blockRegex = new RegExp(`\\{\\{#if\\s+${key}\\}\\}([\\s\\S]*?)\\{\\{\\/if\\}\\}`, "g");
  return template.replace(blockRegex, include ? "$1" : "");
};

const renderWithdrawalStatusUpdateEmail = (
  user: User,
  withdrawal: Withdrawal,
  nextStatus: "approved" | "declined"
): string => {
  let template = readFileSync(join(process.cwd(), "src", "emails", "withdrawal-status-update-email.html"), "utf-8");
  const firstName = user.username.trim() || "there";
  const statusReason = nextStatus === "approved"
    ? "Your withdrawal has been approved and is being processed for payout."
    : "Your withdrawal could not be processed. Please review your payout details and try again.";

  template = renderIfBlock(template, "isDeclined", nextStatus === "declined");
  template = renderIfBlock(template, "isFailed", false);

  if (nextStatus === "approved") {
    const statusCellRegex = new RegExp('(<p class="meta-label">Status</p>)[\\s\\S]*?(</td>)');
    template = template.replace(
      statusCellRegex,
      `$1\n                                    <p class=\"status-pill\">Approved</p>\n                                  $2`
    );
  }

  return template
    .replace(/\{\{firstName\}\}/g, escapeHtml(firstName))
    .replace(/\{\{withdrawalAmount\}\}/g, escapeHtml(formatUsd(withdrawal.amount)))
    .replace(/\{\{requestId\}\}/g, escapeHtml(withdrawal.withdrawalId))
    .replace(/\{\{updatedOn\}\}/g, escapeHtml(formatDateTime(withdrawal.processedAt || new Date().toISOString())))
    .replace(/\{\{payoutMethod\}\}/g, escapeHtml(`${withdrawal.wallet.name} (${withdrawal.wallet.network})`))
    .replace(/\{\{destinationSummary\}\}/g, escapeHtml(withdrawal.wallet.value))
    .replace(/\{\{statusReason\}\}/g, escapeHtml(statusReason))
    .replace(/\{\{resubmitWithdrawalUrl\}\}/g, escapeHtml("https://shop.gameket.io/user/wallet"))
    .replace(/\{\{retryWithdrawalUrl\}\}/g, escapeHtml("https://shop.gameket.io/user/wallet"))
    .replace(/\{\{year\}\}/g, String(new Date().getFullYear()));
};

const renderOrderStatusUpdateEmail = (
  firstName: string,
  input: {
    status: "disputed" | "cancelled" | "refunded";
    orderId: string;
    productName: string;
    quantity: number;
    orderAmount: number;
    updatedOn: string;
    statusReason?: string | null;
    refundAmount?: number;
  }
): string => {
  let template = readFileSync(join(process.cwd(), "src", "emails", "order-status-update-email.html"), "utf-8");

  const isDisputed = input.status === "disputed";
  const isCancelled = input.status === "cancelled";
  const isRefunded = input.status === "refunded";

  template = renderIfBlock(template, "isDisputed", isDisputed);
  template = renderIfBlock(template, "isCancelled", isCancelled);
  template = renderIfBlock(template, "isRefunded", isRefunded);
  template = renderIfBlock(template, "statusReason", Boolean((input.statusReason || "").trim()));

  const statusHeadline = isDisputed
    ? "Order Disputed"
    : isCancelled
      ? "Order Cancelled"
      : "Order Refunded";

  return template
    .replace(/\{\{firstName\}\}/g, escapeHtml(firstName))
    .replace(/\{\{statusHeadline\}\}/g, escapeHtml(statusHeadline))
    .replace(/\{\{orderId\}\}/g, escapeHtml(input.orderId))
    .replace(/\{\{productName\}\}/g, escapeHtml(input.productName))
    .replace(/\{\{quantity\}\}/g, String(input.quantity))
    .replace(/\{\{orderAmount\}\}/g, escapeHtml(formatUsd(input.orderAmount)))
    .replace(/\{\{updatedOn\}\}/g, escapeHtml(formatDateTime(input.updatedOn)))
    .replace(/\{\{statusReason\}\}/g, escapeHtml((input.statusReason || "").trim()))
    .replace(/\{\{disputeUrl\}\}/g, escapeHtml(`https://shop.gameket.io/orders?id=${encodeURIComponent(input.orderId)}`))
    .replace(/\{\{browseUrl\}\}/g, escapeHtml("https://shop.gameket.io"))
    .replace(/\{\{transactionsUrl\}\}/g, escapeHtml("https://shop.gameket.io/dashboard/transactions"))
    .replace(/\{\{refundAmount\}\}/g, escapeHtml(formatUsd(input.refundAmount ?? input.orderAmount)))
    .replace(/\{\{refundedOn\}\}/g, escapeHtml(formatDateTime(input.updatedOn)))
    .replace(/\{\{refundMethod\}\}/g, "Wallet Balance")
    .replace(/\{\{refundReference\}\}/g, escapeHtml(input.orderId))
    .replace(/\{\{year\}\}/g, String(new Date().getFullYear()));
};

const sendOrderStatusUpdateEmails = async (
  db: ReturnType<typeof getDB>,
  order: Order,
  input: {
    status: "disputed" | "cancelled" | "refunded";
    updatedOn: string;
    statusReason?: string | null;
    refundAmount?: number;
  }
) => {
  const [buyer, seller, product] = await Promise.all([
    order.buyerId === "anon-gameket-id" ? null : db.collection<User>("users").findOne({ id: order.buyerId }),
    db.collection<User>("users").findOne({ id: order.sellerId }),
    getCatalogsDB().collection<Product>("Products").findOne({ productId: order.productId }),
  ]);

  const productName = product?.name || "Product";
  const recipients: Array<{ username: string; email: string }> = [];
  if (buyer && shouldSendEmailForUser(buyer)) recipients.push({ username: buyer.username, email: buyer.email });
  if (seller && shouldSendEmailForUser(seller)) recipients.push({ username: seller.username, email: seller.email });
  if (!recipients.length) return;

  await Promise.allSettled(
    recipients.map((recipient) => {
      const html = renderOrderStatusUpdateEmail(recipient.username, {
        status: input.status,
        orderId: order.orderId,
        productName,
        quantity: order.quantity,
        orderAmount: order.totalAmount,
        updatedOn: input.updatedOn,
        statusReason: input.statusReason,
        refundAmount: input.refundAmount,
      });

      return smtpTransporter.sendMail({
        from: `GAMEKET <${process.env.SMTP_EMAIL}>`,
        to: recipient.email,
        subject: "Order Status Updated",
        html,
      });
    })
  );
};

const renderUserSuspendedEmail = (user: User, suspendedOn: string): string => {
  const template = readFileSync(join(process.cwd(), "src", "emails", "user-suspended-email.html"), "utf-8");
  const firstName = user.username.trim() || "there";
  const caseId = `SUSP-${randomBytes(4).toString("hex").toUpperCase()}`;

  return template
    .replace(/\{\{firstName\}\}/g, escapeHtml(firstName))
    .replace(/\{\{email\}\}/g, escapeHtml(user.email))
    .replace(/\{\{userId\}\}/g, escapeHtml(user.id))
    .replace(/\{\{suspendedOn\}\}/g, escapeHtml(formatDateTime(suspendedOn)))
    .replace(/\{\{suspensionType\}\}/g, "Administrative Suspension")
    .replace(/\{\{caseId\}\}/g, escapeHtml(caseId))
    .replace(/\{\{suspensionReason\}\}/g, "Your account was suspended due to a policy or security review. Contact support to submit an appeal.")
    .replace(/\{\{year\}\}/g, String(new Date().getFullYear()));
};

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

function toAdminWithdrawalNode(withdrawal: Withdrawal) {
  return {
    withdrawalId: withdrawal.withdrawalId,
    transactionId: withdrawal.transactionId,
    userId: withdrawal.userId,
    amount: withdrawal.amount,
    serviceFee: withdrawal.serviceFee,
    networkFee: withdrawal.networkFee,
    totalFee: withdrawal.totalFee,
    payoutAmount: withdrawal.payoutAmount,
    status: withdrawal.status,
    wallet: withdrawal.wallet,
    createdAt: withdrawal.createdAt,
    processedAt: withdrawal.processedAt,
    processedBy: withdrawal.processedBy,
  };
}

const recordAdminWithdrawalDecision = async (input: {
  eventName: "WITHDRAWAL_APPROVED" | "WITHDRAWAL_DECLINED";
  outcome: "success" | "failure";
  reason: string;
  context: Context;
  withdrawalId: string;
  targetUserId?: string | null;
  metadata?: Record<string, unknown>;
}) => {
  const actorType = input.context.user?.role === "admin" ? "admin" : "anonymous";
  const actorId = input.context.user?.userId || null;

  await recordAuditEvent({
    eventName: input.eventName,
    category: "withdrawal",
    outcome: input.outcome,
    actorType,
    actorId,
    requestId: input.context.requestId,
    targetType: "withdrawal",
    targetId: input.withdrawalId,
    metadata: {
      reason: input.reason,
      withdrawalId: input.withdrawalId,
      targetUserId: input.targetUserId || null,
      ...(input.metadata || {}),
    },
  });

  // Also record to AdminLogs collection
  if (actorId) {
    await recordAdminLog({
      adminId: actorId,
      adminType: "admin",
      action: input.eventName === "WITHDRAWAL_APPROVED" ? "WITHDRAWAL_APPROVE" : "WITHDRAWAL_DECLINE",
      status: input.outcome,
      targetType: "withdrawal",
      targetId: input.withdrawalId,
      details: `Admin ${input.eventName === "WITHDRAWAL_APPROVED" ? "approved" : "declined"} withdrawal ${input.withdrawalId} - Reason: ${input.reason}`,
      metadata: {
        reason: input.reason,
        targetUserId: input.targetUserId,
        ...(input.metadata || {}),
      },
    });
  }
};

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

  AdminGetWithdrawals: async (
    _: unknown,
    { status, first, after, last, before }: { status?: "pending" | "approved" | "declined"; first?: number; after?: string; last?: number; before?: string },
    context: Context
  ) => {
    if (!context.user || context.user.role !== "admin") {
      throw new GraphQLError("Admin access required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const walletsDB = getWalletsDB();
    const query = status ? { status } : {};

    const allWithdrawals = await walletsDB
      .collection<Withdrawal>("Withdrawals")
      .find(query)
      .sort({ createdAt: -1 })
      .toArray();

    const total = allWithdrawals.length;
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

    const sliced = allWithdrawals.slice(start, end);

    const edges = sliced.map((w, i) => ({
      cursor: encodeCursor(start + i),
      node: toAdminWithdrawalNode(w),
    }));

    return {
      code: 200,
      success: true,
      message: status
        ? `${total} withdrawal request(s) found with status ${status}`
        : `${total} withdrawal request(s) found`,
      withdrawals: {
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

  AdmingetPremiumUsers: async (
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

    const allPremium = await db
      .collection<Premium>("Premium")
      .find({ isActive: true })
      .sort({ subscribedAt: -1 })
      .toArray();

    const total = allPremium.length;
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

    const sliced = allPremium.slice(start, end);
    const userIds = [...new Set(sliced.map((p) => p.userId))];
    const users = await db.collection<User>("users").find({ id: { $in: userIds } }).toArray();
    const userMap = new Map(users.map((u) => [u.id, u]));

    const edges = sliced.map((p, i) => ({
      cursor: encodeCursor(start + i),
      node: {
        user: userMap.get(p.userId)!,
        premium: {
          subscribedAt: p.subscribedAt,
          expiresAt: p.expiresAt,
          isActive: p.isActive,
        },
      },
    }));

    return {
      code: 200,
      success: true,
      message: `${total} premium user(s) found`,
      premiumUsers: {
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

  AdmingetProducts: async (
    _: unknown,
    { first, after, last, before }: { first?: number; after?: string; last?: number; before?: string },
    context: Context
  ) => {
    if (!context.user || context.user.role !== "admin") {
      throw new GraphQLError("Admin access required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const catalogsDB = getCatalogsDB();

    const officialStore = await catalogsDB.collection<Store>("Stores").findOne({ type: "official" });
    if (!officialStore) {
      return {
        code: 404,
        success: false,
        message: "Official store not found",
        products: { edges: [], pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null, fetchedCount: 0, remainingCount: 0 } },
      };
    }

    const allProducts = await catalogsDB
      .collection<Product>("Products")
      .find({ storeId: officialStore.storeId })
      .sort({ createdAt: -1 })
      .toArray();

    const total = allProducts.length;
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

    const sliced = allProducts.slice(start, end);

    const edges = sliced.map((p, i) => ({
      cursor: encodeCursor(start + i),
      node: {
        productId: p.productId,
        catalog: p.catalog,
        category: p.category,
        region: p.region,
        name: p.name,
        description: p.description,
        marketPrice: p.marketPrice,
        price: p.price,
        discount: p.discount,
        isActive: p.isActive,
        isPromoted: p.isPromoted,
        available: p.available,
        sold: p.sold,
        type: p.type,
        createdAt: p.createdAt,
      },
    }));

    return {
      code: 200,
      success: true,
      message: `${total} official product(s) found`,
      products: {
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

  AdmingetProductCodes: async (
    _: unknown,
    { productId, first, after, last, before }: { productId: string; first?: number; after?: string; last?: number; before?: string },
    context: Context
  ) => {
    if (!context.user || context.user.role !== "admin") {
      throw new GraphQLError("Admin access required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }
    return catalogsQueries.viewProductCodes(_, { productId, first, after, last, before }, context);
  },

  AdminCheckProductADPosition: async (
    _: unknown,
    { productId, amount }: { productId: string; amount: number },
    context: Context
  ) => {
    if (!context.user || context.user.role !== "admin") {
      throw new GraphQLError("Admin access required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const catalogsDB = getCatalogsDB();
    const product = await catalogsDB.collection<Product>("Products").findOne({ productId });

    if (!product) {
      return {
        code: 404,
        success: false,
        message: "Product not found",
        category: null,
        overallPosition: null,
        categoryPosition: null,
        totalPromoted: null,
        totalPromotedInCategory: null,
      };
    }

    const delegatedContext: Context = {
      ...context,
      user: {
        userId: product.userId,
        email: context.user.email,
      },
      authError: null,
    };

    return catalogsQueries.checkProductADPosition(_, { productId, amount }, delegatedContext);
  },

  AdminCheckStoreADPosition: async (
    _: unknown,
    { amount }: { amount: number },
    context: Context
  ) => {
    if (!context.user || context.user.role !== "admin") {
      throw new GraphQLError("Admin access required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const catalogsDB = getCatalogsDB();
    const officialStore = await catalogsDB.collection<Store>("Stores").findOne({ type: "official" });

    if (!officialStore) {
      return {
        code: 404,
        success: false,
        message: "Official store not found",
        overallPosition: null,
        totalPromoted: null,
      };
    }

    const delegatedContext: Context = {
      ...context,
      user: {
        userId: officialStore.userId,
        email: context.user.email,
      },
      authError: null,
    };

    return catalogsQueries.checkStoreADPosition(_, { amount }, delegatedContext);
  },

  AdmingetUserAdvertisableProducts: async (
    _: unknown,
    { first, after, last, before }: { first?: number; after?: string; last?: number; before?: string },
    context: Context
  ) => {
    if (!context.user || context.user.role !== "admin") {
      throw new GraphQLError("Admin access required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const catalogsDB = getCatalogsDB();
    const officialStore = await catalogsDB.collection<Store>("Stores").findOne({ type: "official" });

    if (!officialStore) {
      return {
        code: 404,
        success: false,
        message: "Official store not found",
        products: null,
      };
    }

    const delegatedContext: Context = {
      ...context,
      user: {
        userId: officialStore.userId,
        email: context.user.email,
      },
      authError: null,
    };

    return catalogsQueries.getUserAdvertisableProducts(_, { first, after, last, before }, delegatedContext);
  },

  AdmingetDisputes: async (
    _: unknown,
    { status, first, after, last, before }: { status?: "open" | "under_review" | "resolved" | "closed"; first?: number; after?: string; last?: number; before?: string },
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

    const allDisputes = await walletsDB
      .collection<Dispute>("Disputes")
      .find(query)
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

  AdmingetDisputeDetails: async (
    _: unknown,
    { disputeId, first, after, last, before }: { disputeId: string; first?: number; after?: string; last?: number; before?: string },
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

    const dispute = await walletsDB.collection<Dispute>("Disputes").findOne({ disputeId });
    if (!dispute) {
      return { code: 404, success: false, message: "Dispute not found", dispute: null };
    }

    const order = await walletsDB.collection<Order>("Orders").findOne({ orderId: dispute.orderId });
    const store = await catalogsDB.collection<Store>("Stores").findOne({ storeId: dispute.storeId });
    const buyer = await db.collection<User>("users").findOne({ id: dispute.buyerId });
    const seller = await db.collection<User>("users").findOne({ id: dispute.sellerId });

    const allMessages = [...(dispute.messages || [])].reverse();
    const total = allMessages.length;

    const defaultPageSize = 30;
    const pageFirst = first ?? (last == null ? defaultPageSize : undefined);
    let msgStart = 0;
    let msgEnd = total;

    if (pageFirst != null && after) {
      msgStart = decodeCursor(after) + 1;
      msgEnd = Math.min(msgStart + pageFirst, total);
    } else if (pageFirst != null) {
      msgEnd = Math.min(pageFirst, total);
    } else if (last != null && before) {
      msgEnd = decodeCursor(before);
      msgStart = Math.max(msgEnd - last, 0);
    } else if (last != null) {
      msgStart = Math.max(total - last, 0);
    }

    const sliced = allMessages.slice(msgStart, msgEnd);

    const messageEdges = sliced.map((m, i) => ({
      cursor: encodeCursor(msgStart + i),
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
            hasNextPage: msgEnd < total,
            hasPreviousPage: msgStart > 0,
            startCursor: messageEdges.length ? messageEdges[0].cursor : null,
            endCursor: messageEdges.length ? messageEdges[messageEdges.length - 1].cursor : null,
            fetchedCount: messageEdges.length,
            remainingCount: total - msgEnd,
          },
        },
        createdAt: dispute.createdAt,
        order: order
          ? {
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
            }
          : null,
      },
    };
  },
};

export const adminMutations = {
  Testemail: async (
    _: unknown,
    { userId, emailkey, mailId }: { userId: string; emailkey: string; mailId: number },
    _context: Context
  ) => {
    const configuredEmailKey = process.env.EMAIL_KEY;
    if (!configuredEmailKey) {
      return { code: 500, success: false, message: "EMAIL_KEY is not configured" };
    }

    if (emailkey !== configuredEmailKey) {
      return { code: 403, success: false, message: "Invalid email key" };
    }

    if (mailId !== 1) {
      return { code: 400, success: false, message: "Unsupported mailId. Use 1 for welcome-email.html" };
    }

    const db = getDB();
    const user = await db.collection<User>("users").findOne({ id: userId });

    if (!user) {
      return { code: 404, success: false, message: "User not found" };
    }

    try {
      await smtpTransporter.sendMail({
        from: `GAMEKET <${process.env.SMTP_EMAIL}>`,
        to: user.email,
        subject: "Welcome to Gameket",
        html: renderWelcomeEmail(user),
      });
    } catch (emailError) {
      console.error("Failed to send test email:", emailError);
      return { code: 500, success: false, message: "Failed to send test email" };
    }

    return {
      code: 200,
      success: true,
      message: `Test email sent successfully using mailId ${mailId}`,
    };
  },

  adminLogin: async (
    _: unknown,
    { input }: { input: { email: string; password: string } },
    context: Context
  ) => {
    const ip = input.email.trim().toLowerCase();
    const emailHash = createHash("sha256").update(ip).digest("hex");
    const requestId = context.requestId;

    const auditAdminLogin = async (
      outcome: "success" | "failure",
      reason: string,
      metadata: Record<string, unknown> = {}
    ) => {
      await recordAuditEvent({
        eventName: outcome === "success" ? "LOGIN_SUCCESS" : "LOGIN_FAILURE",
        category: "auth",
        outcome,
        actorType: outcome === "success" ? "admin" : "anonymous",
        actorId: outcome === "success" ? "admin" : null,
        requestId,
        targetType: "admin",
        targetId: "admin",
        metadata: {
          reason,
          emailHash,
          ...metadata,
        },
      });
    };

    // Rate limiting
    const now = Date.now();
    const attempt = adminLoginAttempts.get(ip);
    if (attempt) {
      if (attempt.lockedUntil > now) {
        const minutesLeft = Math.ceil((attempt.lockedUntil - now) / 60000);
        await auditAdminLogin("failure", "RATE_LIMITED", { minutesLeft });
        return { code: 429, success: false, message: `Too many attempts. Try again in ${minutesLeft} minute(s)`, token: null };
      }
      if (attempt.lockedUntil <= now && attempt.count >= MAX_ADMIN_ATTEMPTS) {
        adminLoginAttempts.delete(ip);
      }
    }

    const db = getDB();

    const adminDoc = await db.collection("Admin").findOne({ key: "admin" });
    if (!adminDoc) {
      await auditAdminLogin("failure", "ADMIN_CONFIG_MISSING");
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
      await auditAdminLogin("failure", "INVALID_EMAIL", { attemptCount: current.count });
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
      await auditAdminLogin("failure", "INVALID_PASSWORD", { attemptCount: current.count });
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

    await auditAdminLogin("success", "ADMIN_LOGIN_SUCCESS", { tokenVersion: newTokenVersion });

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
      await recordAdminLog({
        adminId: null,
        adminType: "support",
        action: "SUPPORT_LOGIN_FAILURE",
        status: "failure",
        targetType: "support",
        targetId: null,
        details: "Support login failed: missing email or password",
      });
      return { code: 400, success: false, message: "Email and password are required", token: null, support: null };
    }

    const support = await supports.findOne({ email });
    if (!support) {
      await recordAdminLog({
        adminId: null,
        adminType: "support",
        action: "SUPPORT_LOGIN_FAILURE",
        status: "failure",
        targetType: "support",
        targetId: null,
        details: `Support login failed: invalid credentials for email ${email}`,
        metadata: { email },
      });
      return { code: 401, success: false, message: "Invalid email or password", token: null, support: null };
    }

    const valid = await bcrypt.compare(password, support.password || "");
    if (!valid) {
      await recordAdminLog({
        adminId: support.supportId,
        adminType: "support",
        action: "SUPPORT_LOGIN_FAILURE",
        status: "failure",
        targetType: "support",
        targetId: support.supportId,
        details: `Support login failed: invalid password for ${support.email}`,
        metadata: { email },
      });
      return { code: 401, success: false, message: "Invalid email or password", token: null, support: null };
    }

    if (support.isSuspended || !support.isActive || !support.hasSupportPrivileges) {
      await recordAdminLog({
        adminId: support.supportId,
        adminType: "support",
        action: "SUPPORT_LOGIN_FAILURE",
        status: "failure",
        targetType: "support",
        targetId: support.supportId,
        details: `Support login blocked: account suspended=${support.isSuspended}, inactive=${!support.isActive}, no privileges=${!support.hasSupportPrivileges}`,
      });
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

    await recordAdminLog({
      adminId: support.supportId,
      adminType: "support",
      action: "SUPPORT_LOGIN",
      status: "success",
      targetType: "support",
      targetId: support.supportId,
      details: `Support staff ${support.email} logged in successfully`,
      metadata: { email: support.email, tokenVersion: newTokenVersion },
    });

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
      await recordAdminLog({
        adminId: context.user.userId,
        adminType: "admin",
        action: "USER_SUSPEND",
        status: "failure",
        targetType: "user",
        targetId: userId,
        details: `Failed to suspend user: user not found`,
        metadata: { userId },
      });
      return { code: 404, success: false, message: "User not found", user: null };
    }

    if (existingUser.isSuspended) {
      await recordAdminLog({
        adminId: context.user.userId,
        adminType: "admin",
        action: "USER_SUSPEND",
        status: "success",
        targetType: "user",
        targetId: userId,
        details: `User already suspended (no action taken)`,
        metadata: { userId, username: existingUser.username },
      });
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

    if (updatedUser && shouldSendEmailForUser(updatedUser)) {
      try {
        const html = renderUserSuspendedEmail(updatedUser, new Date().toISOString());
        await smtpTransporter.sendMail({
          from: `GAMEKET <${process.env.SMTP_EMAIL}>`,
          to: updatedUser.email,
          subject: "Account Suspended - Action Required",
          html,
        });
      } catch (error) {
        console.error("Failed to send user suspension email:", error);
      }
    }

    await recordAdminLog({
      adminId: context.user.userId,
      adminType: "admin",
      action: "USER_SUSPEND",
      status: "success",
      targetType: "user",
      targetId: userId,
      details: `Admin ${context.user.userId} suspended user ${existingUser.username} (${existingUser.email})`,
      metadata: { userId, username: existingUser.username, email: existingUser.email, isStore: existingUser.isStore },
    });

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
      await recordAdminLog({
        adminId: context.user.userId,
        adminType: "admin",
        action: "USER_ACTIVATE",
        status: "failure",
        targetType: "user",
        targetId: userId,
        details: `Failed to activate user: user not found`,
        metadata: { userId },
      });
      return { code: 404, success: false, message: "User not found", user: null };
    }

    if (!existingUser.isSuspended) {
      await recordAdminLog({
        adminId: context.user.userId,
        adminType: "admin",
        action: "USER_ACTIVATE",
        status: "success",
        targetType: "user",
        targetId: userId,
        details: `User already active (no action taken)`,
        metadata: { userId, username: existingUser.username },
      });
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

    await recordAdminLog({
      adminId: context.user.userId,
      adminType: "admin",
      action: "USER_ACTIVATE",
      status: "success",
      targetType: "user",
      targetId: userId,
      details: `Admin ${context.user.userId} activated user ${existingUser.username} (${existingUser.email})`,
      metadata: { userId, username: existingUser.username, email: existingUser.email },
    });

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
      await recordAdminLog({
        adminId: context.user.userId,
        adminType: "admin",
        action: "SUPPORT_ADD",
        status: "failure",
        targetType: "support",
        targetId: null,
        details: "Failed to add support: missing required fields",
      });
      return { code: 400, success: false, message: "Email, username and password are required", support: null };
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      await recordAdminLog({
        adminId: context.user.userId,
        adminType: "admin",
        action: "SUPPORT_ADD",
        status: "failure",
        targetType: "support",
        targetId: null,
        details: `Failed to add support: invalid email format`,
        metadata: { email: normalizedEmail },
      });
      return { code: 400, success: false, message: "Invalid email format", support: null };
    }

    if (password.length < 8) {
      await recordAdminLog({
        adminId: context.user.userId,
        adminType: "admin",
        action: "SUPPORT_ADD",
        status: "failure",
        targetType: "support",
        targetId: null,
        details: "Failed to add support: password too short",
      });
      return { code: 400, success: false, message: "Password must be at least 8 characters", support: null };
    }

    if (cleanUsername.length > 30) {
      await recordAdminLog({
        adminId: context.user.userId,
        adminType: "admin",
        action: "SUPPORT_ADD",
        status: "failure",
        targetType: "support",
        targetId: null,
        details: "Failed to add support: username too long",
      });
      return { code: 400, success: false, message: "Username must be at most 30 characters", support: null };
    }

    if (/\s/.test(cleanUsername)) {
      await recordAdminLog({
        adminId: context.user.userId,
        adminType: "admin",
        action: "SUPPORT_ADD",
        status: "failure",
        targetType: "support",
        targetId: null,
        details: "Failed to add support: username contains spaces",
      });
      return { code: 400, success: false, message: "Username must not contain spaces", support: null };
    }

    const existingByEmail = await supports.findOne({ email: normalizedEmail });
    if (existingByEmail) {
      await recordAdminLog({
        adminId: context.user.userId,
        adminType: "admin",
        action: "SUPPORT_ADD",
        status: "failure",
        targetType: "support",
        targetId: null,
        details: `Failed to add support: email already exists`,
        metadata: { email: normalizedEmail },
      });
      return { code: 409, success: false, message: "Support email already exists", support: null };
    }

    const existingByUsername = await supports.findOne({ username: cleanUsername });
    if (existingByUsername) {
      await recordAdminLog({
        adminId: context.user.userId,
        adminType: "admin",
        action: "SUPPORT_ADD",
        status: "failure",
        targetType: "support",
        targetId: null,
        details: `Failed to add support: username already exists`,
        metadata: { username: cleanUsername },
      });
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

    await recordAdminLog({
      adminId: context.user.userId,
      adminType: "admin",
      action: "SUPPORT_ADD",
      status: "success",
      targetType: "support",
      targetId: support.supportId,
      details: `Admin ${context.user.userId} created new support account: ${cleanUsername} (${normalizedEmail})`,
      metadata: { supportId: support.supportId, email: normalizedEmail, username: cleanUsername },
    });

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
      await recordAdminLog({
        adminId: context.user.userId,
        adminType: "admin",
        action: "SUPPORT_SUSPEND",
        status: "failure",
        targetType: "support",
        targetId: supportId,
        details: `Failed to suspend support: support account not found`,
        metadata: { supportId },
      });
      return { code: 404, success: false, message: "Support account not found", support: null };
    }

    if (existingSupport.isSuspended && !existingSupport.isActive && !existingSupport.hasSupportPrivileges) {
      await recordAdminLog({
        adminId: context.user.userId,
        adminType: "admin",
        action: "SUPPORT_SUSPEND",
        status: "success",
        targetType: "support",
        targetId: supportId,
        details: `Support account already suspended (no action taken)`,
        metadata: { supportId, email: existingSupport.email },
      });
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

    await recordAdminLog({
      adminId: context.user.userId,
      adminType: "admin",
      action: "SUPPORT_SUSPEND",
      status: "success",
      targetType: "support",
      targetId: supportId,
      details: `Admin ${context.user.userId} suspended support account: ${existingSupport.username} (${existingSupport.email})`,
      metadata: { supportId, email: existingSupport.email, username: existingSupport.username },
    });

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
        deliveryOption: "email",
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

  AdminAddProduct: async (_: unknown, { input }: { input: { catalog: string; category: string; region: string; name: string; description: string; marketPrice: number; price: number; discount: number; type: "Auto" | "Manual"; codes?: string[]; isAPI?: boolean } }, context: Context) => {
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

    const catalogsDB = getCatalogsDB();
    const db = getDB();
    const { productId, amount } = input;
    const start = new Date(input.campaignStart);
    const end = new Date(input.campaignEnd);

    if (amount < 0.5) {
      return { code: 400, success: false, message: "Minimum ad amount is 0.5", promotion: null };
    }

    if (end <= start) {
      return { code: 400, success: false, message: "Campaign end must be after campaign start", promotion: null };
    }

    const product = await catalogsDB.collection<Product>("Products").findOne({ productId });

    if (!product) {
      return {
        code: 404,
        success: false,
        message: "Product not found",
        promotion: null,
      };
    }

    if (!product.isActive) {
      return { code: 400, success: false, message: "Product must be active to advertise", promotion: null };
    }

    const existingPromotion = await catalogsDB
      .collection("PromotedProducts")
      .findOne({ productId });

    if (existingPromotion) {
      return {
        code: 409,
        success: false,
        message: "Product is already promoted. Wait for the current campaign to end before creating a new one",
        promotion: null,
      };
    }

    const user = await db.collection<User>("users").findOne({ id: product.userId });
    if (!user) {
      return { code: 404, success: false, message: "Product owner not found", promotion: null };
    }

    const promotion = {
      userId: product.userId,
      storeId: product.storeId,
      productId,
      amount: parseFloat(amount.toFixed(2)),
      campaignStart: start.toISOString(),
      campaignEnd: end.toISOString(),
      createdAt: new Date().toISOString(),
    };

    await catalogsDB.collection("PromotedProducts").insertOne(promotion);

    await catalogsDB.collection<Product>("Products").updateOne(
      { productId: product.productId, userId: product.userId },
      { $set: { isPromoted: true } }
    );

    return {
      code: 201,
      success: true,
      message: "Product promoted successfully",
      user,
      promotion: {
        productId: promotion.productId,
        amount: promotion.amount,
        campaignStart: promotion.campaignStart,
        campaignEnd: promotion.campaignEnd,
        createdAt: promotion.createdAt,
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
          isPromoted: true,
          available: product.available,
          sold: product.sold,
          type: product.type,
          createdAt: product.createdAt,
        },
      },
    };
  },

  AdminAdvertiseStore: async (_: unknown, { input }: { input: { amount: number; campaignStart: string; campaignEnd: string } }, context: Context) => {
    if (!context.user || context.user.role !== "admin") {
      throw new GraphQLError("Admin access required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const catalogsDB = getCatalogsDB();
    const db = getDB();
    const { amount } = input;
    const start = new Date(input.campaignStart);
    const end = new Date(input.campaignEnd);

    if (amount < 0.5) {
      return { code: 400, success: false, message: "Minimum ad amount is 0.5", promotion: null };
    }

    if (end <= start) {
      return { code: 400, success: false, message: "Campaign end must be after campaign start", promotion: null };
    }

    const officialStore = await catalogsDB.collection<Store>("Stores").findOne({ type: "official" });

    if (!officialStore) {
      return {
        code: 404,
        success: false,
        message: "Official store not found",
        promotion: null,
      };
    }

    if (!officialStore.isActive) {
      return { code: 400, success: false, message: "Store must be active to advertise", promotion: null };
    }

    const existingPromotion = await catalogsDB
      .collection("PromotedStores")
      .findOne({ storeId: officialStore.storeId });

    if (existingPromotion) {
      return {
        code: 409,
        success: false,
        message: "Store is already promoted. Wait for the current campaign to end before creating a new one",
        promotion: null,
      };
    }

    const user = await db.collection<User>("users").findOne({ id: officialStore.userId });
    if (!user) {
      return { code: 404, success: false, message: "Store owner not found", promotion: null };
    }

    const promotion = {
      userId: officialStore.userId,
      storeId: officialStore.storeId,
      amount: parseFloat(amount.toFixed(2)),
      campaignStart: start.toISOString(),
      campaignEnd: end.toISOString(),
      createdAt: new Date().toISOString(),
    };

    await catalogsDB.collection("PromotedStores").insertOne(promotion);

    await catalogsDB.collection<Store>("Stores").updateOne(
      { storeId: officialStore.storeId, userId: officialStore.userId },
      { $set: { isPromoted: true } }
    );

    return {
      code: 201,
      success: true,
      message: "Store promoted successfully",
      user,
      promotion: {
        storeId: promotion.storeId,
        amount: promotion.amount,
        campaignStart: promotion.campaignStart,
        campaignEnd: promotion.campaignEnd,
        createdAt: promotion.createdAt,
        store: {
          storeId: officialStore.storeId,
          storeName: officialStore.storeName,
          isActive: officialStore.isActive,
          isApproved: officialStore.isApproved,
          approveStatus: officialStore.approveStatus,
          isPromoted: true,
          type: officialStore.type,
          totalSales: officialStore.totalSales,
          positiveReviews: officialStore.positiveReviews,
          negativeReviews: officialStore.negativeReviews,
          reviews: officialStore.reviews,
          registered: officialStore.createdAt?.split("T")[0] || officialStore.createdAt,
          requestCount: officialStore.requestCount ?? 0,
        },
      },
    };
  },

  AdminApproveWithdrawal: async (
    _: unknown,
    { withdrawalId }: { withdrawalId: string },
    context: Context
  ) => {
    if (!context.user || context.user.role !== "admin") {
      throw new GraphQLError("Admin access required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const walletsDB = getWalletsDB();
    const withdrawals = walletsDB.collection<Withdrawal>("Withdrawals");
    const balances = walletsDB.collection<Balance>("Balances");

    const existing = await withdrawals.findOne({ withdrawalId });
    if (!existing) {
      await recordAdminWithdrawalDecision({
        eventName: "WITHDRAWAL_APPROVED",
        outcome: "failure",
        reason: "WITHDRAWAL_NOT_FOUND",
        context,
        withdrawalId,
      });
      return { code: 404, success: false, message: "Withdrawal request not found", withdrawal: null };
    }

    if (existing.status !== "pending") {
      await recordAdminWithdrawalDecision({
        eventName: "WITHDRAWAL_APPROVED",
        outcome: "failure",
        reason: "WITHDRAWAL_NOT_PENDING",
        context,
        withdrawalId,
        targetUserId: existing.userId,
        metadata: {
          currentStatus: existing.status,
        },
      });
      return {
        code: 400,
        success: false,
        message: `Withdrawal request has already been ${existing.status}`,
        withdrawal: toAdminWithdrawalNode(existing),
      };
    }

    const balanceUpdate = await balances.updateOne(
      { userId: existing.userId, suspendedBalance: { $gte: existing.amount } },
      { $inc: { suspendedBalance: -existing.amount } }
    );

    if (balanceUpdate.modifiedCount === 0) {
      await recordAdminWithdrawalDecision({
        eventName: "WITHDRAWAL_APPROVED",
        outcome: "failure",
        reason: "SUSPENDED_BALANCE_INSUFFICIENT",
        context,
        withdrawalId,
        targetUserId: existing.userId,
      });
      return {
        code: 409,
        success: false,
        message: "Unable to approve withdrawal because suspended balance is insufficient",
        withdrawal: toAdminWithdrawalNode(existing),
      };
    }

    await walletsDB.collection<Transaction>("Transactions").updateOne(
      { id: existing.transactionId },
      { $set: { status: "completed" } }
    );

    const processedAt = new Date().toISOString();
    await withdrawals.updateOne(
      { withdrawalId },
      { $set: { status: "approved", processedAt, processedBy: context.user.userId } }
    );

    const updated = await withdrawals.findOne({ withdrawalId });
    const db = getDB();

    if (updated) {
      const user = await db.collection<User>("users").findOne({ id: updated.userId });
      if (user && shouldSendEmailForUser(user)) {
        try {
          const html = renderWithdrawalStatusUpdateEmail(user, updated, "approved");
          await smtpTransporter.sendMail({
            from: `GAMEKET <${process.env.SMTP_EMAIL}>`,
            to: user.email,
            subject: "Withdrawal Status Update",
            html,
          });
        } catch (error) {
          console.error("Failed to send withdrawal approval email:", error);
        }
      }

      await recordAdminWithdrawalDecision({
        eventName: "WITHDRAWAL_APPROVED",
        outcome: "success",
        reason: "WITHDRAWAL_APPROVED",
        context,
        withdrawalId,
        targetUserId: updated.userId,
        metadata: {
          transactionId: updated.transactionId,
          amount: updated.amount,
        },
      });
    } else {
      await recordAdminWithdrawalDecision({
        eventName: "WITHDRAWAL_APPROVED",
        outcome: "failure",
        reason: "WITHDRAWAL_POST_UPDATE_NOT_FOUND",
        context,
        withdrawalId,
      });
    }

    return {
      code: 200,
      success: true,
      message: "Withdrawal approved successfully",
      withdrawal: updated ? toAdminWithdrawalNode(updated) : null,
    };
  },

  AdminDeclineWithdrawal: async (
    _: unknown,
    { withdrawalId }: { withdrawalId: string },
    context: Context
  ) => {
    if (!context.user || context.user.role !== "admin") {
      throw new GraphQLError("Admin access required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const walletsDB = getWalletsDB();
    const withdrawals = walletsDB.collection<Withdrawal>("Withdrawals");
    const balances = walletsDB.collection<Balance>("Balances");

    const existing = await withdrawals.findOne({ withdrawalId });
    if (!existing) {
      await recordAdminWithdrawalDecision({
        eventName: "WITHDRAWAL_DECLINED",
        outcome: "failure",
        reason: "WITHDRAWAL_NOT_FOUND",
        context,
        withdrawalId,
      });
      return { code: 404, success: false, message: "Withdrawal request not found", withdrawal: null };
    }

    if (existing.status !== "pending") {
      await recordAdminWithdrawalDecision({
        eventName: "WITHDRAWAL_DECLINED",
        outcome: "failure",
        reason: "WITHDRAWAL_NOT_PENDING",
        context,
        withdrawalId,
        targetUserId: existing.userId,
        metadata: {
          currentStatus: existing.status,
        },
      });
      return {
        code: 400,
        success: false,
        message: `Withdrawal request has already been ${existing.status}`,
        withdrawal: toAdminWithdrawalNode(existing),
      };
    }

    const balanceUpdate = await balances.updateOne(
      { userId: existing.userId, suspendedBalance: { $gte: existing.amount } },
      { $inc: { suspendedBalance: -existing.amount, availableBalance: existing.amount } }
    );

    if (balanceUpdate.modifiedCount === 0) {
      await recordAdminWithdrawalDecision({
        eventName: "WITHDRAWAL_DECLINED",
        outcome: "failure",
        reason: "SUSPENDED_BALANCE_INSUFFICIENT",
        context,
        withdrawalId,
        targetUserId: existing.userId,
      });
      return {
        code: 409,
        success: false,
        message: "Unable to decline withdrawal because suspended balance is insufficient",
        withdrawal: toAdminWithdrawalNode(existing),
      };
    }

    await walletsDB.collection<Transaction>("Transactions").updateOne(
      { id: existing.transactionId },
      { $set: { status: "failed" } }
    );

    const processedAt = new Date().toISOString();
    await withdrawals.updateOne(
      { withdrawalId },
      { $set: { status: "declined", processedAt, processedBy: context.user.userId } }
    );

    const updated = await withdrawals.findOne({ withdrawalId });
    const db = getDB();

    if (updated) {
      const user = await db.collection<User>("users").findOne({ id: updated.userId });
      if (user && shouldSendEmailForUser(user)) {
        try {
          const html = renderWithdrawalStatusUpdateEmail(user, updated, "declined");
          await smtpTransporter.sendMail({
            from: `GAMEKET <${process.env.SMTP_EMAIL}>`,
            to: user.email,
            subject: "Withdrawal Status Update",
            html,
          });
        } catch (error) {
          console.error("Failed to send withdrawal decline email:", error);
        }
      }

      await recordAdminWithdrawalDecision({
        eventName: "WITHDRAWAL_DECLINED",
        outcome: "success",
        reason: "WITHDRAWAL_DECLINED",
        context,
        withdrawalId,
        targetUserId: updated.userId,
        metadata: {
          transactionId: updated.transactionId,
          amount: updated.amount,
        },
      });
    } else {
      await recordAdminWithdrawalDecision({
        eventName: "WITHDRAWAL_DECLINED",
        outcome: "failure",
        reason: "WITHDRAWAL_POST_UPDATE_NOT_FOUND",
        context,
        withdrawalId,
      });
    }

    return {
      code: 200,
      success: true,
      message: "Withdrawal declined successfully",
      withdrawal: updated ? toAdminWithdrawalNode(updated) : null,
    };
  },

  AdminUpdateDispute: async (
    _: unknown,
    { disputeId, message }: { disputeId: string; message: string },
    context: Context
  ) => {
    if (!context.user || context.user.role !== "admin") {
      throw new GraphQLError("Admin access required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const trimmed = (message || "").trim();
    if (!trimmed) {
      await recordAdminLog({
        adminId: context.user.userId,
        adminType: "admin",
        action: "DISPUTE_UPDATE",
        status: "failure",
        targetType: "dispute",
        targetId: disputeId,
        details: "Failed to update dispute: message cannot be empty",
      });
      return { code: 400, success: false, message: "Message cannot be empty", dispute: null };
    }

    const walletsDB = getWalletsDB();
    const dispute = await walletsDB.collection<Dispute>("Disputes").findOne({ disputeId });
    if (!dispute) {
      await recordAdminLog({
        adminId: context.user.userId,
        adminType: "admin",
        action: "DISPUTE_UPDATE",
        status: "failure",
        targetType: "dispute",
        targetId: disputeId,
        details: `Failed to update dispute: dispute not found`,
      });
      return { code: 404, success: false, message: "Dispute not found", dispute: null };
    }

    if (dispute.status === "closed") {
      await recordAdminLog({
        adminId: context.user.userId,
        adminType: "admin",
        action: "DISPUTE_UPDATE",
        status: "failure",
        targetType: "dispute",
        targetId: disputeId,
        details: `Failed to update dispute: dispute is closed`,
        metadata: { disputeStatus: dispute.status },
      });
      return { code: 400, success: false, message: "Cannot update a closed dispute", dispute: null };
    }

    const now = new Date().toISOString();
    const newMessage: DisputeMessage = {
      senderId: context.user.userId,
      senderName: "Admin",
      message: trimmed,
      sentAt: now,
    };

    await walletsDB.collection<Dispute>("Disputes").updateOne(
      { disputeId },
      { $push: { messages: newMessage }, $set: { status: dispute.status === "open" ? "under_review" : dispute.status } }
    );

    const updated = await walletsDB.collection<Dispute>("Disputes").findOne({ disputeId });

    await recordAdminLog({
      adminId: context.user.userId,
      adminType: "admin",
      action: "DISPUTE_UPDATE",
      status: "success",
      targetType: "dispute",
      targetId: disputeId,
      details: `Admin added message to dispute ${disputeId}: "${trimmed.substring(0, 100)}"`,
      metadata: { orderId: dispute.orderId, messageLength: trimmed.length },
    });

    return {
      code: 200,
      success: true,
      message: "Dispute updated successfully",
      dispute: {
        disputeId: updated!.disputeId,
        orderId: updated!.orderId,
        buyerId: updated!.buyerId,
        sellerId: updated!.sellerId,
        storeId: updated!.storeId,
        reason: updated!.reason,
        status: updated!.status,
        messages: buildDisputeMessagesConnection(updated!.messages || []),
        createdAt: updated!.createdAt,
        order: null,
      },
    };
  },

  AdminSetDisputeStatus: async (
    _: unknown,
    { disputeId, status }: { disputeId: string; status: "open" | "under_review" | "resolved" | "closed" },
    context: Context
  ) => {
    if (!context.user || context.user.role !== "admin") {
      throw new GraphQLError("Admin access required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const validStatuses = ["open", "under_review", "resolved", "closed"] as const;
    if (!validStatuses.includes(status)) {
      await recordAdminLog({
        adminId: context.user.userId,
        adminType: "admin",
        action: "DISPUTE_SET_STATUS",
        status: "failure",
        targetType: "dispute",
        targetId: disputeId,
        details: `Failed to set dispute status: invalid status ${status}`,
      });
      return { code: 400, success: false, message: "Invalid dispute status", dispute: null };
    }

    const walletsDB = getWalletsDB();
    const dispute = await walletsDB.collection<Dispute>("Disputes").findOne({ disputeId });
    if (!dispute) {
      await recordAdminLog({
        adminId: context.user.userId,
        adminType: "admin",
        action: "DISPUTE_SET_STATUS",
        status: "failure",
        targetType: "dispute",
        targetId: disputeId,
        details: `Failed to set dispute status: dispute not found`,
      });
      return { code: 404, success: false, message: "Dispute not found", dispute: null };
    }

    if (dispute.status === status) {
      await recordAdminLog({
        adminId: context.user.userId,
        adminType: "admin",
        action: "DISPUTE_SET_STATUS",
        status: "success",
        targetType: "dispute",
        targetId: disputeId,
        details: `Dispute already has status ${status} (no action taken)`,
        metadata: { orderId: dispute.orderId, currentStatus: dispute.status },
      });
      return {
        code: 200,
        success: true,
        message: `Dispute is already ${status}`,
        dispute: {
          disputeId: dispute.disputeId,
          orderId: dispute.orderId,
          buyerId: dispute.buyerId,
          sellerId: dispute.sellerId,
          storeId: dispute.storeId,
          reason: dispute.reason,
          status: dispute.status,
          messages: buildDisputeMessagesConnection(dispute.messages || []),
          createdAt: dispute.createdAt,
          order: null,
        },
      };
    }

    await walletsDB.collection<Dispute>("Disputes").updateOne(
      { disputeId },
      { $set: { status } }
    );

    const updated = await walletsDB.collection<Dispute>("Disputes").findOne({ disputeId });

    await recordAdminLog({
      adminId: context.user.userId,
      adminType: "admin",
      action: "DISPUTE_SET_STATUS",
      status: "success",
      targetType: "dispute",
      targetId: disputeId,
      details: `Admin set dispute status from ${dispute.status} to ${status}`,
      changes: { status: { before: dispute.status, after: status } },
      metadata: { orderId: dispute.orderId },
    });

    return {
      code: 200,
      success: true,
      message: `Dispute status set to ${status}`,
      dispute: {
        disputeId: updated!.disputeId,
        orderId: updated!.orderId,
        buyerId: updated!.buyerId,
        sellerId: updated!.sellerId,
        storeId: updated!.storeId,
        reason: updated!.reason,
        status: updated!.status,
        messages: buildDisputeMessagesConnection(updated!.messages || []),
        createdAt: updated!.createdAt,
        order: null,
      },
    };
  },

  AdminResolveDisputeForSeller: async (
    _: unknown,
    { disputeId }: { disputeId: string },
    context: Context
  ) => {
    if (!context.user || context.user.role !== "admin") {
      throw new GraphQLError("Admin access required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const walletsDB = getWalletsDB();

    const dispute = await walletsDB.collection<Dispute>("Disputes").findOne({ disputeId });
    if (!dispute) {
      await recordAdminLog({
        adminId: context.user.userId,
        adminType: "admin",
        action: "DISPUTE_RESOLVE",
        status: "failure",
        targetType: "dispute",
        targetId: disputeId,
        details: "Failed to resolve dispute: dispute not found",
      });
      return { code: 404, success: false, message: "Dispute not found", dispute: null };
    }

    if (dispute.status === "resolved" || dispute.status === "closed") {
      await recordAdminLog({
        adminId: context.user.userId,
        adminType: "admin",
        action: "DISPUTE_RESOLVE",
        status: "failure",
        targetType: "dispute",
        targetId: disputeId,
        details: `Failed to resolve dispute: dispute is already ${dispute.status}`,
        metadata: { currentStatus: dispute.status },
      });
      return { code: 400, success: false, message: `Dispute is already ${dispute.status}`, dispute: null };
    }

    const order = await walletsDB.collection<Order>("Orders").findOne({ orderId: dispute.orderId });
    if (!order) {
      await recordAdminLog({
        adminId: context.user.userId,
        adminType: "admin",
        action: "DISPUTE_RESOLVE",
        status: "failure",
        targetType: "dispute",
        targetId: disputeId,
        details: "Failed to resolve dispute: associated order not found",
        metadata: { orderId: dispute.orderId },
      });
      return { code: 404, success: false, message: "Associated order not found", dispute: null };
    }

    if (!order.isReleased) {
      if (order.status === "pending") {
        await walletsDB.collection<Balance>("Balances").updateOne(
          { userId: order.sellerId },
          { $inc: { availableBalance: order.amount } }
        );
      } else {
        await walletsDB.collection<Balance>("Balances").updateOne(
          { userId: order.sellerId },
          { $inc: { suspendedBalance: -order.amount, availableBalance: order.amount } }
        );
      }

      await walletsDB.collection<Transaction>("Transactions").updateOne(
        { id: order.sellerTransactionId },
        { $set: { status: "completed" } }
      );

      await walletsDB.collection<Order>("Orders").updateOne(
        { orderId: order.orderId },
        { $set: { status: "completed", isReleased: true, releasedAt: new Date().toISOString(), statusUpdatedAt: new Date().toISOString() } }
      );
    } else if (order.status === "disputed") {
      await walletsDB.collection<Order>("Orders").updateOne(
        { orderId: order.orderId },
        { $set: { status: "completed", statusUpdatedAt: new Date().toISOString() } }
      );
    }

    await walletsDB.collection("RefundOffers").updateMany(
      { orderId: order.orderId, status: "pending" },
      { $set: { status: "declined" } }
    );

    const now = new Date().toISOString();
    const resolutionMessage: DisputeMessage = {
      senderId: context.user.userId,
      senderName: "Admin",
      message: "Dispute closed in favor of the seller. Funds released to the seller.",
      sentAt: now,
    };

    await walletsDB.collection<Dispute>("Disputes").updateOne(
      { disputeId },
      { $push: { messages: resolutionMessage }, $set: { status: "closed" } }
    );

    const updated = await walletsDB.collection<Dispute>("Disputes").findOne({ disputeId });

    await recordAdminLog({
      adminId: context.user.userId,
      adminType: "admin",
      action: "DISPUTE_RESOLVE",
      status: "success",
      targetType: "dispute",
      targetId: disputeId,
      details: `Admin resolved dispute in favor of seller: released funds to seller (${order.sellerId}), refund offers declined`,
      metadata: { orderId: dispute.orderId, sellerId: order.sellerId, amount: order.amount },
    });

    return {
      code: 200,
      success: true,
      message: "Dispute closed in favor of the seller",
      dispute: {
        disputeId: updated!.disputeId,
        orderId: updated!.orderId,
        buyerId: updated!.buyerId,
        sellerId: updated!.sellerId,
        storeId: updated!.storeId,
        reason: updated!.reason,
        status: updated!.status,
        messages: buildDisputeMessagesConnection(updated!.messages || []),
        createdAt: updated!.createdAt,
        order: null,
      },
    };
  },

  AdminRefundBuyer: async (
    _: unknown,
    { disputeId }: { disputeId: string },
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

    const dispute = await walletsDB.collection<Dispute>("Disputes").findOne({ disputeId });
    if (!dispute) {
      await recordAdminLog({
        adminId: context.user.userId,
        adminType: "admin",
        action: "REFUND_BUYER",
        status: "failure",
        targetType: "dispute",
        targetId: disputeId,
        details: "Failed to refund buyer: dispute not found",
      });
      return { code: 404, success: false, message: "Dispute not found", dispute: null };
    }

    if (dispute.status === "resolved" || dispute.status === "closed") {
      await recordAdminLog({
        adminId: context.user.userId,
        adminType: "admin",
        action: "REFUND_BUYER",
        status: "failure",
        targetType: "dispute",
        targetId: disputeId,
        details: `Failed to refund buyer: dispute is already ${dispute.status}`,
        metadata: { currentStatus: dispute.status },
      });
      return { code: 400, success: false, message: `Dispute is already ${dispute.status}`, dispute: null };
    }

    const order = await walletsDB.collection<Order>("Orders").findOne({ orderId: dispute.orderId });
    if (!order) {
      await recordAdminLog({
        adminId: context.user.userId,
        adminType: "admin",
        action: "REFUND_BUYER",
        status: "failure",
        targetType: "dispute",
        targetId: disputeId,
        details: "Failed to refund buyer: associated order not found",
        metadata: { orderId: dispute.orderId },
      });
      return { code: 404, success: false, message: "Associated order not found", dispute: null };
    }

    if (order.status === "refunded") {
      await recordAdminLog({
        adminId: context.user.userId,
        adminType: "admin",
        action: "REFUND_BUYER",
        status: "failure",
        targetType: "dispute",
        targetId: disputeId,
        details: "Failed to refund buyer: order already refunded",
        metadata: { orderId: dispute.orderId },
      });
      return { code: 400, success: false, message: "Order has already been refunded", dispute: null };
    }

    const refundAmount = parseFloat(order.totalAmount.toFixed(2));
    const sellerDeduction = parseFloat(order.amount.toFixed(2));

    await walletsDB.collection<Balance>("Balances").updateOne(
      { userId: order.buyerId },
      { $inc: { availableBalance: refundAmount } }
    );

    if (order.isReleased) {
      await walletsDB.collection<Balance>("Balances").updateOne(
        { userId: order.sellerId },
        { $inc: { availableBalance: -sellerDeduction } }
      );
    } else if (order.status !== "pending") {
      await walletsDB.collection<Balance>("Balances").updateOne(
        { userId: order.sellerId },
        { $inc: { suspendedBalance: -sellerDeduction } }
      );
    } else {
      // No-op: pending orders have no seller credit yet.
    }

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

    await walletsDB.collection<Transaction>("Transactions").updateOne(
      { id: order.buyerTransactionId },
      { $set: { status: "refunded" } }
    );
    await walletsDB.collection<Transaction>("Transactions").updateOne(
      { id: order.sellerTransactionId },
      { $set: { status: "refunded" } }
    );

    const buyerRefundTxnId = randomBytes(24).toString("base64").replace(/[+/=]/g, "");
    const now = new Date().toISOString();
    await walletsDB.collection<Transaction>("Transactions").insertOne({
      userId: order.buyerId,
      id: buyerRefundTxnId,
      type: "Refund",
      status: "completed",
      method: "balance",
      amount: refundAmount,
      createdAt: now,
    });

    await walletsDB.collection<Order>("Orders").updateOne(
      { orderId: order.orderId },
      { $set: { status: "refunded", isReleased: true, statusUpdatedAt: now } }
    );

    try {
      await sendOrderStatusUpdateEmails(db, order, {
        status: "refunded",
        updatedOn: now,
        statusReason: "Admin resolved dispute in favor of the buyer and issued a refund",
        refundAmount,
      });
    } catch (error) {
      console.error("Failed to send admin refund order status email:", error);
    }

    await walletsDB.collection("RefundOffers").updateMany(
      { orderId: order.orderId, status: "pending" },
      { $set: { status: "declined" } }
    );

    const resolutionMessage: DisputeMessage = {
      senderId: context.user.userId,
      senderName: "Admin",
      message: `Dispute resolved in favor of the buyer. Refund of ${refundAmount} issued.`,
      sentAt: now,
    };

    await walletsDB.collection<Dispute>("Disputes").updateOne(
      { disputeId },
      { $push: { messages: resolutionMessage }, $set: { status: "resolved" } }
    );

    const updated = await walletsDB.collection<Dispute>("Disputes").findOne({ disputeId });

    await recordAdminLog({
      adminId: context.user.userId,
      adminType: "admin",
      action: "REFUND_BUYER",
      status: "success",
      targetType: "dispute",
      targetId: disputeId,
      details: `Admin resolved dispute in favor of buyer (${order.buyerId}): refunded $${refundAmount}, deducted $${sellerDeduction} from seller (${order.sellerId}), declined pending refund offers`,
      metadata: { orderId: dispute.orderId, buyerId: order.buyerId, sellerId: order.sellerId, refundAmount, sellerDeduction },
    });

    return {
      code: 200,
      success: true,
      message: "Buyer refunded and dispute resolved",
      dispute: {
        disputeId: updated!.disputeId,
        orderId: updated!.orderId,
        buyerId: updated!.buyerId,
        sellerId: updated!.sellerId,
        storeId: updated!.storeId,
        reason: updated!.reason,
        status: updated!.status,
        messages: buildDisputeMessagesConnection(updated!.messages || []),
        createdAt: updated!.createdAt,
        order: null,
      },
    };
  },
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const pickAdminTargetFromArgs = (args: unknown): { targetType: string | null; targetId: string | null } => {
  if (!isPlainRecord(args)) {
    return { targetType: null, targetId: null };
  }

  const targetMappings: Array<[string, string]> = [
    ["withdrawalId", "withdrawal"],
    ["userId", "user"],
    ["supportId", "support"],
    ["disputeId", "dispute"],
    ["productId", "product"],
    ["storeId", "store"],
    ["orderId", "order"],
  ];

  for (const [argName, targetType] of targetMappings) {
    const value = args[argName];
    if (typeof value === "string" && value.trim()) {
      return { targetType, targetId: value };
    }
  }

  const inputValue = args.input;
  if (isPlainRecord(inputValue)) {
    for (const [argName, targetType] of targetMappings) {
      const value = inputValue[argName];
      if (typeof value === "string" && value.trim()) {
        return { targetType, targetId: value };
      }
    }
  }

  return { targetType: null, targetId: null };
};

const wrapAdminActionResolver = (
  actionName: string,
  resolver: (parent: unknown, args: unknown, context: Context, info: unknown) => Promise<unknown>
) => {
  return async (parent: unknown, args: unknown, context: Context, info: unknown) => {
    const actorType = context.user?.role === "admin" ? "admin" : "anonymous";
    const actorId = actorType === "admin" ? context.user?.userId || null : null;
    const { targetType, targetId } = pickAdminTargetFromArgs(args);

    try {
      const result = await resolver(parent, args, context, info);
      const resultRecord = isPlainRecord(result) ? result : null;
      const success = resultRecord && "success" in resultRecord
        ? Boolean(resultRecord.success)
        : true;

      await recordAuditEvent({
        eventName: "ADMIN_ACTION",
        category: "admin_action",
        outcome: success ? "success" : "failure",
        actorType,
        actorId,
        requestId: context.requestId,
        targetType,
        targetId,
        metadata: {
          actionName,
          resultCode: resultRecord && typeof resultRecord.code === "number" ? resultRecord.code : null,
        },
      });

      return result;
    } catch (err) {
      await recordAuditEvent({
        eventName: "ADMIN_ACTION",
        category: "admin_action",
        outcome: "failure",
        actorType,
        actorId,
        requestId: context.requestId,
        targetType,
        targetId,
        metadata: {
          actionName,
          errorName: err instanceof Error ? err.name : "UnknownError",
        },
      });

      throw err;
    }
  };
};

for (const [mutationName, mutationResolver] of Object.entries(adminMutations)) {
  if (!mutationName.startsWith("Admin")) {
    continue;
  }

  if (typeof mutationResolver !== "function") {
    continue;
  }

  (adminMutations as Record<string, unknown>)[mutationName] = wrapAdminActionResolver(
    mutationName,
    mutationResolver as (parent: unknown, args: unknown, context: Context, info: unknown) => Promise<unknown>
  );
}
