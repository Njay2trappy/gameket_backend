# Error Handling

This guide explains error responses, error codes, and how to handle common issues.

## Error Response Format

All error responses follow a consistent JSON structure:

```json
{
  "success": false,
  "error": "Human-readable error message",
  "code": "ERROR_CODE",
  "requestId": "req_abc123def456"
}
```

**Use `requestId` when reporting issues to support.**

## HTTP Status Codes

| Code | Name | Meaning | Action |
|------|------|---------|--------|
| 400 | Bad Request | Invalid request parameters | Fix request and retry |
| 401 | Unauthorized | Invalid/expired authentication | Get new token |
| 403 | Forbidden | Access denied (not allowed) | Check permissions |
| 404 | Not Found | Resource doesn't exist | Verify ID and retry |
| 409 | Conflict | Duplicate/conflict (idempotency) | Use different idempotency key |
| 429 | Too Many Requests | Rate limit exceeded | Wait and retry |
| 500 | Server Error | API server error | Retry after delay |
| 503 | Service Unavailable | API maintenance/overload | Retry after delay |

## Common Error Codes

### Authentication Errors

**`UNAUTHORIZED`** (401)
```json
{
  "success": false,
  "error": "Invalid or expired token",
  "code": "UNAUTHORIZED"
}
```
**Fix:** Request a new token via `/merchant/auth/check`

**`INVALID_CREDENTIALS`** (401)
```json
{
  "success": false,
  "error": "Invalid merchant credentials",
  "code": "INVALID_CREDENTIALS"
}
```
**Fix:** Verify your API key and secret

**`ACCOUNT_SUSPENDED`** (403)
```json
{
  "success": false,
  "error": "Account is suspended",
  "code": "ACCOUNT_SUSPENDED"
}
```
**Fix:** Contact support to resolve account status

### Rate Limiting Errors

**`RATE_LIMITED`** (429)
```json
{
  "success": false,
  "message": "Too many merchant requests",
  "retryAfterSeconds": 45,
  "code": "RATE_LIMITED"
}
```
**Fix:** Wait `retryAfterSeconds` before retrying

**`TOKEN_ISSUANCE_RATE_LIMITED`** (429)
```json
{
  "success": false,
  "message": "Token issuance rate limit exceeded (2 per hour)",
  "retryAfterSeconds": 1800,
  "code": "TOKEN_ISSUANCE_RATE_LIMITED"
}
```
**Fix:** Cache existing tokens; only request new ones when expired

### Validation Errors

**`INVALID_TYPE`** (400)
```json
{
  "success": false,
  "error": "Invalid product type: unknown",
  "code": "INVALID_TYPE"
}
```
**Fix:** Use valid product type: `game-vouchers`, `gift-cards`, etc.

**`INVALID_STATUS`** (400)
```json
{
  "success": false,
  "error": "Invalid order status: invalid",
  "code": "INVALID_STATUS"
}
```
**Fix:** Use valid status: `pending`, `completed`, `refunded`, etc.

**`MISSING_REQUIRED_FIELD`** (400)
```json
{
  "success": false,
  "error": "Missing required field: name",
  "code": "MISSING_REQUIRED_FIELD"
}
```
**Fix:** Include all required fields in request body

**`INVALID_AMOUNT`** (400)
```json
{
  "success": false,
  "error": "Amount must be positive",
  "code": "INVALID_AMOUNT"
}
```
**Fix:** Use positive amounts

### Resource Errors

**`PRODUCT_NOT_FOUND`** (404)
```json
{
  "success": false,
  "error": "Product not found: prod_xyz",
  "code": "PRODUCT_NOT_FOUND"
}
```
**Fix:** Verify product ID; retrieve products list if needed

**`ORDER_NOT_FOUND`** (404)
```json
{
  "success": false,
  "error": "Order not found: ord_xyz",
  "code": "ORDER_NOT_FOUND"
}
```
**Fix:** Verify order ID; check order list for correct ID

**`STORE_NOT_FOUND`** (404)
```json
{
  "success": false,
  "error": "Store not found",
  "code": "STORE_NOT_FOUND"
}
```
**Fix:** Verify API key is correct

### Conflict Errors

**`PRODUCT_EXISTS`** (409)
```json
{
  "success": false,
  "error": "Product already exists",
  "code": "PRODUCT_EXISTS"
}
```
**Fix:** Use different product name or idempotency key

