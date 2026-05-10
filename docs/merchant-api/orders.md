# Orders

Manage merchant orders through the Orders API. View, fulfill, refund, and cancel orders.

## List Orders

Retrieve all orders for your store.

**Endpoint:**
```
GET /merchant/orders
```

**Query Parameters:**
```
- orderId: specific order ID (optional)
- status: order status filter (optional)
- type: product type filter (optional)
- from: start date ISO format (optional)
- to: end date ISO format (optional)
- page: page number (default: 1)
- limit: results per page (default: 20, max: 100)
```

**Request:**
```bash
curl -X GET "https://api.gameket.io/merchant/orders?status=pending&page=1&limit=20" \
  -H "Authorization: Bearer {token}" \
  -H "x-merchant-api-key: {apiKey}"
```

**Response (200 OK):**
```json
{
  "success": true,
  "data": [
    {
      "orderId": "ord_abc123",
      "storeId": "store_xyz789",
      "buyerId": "buyer_def456",
      "productId": "prod_ghi789",
      "amount": 50,
      "status": "pending",
      "type": "game-vouchers",
      "quantity": 1,
      "notes": "FIFA 2026 Coins",
      "codesDelivered": 0,
      "codesRequired": 1,
      "createdAt": "2026-05-10T14:00:00Z",
      "updatedAt": "2026-05-10T14:00:00Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 45
  }
}
```

## Get Order Codes

Retrieve delivery codes for an order.

**Endpoint:**
```
GET /merchant/orders/codes?orderId={orderId}
```

**Request:**
```bash
curl -X GET "https://api.gameket.io/merchant/orders/codes?orderId=ord_abc123" \
  -H "Authorization: Bearer {token}" \
  -H "x-merchant-api-key: {apiKey}"
```

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "orderId": "ord_abc123",
    "codes": [
      {
        "code": "FIFA26-ABC-XYZ-123",
        "type": "game-voucher",
        "deliveredAt": "2026-05-10T14:15:00Z"
      }
    ],
    "codesRequired": 1,
    "codesDelivered": 1,
    "status": "completed"
  }
}
```

## Add Order Codes

Deliver codes to fulfill an order.

**Endpoint:**
```
POST /merchant/orders/codes?orderId={orderId}
```

**Headers:**
```
Authorization: Bearer {token}
x-merchant-api-key: {apiKey}
Idempotency-Key: {unique-key}
Content-Type: application/json
```

**Request Body:**
```json
{
  "codes": ["FIFA26-ABC-XYZ-123", "FIFA26-DEF-UVW-456"]
}
```

**Request:**
```bash
curl -X POST "https://api.gameket.io/merchant/orders/codes?orderId=ord_abc123" \
  -H "Authorization: Bearer {token}" \
  -H "x-merchant-api-key: {apiKey}" \
  -H "Idempotency-Key: deliver-codes-123" \
  -H "Content-Type: application/json" \
  -d '{
    "codes": ["FIFA26-ABC-XYZ-123"]
  }'
```

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "orderId": "ord_abc123",
    "codesDelivered": 1,
    "codesRequired": 1,
    "status": "codes-delivered"
  }
}
```

**Note:** Order auto-completes when all required codes are delivered.

## Complete Order

Manually mark an order as complete.

**Endpoint:**
```
POST /merchant/orders/complete?orderId={orderId}
```

**Headers:**
```
Authorization: Bearer {token}
x-merchant-api-key: {apiKey}
Idempotency-Key: {unique-key}
Content-Type: application/json
```

