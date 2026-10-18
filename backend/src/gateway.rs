//! Agents through farmhand, the rec.farm MCP gateway. Off unless `GATEWAY_ISSUER` is set.
//!
//! For each tool call farmhand signs a one-minute assertion (farmhand's docs/ASSERTIONS.md): the
//! person as the single sign-on provider knows them, the agent acting for them, and the scopes
//! they allowed. StillUp finds that person's existing user by issuer and subject and caps their
//! role by the scopes. An assertion never creates a user or acts as the installation.
use crate::{
    error::ApiError,
    server::AppState,
    users::{CredentialRole, Principal, subject_key},
};
use axum::http::StatusCode;
use jsonwebtoken::{
    Algorithm, DecodingKey, Validation, decode, decode_header,
    jwk::{Jwk, JwkSet},
};
use serde::Deserialize;
use std::{
    env,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;
use uuid::Uuid;

const TYPE: &str = "farmhand-assertion+jwt";
const KEYS_MAX_AGE: Duration = Duration::from_secs(3600);
/// An unknown key ID refreshes the key set at most this often, so made-up IDs cannot make
/// StillUp hammer farmhand.
const KEYS_MIN_REFRESH: Duration = Duration::from_secs(60);

/// farmhand's public origin, when agents may act through it.
pub fn issuer_from_env() -> Result<Option<String>, String> {
    let Some(issuer) = env::var("GATEWAY_ISSUER")
        .ok()
        .map(|value| value.trim().trim_end_matches('/').to_owned())
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    let url = url::Url::parse(&issuer).map_err(|_| "GATEWAY_ISSUER must be a valid URL")?;
    if !crate::oidc::allowed_endpoint(&url, url.scheme() == "http") {
        return Err("GATEWAY_ISSUER must use HTTPS, except for loopback development".into());
    }
    Ok(Some(issuer))
}

/// farmhand's signing keys, from `<issuer>/.well-known/jwks.json`, cached.
#[derive(Clone)]
pub struct Keys {
    client: reqwest::Client,
    cache: Arc<Mutex<Option<(Instant, JwkSet)>>>,
}
impl Default for Keys {
    fn default() -> Self {
        Self {
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(10))
                .build()
                .expect("TLS client"),
            cache: Arc::new(Mutex::new(None)),
        }
    }
}
impl Keys {
    async fn fetch(&self, issuer: &str) -> Option<JwkSet> {
        self.client
            .get(format!("{issuer}/.well-known/jwks.json"))
            .send()
            .await
            .ok()?
            .error_for_status()
            .ok()?
            .json()
            .await
            .ok()
    }
    async fn find(&self, issuer: &str, kid: &str) -> Result<Jwk, ApiError> {
        let mut cache = self.cache.lock().await;
        if let Some((fetched, keys)) = cache.as_ref() {
            if fetched.elapsed() < KEYS_MAX_AGE
                && let Some(key) = keys.find(kid)
            {
                return Ok(key.clone());
            }
            if fetched.elapsed() < KEYS_MIN_REFRESH {
                return Err(invalid());
            }
        }
        let keys = self.fetch(issuer).await.ok_or_else(|| {
            tracing::warn!("farmhand's signing keys could not be fetched");
            ApiError(
                StatusCode::SERVICE_UNAVAILABLE,
                "Agent access is temporarily unavailable".into(),
            )
        })?;
        let key = keys.find(kid).cloned();
        *cache = Some((Instant::now(), keys));
        key.ok_or_else(invalid)
    }
}

fn invalid() -> ApiError {
    ApiError(StatusCode::UNAUTHORIZED, "Invalid agent assertion".into())
}

#[derive(Deserialize)]
struct Claims {
    user: Person,
    scope: String,
    act: Actor,
}
#[derive(Deserialize)]
struct Person {
    iss: String,
    sub: String,
}
#[derive(Deserialize)]
struct Actor {
    name: String,
}

/// Whether a bearer token is meant for `principal`: a JWT, when the gateway is on. The
/// installation token and API keys are told apart before this.
pub fn recognises(state: &AppState, token: &str) -> bool {
    state.config.gateway_issuer.is_some() && token.split('.').count() == 3
}

