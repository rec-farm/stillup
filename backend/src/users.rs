use crate::{
    error::ApiError,
    json::{ApiJson, ApiPath},
    server::{AppState, timestamp},
};
use axum::{Extension, Json, extract::State, http::StatusCode};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row, postgres::PgRow};
use uuid::Uuid;

pub const SESSION_SECONDS: i64 = 86_400;
const USERS_LOCK: i64 = 782_315;

/// Who an authenticated request acts for. The installation token, and single sign-on while no
/// users exist, act as the installation administrator.
#[derive(Clone, Debug, PartialEq)]
pub enum Principal {
    Installation,
    User { id: Uuid, admin: bool },
}
impl Principal {
    pub fn admin(&self) -> bool {
        matches!(self, Self::Installation | Self::User { admin: true, .. })
    }
}

/// Viewers can read monitoring data but not settings that hold destinations or credentials.
pub fn viewer_may(method: &str, path: &str) -> bool {
    matches!(method, "GET" | "HEAD")
        && (matches!(path, "/v1/dashboard" | "/v1/me" | "/v1/workspace")
            || path.starts_with("/v1/checks/")
            || path.starts_with("/v1/incidents/"))
}

/// Hides request headers and bodies from viewers in every check configuration of a response,
/// since they may hold credentials written inline instead of as secret references.
pub fn redact_for_viewer(value: &mut Value) {
    match value {
        Value::Object(object) => {
            if let Some(Value::Object(config)) = object.get_mut("config") {
                if let Some(Value::Object(headers)) = config.get_mut("headers") {
                    for header in headers.values_mut() {
                        *header = json!(HIDDEN);
                    }
                }
                if let Some(url) = config.get("url").and_then(Value::as_str).map(hide_query) {
                    config["url"] = json!(url);
                }
                if config
                    .get("body")
                    .and_then(Value::as_str)
                    .is_some_and(|body| !body.is_empty())
                {
                    config["body"] = json!(HIDDEN);
                }
            }
            object.values_mut().for_each(redact_for_viewer);
        }
        Value::Array(items) => items.iter_mut().for_each(redact_for_viewer),
        _ => (),
    }
}
pub const HIDDEN: &str = "[hidden]";
fn hide_query(value: &str) -> String {
    let Ok(mut url) = url::Url::parse(value) else {
        return value.to_owned();
    };
    if url.query().is_none() {
        return value.to_owned();
    }
    let query = url
        .query_pairs()
        .map(|(name, _)| {
            format!(
                "{}={HIDDEN}",
                url::form_urlencoded::byte_serialize(name.as_bytes()).collect::<String>()
            )
        })
        .collect::<Vec<_>>()
        .join("&");
    url.set_query(Some(&query));
    url.into()
}

pub fn is_user_session(value: &str) -> bool {
    value.starts_with("u.")
}
fn token_hash(value: &str) -> Vec<u8> {
    Sha256::digest(value.as_bytes()).to_vec()
}

pub async fn session_principal(pool: &PgPool, value: &str) -> Result<Option<Principal>, ApiError> {
    let row = sqlx::query_as::<_, (Option<Uuid>, Option<String>)>(
        "SELECT s.user_id,u.role FROM user_sessions s LEFT JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()",
    )
    .bind(token_hash(value))
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(id, role)| match id {
        None => Principal::Installation,
        Some(id) => Principal::User {
            id,
            admin: role.as_deref() == Some("admin"),
        },
    }))
}

/// A signed installation session is current unless it was issued before the first user existed.
/// Single sign-on no longer issues these, but sessions from before an upgrade may remain.
pub async fn legacy_session_current(pool: &PgPool, value: &str) -> Result<bool, ApiError> {
    let Some(expires) = value
        .split_once('.')
        .and_then(|(expires, _)| expires.parse::<i64>().ok())
    else {
        return Ok(false);
    };
    let first = sqlx::query_scalar::<_, Option<i64>>(
        "SELECT (extract(epoch FROM min(created_at))*1000)::bigint FROM users",
    )
    .fetch_one(pool)
    .await?;
    Ok(first.is_none_or(|first| expires - SESSION_SECONDS * 1000 >= first))
}

/// A missing user is the installation administrator, admitted by single sign-on before any
/// users existed; adding the first user ends those sessions.
async fn create_session(
    connection: &mut sqlx::PgConnection,
    user: Option<Uuid>,
) -> Result<String, sqlx::Error> {
    // Two v4 UUIDs carry 244 random bits from the operating system generator.
    let token = format!("u.{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    sqlx::query("DELETE FROM user_sessions WHERE expires_at<=now()")
        .execute(&mut *connection)
        .await?;
    sqlx::query("INSERT INTO user_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+make_interval(secs=>$3))")
        .bind(token_hash(&token))
        .bind(user)
        .bind(SESSION_SECONDS as f64)
        .execute(&mut *connection)
        .await?;
    Ok(token)
}

pub async fn end_session(pool: &PgPool, value: &str) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM user_sessions WHERE token_hash=$1")
        .bind(token_hash(value))
        .execute(pool)
        .await?;
    Ok(())
}

