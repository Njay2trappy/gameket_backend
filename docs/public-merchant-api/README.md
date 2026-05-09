# Public Merchant API

This is the public documentation for merchant integrations on Gameket.

## Who this is for

- Store owners
- Merchant engineering teams
- Integration partners

## Start here

1. [Quickstart](quickstart.md)
2. [Authentication and Signing](authentication.md)
3. [Endpoint Reference](endpoint-reference.md)
4. [Errors, Retries, and Idempotency](errors-and-retries.md)
5. [Onboarding Checklist](onboarding-checklist.md)

## Base URL

Use your environment-specific API host:

- Staging: `https://staging-api.yourdomain.com`
- Production: `https://api.yourdomain.com`

All endpoints in this guide are shown with path-only format, for example:

- `/merchant/orders/{orderId}/codes`

## Authentication summary

All protected merchant endpoints require these headers:

- `x-merchant-api-key`
- `x-merchant-timestamp`
- `x-merchant-nonce`
- `x-merchant-signature`

Write operations for order fulfillment also require:

- `Idempotency-Key` (or `x-idempotency-key`)

## Support and versioning

- Share your `requestId` and timestamp when reporting issues.
- Treat this documentation set as API v1 reference unless otherwise announced.
