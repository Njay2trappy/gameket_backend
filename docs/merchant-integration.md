# Merchant Integration Guide

This guide covers merchant write endpoints for order fulfillment and the exact retry behavior.

## Required headers

All protected merchant requests require:

- `x-merchant-api-key`
- `Authorization: Bearer <token>`

For write endpoints below, this is also required:

- `Idempotency-Key` (or `x-idempotency-key`)

## Token flow (recommended)

1. Merchant calls `POST /merchant/auth/check` with `apiKey` and `secret`.
2. API returns a Bearer token valid for 2 hours.
3. Merchant sends `x-merchant-api-key` + `Authorization: Bearer <token>` on protected endpoints.
4. When token expires, merchant calls `POST /merchant/auth/check` again.

Request body for token issuance:

```json
{
  "apiKey": "your-merchant-api-key",
  "secret": "your-merchant-secret"
}
```

Example token response:

```json
{
  "success": true,
  "message": "Merchant access token issued",
  "token": "<jwt>",
  "tokenType": "Bearer",
  "expiresInSeconds": 7200,
  "expiresAt": "2026-05-10T12:00:00.000Z",
  "merchant": {
    "storeId": "...",
    "storeName": "..."
  }
}
```

## How merchants get credentials

### 1) `x-merchant-api-key`

- Issued when a store becomes a merchant.
- Returned in GraphQL merchant details under `merchantCredentials.apiKey`.

### 2) Merchant secret (for token issuance)

- Returned in GraphQL merchant details under `merchantCredentials.secret`.
- Keep this server-side only. Never expose in frontend apps.

### 3) Access token

- Issued from `POST /merchant/auth/check`.
- Valid for 2 hours.
- Re-issue using same endpoint when expired.

### Rotating credentials

- If key or secret leaks, regenerate through merchant settings mutation:
  - `UpdateMerchantdetails` with `regenerateApiKey` and/or `regenerateSecret`
- After rotation, old credentials stop working.

## Retry rules (exact)

1. For each new business action, generate a new `Idempotency-Key`.
2. If request times out, connection drops, or server returns 5xx, retry the same method + path + body with the same `Idempotency-Key`.
3. If the first request already succeeded, retry returns the original response and includes `x-idempotent-replay: true`.
4. If the same key is reused with a different payload, server returns `409`.
5. If the same key arrives while first request is still running, server returns `409` (in progress). Retry with the same key after a short delay.
6. `Idempotency-Key` must be 8 to 128 characters.
7. Do not change endpoint, order id, or request body when retrying the same key.

## Endpoint 1: Add codes to order

Adds codes in batches. Cumulative codes cannot exceed order quantity.

- Method: `POST`
- Path: `/merchant/orders/codes?orderId={orderId}`
- Required body fields: `codes` (array of strings)

```bash
curl -X POST "${BASE_URL}/merchant/orders/codes?orderId=${ORDER_ID}" \
  -H "Content-Type: application/json" \
  -H "x-merchant-api-key: ${MERCHANT_API_KEY}" \
  -H "Authorization: Bearer ${MERCHANT_ACCESS_TOKEN}" \
  -H "Idempotency-Key: ${IDEMPOTENCY_KEY}" \
  -d '{
    "codes": ["CODE-001", "CODE-002", "CODE-003"]
  }'
```

## Endpoint 2: Complete order

Marks order as completed and starts payout countdown.

- Method: `POST`
- Path: `/merchant/orders/complete?orderId={orderId}`
- Optional body field: `fulfilmentNote`

```bash
curl -X POST "${BASE_URL}/merchant/orders/complete?orderId=${ORDER_ID}" \
  -H "Content-Type: application/json" \
  -H "x-merchant-api-key: ${MERCHANT_API_KEY}" \
  -H "Authorization: Bearer ${MERCHANT_ACCESS_TOKEN}" \
  -H "Idempotency-Key: ${IDEMPOTENCY_KEY}" \
  -d '{
    "fulfilmentNote": "Delivery completed successfully"
  }'
```

## Endpoint 3: Refund order

Refunds order if still eligible.

- Method: `POST`
- Path: `/merchant/orders/refund?orderId={orderId}`
- Optional body field: `quantity`

If `quantity` is sent, it must match full order quantity.

```bash
curl -X POST "${BASE_URL}/merchant/orders/refund?orderId=${ORDER_ID}" \
  -H "Content-Type: application/json" \
  -H "x-merchant-api-key: ${MERCHANT_API_KEY}" \
  -H "Authorization: Bearer ${MERCHANT_ACCESS_TOKEN}" \
  -H "Idempotency-Key: ${IDEMPOTENCY_KEY}" \
  -d '{
    "quantity": 5
  }'
```

## Recommended client behavior

- Persist generated idempotency keys client-side until request completes.
- Log response headers: `x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-reset`.
- Treat `401`, `409`, and `429` as recoverable integration errors and surface clear messages to merchant operators.

## Thunder Client test: post codes to an order

Use this flow to test `POST /merchant/orders/codes?orderId={orderId}` in Thunder Client.

### 1) Generate headers with helper script

Set these environment variables and run:

```bash
BASE_URL="http://localhost:4000" \
MERCHANT_API_KEY="your-api-key" \
MERCHANT_SECRET="your-secret" \
ORDER_ID="order-id" \
CODES="CODE-001,CODE-002,CODE-003" \
node scripts/sample-post-order-codes.mjs
```

The script prints:

- token request URL + body
- protected endpoint URL
- JSON body
- exact headers to paste into Thunder Client

### 2) Configure request in Thunder Client

- Method: `POST`
- URL: printed URL from the script
- Body (JSON): paste printed body
- Headers: paste all printed headers

Required headers for this request:

- `Content-Type: application/json`
- `x-merchant-api-key`
- `Authorization: Bearer <token>`
- `Idempotency-Key`

### 3) Retry test

To verify idempotency:

- resend the same request with the same `Idempotency-Key`
- expected: replayed response with `x-idempotent-replay: true`
