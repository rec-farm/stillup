use crate::{
    auth,
    server::{AppState, cookie},
    users,
};
use axum::{
    Json,
    extract::{Request, State},
    http::header,
    response::{IntoResponse, Redirect, Response},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, KeyInit, Mac};
use openidconnect::{
    AccessTokenHash, AuthorizationCode, ClientId, ClientSecret, CsrfToken, Nonce,
    OAuth2TokenResponse, PkceCodeChallenge, PkceCodeVerifier, RedirectUrl, Scope, TokenResponse,
    core::{CoreAuthenticationFlow, CoreClient, CoreProviderMetadata},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::Sha256;
use std::{collections::HashMap, env, sync::Arc, time::Duration};
use tokio::sync::Mutex;

#[derive(Clone)]
pub struct OidcConfig {
    pub issuer: String,
    pub client_id: String,
    pub client_secret: String,
    pub scopes: String,
    pub display_name: String,
}
impl Default for OidcConfig {
    fn default() -> Self {
        Self {
            issuer: String::new(),
            client_id: String::new(),
            client_secret: String::new(),
            scopes: "openid profile email groups".into(),
            display_name: "Handstamp".into(),
        }
    }
}
impl OidcConfig {
    pub fn from_env() -> Result<Self, String> {
        let defaults = Self::default();
        let value = |key: &str, default: &str| {
            env::var(key)
                .ok()
                .filter(|v| !v.trim().is_empty())
                .unwrap_or_else(|| default.into())
        };
        let result = Self {
            issuer: value("OIDC_ISSUER", "").trim_end_matches('/').into(),
            client_id: value("OIDC_CLIENT_ID", ""),
            client_secret: value("OIDC_CLIENT_SECRET", ""),
            scopes: value("OIDC_SCOPES", &defaults.scopes),
            display_name: value("OIDC_DISPLAY_NAME", &defaults.display_name)
                .trim()
                .into(),
        };
        if !result.issuer.is_empty() {
            let url =
                url::Url::parse(&result.issuer).map_err(|_| "OIDC_ISSUER must be a valid URL")?;
            if !allowed_endpoint(&url, is_loopback(&url) && url.scheme() == "http") {
                return Err("OIDC_ISSUER must use HTTPS, except for loopback development".into());
            }
        }
        Ok(result)
    }
    pub fn enabled(&self) -> bool {
        !self.issuer.is_empty() && !self.client_id.is_empty()
    }
}
#[derive(Clone)]
pub struct Runtime {
    client: reqwest::Client,
    metadata: Arc<Mutex<Option<(CoreProviderMetadata, Value)>>>,
}
impl Default for Runtime {
    fn default() -> Self {
        Self {
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(10))
                .build()
                .expect("TLS client"),
            metadata: Arc::new(Mutex::new(None)),
        }
    }
}
fn is_loopback(url: &url::Url) -> bool {
    matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
}
pub(crate) fn allowed_endpoint(url: &url::Url, local_http: bool) -> bool {
    url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
        && (url.scheme() == "https" || local_http && url.scheme() == "http" && is_loopback(url))
}
impl Runtime {
    async fn discovery(
        &self,
        config: &OidcConfig,
        refresh: bool,
    ) -> Result<(CoreProviderMetadata, Value), ()> {
        let mut cached = self.metadata.lock().await;
        if !refresh && let Some(value) = cached.as_ref() {
            return Ok(value.clone());
        }
        let issuer = url::Url::parse(&config.issuer).map_err(|_| ())?;
        let local_http = is_loopback(&issuer) && issuer.scheme() == "http";
        if !allowed_endpoint(&issuer, local_http) {
            return Err(());
        }
        let raw: Value = self
            .client
            .get(format!(
                "{}/.well-known/openid-configuration",
                config.issuer
            ))
            .send()
            .await
            .map_err(|_| ())?
            .error_for_status()
            .map_err(|_| ())?
            .json()
            .await
            .map_err(|_| ())?;
        for name in [
            "authorization_endpoint",
            "token_endpoint",
            "jwks_uri",
            "userinfo_endpoint",
            "end_session_endpoint",
        ] {
            if let Some(value) = raw[name].as_str()
                && !allowed_endpoint(&url::Url::parse(value).map_err(|_| ())?, local_http)
            {
                return Err(());
            }
        }
        // Parse the same checked discovery document and fetch its exact JWKS URI.
        // This avoids a second discovery response bypassing endpoint validation.
        let metadata: CoreProviderMetadata = serde_json::from_value(raw.clone()).map_err(|_| ())?;
        if metadata.issuer().as_str() != config.issuer {
            return Err(());
        }
        let keys: openidconnect::core::CoreJsonWebKeySet = self
            .client
            .get(metadata.jwks_uri().as_str())
            .send()
            .await
            .map_err(|_| ())?
            .error_for_status()
            .map_err(|_| ())?
            .json()
            .await
            .map_err(|_| ())?;
        let metadata = metadata.set_jwks(keys);
        let value = (metadata, raw);
        *cached = Some(value.clone());
        Ok(value)
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Flow {
    pub state: String,
    pub nonce: String,
    pub verifier: String,
    pub next: String,
    pub expires: u64,
}
pub fn seal(flow: &Flow, secret: &str) -> String {
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(flow).expect("flow serialization"));
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("HMAC key");
    mac.update(format!("oidc-flow:{payload}").as_bytes());
    format!(
        "{payload}.{}",
        URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
    )
}
pub fn open(value: &str, secret: &str, now: u64) -> Option<Flow> {
    if value.len() > 8192 {
        return None;
    }
    let (payload, signature) = value.split_once('.')?;
    let signature = URL_SAFE_NO_PAD.decode(signature).ok()?;
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).ok()?;
    mac.update(format!("oidc-flow:{payload}").as_bytes());
    mac.verify_slice(&signature).ok()?;
    let flow: Flow = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).ok()?).ok()?;
    if flow.expires <= now
        || flow.state.is_empty()
        || flow.nonce.is_empty()
        || flow.verifier.len() < 43
    {
        return None;
    }
    Some(flow)
}
/// Where to land after signing in: a same-origin app path, or "/" for anything else.
pub fn safe_next(value: &str) -> String {
    if !value.starts_with('/')
        || value.starts_with("//")
        // Browsers drop tabs and newlines while parsing, so "/\t/evil" becomes "//evil".
        || value.chars().any(|v| v == '\\' || v.is_control())
        || has_dot_segment(value)
    {
        return "/".into();
    }
    let base = url::Url::parse("http://app.invalid").unwrap();
    let Ok(url) = base.join(value) else {
        return "/".into();
    };
    let path = url.path();
    if url.origin() != base.origin()
        || path.starts_with("//")
        || ["/login", "/api", "/v1"].iter().any(|prefix| {
            path.strip_prefix(prefix)
                .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
        })
    {
        return "/".into();
    }
    format!(
        "{path}{}{}",
        url.query().map(|v| format!("?{v}")).unwrap_or_default(),
        url.fragment().map(|v| format!("#{v}")).unwrap_or_default()
    )
}
// Browsers collapse "." and ".." segments (also as "%2e"), so "/./api/x" lands on "/api/x" and
// "/.//evil.example" on "//evil.example". Rejecting them keeps the path the browser sees.
fn has_dot_segment(value: &str) -> bool {
    let path = value.split(['?', '#']).next().unwrap_or_default();
    path.split('/').any(|segment| {
        matches!(
            segment.to_ascii_lowercase().replace("%2e", ".").as_str(),
            "." | ".."
        )
    })
}
fn now() -> u64 {
    chrono::Utc::now().timestamp_millis().max(0) as u64
}
fn set_cookie(
    response: &mut Response,
    name: &str,
    value: &str,
    ttl: u64,
    same_site: &str,
    secure: bool,
) {
    let secure = if secure { "; Secure" } else { "" };
    response.headers_mut().append(
        header::SET_COOKIE,
        format!("{name}={value}; Path=/; Max-Age={ttl}; HttpOnly; SameSite={same_site}{secure}")
            .parse()
            .expect("cookie value"),
    );
}
fn redirect(location: &str) -> Response {
    let mut response = Redirect::temporary(location).into_response();
    *response.status_mut() = axum::http::StatusCode::FOUND;
    response
}
fn login_error(state: &AppState, key: &str) -> Response {
    redirect(&format!("{}/login?error={key}", state.config.origin)).into_response()
}
macro_rules! client {
    ($state:expr,$metadata:expr) => {
        CoreClient::from_provider_metadata(
            $metadata,
            ClientId::new($state.config.oidc.client_id.clone()),
            if $state.config.oidc.client_secret.is_empty() {
                None
            } else {
                Some(ClientSecret::new($state.config.oidc.client_secret.clone()))
            },
        )
        .set_redirect_uri(
            RedirectUrl::new(format!(
                "{}/api/v1/auth/oidc/callback",
                $state.config.origin
            ))
            .map_err(|_| ())?,
        )
    };
}
pub async fn config(State(state): State<AppState>) -> Json<Value> {
    // The audience is what GitHub Actions workflows request their tokens for.
    Json(
        json!({"oidc":state.config.oidc.enabled(),"displayName":state.config.oidc.display_name,"audience":state.config.origin}),
    )
}
pub async fn start(State(state): State<AppState>, request: Request) -> Response {
    if !state.config.oidc.enabled() {
        return login_error(&state, "oidc_disabled");
    }
    let query: HashMap<String, String> =
        url::form_urlencoded::parse(request.uri().query().unwrap_or("").as_bytes())
            .into_owned()
            .collect();
    drop(request);
    let result = async {
        let (metadata, _) = state.oidc.discovery(&state.config.oidc, false).await?;
        let client = client!(state, metadata);
        let (challenge, verifier) = PkceCodeChallenge::new_random_sha256();
        let mut authorization = client
            .authorize_url(
                CoreAuthenticationFlow::AuthorizationCode,
                CsrfToken::new_random,
                Nonce::new_random,
            )
            .set_pkce_challenge(challenge);
        for scope in state
            .config
            .oidc
            .scopes
            .split_whitespace()
            .filter(|s| *s != "openid")
        {
            authorization = authorization.add_scope(Scope::new(scope.into()));
        }
        let (url, csrf, nonce) = authorization.url();
        let flow = Flow {
            state: csrf.secret().clone(),
            nonce: nonce.secret().clone(),
            verifier: verifier.secret().clone(),
            next: safe_next(query.get("next").map(String::as_str).unwrap_or("/")),
            expires: now() + 600000,
        };
        let mut response = redirect(url.as_str()).into_response();
        set_cookie(
            &mut response,
            "stillup_oidc_flow",
            &seal(&flow, &state.config.admin_token),
            600,
            "Lax",
            state.config.origin.starts_with("https:"),
        );
        Ok::<_, ()>(response)
    }
    .await;
    result.unwrap_or_else(|_| login_error(&state, "oidc_unavailable"))
}
pub async fn callback(State(state): State<AppState>, request: Request) -> Response {
    let query: HashMap<String, String> =
        url::form_urlencoded::parse(request.uri().query().unwrap_or("").as_bytes())
            .into_owned()
            .collect();
    let flow = cookie(request.headers(), "stillup_oidc_flow")
        .and_then(|value| open(value, &state.config.admin_token, now()));
    let mut response = if let Some(error) = query.get("error") {
        login_error(
            &state,
            if error == "access_denied" {
                "oidc_denied"
            } else {
                "oidc_failed"
            },
        )
    } else if let Some(flow) = flow.filter(|_| state.config.oidc.enabled()) {
        finish(&state, &query, &flow)
            .await
            .unwrap_or_else(|_| login_error(&state, "oidc_failed"))
    } else {
        login_error(&state, "oidc_expired")
    };
    set_cookie(
        &mut response,
        "stillup_oidc_flow",
        "",
        0,
        "Lax",
        state.config.origin.starts_with("https:"),
    );
    response
}
async fn finish(
    state: &AppState,
    query: &HashMap<String, String>,
    flow: &Flow,
) -> Result<Response, ()> {
    let expected = query.get("state").ok_or(())?;
    if !auth::token_matches(expected, &flow.state) {
        return Err(());
    }
    let (metadata, _) = state.oidc.discovery(&state.config.oidc, false).await?;
    let client = client!(state, metadata);
    let tokens = client
        .exchange_code(AuthorizationCode::new(query.get("code").ok_or(())?.clone()))
        .map_err(|_| ())?
        .set_pkce_verifier(PkceCodeVerifier::new(flow.verifier.clone()))
        .request_async(&state.oidc.client)
        .await
        .map_err(|_| ())?;
    let id_token = tokens.id_token().ok_or(())?;
    // Retry signature verification after fresh discovery so rotated signing keys work.
    let (metadata, _) = state.oidc.discovery(&state.config.oidc, false).await?;
    let verifier_client = client!(state, metadata);
    let identity = match verify(
        &verifier_client.id_token_verifier(),
        id_token,
        &tokens,
        flow,
    ) {
        Some(identity) => identity,
        None => {
            let (metadata, _) = state.oidc.discovery(&state.config.oidc, true).await?;
            let refreshed = client!(state, metadata);
            verify(&refreshed.id_token_verifier(), id_token, &tokens, flow).ok_or(())?
        }
    };
    let Some(session) = users::sign_in(&state.pool, &state.config.oidc.issuer, &identity)
        .await
        .map_err(|_| ())?
    else {
        return Ok(login_error(state, "oidc_not_invited"));
    };
    let secure = state.config.origin.starts_with("https:");
    let mut response =
        redirect(&format!("{}{}", state.config.origin, safe_next(&flow.next))).into_response();
    set_cookie(
        &mut response,
        "stillup_session",
        &session,
        86400,
        "Lax",
        secure,
    );
    let token = id_token.to_string();
    if token.len() < 3800 {
        set_cookie(
            &mut response,
            "stillup_oidc_idt",
            &token,
            86400,
            "Strict",
            secure,
        );
    } else {
        set_cookie(&mut response, "stillup_oidc_idt", "", 0, "Strict", secure);
    }
    Ok(response)
}
fn verify(
    verifier: &openidconnect::core::CoreIdTokenVerifier<'_>,
    id_token: &openidconnect::core::CoreIdToken,
    tokens: &openidconnect::core::CoreTokenResponse,
    flow: &Flow,
) -> Option<users::Identity> {
    let claims = id_token
        .claims(verifier, &Nonce::new(flow.nonce.clone()))
        .ok()?;
    if let Some(expected) = claims.access_token_hash() {
        let algorithm = id_token.signing_alg().ok()?;
        let key = id_token.signing_key(verifier).ok()?;
        let actual = AccessTokenHash::from_token(tokens.access_token(), algorithm, key).ok()?;
        if actual != *expected {
            return None;
        }
    }
    Some(users::Identity {
        subject: claims.subject().to_string(),
        sid: payload_claim(&id_token.to_string(), "sid"),
        email: claims.email().map(|email| email.to_string()),
        email_verified: claims.email_verified(),
        name: claims
            .name()
            .and_then(|name| name.get(None))
            .map(|name| name.to_string()),
    })
}
/// Reads a string claim from a JWT whose signature has already been verified.
fn payload_claim(jwt: &str, name: &str) -> Option<String> {
    let payload = jwt.split('.').nth(1)?;
    let claims: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).ok()?).ok()?;
    claims[name]
        .as_str()
        .filter(|value| !value.is_empty() && value.len() <= 255)
        .map(str::to_owned)
}