**Request:**
```bash
curl -X POST "https://api.gameket.io/merchant/orders/complete?orderId=ord_abc123" \
  -H "Authorization: Bearer {token}" \
  -H "x-merchant-api-key: {apiKey}" \
  -H "Idempotency-Key: complete-order-123"
```

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "orderId": "ord_abc123",
    "status": "completed",
    "completedAt": "2026-05-10T14:30:00Z"
  }
}
```

**Allowed Status Transitions:**
- `pending` → `completed`
- `billed` → `completed`

**Rejected Status Transitions:**
- `codes-delivered` → `completed` (auto-completes)
- `completed` → `completed` (already complete)
- `refunded` → `completed` (cannot complete refunded orders)
- `cancelled` → `completed` (cannot complete cancelled orders)

## Refund Order

Refund an order and return funds to the buyer.

**Endpoint:**
```
POST /merchant/orders/refund?orderId={orderId}
```

**Headers:**
```
Authorization: Bearer {token}
x-merchant-api-key: {apiKey}
Idempotency-Key: {unique-key}
Content-Type: application/json
```

**Request Body:**
```json
{
  "reason": "Buyer requested refund",
  "amount": 50
}
```

**Request:**
```bash
curl -X POST "https://api.gameket.io/merchant/orders/refund?orderId=ord_abc123" \
  -H "Authorization: Bearer {token}" \
  -H "x-merchant-api-key: {apiKey}" \
  -H "Idempotency-Key: refund-order-123" \
  -H "Content-Type: application/json" \
  -d '{
    "reason": "Buyer requested refund",
    "amount": 50
  }'
```

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "orderId": "ord_abc123",
    "refundAmount": 50,
    "status": "refunded",
    "refundedAt": "2026-05-10T14:45:00Z"
  }
}
```

**Features:**
- ✅ Refund emails sent to both merchant and buyer
- ✅ Buyer balance restored
- ✅ Reverses financial state
- ✅ Logged for audit trail

## Cancel Order

Cancel an order and refund the buyer.

**Endpoint:**
```
POST /merchant/orders/cancel?orderId={orderId}
```

**Headers:**
```
Authorization: Bearer {token}
x-merchant-api-key: {apiKey}
Idempotency-Key: {unique-key}
```

**Request:**
```bash
curl -X POST "https://api.gameket.io/merchant/orders/cancel?orderId=ord_abc123" \
  -H "Authorization: Bearer {token}" \
  -H "x-merchant-api-key: {apiKey}" \
  -H "Idempotency-Key: cancel-order-123"
```

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "orderId": "ord_abc123",
    "status": "cancelled",
    "cancelledAt": "2026-05-10T15:00:00Z"
  }
}
```

## Order Status Values

| Status | Description | Merchant Action |
|--------|-------------|-----------------|
| `pending` | Order created, awaiting code delivery | Deliver codes |
| `billed` | Buyer charged, awaiting fulfillment | Deliver codes |
| `codes-delivered` | Codes delivered to buyer | Auto-completes |
| `completed` | Order complete | None |
| `refunded` | Order refunded | Monitor for disputes |
| `cancelled` | Order cancelled | None |
| `disputed` | Buyer disputed the order | Contact support |

## Update Order Status (Action Alias)

`PATCH` and `PUT` on `/merchant/orders` are action aliases for status transitions.
They do **not** support arbitrary updates such as changing `amount` or `notes`.

**Endpoints:**
```
PATCH /merchant/orders?orderId={orderId}
PUT /merchant/orders?orderId={orderId}
```

**Supported Request Body:**
```json
{
  "status": "completed"
}
```

Supported `status` values:
- `completed` (or `complete`) → same behavior as `POST /merchant/orders/complete`
- `refunded` (or `refund`) → same behavior as `POST /merchant/orders/refund`
- `cancelled` (or `cancel`) → same behavior as `POST /merchant/orders/cancel`

Unsupported values (for example `pending`) return `400`.

**Equivalent examples:**

Complete:
```bash
curl -X PATCH "https://api.gameket.io/merchant/orders?orderId=ord_abc123" \
  -H "Authorization: Bearer {token}" \
  -H "x-merchant-api-key: {apiKey}" \
  -H "Idempotency-Key: complete-order-123" \
  -H "Content-Type: application/json" \
  -d '{"status":"completed"}'
```

Refund:
```bash
curl -X PUT "https://api.gameket.io/merchant/orders?orderId=ord_abc123" \
  -H "Authorization: Bearer {token}" \
  -H "x-merchant-api-key: {apiKey}" \
  -H "Idempotency-Key: refund-order-123" \
  -H "Content-Type: application/json" \
  -d '{"status":"refunded"}'
