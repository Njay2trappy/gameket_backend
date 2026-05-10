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
const path = "/merchant/orders/codes";
const query = new URLSearchParams({ orderId }).toString();
const requestTarget = `${path}?${query}`;
const body = { codes };
const idempotencyKey = crypto.randomUUID();

const url = `${baseUrl}${requestTarget}`;
const authUrl = `${baseUrl}/merchant/auth/check`;
const headers = {
  "Content-Type": "application/json",
  "x-merchant-api-key": merchantApiKey,
  "Authorization": "Bearer <paste-token-here>",
  "Idempotency-Key": idempotencyKey,
};

console.log("Step 1: Issue token");
console.log("Method: POST");
console.log("URL:", authUrl);
console.log("Body:");
console.log(JSON.stringify({ apiKey: merchantApiKey, secret: merchantSecret }, null, 2));

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
