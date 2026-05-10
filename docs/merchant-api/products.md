# Products

Manage your product catalog through the Products API. Create, update, delete, and manage stock for your products.

## List Products

Retrieve all products for your store.

**Endpoint:**
```
GET /merchant/products
```

**Query Parameters:**
```
- productId: specific product ID (optional)
- type: product category (optional)
- isApi: true | false (optional)
- isActive: true | false (optional)
- search: free text search (optional)
- page: page number (default: 1)
- limit: results per page (default: 20, max: 100)
```

**Request:**
```bash
curl -X GET "https://api.gameket.io/merchant/products?type=game-vouchers&isActive=true&page=1&limit=20" \
  -H "Authorization: Bearer {token}" \
  -H "x-merchant-api-key: {apiKey}"
```

**Response (200 OK):**
```json
{
  "success": true,
  "data": [
    {
      "productId": "prod_abc123",
      "name": "FIFA 2026 Coins",
      "description": "In-game currency for FIFA 2026",
      "type": "game-vouchers",
      "category": "Sports",
      "price": 50,
      "currency": "USD",
      "status": "active",
      "stock": {
        "available": 500,
        "reserved": 50,
        "sold": 2500,
        "method": "auto"
      },
      "isApi": true,
      "createdAt": "2026-01-15T10:00:00Z",
      "updatedAt": "2026-05-10T15:30:00Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 150
  }
}
```

## Create Product

Create a new product in your store.

**Endpoint:**
```
POST /merchant/products
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
  "name": "FIFA 2026 Coins",
  "description": "In-game currency for FIFA 2026",
  "type": "game-vouchers",
  "category": "Sports",
  "price": 50,
  "currency": "USD",
  "isApi": true
}
```

**Request:**
```bash
curl -X POST https://api.gameket.io/merchant/products \
  -H "Authorization: Bearer {token}" \
  -H "x-merchant-api-key: {apiKey}" \
  -H "Idempotency-Key: create-fifa-coins" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "FIFA 2026 Coins",
    "description": "In-game currency for FIFA 2026",
    "type": "game-vouchers",
    "category": "Sports",
    "price": 50,
    "currency": "USD",
    "isApi": true
  }'
```

**Response (201 Created):**
```json
{
  "success": true,
  "data": {
    "productId": "prod_xyz789",
    "name": "FIFA 2026 Coins",
    "price": 50,
    "status": "active",
    "createdAt": "2026-05-10T15:30:00Z"
  }
}
```

## Update Product

Update product details.

**Endpoint:**
```
PATCH /merchant/products?productId={productId}
```

**Headers:**
```
Authorization: Bearer {token}
x-merchant-api-key: {apiKey}
Idempotency-Key: {unique-key}
Content-Type: application/json
```

**Request Body (all fields optional):**
```json
{
  "name": "FIFA 2026 Ultimate Edition",
  "description": "Premium in-game currency",
  "price": 75,
  "status": "active"
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "productId": "prod_xyz789",
    "name": "FIFA 2026 Ultimate Edition",
    "price": 75,
    "updatedAt": "2026-05-10T16:00:00Z"
  }
}
```

## Delete Product

Delete a product from your store.

**Endpoint:**
```
DELETE /merchant/products?productId={productId}
```

**Headers:**
```
Authorization: Bearer {token}
x-merchant-api-key: {apiKey}
Idempotency-Key: {unique-key}
```

