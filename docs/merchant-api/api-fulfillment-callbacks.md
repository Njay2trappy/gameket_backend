# API Fulfillment Callbacks

When a customer places an order on a product marked as **API-fulfilled** (`isAPI: true`), Gameket immediately sends an HTTP POST request to the product's configured **Callback URL**. This allows your server to receive the order in real time and fulfill it (e.g., generate a code, provision a service, etc.).

---

## Overview

| Property | Value |
|---|---|
| Method | `POST` |
| Content-Type | `application/json` |
| Trigger | Order placed on an API-fulfilled product |
| Timing | Dispatched immediately after the order is created |
| Signature Header | `x-gk-signature` |

> **Note:** The callback is a notification — Gameket does not wait for your response before completing the order record. A callback failure is logged, but the order still proceeds.

---

## Callback Payload

Your endpoint will receive a JSON body with the following fields:

```json
{
  "orderId": "abc123xyz",
  "productId": "prod_001",
  "productName": "My Game Top-Up",
  "productType": "direct-top-up",
  "storeId": "store_99",
  "storeName": "My Awesome Store",
  "quantity": 1,
  "amount": 50.00,
  "fee": 0.25,
  "totalAmount": 50.25,
  "datainput": "PlayerID:987654321",
  "requestedAt": "2026-05-12T14:00:00.000Z",
  "source": "user"
}
```

### Field Reference

| Field | Type | Description |
|---|---|---|
| `orderId` | `string` | Unique identifier for this order. Use this to mark the order complete or refunded via the API. |
| `productId` | `string` | ID of the product that was ordered. |
| `productName` | `string` | Display name of the product at time of purchase. |
| `productType` | `string` | Product category/type (e.g. `direct-top-up`, `gift-cards`). |
| `storeId` | `string` | ID of your store. |
| `storeName` | `string` | Display name of your store. |
| `quantity` | `number` | Number of units ordered (always `1` for single-item products). |
| `amount` | `number` | Product price paid by the customer (before fee). |
| `fee` | `number` | Platform fee deducted from the sale. |
| `totalAmount` | `number` | Total amount charged to the customer (`amount + fee`). |
| `datainput` | `string \| null` | Optional data the buyer submitted at checkout (e.g. game ID, username). `null` if not provided. |
| `requestedAt` | `string` | ISO 8601 timestamp of when the order was placed. |
| `source` | `"user" \| "guest"` | Whether the order was placed by a logged-in user or a guest via payment link. |

---

## Signature Verification

Every callback request includes an `x-gk-signature` header. You should **always verify this signature** before processing the payload to ensure the request genuinely came from Gameket.

### Header Format

```
x-gk-signature: t=1747058400,v1=abc123def456...,w=18000
```

| Part | Description |
|---|---|
| `t` | Unix timestamp (seconds) when the request was sent. |
| `v1` | HMAC-SHA256 hex signature of `{t}.{raw JSON body}` using your merchant secret. |
| `w` | Tolerance window in seconds (18000 = 5 hours). Reject requests where `now - t > w`. |

### How to Verify

1. Parse `t`, `v1`, and `w` from the `x-gk-signature` header.
2. Check that `Math.abs(Date.now() / 1000 - t) <= w`. Reject if outside the window.
3. Compute `HMAC-SHA256(merchantSecret, "{t}.{rawBodyString}")`.
4. Compare your computed signature to `v1`. Reject if they don't match.

> **Important:** Compute the HMAC over the **raw request body string** — not a re-serialized version of the parsed JSON. Preserve byte order exactly as received.

---

## Verification Examples

### Node.js

```javascript
import crypto from "crypto";

function verifyGamocketCallback(req, merchantSecret) {
  const header = req.headers["x-gk-signature"];
  if (!header) return false;

  const parts = Object.fromEntries(
    header.split(",").map((p) => p.split("=", 2))
  );
  const { t, v1, w } = parts;

  if (!t || !v1 || !w) return false;

  // Check timestamp tolerance
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(t)) > Number(w)) return false;

  // Verify signature  (req.rawBody must be the unparsed body string)
  const expected = crypto
    .createHmac("sha256", merchantSecret)
    .update(`${t}.${req.rawBody}`)
    .digest("hex");

  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
}
```

> **Tip (Express):** Use `express.raw({ type: "application/json" })` on your callback route to preserve the raw body. Store it as `req.rawBody` in a middleware before JSON parsing.

### Python

```python
import hmac
import hashlib
import time

def verify_gameket_callback(headers: dict, raw_body: bytes, merchant_secret: str) -> bool:
    sig_header = headers.get("x-gk-signature", "")
    if not sig_header:
        return False

    parts = dict(p.split("=", 1) for p in sig_header.split(",") if "=" in p)
    t = parts.get("t")
    v1 = parts.get("v1")
    w = parts.get("w")

    if not (t and v1 and w):
        return False

    # Check timestamp tolerance
    now = int(time.time())
    if abs(now - int(t)) > int(w):
        return False

    # Verify signature
    payload = f"{t}.{raw_body.decode('utf-8')}".encode("utf-8")
    expected = hmac.new(
        merchant_secret.encode("utf-8"), payload, hashlib.sha256
    ).hexdigest()

    return hmac.compare_digest(expected, v1)
```

### PHP

```php
function verifyGamekitCallback(array $headers, string $rawBody, string $merchantSecret): bool {
    $sigHeader = $headers['x-gk-signature'] ?? '';
    if (!$sigHeader) return false;

    $parts = [];
    foreach (explode(',', $sigHeader) as $part) {
        [$key, $val] = explode('=', $part, 2);
        $parts[$key] = $val;
    }

    if (empty($parts['t']) || empty($parts['v1']) || empty($parts['w'])) return false;

    // Check timestamp tolerance
    if (abs(time() - (int)$parts['t']) > (int)$parts['w']) return false;

    // Verify signature
    $payload = $parts['t'] . '.' . $rawBody;
    $expected = hash_hmac('sha256', $payload, $merchantSecret);

    return hash_equals($expected, $parts['v1']);
}
```

---

## Responding to Callbacks

Your endpoint should return a **2xx HTTP status** (e.g. `200 OK`) to acknowledge receipt. Gameket does not retry failed callbacks, so ensure your endpoint is reliable.

| Response | Outcome |
|---|---|
| `2xx` | Callback marked as successful |
| `4xx` / `5xx` | Callback failure logged; order is unaffected |
| Timeout / unreachable | Callback failure logged; order is unaffected |

---

## After Receiving a Callback

Once you have fulfilled the order on your end (e.g. generated a code), use the [Orders API](orders.md) to:

1. **Add codes/keys** to the order: `POST /merchant/orders/codes`
2. **Mark the order as complete**: `PATCH /merchant/orders` with `{ "orderId": "...", "status": "completed" }`

If you cannot fulfill the order, **cancel it** with `{ "status": "cancelled" }` so the customer is refunded.

---

## Configuring the Callback URL

The callback URL is set per-product when creating or updating a product. It must be a valid `http://` or `https://` URL.

See [Products — Callback URL](products.md#callback-url) for configuration details.
