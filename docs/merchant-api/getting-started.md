# Getting Started

This guide will help you set up your Gameket Merchant API integration in minutes.

## Prerequisites

- Gameket merchant account with API credentials
- `apiKey` and `secret` from your dashboard
- Basic understanding of REST APIs
- A tool for making HTTP requests (cURL, Postman, Thunder Client, etc.)

## Step 1: Get Your Credentials

1. Log in to your Gameket merchant dashboard
2. Navigate to **Settings > API Keys**
3. Copy your `apiKey` and `secret` (keep these secure!)
4. Store them in a secure environment variable or configuration

> ⚠️ **Never commit credentials to version control.** Use `.env` files or secrets managers.

## Step 2: Request an Access Token

Make a POST request to get a Bearer token:

```bash
curl -X POST https://api.gameket.io/merchant/auth/check \
  -H "Content-Type: application/json" \
  -d '{
    "apiKey": "your_merchant_api_key",
    "secret": "your_merchant_secret"
  }'
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

**Save the token** - You'll use it for all subsequent requests.

## Step 3: Make Your First Request

Fetch your merchant profile:

```bash
curl -X GET https://api.gameket.io/merchant \
  -H "Authorization: Bearer YOUR_TOKEN_HERE" \
  -H "x-merchant-api-key: your_merchant_api_key"
```

**Response:**
```json
{
  "success": true,
  "data": {
    "storeId": "store_abc123",
    "storeName": "My Store",
    "status": "active",
    "createdAt": "2026-01-15T10:00:00Z",
    "totalSales": 5000,
    "rank": 5
  }
}
```

## Step 4: Explore the API

Now you can:
- **[Manage Products](products.md)** - Create and update your product catalog
- **[Handle Orders](orders.md)** - Process orders, refunds, and cancellations
- **[View Rate Limits](rate-limiting.md)** - Understand usage quotas

## Common Integration Patterns

### Pattern 1: Periodic Token Refresh

Request a new token every 90 minutes (token lasts 2 hours):

```javascript
async function getValidToken() {
  const cachedToken = localStorage.get('merchant_token');
  const expiresAt = localStorage.get('token_expires_at');
  
  if (cachedToken && Date.now() < expiresAt) {
    return cachedToken; // Use cached token
  }
  
  // Request new token
  const response = await fetch('https://api.gameket.io/merchant/auth/check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      apiKey: process.env.MERCHANT_API_KEY,
      secret: process.env.MERCHANT_SECRET
    })
  });
  
  const { data } = await response.json();
  localStorage.set('merchant_token', data.token);
  localStorage.set('token_expires_at', new Date(data.expiresAt).getTime());
  
  return data.token;
}
```

### Pattern 2: Error Handling

Always handle 401 (Unauthorized) by requesting a new token:

```javascript
async function apiRequest(method, endpoint, body = null) {
  let token = await getValidToken();
  
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'x-merchant-api-key': process.env.MERCHANT_API_KEY
    }
  };
  
  if (body) {
    options.body = JSON.stringify(body);
  }
  
  let response = await fetch(`https://api.gameket.io${endpoint}`, options);
  
  // If unauthorized, refresh token and retry
  if (response.status === 401) {
    token = await getValidToken(); // Force refresh
    options.headers.Authorization = `Bearer ${token}`;
    response = await fetch(`https://api.gameket.io${endpoint}`, options);
  }
  
  return response.json();
}
```

## Python Integration

### Token Refresh Pattern

```python
import requests
from datetime import datetime, timedelta
import os

class MerchantAPIClient:
    def __init__(self):
        self.token = None
        self.expires_at = None
        self.api_key = os.getenv('MERCHANT_API_KEY')
        self.secret = os.getenv('MERCHANT_SECRET')

    def get_valid_token(self):
        """Get valid token, refreshing if needed"""
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

    def api_request(self, method, endpoint, body=None):
        """Make authenticated API request"""
        token = self.get_valid_token()
        
        headers = {
            'Content-Type': 'application/json',
            'Authorization': f'Bearer {token}',
            'x-merchant-api-key': self.api_key
        }
        
        response = requests.request(
            method,
            f'https://api.gameket.io{endpoint}',
            json=body,
            headers=headers
        )
        
        if response.status_code == 401:
            # Force token refresh and retry
            token = self.get_valid_token()
            headers['Authorization'] = f'Bearer {token}'
            response = requests.request(
                method,
                f'https://api.gameket.io{endpoint}',
                json=body,
                headers=headers
            )
        
        return response.json()