pub struct Identity {
    pub subject: String,
    pub email: Option<String>,
    pub email_verified: Option<bool>,
    pub name: Option<String>,
}

/// Matches a verified single sign-on identity to a user, first by its bound subject, then once
/// by email for an invited user who has not signed in yet, and returns a new session token.
/// Returns None for people who are not invited. Runs under the shared users lock, so a
/// concurrent first invitation or removal either precedes it or ends the session it creates.
pub async fn sign_in(
    pool: &PgPool,
    issuer: &str,
    identity: &Identity,
) -> Result<Option<String>, ApiError> {
    let mut transaction = pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock_shared($1)")
        .bind(USERS_LOCK)
        .execute(&mut *transaction)
        .await?;
    let user = if !sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM users)")
        .fetch_one(&mut *transaction)
        .await?
    {
        None
    } else {
        match matching_user(&mut transaction, issuer, identity).await? {
            Some(id) => Some(id),
            None => return Ok(None),
        }
    };
    let token = create_session(&mut transaction, user).await?;
    transaction.commit().await?;
    Ok(Some(token))
}
async fn matching_user(
    connection: &mut sqlx::PgConnection,
    issuer: &str,
    identity: &Identity,
) -> Result<Option<Uuid>, sqlx::Error> {
    let subject = format!("{issuer} {}", identity.subject);
    let name = identity
        .name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(|name| name.chars().take(200).collect::<String>());
    if let Some(id) = sqlx::query_scalar::<_, Uuid>(
        "UPDATE users SET last_sign_in_at=now(),name=COALESCE($2,name) WHERE oidc_subject=$1 RETURNING id",
    )
    .bind(&subject)
    .bind(&name)
    .fetch_optional(&mut *connection)
    .await?
    {
        return Ok(Some(id));
    }
    // Only an address the provider asserts it verified can claim an invitation.
    let Some(email) = identity
        .email
        .as_deref()
        .filter(|_| identity.email_verified == Some(true))
        .map(|email| email.trim().to_lowercase())
    else {
        return Ok(None);
    };
    sqlx::query_scalar::<_, Uuid>(
        "UPDATE users SET oidc_subject=$1,last_sign_in_at=now(),name=COALESCE($3,name) WHERE email=$2 AND oidc_subject IS NULL RETURNING id",
    )
    .bind(&subject)
    .bind(&email)
    .bind(&name)
    .fetch_optional(&mut *connection)
    .await
}

fn user(row: &PgRow) -> Result<Value, sqlx::Error> {
    Ok(json!({
        "id": row.try_get::<Uuid, _>("id")?,
        "email": row.try_get::<String, _>("email")?,
        "name": row.try_get::<Option<String>, _>("name")?,
        "role": row.try_get::<String, _>("role")?,
        "linked": row.try_get::<Option<String>, _>("oidc_subject")?.is_some(),
        "createdAt": timestamp(row, "created_at")?,
        "lastSignInAt": timestamp(row, "last_sign_in_at")?,
    }))
}

pub async fn me(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
) -> Result<Json<Value>, ApiError> {
    let Principal::User { id, .. } = principal else {
        return Ok(Json(json!({"kind":"installation","role":"admin"})));
    };
    let row = sqlx::query("SELECT * FROM users WHERE id=$1")
        .bind(id)
        .fetch_one(&state.pool)
        .await?;
    let mut value = user(&row)?;
    value["kind"] = json!("user");
    Ok(Json(value))
}

pub async fn list(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let rows = sqlx::query("SELECT * FROM users ORDER BY email")
        .fetch_all(&state.pool)
        .await?;
    let users = rows.iter().map(user).collect::<Result<Vec<_>, _>>()?;
    Ok(Json(
        json!({"users":users,"oidc":state.config.oidc.enabled()}),
    ))
}

fn role(input: &Value) -> Result<&'static str, ApiError> {
    match input.get("role").and_then(Value::as_str) {
        Some("admin") => Ok("admin"),
        Some("viewer") => Ok("viewer"),
        _ => Err(ApiError::bad("role: Expected admin or viewer")),
    }
}
pub fn email(value: &str) -> Option<String> {
    let email = value.trim().to_lowercase();
    let (local, domain) = email.split_once('@')?;
    (!local.is_empty()
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && !domain.contains('@')
        && email.len() <= 254
        && !email.chars().any(|c| c.is_whitespace() || c.is_control()))
    .then_some(email)
}
fn id(value: &str) -> Result<Uuid, ApiError> {
    if !crate::check_config::valid_uuid(value) {
        return Err(ApiError::bad("id: Invalid UUID"));
    }
    Uuid::parse_str(value).map_err(|_| ApiError::bad("id: Invalid UUID"))
}
fn not_found() -> ApiError {
    ApiError(StatusCode::NOT_FOUND, "User not found".into())
}

