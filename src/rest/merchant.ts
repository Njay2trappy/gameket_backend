import crypto from "crypto";
import { readFileSync } from "fs";
import jwt from "jsonwebtoken";
import nodemailer from "nodemailer";
import { join } from "path";
import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { MongoServerError, type Filter } from "mongodb";
import { allGroups } from "../../data/categories/index.js";
import countryData from "../../data/country.json";
import { recordAuditEvent } from "../audit.js";
import { getCatalogsDB, getDB, getWalletsDB } from "../db.js";
import { getRequestId, logger } from "../logger.js";
import { decryptCodeOrPlain, encryptCode } from "../utils/codeCrypto.js";
import type {
  Balance,
  Deposit,
  MerchantIdempotencyRecord,
  MerchantRequestNonce,
  Order,
  Product,
  ProductManualOrderConfig,
  ProductManualWorkingDay,
  Store,
  Transaction,
  User,
} from "../types.js";

const router = Router();

const smtpTransporter = nodemailer.createTransport({
  host: "gameket.io",
  port: 465,
  secure: true,
  auth: {
    user: process.env.SMTP_EMAIL,
    pass: process.env.SMTP_PASSWORD,
  },
});

const MERCHANT_SIGNATURE_WINDOW_MS = Number(process.env.MERCHANT_SIGNATURE_WINDOW_MS || 5 * 60 * 60 * 1000);
const MERCHANT_NONCE_TTL_MS = Number(process.env.MERCHANT_NONCE_TTL_MS || 10 * 60 * 1000);
const MERCHANT_ACCESS_TOKEN_TTL_SECONDS = Number(process.env.MERCHANT_ACCESS_TOKEN_TTL_SECONDS || 2 * 60 * 60);
const MERCHANT_RATE_LIMIT_WINDOW_MS = Number(process.env.MERCHANT_RATE_LIMIT_WINDOW_MS || 60 * 1000);
const MERCHANT_RATE_LIMIT_MAX = Number(process.env.MERCHANT_RATE_LIMIT_MAX || 20);
const MERCHANT_RATE_LIMIT_READ_MAX = Number(process.env.MERCHANT_RATE_LIMIT_READ_MAX || 20);
const MERCHANT_RATE_LIMIT_WRITE_MAX = Number(process.env.MERCHANT_RATE_LIMIT_WRITE_MAX || MERCHANT_RATE_LIMIT_MAX);
const MERCHANT_TOKEN_ISSUANCE_WINDOW_MS = Number(process.env.MERCHANT_TOKEN_ISSUANCE_WINDOW_MS || 60 * 60 * 1000); // 1 hour
const MERCHANT_TOKEN_ISSUANCE_MAX = Number(process.env.MERCHANT_TOKEN_ISSUANCE_MAX || 2);
const MERCHANT_ANOMALY_WINDOW_MS = Number(process.env.MERCHANT_ANOMALY_WINDOW_MS || 10 * 60 * 1000);
const MERCHANT_ANOMALY_ALERT_THRESHOLD = Number(process.env.MERCHANT_ANOMALY_ALERT_THRESHOLD || 5);
const MERCHANT_IDEMPOTENCY_TTL_MS = Number(process.env.MERCHANT_IDEMPOTENCY_TTL_MS || 24 * 60 * 60 * 1000);
const MERCHANT_IDEMPOTENCY_PENDING_MAX_AGE_MS = Number(process.env.MERCHANT_IDEMPOTENCY_PENDING_MAX_AGE_MS || 10 * 60 * 1000);
const MERCHANT_IDEMPOTENCY_KEY_MIN_LENGTH = 8;
const MERCHANT_IDEMPOTENCY_KEY_MAX_LENGTH = 128;

const merchantRateLimitState = new Map<string, { windowStart: number; count: number }>();
const merchantTokenIssuanceState = new Map<string, { windowStart: number; count: number }>();
const merchantAnomalyState = new Map<string, { windowStart: number; count: number }>();

type MerchantRateLimitBucket = "read" | "write";

type MerchantAuthenticatedRequest = Request & { merchantStore?: Store };

const MAX_PRODUCT_NAME_LENGTH = 100;
const MAX_PRODUCT_DESCRIPTION_LENGTH = 3000;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const MANUAL_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const VALID_WORKING_DAYS: ProductManualWorkingDay["day"][] = [
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
  "SUNDAY",
];

const validRegions = new Set([
  ...Object.values(countryData.countries).map((country) => country.toLowerCase()),
  ...Object.values(countryData.regions).map((region) => region.toLowerCase()),
]);

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

const renderIfBlock = (template: string, key: string, include: boolean): string => {
  const blockRegex = new RegExp(`\\{\\{#if\\s+${key}\\}\\}([\\s\\S]*?)\\{\\{\\/if\\}\\}`, "g");
  return template.replace(blockRegex, include ? "$1" : "");
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

const renderGuestAutomaticOrderEmail = (
  input: {
    orderId: string;
    orderDate: string;
    deliveredOn: string;
    productName: string;
    codes: string[];
    quantity: number;
    totalAmount: number;
    paymentMethod: string;
  }
): string => {
  let template = readFileSync(join(process.cwd(), "src", "emails", "guest-automatic-order-email.html"), "utf-8");
  const cleanCodes = input.codes.filter((value) => value.trim().length > 0);

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

  return template
    .replace(/\{\{orderId\}\}/g, escapeHtml(input.orderId))
    .replace(/\{\{orderDate\}\}/g, escapeHtml(formatDateTime(input.orderDate)))
    .replace(/\{\{deliveredOn\}\}/g, escapeHtml(formatDateTime(input.deliveredOn)))
    .replace(/\{\{productName\}\}/g, escapeHtml(input.productName))
    .replace(/\{\{quantity\}\}/g, String(input.quantity))
    .replace(/\{\{orderTotal\}\}/g, escapeHtml(formatUsd(input.totalAmount)))
    .replace(/\{\{paymentMethod\}\}/g, escapeHtml(input.paymentMethod))
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

const sendMerchantCompletionEmails = async (input: {
  db: ReturnType<typeof getDB>;
  walletsDB: ReturnType<typeof getWalletsDB>;
  order: Order;
  product: Product;
  store: Store;
  sellerUser: User | null;
  fulfilledAt: string;
  fulfilmentNote: string;
  deliveredCodes: string[];
}): Promise<void> => {
  const { db, walletsDB, order, product, store, sellerUser, fulfilledAt, fulfilmentNote, deliveredCodes } = input;
  const isManual = product.type === "Manual";

  try {
    const mailTasks: Array<Promise<unknown>> = [];

    if (isManual && sellerUser && shouldSendEmailForUser(sellerUser)) {
      const sellerHtml = renderStoreManualFulfilledOrderEmail(sellerUser.username, {
        orderId: order.orderId,
        productName: product.name,
        quantity: order.quantity,
        buyerTag: order.buyerName || "Buyer",
        fulfilledOn: fulfilledAt,
        orderAmount: order.totalAmount,
        netEarnings: order.amount,
        payoutStatus: "Pending Release",
        expectedPayoutDate: formatDateTime(order.releasedAt),
      });

      mailTasks.push(
        smtpTransporter.sendMail({
          from: `GAMEKET <${process.env.SMTP_EMAIL}>`,
          to: sellerUser.email,
          subject: "Manual Order Fulfilled",
          html: sellerHtml,
        })
      );
    }

    if (order.buyerId === "anon-gameket-id") {
      const guestDeposit = await walletsDB.collection<Deposit>("Deposits").findOne({ orderId: order.orderId });
      if (guestDeposit?.userId) {
        if (isManual) {
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
        } else {
          const guestHtml = renderGuestAutomaticOrderEmail({
            orderId: order.orderId,
            orderDate: order.createdAt,
            deliveredOn: fulfilledAt,
            productName: product.name,
            codes: deliveredCodes,
            quantity: order.quantity,
            totalAmount: order.totalAmount,
            paymentMethod: guestDeposit.paymentMethod || "Webcheckout",
          });

          mailTasks.push(
            smtpTransporter.sendMail({
              from: `GAMEKET <${process.env.SMTP_EMAIL}>`,
              to: guestDeposit.userId,
              subject: "Guest Order Completed",
              html: guestHtml,
            })
          );
        }
      }
    } else {
      const buyer = await db.collection<User>("users").findOne({ id: order.buyerId });
      if (buyer && shouldSendEmailForUser(buyer)) {
        if (isManual) {
          const buyerHtml = renderBuyerManualFulfilledOrderEmail(buyer.username, {
            orderId: order.orderId,
            fulfilledOn: fulfilledAt,
            storeName: store.storeName || "Store",
            productName: product.name,
            quantity: order.quantity,
            orderAmount: order.totalAmount,
            paymentMethod: "Wallet Balance",
            codes: deliveredCodes,
            fulfillmentNote: fulfilmentNote,
          });

          mailTasks.push(
            smtpTransporter.sendMail({
              from: `GAMEKET <${process.env.SMTP_EMAIL}>`,
              to: buyer.email,
              subject: "Manual Order Fulfilled",
              html: buyerHtml,
            })
          );
        } else {
          const buyerHtml = renderOrderSummaryEmail(buyer.username, {
            orderId: order.orderId,
            orderDate: order.createdAt,
            paymentMethod: "Wallet Balance",
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
              to: buyer.email,
              subject: "Your Order Summary",
              html: buyerHtml,
            })
          );
        }
      }
    }

    await Promise.allSettled(mailTasks);
  } catch (error) {
    logger.error({ err: error, orderId: order.orderId }, "Failed to send merchant completion emails");
  }
};

const sendMerchantRefundEmails = async (input: {
  db: ReturnType<typeof getDB>;
  walletsDB: ReturnType<typeof getWalletsDB>;
  order: Order;
  product: Product;
  refundedAt: string;
  refundAmount: number;
}): Promise<void> => {
  const { db, walletsDB, order, product, refundedAt, refundAmount } = input;

  try {
    const mailTasks: Array<Promise<unknown>> = [];

    if (order.buyerId === "anon-gameket-id") {
      const guestDeposit = await walletsDB.collection<Deposit>("Deposits").findOne({ orderId: order.orderId });
      if (guestDeposit?.userId) {
        const guestHtml = renderOrderStatusUpdateEmail(order.buyerName || "Guest", {
          status: "refunded",
          orderId: order.orderId,
          productName: product.name,
          quantity: order.quantity,
          orderAmount: order.totalAmount,
          updatedOn: refundedAt,
          refundAmount: refundAmount,
        });

        mailTasks.push(
          smtpTransporter.sendMail({
            from: `GAMEKET <${process.env.SMTP_EMAIL}>`,
            to: guestDeposit.userId,
            subject: "Order Status Updated",
            html: guestHtml,
          })
        );
      }
    } else {
      const buyer = await db.collection<User>("users").findOne({ id: order.buyerId });
      if (buyer && shouldSendEmailForUser(buyer)) {
        const buyerHtml = renderOrderStatusUpdateEmail(buyer.username, {
          status: "refunded",
          orderId: order.orderId,
          productName: product.name,
          quantity: order.quantity,
          orderAmount: order.totalAmount,
          updatedOn: refundedAt,
          refundAmount: refundAmount,
        });

        mailTasks.push(
          smtpTransporter.sendMail({
            from: `GAMEKET <${process.env.SMTP_EMAIL}>`,
            to: buyer.email,
            subject: "Order Status Updated",
            html: buyerHtml,
          })
        );
      }

      const seller = await db.collection<User>("users").findOne({ id: order.sellerId });
      if (seller && shouldSendEmailForUser(seller)) {
        const sellerHtml = renderOrderStatusUpdateEmail(seller.username, {
          status: "refunded",
          orderId: order.orderId,
          productName: product.name,
          quantity: order.quantity,
          orderAmount: order.totalAmount,
          updatedOn: refundedAt,
          refundAmount: refundAmount,
        });

        mailTasks.push(
          smtpTransporter.sendMail({
            from: `GAMEKET <${process.env.SMTP_EMAIL}>`,
            to: seller.email,
            subject: "Order Status Updated",
            html: sellerHtml,
          })
        );
      }
    }

    await Promise.allSettled(mailTasks);
  } catch (error) {
    logger.error({ err: error, orderId: order.orderId }, "Failed to send merchant refund emails");
  }
};

const getClientIp = (req: Request): string => {
  const forwarded = req.headers["x-forwarded-for"];
  if (Array.isArray(forwarded)) {
    return (forwarded[0] || req.socket.remoteAddress || "unknown").toString();
  }
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
  }
  return req.socket.remoteAddress || "unknown";
};

