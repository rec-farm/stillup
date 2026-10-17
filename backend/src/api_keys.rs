//! API keys for other apps and automation, and authentication of the short-lived tokens that
//! trusted GitHub Actions workflows receive. Only a SHA-256 of each is stored; a key's plaintext
//! is shown once, at creation.
use crate::{
    error::ApiError,
    json::{ApiJson, ApiPath},
    server::{AppState, timestamp},
    users::{CredentialRole, Principal},
};
use axum::{Extension, Json, extract::State, http::StatusCode};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row, postgres::PgRow};
use uuid::Uuid;

pub const KEY_PREFIX: &str = "suk_";
pub const PUBLISHER_TOKEN_PREFIX: &str = "sut_";
const LIMIT: i64 = 100;

pub fn hash(value: &str) -> Vec<u8> {
    Sha256::digest(value.as_bytes()).to_vec()
}
/// A prefix and two v4 UUIDs: 244 random bits from the operating system generator.
pub fn random_token(prefix: &str) -> String {
    format!(
        "{prefix}{}{}",
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple()
    )
}
fn well_formed(value: &str, prefix: &str) -> bool {
    value.strip_prefix(prefix).is_some_and(|rest| {
        rest.len() == 64
            && rest
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    })
}
/// Whether a bearer value is shaped like a StillUp credential, as opposed to the
/// installation token.
pub fn is_credential(value: &str) -> bool {
    value.starts_with(KEY_PREFIX) || value.starts_with(PUBLISHER_TOKEN_PREFIX)
}

/// The principal an API key or trusted-publisher token acts as, or None when it is unknown,
/// expired or revoked.
pub async fn principal(pool: &PgPool, value: &str) -> Result<Option<Principal>, ApiError> {
    if well_formed(value, KEY_PREFIX) {
        let row = sqlx::query_as::<_, (Uuid, String, Option<Vec<String>>, bool)>(
            "SELECT id,role,projects,last_used_at IS NULL OR last_used_at<now()-interval '1 minute' FROM api_keys WHERE token_hash=$1 AND (expires_at IS NULL OR expires_at>now())",
        )
        .bind(hash(value))
        .fetch_optional(pool)
        .await?;
        let Some((id, role, projects, stale)) = row else {
            return Ok(None);
        };
        // Recorded at most once a minute, so busy integrations do not write on every request.
        if stale {
            sqlx::query("UPDATE api_keys SET last_used_at=now() WHERE id=$1")
                .bind(id)
                .execute(pool)
                .await?;
        }
        return Ok(
            CredentialRole::parse(&role).map(|role| Principal::Credential { id, role, projects }),
        );
    }
    if well_formed(value, PUBLISHER_TOKEN_PREFIX) {
        let row = sqlx::query_as::<_, (Uuid, Vec<String>)>(
            "SELECT p.id,p.projects FROM publisher_tokens t JOIN trusted_publishers p ON p.id=t.publisher_id WHERE t.token_hash=$1 AND t.expires_at>now()",
        )
        .bind(hash(value))
        .fetch_optional(pool)
        .await?;
        return Ok(row.map(|(id, projects)| Principal::Credential {
            id,
            role: CredentialRole::Deployer,
            projects: Some(projects),
        }));
    }
    Ok(None)
}

/// Who created a credential, as shown next to it.
pub async fn actor(pool: &PgPool, principal: &Principal) -> Result<String, ApiError> {
    Ok(match principal {
        Principal::User { id, .. } => {
            sqlx::query_scalar::<_, String>("SELECT email FROM users WHERE id=$1")
                .bind(id)
                .fetch_one(pool)
                .await?
        }
        _ => "Installation administrator".into(),
    })
}

/// Monitoring-as-code project IDs, as configurations name them.
pub fn projects(value: Option<&Value>, max: usize) -> Result<Vec<String>, ApiError> {
    let invalid = || {
        ApiError::bad(format!(
            "projects: Expected up to {max} project IDs of 1–64 lowercase letters, digits, or hyphens"
        ))
    };
    let Some(value) = value.filter(|value| !value.is_null()) else {
        return Ok(Vec::new());
    };
    let items = value
        .as_array()
        .filter(|items| items.len() <= max)
        .ok_or_else(invalid)?;
    let mut projects = Vec::new();
    for item in items {
        let project = crate::code_management::identity(item).map_err(|_| invalid())?;
        if !projects.contains(&project) {
            projects.push(project);
        }
    }
    Ok(projects)
}

fn key(row: &PgRow) -> Result<Value, sqlx::Error> {
    Ok(json!({
        "id": row.try_get::<Uuid, _>("id")?,
        "name": row.try_get::<String, _>("name")?,
        "role": row.try_get::<String, _>("role")?,
        "projects": row.try_get::<Option<Vec<String>>, _>("projects")?,
        "hint": row.try_get::<String, _>("hint")?,
        "createdBy": row.try_get::<String, _>("created_by")?,
        "createdAt": timestamp(row, "created_at")?,
        "expiresAt": timestamp(row, "expires_at")?,
        "lastUsedAt": timestamp(row, "last_used_at")?,
    }))
}