/// Serializes user changes and refuses any that would leave users without an administrator,
/// since only administrators can manage users through single sign-on.
async fn change<T>(
    pool: &PgPool,
    apply: impl AsyncFnOnce(&mut sqlx::PgConnection) -> Result<T, ApiError>,
) -> Result<T, ApiError> {
    let mut transaction = pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(USERS_LOCK)
        .execute(&mut *transaction)
        .await?;
    let result = apply(&mut *transaction).await?;
    let (users, admins) = sqlx::query_as::<_, (i64, i64)>(
        "SELECT count(*),count(*) FILTER (WHERE role='admin') FROM users",
    )
    .fetch_one(&mut *transaction)
    .await?;
    if users > 0 && admins == 0 {
        return Err(ApiError::conflict(
            "Keep at least one administrator so someone can manage StillUp with single sign-on",
        ));
    }
    if users > 0 {
        // Single sign-on admitted these before anyone was invited; they may not be invited now.
        sqlx::query("DELETE FROM user_sessions WHERE user_id IS NULL")
            .execute(&mut *transaction)
            .await?;
    }
    transaction.commit().await?;
    Ok(result)
}

pub async fn create(
    State(state): State<AppState>,
    ApiJson(input): ApiJson,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let email = input
        .get("email")
        .and_then(Value::as_str)
        .and_then(email)
        .ok_or_else(|| ApiError::bad("email: Enter a valid email address"))?;
    let name = match input.get("name") {
        None | Some(Value::Null) => None,
        Some(Value::String(name)) if name.trim().chars().count() <= 200 => {
            Some(name.trim().to_owned()).filter(|name| !name.is_empty())
        }
        _ => return Err(ApiError::bad("name: Expected at most 200 characters")),
    };
    let role = role(&input)?;
    let row = change(&state.pool, async |connection| {
        sqlx::query("INSERT INTO users(email,name,role) VALUES($1,$2,$3) ON CONFLICT(email) DO NOTHING RETURNING *")
            .bind(&email)
            .bind(&name)
            .bind(role)
            .fetch_optional(connection)
            .await?
            .ok_or_else(|| ApiError::conflict("A user with this email already exists"))
    })
    .await?;
    Ok((StatusCode::CREATED, Json(user(&row)?)))
}

pub async fn edit(
    State(state): State<AppState>,
    ApiPath(value): ApiPath<String>,
    ApiJson(input): ApiJson,
) -> Result<Json<Value>, ApiError> {
    let id = id(&value)?;
    let role = role(&input)?;
    let row = change(&state.pool, async |connection| {
        sqlx::query("UPDATE users SET role=$2 WHERE id=$1 RETURNING *")
            .bind(id)
            .bind(role)
            .fetch_optional(connection)
            .await?
            .ok_or_else(not_found)
    })
    .await?;
    Ok(Json(user(&row)?))
}

/// Removing a user also ends their sessions.
pub async fn remove(
    State(state): State<AppState>,
    ApiPath(value): ApiPath<String>,
) -> Result<StatusCode, ApiError> {
    let id = id(&value)?;
    change(&state.pool, async |connection| {
        let removed = sqlx::query("DELETE FROM users WHERE id=$1")
            .bind(id)
            .execute(connection)
            .await?;
        if removed.rows_affected() == 0 {
            return Err(not_found());
        }
        Ok(())
    })
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn email_addresses_are_normalized_and_bounded() {
        assert_eq!(email("  Ada@Example.COM "), Some("ada@example.com".into()));
        for invalid in [
            "",
            "ada",
            "@example.com",
            "ada@example",
            "a b@x.io",
            "a@x.io.",
        ] {
            assert_eq!(email(invalid), None, "{invalid}");
        }
        assert_eq!(email(&format!("{}@x.io", "a".repeat(250))), None);
    }
    #[test]
    fn viewers_read_monitoring_but_not_settings() {
        for path in [
            "/v1/dashboard",
            "/v1/me",
            "/v1/checks/x/runs",
            "/v1/incidents/x",
        ] {
            assert!(viewer_may("GET", path), "{path}");
        }
        for path in [
            "/v1/users",
            "/v1/secrets",
            "/v1/notification-channels",
            "/v1/locations",
            "/v1/status-management",
        ] {
            assert!(!viewer_may("GET", path), "{path}");
        }
        let mut value = json!({"monitors":[{"config":{"headers":{"authorization":"Bearer x"},"body":"{\"key\":1}","url":"https://x.io/a?api_key=x&b"}}],"revisions":[{"config":{"headers":{},"body":""}}]});
        redact_for_viewer(&mut value);
        assert_eq!(
            value,
            json!({"monitors":[{"config":{"headers":{"authorization":"[hidden]"},"body":"[hidden]","url":"https://x.io/a?api_key=[hidden]&b=[hidden]"}}],"revisions":[{"config":{"headers":{},"body":""}}]})
        );
        assert!(!viewer_may("POST", "/v1/checks/x/run"));
        assert!(!viewer_may("PATCH", "/v1/checks/x"));
    }
}