const getMerchantJwtSecret = (): string => {
  const secret = process.env.MERCHANT_JWT_SECRET?.trim();
  if (!secret) {
    throw new Error("MERCHANT_JWT_SECRET is not configured");
  }
  return secret;
};

const getBearerToken = (req: Request): string => {
  const authHeader = req.header("authorization")?.trim() || "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) {
    return "";
  }
  return authHeader.slice(7).trim();
};

const secureSecretMatch = (providedSecret: string, expectedSecret: string): boolean => {
  const providedHash = crypto.createHash("sha256").update(providedSecret).digest();
  const expectedHash = crypto.createHash("sha256").update(expectedSecret).digest();
  return crypto.timingSafeEqual(providedHash, expectedHash);
};

const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));

  const serializedEntries = entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`);
  return `{${serializedEntries.join(",")}}`;
};

const sha256Hex = (value: string): string => {
  return crypto.createHash("sha256").update(value).digest("hex");
};

const hmacSha256Hex = (secret: string, payload: string): string => {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
};

const normalizeSignature = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.startsWith("sha256=")) {
    return trimmed.slice(7);
  }
  return trimmed;
};

const secureSignatureMatch = (providedSignature: string, expectedSignature: string): boolean => {
  if (!/^[a-f0-9]{64}$/i.test(providedSignature) || !/^[a-f0-9]{64}$/i.test(expectedSignature)) {
    return false;
  }

  const providedBuffer = Buffer.from(providedSignature.toLowerCase(), "hex");
  const expectedBuffer = Buffer.from(expectedSignature.toLowerCase(), "hex");

  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(providedBuffer, expectedBuffer);
};

const parseTimestampMs = (value: string): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return NaN;
  }

  return parsed < 1e12 ? parsed * 1000 : parsed;
};

const escapeRegex = (value: string): string => {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
};

const parseBooleanQuery = (value: unknown): boolean | null => {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return null;
};

const validateCallbackUrl = (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }

    return parsed.toString();
  } catch {
    return null;
  }
};

const normalizeRequestPath = (req: Request): string => {
  const rawPath = req.originalUrl.split("?")[0] || req.path || "";
  if (rawPath.length > 1 && rawPath.endsWith("/")) {
    return rawPath.slice(0, -1);
  }

  return rawPath;
};

const getCanonicalRequestTarget = (req: Request): string => {
  const path = normalizeRequestPath(req);
  const queryIndex = req.originalUrl.indexOf("?");

  if (queryIndex === -1) {
    return path;
  }

  const rawQuery = req.originalUrl.slice(queryIndex + 1);
  if (!rawQuery) {
    return path;
  }

  const sortedEntries = [...new URLSearchParams(rawQuery).entries()]
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => {
      if (leftKey === rightKey) {
        return leftValue.localeCompare(rightValue);
      }

      return leftKey.localeCompare(rightKey);
    });

  if (sortedEntries.length === 0) {
    return path;
  }

  const canonicalQuery = new URLSearchParams();
  for (const [key, value] of sortedEntries) {
    canonicalQuery.append(key, value);
  }

  return `${path}?${canonicalQuery.toString()}`;
};

const getQueryStringValue = (req: Request, key: string): string => {
  const rawValue = req.query[key];

  if (typeof rawValue === "string") {
    return rawValue.trim();
  }

  if (Array.isArray(rawValue)) {
    const firstString = rawValue.find((value) => typeof value === "string" && value.trim().length > 0);
    return typeof firstString === "string" ? firstString.trim() : "";
  }

  return "";
};

const getMerchantIdempotencyKey = (req: Request): string => {
  const standardHeader = req.header("idempotency-key")?.trim();
  if (standardHeader) {
    return standardHeader;
  }

  return req.header("x-idempotency-key")?.trim() || "";
};

const getMerchantIdempotencyOperation = (req: Request): string | null => {
  const method = req.method.toUpperCase();
  const path = normalizeRequestPath(req);
  const orderId = getQueryStringValue(req, "orderId");

  if ((method === "POST" || method === "PATCH") && path === "/merchant/orders/codes" && orderId) {
    return `order_codes:${orderId}`;
  }

  if (method === "POST" && path === "/merchant/orders/complete" && orderId) {
    return `order_complete:${orderId}`;
  }

  if (method === "POST" && path === "/merchant/orders/refund" && orderId) {
    return `order_refund:${orderId}`;
  }

  if (method === "POST" && path === "/merchant/orders/cancel" && orderId) {
    return `order_cancel:${orderId}`;
  }

  if ((method === "PATCH" || method === "PUT") && path === "/merchant/orders" && orderId) {
    const statusRaw = typeof req.body?.status === "string" ? req.body.status.trim().toLowerCase() : "";

    if (statusRaw === "complete" || statusRaw === "completed") {
      return `order_complete:${orderId}`;
    }

    if (statusRaw === "refund" || statusRaw === "refunded") {
      return `order_refund:${orderId}`;
    }

    if (statusRaw === "cancel" || statusRaw === "cancelled") {
      return `order_cancel:${orderId}`;
    }
  }

  return null;
};

const enforceMerchantIdempotency = async (
  req: Request,
  res: Response,
  store: Store
): Promise<boolean> => {
  const operation = getMerchantIdempotencyOperation(req);
  if (!operation) {
    return false;
  }

  const requestId = getRequestId(req);
  const idempotencyKey = getMerchantIdempotencyKey(req);

  if (!idempotencyKey) {
    res.status(400).json({
      success: false,
      message: "Missing Idempotency-Key header for this write operation",
      requestId,
    });
    return true;
  }

  if (
    idempotencyKey.length < MERCHANT_IDEMPOTENCY_KEY_MIN_LENGTH
    || idempotencyKey.length > MERCHANT_IDEMPOTENCY_KEY_MAX_LENGTH
  ) {
    res.status(400).json({
      success: false,
      message: `Idempotency-Key must be between ${MERCHANT_IDEMPOTENCY_KEY_MIN_LENGTH} and ${MERCHANT_IDEMPOTENCY_KEY_MAX_LENGTH} characters`,
      requestId,
    });
    return true;
  }

  const requestHash = sha256Hex(stableStringify(req.body ?? {}));
  const collection = getCatalogsDB().collection<MerchantIdempotencyRecord>("MerchantIdempotencyKeys");
  const selector = {
    storeId: store.storeId,
    operation,
    idempotencyKey,
  };

  const replayOrRejectExisting = async (record: MerchantIdempotencyRecord): Promise<boolean> => {
    if (record.requestHash !== requestHash) {
      res.status(409).json({
        success: false,
        message: "Idempotency-Key was already used with a different request payload",
        requestId,
      });
      return true;
    }

    if (record.state === "completed" && typeof record.statusCode === "number") {
      res.setHeader("x-idempotent-replay", "true");
      res.status(record.statusCode).json(record.responseBody);
      return true;
    }

    const createdAtMs = new Date(record.createdAt).getTime();
    const isStalePending = !Number.isFinite(createdAtMs)
      || ((Date.now() - createdAtMs) > MERCHANT_IDEMPOTENCY_PENDING_MAX_AGE_MS);

    if (!isStalePending) {
      res.status(409).json({
        success: false,
        message: "Request with this Idempotency-Key is already in progress",
        requestId,
      });
      return true;
    }

    await collection.deleteOne({ ...selector, state: "pending" });
    return false;
  };

  const existing = await collection.findOne(selector);
  if (existing) {
    const handled = await replayOrRejectExisting(existing);
    if (handled) {
      return true;
    }
  }

  const nowIso = new Date().toISOString();
  const expiresAt = new Date(Date.now() + MERCHANT_IDEMPOTENCY_TTL_MS).toISOString();

  try {
    await collection.insertOne({
      ...selector,
      requestHash,
      state: "pending",
      statusCode: null,
      responseBody: null,
      createdAt: nowIso,
      expiresAt,
    });
  } catch (error) {
    if (error instanceof MongoServerError && error.code === 11000) {
      const racedRecord = await collection.findOne(selector);
      if (racedRecord) {
        const handled = await replayOrRejectExisting(racedRecord);
        if (handled) {
          return true;
        }
      }
    } else {
      throw error;
    }
  }

  const originalJson = res.json.bind(res);
  res.json = ((body: unknown) => {
    const statusCode = res.statusCode || 200;

    if (statusCode >= 500) {
      void collection.deleteOne({ ...selector, state: "pending" }).catch((deleteError) => {
        logger.error(
          { err: deleteError, requestId, selector },
          "Failed to cleanup pending merchant idempotency record after server error"
        );
      });
    } else {
      void collection.updateOne(
        { ...selector, state: "pending" },
        {
          $set: {
            state: "completed",
            statusCode,
            responseBody: body,
          },
        }
      ).catch((updateError) => {
        logger.error(
          { err: updateError, requestId, selector },
          "Failed to persist completed merchant idempotency response"
        );
      });
    }

    return originalJson(body as never);
  }) as Response["json"];

  return false;
};

const mapManualOrderConfig = (config: ProductManualOrderConfig | null | undefined) => {
  if (!config) return null;

  return {
    isadditional: Boolean(config.isadditional),
    characterCount: config.characterCount ?? null,
    orderDescription: config.orderDescription ?? null,
    workingDays: (config.workingDays || []).map((day: ProductManualWorkingDay) => ({
      day: day.day,
      openTime: day.openTime,
      closeTime: day.closeTime,
    })),
  };
};

const mapProductForResponse = (product: Product) => {
  return {
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
    isAPI: Boolean(product.isAPI),
    callbackurl: product.apiCallbackUrl || null,
    available: product.available,
    sold: product.sold,
    type: product.type,
    manualOrderConfig: mapManualOrderConfig(product.manualOrderConfig),
    createdAt: product.createdAt,
  };
};

const parseTimeToMinutes = (value: string): number => {
  const [hours, minutes] = value.split(":").map((part) => Number(part));
  return (hours * 60) + minutes;
};

const mapOrderForResponse = (order: Order, product: Product | null) => {
  return {
    orderId: order.orderId,
    buyerId: order.buyerId,
    buyerName: order.buyerName,
    sellerId: order.sellerId,
    storeId: order.storeId,
    productId: order.productId,
    quantity: order.quantity,
    amount: order.amount,
    fee: order.fee,
    totalAmount: order.totalAmount,
    status: order.status,
    type: order.type,
    isReviewed: order.isReviewed,
    reviewType: order.reviewType ?? null,
    isReleased: order.isReleased,
    disputeReason: order.disputeReason ?? null,
    datainput: order.datainput ?? null,
    fulfilledAt: order.fulfilledAt ?? null,
    fulfilledBy: order.fulfilledBy ?? null,
    fulfilmentNote: order.fulfilmentNote ?? null,
    declinedAt: order.declinedAt ?? null,
    declineReason: order.declineReason ?? null,
    createdAt: order.createdAt,
    releasedAt: order.releasedAt,
    codes: (order.codes || []).map((code) => decryptCodeOrPlain(code)),
    product: product ? mapProductForResponse(product) : null,
  };
};

const buildSigningPayload = (
  method: string,
  path: string,
  timestamp: string,
  nonce: string,
  bodyHash: string
): string => {
  return [method.toUpperCase(), path, timestamp, nonce, bodyHash].join("\n");
};

const recordMerchantAnomaly = (
  merchantKey: string,
  reason: string,
  metadata: Record<string, unknown>
): void => {
  const now = Date.now();
  const current = merchantAnomalyState.get(merchantKey);

  if (!current || now - current.windowStart >= MERCHANT_ANOMALY_WINDOW_MS) {
    merchantAnomalyState.set(merchantKey, { windowStart: now, count: 1 });
  } else {
    current.count += 1;
    merchantAnomalyState.set(merchantKey, current);
  }

  const anomalyState = merchantAnomalyState.get(merchantKey)!;
  const logPayload = {
    merchantKey,
    reason,
    anomalyCountInWindow: anomalyState.count,
    anomalyWindowMs: MERCHANT_ANOMALY_WINDOW_MS,
    ...metadata,
  };

  if (anomalyState.count >= MERCHANT_ANOMALY_ALERT_THRESHOLD) {
    logger.error(logPayload, "Merchant anomaly threshold reached");
    return;
  }

  logger.warn(logPayload, "Merchant request anomaly detected");
};

const getMerchantRateLimitPolicy = (req: Request): { bucket: MerchantRateLimitBucket; limit: number } => {
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD") {
    return {
      bucket: "read",
      limit: Number.isFinite(MERCHANT_RATE_LIMIT_READ_MAX) && MERCHANT_RATE_LIMIT_READ_MAX > 0
        ? MERCHANT_RATE_LIMIT_READ_MAX
        : 1,
    };
  }

  return {
    bucket: "write",
    limit: Number.isFinite(MERCHANT_RATE_LIMIT_WRITE_MAX) && MERCHANT_RATE_LIMIT_WRITE_MAX > 0
      ? MERCHANT_RATE_LIMIT_WRITE_MAX
      : 1,
  };
};

const enforceMerchantRateLimit = (
  merchantApiKey: string,
  req: Request
): {
  allowed: boolean;
  retryAfterSeconds: number;
  bucket: MerchantRateLimitBucket;
  limit: number;
  remaining: number;
  resetAt: string;
  keyHash: string;
} => {
  const { bucket, limit } = getMerchantRateLimitPolicy(req);
  const keyHash = sha256Hex(merchantApiKey).slice(0, 24);
  const stateKey = `${keyHash}:${bucket}`;
  const now = Date.now();
  const state = merchantRateLimitState.get(stateKey);

  const toResponse = (count: number, allowed: boolean, windowStart: number) => {
    const retryAfterMs = Math.max(0, MERCHANT_RATE_LIMIT_WINDOW_MS - (now - windowStart));
    return {
      allowed,
      retryAfterSeconds: allowed ? 0 : Math.ceil(retryAfterMs / 1000),
      bucket,
      limit,
      remaining: Math.max(limit - count, 0),
      resetAt: new Date(windowStart + MERCHANT_RATE_LIMIT_WINDOW_MS).toISOString(),
      keyHash,
    };
  };

  if (!state || now - state.windowStart >= MERCHANT_RATE_LIMIT_WINDOW_MS) {
    const nextState = { windowStart: now, count: 1 };
    merchantRateLimitState.set(stateKey, nextState);
    return toResponse(nextState.count, true, nextState.windowStart);
  }

  state.count += 1;
  merchantRateLimitState.set(stateKey, state);

  if (state.count > limit) {
    return toResponse(state.count, false, state.windowStart);
  }

  return toResponse(state.count, true, state.windowStart);
};

const enforceTokenIssuanceRateLimit = (
  merchantApiKey: string,
  req: Request
): {
  allowed: boolean;
  retryAfterSeconds: number;
  limit: number;
  remaining: number;
  resetAt: string;
} => {
  const keyHash = sha256Hex(merchantApiKey).slice(0, 24);
  const stateKey = `token:${keyHash}`;
  const now = Date.now();
  const state = merchantTokenIssuanceState.get(stateKey);
  const limit = MERCHANT_TOKEN_ISSUANCE_MAX;

  const toResponse = (count: number, allowed: boolean, windowStart: number) => {
    const retryAfterMs = Math.max(0, MERCHANT_TOKEN_ISSUANCE_WINDOW_MS - (now - windowStart));
    return {
      allowed,
      retryAfterSeconds: allowed ? 0 : Math.ceil(retryAfterMs / 1000),
      limit,
      remaining: Math.max(limit - count, 0),
      resetAt: new Date(windowStart + MERCHANT_TOKEN_ISSUANCE_WINDOW_MS).toISOString(),
    };
  };

  if (!state || now - state.windowStart >= MERCHANT_TOKEN_ISSUANCE_WINDOW_MS) {
    const nextState = { windowStart: now, count: 1 };
    merchantTokenIssuanceState.set(stateKey, nextState);
    return toResponse(nextState.count, true, nextState.windowStart);
  }

  state.count += 1;
  merchantTokenIssuanceState.set(stateKey, state);

  if (state.count > limit) {
    return toResponse(state.count, false, state.windowStart);
  }

  return toResponse(state.count, true, state.windowStart);
};

const consumeMerchantNonce = async (storeId: string, nonce: string, timestampMs: number): Promise<boolean> => {
  const nowIso = new Date().toISOString();
  const ttlBaseTime = Math.max(Date.now(), timestampMs);
  const expiresAtIso = new Date(ttlBaseTime + MERCHANT_NONCE_TTL_MS).toISOString();

  try {
    await getCatalogsDB().collection<MerchantRequestNonce>("MerchantRequestNonces").insertOne({
      storeId,
      nonce,
      createdAt: nowIso,
      expiresAt: expiresAtIso,
    });
    return true;
  } catch (error) {
    if (error instanceof MongoServerError && error.code === 11000) {
      return false;
    }

    throw error;
  }
};

const authenticateMerchantRequest = async (
  req: MerchantAuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const requestId = getRequestId(req);
  const clientIp = getClientIp(req);

  const apiKey = req.header("x-merchant-api-key")?.trim() || "";
  const accessToken = getBearerToken(req);

  const missingHeaders: string[] = [];
  if (!apiKey) missingHeaders.push("x-merchant-api-key");
  if (!accessToken) missingHeaders.push("authorization: Bearer <token>");

  if (missingHeaders.length > 0) {
    recordMerchantAnomaly("unknown", "missing_headers", {
      requestId,
      clientIp,
      missingHeaders,
      path: req.originalUrl,
    });

    res.status(401).json({
      success: false,
      message: "Missing merchant authentication headers",
      requestId,
    });
    return;
  }

  const catalogsDB = getCatalogsDB();
  const store = await catalogsDB.collection<Store>("Stores").findOne({ merchantApiKey: apiKey });

  if (!store || store.type !== "merchant" || !store.isActive || !store.merchantSecret) {
    recordMerchantAnomaly(apiKey.slice(0, 12) || "unknown", "invalid_api_key", {
      requestId,
      clientIp,
      path: req.originalUrl,
    });

    res.status(401).json({
      success: false,
      message: "Invalid merchant credentials",
      requestId,
    });
    return;
  }

  let decoded: jwt.JwtPayload;
  try {
    const verified = jwt.verify(accessToken, getMerchantJwtSecret());
    if (typeof verified === "string") {
      throw new Error("Invalid token payload");
    }
    decoded = verified;
  } catch (error) {
    const reason = error instanceof Error && error.name === "TokenExpiredError"
      ? "token_expired"
      : "invalid_token";

    recordMerchantAnomaly(store.storeId, reason, {
      requestId,
      clientIp,
      path: req.originalUrl,
    });

    res.status(401).json({
      success: false,
      message: reason === "token_expired" ? "Merchant access token expired" : "Invalid merchant access token",
      requestId,
    });
    return;
  }

  const expectedApiKeyHash = sha256Hex(apiKey);
  const tokenStoreId = typeof decoded.storeId === "string" ? decoded.storeId : "";
  const tokenApiKeyHash = typeof decoded.apiKeyHash === "string" ? decoded.apiKeyHash : "";
  const tokenType = typeof decoded.type === "string" ? decoded.type : "";

  if (tokenType !== "merchant_access" || tokenStoreId !== store.storeId || tokenApiKeyHash !== expectedApiKeyHash) {
    recordMerchantAnomaly(store.storeId, "token_context_mismatch", {
      requestId,
      clientIp,
      path: req.originalUrl,
    });

    res.status(401).json({
      success: false,
      message: "Merchant access token does not match API key",
      requestId,
    });
    return;
  }

  const rateLimit = enforceMerchantRateLimit(apiKey, req);
  res.setHeader("x-ratelimit-policy", `api-key:${rateLimit.bucket}`);
  res.setHeader("x-ratelimit-limit", String(rateLimit.limit));
  res.setHeader("x-ratelimit-remaining", String(rateLimit.remaining));
  res.setHeader("x-ratelimit-reset", rateLimit.resetAt);

  if (!rateLimit.allowed) {
    res.setHeader("retry-after", String(rateLimit.retryAfterSeconds));
    recordMerchantAnomaly(store.storeId, "rate_limit_exceeded", {
      requestId,
      clientIp,
      retryAfterSeconds: rateLimit.retryAfterSeconds,
      rateLimitBucket: rateLimit.bucket,
      rateLimitScope: "api-key",
      rateLimitKeyHash: rateLimit.keyHash,
      path: req.originalUrl,
    });

    res.status(429).json({
      success: false,
      message: "Too many merchant requests",
      retryAfterSeconds: rateLimit.retryAfterSeconds,
      requestId,
    });
    return;
  }

  req.merchantStore = store;

  const idempotencyHandled = await enforceMerchantIdempotency(req, res, store);
  if (idempotencyHandled) {
    return;
  }

  next();
};

router.post(
  "/merchant/auth/check",
  async (req, res) => {
    const requestId = getRequestId(req);
    const clientIp = getClientIp(req);

    try {
      const apiKey = typeof req.body?.apiKey === "string"
        ? req.body.apiKey.trim()
        : (req.header("x-merchant-api-key")?.trim() || "");
      const secret = typeof req.body?.secret === "string" ? req.body.secret : "";

      if (!apiKey || !secret) {
        res.status(400).json({
          success: false,
          message: "apiKey and secret are required",
          requestId,
        });
        return;
      }

      const catalogsDB = getCatalogsDB();
      const store = await catalogsDB.collection<Store>("Stores").findOne({ merchantApiKey: apiKey });

      if (!store || store.type !== "merchant" || !store.isActive || !store.merchantSecret) {
        recordMerchantAnomaly(apiKey.slice(0, 12) || "unknown", "invalid_token_issue_credentials", {
          requestId,
          clientIp,
          path: req.originalUrl,
        });

        res.status(401).json({
          success: false,
          message: "Invalid merchant credentials",
          requestId,
        });
        return;
      }

      const rateLimit = enforceTokenIssuanceRateLimit(apiKey, req);
      res.setHeader("x-ratelimit-policy", "token-issuance");
      res.setHeader("x-ratelimit-limit", String(rateLimit.limit));
      res.setHeader("x-ratelimit-remaining", String(rateLimit.remaining));
      res.setHeader("x-ratelimit-reset", rateLimit.resetAt);

      if (!rateLimit.allowed) {
        res.setHeader("retry-after", String(rateLimit.retryAfterSeconds));
        res.status(429).json({
          success: false,
          message: "Too many merchant requests",
          retryAfterSeconds: rateLimit.retryAfterSeconds,
          requestId,
        });
        return;
      }

      if (!secureSecretMatch(secret, store.merchantSecret)) {
        recordMerchantAnomaly(store.storeId, "invalid_token_issue_secret", {
          requestId,
          clientIp,
          path: req.originalUrl,
        });

        res.status(401).json({
          success: false,
          message: "Invalid merchant credentials",
          requestId,
        });
        return;
      }

      const issuedAtMs = Date.now();
      const expiresAtMs = issuedAtMs + (MERCHANT_ACCESS_TOKEN_TTL_SECONDS * 1000);
      const token = jwt.sign(
        {
          type: "merchant_access",
          storeId: store.storeId,
          apiKeyHash: sha256Hex(apiKey),
        },
        getMerchantJwtSecret(),
        { expiresIn: MERCHANT_ACCESS_TOKEN_TTL_SECONDS }
      );

      res.status(200).json({
        success: true,
        message: "Merchant access token issued",
        token,
        tokenType: "Bearer",
        expiresInSeconds: MERCHANT_ACCESS_TOKEN_TTL_SECONDS,
        expiresAt: new Date(expiresAtMs).toISOString(),
        merchant: {
          storeId: store.storeId,
          storeName: store.storeName,
        },
        serverTime: new Date(issuedAtMs).toISOString(),
        requestId,
      });
    } catch (error) {
      logger.error({ err: error, requestId: getRequestId(req) }, "Failed to authenticate merchant request");
      res.status(500).json({
        success: false,
        message: "Merchant token issuance failed",
        requestId: getRequestId(req),
      });
    }
  }
);

const requireMerchantAuth = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await authenticateMerchantRequest(req as MerchantAuthenticatedRequest, res, next);
  } catch (error) {
    logger.error({ err: error, requestId: getRequestId(req) }, "Failed to authenticate merchant request");
    res.status(500).json({
      success: false,
      message: "Merchant authentication failed",
      requestId: getRequestId(req),
    });
  }
};

const getMerchantDetailsHandler = async (req: Request, res: Response): Promise<void> => {
  const requestId = getRequestId(req);

  try {
    const merchantReq = req as MerchantAuthenticatedRequest;
    const store = merchantReq.merchantStore!;

    const db = getDB();
    const user = await db.collection<User>("users").findOne({ id: store.userId });

    res.status(200).json({
      success: true,
      message: "Merchant details fetched successfully",
      merchant: {
        user: user
          ? {
              id: user.id,
              username: user.username,
              email: user.email,
              country: user.country,
              isVerified: user.isVerified,
              isPremium: user.isPremium,
              rank: user.rank,
              registered: user.registered,
            }
          : null,
        store: {
          storeId: store.storeId,
          storeName: store.storeName,
          bio: store.bio ?? null,
          storeImage: store.storeImage ?? null,
          isActive: store.isActive,
          isApproved: store.isApproved,
          approveStatus: store.approveStatus ?? null,
          isPromoted: store.isPromoted,
          type: store.type,
          totalSales: store.totalSales,
          positiveReviews: store.positiveReviews,
          negativeReviews: store.negativeReviews,
          requestCount: store.requestCount,
          createdAt: store.createdAt,
          merchantApiKey: store.merchantApiKey ?? null,
        },
      },
      requestId,
    });
  } catch (error) {
    logger.error({ err: error, requestId }, "Failed to fetch merchant details");
    res.status(500).json({
      success: false,
      message: "Failed to fetch merchant details",
      requestId,
    });
  }
};

router.get("/merchant", requireMerchantAuth, getMerchantDetailsHandler);
router.get("/merchant/me", requireMerchantAuth, getMerchantDetailsHandler);

router.get("/merchant/products", requireMerchantAuth, async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const merchantReq = req as MerchantAuthenticatedRequest;
    const store = merchantReq.merchantStore!;
    const productId = getQueryStringValue(req, "productId");

    if (productId) {
      const product = await getCatalogsDB().collection<Product>("Products").findOne({
        productId,
        userId: store.userId,
      });

      if (!product) {
        res.status(404).json({
          success: false,
          message: "Product not found or does not belong to this merchant",
          requestId,
        });
        return;
      }

      res.status(200).json({
        success: true,
        message: "Product fetched successfully",
        product: mapProductForResponse(product),
        requestId,
      });
      return;
    }

    const typeQuery = typeof req.query.type === "string" ? req.query.type.trim() : "";
    if (typeQuery && typeQuery !== "Auto" && typeQuery !== "Manual") {
      res.status(400).json({
        success: false,
        message: "type must be either Auto or Manual",
        requestId,
      });
      return;
    }

    const isApiQueryRaw = req.query.isApi;
    const isApiQuery = parseBooleanQuery(typeof isApiQueryRaw === "string" ? isApiQueryRaw : undefined);
    if (isApiQueryRaw != null && isApiQuery === null) {
      res.status(400).json({
        success: false,
        message: "isApi must be true or false",
        requestId,
      });
      return;
    }

    const isActiveQueryRaw = req.query.isActive;
    const isActiveQuery = parseBooleanQuery(typeof isActiveQueryRaw === "string" ? isActiveQueryRaw : undefined);
    if (isActiveQueryRaw != null && isActiveQuery === null) {
      res.status(400).json({
        success: false,
        message: "isActive must be true or false",
        requestId,
      });
      return;
    }

    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";

    const parsedPage = Number.parseInt(String(req.query.page ?? "1"), 10);
    const parsedLimit = Number.parseInt(String(req.query.limit ?? String(DEFAULT_PAGE_SIZE)), 10);

    if (!Number.isFinite(parsedPage) || parsedPage <= 0) {
      res.status(400).json({
        success: false,
        message: "page must be a positive integer",
        requestId,
      });
      return;
    }

    if (!Number.isFinite(parsedLimit) || parsedLimit <= 0 || parsedLimit > MAX_PAGE_SIZE) {
      res.status(400).json({
        success: false,
        message: `limit must be between 1 and ${MAX_PAGE_SIZE}`,
        requestId,
      });
      return;
    }

    const filter: Filter<Product> = { userId: store.userId };

    if (typeQuery) {
      filter.type = typeQuery as Product["type"];
    }

    if (isApiQuery != null) {
      filter.isAPI = isApiQuery;
    }

    if (isActiveQuery != null) {
      filter.isActive = isActiveQuery;
    }

    if (search) {
      filter.name = { $regex: escapeRegex(search), $options: "i" };
    }

    const catalogsDB = getCatalogsDB();
    const skip = (parsedPage - 1) * parsedLimit;

    const [total, products] = await Promise.all([
      catalogsDB.collection<Product>("Products").countDocuments(filter),
      catalogsDB.collection<Product>("Products").find(filter).sort({ createdAt: -1 }).skip(skip).limit(parsedLimit).toArray(),
    ]);

    const totalPages = total === 0 ? 0 : Math.ceil(total / parsedLimit);

    res.status(200).json({
      success: true,
      message: `${products.length} product(s) fetched`,
      products: products.map(mapProductForResponse),
      pagination: {
        page: parsedPage,
        limit: parsedLimit,
        total,
        totalPages,
        hasNextPage: parsedPage < totalPages,
        hasPreviousPage: parsedPage > 1,
      },
      requestId,
    });
  } catch (error) {
    logger.error({ err: error, requestId }, "Failed to fetch merchant products");
    res.status(500).json({
      success: false,
      message: "Failed to fetch merchant products",
      requestId,
    });
  }
});

const updateMerchantProductHandler = async (req: Request, res: Response): Promise<void> => {
  const requestId = getRequestId(req);

  try {
    const merchantReq = req as MerchantAuthenticatedRequest;
    const store = merchantReq.merchantStore!;
    const productId = getQueryStringValue(req, "productId");

    if (!productId) {
      res.status(400).json({
        success: false,
        message: "productId query parameter is required",
        requestId,
      });
      return;
    }

    const catalogsDB = getCatalogsDB();
    const product = await catalogsDB.collection<Product>("Products").findOne({ productId, userId: store.userId });

    if (!product) {
      res.status(404).json({
        success: false,
        message: "Product not found or does not belong to this merchant",
        requestId,
      });
      return;
    }

    const updates: Partial<Pick<Product, "name" | "description" | "marketPrice" | "price" | "region" | "isActive" | "discount" | "apiCallbackUrl">> = {};

    if (req.body?.name != null) {
      if (typeof req.body.name !== "string") {
        res.status(400).json({ success: false, message: "name must be a string", requestId });
        return;
      }

      const name = req.body.name.trim();
      if (!name) {
        res.status(400).json({ success: false, message: "name cannot be empty", requestId });
        return;
      }

      if (name.length > MAX_PRODUCT_NAME_LENGTH) {
        res.status(400).json({
          success: false,
          message: `name must be at most ${MAX_PRODUCT_NAME_LENGTH} characters`,
          requestId,
        });
        return;
      }

      updates.name = name;
    }

    if (req.body?.description != null) {
      if (typeof req.body.description !== "string") {
        res.status(400).json({ success: false, message: "description must be a string", requestId });
        return;
      }

      const description = req.body.description.trim();
      if (!description) {
        res.status(400).json({ success: false, message: "description cannot be empty", requestId });
        return;
      }

      if (description.length > MAX_PRODUCT_DESCRIPTION_LENGTH) {
        res.status(400).json({
          success: false,
          message: `description must be at most ${MAX_PRODUCT_DESCRIPTION_LENGTH} characters`,
          requestId,
        });
        return;
      }

      updates.description = description;
    }

    if (req.body?.region != null) {
      if (typeof req.body.region !== "string") {
        res.status(400).json({ success: false, message: "region must be a string", requestId });
        return;
      }

      const region = req.body.region.trim();
      if (!region) {
        res.status(400).json({ success: false, message: "region cannot be empty", requestId });
        return;
      }

      if (!validRegions.has(region.toLowerCase())) {
        res.status(400).json({ success: false, message: "Invalid region or country", requestId });
        return;
      }

      updates.region = region;
    }

    const hasCallbackurlField = Object.prototype.hasOwnProperty.call(req.body || {}, "callbackurl");
    const hasCallbackUrlField = Object.prototype.hasOwnProperty.call(req.body || {}, "callbackUrl");

    if (hasCallbackurlField || hasCallbackUrlField) {
      if (!product.isAPI) {
        res.status(400).json({
          success: false,
          message: "This product is not configured as API",
          requestId,
        });
        return;
      }

      const callbackInput = typeof req.body?.callbackurl === "string"
        ? req.body.callbackurl
        : (typeof req.body?.callbackUrl === "string" ? req.body.callbackUrl : "");

      const callbackurl = validateCallbackUrl(callbackInput);
      if (!callbackurl) {
        res.status(400).json({
          success: false,
          message: "callbackurl must be a valid http or https URL",
          requestId,
        });
        return;
      }

      updates.apiCallbackUrl = callbackurl;
    }

    if (req.body?.marketPrice != null) {
      if (typeof req.body.marketPrice !== "number" || !Number.isFinite(req.body.marketPrice)) {
        res.status(400).json({ success: false, message: "marketPrice must be a valid number", requestId });
        return;
      }

      if (req.body.marketPrice <= 0) {
        res.status(400).json({ success: false, message: "marketPrice must be greater than 0", requestId });
        return;
      }

      updates.marketPrice = parseFloat(req.body.marketPrice.toFixed(2));
    }

    if (req.body?.price != null) {
      if (typeof req.body.price !== "number" || !Number.isFinite(req.body.price)) {
        res.status(400).json({ success: false, message: "price must be a valid number", requestId });
        return;
      }

      if (req.body.price <= 0) {
        res.status(400).json({ success: false, message: "price must be greater than 0", requestId });
        return;
      }

      updates.price = parseFloat(req.body.price.toFixed(2));
    }

    if (req.body?.isActive != null) {
      if (typeof req.body.isActive !== "boolean") {
        res.status(400).json({ success: false, message: "isActive must be true or false", requestId });
        return;
      }

      updates.isActive = req.body.isActive;
    }

    if (Object.keys(updates).length === 0) {
      res.status(400).json({
        success: false,
        message: "No valid fields to update",
        requestId,
      });
      return;
    }

    const finalMarketPrice = updates.marketPrice ?? product.marketPrice;
    const finalPrice = updates.price ?? product.price;

    if (finalPrice > finalMarketPrice) {
      res.status(400).json({
        success: false,
        message: "price cannot exceed marketPrice",
        requestId,
      });
      return;
    }

    updates.discount = parseFloat((((finalMarketPrice - finalPrice) / finalMarketPrice) * 100).toFixed(2));

    await catalogsDB.collection<Product>("Products").updateOne(
      { productId, userId: store.userId },
      { $set: updates }
    );

    const updated = await catalogsDB.collection<Product>("Products").findOne({ productId, userId: store.userId });

    res.status(200).json({
      success: true,
      message: "Product updated successfully",
      product: updated ? mapProductForResponse(updated) : null,
      requestId,
    });
  } catch (error) {
    logger.error({ err: error, requestId }, "Failed to update merchant product");
    res.status(500).json({
      success: false,
      message: "Failed to update merchant product",
      requestId,
    });
  }
};

router.patch("/merchant/products", requireMerchantAuth, updateMerchantProductHandler);
router.put("/merchant/products", requireMerchantAuth, updateMerchantProductHandler);

router.delete("/merchant/products", requireMerchantAuth, async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const merchantReq = req as MerchantAuthenticatedRequest;
    const store = merchantReq.merchantStore!;
    const productId = getQueryStringValue(req, "productId");

    if (!productId) {
      res.status(400).json({
        success: false,
        message: "productId query parameter is required",
        requestId,
      });
      return;
    }

    const catalogsDB = getCatalogsDB();
    const product = await catalogsDB.collection<Product>("Products").findOne({ productId, userId: store.userId });

    if (!product) {
      res.status(404).json({
        success: false,
        message: "Product not found or does not belong to this merchant",
        requestId,
      });
      return;
    }

    await catalogsDB.collection<Product>("Products").updateOne(
      { productId, userId: store.userId },
      { $set: { isActive: false } }
    );

    const updated = await catalogsDB.collection<Product>("Products").findOne({ productId, userId: store.userId });

    res.status(200).json({
      success: true,
      message: "Product archived successfully",
      product: updated ? mapProductForResponse(updated) : null,
      requestId,
    });
  } catch (error) {
    logger.error({ err: error, requestId }, "Failed to archive merchant product");
    res.status(500).json({
      success: false,
      message: "Failed to archive merchant product",
      requestId,
    });
  }
});

router.patch("/merchant/products/callback-url", requireMerchantAuth, async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const merchantReq = req as MerchantAuthenticatedRequest;
    const store = merchantReq.merchantStore!;
    const productId = getQueryStringValue(req, "productId");

    if (!productId) {
      res.status(400).json({
        success: false,
        message: "productId query parameter is required",
        requestId,
      });
      return;
    }

    const callbackInput = typeof req.body?.callbackurl === "string"
      ? req.body.callbackurl
      : (typeof req.body?.callbackUrl === "string" ? req.body.callbackUrl : "");

    const callbackurl = validateCallbackUrl(callbackInput);
    if (!callbackurl) {
      res.status(400).json({
        success: false,
        message: "callbackurl must be a valid http or https URL",
        requestId,
      });
      return;
    }

    const catalogsDB = getCatalogsDB();
    const product = await catalogsDB.collection<Product>("Products").findOne({ productId, userId: store.userId });

    if (!product) {
      res.status(404).json({
        success: false,
        message: "Product not found or does not belong to this merchant",
        requestId,
      });
      return;
    }

    if (!product.isAPI) {
      res.status(400).json({
        success: false,
        message: "This product is not configured as API",
        requestId,
      });
      return;
    }

    await catalogsDB.collection<Product>("Products").updateOne(
      { productId, userId: store.userId },
      { $set: { apiCallbackUrl: callbackurl } }
    );

    const updated = await catalogsDB.collection<Product>("Products").findOne({ productId, userId: store.userId });

    res.status(200).json({
      success: true,
      message: "Product callback URL updated successfully",
      callbackurl: updated?.apiCallbackUrl || callbackurl,
      product: updated ? mapProductForResponse(updated) : null,
      requestId,
    });
  } catch (error) {
    logger.error({ err: error, requestId }, "Failed to update product callback URL");
    res.status(500).json({
      success: false,
      message: "Failed to update product callback URL",
      requestId,
    });
  }
});

router.post("/merchant/products", requireMerchantAuth, async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const merchantReq = req as MerchantAuthenticatedRequest;
    const store = merchantReq.merchantStore!;

    if (!store.isActive) {
      res.status(403).json({
        success: false,
        message: "Store is not active",
        requestId,
      });
      return;
    }

    const catalog = typeof req.body?.catalog === "string" ? req.body.catalog.trim() : "";
    const category = typeof req.body?.category === "string" ? req.body.category.trim() : "";
    const region = typeof req.body?.region === "string" ? req.body.region.trim() : "";
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const description = typeof req.body?.description === "string" ? req.body.description.trim() : "";
    const type = typeof req.body?.type === "string" ? req.body.type.trim() : "";
    const marketPrice = req.body?.marketPrice;
    const price = req.body?.price;

    if (!catalog || !category || !region || !name || !description || !type) {
      res.status(400).json({
        success: false,
        message: "catalog, category, region, name, description, type, marketPrice and price are required",
        requestId,
      });
      return;
    }

    if (name.length > MAX_PRODUCT_NAME_LENGTH) {
      res.status(400).json({
        success: false,
        message: `name must be at most ${MAX_PRODUCT_NAME_LENGTH} characters`,
        requestId,
      });
      return;
    }

    if (description.length > MAX_PRODUCT_DESCRIPTION_LENGTH) {
      res.status(400).json({
        success: false,
        message: `description must be at most ${MAX_PRODUCT_DESCRIPTION_LENGTH} characters`,
        requestId,
      });
      return;
    }

    if (type !== "Auto" && type !== "Manual") {
      res.status(400).json({
        success: false,
        message: "type must be either Auto or Manual",
        requestId,
      });
      return;
    }

    if (typeof marketPrice !== "number" || !Number.isFinite(marketPrice) || marketPrice <= 0) {
      res.status(400).json({
        success: false,
        message: "marketPrice must be a number greater than 0",
        requestId,
      });
      return;
    }

    if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
      res.status(400).json({
        success: false,
        message: "price must be a number greater than 0",
        requestId,
      });
      return;
    }

    if (price > marketPrice) {
      res.status(400).json({
        success: false,
        message: "price cannot exceed marketPrice",
        requestId,
      });
      return;
    }

    const group = allGroups.find((entry) => entry.title.toLowerCase() === catalog.toLowerCase());
    if (!group) {
      res.status(400).json({
        success: false,
        message: "Invalid catalog",
        requestId,
      });
      return;
    }

    const categoryExists = group.categories.some((entry) => entry.name.toLowerCase() === category.toLowerCase());
    if (!categoryExists) {
      res.status(400).json({
        success: false,
        message: "Invalid category for this catalog",
        requestId,
      });
      return;
    }

    if (!validRegions.has(region.toLowerCase())) {
      res.status(400).json({
        success: false,
        message: "Invalid region or country",
        requestId,
      });
      return;
    }

    const discount = parseFloat((((marketPrice - price) / marketPrice) * 100).toFixed(2));

    const product: Product = {
      userId: store.userId,
      storeId: store.storeId,
      productId: crypto.randomUUID(),
      catalog,
      category,
      region,
      name,
      description,
      marketPrice: parseFloat(marketPrice.toFixed(2)),
      price: parseFloat(price.toFixed(2)),
      discount,
      type: type as Product["type"],
      isActive: false,
      isPromoted: false,
      isAPI: false,
      apiCallbackUrl: null,
      available: 0,
      sold: 0,
      availableCodes: [],
      soldCodes: [],
      manualOrderConfig: null,
      createdAt: new Date().toISOString(),
    };

    await getCatalogsDB().collection<Product>("Products").insertOne(product);

    res.status(201).json({
      success: true,
      message: "Product created successfully",
      product: mapProductForResponse(product),
      requestId,
    });
  } catch (error) {
    logger.error({ err: error, requestId }, "Failed to create merchant product");
    res.status(500).json({
      success: false,
      message: "Failed to create merchant product",
      requestId,
    });
  }
});

router.patch("/merchant/products/status", requireMerchantAuth, async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const merchantReq = req as MerchantAuthenticatedRequest;
    const store = merchantReq.merchantStore!;
    const productId = getQueryStringValue(req, "productId");

    if (!productId) {
      res.status(400).json({
        success: false,
        message: "productId query parameter is required",
        requestId,
      });
      return;
    }

    let nextActive: boolean | null = null;

    if (typeof req.body?.isActive === "boolean") {
      nextActive = req.body.isActive;
    } else if (typeof req.body?.status === "string") {
      const normalized = req.body.status.trim().toLowerCase();
      if (["enable", "enabled", "active", "on", "true"].includes(normalized)) {
        nextActive = true;
      } else if (["disable", "disabled", "inactive", "off", "false"].includes(normalized)) {
        nextActive = false;
      }
    }

    if (nextActive == null) {
      res.status(400).json({
        success: false,
        message: "Provide isActive as boolean or status as enable/disable",
        requestId,
      });
      return;
    }

    const catalogsDB = getCatalogsDB();
    const product = await catalogsDB.collection<Product>("Products").findOne({ productId, userId: store.userId });

    if (!product) {
      res.status(404).json({
        success: false,
        message: "Product not found or does not belong to this merchant",
        requestId,
      });
      return;
    }

    if (product.isActive === nextActive) {
      res.status(409).json({
        success: false,
        message: nextActive ? "Product is already enabled" : "Product is already disabled",
        requestId,
      });
      return;
    }

    if (nextActive) {
      if (!store.isActive) {
        res.status(403).json({
          success: false,
          message: "Store is not active. Product cannot be enabled",
          requestId,
        });
        return;
      }

      if (product.available <= 0) {
        res.status(400).json({
          success: false,
          message: "Product has no available stock and cannot be enabled",
          requestId,
        });
        return;
      }
    }

    await catalogsDB.collection<Product>("Products").updateOne(
      { productId, userId: store.userId },
      { $set: { isActive: nextActive } }
    );

    const updated = await catalogsDB.collection<Product>("Products").findOne({ productId, userId: store.userId });

    res.status(200).json({
      success: true,
      message: nextActive ? "Product enabled successfully" : "Product disabled successfully",
      product: updated ? mapProductForResponse(updated) : null,
      requestId,
    });
  } catch (error) {
    logger.error({ err: error, requestId }, "Failed to update merchant product status");
    res.status(500).json({
      success: false,
      message: "Failed to update merchant product status",
      requestId,
    });
  }
});

const addMerchantAutoStockHandler = async (req: Request, res: Response): Promise<void> => {
  const requestId = getRequestId(req);

  try {
    const merchantReq = req as MerchantAuthenticatedRequest;
    const store = merchantReq.merchantStore!;
    const productId = getQueryStringValue(req, "productId");

    if (!productId) {
      res.status(400).json({
        success: false,
        message: "productId query parameter is required",
        requestId,
      });
      return;
    }

    const rawCodes = Array.isArray(req.body?.codes) ? req.body.codes : null;
    if (!rawCodes || rawCodes.length === 0) {
      res.status(400).json({
        success: false,
        message: "codes must be a non-empty array",
        requestId,
      });
      return;
    }

    const codes = rawCodes
      .map((value: unknown) => (typeof value === "string" ? value.trim() : ""))
      .filter((value: string) => value.length > 0);

    if (codes.length === 0) {
      res.status(400).json({
        success: false,
        message: "codes must contain at least one non-empty string",
        requestId,
      });
      return;
    }

    const catalogsDB = getCatalogsDB();
    const product = await catalogsDB.collection<Product>("Products").findOne({ productId, userId: store.userId });

    if (!product) {
      res.status(404).json({
        success: false,
        message: "Product not found or does not belong to this merchant",
        requestId,
      });
      return;
    }

    if (product.type !== "Auto") {
      res.status(400).json({
        success: false,
        message: "This endpoint only supports Auto products",
        requestId,
      });
      return;
    }

    if (product.isAPI) {
      res.status(400).json({
        success: false,
        message: "This is an API product. Use the API stock endpoint instead",
        requestId,
      });
      return;
    }

    const encryptedCodes = codes.map((code: string) => encryptCode(code));

    await catalogsDB.collection<Product>("Products").updateOne(
      { productId, userId: store.userId },
      {
        $push: { availableCodes: { $each: encryptedCodes } },
        $inc: { available: encryptedCodes.length },
        $set: { isActive: true },
      }
    );

    const updated = await catalogsDB.collection<Product>("Products").findOne({ productId, userId: store.userId });

    res.status(200).json({
      success: true,
      message: `${encryptedCodes.length} code(s) added successfully`,
      available: updated?.available ?? product.available + encryptedCodes.length,
      product: updated ? mapProductForResponse(updated) : null,
      requestId,
    });
  } catch (error) {
    logger.error({ err: error, requestId }, "Failed to add auto stock for merchant product");
    res.status(500).json({
      success: false,
      message: "Failed to add auto stock for merchant product",
      requestId,
    });
  }
};

const addMerchantManualStockHandler = async (req: Request, res: Response): Promise<void> => {
  const requestId = getRequestId(req);

  try {
    const merchantReq = req as MerchantAuthenticatedRequest;
    const store = merchantReq.merchantStore!;
    const productId = getQueryStringValue(req, "productId");

    if (!productId) {
      res.status(400).json({
        success: false,
        message: "productId query parameter is required",
        requestId,
      });
      return;
    }

    const quantity = req.body?.quantity;
    if (!Number.isInteger(quantity) || quantity <= 0) {
      res.status(400).json({
        success: false,
        message: "quantity must be a positive integer",
        requestId,
      });
      return;
    }

    const isadditional = req.body?.isadditional ?? false;
    if (typeof isadditional !== "boolean") {
      res.status(400).json({
        success: false,
        message: "isadditional must be true or false",
        requestId,
      });
      return;
    }

    const workingDaysInput = req.body?.workingDays;
    if (workingDaysInput != null && !Array.isArray(workingDaysInput)) {
      res.status(400).json({
        success: false,
        message: "workingDays must be an array",
        requestId,
      });
      return;
    }

    const workingDays: ProductManualWorkingDay[] = [];
    const seenDays = new Set<ProductManualWorkingDay["day"]>();

    for (const dayEntry of workingDaysInput || []) {
      if (!dayEntry || typeof dayEntry !== "object") {
        res.status(400).json({
          success: false,
          message: "Each working day must be an object",
          requestId,
        });
        return;
      }

      const day = String((dayEntry as { day?: string }).day || "").toUpperCase() as ProductManualWorkingDay["day"];
      const openTime = String((dayEntry as { openTime?: string }).openTime || "").trim();
      const closeTime = String((dayEntry as { closeTime?: string }).closeTime || "").trim();

      if (!VALID_WORKING_DAYS.includes(day)) {
        res.status(400).json({
          success: false,
          message: "Invalid working day provided",
          requestId,
        });
        return;
      }

      if (seenDays.has(day)) {
        res.status(400).json({
          success: false,
          message: `Duplicate working day: ${day}`,
          requestId,
        });
        return;
      }

      if (!MANUAL_TIME_PATTERN.test(openTime) || !MANUAL_TIME_PATTERN.test(closeTime)) {
        res.status(400).json({
          success: false,
          message: `Working day time must be in 24-hour HH:MM format for ${day}`,
          requestId,
        });
        return;
      }

      if (parseTimeToMinutes(closeTime) <= parseTimeToMinutes(openTime)) {
        res.status(400).json({
          success: false,
          message: `closeTime must be after openTime for ${day}`,
          requestId,
        });
        return;
      }

      seenDays.add(day);
      workingDays.push({ day, openTime, closeTime });
    }

    let characterCount: number | null = null;
    let orderDescription: string | null = null;

    if (isadditional) {
      const rawOrderDescription = typeof req.body?.orderDescription === "string"
        ? req.body.orderDescription.trim()
        : "";

      if (!rawOrderDescription) {
        res.status(400).json({
          success: false,
          message: "orderDescription is required when isadditional is true",
          requestId,
        });
        return;
      }

      if (rawOrderDescription.length > 2000) {
        res.status(400).json({
          success: false,
          message: "orderDescription must be at most 2000 characters",
          requestId,
        });
        return;
      }

      if (req.body?.characterCount != null) {
        if (!Number.isInteger(req.body.characterCount) || req.body.characterCount <= 0) {
          res.status(400).json({
            success: false,
            message: "characterCount must be a positive integer",
            requestId,
          });
          return;
        }

        characterCount = req.body.characterCount;
      }

      orderDescription = rawOrderDescription;
    } else {
      const hasCharacterCount = req.body?.characterCount != null;
      const hasOrderDescription = typeof req.body?.orderDescription === "string" && req.body.orderDescription.trim().length > 0;
      if (hasCharacterCount || hasOrderDescription) {
        res.status(400).json({
          success: false,
          message: "characterCount and orderDescription can only be used when isadditional is true",
          requestId,
        });
        return;
      }
    }

    const catalogsDB = getCatalogsDB();
    const product = await catalogsDB.collection<Product>("Products").findOne({ productId, userId: store.userId });

    if (!product) {
      res.status(404).json({
        success: false,
        message: "Product not found or does not belong to this merchant",
        requestId,
      });
      return;
    }

    if (product.type !== "Manual") {
      res.status(400).json({
        success: false,
        message: "This endpoint only supports Manual products",
        requestId,
      });
      return;
    }

    if (product.isAPI) {
      res.status(400).json({
        success: false,
        message: "This is an API product. Use the API stock endpoint instead",
        requestId,
      });
      return;
    }

    const manualOrderConfig: ProductManualOrderConfig = {
      isadditional,
      characterCount,
      orderDescription,
      workingDays,
    };

    await catalogsDB.collection<Product>("Products").updateOne(
      { productId, userId: store.userId },
      {
        $inc: { available: quantity },
        $set: {
          isActive: true,
          manualOrderConfig,
        },
      }
    );

    const updated = await catalogsDB.collection<Product>("Products").findOne({ productId, userId: store.userId });

    res.status(200).json({
      success: true,
      message: `${quantity} manual slot(s) added successfully`,
      available: updated?.available ?? product.available + quantity,
      product: updated ? mapProductForResponse(updated) : null,
      requestId,
    });
  } catch (error) {
    logger.error({ err: error, requestId }, "Failed to add manual stock for merchant product");
    res.status(500).json({
      success: false,
      message: "Failed to add manual stock for merchant product",
      requestId,
    });
  }
};

const updateMerchantProductStockHandler = async (req: Request, res: Response): Promise<void> => {
  const modeRaw = typeof req.body?.mode === "string"
    ? req.body.mode.trim().toLowerCase()
    : (typeof req.body?.type === "string" ? req.body.type.trim().toLowerCase() : "");

  if (modeRaw === "auto") {
    await addMerchantAutoStockHandler(req, res);
    return;
  }

  if (modeRaw === "manual") {
    await addMerchantManualStockHandler(req, res);
    return;
  }

  const hasCodesArray = Array.isArray(req.body?.codes);
  const hasQuantity = req.body?.quantity != null;

  if (hasCodesArray && !hasQuantity) {
    await addMerchantAutoStockHandler(req, res);
    return;
  }

  if (hasQuantity && !hasCodesArray) {
    await addMerchantManualStockHandler(req, res);
    return;
  }

  const requestId = getRequestId(req);
  res.status(400).json({
    success: false,
    message: "Provide mode as auto/manual, or send either codes[] for auto stock or quantity for manual stock",
    requestId,
  });
};

router.patch("/merchant/products/stock", requireMerchantAuth, updateMerchantProductStockHandler);
router.put("/merchant/products/stock", requireMerchantAuth, updateMerchantProductStockHandler);

router.post("/merchant/products/stock/auto", requireMerchantAuth, addMerchantAutoStockHandler);
router.post("/merchant/products/stock/manual", requireMerchantAuth, addMerchantManualStockHandler);

router.get("/merchant/orders", requireMerchantAuth, async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const merchantReq = req as MerchantAuthenticatedRequest;
    const store = merchantReq.merchantStore!;
    const orderId = getQueryStringValue(req, "orderId");

    if (orderId) {
      const walletsDB = getWalletsDB();
      const catalogsDB = getCatalogsDB();

      const order = await walletsDB.collection<Order>("Orders").findOne({ orderId, sellerId: store.userId });
      if (!order) {
        res.status(404).json({
          success: false,
          message: "Order not found or does not belong to this merchant",
          requestId,
        });
        return;
      }

      const product = await catalogsDB.collection<Product>("Products").findOne({ productId: order.productId });

      res.status(200).json({
        success: true,
        message: "Order fetched successfully",
        order: mapOrderForResponse(order, product),
        requestId,
      });
      return;
    }

    const status = typeof req.query.status === "string" ? req.query.status.trim() : "";
    const type = typeof req.query.type === "string" ? req.query.type.trim() : "";

    const parsedPage = Number.parseInt(String(req.query.page ?? "1"), 10);
    const parsedLimit = Number.parseInt(String(req.query.limit ?? String(DEFAULT_PAGE_SIZE)), 10);

    if (!Number.isFinite(parsedPage) || parsedPage <= 0) {
      res.status(400).json({
        success: false,
        message: "page must be a positive integer",
        requestId,
      });
      return;
    }

    if (!Number.isFinite(parsedLimit) || parsedLimit <= 0 || parsedLimit > MAX_PAGE_SIZE) {
      res.status(400).json({
        success: false,
        message: `limit must be between 1 and ${MAX_PAGE_SIZE}`,
        requestId,
      });
      return;
    }

    const filter: Filter<Order> = { sellerId: store.userId };

    if (status) {
      filter.status = status;
    }

    if (type) {
      filter.type = type;
    }

    const from = typeof req.query.from === "string" ? req.query.from.trim() : "";
    const to = typeof req.query.to === "string" ? req.query.to.trim() : "";

    if (from || to) {
      const createdAtFilter: { $gte?: string; $lte?: string } = {};

      if (from) {
        const parsedFrom = new Date(from);
        if (Number.isNaN(parsedFrom.getTime())) {
          res.status(400).json({
            success: false,
            message: "from must be a valid date",
            requestId,
          });
          return;
        }
        createdAtFilter.$gte = parsedFrom.toISOString();
      }

      if (to) {
        const parsedTo = new Date(to);
        if (Number.isNaN(parsedTo.getTime())) {
          res.status(400).json({
            success: false,
            message: "to must be a valid date",
            requestId,
          });
          return;
        }
        createdAtFilter.$lte = parsedTo.toISOString();
      }

      filter.createdAt = createdAtFilter as Order["createdAt"];
    }

    const walletsDB = getWalletsDB();
    const catalogsDB = getCatalogsDB();
    const skip = (parsedPage - 1) * parsedLimit;

    const [total, orders] = await Promise.all([
      walletsDB.collection<Order>("Orders").countDocuments(filter),
      walletsDB.collection<Order>("Orders").find(filter).sort({ createdAt: -1 }).skip(skip).limit(parsedLimit).toArray(),
    ]);

    const productIds = [...new Set(orders.map((order) => order.productId))];
    const products = productIds.length > 0
      ? await catalogsDB.collection<Product>("Products").find({ productId: { $in: productIds } }).toArray()
      : [];
    const productMap = new Map(products.map((product) => [product.productId, product]));

    const totalPages = total === 0 ? 0 : Math.ceil(total / parsedLimit);

    res.status(200).json({
      success: true,
      message: `${orders.length} order(s) fetched`,
      orders: orders.map((order) => mapOrderForResponse(order, productMap.get(order.productId) || null)),
      pagination: {
        page: parsedPage,
        limit: parsedLimit,
        total,
        totalPages,
        hasNextPage: parsedPage < totalPages,
        hasPreviousPage: parsedPage > 1,
      },
      requestId,
    });
  } catch (error) {
    logger.error({ err: error, requestId }, "Failed to fetch merchant orders");
    res.status(500).json({
      success: false,
      message: "Failed to fetch merchant orders",
      requestId,
    });
  }
});

const addMerchantOrderCodesHandler = async (req: Request, res: Response): Promise<void> => {
  const requestId = getRequestId(req);

  try {
    const merchantReq = req as MerchantAuthenticatedRequest;
    const store = merchantReq.merchantStore!;
    const orderId = getQueryStringValue(req, "orderId");

    if (!orderId?.trim()) {
      res.status(400).json({
        success: false,
        message: "orderId query parameter is required",
        requestId,
      });
      return;
    }

    const rawCodes = req.body?.codes;
    if (!Array.isArray(rawCodes) || rawCodes.length === 0) {
      res.status(400).json({
        success: false,
        message: "codes is required and must be a non-empty array",
        requestId,
      });
      return;
    }

    const trimmedCodes = rawCodes
      .map((value: unknown) => (typeof value === "string" ? value.trim() : ""))
      .filter((value: string) => value.length > 0);

    if (trimmedCodes.length === 0) {
      res.status(400).json({
        success: false,
        message: "codes must contain at least one non-empty string",
        requestId,
      });
      return;
    }

    const seenCodes = new Set<string>();
    for (const code of trimmedCodes) {
      if (seenCodes.has(code)) {
        res.status(400).json({
          success: false,
          message: "codes array contains duplicates",
          requestId,
        });
        return;
      }
      seenCodes.add(code);
    }

    const walletsDB = getWalletsDB();
    const catalogsDB = getCatalogsDB();

    const order = await walletsDB.collection<Order>("Orders").findOne({ orderId, sellerId: store.userId });
    if (!order) {
      res.status(404).json({
        success: false,
        message: "Order not found or does not belong to this merchant",
        requestId,
      });
      return;
    }

    if (order.status !== "pending") {
      res.status(409).json({
        success: false,
        message: `Only pending orders can receive codes. Current status: ${order.status}`,
        requestId,
      });
      return;
    }

    const existingCodesCount = (order.codes || []).length;
    const remainingBeforeAdd = order.quantity - existingCodesCount;

    if (remainingBeforeAdd <= 0) {
      res.status(409).json({
        success: false,
        message: "This order already has all required codes",
        requestedQuantity: order.quantity,
        codesAdded: existingCodesCount,
        remaining: 0,
        requestId,
      });
      return;
    }

    if (trimmedCodes.length > remainingBeforeAdd) {
      res.status(400).json({
        success: false,
        message: `You can only add ${remainingBeforeAdd} more code(s) for this order`,
        requestedQuantity: order.quantity,
        codesAdded: existingCodesCount,
        remaining: remainingBeforeAdd,
        requestId,
      });
      return;
    }

    const encryptedCodes = trimmedCodes.map((code) => encryptCode(code));

    const updateResult = await walletsDB.collection<Order>("Orders").updateOne(
      {
        orderId,
        sellerId: store.userId,
        status: "pending",
        $expr: {
          $lte: [
            { $add: [{ $size: { $ifNull: ["$codes", []] } }, encryptedCodes.length] },
            "$quantity",
          ],
        },
      },
      {
        $push: { codes: { $each: encryptedCodes } },
        $set: { statusUpdatedAt: new Date().toISOString() },
      }
    );

    if (updateResult.modifiedCount === 0) {
      const freshOrder = await walletsDB.collection<Order>("Orders").findOne({ orderId, sellerId: store.userId });
      const freshCodesCount = (freshOrder?.codes || []).length;

      res.status(409).json({
        success: false,
        message: "Order codes changed while processing. Fetch order and retry with remaining quantity",
        requestedQuantity: freshOrder?.quantity ?? order.quantity,
        codesAdded: freshCodesCount,
        remaining: Math.max((freshOrder?.quantity ?? order.quantity) - freshCodesCount, 0),
        requestId,
      });
      return;
    }

    const [updatedOrder, product] = await Promise.all([
      walletsDB.collection<Order>("Orders").findOne({ orderId, sellerId: store.userId }),
      catalogsDB.collection<Product>("Products").findOne({ productId: order.productId }),
    ]);

    const updatedCodesCount = (updatedOrder?.codes || []).length;

    const canAutoComplete = Boolean(
      updatedOrder
      && product
      && product.type !== "Manual"
      && updatedOrder.status === "pending"
      && updatedCodesCount >= updatedOrder.quantity
    );

    if (canAutoComplete) {
      if (typeof req.body?.fulfilmentNote !== "string" || req.body.fulfilmentNote.trim().length === 0) {
        req.body.fulfilmentNote = "Auto-completed after all required codes were delivered";
      }

      await completeMerchantOrderHandler(req, res);
      return;
    }

    res.status(200).json({
      success: true,
      message: `${trimmedCodes.length} code(s) added to order successfully`,
      requestedQuantity: updatedOrder?.quantity ?? order.quantity,
      codesAdded: updatedCodesCount,
      remaining: Math.max((updatedOrder?.quantity ?? order.quantity) - updatedCodesCount, 0),
      order: updatedOrder ? mapOrderForResponse(updatedOrder, product) : null,
      requestId,
    });
  } catch (error) {
    logger.error({ err: error, requestId }, "Failed to add codes to merchant order");
    res.status(500).json({
      success: false,
      message: "Failed to add codes to merchant order",
      requestId,
    });
  }
};

const completeMerchantOrderHandler = async (req: Request, res: Response): Promise<void> => {
  const requestId = getRequestId(req);

  try {
    const merchantReq = req as MerchantAuthenticatedRequest;
    const store = merchantReq.merchantStore!;
    const orderId = getQueryStringValue(req, "orderId");

    if (!orderId) {
      res.status(400).json({
        success: false,
        message: "orderId query parameter is required",
        requestId,
      });
      return;
    }

    const fulfilmentNote = typeof req.body?.fulfilmentNote === "string" ? req.body.fulfilmentNote.trim() : "";
    if (fulfilmentNote.length > 2000) {
      res.status(400).json({
        success: false,
        message: "fulfilmentNote must be at most 2000 characters",
        requestId,
      });
      return;
    }

    const walletsDB = getWalletsDB();
    const catalogsDB = getCatalogsDB();
    const db = getDB();

    const [order, sellerUser] = await Promise.all([
      walletsDB.collection<Order>("Orders").findOne({ orderId, sellerId: store.userId }),
      db.collection<User>("users").findOne({ id: store.userId }),
    ]);

    if (!order) {
      res.status(404).json({
        success: false,
        message: "Order not found or does not belong to this merchant",
        requestId,
      });
      return;
    }

    if (order.sellerId !== store.userId || order.storeId !== store.storeId) {
      res.status(403).json({
        success: false,
        message: "You can only complete orders that belong to your merchant store",
        requestId,
      });
      return;
    }

    const product = await catalogsDB.collection<Product>("Products").findOne({ productId: order.productId });
    if (!product) {
      res.status(404).json({
        success: false,
        message: "Product not found for this order",
        requestId,
      });
      return;
    }

    const isManual = product.type === "Manual";
    const normalizedStatus = order.status.trim().toLowerCase();
    const completionEligibleStatuses = new Set(["pending", "billed", "pending_payment", "pending_fulfillment"]);

    if (normalizedStatus === "completed") {
      res.status(409).json({
        success: false,
        message: "Order is already completed",
        requestId,
      });
      return;
    }

    if (normalizedStatus === "refunded" || normalizedStatus === "cancelled" || normalizedStatus === "disputed") {
      res.status(409).json({
        success: false,
        message: `Order cannot be completed from status: ${order.status}`,
        requestId,
      });
      return;
    }

    const isPendingLikeStatus = completionEligibleStatuses.has(normalizedStatus) || normalizedStatus.startsWith("pending");

    if (!isPendingLikeStatus) {
      res.status(409).json({
        success: false,
        message: `Only pending or billed orders can be completed. Current status: ${order.status}`,
        requestId,
      });
      return;
    }

    if (isManual && normalizedStatus !== "billed") {
      res.status(409).json({
        success: false,
        message: `Manual orders can only be completed from billed status. Current status: ${order.status}`,
        requestId,
      });
      return;
    }

    const cleanCode = typeof req.body?.code === "string" ? req.body.code.trim() : "";
    if (cleanCode.length > 2000) {
      res.status(400).json({
        success: false,
        message: "code must be at most 2000 characters",
        requestId,
      });
      return;
    }

    const now = new Date().toISOString();

    const nextCodes = cleanCode ? [...(order.codes || []), cleanCode] : (order.codes || []);

    if (!isManual) {
      await walletsDB.collection<Balance>("Balances").updateOne(
        { userId: order.sellerId },
        { $inc: { suspendedBalance: order.amount } }
      );
    }

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

    await walletsDB.collection<Order>("Orders").updateOne(
      { orderId, sellerId: store.userId },
      {
        $set: {
          status: "completed",
          codes: nextCodes,
          fulfilledAt: now,
          fulfilledBy: store.userId,
          fulfilmentNote: fulfilmentNote || null,
          statusUpdatedAt: now,
        },
      }
    );

    const updatedOrder = await walletsDB.collection<Order>("Orders").findOne({ orderId, sellerId: store.userId });

    await recordAuditEvent({
      eventName: "ADMIN_ACTION",
      category: "admin_action",
      outcome: "success",
      actorType: "user",
      actorId: store.userId,
      requestId,
      targetType: "order",
      targetId: order.orderId,
      metadata: {
        action: "MERCHANT_OVERRIDE_COMPLETE_ORDER",
        actorStoreId: store.storeId,
        actorSellerId: store.userId,
        previousStatus: order.status,
        newStatus: "completed",
        orderType: order.type,
      },
    });

    if (updatedOrder) {
      await sendMerchantCompletionEmails({
        db,
        walletsDB,
        order: updatedOrder,
        product,
        store,
        sellerUser,
        fulfilledAt: now,
        fulfilmentNote,
        deliveredCodes: nextCodes.map((code) => decryptCodeOrPlain(code)),
      });
    }

    res.status(200).json({
      success: true,
      message: isManual
        ? "Manual order fulfilled successfully"
        : "Order marked as completed; payout countdown started",
      order: updatedOrder ? mapOrderForResponse(updatedOrder, product) : null,
      requestId,
    });
  } catch (error) {
    logger.error({ err: error, requestId }, "Failed to complete merchant order");
    res.status(500).json({
      success: false,
      message: "Failed to complete merchant order",
      requestId,
    });
  }
};

const refundMerchantOrderHandler = async (req: Request, res: Response): Promise<void> => {
  const requestId = getRequestId(req);

  try {
    const merchantReq = req as MerchantAuthenticatedRequest;
    const store = merchantReq.merchantStore!;
    const orderId = getQueryStringValue(req, "orderId");

    if (!orderId) {
      res.status(400).json({
        success: false,
        message: "orderId query parameter is required",
        requestId,
      });
      return;
    }

    const walletsDB = getWalletsDB();
    const catalogsDB = getCatalogsDB();
    const db = getDB();

    const order = await walletsDB.collection<Order>("Orders").findOne({ orderId, sellerId: store.userId });
    if (!order) {
      res.status(404).json({
        success: false,
        message: "Order not found or does not belong to this merchant",
        requestId,
      });
      return;
    }

    if (order.buyerId === "anon-gameket-id") {
      res.status(400).json({
        success: false,
        message: "Refunds are not available for guest purchases",
        requestId,
      });
      return;
      
    }

    if (order.isReleased) {
      res.status(400).json({
        success: false,
        message: "Cannot refund an already released order",
        requestId,
      });
      return;
    }

    if (order.status === "refunded") {
      res.status(400).json({
        success: false,
        message: "Order has already been refunded",
        requestId,
      });
      return;
    }

    const now = new Date().toISOString();
    if (order.releasedAt <= now) {
      res.status(400).json({
        success: false,
        message: "Cannot refund because release period has already passed",
        requestId,
      });
      return;
    }

    const quantityInput = req.body?.quantity;
    if (quantityInput != null) {
      if (!Number.isInteger(quantityInput) || quantityInput <= 0) {
        res.status(400).json({
          success: false,
          message: "quantity must be a positive integer",
          requestId,
        });
        return;
      }

      if (quantityInput !== order.quantity) {
        res.status(400).json({
          success: false,
          message: "Partial refunds are not supported on this endpoint; quantity must match the full order",
          requestId,
        });
        return;
      }
    }

    await walletsDB.collection<Balance>("Balances").updateOne(
      { userId: order.buyerId },
      { $inc: { availableBalance: order.totalAmount } }
    );

    if (order.isReleased) {
      await walletsDB.collection<Balance>("Balances").updateOne(
        { userId: order.sellerId },
        { $inc: { availableBalance: -order.amount } }
      );
    } else if (order.status !== "pending") {
      await walletsDB.collection<Balance>("Balances").updateOne(
        { userId: order.sellerId },
        { $inc: { suspendedBalance: -order.amount } }
      );
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

    if (order.buyerTransactionId) {
      await walletsDB.collection<Transaction>("Transactions").updateOne(
        { id: order.buyerTransactionId },
        { $set: { status: "refunded" } }
      );
    }

    if (order.sellerTransactionId) {
      await walletsDB.collection<Transaction>("Transactions").updateOne(
        { id: order.sellerTransactionId },
        { $set: { status: "refunded" } }
      );
    }

    const buyerRefundTxnId = crypto.randomBytes(24).toString("base64").replace(/[+/=]/g, "");
    await walletsDB.collection<Transaction>("Transactions").insertOne({
      userId: order.buyerId,
      id: buyerRefundTxnId,
      type: "Refund",
      status: "completed",
      method: "balance",
      amount: order.totalAmount,
      createdAt: now,
    } as Transaction);

    await walletsDB.collection<Order>("Orders").updateOne(
      { orderId, sellerId: store.userId },
      { $set: { status: "refunded", isReleased: true, statusUpdatedAt: now } }
    );

    const [updatedOrder, product, sellerUser] = await Promise.all([
      walletsDB.collection<Order>("Orders").findOne({ orderId, sellerId: store.userId }),
      catalogsDB.collection<Product>("Products").findOne({ productId: order.productId }),
      db.collection<User>("users").findOne({ id: store.userId }),
    ]);

    await recordAuditEvent({
      eventName: "ADMIN_ACTION",
      category: "admin_action",
      outcome: "success",
      actorType: "user",
      actorId: store.userId,
      requestId,
      targetType: "order",
      targetId: order.orderId,
      metadata: {
        action: "MERCHANT_REFUND_ORDER",
        actorStoreId: store.storeId,
        actorSellerId: store.userId,
        previousStatus: order.status,
        newStatus: "refunded",
        orderType: order.type,
        refundAmount: order.totalAmount,
      },
    });

    if (updatedOrder && product) {
      await sendMerchantRefundEmails({
        db,
        walletsDB,
        order: updatedOrder,
        product,
        refundedAt: now,
        refundAmount: order.totalAmount,
      });
    }

    res.status(200).json({
      success: true,
      message: "Order refunded successfully",
      order: updatedOrder ? mapOrderForResponse(updatedOrder, product) : null,
      requestId,
    });
  } catch (error) {
    logger.error({ err: error, requestId }, "Failed to refund merchant order");
    res.status(500).json({
      success: false,
      message: "Failed to refund merchant order",
      requestId,
    });
  }
};

const cancelMerchantOrderHandler = async (req: Request, res: Response): Promise<void> => {
  const requestId = getRequestId(req);

  try {
    const merchantReq = req as MerchantAuthenticatedRequest;
    const store = merchantReq.merchantStore!;
    const orderId = getQueryStringValue(req, "orderId");

    if (!orderId) {
      res.status(400).json({
        success: false,
        message: "orderId query parameter is required",
        requestId,
      });
      return;
    }

    const declineReason = typeof req.body?.declineReason === "string" ? req.body.declineReason.trim() : "";
    if (declineReason.length > 2000) {
      res.status(400).json({
        success: false,
        message: "declineReason must be at most 2000 characters",
        requestId,
      });
      return;
    }

    const walletsDB = getWalletsDB();
    const catalogsDB = getCatalogsDB();
    const db = getDB();

    const order = await walletsDB.collection<Order>("Orders").findOne({ orderId, sellerId: store.userId });
    if (!order) {
      res.status(404).json({
        success: false,
        message: "Order not found or does not belong to this merchant",
        requestId,
      });
      return;
    }

    if (order.sellerId !== store.userId || order.storeId !== store.storeId) {
      res.status(403).json({
        success: false,
        message: "You can only cancel orders that belong to your merchant store",
        requestId,
      });
      return;
    }

    const normalizedStatus = order.status.trim().toLowerCase();
    const isPendingLikeStatus = normalizedStatus === "pending" || normalizedStatus.startsWith("pending");
    const canCancelStatus = isPendingLikeStatus || normalizedStatus === "billed" || normalizedStatus === "completed";

    if (normalizedStatus === "cancelled") {
      res.status(409).json({
        success: false,
        message: "Order is already cancelled",
        requestId,
      });
      return;
    }

    if (normalizedStatus === "refunded") {
      res.status(409).json({
        success: false,
        message: "Order has already been refunded and cannot be cancelled",
        requestId,
      });
      return;
    }

    if (normalizedStatus === "disputed") {
      res.status(409).json({
        success: false,
        message: "Disputed orders cannot be cancelled via this endpoint",
        requestId,
      });
      return;
    }

    if (!canCancelStatus) {
      res.status(409).json({
        success: false,
        message: `Order cannot be cancelled from status: ${order.status}`,
        requestId,
      });
      return;
    }

    const now = new Date().toISOString();
    if (order.isReleased || order.releasedAt <= now) {
      res.status(400).json({
        success: false,
        message: "Cannot cancel because the order is already released",
        requestId,
      });
      return;
    }

    const isAnonBuyer = order.buyerId === "anon-gameket-id";

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
    } else if (!isPendingLikeStatus) {
      await walletsDB.collection<Balance>("Balances").updateOne(
        { userId: order.sellerId },
        { $inc: { suspendedBalance: -order.amount } }
      );
    }

    if (order.buyerTransactionId) {
      await walletsDB.collection<Transaction>("Transactions").updateOne(
        { id: order.buyerTransactionId },
        { $set: { status: "refunded" } }
      );
    }

    if (order.sellerTransactionId) {
      await walletsDB.collection<Transaction>("Transactions").updateOne(
        { id: order.sellerTransactionId },
        { $set: { status: "refunded" } }
      );
    }

    if (!isAnonBuyer) {
      const buyerRefundTxnId = crypto.randomBytes(24).toString("base64").replace(/[+/=]/g, "");
      await walletsDB.collection<Transaction>("Transactions").insertOne({
        userId: order.buyerId,
        id: buyerRefundTxnId,
        type: "Refund",
        status: "completed",
        method: "balance",
        amount: order.totalAmount,
        createdAt: now,
      } as Transaction);
    }

    await walletsDB.collection<Order>("Orders").updateOne(
      { orderId, sellerId: store.userId },
      {
        $set: {
          status: "cancelled",
          isReleased: true,
          declinedAt: now,
          declineReason: declineReason || "Order cancelled by merchant",
          statusUpdatedAt: now,
        },
      }
    );

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

    await recordAuditEvent({
      eventName: "ADMIN_ACTION",
      category: "admin_action",
      outcome: "success",
      actorType: "user",
      actorId: store.userId,
      requestId,
      targetType: "order",
      targetId: order.orderId,
      metadata: {
        action: "MERCHANT_CANCEL_ORDER",
        actorStoreId: store.storeId,
        actorSellerId: store.userId,
        previousStatus: order.status,
        newStatus: "cancelled",
        isAnonBuyer,
      },
    });

    const [updatedOrder, product] = await Promise.all([
      walletsDB.collection<Order>("Orders").findOne({ orderId, sellerId: store.userId }),
      catalogsDB.collection<Product>("Products").findOne({ productId: order.productId }),
    ]);

    res.status(200).json({
      success: true,
      message: isAnonBuyer
        ? "Order cancelled successfully. Guest refund must be processed manually."
        : "Order cancelled and buyer refunded successfully",
      order: updatedOrder ? mapOrderForResponse(updatedOrder, product) : null,
      requestId,
    });
  } catch (error) {
    logger.error({ err: error, requestId }, "Failed to cancel merchant order");
    res.status(500).json({
      success: false,
      message: "Failed to cancel merchant order",
      requestId,
    });
  }
};

const updateMerchantOrderHandler = async (req: Request, res: Response): Promise<void> => {
  const statusRaw = typeof req.body?.status === "string" ? req.body.status.trim().toLowerCase() : "";

  if (statusRaw === "complete" || statusRaw === "completed") {
    req.body.status = "completed";
    await completeMerchantOrderHandler(req, res);
    return;
  }

  if (statusRaw === "refund" || statusRaw === "refunded") {
    req.body.status = "refunded";
    await refundMerchantOrderHandler(req, res);
    return;
  }

  if (statusRaw === "cancel" || statusRaw === "cancelled") {
    req.body.status = "cancelled";
    await cancelMerchantOrderHandler(req, res);
    return;
  }

  const requestId = getRequestId(req);
  res.status(400).json({
    success: false,
    message: "status must be either completed, refunded, or cancelled",
    requestId,
  });
};

router.patch("/merchant/orders", requireMerchantAuth, updateMerchantOrderHandler);
router.put("/merchant/orders", requireMerchantAuth, updateMerchantOrderHandler);

router.post("/merchant/orders/codes", requireMerchantAuth, addMerchantOrderCodesHandler);
router.patch("/merchant/orders/codes", requireMerchantAuth, addMerchantOrderCodesHandler);

router.post("/merchant/orders/complete", requireMerchantAuth, completeMerchantOrderHandler);
router.post("/merchant/orders/refund", requireMerchantAuth, refundMerchantOrderHandler);
router.post("/merchant/orders/cancel", requireMerchantAuth, cancelMerchantOrderHandler);

export default router;