**Request:**
```bash
curl -X DELETE "https://api.gameket.io/merchant/products?productId=prod_xyz789" \
  -H "Authorization: Bearer {token}" \
  -H "x-merchant-api-key: {apiKey}" \
  -H "Idempotency-Key: delete-fifa-coins"
```

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "message": "Product deleted successfully"
  }
}
```

## Manage Stock

### Update Stock Status

**Endpoint:**
```
PATCH /merchant/products/status?productId={productId}
```

**Request Body:**
```json
{
  "status": "active" | "inactive" | "out-of-stock"
}
```

### Auto Stock Management

**Endpoint:**
```
POST /merchant/products/stock/auto?productId={productId}
```

**Request Body:**
```json
{
  "enabled": true,
  "minThreshold": 50,
  "autoReplenishAmount": 500
}
```

### Manual Stock Management

**Endpoint:**
```
POST /merchant/products/stock/manual?productId={productId}
```

**Request Body:**
```json
{
  "available": 1000,
  "reserved": 100
}
```

### Update Stock Amount

**Endpoint:**
```
PUT /merchant/products/stock?productId={productId}
```

**Request Body:**
```json
{
  "available": 500,
  "method": "manual"
}
```

## Callback URL

Set a webhook URL to receive order notifications.

**Endpoint:**
```
PATCH /merchant/products/callback-url?productId={productId}
```

**Request Body:**
```json
{
  "callbackUrl": "https://mystore.com/webhooks/orders"
}
```

## Product Types

Supported product types:

| Type | Description |
|------|------------|
| `game-vouchers` | In-game currency and vouchers |
| `direct-top-up` | Direct account top-ups |
| `gift-cards` | Gift cards and prepaid cards |
| `prepaid` | Prepaid services |
| `social-media-entertainment` | Social media credits |

## Status Values

- `active` - Product is available for purchase
- `inactive` - Product is hidden from buyers
- `out-of-stock` - Product has no available inventory
- `discontinued` - Product is no longer sold

## Common Operations

### Create and Set Stock

```javascript
// 1. Create product
const createResponse = await fetch('https://api.gameket.io/merchant/products', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'x-merchant-api-key': apiKey,
    'Idempotency-Key': uuid(),
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    name: 'FIFA 2026 Coins',
    price: 50,
    type: 'game-vouchers'
  })
});

const { data: product } = await createResponse.json();

// 2. Set initial stock
await fetch(`https://api.gameket.io/merchant/products/stock?productId=${product.productId}`, {
  method: 'PUT',
  headers: {
    'Authorization': `Bearer ${token}`,
    'x-merchant-api-key': apiKey,
    'Idempotency-Key': uuid(),
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    available: 1000,
    method: 'manual'
  })
});
```

### Enable Auto Stock Management

```javascript
await fetch(`https://api.gameket.io/merchant/products/stock/auto?productId=${productId}`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'x-merchant-api-key': apiKey,
    'Idempotency-Key': uuid(),
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    enabled: true,
    minThreshold: 100,
    autoReplenishAmount: 500
  })
});
```

### Deactivate Product

```javascript
await fetch(`https://api.gameket.io/merchant/products/status?productId=${productId}`, {
  method: 'PATCH',
  headers: {
    'Authorization': `Bearer ${token}`,
    'x-merchant-api-key': apiKey,
    'Idempotency-Key': uuid(),
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    status: 'inactive'
  })
});
```

### Python: Create and Set Stock

```python
import requests
from uuid import uuid4

def create_product_and_set_stock(token, api_key):
    # 1. Create product
    create_response = requests.post(
        'https://api.gameket.io/merchant/products',
        headers={
            'Authorization': f'Bearer {token}',
            'x-merchant-api-key': api_key,
            'Idempotency-Key': str(uuid4()),
            'Content-Type': 'application/json'
        },
        json={
            'name': 'FIFA 2026 Coins',
            'price': 50,
            'type': 'game-vouchers'
        }
    )
    
    product = create_response.json()['data']
    product_id = product['productId']
    
    # 2. Set initial stock
    requests.put(
        f'https://api.gameket.io/merchant/products/stock?productId={product_id}',
        headers={
            'Authorization': f'Bearer {token}',
            'x-merchant-api-key': api_key,
            'Idempotency-Key': str(uuid4()),
            'Content-Type': 'application/json'
        },
        json={
            'available': 1000,
            'method': 'manual'
        }
    )
    
    return product_id

def enable_auto_stock(token, api_key, product_id):
    """Enable automatic stock management"""
    response = requests.post(
        f'https://api.gameket.io/merchant/products/stock/auto?productId={product_id}',
        headers={
            'Authorization': f'Bearer {token}',
            'x-merchant-api-key': api_key,
            'Idempotency-Key': str(uuid4()),
            'Content-Type': 'application/json'
        },
        json={
            'enabled': True,
            'minThreshold': 100,
            'autoReplenishAmount': 500
        }
    )
    return response.json()

