# Core Concepts

Understanding these core concepts will help you build a robust integration with the Gameket Merchant API.

## Request Headers

All API requests follow a consistent header pattern.

### Authentication Headers (All Protected Endpoints)

Required on every request to protected endpoints:

```
Authorization: Bearer {token}
x-merchant-api-key: {your_merchant_api_key}
```

Example:
```bash
curl -X GET https://api.gameket.io/merchant/orders \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." \
  -H "x-merchant-api-key: mapi_abc123def456"
```

### Idempotency Headers (Write Operations Only)

For POST, PATCH, PUT requests, include an `Idempotency-Key`:

```
Idempotency-Key: {unique-key-per-request}
```

Example:
```bash
curl -X POST https://api.gameket.io/merchant/products \
  -H "Authorization: Bearer ..." \
  -H "x-merchant-api-key: ..." \
  -H "Idempotency-Key: product-create-20260510-001" \
  -H "Content-Type: application/json" \
  -d '{"name": "Game Voucher", "price": 50}'
```

### Content-Type Header

For JSON requests:
```
Content-Type: application/json
```

### Standard Headers

These are automatically set by most HTTP clients:
```
Accept: application/json
Accept-Encoding: gzip, deflate
User-Agent: {your-app-name}/{version}
```

## Idempotency

Idempotency ensures that requests with the same key produce the same result, even if executed multiple times.

### Why Idempotency Matters

When making write operations over a network, sometimes you don't receive the response:
- Network timeout before response arrives
- Server processes request but returns 500 error
- Client crashes after sending request

Without idempotency, retrying the request would create duplicates.

### Using Idempotency Keys

**Format:** Any unique string (UUID recommended)
```
Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000
```

**Generate a UUID in JavaScript:**
```javascript
const uuid = crypto.randomUUID();
// or: const uuid = Math.random().toString(36).substr(2, 9);
```

### Idempotency Behavior

1. **First request:** Server processes and returns response
2. **Duplicate request (same key):** Server returns cached response
3. **New request (different key):** Server processes as new request

**Example:**

```bash
# Request 1: Creates a product
curl -X POST https://api.gameket.io/merchant/products \
  -H "Idempotency-Key: create-voucher-123" \
  -d '{"name": "Gift Card", "price": 100}'

# Response: Product created with ID "prod_xyz"

# Request 2: Same key, network timeout
curl -X POST https://api.gameket.io/merchant/products \
  -H "Idempotency-Key: create-voucher-123" \
  -d '{"name": "Gift Card", "price": 100}'

# Response: Same product returned (not duplicated!)
```

### Idempotency Key Storage

Store the key with your request to enable retries:

```javascript
const idempotencyKey = crypto.randomUUID();
const request = {
  id: 'req_123',
  idempotencyKey,
  endpoint: '/merchant/products',
  body: { name: 'Gift Card', price: 100 },
  createdAt: new Date()
};

// Save request to DB/cache
await saveRequest(request);

// Make API call with idempotency key
const response = await fetch('https://api.gameket.io/merchant/products', {
  method: 'POST',
  headers: {
    'Idempotency-Key': idempotencyKey,
    // ... other headers
  },
  body: JSON.stringify(request.body)
});
```

### Idempotency Key Storage (Python)

```python
import uuid
import sqlite3

def store_request_with_idempotency(endpoint, body):
    """Store request with idempotency key for retry ability"""
    idempotency_key = str(uuid.uuid4())
    
    # Save to database
    conn = sqlite3.connect('requests.db')
    cursor = conn.cursor()
    cursor.execute('''
        INSERT INTO requests (idempotency_key, endpoint, body)
        VALUES (?, ?, ?)
    ''', (idempotency_key, endpoint, str(body)))
    conn.commit()
    
    # Make API call with idempotency key
    response = requests.post(
        f'https://api.gameket.io{endpoint}',
        json=body,
        headers={'Idempotency-Key': idempotency_key}
    )
    
    return response
```

### Idempotency Key Storage (Rust)

