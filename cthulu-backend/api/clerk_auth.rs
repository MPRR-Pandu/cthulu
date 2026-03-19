//! Clerk JWT verification and AuthUser extractor.
//!
//! When `CLERK_DOMAIN` is set, verifies Clerk JWTs via JWKS.
//! When unset (local dev), returns a hardcoded dev user — fully backward compatible.

use axum::extract::FromRequestParts;
use hyper::StatusCode;
use axum::Json;
use hyper::header::AUTHORIZATION;
use hyper::http::request::Parts;
use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::RwLock;

use crate::api::AppState;

// ── JWKS Cache ───────────────────────────────────────────────

/// Cached JWKS keys fetched from Clerk's well-known endpoint.
pub struct JwksCache {
    /// kid -> DecodingKey
    pub keys: HashMap<String, DecodingKey>,
    pub fetched_at: Instant,
}

const JWKS_TTL_SECS: u64 = 3600; // 1 hour

/// Fetch JWKS from Clerk and build a cache of kid -> DecodingKey.
pub async fn fetch_jwks(
    http_client: &reqwest::Client,
    clerk_domain: &str,
) -> Result<JwksCache, String> {
    let url = format!("https://{}/.well-known/jwks.json", clerk_domain);
    let resp = http_client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("JWKS fetch failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("JWKS endpoint returned {}", resp.status()));
    }

    let body: Value = resp
        .json()
        .await
        .map_err(|e| format!("JWKS parse failed: {e}"))?;

    let mut keys = HashMap::new();
    if let Some(jwks_keys) = body.get("keys").and_then(|k| k.as_array()) {
        for key in jwks_keys {
            let kid = key.get("kid").and_then(|k| k.as_str()).unwrap_or_default();
            let n = key.get("n").and_then(|v| v.as_str()).unwrap_or_default();
            let e = key.get("e").and_then(|v| v.as_str()).unwrap_or_default();

            if !kid.is_empty() && !n.is_empty() && !e.is_empty() {
                if let Ok(dk) = DecodingKey::from_rsa_components(n, e) {
                    keys.insert(kid.to_string(), dk);
                }
            }
        }
    }

    if keys.is_empty() {
        return Err("No valid RSA keys found in JWKS".to_string());
    }

    Ok(JwksCache {
        keys,
        fetched_at: Instant::now(),
    })
}

// ── AuthUser Extractor ───────────────────────────────────────

/// Clerk JWT claims we care about.
#[derive(Debug, Deserialize)]
struct ClerkClaims {
    sub: String,
}

/// Authenticated user extracted from Clerk JWT.
/// When auth is disabled (dev mode), user_id is "dev_user".
#[derive(Debug, Clone, Serialize)]
pub struct AuthUser {
    pub user_id: String,
}

impl AuthUser {
    pub fn dev_user() -> Self {
        Self {
            user_id: "dev_user".to_string(),
        }
    }
}

impl FromRequestParts<AppState> for AuthUser {
    type Rejection = (StatusCode, Json<Value>);

    fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> impl std::future::Future<Output = Result<Self, Self::Rejection>> + Send {
        let clerk_domain = state.clerk_domain.clone();
        let jwks_cache = state.jwks_cache.clone();
        let http_client = state.http_client.clone();

        // Extract token from header or query param before the async block
        let token = extract_token(parts);

        async move {
            // Dev mode: no Clerk domain configured → bypass auth
            let clerk_domain = match clerk_domain {
                Some(d) => d,
                None => return Ok(AuthUser::dev_user()),
            };

            let token = token.ok_or_else(|| {
                (
                    StatusCode::UNAUTHORIZED,
                    Json(json!({ "error": "Missing authentication token" })),
                )
            })?;

            // Decode JWT header to get kid
            let header = decode_header(&token).map_err(|e| {
                (
                    StatusCode::UNAUTHORIZED,
                    Json(json!({ "error": format!("Invalid token header: {e}") })),
                )
            })?;

            let kid = header.kid.ok_or_else(|| {
                (
                    StatusCode::UNAUTHORIZED,
                    Json(json!({ "error": "Token missing kid" })),
                )
            })?;

            // Get decoding key from cache (or fetch)
            let decoding_key = get_decoding_key(
                &jwks_cache,
                &http_client,
                &clerk_domain,
                &kid,
            )
            .await
            .map_err(|e| {
                (
                    StatusCode::UNAUTHORIZED,
                    Json(json!({ "error": e })),
                )
            })?;

            // Verify the JWT
            let mut validation = Validation::new(Algorithm::RS256);
            validation.set_issuer(&[format!("https://{clerk_domain}")]);
            validation.validate_aud = false; // Clerk doesn't always set aud

            let token_data = decode::<ClerkClaims>(&token, &decoding_key, &validation)
                .map_err(|e| {
                    (
                        StatusCode::UNAUTHORIZED,
                        Json(json!({ "error": format!("Token verification failed: {e}") })),
                    )
                })?;

            let user_id = token_data.claims.sub;

            // Validate user_id is safe for filesystem paths
            if !user_id.chars().all(|c| c.is_alphanumeric() || c == '_') {
                return Err((
                    StatusCode::UNAUTHORIZED,
                    Json(json!({ "error": "Invalid user ID format" })),
                ));
            }

            Ok(AuthUser { user_id })
        }
    }
}

