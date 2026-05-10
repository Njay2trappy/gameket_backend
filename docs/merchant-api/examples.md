# Examples & Guides

Practical examples for integrating with the Gameket Merchant API in different languages and platforms.

## cURL Examples

### 1. Get Access Token

```bash
curl -X POST https://api.gameket.io/merchant/auth/check \
  -H "Content-Type: application/json" \
  -d '{
    "apiKey": "mapi_abc123def456",
    "secret": "your_merchant_secret"
  }'
```

**Save the token:**
```bash
TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
API_KEY="mapi_abc123def456"
```

### 2. Get Merchant Profile

```bash
curl -X GET https://api.gameket.io/merchant \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-merchant-api-key: $API_KEY"
```

### 3. List Orders

```bash
curl -X GET "https://api.gameket.io/merchant/orders?status=pending&page=1&limit=20" \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-merchant-api-key: $API_KEY"
```

### 4. Create Product

```bash
curl -X POST https://api.gameket.io/merchant/products \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-merchant-api-key: $API_KEY" \
  -H "Idempotency-Key: product-fifa-coins" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "FIFA 2026 Coins",
    "description": "In-game currency",
    "type": "game-vouchers",
    "price": 50,
    "currency": "USD",
    "isApi": true
  }'
```

### 5. Deliver Order Codes

```bash
curl -X POST "https://api.gameket.io/merchant/orders/codes?orderId=ord_abc123" \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-merchant-api-key: $API_KEY" \
  -H "Idempotency-Key: deliver-codes-001" \
  -H "Content-Type: application/json" \
  -d '{
    "codes": ["FIFA26-ABC-XYZ-123", "FIFA26-DEF-UVW-456"]
  }'
```

### 6. Refund Order

```bash
curl -X POST "https://api.gameket.io/merchant/orders/refund?orderId=ord_abc123" \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-merchant-api-key: $API_KEY" \
  -H "Idempotency-Key: refund-001" \
  -H "Content-Type: application/json" \
  -d '{
    "reason": "Customer requested refund",
    "amount": 50
  }'
```

## Node.js Integration

### Basic Setup

```javascript
class GametekMerchantAPI {
  constructor(apiKey, secret, baseUrl = 'https://api.gameket.io') {
    this.apiKey = apiKey;
    this.secret = secret;
    this.baseUrl = baseUrl;
    this.token = null;
    this.tokenExpiresAt = null;
  }

  async getToken() {
    // Return cached token if still valid
    if (this.token && Date.now() < this.tokenExpiresAt - 60000) {
      return this.token;
    }

    const response = await fetch(`${this.baseUrl}/merchant/auth/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiKey: this.apiKey,
        secret: this.secret
      })
    });

    if (!response.ok) throw new Error('Token request failed');

    const { data } = await response.json();
    this.token = data.token;
    this.tokenExpiresAt = new Date(data.expiresAt).getTime();

    return this.token;
  }

  async request(method, endpoint, body = null) {
    const token = await this.getToken();
    const options = {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'x-merchant-api-key': this.apiKey,
        'Content-Type': 'application/json'
      }
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(`${this.baseUrl}${endpoint}`, options);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(`API Error: ${data.error}`);
    }

    return data;
  }

  // Convenience methods
  async getProfile() {
    return this.request('GET', '/merchant');
  }

  async listOrders(page = 1, limit = 20, filters = {}) {
    const params = new URLSearchParams({ page, limit, ...filters });
    return this.request('GET', `/merchant/orders?${params}`);
  }

  async createProduct(productData) {
    return this.request('POST', '/merchant/products', productData);
  }

  async deliverCodes(orderId, codes) {
    return this.request('POST', `/merchant/orders/codes?orderId=${orderId}`, { codes });
  }

  async refundOrder(orderId, reason, amount) {
    return this.request('POST', `/merchant/orders/refund?orderId=${orderId}`, {
      reason,
      amount
    });
  }
}

// Usage
const client = new GametekMerchantAPI(
  process.env.MERCHANT_API_KEY,
  process.env.MERCHANT_SECRET
);

// Get profile
const profile = await client.getProfile();
console.log(`Welcome ${profile.data.storeName}`);

// List pending orders
const orders = await client.listOrders(1, 50, { status: 'pending' });
console.log(`Found ${orders.data.length} pending orders`);
```

### Batch Process Orders

```javascript
async function processPendingOrders(client) {
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const { data: orders, pagination } = await client.listOrders(page, 100, {
      status: 'pending'
    });

    for (const order of orders) {
      try {
        // Generate or fetch codes from your system
        const codes = await generateCodesForOrder(order);

        // Deliver codes
        await client.deliverCodes(order.orderId, codes);
        console.log(`✓ Delivered codes for order ${order.orderId}`);
      } catch (error) {
        console.error(`✗ Failed to process order ${order.orderId}:`, error);
      }
    }

    hasMore = page < pagination.pages;
    page++;
  }
}

