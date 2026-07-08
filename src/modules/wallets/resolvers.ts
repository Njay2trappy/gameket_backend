import { randomBytes } from "crypto";
import { GraphQLError } from "graphql";
import nodemailer from "nodemailer";
import { readFileSync } from "fs";
import { join } from "path";
import { getDB, getWalletsDB, getCatalogsDB } from "../../db.js";
import { recordAuditEvent } from "../../audit.js";
import { decryptCodeOrPlain } from "../../utils/codeCrypto.js";
import {
  dispatchApiOrderCallback,
  isApiFulfillmentProduct,
  resolveApiCallbackUrl,
} from "../../utils/productFulfillment.js";
import type { User, Balance, Deposit, Transaction, Order, Product, Store, Review, Dispute, DisputeMessage, RefundOffer, Blacklist, Withdrawal, NotificationState, NotificationConflictRead } from "../../types.js";
import type { Context } from "../../index.js";

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

const renderWithdrawalRequestEmail = (
  user: User,
  withdrawal: Withdrawal,
  availableBalance: number
): string => {
  const template = readFileSync(join(process.cwd(), "src", "emails", "withdrawal-request-email.html"), "utf-8");
  const firstName = user.username.trim() || "there";

  return template
    .replace(/\{\{firstName\}\}/g, escapeHtml(firstName))
    .replace(/\{\{withdrawalAmount\}\}/g, escapeHtml(formatUsd(withdrawal.amount)))
    .replace(/\{\{requestId\}\}/g, escapeHtml(withdrawal.withdrawalId))
    .replace(/\{\{requestedOn\}\}/g, escapeHtml(formatDateTime(withdrawal.createdAt)))
    .replace(/\{\{payoutMethod\}\}/g, escapeHtml(`${withdrawal.wallet.name} (${withdrawal.wallet.network})`))
    .replace(/\{\{destinationSummary\}\}/g, escapeHtml(withdrawal.wallet.value))
    .replace(/\{\{estimatedProcessingTime\}\}/g, "Up to 24 hours")
    .replace(/\{\{availableBalance\}\}/g, escapeHtml(formatUsd(availableBalance)))
    .replace(/\{\{withdrawalRequestUrl\}\}/g, escapeHtml("https://shop.gameket.io/user/wallet"))
    .replace(/\{\{year\}\}/g, String(new Date().getFullYear()));
};

const renderStoreCodeSoldEmail = (
  seller: User,
  input: {
    storeName: string;
    orderId: string;
    productName: string;
    quantity: number;
    soldOn: string;
    buyerTag: string;
    grossAmount: number;
    platformFee: number;
    netEarnings: number;
    payoutTimeline: string;
  }
): string => {
  const template = readFileSync(join(process.cwd(), "src", "emails", "store-code-sold-email.html"), "utf-8");
  const firstName = seller.username.trim() || "there";

  return template
    .replace(/\{\{firstName\}\}/g, escapeHtml(firstName))
    .replace(/\{\{storeName\}\}/g, escapeHtml(input.storeName))
    .replace(/\{\{orderId\}\}/g, escapeHtml(input.orderId))
    .replace(/\{\{productName\}\}/g, escapeHtml(input.productName))
    .replace(/\{\{quantity\}\}/g, String(input.quantity))
    .replace(/\{\{soldOn\}\}/g, escapeHtml(formatDateTime(input.soldOn)))
    .replace(/\{\{buyerTag\}\}/g, escapeHtml(input.buyerTag))
    .replace(/\{\{grossAmount\}\}/g, escapeHtml(formatUsd(input.grossAmount)))
    .replace(/\{\{platformFee\}\}/g, escapeHtml(formatUsd(input.platformFee)))
    .replace(/\{\{netEarnings\}\}/g, escapeHtml(formatUsd(input.netEarnings)))
    .replace(/\{\{payoutTimeline\}\}/g, escapeHtml(input.payoutTimeline))
    .replace(/\{\{year\}\}/g, String(new Date().getFullYear()));
};

