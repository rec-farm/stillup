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
    User {
        id: Uuid,
        admin: bool,
    },
    /// An API key, or a short-lived token from a trusted GitHub Actions workflow.
    Credential {
        id: Uuid,
        role: CredentialRole,
        /// Monitoring-as-code projects a deployer may change; None means every project.
        projects: Option<Vec<String>>,
    },
    /// An agent acting for a person through farmhand (`gateway`): what the person may do,
    /// capped by the scope they allowed, never access management.
    Delegated {
        user_id: Uuid,
        admin: bool,
        cap: CredentialRole,
        agent: String,
    },
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum CredentialRole {
    Viewer,
    Deployer,
    Admin,
}
impl CredentialRole {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "viewer" => Some(Self::Viewer),
            "deployer" => Some(Self::Deployer),
            "admin" => Some(Self::Admin),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Viewer => "viewer",
            Self::Deployer => "deployer",
            Self::Admin => "admin",
        }
    }
}
impl Principal {
    pub fn admin(&self) -> bool {
        matches!(
            self,
            Self::Installation
                | Self::User { admin: true, .. }
                | Self::Credential {
                    role: CredentialRole::Admin,
                    ..
                }
        )
    }
    /// Whether this principal may make a request at all. Credentials and agents never manage
    /// people or other credentials, so a leaked key cannot mint more access.
    pub fn may(&self, method: &str, path: &str) -> bool {
        match self {
            Self::Installation | Self::User { admin: true, .. } => true,
            Self::User { .. } => viewer_may(method, path),
            Self::Credential { role, .. } => match role {
                CredentialRole::Admin => !manages_access(path),
                CredentialRole::Viewer => viewer_may(method, path),
                CredentialRole::Deployer => {
                    (method == "POST"
                        && matches!(path, "/v1/code/plan" | "/v1/code/apply" | "/v1/checks/test"))
                        || (matches!(method, "GET" | "HEAD") && path == "/v1/me")
                }
            },
            Self::Delegated { admin, cap, .. } => {
                let person = *admin || viewer_may(method, path);
                let scope = match cap {
                    CredentialRole::Admin => true,
                    CredentialRole::Viewer => viewer_may(method, path),
                    CredentialRole::Deployer => {
                        viewer_may(method, path)
                            || (method == "POST"
                                && matches!(
                                    path,
                                    "/v1/code/plan" | "/v1/code/apply" | "/v1/checks/test"
                                ))
                    }
                };
                person && scope && !manages_access(path)
            }
        }
    }
    /// Whether this principal may change the checks of a monitoring-as-code project.
    pub fn may_deploy(&self, project: &str) -> bool {
        match self {
            Self::Credential {
                role: CredentialRole::Deployer,
                projects,
                ..
            } => projects
                .as_ref()
                .is_none_or(|projects| projects.iter().any(|p| p == project)),
            Self::Delegated { admin, cap, .. } => *admin && *cap != CredentialRole::Viewer,
            _ => self.admin(),
        }
    }
}
fn manages_access(path: &str) -> bool {
    ["/v1/users", "/v1/api-keys", "/v1/trusted-publishers"]
        .iter()
        .any(|prefix| {
            path.strip_prefix(prefix)
                .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
        })
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
/// Keeps parameter names but hides every value. String-based, so unparseable URLs such as
/// those with secret references in the host are covered too.
fn hide_query(value: &str) -> String {
    let Some((base, query)) = value.split_once('?') else {
        return value.to_owned();
    };
    let query = query
        .split('&')
        .map(|pair| {
            format!(
                "{}={HIDDEN}",
                pair.split_once('=').map_or(pair, |(name, _)| name)
            )
        })
        .collect::<Vec<_>>()
        .join("&");
    format!("{base}?{query}")
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
    subject: &str,
    sid: Option<&str>,
) -> Result<String, sqlx::Error> {
    // Two v4 UUIDs carry 244 random bits from the operating system generator.
    let token = format!("u.{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    sqlx::query("DELETE FROM user_sessions WHERE expires_at<=now()")
        .execute(&mut *connection)
        .await?;
    sqlx::query("INSERT INTO user_sessions(token_hash,user_id,expires_at,oidc_subject,oidc_sid) VALUES($1,$2,now()+make_interval(secs=>$3),$4,$5)")
        .bind(token_hash(&token))
        .bind(user)
        .bind(SESSION_SECONDS as f64)
        .bind(subject)
        .bind(sid)
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

/// How a provider's subject is stored: the issuer and subject, as users bind it.
pub(crate) fn subject_key(issuer: &str, subject: &str) -> String {
    format!("{issuer} {subject}")
}

/// Ends the single sign-on sessions a verified back-channel logout names: those from its
/// provider session (sid), of its person (sub), or both. Sessions from before sessions recorded
/// either are matched through their user's bound subject. A replayed token ID changes nothing.
pub async fn end_provider_sessions(
    pool: &PgPool,
    issuer: &str,
    subject: Option<&str>,
    sid: Option<&str>,
    token_id: &str,
) -> Result<u64, ApiError> {
    if subject.is_none() && sid.is_none() {
        return Ok(0);
    }
    let subject = subject.map(|subject| subject_key(issuer, subject));
    let mut transaction = pool.begin().await?;
    sqlx::query("DELETE FROM oidc_logout_tokens WHERE expires_at<=now()")
        .execute(&mut *transaction)
        .await?;
    let fresh = sqlx::query(
        "INSERT INTO oidc_logout_tokens(jti_hash,expires_at) VALUES($1,now()+interval '10 minutes') ON CONFLICT DO NOTHING",
    )
    .bind(token_hash(&format!("{issuer}\n{token_id}")))
    .execute(&mut *transaction)
    .await?
    .rows_affected()
        == 1;
    if !fresh {
        return Ok(0);
    }
    let ended = sqlx::query(
        "DELETE FROM user_sessions s WHERE ($1::text IS NULL OR s.oidc_subject=$1 OR (s.oidc_subject IS NULL AND s.user_id IN (SELECT id FROM users WHERE oidc_subject=$1))) AND ($2::text IS NULL OR s.oidc_sid=$2 OR (s.oidc_sid IS NULL AND $1::text IS NOT NULL))",
    )
    .bind(&subject)
    .bind(sid)
    .execute(&mut *transaction)
    .await?
    .rows_affected();
    transaction.commit().await?;
    Ok(ended)
}

pub struct Identity {
    pub subject: String,
    /// The provider's session, named again by its back-channel logout.
    pub sid: Option<String>,
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
    let subject = subject_key(issuer, &identity.subject);
    let token = create_session(&mut transaction, user, &subject, identity.sid.as_deref()).await?;
    transaction.commit().await?;
    Ok(Some(token))
}
async fn matching_user(
    connection: &mut sqlx::PgConnection,
    issuer: &str,
    identity: &Identity,
) -> Result<Option<Uuid>, sqlx::Error> {
    let subject = subject_key(issuer, &identity.subject);
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
    let (id, agent) = match principal {
        Principal::User { id, .. } => (id, None),
        Principal::Delegated { user_id, agent, .. } => (user_id, Some(agent)),
        Principal::Installation => return Ok(Json(json!({"kind":"installation","role":"admin"}))),
        Principal::Credential { role, projects, .. } => {
            return Ok(Json(
                json!({"kind":"credential","role":role.as_str(),"projects":projects}),
            ));
        }
    };
    let row = sqlx::query("SELECT * FROM users WHERE id=$1")
        .bind(id)
        .fetch_one(&state.pool)
        .await?;
    let mut value = user(&row)?;
    value["kind"] = json!("user");
    if let Some(agent) = agent {
        value["agent"] = json!(agent);
    }
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
        assert_eq!(
            hide_query("https://{{HOST}}/x?key={{K}}&raw"),
            "https://{{HOST}}/x?key=[hidden]&raw=[hidden]"
        );
        assert_eq!(hide_query("https://x.io/a"), "https://x.io/a");
        assert!(!viewer_may("POST", "/v1/checks/x/run"));
        assert!(!viewer_may("PATCH", "/v1/checks/x"));
    }
    #[test]
    fn agents_get_their_persons_role_capped_by_scope_and_always_redacted() {
        let agent = |admin, cap| Principal::Delegated {
            user_id: Uuid::nil(),
            admin,
            cap,
            agent: "Claude Code".into(),
        };
        let all = agent(true, CredentialRole::Admin);
        assert!(all.may("PATCH", "/v1/checks/x"));
        assert!(all.may("POST", "/v1/code/apply"));
        assert!(all.may_deploy("api"));
        assert!(!all.may("GET", "/v1/users"));
        assert!(!all.may("POST", "/v1/api-keys"));
        assert!(!all.admin(), "configs are redacted for agents");
        let deployer = agent(true, CredentialRole::Deployer);
        assert!(deployer.may("POST", "/v1/code/plan") && deployer.may("GET", "/v1/dashboard"));
        assert!(!deployer.may("PATCH", "/v1/checks/x"));
        let reader = agent(true, CredentialRole::Viewer);
        assert!(reader.may("GET", "/v1/checks/x") && !reader.may("POST", "/v1/code/plan"));
        assert!(!reader.may_deploy("api"));
        let viewer = agent(false, CredentialRole::Admin);
        assert!(viewer.may("GET", "/v1/dashboard"));
        assert!(!viewer.may("POST", "/v1/code/plan") && !viewer.may_deploy("api"));
        assert!(!viewer.may("GET", "/v1/secrets"));
    }
    #[test]
    fn credentials_never_manage_access_and_deployers_stay_in_their_projects() {
        let credential = |role, projects: Option<&[&str]>| Principal::Credential {
            id: Uuid::nil(),
            role,
            projects: projects.map(|p| p.iter().map(|p| p.to_string()).collect()),
        };
        let admin = credential(CredentialRole::Admin, None);
        assert!(admin.may("POST", "/v1/checks"));
        assert!(admin.may("GET", "/v1/secrets"));
        for path in [
            "/v1/users",
            "/v1/users/x",
            "/v1/api-keys",
            "/v1/api-keys/x",
            "/v1/trusted-publishers",
            "/v1/trusted-publishers/x",
        ] {
            assert!(!admin.may("GET", path), "{path}");
            assert!(!admin.may("POST", path), "{path}");
            assert!(Principal::Installation.may("POST", path), "{path}");
        }
        assert!(admin.may("GET", "/v1/users-report"));
        let viewer = credential(CredentialRole::Viewer, None);
        assert!(viewer.may("GET", "/v1/dashboard"));
        assert!(!viewer.may("POST", "/v1/code/plan"));
        assert!(!viewer.may_deploy("api"));
        let deployer = credential(CredentialRole::Deployer, Some(&["api"]));
        for path in ["/v1/code/plan", "/v1/code/apply", "/v1/checks/test"] {
            assert!(deployer.may("POST", path), "{path}");
        }
        assert!(deployer.may("GET", "/v1/me"));
        for (method, path) in [
            ("GET", "/v1/dashboard"),
            ("POST", "/v1/checks"),
            ("GET", "/v1/secrets"),
            ("GET", "/v1/code/plan"),
        ] {
            assert!(!deployer.may(method, path), "{method} {path}");
        }
        assert!(deployer.may_deploy("api"));
        assert!(!deployer.may_deploy("web"));
        assert!(credential(CredentialRole::Deployer, None).may_deploy("web"));
        assert!(admin.may_deploy("web"));
        let person = Principal::User {
            id: Uuid::nil(),
            admin: false,
        };
        assert!(!person.may_deploy("web"));
    }
}