pub async fn list(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let rows = sqlx::query("SELECT * FROM api_keys ORDER BY created_at DESC")
        .fetch_all(&state.pool)
        .await?;
    let keys = rows.iter().map(key).collect::<Result<Vec<_>, _>>()?;
    Ok(Json(json!({"keys":keys})))
}

pub async fn create(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    ApiJson(input): ApiJson,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let name = input
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| (1..=80).contains(&name.chars().count()))
        .ok_or_else(|| ApiError::bad("name: Enter a name of up to 80 characters"))?;
    let role = input
        .get("role")
        .and_then(Value::as_str)
        .and_then(CredentialRole::parse)
        .ok_or_else(|| ApiError::bad("role: Expected viewer, deployer or admin"))?;
    let projects = projects(input.get("projects"), 20)?;
    if role != CredentialRole::Deployer && !projects.is_empty() {
        return Err(ApiError::bad(
            "projects: Only deploy keys are limited to projects",
        ));
    }
    let days = match input.get("expiresInDays") {
        None | Some(Value::Null) => None,
        Some(value) => Some(
            value
                .as_i64()
                .filter(|days| (1..=365).contains(days))
                .ok_or_else(|| {
                    ApiError::bad("expiresInDays: Expected 1 to 365 days, or null for never")
                })?,
        ),
    };
    let token = random_token(KEY_PREFIX);
    let created_by = actor(&state.pool, &principal).await?;
    let mut transaction = state.pool.begin().await?;
    // Serializes creation so the limit holds under concurrent requests.
    sqlx::query("LOCK TABLE api_keys IN SHARE ROW EXCLUSIVE MODE")
        .execute(&mut *transaction)
        .await?;
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM api_keys")
        .fetch_one(&mut *transaction)
        .await?;
    if count >= LIMIT {
        return Err(ApiError::conflict(format!(
            "StillUp keeps up to {LIMIT} API keys. Revoke unused keys first."
        )));
    }
    let row = sqlx::query(
        "INSERT INTO api_keys(name,role,projects,token_hash,hint,created_by,expires_at) VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $7::int IS NULL THEN NULL ELSE now()+make_interval(days=>$7::int) END) RETURNING *",
    )
    .bind(name)
    .bind(role.as_str())
    .bind((!projects.is_empty()).then_some(&projects))
    .bind(hash(&token))
    .bind(&token[..KEY_PREFIX.len() + 8])
    .bind(&created_by)
    .bind(days.map(|days| days as i32))
    .fetch_one(&mut *transaction)
    .await?;
    transaction.commit().await?;
    Ok((
        StatusCode::CREATED,
        Json(json!({"key":key(&row)?,"token":token})),
    ))
}

pub async fn revoke(
    State(state): State<AppState>,
    ApiPath(value): ApiPath<String>,
) -> Result<StatusCode, ApiError> {
    if !crate::check_config::valid_uuid(&value) {
        return Err(ApiError::bad("id: Invalid UUID"));
    }
    let id = Uuid::parse_str(&value).map_err(|_| ApiError::bad("id: Invalid UUID"))?;
    let removed = sqlx::query("DELETE FROM api_keys WHERE id=$1")
        .bind(id)
        .execute(&state.pool)
        .await?;
    if removed.rows_affected() == 0 {
        return Err(ApiError(StatusCode::NOT_FOUND, "API key not found".into()));
    }
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn credentials_are_recognized_by_shape() {
        let key = random_token(KEY_PREFIX);
        assert!(well_formed(&key, KEY_PREFIX));
        assert!(!well_formed(&key, PUBLISHER_TOKEN_PREFIX));
        assert!(is_credential(&key));
        assert!(well_formed(
            &random_token(PUBLISHER_TOKEN_PREFIX),
            PUBLISHER_TOKEN_PREFIX
        ));
        for value in [
            "suk_",
            "suk_xyz",
            &format!("suk_{}", "A".repeat(64)),
            &format!("suk_{}", "a".repeat(63)),
            &format!("suk_{}0", "a".repeat(64)),
        ] {
            assert!(!well_formed(value, KEY_PREFIX), "{value}");
        }
        assert!(!is_credential("01234567890123456789012345678901"));
    }
    #[test]
    fn projects_are_validated_and_deduplicated() {
        assert_eq!(projects(None, 20).unwrap(), Vec::<String>::new());
        assert_eq!(
            projects(Some(&json!(["api", "web", "api"])), 20).unwrap(),
            ["api", "web"]
        );
        for invalid in [json!("api"), json!(["API"]), json!([""]), json!([1])] {
            assert!(projects(Some(&invalid), 20).is_err(), "{invalid}");
        }
        assert!(projects(Some(&json!(["a", "b", "c"])), 2).is_err());
    }
}