const BACKCHANNEL_LOGOUT_EVENT: &str = "http://schemas.openid.net/event/backchannel-logout";
/// How old a logout token may be. Its ID is remembered for longer than this, so replays fail.
const LOGOUT_TOKEN_AGE: i64 = 300;
/// What a verified logout token asks for.
#[derive(Debug, PartialEq)]
pub struct LogoutRequest {
    pub subject: Option<String>,
    pub sid: Option<String>,
    pub token_id: String,
}
/// Checks the claims of a logout token whose signature, issuer and audience are verified,
/// as OpenID Connect Back-Channel Logout 1.0 section 2.6 asks.
pub fn logout_request(claims: &Value, now: i64) -> Option<LogoutRequest> {
    let text = |name: &str| {
        claims
            .get(name)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty() && value.len() <= 255)
            .map(str::to_owned)
    };
    let issued = claims.get("iat")?.as_i64()?;
    if issued < now - LOGOUT_TOKEN_AGE
        || issued > now + 30
        || claims.get("nonce").is_some()
        || !claims["events"][BACKCHANNEL_LOGOUT_EVENT].is_object()
    {
        return None;
    }
    let request = LogoutRequest {
        subject: text("sub"),
        sid: text("sid"),
        token_id: text("jti")?,
    };
    (request.subject.is_some() || request.sid.is_some()).then_some(request)
}
fn logout_error() -> Response {
    crate::error::ApiError::bad("invalid_request").into_response()
}
/// OpenID Connect Back-Channel Logout: the provider ends the StillUp sessions that came from a
/// provider session or person it signed out. Called server to server, without cookies.
pub async fn backchannel_logout(State(state): State<AppState>, request: Request) -> Response {
    use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode, decode_header, jwk::JwkSet};
    if !state.config.oidc.enabled() {
        return crate::error::ApiError(axum::http::StatusCode::NOT_FOUND, "Not found".into())
            .into_response();
    }
    let Ok(bytes) = axum::body::to_bytes(request.into_body(), 16384).await else {
        return logout_error();
    };
    let Some(token) = url::form_urlencoded::parse(&bytes)
        .find(|(name, _)| name == "logout_token")
        .map(|(_, value)| value.into_owned())
    else {
        return logout_error();
    };
    let Ok(header) = decode_header(&token) else {
        return logout_error();
    };
    let Some(kid) = header.kid.as_deref().filter(|_| {
        matches!(
            header.alg,
            Algorithm::RS256 | Algorithm::ES256 | Algorithm::EdDSA
        )
    }) else {
        return logout_error();
    };
    let unavailable = || {
        crate::error::ApiError(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "The identity provider cannot be reached".into(),
        )
        .into_response()
    };
    // Fetched for each logout, which is rare, so rotated signing keys always verify.
    let Ok((metadata, _)) = state.oidc.discovery(&state.config.oidc, false).await else {
        return unavailable();
    };
    let keys: JwkSet = match async {
        state
            .oidc
            .client
            .get(metadata.jwks_uri().as_str())
            .send()
            .await?
            .error_for_status()?
            .json()
            .await
    }
    .await
    {
        Ok(keys) => keys,
        Err(_) => return unavailable(),
    };
    let Some(key) = keys
        .find(kid)
        .and_then(|key| DecodingKey::from_jwk(key).ok())
    else {
        return logout_error();
    };
    let mut validation = Validation::new(header.alg);
    validation.set_issuer(&[&state.config.oidc.issuer]);
    validation.set_audience(&[&state.config.oidc.client_id]);
    validation.set_required_spec_claims(&["iss", "aud", "iat", "jti"]);
    let Ok(claims) = decode::<Value>(&token, &key, &validation) else {
        return logout_error();
    };
    let Some(logout) = logout_request(&claims.claims, chrono::Utc::now().timestamp()) else {
        return logout_error();
    };
    match users::end_provider_sessions(
        &state.pool,
        &state.config.oidc.issuer,
        logout.subject.as_deref(),
        logout.sid.as_deref(),
        &logout.token_id,
    )
    .await
    {
        Ok(ended) => {
            tracing::info!(sessions = ended, "Back-channel logout ended sessions");
            axum::http::StatusCode::OK.into_response()
        }
        Err(error) => error.into_response(),
    }
}
pub async fn logout(state: &AppState, token: Option<String>) -> Option<String> {
    if !state.config.oidc.enabled() {
        return None;
    }
    let token = token?;
    let (_, raw) = state.oidc.discovery(&state.config.oidc, false).await.ok()?;
    let mut url = url::Url::parse(raw["end_session_endpoint"].as_str()?).ok()?;
    url.query_pairs_mut()
        .append_pair("id_token_hint", &token)
        .append_pair(
            "post_logout_redirect_uri",
            &format!("{}/login", state.config.origin),
        );
    Some(url.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn existing_signed_cookie_format_and_tamper_rejection() {
        let flow = Flow {
            state: "state-value".into(),
            nonce: "nonce-value".into(),
            verifier: "v".repeat(43),
            next: "/docs".into(),
            expires: 1000,
        };
        let value = seal(&flow, "secret");
        assert_eq!(
            value,
            "eyJzdGF0ZSI6InN0YXRlLXZhbHVlIiwibm9uY2UiOiJub25jZS12YWx1ZSIsInZlcmlmaWVyIjoidnZ2dnZ2dnZ2dnZ2dnZ2dnZ2dnZ2dnZ2dnZ2dnZ2dnZ2dnZ2dnZ2dnZ2diIsIm5leHQiOiIvZG9jcyIsImV4cGlyZXMiOjEwMDB9.fg2B_swcipJUQ3ki6nWHpPloLFFMQ3lB2fsEC8QRDE8"
        );
        assert_eq!(open(&value, "secret", 999).unwrap().next, "/docs");
        assert!(open(&value, "secret", 1000).is_none());
        assert!(open(&value, "other", 999).is_none());
        assert!(open(&format!("{value}.extra"), "secret", 999).is_none());
        let (payload, signature) = value.split_once('.').unwrap();
        let mut input: Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).unwrap()).unwrap();
        input["next"] = json!("/evil");
        let forged = format!(
            "{}.{}",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&input).unwrap()),
            signature
        );
        assert!(open(&forged, "secret", 999).is_none());
    }
    #[test]
    fn plain_http_is_only_allowed_for_loopback_development() {
        for value in [
            "http://localhost:3000/token",
            "http://127.0.0.1:3000/token",
            "http://[::1]:3000/token",
        ] {
            let url = url::Url::parse(value).unwrap();
            assert!(allowed_endpoint(&url, true));
            assert!(!allowed_endpoint(&url, false));
        }
        for value in [
            "http://provider.example/token",
            "https://user:password@provider.example/token",
            "https://provider.example/token#fragment",
            "file:///tmp/keys",
        ] {
            assert!(!allowed_endpoint(&url::Url::parse(value).unwrap(), true));
        }
    }
    #[test]
    fn logout_tokens_follow_the_back_channel_logout_rules() {
        let now = 1_000_000;
        let valid = json!({"iss":"https://id.example","aud":"stillup","iat":now,"jti":"j1","sub":"ada","sid":"s1","events":{BACKCHANNEL_LOGOUT_EVENT:{}}});
        assert_eq!(
            logout_request(&valid, now),
            Some(LogoutRequest {
                subject: Some("ada".into()),
                sid: Some("s1".into()),
                token_id: "j1".into()
            })
        );
        let with = |name: &str, value: Value| {
            let mut claims = valid.clone();
            if value.is_null() {
                claims.as_object_mut().unwrap().remove(name);
            } else {
                claims[name] = value;
            }
            claims
        };
        assert_eq!(
            logout_request(&with("sub", Value::Null), now)
                .unwrap()
                .subject,
            None
        );
        assert_eq!(
            logout_request(&with("sid", Value::Null), now).unwrap().sid,
            None
        );
        for claims in [
            with("nonce", json!("n")),
            with("events", Value::Null),
            with("events", json!({BACKCHANNEL_LOGOUT_EVENT:true})),
            with("events", json!({"other":{}})),
            with("iat", Value::Null),
            with("iat", json!(now - LOGOUT_TOKEN_AGE - 1)),
            with("iat", json!(now + 31)),
            with("jti", Value::Null),
            with("jti", json!("")),
            with("sub", json!("")),
            {
                let mut claims = with("sub", Value::Null);
                claims.as_object_mut().unwrap().remove("sid");
                claims
            },
        ] {
            let claims = if claims.get("sub") == Some(&json!("")) {
                let mut claims = claims;
                claims.as_object_mut().unwrap().remove("sid");
                claims
            } else {
                claims
            };
            assert_eq!(logout_request(&claims, now), None, "{claims}");
        }
    }
    #[test]
    fn safe_redirect_matches_existing_normalization_guards() {
        assert_eq!(
            safe_next("/docs/hosting?tab=a#auth"),
            "/docs/hosting?tab=a#auth"
        );
        for value in [
            "",
            "docs",
            "https://evil.example/",
            "//evil.example/",
            "/.//evil.example/",
            "/..//evil.example/",
            "/a/..//evil.example/",
            "/\\evil.example",
            "/\t/evil.example",
            "javascript:alert(1)",
            "/login?error=x",
        ] {
            assert_eq!(safe_next(value), "/");
        }
    }
    // Mirrors the classes paramtune hardened in its sign-in return paths.
    #[test]
    fn safe_redirect_rejects_control_characters() {
        for value in [
            "/\t/evil.example",
            "/\n/evil.example",
            "/\r/evil.example",
            "/docs\r\nLocation: https://evil.example",
            "/\u{0}/evil.example",
            "/\u{7f}/evil.example",
            "/docs\u{85}",
        ] {
            assert_eq!(safe_next(value), "/", "{value:?}");
        }
    }
    #[test]
    fn safe_redirect_rejects_paths_that_normalize_to_a_network_path() {
        for value in [
            "/.//evil.example",
            "/..//evil.example",
            "/a/..//evil.example",
            "/%2e//evil.example",
            "/%2E%2e//evil.example",
            "/a/%2e%2e//evil.example",
        ] {
            assert_eq!(safe_next(value), "/", "{value:?}");
        }
    }
    #[test]
    fn safe_redirect_rejects_dot_segments() {
        for value in [
            "/status/../docs",
            "/./docs",
            "/%2e/docs",
            "/docs/%2E%2E/status",
            "/./login",
            "/%2e/api/v1/session",
        ] {
            assert_eq!(safe_next(value), "/", "{value:?}");
        }
        // Dot segments after the path are data, not navigation.
        assert_eq!(safe_next("/docs?x=../y#../z"), "/docs?x=../y#../z");
        assert_eq!(safe_next("/docs/..hidden"), "/docs/..hidden");
    }
    #[test]
    fn safe_redirect_rejects_api_and_sign_in_paths() {
        for value in [
            "/api/v1/auth/oidc/start",
            "/api/v1/session",
            "/v1/checks",
            "/login",
            "/login/",
        ] {
            assert_eq!(safe_next(value), "/", "{value:?}");
        }
        assert_eq!(safe_next("/api-docs"), "/api-docs");
        assert_eq!(safe_next("/loginhelp"), "/loginhelp");
    }
}
