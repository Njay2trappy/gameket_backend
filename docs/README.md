# Gameket Merchant API

Welcome to the Gameket Merchant API documentation. This API enables merchants to manage products, orders, and handle transactions in the Gameket ecosystem.

## Quick Start

1. **Get API Credentials** - Contact Gameket to receive your `apiKey` and `secret`
2. **Request a Token** - POST to `/merchant/auth/check` with your credentials
3. **Use the Token** - Include the Bearer token in all subsequent requests
4. **Start Integrating** - Use the endpoints to manage your products and orders

## Base URL

```
https://api.gameket.io
```

## Key Features

- ✅ **Token-based Authentication** - JWT tokens valid for 2 hours
- ✅ **Rate Limiting** - Fair usage limits to protect the API
- ✅ **Idempotency Keys** - Prevent duplicate operations
- ✅ **Product Management** - Create, update, and manage product catalogs
- ✅ **Order Handling** - Process orders, refunds, and cancellations
- ✅ **Stock Management** - Automatic and manual stock control
- ✅ **Webhooks** - Receive real-time notifications

## Authentication

All requests (except `/merchant/auth/check`) require:
- `Authorization: Bearer {token}` header
- `x-merchant-api-key: {apiKey}` header

For write operations, also include:
- `Idempotency-Key: {unique-key}` header

## Rate Limits

| Endpoint | Limit | Window |
|----------|-------|--------|
| Token Issuance | 2 tokens | 1 hour |
| General Reads | 20 requests | 1 minute |
| General Writes | 20 requests | 1 minute |

## Response Format

All responses use a standard JSON format:

**Success Response:**
```json
{
  "success": true,
  "data": { /* response data */ }
}
```

**Error Response:**
```json
{
  "success": false,
  "error": "Error message",
  "code": "ERROR_CODE",
  "requestId": "req_12345"
}
```

## Support

For API support and integration help:
- 📧 Email: api-support@gameket.io
- 📖 [Full Documentation](merchant-api/getting-started.md)
- 💬 [Community Forum](https://community.gameket.io)

## What's Next?

- [Getting Started Guide](merchant-api/getting-started.md)
- [Authentication Setup](merchant-api/authentication.md)
- [Products API](merchant-api/products.md)
- [Orders API](merchant-api/orders.md)
- [API Examples](merchant-api/examples.md)
