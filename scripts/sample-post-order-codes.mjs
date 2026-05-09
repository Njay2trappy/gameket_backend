#!/usr/bin/env node

import crypto from "crypto";

const requiredEnv = ["BASE_URL", "MERCHANT_API_KEY", "MERCHANT_SECRET", "ORDER_ID"];
const missing = requiredEnv.filter((name) => !process.env[name]);

if (missing.length > 0) {
  console.error(`Missing required environment variables: ${missing.join(", ")}`);
  process.exit(1);
}

const baseUrl = process.env.BASE_URL.replace(/\/+$/, "");
const merchantApiKey = process.env.MERCHANT_API_KEY;
const merchantSecret = process.env.MERCHANT_SECRET;
const orderId = process.env.ORDER_ID;
const codesInput = process.env.CODES || "CODE-001,CODE-002,CODE-003";

const codes = codesInput
  .split(",")
  .map((code) => code.trim())
  .filter(Boolean);

if (codes.length === 0) {
  console.error("CODES produced an empty list. Provide at least one code.");
  process.exit(1);
}

const method = "POST";
const path = `/merchant/orders/${orderId}/codes`;
const body = { codes };
const timestamp = `${Date.now()}`;
const nonce = crypto.randomUUID().replace(/-/g, "");
const idempotencyKey = crypto.randomUUID();

function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const entries = Object.entries(value)
    .filter(([, itemValue]) => itemValue !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));

  const serializedEntries = entries.map(([key, itemValue]) => `${JSON.stringify(key)}:${stableStringify(itemValue)}`);
  return `{${serializedEntries.join(",")}}`;
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hmacSha256Hex(secret, payload) {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

const canonicalBody = stableStringify(body);
const bodyHash = sha256Hex(canonicalBody);
const payload = [method, path, timestamp, nonce, bodyHash].join("\n");
const signature = hmacSha256Hex(merchantSecret, payload);

const url = `${baseUrl}${path}`;
const headers = {
  "Content-Type": "application/json",
  "x-merchant-api-key": merchantApiKey,
  "x-merchant-timestamp": timestamp,
  "x-merchant-nonce": nonce,
  "x-merchant-signature": signature,
  "Idempotency-Key": idempotencyKey,
};

console.log("Method:", method);
console.log("URL:", url);
console.log("\nBody:");
console.log(JSON.stringify(body, null, 2));

console.log("\nHeaders for Thunder Client:");
for (const [key, value] of Object.entries(headers)) {
  console.log(`${key}: ${value}`);
}

console.log("\nHeaders as JSON:");
console.log(JSON.stringify(headers, null, 2));

console.log("\nRaw payload used for signature:");
console.log(payload);
