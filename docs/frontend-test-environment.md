# Frontend Test Environment Setup

This setup gives your frontend team a safe test environment for all backend API checks, including merchant endpoints.

## 1) Core architecture (important)

- Browser app should never hold merchant secret.
- Browser app calls your own server-side proxy endpoint.
- Proxy endpoint signs merchant requests and forwards to backend.

Reason:

- Merchant secret in browser can be extracted and abused.

## 2) Environment layout

Use separate environments for backend and frontend.

- Development
- Staging (recommended primary QA environment)
- Production

## 3) Recommended frontend env variables

Client-side variables (safe in browser):

- NEXT_PUBLIC_APP_ENV=development|staging|production
- NEXT_PUBLIC_BACKEND_BASE_URL=https://staging-api.yourdomain.com
- NEXT_PUBLIC_ENABLE_BACKEND_TEST_PANEL=true

Server-side variables (never expose to browser):

- MERCHANT_API_KEY=...
- MERCHANT_SECRET=...

If using Vite, keep server-side secrets in your backend/proxy service only.

## 4) Request flow for merchant testing

1. Frontend QA panel triggers a test action (add codes, complete, refund, etc).
2. Frontend calls your server route (example: /api/merchant-test/orders/:orderId/codes).
3. Server route generates:
   - x-merchant-timestamp
   - x-merchant-nonce
   - x-merchant-signature
4. Server route attaches:
   - x-merchant-api-key
   - Idempotency-Key (for write operations)
5. Server forwards request to backend merchant API.
6. Server returns backend response to frontend panel.

## 5) Retry and idempotency policy in frontend QA panel

- For a new write operation, generate a new Idempotency-Key.
- On timeout/network failure/5xx, retry same method + path + body with same Idempotency-Key.
- If response has x-idempotent-replay: true, show it as a replayed successful response.
- If 409 due payload mismatch, treat as integration error and stop retries.

## 6) Test panel features to include

- Environment selector (dev/staging/prod)
- Endpoint selector (GET/POST/PATCH routes)
- Raw request/response viewer
- Auto-generated correlation id per request
- Retry toggle with max attempts
- Header viewer for rate limits:
  - x-ratelimit-policy
  - x-ratelimit-limit
  - x-ratelimit-remaining
  - x-ratelimit-reset

## 7) Minimum backend test suite from frontend

- Merchant auth check
- Product list/details
- Add codes in 2 batches (for example 3 then 2 for quantity 5)
- Reject overflow batch (try adding 3 when only 2 remaining)
- Complete order
- Refund order
- Retry same idempotency key and verify replay behavior

## 8) Launch recommendation

- Run this setup first in staging with test merchant credentials.
- Use production only after staging pass and error-rate review.

## 9) Security checklist

- Do not expose MERCHANT_SECRET to browser or mobile client.
- Rotate merchant credentials if leaked.
- Keep strict CORS and origin allow-list in your server-side proxy.
- Log and monitor 401, 409, 429, and 5xx rates.