const renderOrderSummaryEmail = (
  buyerName: string,
  input: {
    orderId: string;
    orderDate: string;
    paymentMethod: string;
    orderStatus: string;
    productName: string;
    quantity: number;
    amount: number;
    fee: number;
    totalAmount: number;
  }
): string => {
  let template = readFileSync(join(process.cwd(), "src", "emails", "order-summary-email.html"), "utf-8");
  const firstName = buyerName.trim() || "there";

  const itemBlockRegex = /\{\{#each items\}\}([\s\S]*?)\{\{\/each\}\}/g;
  const itemBlockMatch = itemBlockRegex.exec(template);
  if (itemBlockMatch) {
    const itemBlock = itemBlockMatch[1];

    const renderedItem = itemBlock
      .replace(/\{\{name\}\}/g, escapeHtml(input.productName))
      .replace(/\{\{description\}\}/g, "Digital code order")
      .replace(/\{\{quantity\}\}/g, String(input.quantity))
      .replace(/\{\{price\}\}/g, escapeHtml(formatUsd(input.amount)));

    template = template.replace(itemBlockRegex, renderedItem);
  }

  return template
    .replace(/\{\{firstName\}\}/g, escapeHtml(firstName))
    .replace(/\{\{orderId\}\}/g, escapeHtml(input.orderId))
    .replace(/\{\{orderDate\}\}/g, escapeHtml(formatDateTime(input.orderDate)))
    .replace(/\{\{paymentMethod\}\}/g, escapeHtml(input.paymentMethod))
    .replace(/\{\{orderStatus\}\}/g, escapeHtml(input.orderStatus))
    .replace(/\{\{subtotal\}\}/g, escapeHtml(formatUsd(input.amount)))
    .replace(/\{\{processingFee\}\}/g, escapeHtml(formatUsd(input.fee)))
    .replace(/\{\{discount\}\}/g, escapeHtml(formatUsd(0)))
    .replace(/\{\{grandTotal\}\}/g, escapeHtml(formatUsd(input.totalAmount)))
    .replace(/\{\{year\}\}/g, String(new Date().getFullYear()));
};

const renderBuyerManualPendingOrderEmail = (
  buyerName: string,
  input: {
    orderId: string;
    storeName: string;
    placedOn: string;
    productName: string;
    quantity: number;
    orderAmount: number;
    expectedFulfillmentTime: string;
    buyerNote?: string | null;
  }
): string => {
  const template = readFileSync(join(process.cwd(), "src", "emails", "buyer-manual-pending-order-email.html"), "utf-8");
  const firstName = buyerName.trim() || "there";

  return template
    .replace(/\{\{firstName\}\}/g, escapeHtml(firstName))
    .replace(/\{\{orderId\}\}/g, escapeHtml(input.orderId))
    .replace(/\{\{storeName\}\}/g, escapeHtml(input.storeName))
    .replace(/\{\{placedOn\}\}/g, escapeHtml(formatDateTime(input.placedOn)))
    .replace(/\{\{productName\}\}/g, escapeHtml(input.productName))
    .replace(/\{\{quantity\}\}/g, String(input.quantity))
    .replace(/\{\{orderAmount\}\}/g, escapeHtml(formatUsd(input.orderAmount)))
    .replace(/\{\{expectedFulfillmentTime\}\}/g, escapeHtml(input.expectedFulfillmentTime))
    .replace(/\{\{buyerNote\}\}/g, escapeHtml((input.buyerNote || "").trim() || "No additional note provided."))
    .replace(/\{\{year\}\}/g, String(new Date().getFullYear()));
};

const renderStoreManualPendingOrderEmail = (
  sellerName: string,
  input: {
    storeName: string;
    orderId: string;
    productName: string;
    quantity: number;
    buyerTag: string;
    requestedOn: string;
    orderAmount: number;
    fulfillmentWindow: string;
  }
): string => {
  const template = readFileSync(join(process.cwd(), "src", "emails", "store-manual-pending-order-email.html"), "utf-8");
  const firstName = sellerName.trim() || "there";

  return template
    .replace(/\{\{firstName\}\}/g, escapeHtml(firstName))
    .replace(/\{\{storeName\}\}/g, escapeHtml(input.storeName))
    .replace(/\{\{orderId\}\}/g, escapeHtml(input.orderId))
    .replace(/\{\{productName\}\}/g, escapeHtml(input.productName))
    .replace(/\{\{quantity\}\}/g, String(input.quantity))
    .replace(/\{\{buyerTag\}\}/g, escapeHtml(input.buyerTag))
    .replace(/\{\{requestedOn\}\}/g, escapeHtml(formatDateTime(input.requestedOn)))
    .replace(/\{\{orderAmount\}\}/g, escapeHtml(formatUsd(input.orderAmount)))
    .replace(/\{\{fulfillmentWindow\}\}/g, escapeHtml(input.fulfillmentWindow))
    .replace(/\{\{year\}\}/g, String(new Date().getFullYear()));
};

const renderStoreManualFulfilledOrderEmail = (
  sellerName: string,
  input: {
    orderId: string;
    productName: string;
    quantity: number;
    buyerTag: string;
    fulfilledOn: string;
    orderAmount: number;
    netEarnings: number;
    payoutStatus: string;
    expectedPayoutDate: string;
  }
): string => {
  const template = readFileSync(join(process.cwd(), "src", "emails", "store-manual-order-fulfilled-email.html"), "utf-8");
  const firstName = sellerName.trim() || "there";

  return template
    .replace(/\{\{firstName\}\}/g, escapeHtml(firstName))
    .replace(/\{\{orderId\}\}/g, escapeHtml(input.orderId))
    .replace(/\{\{productName\}\}/g, escapeHtml(input.productName))
    .replace(/\{\{quantity\}\}/g, String(input.quantity))
    .replace(/\{\{buyerTag\}\}/g, escapeHtml(input.buyerTag))
    .replace(/\{\{fulfilledOn\}\}/g, escapeHtml(formatDateTime(input.fulfilledOn)))
    .replace(/\{\{orderAmount\}\}/g, escapeHtml(formatUsd(input.orderAmount)))
    .replace(/\{\{netEarnings\}\}/g, escapeHtml(formatUsd(input.netEarnings)))
    .replace(/\{\{payoutStatus\}\}/g, escapeHtml(input.payoutStatus))
    .replace(/\{\{expectedPayoutDate\}\}/g, escapeHtml(input.expectedPayoutDate))
    .replace(/\{\{year\}\}/g, String(new Date().getFullYear()));
};

const renderBuyerManualFulfilledOrderEmail = (
  buyerName: string,
  input: {
    orderId: string;
    fulfilledOn: string;
    storeName: string;
    productName: string;
    quantity: number;
    orderAmount: number;
    paymentMethod: string;
    codes: string[];
    fulfillmentNote?: string | null;
  }
): string => {
  let template = readFileSync(join(process.cwd(), "src", "emails", "buyer-manual-order-fulfilled-email.html"), "utf-8");
  const firstName = buyerName.trim() || "there";
  const cleanCodes = input.codes.map((code) => code.trim()).filter((code) => code.length > 0);

  template = template.replace(/\{\{#if purchasedCodes\}\}([\s\S]*?)\{\{\/if\}\}/g, (_full, block: string) => {
    if (cleanCodes.length <= 1) return "";
    return block.replace(/\{\{#each purchasedCodes\}\}([\s\S]*?)\{\{\/each\}\}/g, (_eachFull, eachBlock: string) => {
      return cleanCodes.map((code) => eachBlock.replace(/\{\{this\}\}/g, escapeHtml(code))).join("");
    });
  });

  template = template.replace(/\{\{#if purchasedCode\}\}([\s\S]*?)\{\{\/if\}\}/g, (_full, block: string) => {
    if (cleanCodes.length !== 1) return "";
    return block.replace(/\{\{purchasedCode\}\}/g, escapeHtml(cleanCodes[0]));
  });

  template = renderIfBlock(template, "fulfillmentNote", Boolean((input.fulfillmentNote || "").trim()));

  return template
    .replace(/\{\{firstName\}\}/g, escapeHtml(firstName))
    .replace(/\{\{orderId\}\}/g, escapeHtml(input.orderId))
    .replace(/\{\{fulfilledOn\}\}/g, escapeHtml(formatDateTime(input.fulfilledOn)))
    .replace(/\{\{storeName\}\}/g, escapeHtml(input.storeName))
    .replace(/\{\{productName\}\}/g, escapeHtml(input.productName))
    .replace(/\{\{quantity\}\}/g, String(input.quantity))
    .replace(/\{\{orderAmount\}\}/g, escapeHtml(formatUsd(input.orderAmount)))
    .replace(/\{\{paymentMethod\}\}/g, escapeHtml(input.paymentMethod))
    .replace(/\{\{fulfillmentNote\}\}/g, escapeHtml((input.fulfillmentNote || "").trim()))
    .replace(/\{\{year\}\}/g, String(new Date().getFullYear()));
};

const renderIfBlock = (template: string, key: string, include: boolean): string => {
  const blockRegex = new RegExp(`\\{\\{#if\\s+${key}\\}\\}([\\s\\S]*?)\\{\\{\\/if\\}\\}`, "g");
  return template.replace(blockRegex, include ? "$1" : "");
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

  const tasks = recipients.map((recipient) => {
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
  });

  await Promise.allSettled(tasks);
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

function mapManualOrderConfig(config: Product["manualOrderConfig"]) {
  if (!config) return null;
  return {
    isadditional: Boolean(config.isadditional),
    characterCount: config.characterCount ?? null,
    orderDescription: config.orderDescription ?? null,
    workingDays: (config.workingDays || []).map((entry) => ({
      day: entry.day,
      openTime: entry.openTime,
      closeTime: entry.closeTime,
    })),
  };
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
    case "MerchantUpgrade":
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

const DEFAULT_NOTIFICATION_SEEN_AT = "1970-01-01T00:00:00.000Z";

function getDefaultNotificationState(userId: string): NotificationState {
  return {
    userId,
    ordersSeenAt: DEFAULT_NOTIFICATION_SEEN_AT,
    transactionsSeenAt: DEFAULT_NOTIFICATION_SEEN_AT,
    conflictSeenAt: DEFAULT_NOTIFICATION_SEEN_AT,
    updatedAt: DEFAULT_NOTIFICATION_SEEN_AT,
  };
}

async function buildUserNotificationSummary(
  walletsDB: ReturnType<typeof getWalletsDB>,
  userId: string,
  state: NotificationState
) {
  const ordersSeenAt = state.ordersSeenAt || DEFAULT_NOTIFICATION_SEEN_AT;
  const transactionsSeenAt = state.transactionsSeenAt || DEFAULT_NOTIFICATION_SEEN_AT;
  const conflictSeenAt = state.conflictSeenAt || DEFAULT_NOTIFICATION_SEEN_AT;
  const globalConflictSeenMs = (() => {
    const ms = new Date(conflictSeenAt).getTime();
    return Number.isFinite(ms) ? ms : 0;
  })();

  const newOrdersCount = await walletsDB.collection<Order>("Orders").countDocuments({
    $and: [
      { $or: [{ buyerId: userId }, { sellerId: userId }] },
      { $or: [
        { createdAt: { $gt: ordersSeenAt } },
        { statusUpdatedAt: { $gt: ordersSeenAt } },
      ]},
    ],
  });

  const newTransactionsCount = await walletsDB.collection<Transaction>("Transactions").countDocuments({
    userId,
    createdAt: { $gt: transactionsSeenAt },
  });

  const disputes = await walletsDB.collection<Dispute>("Disputes").find({
    $or: [{ buyerId: userId }, { sellerId: userId }],
    "messages.0": { $exists: true },
  }).toArray();

  const disputeIds = disputes.map((dispute) => dispute.disputeId);
  const conflictReads = disputeIds.length
    ? await walletsDB.collection<NotificationConflictRead>("NotificationConflictReads").find({
        userId,
        disputeId: { $in: disputeIds },
      }).toArray()
    : [];
  const conflictReadMap = new Map(conflictReads.map((item) => [item.disputeId, item.seenAt || DEFAULT_NOTIFICATION_SEEN_AT]));

  const conflictNotifications = disputes
    .map((dispute) => {
      const messages = dispute.messages || [];
      const disputeSeenAt = conflictReadMap.get(dispute.disputeId) || DEFAULT_NOTIFICATION_SEEN_AT;
      const disputeSeenMs = (() => {
        const ms = new Date(disputeSeenAt).getTime();
        return Number.isFinite(ms) ? ms : 0;
      })();
      const effectiveConflictSeenMs = Math.max(globalConflictSeenMs, disputeSeenMs);
      let unreadMessagesCount = 0;

      for (const message of messages) {
        if (message.senderId === userId) continue;
        const sentAtMs = new Date(message.sentAt).getTime();
        if (!Number.isFinite(sentAtMs)) continue;
        if (sentAtMs > effectiveConflictSeenMs) {
          unreadMessagesCount += 1;
        }
      }

      const lastMessageNode = messages[messages.length - 1] || null;
      const lastMessage = lastMessageNode?.message || null;
      const lastMessageAt = lastMessageNode?.sentAt || null;

      const icon = unreadMessagesCount > 0
        ? "NEW_MESSAGE"
        : dispute.status === "resolved"
          ? "RESOLVED"
          : dispute.status === "closed"
            ? "CLOSED"
            : "IN_PROGRESS";

      return {
        disputeId: dispute.disputeId,
        orderId: dispute.orderId,
        status: dispute.status,
        unreadMessagesCount,
        lastMessage,
        lastMessageAt,
        icon,
      };
    })
    .filter((conflict) => conflict.unreadMessagesCount > 0)
    .sort((a, b) => {
      if (b.unreadMessagesCount !== a.unreadMessagesCount) {
        return b.unreadMessagesCount - a.unreadMessagesCount;
      }

      const aTime = a.lastMessageAt || "";
      const bTime = b.lastMessageAt || "";
      return bTime.localeCompare(aTime);
    });

  const newConflictMessagesCount = conflictNotifications.reduce(
    (sum, conflict) => sum + conflict.unreadMessagesCount,
    0
  );

  const totalUnreadCount = newOrdersCount + newTransactionsCount + newConflictMessagesCount;

  return {
    badgeCount: totalUnreadCount > 0 ? 1 : 0,
    hasUnread: totalUnreadCount > 0,
    totalUnreadCount,
    newOrdersCount,
    newTransactionsCount,
    newConflictMessagesCount,
    conflictNotifications,
    ordersSeenAt,
    transactionsSeenAt,
    conflictSeenAt,
  };
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

  getUserNotificationSummary: async (_: unknown, __: unknown, context: Context) => {
    if (!context.user) {
      throw new GraphQLError(context.authError || "Authentication required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const { userId } = context.user;
    const walletsDB = getWalletsDB();

    const state = await walletsDB.collection<NotificationState>("NotificationStates").findOne({ userId })
      || getDefaultNotificationState(userId);

    const summary = await buildUserNotificationSummary(walletsDB, userId, state);

    return {
      code: 200,
      success: true,
      message: "Notification summary retrieved successfully",
      summary,
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
            manualOrderConfig: mapManualOrderConfig(product.manualOrderConfig),
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
          manualOrderConfig: mapManualOrderConfig(product.manualOrderConfig),
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
        codes: order.codes.map(decryptCodeOrPlain),
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
            manualOrderConfig: mapManualOrderConfig(product.manualOrderConfig),
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
          codes: order.codes.map(decryptCodeOrPlain),
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
          datainput: order.datainput ?? null,
          fulfilledAt: order.fulfilledAt ?? null,
          fulfilledBy: order.fulfilledBy ?? null,
          fulfilmentNote: order.fulfilmentNote ?? null,
          declinedAt: order.declinedAt ?? null,
          declineReason: order.declineReason ?? null,
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
            manualOrderConfig: mapManualOrderConfig(product.manualOrderConfig),
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
          codes: order.codes.map(decryptCodeOrPlain),
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
          datainput: order.datainput ?? null,
          fulfilledAt: order.fulfilledAt ?? null,
          fulfilledBy: order.fulfilledBy ?? null,
          fulfilmentNote: order.fulfilmentNote ?? null,
          declinedAt: order.declinedAt ?? null,
          declineReason: order.declineReason ?? null,
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
      .filter((order) => order.sellerId === userId && !order.isReleased && (order.status === "completed" || order.status === "pending"))
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
              manualOrderConfig: mapManualOrderConfig(product.manualOrderConfig),
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
  markConflictNotificationAsSeen: async (
    _: unknown,
    { disputeId }: { disputeId: string },
    context: Context
  ) => {
    if (!context.user) {
      throw new GraphQLError(context.authError || "Authentication required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const { userId } = context.user;
    const walletsDB = getWalletsDB();

    const dispute = await walletsDB.collection<Dispute>("Disputes").findOne({
      disputeId,
      $or: [{ buyerId: userId }, { sellerId: userId }],
    });

    if (!dispute) {
      return {
        code: 404,
        success: false,
        message: "Conflict not found",
        summary: {
          badgeCount: 0,
          hasUnread: false,
          totalUnreadCount: 0,
          newOrdersCount: 0,
          newTransactionsCount: 0,
          newConflictMessagesCount: 0,
          conflictNotifications: [],
          ordersSeenAt: DEFAULT_NOTIFICATION_SEEN_AT,
          transactionsSeenAt: DEFAULT_NOTIFICATION_SEEN_AT,
          conflictSeenAt: DEFAULT_NOTIFICATION_SEEN_AT,
        },
      };
    }

    const nowMs = Date.now();
    const latestIncomingMessageMs = (() => {
      let latest = 0;
      for (const message of dispute.messages || []) {
        if (message.senderId === userId) continue;
        const sentAtMs = new Date(message.sentAt).getTime();
        if (Number.isFinite(sentAtMs) && sentAtMs > latest) {
          latest = sentAtMs;
        }
      }
      return latest;
    })();

    // Use the newest incoming message timestamp so this conflict reliably clears.
    const seenAt = new Date(Math.max(nowMs, latestIncomingMessageMs)).toISOString();
    await walletsDB.collection<NotificationConflictRead>("NotificationConflictReads").updateOne(
      { userId, disputeId },
      {
        $set: {
          seenAt,
          updatedAt: seenAt,
        },
        $setOnInsert: {
          userId,
          disputeId,
        },
      },
      { upsert: true }
    );

    const state = await walletsDB.collection<NotificationState>("NotificationStates").findOne({ userId })
      || getDefaultNotificationState(userId);

    const summary = await buildUserNotificationSummary(walletsDB, userId, state);

    return {
      code: 200,
      success: true,
      message: "Conflict notification marked as seen",
      summary,
    };
  },

  markNotificationAsSeen: async (
    _: unknown,
    { section }: { section?: "all" | "orders" | "transactions" | "conflicts" },
    context: Context
  ) => {
    if (!context.user) {
      throw new GraphQLError(context.authError || "Authentication required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const { userId } = context.user;
    const walletsDB = getWalletsDB();
    const now = new Date().toISOString();
    const target = section || "all";

    const setFields: Partial<NotificationState> = { updatedAt: now };

    if (target === "all" || target === "orders") {
      setFields.ordersSeenAt = now;
    }
    if (target === "all" || target === "transactions") {
      setFields.transactionsSeenAt = now;
    }
    if (target === "all" || target === "conflicts") {
      setFields.conflictSeenAt = now;
    }

    // Avoid Mongo path conflicts: a field cannot appear in both $set and $setOnInsert.
    const setOnInsertFields: Partial<NotificationState> = { userId };
    if (setFields.ordersSeenAt == null) {
      setOnInsertFields.ordersSeenAt = DEFAULT_NOTIFICATION_SEEN_AT;
    }
    if (setFields.transactionsSeenAt == null) {
      setOnInsertFields.transactionsSeenAt = DEFAULT_NOTIFICATION_SEEN_AT;
    }
    if (setFields.conflictSeenAt == null) {
      setOnInsertFields.conflictSeenAt = DEFAULT_NOTIFICATION_SEEN_AT;
    }

    await walletsDB.collection<NotificationState>("NotificationStates").updateOne(
      { userId },
      {
        $set: setFields,
        $setOnInsert: setOnInsertFields,
      },
      { upsert: true }
    );

    const state = await walletsDB.collection<NotificationState>("NotificationStates").findOne({ userId })
      || getDefaultNotificationState(userId);

    const summary = await buildUserNotificationSummary(walletsDB, userId, state);

    return {
      code: 200,
      success: true,
      message: "Notification marker updated successfully",
      summary,
    };
  },

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
      const res = await fetch("https://api.argonpay.app/create-payment", {
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

    const requestId = context.requestId;
    const actorId = context.user.userId;
    const actorType = context.user.role === "admin" ? "admin" : "user";

    const logWithdrawalRequest = async (
      outcome: "success" | "failure",
      reason: string,
      metadata: Record<string, unknown> = {}
    ) => {
      await recordAuditEvent({
        eventName: "WITHDRAWAL_REQUESTED",
        category: "withdrawal",
        outcome,
        actorType,
        actorId,
        requestId,
        targetType: "user",
        targetId: context.user?.userId || null,
        metadata: {
          reason,
          amount,
          ...metadata,
        },
      });
    };

    if (context.user.role === "admin") {
      await logWithdrawalRequest("failure", "ADMIN_TOKEN_NOT_ALLOWED");
      return { code: 403, success: false, message: "Admin token is not allowed for user withdrawals", withdrawal: null };
    }

    if (context.user.isSuspended) {
      await logWithdrawalRequest("failure", "USER_SUSPENDED");
      return { code: 403, success: false, message: "Your account is suspended. You cannot make withdrawals.", withdrawal: null };
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      await logWithdrawalRequest("failure", "INVALID_AMOUNT");
      return { code: 400, success: false, message: "Amount must be greater than 0", withdrawal: null };
    }

    const withdrawalAmount = parseFloat(amount.toFixed(2));
    const serviceFee = parseFloat((withdrawalAmount * 0.01).toFixed(2));
    const networkFee = 0.5;
    const totalFee = parseFloat((serviceFee + networkFee).toFixed(2));
    const payoutAmount = parseFloat((withdrawalAmount - totalFee).toFixed(2));

    if (payoutAmount <= 0) {
      await logWithdrawalRequest("failure", "AMOUNT_TOO_LOW_AFTER_FEES", {
        payoutAmount,
      });
      return { code: 400, success: false, message: "Amount is too low after fees", withdrawal: null };
    }

    const { userId } = context.user;
    const db = getDB();
    const walletsDB = getWalletsDB();

    const user = await db.collection<User>("users").findOne({ id: userId });
    if (!user) {
      await logWithdrawalRequest("failure", "USER_NOT_FOUND");
      return { code: 404, success: false, message: "User not found", withdrawal: null };
    }

    const balances = walletsDB.collection<Balance>("Balances");
    const balance = await balances.findOne({ userId });
    if (!balance) {
      await logWithdrawalRequest("failure", "WALLET_NOT_FOUND");
      return { code: 404, success: false, message: "Wallet not found", user, withdrawal: null };
    }

    const activeMethod = balance.methods.find((method) => method.isActive);
    if (!activeMethod) {
      await logWithdrawalRequest("failure", "NO_ACTIVE_PAYOUT_METHOD");
      return { code: 400, success: false, message: "Add an active wallet option before making a withdrawal", user, withdrawal: null };
    }

    if (balance.availableBalance < withdrawalAmount) {
      await logWithdrawalRequest("failure", "INSUFFICIENT_BALANCE", {
        availableBalance: balance.availableBalance,
      });
      return { code: 400, success: false, message: "Insufficient balance", user, withdrawal: null };
    }

    const balanceUpdate = await balances.updateOne(
      { userId, availableBalance: { $gte: withdrawalAmount } },
      { $inc: { availableBalance: -withdrawalAmount, suspendedBalance: withdrawalAmount } }
    );

    if (balanceUpdate.modifiedCount === 0) {
      await logWithdrawalRequest("failure", "BALANCE_RESERVATION_FAILED");
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

    await logWithdrawalRequest("success", "WITHDRAWAL_CREATED", {
      withdrawalId,
      transactionId,
      payoutAmount,
      totalFee,
    });

    if (shouldSendEmailForUser(user)) {
      try {
        const html = renderWithdrawalRequestEmail(
          user,
          withdrawalRecord,
          parseFloat((balance.availableBalance - withdrawalAmount).toFixed(2))
        );

        await smtpTransporter.sendMail({
          from: `GAMEKET <${process.env.SMTP_EMAIL}>`,
          to: user.email,
          subject: "Withdrawal Request Received",
          html,
        });
      } catch (error) {
        console.error("Failed to send withdrawal request email:", error);
      }
    }

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

    if (product.type === "Manual") {
      return {
        code: 400,
        success: false,
        message: "This is a manual product. Use buyCodesManualbyUser for manual orders",
        order: null,
        transaction: null,
      };
    }

    const isApiFulfillment = isApiFulfillmentProduct(product);
    if (isApiFulfillment && !resolveApiCallbackUrl(product)) {
      return {
        code: 400,
        success: false,
        message: "This API product is missing a valid callback URL",
        order: null,
        transaction: null,
      };
    }

    if (isApiFulfillment && quantity > 10) {
      return {
        code: 400,
        success: false,
        message: "API products allow a maximum quantity of 10 per purchase",
        order: null,
        transaction: null,
      };
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

    const availableStock = isApiFulfillment ? product.available : product.availableCodes.length;
    if (availableStock < quantity) {
      return { code: 400, success: false, message: `Only ${availableStock} slot(s) available`, order: null, transaction: null };
    }

    const amount = parseFloat((product.price * quantity).toFixed(2));
    const fee = parseFloat(Math.max(amount * 0.005, 0.1).toFixed(2));
    const totalAmount = parseFloat((amount + fee).toFixed(2));

    // Check buyer balance
    const buyerBalance = await walletsDB.collection<Balance>("Balances").findOne({ userId });
    if (!buyerBalance || buyerBalance.availableBalance < totalAmount) {
      return { code: 400, success: false, message: "Insufficient balance", order: null, transaction: null };
    }

    const purchasedCodes = isApiFulfillment ? [] : product.availableCodes.slice(0, quantity);
    const remainingCodes = isApiFulfillment ? product.availableCodes : product.availableCodes.slice(quantity);

    // Debit buyer (total including fee)
    await walletsDB.collection<Balance>("Balances").updateOne(
      { userId },
      { $inc: { availableBalance: -totalAmount } }
    );

    // Do not credit seller balance for API-pending orders.
    if (!isApiFulfillment) {
      await walletsDB.collection<Balance>("Balances").updateOne(
        { userId: product.userId },
        { $inc: { suspendedBalance: amount } }
      );
    }

    if (isApiFulfillment) {
      await catalogsDB.collection<Product>("Products").updateOne(
        { productId },
        {
          $inc: { sold: quantity },
          $set: { isActive: true },
        }
      );
    } else {
      // Update product: move codes from available to sold, update counts
      await catalogsDB.collection<Product>("Products").updateOne(
        { productId },
        {
          $set: { availableCodes: remainingCodes },
          $push: { soldCodes: { $each: purchasedCodes } },
          $inc: { available: -quantity, sold: quantity },
        }
      );
    }

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
      status: isApiFulfillment ? "billed" : "completed",
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
      status: isApiFulfillment ? "billed" : "pending",
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
      status: isApiFulfillment ? "pending" : "completed",
      type: "userpurchase",
      isReviewed: false,
      reviewType: null,
      isReleased: false,
      disputeReason: null,
      createdAt: now,
      releasedAt,
    };

    await walletsDB.collection<Order>("Orders").insertOne(order);

    if (isApiFulfillment) {
      const callbackResult = await dispatchApiOrderCallback(product, store, {
        orderId,
        productId: product.productId,
        storeId: store.storeId,
        quantity,
        amount,
        fee,
        totalAmount,
        datainput: null,
        requestedAt: now,
        source: "user",
      });

      if (!callbackResult.success) {
        console.error(`API fulfillment callback failed for order ${orderId}:`, callbackResult.error || callbackResult.status);
      }
    }

    const seller = await db.collection<User>("users").findOne({ id: product.userId });

    try {
      const mailTasks: Array<Promise<unknown>> = [];

      if (seller && shouldSendEmailForUser(seller)) {
        if (isApiFulfillment) {
          const sellerHtml = renderStoreManualPendingOrderEmail(seller.username, {
            storeName: updatedStore?.storeName || store?.storeName || "Your Store",
            orderId,
            productName: product.name,
            quantity,
            buyerTag: user.username,
            requestedOn: now,
            orderAmount: totalAmount,
            fulfillmentWindow: "24 hours",
          });

          mailTasks.push(
            smtpTransporter.sendMail({
              from: `GAMEKET <${process.env.SMTP_EMAIL}>`,
              to: seller.email,
              subject: "New API Order Pending",
              html: sellerHtml,
            })
          );
        } else {
          const sellerHtml = renderStoreCodeSoldEmail(seller, {
            storeName: updatedStore?.storeName || store?.storeName || "Your Store",
            orderId,
            productName: product.name,
            quantity,
            soldOn: now,
            buyerTag: user.username,
            grossAmount: amount,
            platformFee: fee,
            netEarnings: amount,
            payoutTimeline: "Funds release in up to 24 hours",
          });

          mailTasks.push(
            smtpTransporter.sendMail({
              from: `GAMEKET <${process.env.SMTP_EMAIL}>`,
              to: seller.email,
              subject: "Code Sold - New Store Order",
              html: sellerHtml,
            })
          );
        }
      }

      if (shouldSendEmailForUser(user)) {
        if (isApiFulfillment) {
          const buyerHtml = renderBuyerManualPendingOrderEmail(user.username, {
            orderId,
            storeName: updatedStore?.storeName || store?.storeName || "Store",
            placedOn: now,
            productName: product.name,
            quantity,
            orderAmount: totalAmount,
            expectedFulfillmentTime: "Within 24 hours",
          });

          mailTasks.push(
            smtpTransporter.sendMail({
              from: `GAMEKET <${process.env.SMTP_EMAIL}>`,
              to: user.email,
              subject: "Order Pending Fulfillment",
              html: buyerHtml,
            })
          );
        } else {
          const buyerHtml = renderOrderSummaryEmail(user.username, {
            orderId,
            orderDate: now,
            paymentMethod: "Wallet Balance",
            orderStatus: "Completed",
            productName: product.name,
            quantity,
            amount,
            fee,
            totalAmount,
          });

          mailTasks.push(
            smtpTransporter.sendMail({
              from: `GAMEKET <${process.env.SMTP_EMAIL}>`,
              to: user.email,
              subject: "Your Order Summary",
              html: buyerHtml,
            })
          );
        }
      }

      await Promise.allSettled(mailTasks);
    } catch (error) {
      console.error("Failed to send order notification emails:", error);
    }

    return {
      code: 200,
      success: true,
      message: isApiFulfillment ? "Order sent for API fulfillment" : "Purchase successful",
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
          available: isApiFulfillment ? product.available : product.available - quantity,
          sold: product.sold + quantity,
          type: product.type,
          manualOrderConfig: mapManualOrderConfig(product.manualOrderConfig),
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
        codes: order.codes.map(decryptCodeOrPlain),
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
        datainput: order.datainput ?? null,
        fulfilledAt: order.fulfilledAt ?? null,
        fulfilledBy: order.fulfilledBy ?? null,
        fulfilmentNote: order.fulfilmentNote ?? null,
        declinedAt: order.declinedAt ?? null,
        declineReason: order.declineReason ?? null,
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

  buyCodesManualbyUser: async (
    _: unknown,
    { productId, quantity, datainput }: { productId: string; quantity: number; datainput?: string },
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

    const cleanDataInput = typeof datainput === "string" ? datainput.trim() : "";
    if (cleanDataInput.length > 2000) {
      return { code: 400, success: false, message: "datainput must be at most 2000 characters", order: null, transaction: null };
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

    if (product.type !== "Manual") {
      return { code: 400, success: false, message: "This mutation only supports Manual products", order: null, transaction: null };
    }

    const isApiFulfillment = isApiFulfillmentProduct(product);
    if (isApiFulfillment && !resolveApiCallbackUrl(product)) {
      return {
        code: 400,
        success: false,
        message: "This API product is missing a valid callback URL",
        order: null,
        transaction: null,
      };
    }

    if (isApiFulfillment && quantity > 10) {
      return {
        code: 400,
        success: false,
        message: "API products allow a maximum quantity of 10 per purchase",
        order: null,
        transaction: null,
      };
    }

    if (!product.isActive) {
      return { code: 400, success: false, message: "Product is not available", order: null, transaction: null };
    }

    const store = await catalogsDB.collection<Store>("Stores").findOne({ storeId: product.storeId });
    if (!store || !store.isActive) {
      return { code: 400, success: false, message: "This store is currently unavailable", order: null, transaction: null };
    }

    if (!store.isApproved) {
      return { code: 400, success: false, message: "This store is not approved", order: null, transaction: null };
    }

    if (product.userId === userId) {
      return { code: 403, success: false, message: "You cannot purchase your own product", order: null, transaction: null };
    }

    const isBlacklisted = await catalogsDB.collection<Blacklist>("Blacklists").findOne({ storeId: product.storeId, userId });
    if (isBlacklisted) {
      return { code: 403, success: false, message: "You are blocked from purchasing from this store", order: null, transaction: null };
    }

    if (product.available < quantity) {
      return { code: 400, success: false, message: `Only ${product.available} slot(s) available`, order: null, transaction: null };
    }

    const amount = parseFloat((product.price * quantity).toFixed(2));
    const fee = parseFloat(Math.max(amount * 0.005, 0.1).toFixed(2));
    const totalAmount = parseFloat((amount + fee).toFixed(2));

    const buyerBalance = await walletsDB.collection<Balance>("Balances").findOne({ userId });
    if (!buyerBalance || buyerBalance.availableBalance < totalAmount) {
      return { code: 400, success: false, message: "Insufficient balance", order: null, transaction: null };
    }

    await walletsDB.collection<Balance>("Balances").updateOne(
      { userId },
      { $inc: { availableBalance: -totalAmount } }
    );

    if (!isApiFulfillment) {
      await walletsDB.collection<Balance>("Balances").updateOne(
        { userId: product.userId },
        { $inc: { suspendedBalance: amount } }
      );
    }

    if (isApiFulfillment) {
      await catalogsDB.collection<Product>("Products").updateOne(
        { productId },
        {
          $inc: { sold: quantity },
          $set: { isActive: true },
        }
      );
    } else {
      await catalogsDB.collection<Product>("Products").updateOne(
        { productId },
        {
          $inc: { available: -quantity, sold: quantity },
          $set: { isActive: (product.available - quantity) > 0 },
        }
      );
    }

    const updatedStore = await catalogsDB.collection<Store>("Stores").findOneAndUpdate(
      { storeId: product.storeId },
      { $inc: { totalSales: quantity } },
      { returnDocument: "after" }
    );

    if (updatedStore) {
      const newRank = getRankFromSales(updatedStore.totalSales);
      await db.collection<User>("users").updateOne(
        { id: product.userId },
        { $set: { rank: newRank } }
      );
    }

    const now = new Date().toISOString();
    const releasedAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const transactionId = randomBytes(24).toString("base64").replace(/[+/=]/g, "");

    const transaction: Transaction = {
      userId,
      id: transactionId,
      type: "ProductPurchase",
      status: "billed",
      method: "balance",
      amount: totalAmount,
      createdAt: now,
    };

    await walletsDB.collection<Transaction>("Transactions").insertOne(transaction);

    const sellerTransactionId = randomBytes(24).toString("base64").replace(/[+/=]/g, "");

    const sellerTransaction: Transaction = {
      userId: product.userId,
      id: sellerTransactionId,
      type: "SoldCodes",
      status: "billed",
      method: "balance",
      amount,
      createdAt: now,
    };

    await walletsDB.collection<Transaction>("Transactions").insertOne(sellerTransaction);

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
      codes: [],
      quantity,
      amount,
      fee,
      totalAmount,
      status: isApiFulfillment ? "pending" : "billed",
      type: "userpurchase",
      isReviewed: false,
      reviewType: null,
      isReleased: false,
      disputeReason: null,
      datainput: cleanDataInput.length ? cleanDataInput : null,
      createdAt: now,
      releasedAt,
    };

    await walletsDB.collection<Order>("Orders").insertOne(order);

    if (isApiFulfillment) {
      const callbackResult = await dispatchApiOrderCallback(product, store, {
        orderId,
        productId: product.productId,
        storeId: store.storeId,
        quantity,
        amount,
        fee,
        totalAmount,
        datainput: cleanDataInput.length ? cleanDataInput : null,
        requestedAt: now,
        source: "user",
      });

      if (!callbackResult.success) {
        console.error(`API fulfillment callback failed for order ${orderId}:`, callbackResult.error || callbackResult.status);
      }
    }

    const seller = await db.collection<User>("users").findOne({ id: product.userId });

    try {
      const mailTasks: Array<Promise<unknown>> = [];

      if (shouldSendEmailForUser(user)) {
        const buyerHtml = renderBuyerManualPendingOrderEmail(user.username, {
          orderId,
          storeName: updatedStore?.storeName || store?.storeName || "Store",
          placedOn: now,
          productName: product.name,
          quantity,
          orderAmount: totalAmount,
          expectedFulfillmentTime: "Within 24 hours",
          buyerNote: cleanDataInput,
        });

        mailTasks.push(
          smtpTransporter.sendMail({
            from: `GAMEKET <${process.env.SMTP_EMAIL}>`,
            to: user.email,
            subject: "Manual Order Pending",
            html: buyerHtml,
          })
        );
      }

      if (seller && shouldSendEmailForUser(seller)) {
        const sellerHtml = renderStoreManualPendingOrderEmail(seller.username, {
          storeName: updatedStore?.storeName || store?.storeName || "Your Store",
          orderId,
          productName: product.name,
          quantity,
          buyerTag: user.username,
          requestedOn: now,
          orderAmount: totalAmount,
          fulfillmentWindow: "24 hours",
        });

        mailTasks.push(
          smtpTransporter.sendMail({
            from: `GAMEKET <${process.env.SMTP_EMAIL}>`,
            to: seller.email,
            subject: "New Manual Order Pending",
            html: sellerHtml,
          })
        );
      }

      await Promise.allSettled(mailTasks);
    } catch (error) {
      console.error("Failed to send manual pending order notification emails:", error);
    }

    return {
      code: 200,
      success: true,
      message: isApiFulfillment ? "Manual API order sent for fulfillment" : "Manual order purchase successful",
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
          available: isApiFulfillment ? product.available : product.available - quantity,
          sold: product.sold + quantity,
          type: product.type,
          manualOrderConfig: mapManualOrderConfig(product.manualOrderConfig),
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
        datainput: order.datainput ?? null,
        fulfilledAt: order.fulfilledAt ?? null,
        fulfilledBy: order.fulfilledBy ?? null,
        fulfilmentNote: order.fulfilmentNote ?? null,
        declinedAt: order.declinedAt ?? null,
        declineReason: order.declineReason ?? null,
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

    if (product.type === "Manual") {
      return {
        code: 400,
        success: false,
        message: "This product is Manual. Use buyCodesManualbyAnon instead",
        ...errorResponse,
      };
    }

    const isApiFulfillment = isApiFulfillmentProduct(product);
    if (isApiFulfillment && !resolveApiCallbackUrl(product)) {
      return { code: 400, success: false, message: "This API product is missing a valid callback URL", ...errorResponse };
    }

    const maxQuantity = isApiFulfillment ? 10 : 2;
    if (quantity > maxQuantity) {
      return {
        code: 400,
        success: false,
        message: `Maximum quantity is ${maxQuantity}`,
        ...errorResponse,
      };
    }

    const store = await catalogsDB.collection<Store>("Stores").findOne({ storeId: product.storeId });
    if (!store || !store.isActive) {
      return { code: 400, success: false, message: "This store is currently unavailable", ...errorResponse };
    }

    if (!store.isApproved) {
      return { code: 400, success: false, message: "This store is not approved", ...errorResponse };
    }

    const availableStock = isApiFulfillment ? product.available : product.availableCodes.length;
    if (availableStock < quantity) {
      return { code: 400, success: false, message: `Only ${availableStock} slot(s) available`, ...errorResponse };
    }

    const amount = parseFloat((product.price * quantity).toFixed(2));
    const networkFee = parseFloat(Math.max(amount * 0.002, 0.1).toFixed(2));
    const serviceFee = parseFloat(Math.max(amount * 0.005, 0.1).toFixed(2));
    const fee = parseFloat((serviceFee + networkFee).toFixed(2));
    const totalAmount = parseFloat((amount + fee).toFixed(2));

    const apiKey = process.env.GAMEKET_PAY_API_KEY;
    if (!apiKey) {
      throw new Error("Server configuration error");
    }

    let paymentResponse;
    try {
      const res = await fetch("https://api.argonpay.app/create-payment", {
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
          manualOrderConfig: mapManualOrderConfig(product.manualOrderConfig),
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

  buyCodesManualbyAnon: async (
    _: unknown,
    { productId, quantity, email, datainput }: { productId: string; quantity: number; email: string; datainput?: string }
  ) => {
    const errorResponse = { order: null, deposit: null, payId: null, paymentLink: null };

    if (!Number.isInteger(quantity) || quantity <= 0) {
      return { code: 400, success: false, message: "Quantity must be a positive integer", ...errorResponse };
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return { code: 400, success: false, message: "Invalid email address", ...errorResponse };
    }

    const cleanDataInput = typeof datainput === "string" ? datainput.trim() : "";
    if (cleanDataInput.length > 2000) {
      return { code: 400, success: false, message: "datainput must be at most 2000 characters", ...errorResponse };
    }

    const walletsDB = getWalletsDB();
    const catalogsDB = getCatalogsDB();

    const product = await catalogsDB.collection<Product>("Products").findOne({ productId });
    if (!product) {
      return { code: 404, success: false, message: "Product not found", ...errorResponse };
    }

    if (product.type !== "Manual") {
      return {
        code: 400,
        success: false,
        message: "This mutation only supports Manual products",
        ...errorResponse,
      };
    }

    const isApiFulfillment = isApiFulfillmentProduct(product);
    if (isApiFulfillment && !resolveApiCallbackUrl(product)) {
      return { code: 400, success: false, message: "This API product is missing a valid callback URL", ...errorResponse };
    }

    const maxQuantity = isApiFulfillment ? 10 : 2;
    if (quantity > maxQuantity) {
      return {
        code: 400,
        success: false,
        message: `Maximum quantity is ${maxQuantity}`,
        ...errorResponse,
      };
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

    if (product.available < quantity) {
      return { code: 400, success: false, message: `Only ${product.available} slot(s) available`, ...errorResponse };
    }

    const amount = parseFloat((product.price * quantity).toFixed(2));
    const networkFee = parseFloat(Math.max(amount * 0.002, 0.1).toFixed(2));
    const serviceFee = parseFloat(Math.max(amount * 0.005, 0.1).toFixed(2));
    const fee = parseFloat((serviceFee + networkFee).toFixed(2));
    const totalAmount = parseFloat((amount + fee).toFixed(2));

    const apiKey = process.env.GAMEKET_PAY_API_KEY;
    if (!apiKey) {
      throw new Error("Server configuration error");
    }

    let paymentResponse;
    try {
      const res = await fetch("https://api.argonpay.app/create-payment", {
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
      datainput: cleanDataInput.length ? cleanDataInput : null,
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
          manualOrderConfig: mapManualOrderConfig(product.manualOrderConfig),
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
        datainput: cleanDataInput.length ? cleanDataInput : null,
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

  FulfilManualOrder: async (
    _: unknown,
    { orderId, action, code, fulfilmentNote, declineReason }: { orderId: string; action: "Confirm" | "Decline"; code?: string; fulfilmentNote?: string; declineReason?: string },
    context: Context
  ) => {
    if (!context.user) {
      throw new GraphQLError(context.authError || "Authentication required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const userId = context.user.userId;
    const db = getDB();
    const walletsDB = getWalletsDB();
    const catalogsDB = getCatalogsDB();

    const user = await db.collection<User>("users").findOne({ id: userId });
    if (!user) {
      return { code: 404, success: false, message: "User not found", user: null, order: null, transaction: null };
    }

    const order = await walletsDB.collection<Order>("Orders").findOne({ orderId });
    if (!order) {
      return { code: 404, success: false, message: "Order not found", user, order: null, transaction: null };
    }

    if (order.sellerId !== userId) {
      return { code: 403, success: false, message: "Only the selling store can fulfil this manual order", user, order: null, transaction: null };
    }

    const product = await catalogsDB.collection<Product>("Products").findOne({ productId: order.productId });
    if (!product || product.type !== "Manual") {
      return { code: 400, success: false, message: "FulfilManualOrder is only available for Manual products", user, order: null, transaction: null };
    }

    const cleanCode = typeof code === "string" ? code.trim() : "";
    if (cleanCode.length > 2000) {
      return { code: 400, success: false, message: "code must be at most 2000 characters", user, order: null, transaction: null };
    }

    const cleanFulfilmentNote = typeof fulfilmentNote === "string" ? fulfilmentNote.trim() : "";
    if (cleanFulfilmentNote.length > 2000) {
      return { code: 400, success: false, message: "fulfilmentNote must be at most 2000 characters", user, order: null, transaction: null };
    }

    const cleanDeclineReason = typeof declineReason === "string" ? declineReason.trim() : "";
    if (cleanDeclineReason.length > 2000) {
      return { code: 400, success: false, message: "declineReason must be at most 2000 characters", user, order: null, transaction: null };
    }

    if (order.status !== "billed") {
      const idempotencyMessages: Record<string, string> = {
        pending: "This order has already been fulfilled and is awaiting buyer release",
        completed: "This order has already been fulfilled",
        cancelled: "This order has already been declined and cancelled",
        refunded: "This order has been refunded and cannot be acted on",
        disputed: "This order is currently under dispute and cannot be fulfilled",
        partially_refunded: "This order has been partially refunded",
        failed: "This order has failed and cannot be acted on",
      };
      const msg = idempotencyMessages[order.status] ?? `This order cannot be fulfilled. Current status: ${order.status}`;
      return { code: 409, success: false, message: msg, user, order: null, transaction: null };
    }

    const now = new Date().toISOString();
    const store = await catalogsDB.collection<Store>("Stores").findOne({ storeId: order.storeId });
    const sellerTransaction = await walletsDB.collection<Transaction>("Transactions").findOne({ id: order.sellerTransactionId });

    if (action === "Confirm") {
      const nextCodes = cleanCode ? [...order.codes, cleanCode] : order.codes;

      await walletsDB.collection<Order>("Orders").updateOne(
        { orderId },
        {
          $set: {
            status: "completed",
            codes: nextCodes,
            fulfilledAt: now,
            fulfilledBy: userId,
            fulfilmentNote: cleanFulfilmentNote.length ? cleanFulfilmentNote : null,
            statusUpdatedAt: now,
          },
        }
      );

      // Transition transactions out of billed now that order is confirmed
      if (order.buyerTransactionId) {
        await walletsDB.collection<Transaction>("Transactions").updateOne(
          { id: order.buyerTransactionId },
          { $set: { status: "completed" } }
        );
      }
      await walletsDB.collection<Transaction>("Transactions").updateOne(
        { id: order.sellerTransactionId },
        { $set: { status: "pending" } }
      );

      try {
        const sellerHtml = renderStoreManualFulfilledOrderEmail(user.username, {
          orderId: order.orderId,
          productName: product.name,
          quantity: order.quantity,
          buyerTag: order.buyerName || "Buyer",
          fulfilledOn: now,
          orderAmount: order.totalAmount,
          netEarnings: order.amount,
          payoutStatus: "Pending Release",
          expectedPayoutDate: formatDateTime(order.releasedAt),
        });

        const mailTasks: Array<Promise<unknown>> = [];

        if (shouldSendEmailForUser(user)) {
          mailTasks.push(
            smtpTransporter.sendMail({
              from: `GAMEKET <${process.env.SMTP_EMAIL}>`,
              to: user.email,
              subject: "Manual Order Fulfilled",
              html: sellerHtml,
            })
          );
        }

        if (order.buyerId === "anon-gameket-id") {
          const guestDeposit = await walletsDB.collection<Deposit>("Deposits").findOne({ orderId: order.orderId });
          if (guestDeposit?.userId) {
            const guestSummaryHtml = renderOrderSummaryEmail(order.buyerName || "Guest", {
              orderId: order.orderId,
              orderDate: order.createdAt,
              paymentMethod: guestDeposit.paymentMethod || "Webcheckout",
              orderStatus: "Completed",
              productName: product.name,
              quantity: order.quantity,
              amount: order.amount,
              fee: order.fee,
              totalAmount: order.totalAmount,
            });

            mailTasks.push(
              smtpTransporter.sendMail({
                from: `GAMEKET <${process.env.SMTP_EMAIL}>`,
                to: guestDeposit.userId,
                subject: "Your Manual Order Summary",
                html: guestSummaryHtml,
              })
            );
          }
        } else {
          const buyer = await db.collection<User>("users").findOne({ id: order.buyerId });
          if (buyer && shouldSendEmailForUser(buyer)) {
            const buyerHtml = renderBuyerManualFulfilledOrderEmail(buyer.username, {
              orderId: order.orderId,
              fulfilledOn: now,
              storeName: store?.storeName || "Store",
              productName: product.name,
              quantity: order.quantity,
              orderAmount: order.totalAmount,
              paymentMethod: "Wallet Balance",
              codes: nextCodes,
              fulfillmentNote: cleanFulfilmentNote,
            });

            mailTasks.push(
              smtpTransporter.sendMail({
                from: `GAMEKET <${process.env.SMTP_EMAIL}>`,
                to: buyer.email,
                subject: "Manual Order Fulfilled",
                html: buyerHtml,
              })
            );
          }
        }

        await Promise.allSettled(mailTasks);
      } catch (error) {
        console.error("Failed to send manual fulfilled order emails:", error);
      }

      return {
        code: 200,
        success: true,
        message: "Manual order fulfilled successfully",
        user,
        order: {
          orderId: order.orderId,
          buyerId: order.buyerId,
          buyerName: order.buyerName,
          sellerId: order.sellerId,
          sellerName: user.username,
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
            manualOrderConfig: mapManualOrderConfig(product.manualOrderConfig),
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
          },
          codes: nextCodes,
          amount: order.amount,
          fee: order.fee,
          totalAmount: order.totalAmount,
          status: "completed",
          type: order.type,
          action: "sell",
          isReviewed: order.isReviewed,
          isReleased: order.isReleased,
          reviewType: order.reviewType ?? null,
          disputeReason: order.disputeReason ?? null,
          datainput: order.datainput ?? null,
          fulfilledAt: now,
          fulfilledBy: userId,
          fulfilmentNote: cleanFulfilmentNote.length ? cleanFulfilmentNote : null,
          declinedAt: null,
          declineReason: null,
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
          transaction: sellerTransaction ? {
            id: sellerTransaction.id,
            type: sellerTransaction.type,
            status: sellerTransaction.status,
            method: sellerTransaction.method,
            amount: sellerTransaction.amount,
            createdAt: sellerTransaction.createdAt,
          } : null,
        },
        transaction: sellerTransaction ? {
          id: sellerTransaction.id,
          type: sellerTransaction.type,
          status: sellerTransaction.status,
          method: sellerTransaction.method,
          amount: sellerTransaction.amount,
          createdAt: sellerTransaction.createdAt,
        } : null,
      };
    }

    const isAnonBuyer = order.buyerId === "anon-gameket-id";

    // Reverse buyer balance. Guest orders have no wallet — refund processed manually.
    if (!isAnonBuyer) {
      await walletsDB.collection<Balance>("Balances").updateOne(
        { userId: order.buyerId },
        { $inc: { availableBalance: order.totalAmount } }
      );
    }

    if (order.isReleased) {
      await walletsDB.collection<Balance>("Balances").updateOne(
        { userId: order.sellerId },
        { $inc: { availableBalance: -order.amount } }
      );
    } else {
      await walletsDB.collection<Balance>("Balances").updateOne(
        { userId: order.sellerId },
        { $inc: { suspendedBalance: -order.amount } }
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

    await walletsDB.collection<Order>("Orders").updateOne(
      { orderId },
      {
        $set: {
          status: "cancelled",
          isReleased: true,
          codes: cleanCode ? [...order.codes, cleanCode] : order.codes,
          declinedAt: now,
          declineReason: cleanDeclineReason.length ? cleanDeclineReason : null,
          statusUpdatedAt: now,
        },
      }
    );

    try {
      await sendOrderStatusUpdateEmails(db, order, {
        status: "cancelled",
        updatedOn: now,
        statusReason: cleanDeclineReason.length ? cleanDeclineReason : "Order was declined by the seller",
        refundAmount: order.totalAmount,
      });
    } catch (error) {
      console.error("Failed to send cancelled order status email:", error);
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

    const sellerTransactionAfter = await walletsDB.collection<Transaction>("Transactions").findOne({ id: order.sellerTransactionId });

    return {
      code: 200,
      success: true,
      message: isAnonBuyer
        ? "Manual order declined and cancelled. Guest refund must be processed manually."
        : "Manual order declined and buyer refunded successfully",
      user,
      order: {
        orderId: order.orderId,
        buyerId: order.buyerId,
        buyerName: order.buyerName,
        sellerId: order.sellerId,
        sellerName: user.username,
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
          manualOrderConfig: mapManualOrderConfig(product.manualOrderConfig),
          createdAt: product.createdAt,
          store: (updatedStore || store) ? {
            storeId: (updatedStore || store)!.storeId,
            storeName: (updatedStore || store)!.storeName,
            isActive: (updatedStore || store)!.isActive,
            isApproved: (updatedStore || store)!.isApproved,
            approveStatus: (updatedStore || store)!.approveStatus,
            isPromoted: (updatedStore || store)!.isPromoted,
            type: (updatedStore || store)!.type,
            totalSales: (updatedStore || store)!.totalSales,
            positiveReviews: (updatedStore || store)!.positiveReviews,
            negativeReviews: (updatedStore || store)!.negativeReviews,
            registered: (updatedStore || store)!.createdAt,
            requestCount: (updatedStore || store)!.requestCount,
          } : null,
        },
        codes: cleanCode ? [...order.codes, cleanCode] : order.codes,
        amount: order.amount,
        fee: order.fee,
        totalAmount: order.totalAmount,
        status: "cancelled",
        type: order.type,
        action: "sell",
        isReviewed: order.isReviewed,
        isReleased: true,
        reviewType: order.reviewType ?? null,
        disputeReason: order.disputeReason ?? null,
        datainput: order.datainput ?? null,
        fulfilledAt: null,
        fulfilledBy: null,
        fulfilmentNote: null,
        declinedAt: now,
        declineReason: cleanDeclineReason.length ? cleanDeclineReason : null,
        createdAt: order.createdAt,
        releasedAt: order.releasedAt,
        store: (updatedStore || store) ? {
          storeId: (updatedStore || store)!.storeId,
          storeName: (updatedStore || store)!.storeName,
          isActive: (updatedStore || store)!.isActive,
          isApproved: (updatedStore || store)!.isApproved,
          approveStatus: (updatedStore || store)!.approveStatus,
          isPromoted: (updatedStore || store)!.isPromoted,
          type: (updatedStore || store)!.type,
          totalSales: (updatedStore || store)!.totalSales,
          positiveReviews: (updatedStore || store)!.positiveReviews,
          negativeReviews: (updatedStore || store)!.negativeReviews,
          registered: (updatedStore || store)!.createdAt,
          requestCount: (updatedStore || store)!.requestCount,
        } : null,
        transaction: sellerTransactionAfter ? {
          id: sellerTransactionAfter.id,
          type: sellerTransactionAfter.type,
          status: sellerTransactionAfter.status,
          method: sellerTransactionAfter.method,
          amount: sellerTransactionAfter.amount,
          createdAt: sellerTransactionAfter.createdAt,
        } : null,
      },
      transaction: sellerTransactionAfter ? {
        id: sellerTransactionAfter.id,
        type: sellerTransactionAfter.type,
        status: sellerTransactionAfter.status,
        method: sellerTransactionAfter.method,
        amount: sellerTransactionAfter.amount,
        createdAt: sellerTransactionAfter.createdAt,
      } : null,
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

    if (order.status !== "completed" && order.status !== "pending") {
      return { code: 400, success: false, message: "Only completed or pending orders can be reviewed", user, review: null };
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

      // Pending orders are not credited to seller suspended balance.
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
        { $set: { status: "refunded", isReleased: true, statusUpdatedAt: now } }
      );

      try {
        await sendOrderStatusUpdateEmails(db, order, {
          status: "refunded",
          updatedOn: now,
          statusReason: "Seller processed a full refund",
          refundAmount,
        });
      } catch (error) {
        console.error("Failed to send refunded order status email:", error);
      }

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
      { $set: { status: "disputed", disputeReason: reason || null, statusUpdatedAt: now } }
    );

    try {
      await sendOrderStatusUpdateEmails(db, order, {
        status: "disputed",
        updatedOn: now,
        statusReason: reason || "A dispute has been opened for this order",
      });
    } catch (error) {
      console.error("Failed to send disputed order status email:", error);
    }

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
    } else if (order.status === "pending") {
      // Pending orders have no seller suspended credit yet; only credit the final remaining payout.
      await walletsDB.collection<Balance>("Balances").updateOne(
        { userId: offer.sellerId },
        { $inc: { availableBalance: remainingAmount } }
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
      { $set: { status: "partially_refunded", isReleased: true, statusUpdatedAt: now } }
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