def deactivate_product(token, api_key, product_id):
    """Deactivate a product"""
    response = requests.patch(
        f'https://api.gameket.io/merchant/products/status?productId={product_id}',
        headers={
            'Authorization': f'Bearer {token}',
            'x-merchant-api-key': api_key,
            'Idempotency-Key': str(uuid4()),
            'Content-Type': 'application/json'
        },
        json={'status': 'inactive'}
    )
    return response.json()
```

### Rust: Create and Set Stock

```rust
use reqwest::Client;
use uuid::Uuid;
use serde_json::json;

pub struct ProductManager {
    client: Client,
    api_key: String,
    token: String,
}

impl ProductManager {
    pub fn new(client: Client, api_key: String, token: String) -> Self {
        Self {
            client,
            api_key,
            token,
        }
    }

    async fn create_product_and_set_stock(
        &self,
        name: &str,
        price: f64,
        product_type: &str,
    ) -> Result<String, Box<dyn std::error::Error>> {
        // 1. Create product
        let create_response = self
            .client
            .post("https://api.gameket.io/merchant/products")
            .header("Authorization", format!("Bearer {}", self.token))
            .header("x-merchant-api-key", &self.api_key)
            .header("Idempotency-Key", Uuid::new_v4().to_string())
            .json(&json!({
                "name": name,
                "price": price,
                "type": product_type
            }))
            .send()
            .await?;

        let product_data: serde_json::Value = create_response.json().await?;
        let product_id = product_data["data"]["productId"]
            .as_str()
            .unwrap()
            .to_string();

        // 2. Set initial stock
        self.client
            .put(format!(
                "https://api.gameket.io/merchant/products/stock?productId={}",
                product_id
            ))
            .header("Authorization", format!("Bearer {}", self.token))
            .header("x-merchant-api-key", &self.api_key)
            .header("Idempotency-Key", Uuid::new_v4().to_string())
            .json(&json!({
                "available": 1000,
                "method": "manual"
            }))
            .send()
            .await?;

        Ok(product_id)
    }

    async fn enable_auto_stock(
        &self,
        product_id: &str,
        min_threshold: u32,
        auto_replenish: u32,
    ) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
        let response = self
            .client
            .post(format!(
                "https://api.gameket.io/merchant/products/stock/auto?productId={}",
                product_id
            ))
            .header("Authorization", format!("Bearer {}", self.token))
            .header("x-merchant-api-key", &self.api_key)
            .header("Idempotency-Key", Uuid::new_v4().to_string())
            .json(&json!({
                "enabled": true,
                "minThreshold": min_threshold,
                "autoReplenishAmount": auto_replenish
            }))
            .send()
            .await?;

        Ok(response.json().await?)
    }

    async fn deactivate_product(
        &self,
        product_id: &str,
    ) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
        let response = self
            .client
            .patch(format!(
                "https://api.gameket.io/merchant/products/status?productId={}",
                product_id
            ))
            .header("Authorization", format!("Bearer {}", self.token))
            .header("x-merchant-api-key", &self.api_key)
            .header("Idempotency-Key", Uuid::new_v4().to_string())
            .json(&json!({ "status": "inactive" }))
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

    let manager = ProductManager::new(client, api_key, token);

    // Create product
    let product_id =
        manager
            .create_product_and_set_stock("FIFA 2026 Coins", 50.0, "game-vouchers")
            .await?;

    println!("Created product: {}", product_id);

    // Enable auto stock
    manager
        .enable_auto_stock(&product_id, 100, 500)
        .await?;

    println!("Enabled auto-stock management");

    Ok(())
}
```

## Error Responses

### 400 Bad Request
```json
{
  "success": false,
  "error": "Invalid product type",
  "code": "INVALID_TYPE",
  "requestId": "req_abc123"
}
```

### 404 Not Found
```json
{
  "success": false,
  "error": "Product not found",
  "code": "PRODUCT_NOT_FOUND",
  "requestId": "req_def456"
}
```

### 409 Conflict
```json
{
  "success": false,
  "error": "Product already exists",
  "code": "PRODUCT_EXISTS",
  "requestId": "req_ghi789"
}
```

## Next Steps

- [Orders API](orders.md) - Process orders for your products
- [Rate Limiting](rate-limiting.md) - Understand API quotas
- [Examples](examples.md) - Full code examples