**`INVALID_STATUS_TRANSITION`** (409)
```json
{
  "success": false,
  "error": "Cannot complete refunded order",
  "code": "INVALID_STATUS_TRANSITION"
}
```
**Fix:** Check order status; verify state machine (see [Orders](orders.md))

**`INSUFFICIENT_STOCK`** (409)
```json
{
  "success": false,
  "error": "Insufficient stock available",
  "code": "INSUFFICIENT_STOCK"
}
```
**Fix:** Add stock to product or wait for replenishment

### Server Errors

**`INTERNAL_SERVER_ERROR`** (500)
```json
{
  "success": false,
  "error": "Internal server error",
  "code": "INTERNAL_SERVER_ERROR",
  "requestId": "req_abc123"
}
```
**Fix:** Retry after 30-60 seconds; report with `requestId` if persists

**`SERVICE_UNAVAILABLE`** (503)
```json
{
  "success": false,
  "error": "Service temporarily unavailable",
  "code": "SERVICE_UNAVAILABLE"
}
```
**Fix:** Retry after 60 seconds; check status page

## Error Handling Strategies

### 1. Retry Logic with Exponential Backoff

```javascript
async function apiRequestWithRetry(method, endpoint, body, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(`https://api.gameket.io${endpoint}`, {
        method,
        headers: { /* ... */ },
        body: body ? JSON.stringify(body) : null
      });

      if (!response.ok) {
        const error = await response.json();

        // Retry on server errors and rate limiting
        if (response.status >= 500 || response.status === 429) {
          const delay = response.status === 429
            ? parseInt(response.headers['retry-after']) * 1000
            : Math.pow(2, attempt) * 1000;

          if (attempt < maxRetries - 1) {
            console.log(`Retrying in ${delay / 1000}s...`);
            await new Promise(r => setTimeout(r, delay));
            continue;
          }
        }

        // Don't retry on client errors (4xx)
        throw new APIError(error.code, error.error, response.status);
      }

      return await response.json();
    } catch (error) {
      if (attempt === maxRetries - 1) throw error;
      await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
    }
  }
}
```

### 2. Error Classification

```javascript
class APIError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }

  isRetryable() {
    return this.status >= 500 || this.status === 429;
  }

  isAuthError() {
    return this.status === 401 || this.status === 403;
  }

  isValidationError() {
    return this.status === 400;
  }

  isNotFound() {
    return this.status === 404;
  }
}

// Usage
try {
  await apiRequest('/merchant/orders');
} catch (error) {
  if (error.isAuthError()) {
    // Get new token
  } else if (error.isRetryable()) {
    // Retry later
  } else if (error.isValidationError()) {
    // Fix request
  }
}
```

### 3. Global Error Handler

```javascript
class MerchantAPIClient {
  constructor(apiKey, secret) {
    this.apiKey = apiKey;
    this.secret = secret;
    this.token = null;
  }

  async request(method, endpoint, body = null) {
    try {
      const response = await fetch(`https://api.gameket.io${endpoint}`, {
        method,
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'x-merchant-api-key': this.apiKey,
          'Content-Type': 'application/json'
        },
        body: body ? JSON.stringify(body) : null
      });

      const data = await response.json();

      if (!response.ok) {
        // Auto-refresh token on auth error
        if (response.status === 401) {
          this.token = await this.getNewToken();
          return this.request(method, endpoint, body); // Retry
        }

        throw new APIError(data.code, data.error, response.status);
      }

      return data;
    } catch (error) {
      this.logError(error);
      throw error;
    }
  }

  async getNewToken() {
    const response = await fetch('https://api.gameket.io/merchant/auth/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiKey: this.apiKey,
        secret: this.secret
      })
    });

    const { data } = await response.json();
    return data.token;
  }

  logError(error) {
    console.error(`[${new Date().toISOString()}] API Error:`, {
      code: error.code,
      message: error.message,
      status: error.status
    });
  }
}
```

### 4. Error Monitoring

```javascript
// Send errors to monitoring service
async function trackError(error, context = {}) {
  await fetch('https://monitoring.myservice.com/errors', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      timestamp: new Date().toISOString(),
      code: error.code,
      message: error.message,
      status: error.status,
      context,
      stack: error.stack,
      userAgent: navigator.userAgent
    })
  });
}
```

### 5. Error Handling (Python)

```python
import requests
from enum import Enum