```

## Rust Integration

### Token Refresh Pattern

```rust
use reqwest::Client;
use serde_json::json;
use tokio::sync::Mutex;
use std::sync::Arc;

pub struct MerchantAPI {
    client: Client,
    api_key: String,
    secret: String,
    token: Arc<Mutex<Option<String>>>,
    expires_at: Arc<Mutex<Option<i64>>>,
}

impl MerchantAPI {
    pub fn new(api_key: String, secret: String) -> Self {
        Self {
            client: Client::new(),
            api_key,
            secret,
            token: Arc::new(Mutex::new(None)),
            expires_at: Arc::new(Mutex::new(None)),
        }
    }

    pub async fn get_valid_token(&self) -> Result<String, Box<dyn std::error::Error>> {
        let mut token_guard = self.token.lock().await;
        let mut expires_guard = self.expires_at.lock().await;
        
        let now = chrono::Utc::now().timestamp();
        
        if let (Some(token), Some(expires)) = (token_guard.as_ref(), expires_guard.as_ref()) {
            if now < expires - 60 {
                return Ok(token.clone());
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
        let token = data["data"]["token"].as_str().unwrap().to_string();
        let expires_str = data["data"]["expiresAt"].as_str().unwrap();
        let expires = chrono::DateTime::parse_from_rfc3339(expires_str)?
            .with_timezone(&chrono::Utc)
            .timestamp();

        *token_guard = Some(token.clone());
        *expires_guard = Some(expires);

        Ok(token)
    }

    pub async fn api_request(
        &self,
        method: &str,
        endpoint: &str,
        body: Option<serde_json::Value>,
    ) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
        let token = self.get_valid_token().await?;
        
        let mut req = match method {
            "GET" => self.client.get(format!("https://api.gameket.io{}", endpoint)),
            "POST" => self.client.post(format!("https://api.gameket.io{}", endpoint)),
            "PATCH" => self.client.patch(format!("https://api.gameket.io{}", endpoint)),
            _ => return Err("Unsupported method".into()),
        };

        req = req
            .header("Authorization", format!("Bearer {}", token))
            .header("x-merchant-api-key", &self.api_key);

        if let Some(b) = body {
            req = req.json(&b);
        }

        let response = req.send().await?;
        Ok(response.json().await?)
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let api = MerchantAPI::new(
        std::env::var("MERCHANT_API_KEY")?,
        std::env::var("MERCHANT_SECRET")?,
    );

    // Get profile
    let profile = api.api_request("GET", "/merchant", None).await?;
    println!("Welcome {:?}", profile);

    Ok(())
}
```

## Pattern 2: Error Handling

Always handle 401 (Unauthorized) by requesting a new token:

```javascript
async function apiRequest(method, endpoint, body = null) {
  let token = await getValidToken();
  
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'x-merchant-api-key': process.env.MERCHANT_API_KEY
    }
  };
  
  if (body) {
    options.body = JSON.stringify(body);
  }
  
  let response = await fetch(`https://api.gameket.io${endpoint}`, options);
  
  // If unauthorized, refresh token and retry
  if (response.status === 401) {
    token = await getValidToken(); // Force refresh
    options.headers.Authorization = `Bearer ${token}`;
    response = await fetch(`https://api.gameket.io${endpoint}`, options);
  }
  
  return response.json();
}
```

### Pattern 2: Error Handling

## Next Steps

- Set up [authentication properly](authentication.md)
- Read about [idempotency](core-concepts.md#idempotency) for safe operations
- Review [rate limiting](rate-limiting.md) before going to production
- Check out [examples](examples.md) in your preferred language

## Need Help?

- 📖 See full [API Reference](README.md)
- 🐛 [Report Issues](https://github.com/gameket/api-issues)
- 💬 Join our [Developer Community](https://community.gameket.io)
