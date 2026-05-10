# Authentication

Gameket uses JWT-based Bearer token authentication for merchant API access. This guide explains how to authenticate and manage tokens.

## Token Generation

To get a Bearer token, POST your API credentials to the authentication endpoint.

**Endpoint:**
```
POST /merchant/auth/check
```

**Request:**
```json
{
  "apiKey": "your_merchant_api_key",
  "secret": "your_merchant_secret"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "tokenType": "Bearer",
    "expiresInSeconds": 7200,
    "expiresAt": "2026-05-10T17:10:31.000Z",
    "merchant": {
      "storeId": "store_abc123",
      "storeName": "My Store"
    }
  }
}
```

**Rate Limit:**
- **2 tokens per hour** per merchant
- Helps prevent token abuse and maintains security

## Using Bearer Tokens

Include the token in the `Authorization` header of all protected requests:

```bash
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

**Required headers for protected endpoints:**
```
Authorization: Bearer {token}
x-merchant-api-key: {your_api_key}
```

**For write operations, also include:**
```
Idempotency-Key: {unique-key-per-request}
```

### Example Protected Request

```bash
curl -X GET "https://api.gameket.io/merchant/orders?page=1&limit=20" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." \
  -H "x-merchant-api-key: your_merchant_api_key"
```

## Token Expiry & Refresh

Tokens are valid for **2 hours** (7200 seconds). When a token expires:

1. The API returns `401 Unauthorized`
2. Request a new token using the same endpoint
3. Use the new token for subsequent requests

**Recommended Token Refresh Strategy:**
```javascript
// Refresh token every 90 minutes (before expiry)
setInterval(async () => {
  const response = await fetch('https://api.gameket.io/merchant/auth/check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      apiKey: process.env.MERCHANT_API_KEY,
      secret: process.env.MERCHANT_SECRET
    })
  });
  
  const { data } = await response.json();
  store.token = data.token;
  store.tokenExpiresAt = new Date(data.expiresAt);
}, 90 * 60 * 1000); // 90 minutes
```

## API Key Rotation

If you suspect your API key has been compromised:

1. **Generate a new API key** in your merchant dashboard
2. **Update your application** to use the new key
3. **All old tokens become invalid immediately**

This provides instant revocation of all tokens associated with the compromised key.

## Security Best Practices

### 1. Store Credentials Securely

**❌ Don't:**
```javascript
const apiKey = "your_merchant_api_key"; // Exposed in code!
```

**✅ Do:**
```javascript
const apiKey = process.env.MERCHANT_API_KEY; // From .env file
```

### 2. Never Log Tokens

**❌ Don't:**
```javascript
console.log("Token:", token); // Exposed in logs!
```

**✅ Do:**
```javascript
console.log("Token created at:", new Date()); // Only log metadata
```

### 3. Use HTTPS Only

All API requests must be made over HTTPS. HTTP requests will be rejected.

### 4. Rotate Keys Periodically

Even if not compromised, rotate your API keys every 90 days.

### 5. Use Short-Lived Tokens

Tokens expire in 2 hours by design. Request new tokens frequently rather than storing old ones.

### 6. Implement Token Caching

Avoid requesting new tokens on every request:

```javascript
class TokenManager {
  constructor() {
    this.token = null;
    this.expiresAt = null;
  }
  
  async getToken() {
    // Use cached token if still valid
    if (this.token && Date.now() < this.expiresAt - 60000) {
      return this.token;
    }
    
    // Request new token
    const response = await this.requestToken();
    this.token = response.token;
    this.expiresAt = new Date(response.expiresAt).getTime();
    
    return this.token;
  }
  
  async requestToken() {
    const response = await fetch('https://api.gameket.io/merchant/auth/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiKey: process.env.MERCHANT_API_KEY,
        secret: process.env.MERCHANT_SECRET
      })
    });
    
    if (!response.ok) throw new Error('Token request failed');
    const { data } = await response.json();
    return data;
  }
}
```

## Troubleshooting

### "Invalid merchant credentials"
- Verify your `apiKey` and `secret` are correct
- Check they haven't been rotated recently
- Confirm your account is active

### "Too many token requests" (429)
- You've exceeded 2 tokens per hour
- Implement token caching to reuse existing tokens
- Wait before requesting another token

### "Unauthorized" (401)
- Token has expired → request a new one
- Token was revoked (API key rotated) → get new credentials
- Bearer token in header is malformed or missing

### "Invalid token"
- Token signature is invalid (tampered with)
- Token is from a different merchant account
- Server was restarted (invalidates in-memory tokens)

## Token Caching Patterns

### Token Caching (JavaScript)

```javascript
class TokenManager {
  constructor() {
    this.token = null;
    this.expiresAt = null;
  }
  
