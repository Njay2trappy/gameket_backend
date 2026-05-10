# Gameket Merchant API Documentation

## Table of Contents

- [Introduction](README.md)
- [Getting Started](merchant-api/getting-started.md)
- [Authentication](merchant-api/authentication.md)
  - [Token Generation](merchant-api/authentication.md#token-generation)
  - [Using Bearer Tokens](merchant-api/authentication.md#using-bearer-tokens)
  - [Token Expiry & Refresh](merchant-api/authentication.md#token-expiry--refresh)
  - [API Key Rotation](merchant-api/authentication.md#api-key-rotation)

- [Core Concepts](merchant-api/core-concepts.md)
  - [Request Headers](merchant-api/core-concepts.md#request-headers)
  - [Idempotency](merchant-api/core-concepts.md#idempotency)
  - [Query Parameters](merchant-api/core-concepts.md#query-parameters)

- [Merchant Profile](merchant-api/merchant-profile.md)
  - [Get Profile](merchant-api/merchant-profile.md#get-profile)
  - [Get Current Store](merchant-api/merchant-profile.md#get-current-store)

- [Products](merchant-api/products.md)
  - [List Products](merchant-api/products.md#list-products)
  - [Create Product](merchant-api/products.md#create-product)
  - [Update Product](merchant-api/products.md#update-product)
  - [Delete Product](merchant-api/products.md#delete-product)
  - [Manage Stock](merchant-api/products.md#manage-stock)
  - [Callback URL](merchant-api/products.md#callback-url)

- [Orders](merchant-api/orders.md)
  - [List Orders](merchant-api/orders.md#list-orders)
  - [Get Order Codes](merchant-api/orders.md#get-order-codes)
  - [Add Order Codes](merchant-api/orders.md#add-order-codes)
  - [Complete Order](merchant-api/orders.md#complete-order)
  - [Refund Order](merchant-api/orders.md#refund-order)
  - [Cancel Order](merchant-api/orders.md#cancel-order)

- [Rate Limiting](merchant-api/rate-limiting.md)
  - [General Rate Limits](merchant-api/rate-limiting.md#general-rate-limits)
  - [Token Issuance Limits](merchant-api/rate-limiting.md#token-issuance-limits)
  - [Rate Limit Headers](merchant-api/rate-limiting.md#rate-limit-headers)
  - [Handling 429 Responses](merchant-api/rate-limiting.md#handling-429-responses)

- [Error Handling](merchant-api/errors.md)
  - [Error Codes](merchant-api/errors.md#error-codes)
  - [Error Response Format](merchant-api/errors.md#error-response-format)
  - [Common Issues](merchant-api/errors.md#common-issues)

- [Examples & Guides](merchant-api/examples.md)
  - [cURL Examples](merchant-api/examples.md#curl-examples)
  - [Node.js Integration](merchant-api/examples.md#nodejs-integration)
  - [Python Integration](merchant-api/examples.md#python-integration)
  - [Webhook Handling](merchant-api/examples.md#webhook-handling)