```

Cancel:
```bash
curl -X PATCH "https://api.gameket.io/merchant/orders?orderId=ord_abc123" \
  -H "Authorization: Bearer {token}" \
  -H "x-merchant-api-key: {apiKey}" \
  -H "Idempotency-Key: cancel-order-123" \
  -H "Content-Type: application/json" \
  -d '{"status":"cancelled"}'
```

## Common Workflows

### Workflow 1: Manual Code Delivery

```javascript
// 1. Get pending orders
const ordersResponse = await fetch('https://api.gameket.io/merchant/orders?status=pending', {
  headers: { 'Authorization': `Bearer ${token}`, 'x-merchant-api-key': apiKey }
});
const { data: orders } = await ordersResponse.json();

// 2. For each order, deliver codes
for (const order of orders) {
  await fetch(`https://api.gameket.io/merchant/orders/codes?orderId=${order.orderId}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'x-merchant-api-key': apiKey,
      'Idempotency-Key': uuid(),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      codes: ['CODE-001', 'CODE-002'] // Generate or fetch from your system
    })
  });
}
```

### Workflow 2: Handle Refunds

```javascript
async function handleRefund(orderId, reason) {
  const response = await fetch(`https://api.gameket.io/merchant/orders/refund?orderId=${orderId}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'x-merchant-api-key': apiKey,
      'Idempotency-Key': uuid(),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ reason, amount: 50 })
  });
  
  const { data } = await response.json();
  console.log(`Refund processed: ${data.refundAmount} on ${data.refundedAt}`);
  
  return data;
}
```

### Workflow 3: Auto-Complete Orders

```javascript
// Orders auto-complete when all codes are delivered
// Manually complete if needed:

async function manuallyCompleteOrder(orderId) {
  const response = await fetch(`https://api.gameket.io/merchant/orders/complete?orderId=${orderId}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'x-merchant-api-key': apiKey,
      'Idempotency-Key': uuid()
    }
  });
  
  const { data } = await response.json();
  return data;
}
```

### Python: Manual Code Delivery Workflow

```python
import requests
from uuid import uuid4

def deliver_codes_to_pending_orders(token, api_key):
    """Deliver codes to all pending orders"""
    # 1. Get pending orders
    orders_response = requests.get(
        'https://api.gameket.io/merchant/orders?status=pending',
        headers={
            'Authorization': f'Bearer {token}',
            'x-merchant-api-key': api_key
        }
    )
    
    orders = orders_response.json()['data']
    
    # 2. For each order, deliver codes
    for order in orders:
        requests.post(
            f'https://api.gameket.io/merchant/orders/codes?orderId={order["orderId"]}',
            headers={
                'Authorization': f'Bearer {token}',
                'x-merchant-api-key': api_key,
                'Idempotency-Key': str(uuid4()),
                'Content-Type': 'application/json'
            },
            json={
                'codes': ['CODE-001', 'CODE-002']  # Generate or fetch from your system
            }
        )
        print(f"Delivered codes to order {order['orderId']}")

def handle_refund(token, api_key, order_id, reason, amount):
    """Process a refund for an order"""
    response = requests.post(
        f'https://api.gameket.io/merchant/orders/refund?orderId={order_id}',
        headers={
            'Authorization': f'Bearer {token}',
            'x-merchant-api-key': api_key,
            'Idempotency-Key': str(uuid4()),
            'Content-Type': 'application/json'
        },
        json={'reason': reason, 'amount': amount}
    )
    
    data = response.json()['data']
    print(f"Refund processed: {data['refundAmount']} on {data['refundedAt']}")
    return data

def manually_complete_order(token, api_key, order_id):
    """Manually complete an order"""
    response = requests.post(
        f'https://api.gameket.io/merchant/orders/complete?orderId={order_id}',
        headers={
            'Authorization': f'Bearer {token}',
            'x-merchant-api-key': api_key,
            'Idempotency-Key': str(uuid4())
        }
    )
    
    return response.json()['data']
```

### Rust: Order Management Workflows

```rust
use reqwest::Client;
use serde_json::json;
use uuid::Uuid;

pub struct OrderManager {
    client: Client,
    api_key: String,
    token: String,
}

impl OrderManager {
    pub fn new(client: Client, api_key: String, token: String) -> Self {
        Self {
            client,
            api_key,
            token,
        }
    }

    async fn deliver_codes_to_pending_orders(
        &self,
    ) -> Result<(), Box<dyn std::error::Error>> {
        // 1. Get pending orders
        let orders_response = self
            .client
            .get("https://api.gameket.io/merchant/orders?status=pending")
            .header("Authorization", format!("Bearer {}", self.token))
            .header("x-merchant-api-key", &self.api_key)
            .send()
            .await?;

        let orders_data: serde_json::Value = orders_response.json().await?;
        let orders = orders_data["data"].as_array().unwrap_or(&vec![]);

        // 2. For each order, deliver codes
        for order in orders {
            let order_id = order["orderId"].as_str().unwrap();
            
            self.client
                .post(format!(
                    "https://api.gameket.io/merchant/orders/codes?orderId={}",
                    order_id
                ))
                .header("Authorization", format!("Bearer {}", self.token))
                .header("x-merchant-api-key", &self.api_key)
                .header("Idempotency-Key", Uuid::new_v4().to_string())
                .json(&json!({
                    "codes": ["CODE-001", "CODE-002"]
                }))
                .send()
                .await?;

            println!("Delivered codes to order {}", order_id);
        }

        Ok(())
    }

    async fn handle_refund(
        &self,
        order_id: &str,
        reason: &str,
        amount: f64,
    ) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
        let response = self
            .client
            .post(format!(
                "https://api.gameket.io/merchant/orders/refund?orderId={}",
                order_id
            ))
            .header("Authorization", format!("Bearer {}", self.token))
            .header("x-merchant-api-key", &self.api_key)
            .header("Idempotency-Key", Uuid::new_v4().to_string())
            .json(&json!({
                "reason": reason,
                "amount": amount
            }))
            .send()
            .await?;

        let data = response.json::<serde_json::Value>().await?;
        println!(
            "Refund processed: {} on {}",
            data["data"]["refundAmount"], data["data"]["refundedAt"]
        );

        Ok(data["data"].clone())
    }

    async fn manually_complete_order(
        &self,
        order_id: &str,
    ) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
        let response = self
            .client
            .post(format!(
                "https://api.gameket.io/merchant/orders/complete?orderId={}",
                order_id
            ))
            .header("Authorization", format!("Bearer {}", self.token))
            .header("x-merchant-api-key", &self.api_key)
            .header("Idempotency-Key", Uuid::new_v4().to_string())
            .send()
            .await?;

        Ok(response.json().await?)
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = Client::new();
    let api_key = std::env::var("MERCHANT_API_KEY")?;
    let token = std::env::var("MERCHANT_TOKEN")?;

    let manager = OrderManager::new(client, api_key, token);

    // Deliver codes to pending orders
    manager.deliver_codes_to_pending_orders().await?;

    // Handle a refund
    manager
        .handle_refund("order_123", "Customer request", 50.0)
        .await?;

    // Manually complete order
    manager.manually_complete_order("order_123").await?;

    Ok(())
}
```

## Error Responses

### 400 Bad Request
```json
{
  "success": false,
  "error": "Invalid order status for refund",
  "code": "INVALID_STATUS",
  "requestId": "req_abc123"
}
```

### 404 Not Found
```json
{
  "success": false,
  "error": "Order not found",
  "code": "ORDER_NOT_FOUND",
  "requestId": "req_def456"
}
```

### 409 Conflict
```json
{
  "success": false,
  "error": "Cannot refund completed order",
  "code": "INVALID_STATUS_TRANSITION",
  "requestId": "req_ghi789"
}
```

## Next Steps

- [Products API](products.md) - Manage product catalog
- [Rate Limiting](rate-limiting.md) - API quotas and best practices
- [Examples](examples.md) - Full integration examples