class ErrorCategory(Enum):
    AUTH_ERROR = "auth"
    RATE_LIMIT = "rate_limit"
    VALIDATION_ERROR = "validation"
    NOT_FOUND = "not_found"
    SERVER_ERROR = "server"
    NETWORK_ERROR = "network"

class GametekAPIError(Exception):
    def __init__(self, code, message, status, response_data=None):
        self.code = code
        self.message = message
        self.status = status
        self.response_data = response_data
        super().__init__(self.message)

    def get_category(self):
        if self.status in [401, 403]:
            return ErrorCategory.AUTH_ERROR
        elif self.status == 429:
            return ErrorCategory.RATE_LIMIT
        elif self.status == 400:
            return ErrorCategory.VALIDATION_ERROR
        elif self.status == 404:
            return ErrorCategory.NOT_FOUND
        elif self.status >= 500:
            return ErrorCategory.SERVER_ERROR
        return ErrorCategory.NETWORK_ERROR

    def is_retryable(self):
        return self.get_category() in [ErrorCategory.RATE_LIMIT, ErrorCategory.SERVER_ERROR]

# Usage
def api_request_safe(client, method, endpoint, data=None):
    """Make API request with error handling"""
    try:
        response = requests.request(method, endpoint, json=data)
        response.raise_for_status()
        return response.json()
    except requests.exceptions.RequestException as e:
        if isinstance(e, requests.exceptions.HTTPError):
            error_data = e.response.json().get('error', {})
            error = GametekAPIError(
                error_data.get('code'),
                error_data.get('message'),
                e.response.status_code,
                error_data
            )
            
            if error.get_category() == ErrorCategory.AUTH_ERROR:
                # Refresh token
                pass
            elif error.is_retryable():
                # Queue for retry
                pass
            
            raise error
        raise
```

### 6. Error Handling (Rust)

```rust
use reqwest::StatusCode;
use std::fmt;

#[derive(Debug)]
pub enum GametekError {
    AuthError(String),
    RateLimited { retry_after: u32 },
    ValidationError(Vec<String>),
    NotFound(String),
    ServerError(String),
    NetworkError(String),
}

impl fmt::Display for GametekError {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self {
            GametekError::AuthError(msg) => write!(f, "Auth Error: {}", msg),
            GametekError::RateLimited { retry_after } => {
                write!(f, "Rate Limited. Retry after {} seconds", retry_after)
            }
            GametekError::ValidationError(errors) => {
                write!(f, "Validation Errors: {}", errors.join(", "))
            }
            GametekError::NotFound(msg) => write!(f, "Not Found: {}", msg),
            GametekError::ServerError(msg) => write!(f, "Server Error: {}", msg),
            GametekError::NetworkError(msg) => write!(f, "Network Error: {}", msg),
        }
    }
}

impl std::error::Error for GametekError {}

impl GametekError {
    pub fn is_retryable(&self) -> bool {
        matches!(
            self,
            GametekError::RateLimited { .. } | GametekError::ServerError(_)
        )
    }

    pub fn is_auth_error(&self) -> bool {
        matches!(self, GametekError::AuthError(_))
    }

    pub fn retry_after_seconds(&self) -> Option<u32> {
        match self {
            GametekError::RateLimited { retry_after } => Some(*retry_after),
            _ => None,
        }
    }

    pub fn from_response(status: StatusCode, body: &serde_json::Value) -> Self {
        match status {
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
                GametekError::AuthError(
                    body["error"]["message"]
                        .as_str()
                        .unwrap_or("Unauthorized")
                        .to_string(),
                )
            }
            StatusCode::TOO_MANY_REQUESTS => {
                let retry_after = body["error"]["retry_after"]
                    .as_u64()
                    .unwrap_or(60) as u32;
                GametekError::RateLimited { retry_after }
            }
            StatusCode::BAD_REQUEST => {
                let errors = body["error"]["details"]
                    .as_array()
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|e| e["message"].as_str().map(String::from))
                            .collect()
                    })
                    .unwrap_or_default();
                GametekError::ValidationError(errors)
            }
            StatusCode::NOT_FOUND => {
                GametekError::NotFound(
                    body["error"]["message"]
                        .as_str()
                        .unwrap_or("Resource not found")
                        .to_string(),
                )
            }
            _ if status.is_server_error() => {
                GametekError::ServerError(
                    body["error"]["message"]
                        .as_str()
                        .unwrap_or("Server error")
                        .to_string(),
                )
            }
            _ => GametekError::NetworkError(format!("HTTP {}", status)),
        }
    }
}