async function generateCodesForOrder(order) {
  // Your code generation logic here
  return [
    `FIFA26-${Math.random().toString(36).substr(2, 9).toUpperCase()}`,
    `FIFA26-${Math.random().toString(36).substr(2, 9).toUpperCase()}`
  ];
}

// Run every hour
setInterval(() => processPendingOrders(client), 60 * 60 * 1000);
```

## Python Integration

### Basic Setup

```python
import requests
import os
from datetime import datetime, timedelta
import json

class GametekMerchantAPI:
    def __init__(self, api_key, secret, base_url='https://api.gameket.io'):
        self.api_key = api_key
        self.secret = secret
        self.base_url = base_url
        self.token = None
        self.token_expires_at = None

    def get_token(self):
        """Get or refresh access token"""
        if self.token and datetime.now() < self.token_expires_at - timedelta(seconds=60):
            return self.token

        response = requests.post(
            f'{self.base_url}/merchant/auth/check',
            json={
                'apiKey': self.api_key,
                'secret': self.secret
            }
        )
        response.raise_for_status()

        data = response.json()['data']
        self.token = data['token']
        self.token_expires_at = datetime.fromisoformat(
            data['expiresAt'].replace('Z', '+00:00')
        )

        return self.token

    def request(self, method, endpoint, json_body=None, **kwargs):
        """Make authenticated API request"""
        token = self.get_token()
        headers = {
            'Authorization': f'Bearer {token}',
            'x-merchant-api-key': self.api_key,
            'Content-Type': 'application/json'
        }
        headers.update(kwargs.get('headers', {}))

        response = requests.request(
            method,
            f'{self.base_url}{endpoint}',
            json=json_body,
            headers=headers,
            **{k: v for k, v in kwargs.items() if k != 'headers'}
        )
        response.raise_for_status()

        return response.json()

    def get_profile(self):
        """Get merchant profile"""
        return self.request('GET', '/merchant')

    def list_orders(self, page=1, limit=20, **filters):
        """List orders with optional filters"""
        params = {'page': page, 'limit': limit, **filters}
        params_str = '&'.join(f'{k}={v}' for k, v in params.items())
        return self.request('GET', f'/merchant/orders?{params_str}')

    def create_product(self, product_data):
        """Create new product"""
        return self.request('POST', '/merchant/products', product_data)

    def deliver_codes(self, order_id, codes):
        """Deliver codes to fulfill order"""
        return self.request(
            'POST',
            f'/merchant/orders/codes?orderId={order_id}',
            {'codes': codes},
            headers={'Idempotency-Key': f'deliver-{order_id}'}
        )

    def refund_order(self, order_id, reason, amount):
        """Refund an order"""
        return self.request(
            'POST',
            f'/merchant/orders/refund?orderId={order_id}',
            {'reason': reason, 'amount': amount},
            headers={'Idempotency-Key': f'refund-{order_id}'}
        )

# Usage
client = GametekMerchantAPI(
    os.getenv('MERCHANT_API_KEY'),
    os.getenv('MERCHANT_SECRET')
)

# Get profile
profile = client.get_profile()
print(f"Welcome {profile['data']['storeName']}")

# List orders
orders = client.list_orders(page=1, limit=50, status='pending')
print(f"Found {len(orders['data'])} pending orders")

# Deliver codes for first order
if orders['data']:
    order = orders['data'][0]
    codes = ['CODE-001', 'CODE-002']
    result = client.deliver_codes(order['orderId'], codes)
    print(f"Delivered codes to order {order['orderId']}")
