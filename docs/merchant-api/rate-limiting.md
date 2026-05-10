# Rate Limiting

Gameket API uses rate limiting to ensure fair usage and protect service stability. This guide explains limits, headers, and best practices.

## General Rate Limits

### Per-Minute Limits

| Endpoint Type | Limit | Window |
|---------------|-------|--------|
| Read (GET) | 20 requests | 1 minute |
| Write (POST, PATCH, PUT, DELETE) | 20 requests | 1 minute |

**Example:**
- ✅ 20 GET requests in 60 seconds
- ✅ 20 POST requests in 60 seconds
- ✅ 10 GETs + 10 POSTs in 60 seconds
- ❌ 21 GET requests in 60 seconds → Rate limited

### Merchant Bucket

Each merchant API key has separate rate limit buckets:
- **Read bucket:** 20 requests/minute
- **Write bucket:** 20 requests/minute

Multiple API keys from the same store share the same limits.

## Token Issuance Limits

The `/merchant/auth/check` endpoint has stricter limits to prevent abuse.

**Token Issuance Rate Limit:**

| Parameter | Value |
|-----------|-------|
| **Limit** | 2 tokens |
| **Window** | 1 hour |
| **Per** | Merchant API Key |

**Example:**
- ✅ Request token at 10:00 AM
- ✅ Request token at 10:30 AM (same key, same hour)
- ❌ Request token at 10:45 AM (same key, same hour) → Rate limited
- ✅ Request token at 11:15 AM (new hour) → Allowed

**Why?** 2-hour tokens mean you only need 1 per session. Frequent token requests indicate a misconfiguration.

## Rate Limit Headers

Every response includes rate limit information:

```
x-ratelimit-policy: api-key:read | api-key:write | token-issuance
x-ratelimit-limit: 20
x-ratelimit-remaining: 19
x-ratelimit-reset: 2026-05-10T15:30:00Z
```

### Reading Headers

```javascript
const limit = parseInt(response.headers['x-ratelimit-limit']);
const remaining = parseInt(response.headers['x-ratelimit-remaining']);
const resetAt = new Date(response.headers['x-ratelimit-reset']);

console.log(`Requests remaining: ${remaining}/${limit}`);
console.log(`Limit resets at: ${resetAt.toISOString()}`);

// Stop making requests if close to limit
if (remaining < 10) {
  console.warn('Approaching rate limit, slowing down...');
}
```

## Handling 429 Responses

When rate limited, the API returns `429 Too Many Requests`:

```json
{
  "success": false,
  "message": "Too many merchant requests",
  "retryAfterSeconds": 45,
  "requestId": "req_abc123"
}
```

**Rate Limit Headers:**
```
HTTP/1.1 429 Too Many Requests
x-ratelimit-remaining: 0
x-ratelimit-reset: 2026-05-10T15:30:00Z
retry-after: 45
```

### Retry Strategy

**Exponential Backoff:**
```javascript
async function apiRequestWithRetry(method, endpoint, body, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(`https://api.gameket.io${endpoint}`, {
        method,
        headers: { /* ... */ },
        body: body ? JSON.stringify(body) : null
      });

      if (response.status === 429) {
        const retryAfter = parseInt(response.headers['retry-after']) || Math.pow(2, attempt);
        console.log(`Rate limited. Retrying after ${retryAfter} seconds...`);
        await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
        continue;
      }

      return response;
    } catch (error) {
      if (attempt === maxRetries - 1) throw error;
      const delayMs = Math.pow(2, attempt) * 1000;
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
}
```

## Best Practices

### 1. Monitor Remaining Requests

```javascript
class RateLimitMonitor {
  constructor() {
    this.readRemaining = 20;
    this.writeRemaining = 20;
  }

  updateFromResponse(response) {
    const policy = response.headers['x-ratelimit-policy'];
    const remaining = parseInt(response.headers['x-ratelimit-remaining']);

    if (policy === 'api-key:read') {
      this.readRemaining = remaining;
    } else if (policy === 'api-key:write') {
      this.writeRemaining = remaining;
    }

    // Warn if approaching limit
    if (remaining < 50) {
      console.warn(`⚠️ ${policy}: ${remaining} requests remaining`);
    }
  }

  canMakeRequest(method) {
    if (method === 'GET') return this.readRemaining > 0;
    return this.writeRemaining > 0;
  }
}
```

### 2. Batch Operations

Instead of updating one product at a time, batch updates:

```javascript
// ❌ Bad: 100 requests
for (const product of products) {
  await fetch(`/merchant/products?productId=${product.id}`, {
    method: 'PATCH',
    body: JSON.stringify(product)
  });
}