  async getToken() {
    // Use cached token if still valid
    if (this.token && Date.now() < this.expiresAt - 60000) {
      return this.token;
    }
    
    // Request new token
    const response = await this.requestToken();
    this.token = response.token;
    this.expiresAt = new Date(response.expiresAt).getTime();
    
    return this.token;
  }
  
  async requestToken() {
    const response = await fetch('https://api.gameket.io/merchant/auth/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiKey: process.env.MERCHANT_API_KEY,
        secret: process.env.MERCHANT_SECRET
      })
    });
    
    if (!response.ok) throw new Error('Token request failed');
    const { data } = await response.json();
    return data;
  }
}
```

### Token Caching (Python)

```python
from datetime import datetime, timedelta
import requests

class TokenManager:
    def __init__(self, api_key, secret):
        self.api_key = api_key
        self.secret = secret
        self.token = None
        self.expires_at = None
    
    def get_token(self):
        """Get cached token or request a new one"""
        if self.token and datetime.now() < self.expires_at - timedelta(seconds=60):
            return self.token
        
        response = requests.post('https://api.gameket.io/merchant/auth/check', json={
            'apiKey': self.api_key,
            'secret': self.secret
        })
        
        data = response.json()['data']
        self.token = data['token']
        self.expires_at = datetime.fromisoformat(data['expiresAt'].replace('Z', '+00:00'))
        
        return self.token
```

### Token Caching (Rust)

```rust
use tokio::sync::Mutex;
use std::sync::Arc;
use chrono::{DateTime, Utc, Duration};
use serde_json::json;

pub struct TokenCache {
    token: Arc<Mutex<Option<String>>>,
    expires_at: Arc<Mutex<Option<DateTime<Utc>>>>,
    client: reqwest::Client,
    api_key: String,
    secret: String,
}

impl TokenCache {
    pub fn new(api_key: String, secret: String) -> Self {
        Self {
            token: Arc::new(Mutex::new(None)),
            expires_at: Arc::new(Mutex::new(None)),
            client: reqwest::Client::new(),
            api_key,
            secret,
        }
    }
    
    pub async fn get_token(&self) -> Result<String, Box<dyn std::error::Error>> {
        let mut token_guard = self.token.lock().await;
        let mut expires_guard = self.expires_at.lock().await;
        
        let now = Utc::now();
        let threshold = now + Duration::seconds(60);
        
        // Return cached token if still valid
        if let (Some(t), Some(e)) = (token_guard.as_ref(), expires_guard.as_ref()) {
            if *e > threshold {
                return Ok(t.clone());
            }
        }
        
        // Request new token
        let response = self.client
            .post("https://api.gameket.io/merchant/auth/check")
            .json(&json!({
                "apiKey": self.api_key,
                "secret": self.secret
            }))
            .send()
            .await?;

        let data: serde_json::Value = response.json().await?;
        let new_token = data["data"]["token"].as_str().unwrap().to_string();
        let expires_str = data["data"]["expiresAt"].as_str().unwrap();
        let new_expires = DateTime::parse_from_rfc3339(expires_str)?
            .with_timezone(&Utc);

        *token_guard = Some(new_token.clone());
        *expires_guard = Some(new_expires);

        Ok(new_token)
    }
}
```

## Environment Variables

Store these securely in your `.env` file:

```bash
MERCHANT_API_KEY=your_merchant_api_key_here
MERCHANT_SECRET=your_merchant_secret_here
MERCHANT_API_BASE_URL=https://api.gameket.io
```

**Never commit `.env` to version control!** Add it to `.gitignore`.

## API Credentials Dashboard

Your API credentials are available in:
1. Log in to merchant.gameket.io
2. Go to **Settings → API & Integration**
3. View or regenerate your `apiKey` and `secret`

## Next Steps

- [Core Concepts](core-concepts.md) - Learn about request headers and idempotency
- [Products API](products.md) - Manage your product catalog
- [Orders API](orders.md) - Handle merchant orders
- [Rate Limiting](rate-limiting.md) - Understand usage limits