/// Extract Bearer token from Authorization header or ?token query param.
fn extract_token(parts: &Parts) -> Option<String> {
    // Try Authorization header first
    if let Some(auth_header) = parts.headers.get(AUTHORIZATION) {
        if let Ok(value) = auth_header.to_str() {
            if let Some(token) = value.strip_prefix("Bearer ") {
                return Some(token.to_string());
            }
        }
    }

    // Fall back to ?token= query param (for SSE EventSource)
    if let Some(query) = parts.uri.query() {
        for pair in query.split('&') {
            if let Some(token) = pair.strip_prefix("token=") {
                return Some(urlencoding_decode(token));
            }
        }
    }

    None
}

/// Simple percent-decoding for the token query param.
fn urlencoding_decode(s: &str) -> String {
    // Tokens are base64url, which doesn't need decoding in practice,
    // but handle %XX just in case.
    let mut result = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '%' {
            let hex: String = chars.by_ref().take(2).collect();
            if let Ok(byte) = u8::from_str_radix(&hex, 16) {
                result.push(byte as char);
            }
        } else if c == '+' {
            result.push(' ');
        } else {
            result.push(c);
        }
    }
    result
}

/// Get a DecodingKey for the given kid, fetching/refreshing JWKS as needed.
async fn get_decoding_key(
    cache: &Arc<RwLock<Option<JwksCache>>>,
    http_client: &reqwest::Client,
    clerk_domain: &str,
    kid: &str,
) -> Result<DecodingKey, String> {
    // Try cache first
    {
        let guard = cache.read().await;
        if let Some(ref jwks) = *guard {
            if jwks.fetched_at.elapsed().as_secs() < JWKS_TTL_SECS {
                if let Some(key) = jwks.keys.get(kid) {
                    return Ok(key.clone());
                }
            }
        }
    }

    // Cache miss or expired — fetch fresh JWKS
    let fresh = fetch_jwks(http_client, clerk_domain).await?;
    let key = fresh.keys.get(kid).cloned();
    {
        let mut guard = cache.write().await;
        *guard = Some(fresh);
    }

    key.ok_or_else(|| format!("Key ID '{kid}' not found in JWKS"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dev_user_has_expected_id() {
        let user = AuthUser::dev_user();
        assert_eq!(user.user_id, "dev_user");
    }

    #[test]
    fn extract_bearer_token() {
        let parts = hyper::Request::builder()
            .header("Authorization", "Bearer test_token_123")
            .body(())
            .unwrap()
            .into_parts()
            .0;
        let token = extract_token(&parts);
        assert_eq!(token, Some("test_token_123".to_string()));
    }

    #[test]
    fn extract_query_token() {
        let parts = hyper::Request::builder()
            .uri("https://example.com/api/test?token=abc123&other=val")
            .body(())
            .unwrap()
            .into_parts()
            .0;
        let token = extract_token(&parts);
        assert_eq!(token, Some("abc123".to_string()));
    }

    #[test]
    fn extract_no_token() {
        let parts = hyper::Request::builder()
            .uri("https://example.com/api/test")
            .body(())
            .unwrap()
            .into_parts()
            .0;
        let token = extract_token(&parts);
        assert!(token.is_none());
    }

    #[test]
    fn urlencoding_decode_passthrough() {
        assert_eq!(urlencoding_decode("hello_world"), "hello_world");
    }

    #[test]
    fn urlencoding_decode_percent() {
        assert_eq!(urlencoding_decode("hello%20world"), "hello world");
    }
}
