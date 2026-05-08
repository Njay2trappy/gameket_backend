import crypto from "crypto";
import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { MongoServerError } from "mongodb";
import { getCatalogsDB } from "../db.js";
import { getRequestId, logger } from "../logger.js";
import type { MerchantRequestNonce, Store } from "../types.js";

const router = Router();

const MERCHANT_SIGNATURE_WINDOW_MS = Number(process.env.MERCHANT_SIGNATURE_WINDOW_MS || 5 * 60 * 60 * 1000);
const MERCHANT_NONCE_TTL_MS = Number(process.env.MERCHANT_NONCE_TTL_MS || 10 * 60 * 1000);
const MERCHANT_RATE_LIMIT_WINDOW_MS = Number(process.env.MERCHANT_RATE_LIMIT_WINDOW_MS || 60 * 1000);
const MERCHANT_RATE_LIMIT_MAX = Number(process.env.MERCHANT_RATE_LIMIT_MAX || 120);
const MERCHANT_ANOMALY_WINDOW_MS = Number(process.env.MERCHANT_ANOMALY_WINDOW_MS || 10 * 60 * 1000);
const MERCHANT_ANOMALY_ALERT_THRESHOLD = Number(process.env.MERCHANT_ANOMALY_ALERT_THRESHOLD || 5);

const merchantRateLimitState = new Map<string, { windowStart: number; count: number }>();
const merchantAnomalyState = new Map<string, { windowStart: number; count: number }>();

type MerchantAuthenticatedRequest = Request & { merchantStore?: Store };

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

const enforceMerchantRateLimit = (storeId: string): { allowed: boolean; retryAfterSeconds: number } => {
  const now = Date.now();
  const state = merchantRateLimitState.get(storeId);

  if (!state || now - state.windowStart >= MERCHANT_RATE_LIMIT_WINDOW_MS) {
    merchantRateLimitState.set(storeId, { windowStart: now, count: 1 });
    return { allowed: true, retryAfterSeconds: 0 };
  }

  state.count += 1;
  merchantRateLimitState.set(storeId, state);

  if (state.count > MERCHANT_RATE_LIMIT_MAX) {
    const retryAfterMs = Math.max(0, MERCHANT_RATE_LIMIT_WINDOW_MS - (now - state.windowStart));
    return { allowed: false, retryAfterSeconds: Math.ceil(retryAfterMs / 1000) };
  }

  return { allowed: true, retryAfterSeconds: 0 };
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
  const timestampHeader = req.header("x-merchant-timestamp")?.trim() || "";
  const nonce = req.header("x-merchant-nonce")?.trim() || "";
  const signatureHeader = req.header("x-merchant-signature")?.trim() || "";

  const missingHeaders: string[] = [];
  if (!apiKey) missingHeaders.push("x-merchant-api-key");
  if (!timestampHeader) missingHeaders.push("x-merchant-timestamp");
  if (!nonce) missingHeaders.push("x-merchant-nonce");
  if (!signatureHeader) missingHeaders.push("x-merchant-signature");

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

  const rateLimit = enforceMerchantRateLimit(store.storeId);
  if (!rateLimit.allowed) {
    recordMerchantAnomaly(store.storeId, "rate_limit_exceeded", {
      requestId,
      clientIp,
      retryAfterSeconds: rateLimit.retryAfterSeconds,
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

  const timestampMs = parseTimestampMs(timestampHeader);
  if (!Number.isFinite(timestampMs)) {
    recordMerchantAnomaly(store.storeId, "invalid_timestamp", {
      requestId,
      clientIp,
      timestampHeader,
      path: req.originalUrl,
    });

    res.status(401).json({
      success: false,
      message: "Invalid merchant timestamp",
      requestId,
    });
    return;
  }

  const now = Date.now();
  if (Math.abs(now - timestampMs) > MERCHANT_SIGNATURE_WINDOW_MS) {
    recordMerchantAnomaly(store.storeId, "timestamp_out_of_window", {
      requestId,
      clientIp,
      timestampHeader,
      path: req.originalUrl,
    });

    res.status(401).json({
      success: false,
      message: "Merchant timestamp is outside the allowed window",
      requestId,
    });
    return;
  }

  if (nonce.length < 16 || nonce.length > 128) {
    recordMerchantAnomaly(store.storeId, "invalid_nonce_format", {
      requestId,
      clientIp,
      nonceLength: nonce.length,
      path: req.originalUrl,
    });

    res.status(401).json({
      success: false,
      message: "Invalid merchant nonce",
      requestId,
    });
    return;
  }

  const normalizedBody = stableStringify(req.body ?? {});
  const bodyHash = sha256Hex(normalizedBody);
  const signingPayload = buildSigningPayload(
    req.method,
    req.originalUrl.split("?")[0] || req.path,
    timestampHeader,
    nonce,
    bodyHash
  );

  const expectedSignature = hmacSha256Hex(store.merchantSecret, signingPayload);
  const providedSignature = normalizeSignature(signatureHeader);

  if (!secureSignatureMatch(providedSignature, expectedSignature)) {
    recordMerchantAnomaly(store.storeId, "invalid_signature", {
      requestId,
      clientIp,
      path: req.originalUrl,
      bodyHash,
    });

    res.status(401).json({
      success: false,
      message: "Invalid merchant signature",
      requestId,
    });
    return;
  }

  const nonceAccepted = await consumeMerchantNonce(store.storeId, nonce, timestampMs);
  if (!nonceAccepted) {
    recordMerchantAnomaly(store.storeId, "nonce_replay_detected", {
      requestId,
      clientIp,
      nonce,
      path: req.originalUrl,
    });

    res.status(409).json({
      success: false,
      message: "Replay detected: merchant nonce has already been used",
      requestId,
    });
    return;
  }

  req.merchantStore = store;
  next();
};

router.post(
  "/merchant/auth/check",
  async (req, res, next) => {
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
  },
  (req, res) => {
    const merchantReq = req as MerchantAuthenticatedRequest;
    const store = merchantReq.merchantStore!;

    res.status(200).json({
      success: true,
      message: "Merchant request authenticated",
      merchant: {
        storeId: store.storeId,
        storeName: store.storeName,
      },
      serverTime: new Date().toISOString(),
      requestId: getRequestId(req),
    });
  }
);

export default router;