/// The person a verified assertion acts for, capped by its scopes.
pub async fn principal(state: &AppState, token: &str) -> Result<Principal, ApiError> {
    let config = &state.config;
    let Some(issuer) = config.gateway_issuer.as_deref() else {
        return Err(invalid());
    };
    if config.oidc.issuer.is_empty() {
        return Err(invalid());
    }
    let header = decode_header(token).map_err(|_| invalid())?;
    if header.alg != Algorithm::EdDSA || header.typ.as_deref() != Some(TYPE) {
        return Err(invalid());
    }
    let kid = header.kid.ok_or_else(invalid)?;
    let key = state.gateway_keys.find(issuer, &kid).await?;
    let key = DecodingKey::from_jwk(&key).map_err(|_| invalid())?;
    let mut validation = Validation::new(Algorithm::EdDSA);
    validation.set_issuer(&[issuer]);
    validation.set_audience(&[&config.origin]);
    validation.set_required_spec_claims(&["iss", "aud", "exp"]);
    validation.leeway = 5;
    let claims = decode::<Claims>(token, &key, &validation)
        .map_err(|_| invalid())?
        .claims;
    let (subject, cap, agent) = scoped(claims, &config.oidc.issuer)?;
    let (user_id, role) =
        sqlx::query_as::<_, (Uuid, String)>("SELECT id,role FROM users WHERE oidc_subject=$1")
            .bind(subject_key(&config.oidc.issuer, &subject))
            .fetch_optional(&state.pool)
            .await?
            .ok_or_else(|| {
                ApiError(
                    StatusCode::FORBIDDEN,
                    "This person is not a StillUp user, or has not signed in yet".into(),
                )
            })?;
    Ok(Principal::Delegated {
        user_id,
        admin: role == "admin",
        cap,
        agent,
    })
}

/// The subject, the widest role the scopes allow, and the agent's name.
fn scoped(
    claims: Claims,
    sign_in_issuer: &str,
) -> Result<(String, CredentialRole, String), ApiError> {
    if claims.user.iss.trim_end_matches('/') != sign_in_issuer.trim_end_matches('/') {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "This agent acts for someone from another sign-in provider".into(),
        ));
    }
    let scopes: Vec<&str> = claims.scope.split_whitespace().collect();
    let cap = if scopes.contains(&"stillup:admin") {
        CredentialRole::Admin
    } else if scopes.contains(&"stillup:deploy") {
        CredentialRole::Deployer
    } else if scopes.contains(&"stillup:read") {
        CredentialRole::Viewer
    } else {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "This agent has no access to StillUp".into(),
        ));
    };
    let agent = claims.act.name.trim();
    if agent.is_empty() || agent.chars().count() > 100 || agent.chars().any(char::is_control) {
        return Err(invalid());
    }
    Ok((claims.user.sub, cap, agent.to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn claims(iss: &str, scope: &str, agent: &str) -> Claims {
        Claims {
            user: Person {
                iss: iss.into(),
                sub: "person-1".into(),
            },
            scope: scope.into(),
            act: Actor { name: agent.into() },
        }
    }
    #[test]
    fn scopes_cap_the_role_and_people_come_from_the_sign_in_provider() {
        let issuer = "https://id.example";
        let cap = |scope| scoped(claims(issuer, scope, "Claude Code"), issuer).map(|s| s.1);
        assert_eq!(cap("stillup:read").unwrap(), CredentialRole::Viewer);
        assert_eq!(
            cap("stillup:read stillup:deploy").unwrap(),
            CredentialRole::Deployer
        );
        assert_eq!(
            cap("stillup:admin stillup:deploy stillup:read").unwrap(),
            CredentialRole::Admin
        );
        assert_eq!(cap("valtr:write").unwrap_err().0, StatusCode::FORBIDDEN);
        let other = scoped(claims("https://evil.example", "stillup:read", "A"), issuer);
        assert_eq!(other.unwrap_err().0, StatusCode::FORBIDDEN);
        for name in ["", " ", "a\u{7}", &"x".repeat(101)] {
            let bad = scoped(claims(issuer, "stillup:read", name), issuer);
            assert_eq!(bad.unwrap_err().0, StatusCode::UNAUTHORIZED);
        }
    }
}