pub async fn api_request_with_error_handling(
    client: &reqwest::Client,
    endpoint: &str,
    max_retries: u32,
) -> Result<serde_json::Value, GametekError> {
    let mut attempt = 0;

    loop {
        attempt += 1;
        match client.get(endpoint).send().await {
            Ok(response) => {
                let status = response.status();
                let body: serde_json::Value = response.json().await.unwrap_or_default();

                if status.is_success() {
                    return Ok(body);
                }

                let error = GametekError::from_response(status, &body);

                if error.is_retryable() && attempt < max_retries {
                    let delay = if let GametekError::RateLimited { retry_after } = error {
                        retry_after as u64
                    } else {
                        2_u64.pow(attempt - 1)
                    };

                    println!("Error: {}. Retrying in {} seconds...", error, delay);
                    tokio::time::sleep(std::time::Duration::from_secs(delay)).await;
                    continue;
                }

                return Err(error);
            }
            Err(e) => {
                let error = GametekError::NetworkError(e.to_string());

                if attempt < max_retries {
                    let delay = 2_u64.pow(attempt - 1);
                    println!("Network error. Retrying in {} seconds...", delay);
                    tokio::time::sleep(std::time::Duration::from_secs(delay)).await;
                    continue;
                }

                return Err(error);
            }
        }
    }
}
```

## Common Issues & Solutions

### Issue: "Invalid merchant credentials"

**Symptoms:** 401 error on every request

**Causes:**
- Wrong API key or secret
- API credentials expired/rotated
- Account suspended

**Solutions:**
1. Verify API key and secret in dashboard
2. Regenerate credentials if needed
3. Check account status
4. Contact support if account is suspended

### Issue: "Too many requests"

**Symptoms:** 429 error after many requests

**Causes:**
- Exceeded rate limit (20 req/min)
- Too many token issuance requests (>2/hour)
- Inefficient integration pattern

**Solutions:**
1. Implement request queuing/batching
2. Cache tokens (don't request new ones constantly)
3. Use exponential backoff
4. Monitor rate limit headers

### Issue: "Order not found"

**Symptoms:** 404 error for valid order

**Causes:**
- Order belongs to different merchant
- Order ID is incorrect
- Order was deleted

**Solutions:**
1. List orders to find correct ID
2. Verify order belongs to your store
3. Check recent orders in dashboard

### Issue: "Cannot complete order"

**Symptoms:** 409 error when completing order

**Causes:**
- Wrong order status (e.g., already refunded)
- Codes not delivered yet
- Order already completed

**Solutions:**
1. Check order status first
2. Deliver codes before completing
3. Use `/merchant/orders/codes` to auto-complete

## Debugging Tips

### Enable Request/Response Logging

```javascript
// Log all requests
fetch = new Proxy(fetch, {
  apply(target, thisArg, args) {
    const [resource, config] = args;
    console.log(`[API] ${config?.method || 'GET'} ${resource}`);
    return target.apply(thisArg, args).then(response => {
      console.log(`[API] ← ${response.status}`);
      return response;
    });
  }
});
```

### Save Request IDs

```javascript
// Store request ID for debugging
async function apiRequest(endpoint, config = {}) {
  const response = await fetch(`https://api.gameket.io${endpoint}`, config);
  const requestId = response.headers.get('request-id');

  if (!response.ok) {
    const error = await response.json();
    console.error(`Error [${requestId}]:`, error);
  }

  return { response, requestId };
}
```

## Getting Help

When reporting issues, include:
- `requestId` from error response
- Request method and endpoint
- Request body (without credentials)
- Error code and message
- Expected vs actual behavior
- Steps to reproduce

## Next Steps

- [Authentication](authentication.md) - Secure token management
- [Rate Limiting](rate-limiting.md) - Quota best practices
- [Examples](examples.md) - Full code examples