```

## Rust Integration

### Basic Setup

Add dependencies to `Cargo.toml`:
```toml
[dependencies]
reqwest = { version = "0.11", features = ["json"] }
tokio = { version = "1", features = ["full"] }
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"
chrono = { version = "0.4", features = ["serde"] }
```

### Client Implementation

```rust
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::Mutex;
use chrono::{DateTime, Utc};

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct TokenResponse {
    pub token: String,
    pub token_type: String,
    pub expires_in_seconds: u32,
    pub expires_at: DateTime<Utc>,
    pub merchant: MerchantInfo,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct MerchantInfo {
    pub store_id: String,
    pub store_name: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ApiResponse<T> {
    pub success: bool,
    pub data: T,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct Order {
    pub order_id: String,
    pub status: String,
    pub amount: f64,
}

pub struct GametekMerchantAPI {
    client: Client,
    api_key: String,
    secret: String,
    base_url: String,
    token: Arc<Mutex<Option<TokenResponse>>>,
}

impl GametekMerchantAPI {
    pub fn new(api_key: String, secret: String) -> Self {
        Self {
            client: Client::new(),
            api_key,
            secret,
            base_url: "https://api.gameket.io".to_string(),
            token: Arc::new(Mutex::new(None)),
        }
    }

    pub async fn get_token(&self) -> Result<String, Box<dyn std::error::Error>> {
        let mut token_guard = self.token.lock().await;

        // Return cached token if still valid
        if let Some(token_resp) = token_guard.as_ref() {
            let expires_at = token_resp.expires_at.timestamp();
            let now = Utc::now().timestamp();
            if now < expires_at - 60 {
                return Ok(token_resp.token.clone());
            }
        }

        // Request new token
        let response = self
            .client
            .post(format!("{}/merchant/auth/check", self.base_url))
            .json(&serde_json::json!({
                "apiKey": self.api_key,
                "secret": self.secret
            }))
            .send()
            .await?;

        let resp_data: ApiResponse<TokenResponse> = response.json().await?;
        let token_resp = resp_data.data;
        let token = token_resp.token.clone();

        *token_guard = Some(token_resp);
        Ok(token)
    }

    pub async fn get_profile(&self) -> Result<ApiResponse<Order>, Box<dyn std::error::Error>> {
        let token = self.get_token().await?;

        let response = self
            .client
            .get(format!("{}/merchant", self.base_url))
            .header("Authorization", format!("Bearer {}", token))
            .header("x-merchant-api-key", &self.api_key)
            .send()
            .await?;

        Ok(response.json().await?)
    }

    pub async fn list_orders(
        &self,
        page: u32,
        limit: u32,
        status: Option<&str>,
    ) -> Result<ApiResponse<Vec<Order>>, Box<dyn std::error::Error>> {
        let token = self.get_token().await?;

        let mut url = format!(
            "{}/merchant/orders?page={}&limit={}",
            self.base_url, page, limit
        );

        if let Some(s) = status {
            url.push_str(&format!("&status={}", s));
        }

        let response = self
            .client
            .get(url)
            .header("Authorization", format!("Bearer {}", token))
            .header("x-merchant-api-key", &self.api_key)
            .send()
            .await?;

        Ok(response.json().await?)
    }

    pub async fn deliver_codes(
        &self,
        order_id: &str,
        codes: Vec<String>,
    ) -> Result<ApiResponse<Order>, Box<dyn std::error::Error>> {
        let token = self.get_token().await?;

        let response = self
            .client
            .post(format!(
                "{}/merchant/orders/codes?orderId={}",
                self.base_url, order_id
            ))
            .header("Authorization", format!("Bearer {}", token))
            .header("x-merchant-api-key", &self.api_key)
            .header("Idempotency-Key", format!("deliver-{}", order_id))
            .json(&serde_json::json!({ "codes": codes }))
            .send()
            .await?;

        Ok(response.json().await?)
    }

    pub async fn refund_order(
        &self,
        order_id: &str,
        reason: &str,
        amount: f64,
    ) -> Result<ApiResponse<Order>, Box<dyn std::error::Error>> {
        let token = self.get_token().await?;

        let response = self
            .client
            .post(format!(
                "{}/merchant/orders/refund?orderId={}",
                self.base_url, order_id
            ))
            .header("Authorization", format!("Bearer {}", token))
            .header("x-merchant-api-key", &self.api_key)
            .header("Idempotency-Key", format!("refund-{}", order_id))
            .json(&serde_json::json!({
                "reason": reason,
                "amount": amount
            }))
            .send()
            .await?;

        Ok(response.json().await?)
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = GametekMerchantAPI::new(
        std::env::var("MERCHANT_API_KEY")?,
        std::env::var("MERCHANT_SECRET")?,
    );

    // Get profile
    let profile = client.get_profile().await?;
    println!("Welcome {:?}", profile.data);

    // List orders
    let orders = client.list_orders(1, 50, Some("pending")).await?;
    println!("Found {} pending orders", orders.data.len());

    // Deliver codes for first order
    if let Some(order) = orders.data.first() {
        let codes = vec!["CODE-001".to_string(), "CODE-002".to_string()];
        let result = client.deliver_codes(&order.order_id, codes).await?;
        println!("Delivered codes to order {}", order.order_id);
    }

    Ok(())
}
```

### Batch Process Orders (Rust with Tokio)

```rust
use futures::stream::{self, StreamExt};

pub async fn process_pending_orders(
    client: &GametekMerchantAPI,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut page = 1;
    let mut has_more = true;

    while has_more {
        let response = client.list_orders(page, 100, Some("pending")).await?;
        let orders = &response.data;

        // Process orders concurrently (max 10 at a time)
        stream::iter(orders.iter())
            .map(|order| async move {
                let codes = vec![
                    format!("GAMEKET-{}", uuid::Uuid::new_v4()),
                    format!("GAMEKET-{}", uuid::Uuid::new_v4()),
                ];

                match client.deliver_codes(&order.order_id, codes).await {
                    Ok(_) => println!("✓ Delivered codes for order {}", order.order_id),
                    Err(e) => {
                        eprintln!("✗ Failed to process order {}: {}", order.order_id, e)
                    }
                }
            })
            .buffer_unordered(10)
            .collect::<()>()
            .await;

        // Check if there are more pages
        has_more = page < 10; // Replace with actual page count from response
        page += 1;
    }

    Ok(())
}

// Run in background task
#[tokio::main]
async fn main() {
    let client = GametekMerchantAPI::new(
        std::env::var("MERCHANT_API_KEY").unwrap(),
        std::env::var("MERCHANT_SECRET").unwrap(),
    );

    // Run every hour
    loop {
        if let Err(e) = process_pending_orders(&client).await {
            eprintln!("Error processing orders: {}", e);
        }
        tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
    }
}
```

## Express.js Webhook Handler

```javascript
const express = require('express');
const app = express();

app.use(express.json());

// Webhook endpoint for order notifications
app.post('/webhooks/gameket/order', (req, res) => {
  const { orderId, status, amount, type } = req.body;

  console.log(`Order webhook: ${orderId} -> ${status}`);

  // Process based on status
  switch (status) {
    case 'pending':
      // Generate and deliver codes
      generateAndDeliverCodes(orderId);
      break;

    case 'completed':
      // Order completed, no action needed
      console.log(`Order ${orderId} completed`);
      break;

    case 'refunded':
      // Order refunded, update your system
      handleOrderRefund(orderId, amount);
      break;

    case 'cancelled':
      // Order cancelled
      handleOrderCancellation(orderId);
      break;
  }

  // Acknowledge receipt
  res.json({ success: true, orderId });
});

async function generateAndDeliverCodes(orderId) {
  try {
    const codes = [
      `GAMEKET-${Math.random().toString(36).substr(2, 9).toUpperCase()}`,
      `GAMEKET-${Math.random().toString(36).substr(2, 9).toUpperCase()}`
    ];

    const result = await merchantAPI.deliverCodes(orderId, codes);
    console.log(`Codes delivered to order ${orderId}`);
  } catch (error) {
    console.error(`Failed to deliver codes: ${error.message}`);
  }
}

function handleOrderRefund(orderId, amount) {
  console.log(`Order ${orderId} refunded: $${amount}`);
  // Update your database, logs, etc.
}

function handleOrderCancellation(orderId) {
  console.log(`Order ${orderId} cancelled`);
  // Clean up resources, update inventory, etc.
}

app.listen(3000, () => {
  console.log('Webhook server listening on port 3000');
});
```

## Testing in Thunder Client

1. **Create Environment**
   - Variable: `base_url` = `https://api.gameket.io`
   - Variable: `token` = (will be set by requests)
   - Variable: `apiKey` = `mapi_abc123def456`

2. **Token Request**
   ```
   POST {{base_url}}/merchant/auth/check
   Body: { "apiKey": "...", "secret": "..." }
   Test: Set token variable
   ```

3. **Authenticated Requests**
   ```
   GET {{base_url}}/merchant
   Headers: 
   - Authorization: Bearer {{token}}
   - x-merchant-api-key: {{apiKey}}
   ```

## Monitoring & Logging

```javascript
class MerchantAPILogger {
  log(method, endpoint, status, duration, requestId) {
    const timestamp = new Date().toISOString();
    console.log(JSON.stringify({
      timestamp,
      method,
      endpoint,
      status,
      duration: `${duration}ms`,
      requestId
    }));
  }

  error(error, context) {
    const timestamp = new Date().toISOString();
    console.error(JSON.stringify({
      timestamp,
      level: 'error',
      error: error.message,
      code: error.code,
      context
    }));
  }
}

// Wrap requests with logging
async function loggedRequest(method, endpoint, body, logger) {
  const startTime = Date.now();
  try {
    const response = await fetch(`https://api.gameket.io${endpoint}`, {
      method,
      headers: { /* ... */ },
      body: body ? JSON.stringify(body) : null
    });

    const duration = Date.now() - startTime;
    const requestId = response.headers.get('request-id');
    logger.log(method, endpoint, response.status, duration, requestId);

    return response.json();
  } catch (error) {
    logger.error(error, { method, endpoint });
    throw error;
  }
}
```

## Next Steps

- [Authentication](authentication.md) - Secure token setup
- [Rate Limiting](rate-limiting.md) - Quota best practices
- [Error Handling](errors.md) - Handle errors gracefully