// ✅ Good: 1 request (if API supports bulk operations)
// Or cache updates locally and batch weekly
```

### 3. Cache Data Locally

```javascript
class CachedMerchantAPI {
  constructor(ttlMs = 60000) {
    this.cache = new Map();
    this.ttlMs = ttlMs;
  }

  async getOrders(query) {
    const cacheKey = JSON.stringify(query);
    const cached = this.cache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < this.ttlMs) {
      return cached.data;
    }

    const response = await fetch(`/merchant/orders?${new URLSearchParams(query)}`);
    const data = await response.json();

    this.cache.set(cacheKey, { data, timestamp: Date.now() });
    return data;
  }
}
```

### 4. Schedule Requests During Off-Peak Hours

```javascript
// Get reports and sync data during low-traffic times
setInterval(async () => {
  const now = new Date();
  const hour = now.getHours();

  // Schedule heavy operations during night hours (1-5 AM)
  if (hour >= 1 && hour <= 5) {
    await syncAllData();
  }
}, 60000); // Check every minute
```

### 5. Implement Request Queuing

```javascript
class RequestQueue {
  constructor(rateLimit = 20) {
    this.queue = [];
    this.activeRequests = 0;
    this.rateLimit = rateLimit;
  }

  async add(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this.process();
    });
  }

  async process() {
    if (this.activeRequests >= this.rateLimit || this.queue.length === 0) {
      return;
    }

    this.activeRequests++;
    const { fn, resolve, reject } = this.queue.shift();

    try {
      const result = await fn();
      resolve(result);
    } catch (error) {
      reject(error);
    } finally {
      this.activeRequests--;
      this.process();
    }
  }
}

// Usage
const queue = new RequestQueue(20); // keep throughput within current per-minute limits

for (const order of orders) {
  queue.add(() => updateOrder(order));
}
```

### 6. Token Refresh Optimization

```javascript
// ✅ Good: Get new token every 90 minutes
setInterval(async () => {
  token = await requestNewToken();
}, 90 * 60 * 1000);

// ❌ Bad: Get new token on every request (wastes limit!)
async function apiRequest(endpoint) {
  const token = await requestNewToken(); // Requests 2+ tokens per hour!
  return fetch(endpoint, { headers: { Authorization: `Bearer ${token}` } });
}
```

## Quota Calculation

**Per minute limits:**
- 20 reads/minute = 0.33 reads/second
- 20 writes/minute = 0.33 writes/second

**Daily allowance (assuming 24-hour operation):**
- Reads: 20 × 1440 = **28,800 requests/day**
- Writes: 20 × 1440 = **28,800 requests/day**

**Practical limits:**
- Small merchant (100 orders/day): ~200 API calls/day → ✅ Well within limits
- Large merchant (10,000 orders/day): ~20,000 API calls/day → ✅ Still within limits

## Rate Limit Increase Requests

If you consistently hit rate limits and need higher quotas:

1. Contact support with usage metrics
2. Provide 30-day request history
3. Explain integration requirements
4. Submit formal rate limit increase request

**Eligibility criteria:**
- Rank 5+ merchant (Tier Silver)
- 90+ days active merchant account
- Good standing (no policy violations)

## Monitoring & Alerts

### Set Up Alerts

```javascript
// Alert if rate limit drops below 20%
function checkRateLimitHealth(response) {
  const remaining = parseInt(response.headers['x-ratelimit-remaining']);
  const limit = parseInt(response.headers['x-ratelimit-limit']);
  const percentage = (remaining / limit) * 100;

  if (percentage < 20) {
    sendAlert(`Rate limit at ${percentage}%`);
  }
}
```

### Log Rate Limit Events

```javascript
function logRateLimitEvent(response) {
  const event = {
    timestamp: new Date().toISOString(),
    policy: response.headers['x-ratelimit-policy'],
    remaining: response.headers['x-ratelimit-remaining'],
    limit: response.headers['x-ratelimit-limit'],
    reset: response.headers['x-ratelimit-reset'],
    requestId: response.headers['request-id']
  };

  console.log(JSON.stringify(event));
  // Save to logging service
}
```

## Next Steps

- [Authentication](authentication.md) - Manage tokens efficiently
- [Core Concepts](core-concepts.md) - Request/response patterns
- [Examples](examples.md) - Full integration code
