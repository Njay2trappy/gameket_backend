# Merchant Profile

Access and manage your merchant account information through these endpoints.

## Get Profile

Retrieve your merchant account information.

**Endpoint:**
```
GET /merchant
```

**Headers:**
```
Authorization: Bearer {token}
x-merchant-api-key: {your_merchant_api_key}
```

**Request:**
```bash
curl -X GET https://api.gameket.io/merchant \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." \
  -H "x-merchant-api-key: mapi_abc123def456"
```

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "storeId": "store_abc123",
    "storeName": "My Gaming Store",
    "status": "active",
    "merchantId": "merchant_xyz789",
    "email": "contact@mystore.com",
    "phone": "+1234567890",
    "country": "US",
    "verified": true,
    "totalSales": 15000,
    "totalOrders": 320,
    "rank": 5,
    "rating": 4.8,
    "totalReviews": 145,
    "accountCreatedAt": "2026-01-15T10:00:00Z",
    "lastActivityAt": "2026-05-10T15:30:00Z"
  }
}
```

## Get Current Store

Retrieve the store associated with the current API key.

**Endpoint:**
```
GET /merchant/me
```

**Headers:**
```
Authorization: Bearer {token}
x-merchant-api-key: {your_merchant_api_key}
```

**Request:**
```bash
curl -X GET https://api.gameket.io/merchant/me \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." \
  -H "x-merchant-api-key: mapi_abc123def456"
```

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "storeId": "store_abc123",
    "storeName": "My Gaming Store",
    "storeType": "merchant",
    "status": "active",
    "description": "Premium gaming products and services",
    "logoUrl": "https://cdn.gameket.io/logos/store_abc123.png",
    "website": "https://mystore.com",
    "supportEmail": "support@mystore.com",
    "supportPhone": "+1234567890",
    "apiKey": "mapi_abc123def456",
    "webhookUrl": "https://mystore.com/webhooks/gameket",
    "createdAt": "2026-01-15T10:00:00Z",
    "updatedAt": "2026-05-10T15:30:00Z"
  }
}
```

## Profile Information

### Store Status Values

| Status | Description |
|--------|-------------|
| `active` | Account is active and operational |
| `suspended` | Account is temporarily suspended |
| `banned` | Account is permanently disabled |
| `pending_verification` | Awaiting verification |
| `inactive` | Account is inactive |

### Rank System

Your rank is determined by total sales:

| Rank | Sales Range | Benefits |
|------|------------|----------|
| 1 | $0 - $99 | Basic seller |
| 2 | $100 - $499 | Discounted fees |
| 3 | $500 - $999 | Priority support |
| 4 | $1,000 - $2,499 | Featured listing |
| 5 | $2,500 - $3,499 | Dedicated account manager |
| 6 | $3,500 - $5,000 | Custom integration support |
| 7 | $5,000 - $7,500 | API rate limit increase |
| 8 | $7,500 - $9,999 | Premium support (24/7) |
| 9 | $10,000 - 99,999 | White-label options |
| 10 | $100,000+ | Enterprise partnership |

### Rating Calculation

Your rating is calculated from buyer reviews (0.0 - 5.0 stars):
- Positive orders increase rating
- Issues/refunds may decrease rating
- Ratings update weekly

## Common Use Cases

### Check Account Status

```javascript
async function checkAccountStatus() {
  const response = await fetch('https://api.gameket.io/merchant', {
    headers: {
      'Authorization': `Bearer ${token}`,
      'x-merchant-api-key': apiKey
    }
  });
  
  const { data } = await response.json();
  
  if (data.status !== 'active') {
    console.warn(`Account status: ${data.status}`);
  }
  
  return data;
}
```

### Verify Store Information

```javascript
async function verifyStoreInfo() {
  const profile = await fetch('https://api.gameket.io/merchant').then(r => r.json());
  
  return {
    verified: profile.data.verified,
    rating: profile.data.rating,
    rank: profile.data.rank,
    totalOrders: profile.data.totalOrders
  };
}
```

### Monitor Account Activity

```javascript
async function getLastActivity() {
  const response = await fetch('https://api.gameket.io/merchant', {
    headers: {
      'Authorization': `Bearer ${token}`,
      'x-merchant-api-key': apiKey
    }
  });
  
  const { data } = await response.json();
  const lastActivity = new Date(data.lastActivityAt);
  const daysSinceActivity = Math.floor((Date.now() - lastActivity) / (1000 * 60 * 60 * 24));
  
  console.log(`Last activity: ${daysSinceActivity} days ago`);
  return daysSinceActivity;
}
```

## Error Responses

### 401 Unauthorized
```json
{
  "success": false,
  "error": "Invalid or expired token",
  "code": "UNAUTHORIZED",
  "requestId": "req_abc123"
}
```
**Action:** Request a new token via `/merchant/auth/check`

### 403 Forbidden
```json
{
  "success": false,
  "error": "Account suspended",
  "code": "ACCOUNT_SUSPENDED",
  "requestId": "req_def456"
}
```
**Action:** Contact support to resolve account status

### 404 Not Found
```json
{
  "success": false,
  "error": "Store not found",
  "code": "STORE_NOT_FOUND",
  "requestId": "req_ghi789"
}
```
**Action:** Verify your API key is correct

## Next Steps

- [Products API](products.md) - Create and manage products
- [Orders API](orders.md) - Handle orders and fulfillment
- [Authentication](authentication.md) - Manage tokens and credentials