```rust
use uuid::Uuid;
use serde_json::json;

pub struct RequestTracker {
    client: reqwest::Client,
}

impl RequestTracker {
    pub async fn track_and_send(
        &self,
        method: &str,
        endpoint: &str,
        body: serde_json::Value,
    ) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
        let idempotency_key = Uuid::new_v4().to_string();
        
        // Log request for audit trail
        println!("Sending {} {} with key {}", method, endpoint, idempotency_key);
        
        let mut req = match method {
            "POST" => self.client.post(format!("https://api.gameket.io{}", endpoint)),
            "PATCH" => self.client.patch(format!("https://api.gameket.io{}", endpoint)),
            _ => return Err("Unsupported method".into()),
        };

        let response = req
            .header("Idempotency-Key", idempotency_key)
            .json(&body)
            .send()
            .await?;

        Ok(response.json().await?)
    }
}
```

## Query Parameters

API endpoints accept query parameters for filtering, pagination, and search.

### Pagination Parameters

**Supported on all list endpoints:**

| Parameter | Type | Default | Max | Description |
|-----------|------|---------|-----|-------------|
| `page` | integer | 1 | — | Page number (1-indexed) |
| `limit` | integer | 20 | 100 | Results per page |

**Example:**
```bash
# Get page 2 with 50 results per page
GET /merchant/orders?page=2&limit=50
```

**Response includes pagination metadata:**
```json
{
  "success": true,
  "data": [...],
  "pagination": {
    "page": 2,
    "limit": 50,
    "total": 250,
    "pages": 5
  }
}
```

### Filter Parameters

**Orders endpoint:**
```bash
GET /merchant/orders?status=pending&type=game-vouchers&page=1&limit=20

Parameters:
- status: pending | billed | codes-delivered | completed | refunded | cancelled | disputed
- type: direct-top-up | game-vouchers | gift-cards | prepaid | social-media-entertainment
- orderId: specific order ID
- from: ISO date (e.g., 2026-05-01)
- to: ISO date (e.g., 2026-05-31)
```

**Products endpoint:**
```bash
GET /merchant/products?type=game-vouchers&isActive=true&search=fifa&page=1&limit=20

Parameters:
- productId: specific product ID
- type: product category
- isApi: true | false
- isActive: true | false
- search: free text search on product name
```

### Query Parameter Encoding

Always URL-encode special characters:

```javascript
// Bad: spaces and special characters not encoded
GET /merchant/products?search=fifa 2024

// Good: properly URL-encoded
GET /merchant/products?search=fifa%202024

// Using URLSearchParams (JavaScript)
const params = new URLSearchParams({
  search: 'fifa 2024',
  page: 1,
  limit: 20
});
const url = `https://api.gameket.io/merchant/products?${params.toString()}`;
```

## Error Handling

All errors follow a standard format:

```json
{
  "success": false,
  "error": "Order not found",
  "code": "ORDER_NOT_FOUND",
  "requestId": "req_abc123def456"
}
```

### Common Status Codes

| Code | Meaning | Action |
|------|---------|--------|
| 200 | OK | Success |
| 201 | Created | Resource created |
| 400 | Bad Request | Invalid parameters |
| 401 | Unauthorized | Invalid/missing token |
| 403 | Forbidden | Not allowed |
| 404 | Not Found | Resource doesn't exist |
| 409 | Conflict | Duplicate/conflict |
| 429 | Too Many Requests | Rate limited |
| 500 | Server Error | Retry later |

### Using Request IDs

Every response includes a `requestId` for debugging:

```json
{
  "success": false,
  "error": "Database connection failed",
  "code": "DB_ERROR",
  "requestId": "req_xyz789"
}
```

Save this ID when reporting issues to support.

## Best Practices

### 1. Always Use Idempotency Keys
```javascript
headers['Idempotency-Key'] = generateUUID();
```

### 2. Implement Retry Logic
```javascript
async function retryRequest(fn, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      await sleep(Math.pow(2, i) * 1000); // Exponential backoff
    }
  }
}
```

### 3. Handle Rate Limiting
```javascript
if (response.status === 429) {
  const retryAfter = response.headers.get('retry-after');
  await sleep(parseInt(retryAfter) * 1000);
  // Retry request
}
```

### 4. Log Request IDs
```javascript
console.log(`Request ${requestId} completed in ${duration}ms`);
```

### 5. Validate Query Parameters
```javascript
const validStatuses = ['pending', 'completed', 'refunded'];
if (!validStatuses.includes(status)) {
  throw new Error(`Invalid status: ${status}`);
}
```

## Next Steps

- [Authentication](authentication.md) - Set up token-based auth
- [Products](products.md) - Manage your product catalog
- [Orders](orders.md) - Handle orders and fulfillment
- [Examples](examples.md) - Full code examples
