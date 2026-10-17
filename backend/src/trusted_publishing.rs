//! Trusted publishing: a GitHub Actions workflow deploys monitoring as code without a stored
//! secret. The run asks GitHub for an OpenID Connect token whose audience is this installation,
//! and exchanges it here for a deploy token that lasts fifteen minutes. Administrators decide
//! which repository, workflow file, branch and environment may deploy which projects.
use crate::{
    api_keys::{self, PUBLISHER_TOKEN_PREFIX},
    error::ApiError,
    json::{ApiJson, ApiPath},
    server::{AppState, timestamp},
    users::Principal,
};
use axum::{Extension, Json, extract::State, http::StatusCode};
use jsonwebtoken::{
    Algorithm, DecodingKey, Validation, decode, decode_header,
    jwk::{Jwk, JwkSet},
};
use serde_json::{Value, json};
use sqlx::{Row, postgres::PgRow};
use std::{
    env,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;
use uuid::Uuid;

pub const GITHUB_ISSUER: &str = "https://token.actions.githubusercontent.com";
const TOKEN_MINUTES: i32 = 15;
const LIMIT: i64 = 100;
const KEYS_MAX_AGE: Duration = Duration::from_secs(3600);
/// An unknown key ID refreshes the key set at most this often, so made-up IDs cannot make
/// StillUp hammer GitHub.
const KEYS_MIN_REFRESH: Duration = Duration::from_secs(60);

/// GitHub Actions' token issuer; GitHub Enterprise Server uses `https://HOST/_services/token`.
pub fn issuer_from_env() -> Result<String, String> {
    let issuer = env::var("GITHUB_ACTIONS_ISSUER")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| GITHUB_ISSUER.into())
        .trim_end_matches('/')
        .to_owned();
    let url = url::Url::parse(&issuer).map_err(|_| "GITHUB_ACTIONS_ISSUER must be a valid URL")?;
    if !crate::oidc::allowed_endpoint(&url, url.scheme() == "http") {
        return Err(
            "GITHUB_ACTIONS_ISSUER must use HTTPS, except for loopback development".into(),
        );
    }
    Ok(issuer)
}

/// GitHub's signing keys, fetched through its discovery document and cached.
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
enum KeyError {
    Unknown,
    Unavailable,
}
impl Keys {
    async fn fetch(&self, issuer: &str) -> Result<JwkSet, ()> {
        let local_http = issuer.starts_with("http:");
        let discovery: Value = self
            .client
            .get(format!("{issuer}/.well-known/openid-configuration"))
            .send()
            .await
            .map_err(|_| ())?
            .error_for_status()
            .map_err(|_| ())?
            .json()
            .await
            .map_err(|_| ())?;
        if discovery["issuer"].as_str() != Some(issuer) {
            return Err(());
        }
        let jwks = url::Url::parse(discovery["jwks_uri"].as_str().ok_or(())?).map_err(|_| ())?;
        if !crate::oidc::allowed_endpoint(&jwks, local_http) {
            return Err(());
        }
        self.client
            .get(jwks)
            .send()
            .await
            .map_err(|_| ())?
            .error_for_status()
            .map_err(|_| ())?
            .json()
            .await
            .map_err(|_| ())
    }
    async fn find(&self, issuer: &str, kid: &str) -> Result<Jwk, KeyError> {
        let mut cache = self.cache.lock().await;
        if let Some((fetched, keys)) = cache.as_ref() {
            if fetched.elapsed() < KEYS_MAX_AGE
                && let Some(key) = keys.find(kid)
            {
                return Ok(key.clone());
            }
            if fetched.elapsed() < KEYS_MIN_REFRESH {
                return Err(KeyError::Unknown);
            }
        }
        let keys = self
            .fetch(issuer)
            .await
            .map_err(|_| KeyError::Unavailable)?;
        let key = keys.find(kid).cloned();
        *cache = Some((Instant::now(), keys));
        key.ok_or(KeyError::Unknown)
    }
}

/// The claims of a verified GitHub Actions token that trust rules match.
#[derive(Debug, PartialEq)]
pub struct Claims {
    pub repository: String,
    pub repository_id: String,
    pub repository_owner_id: String,
    /// The workflow file name, from `workflow_ref`.
    pub workflow: String,
    pub git_ref: String,
    pub environment: Option<String>,
}
/// Reads the claims rules depend on from a token whose signature, issuer, audience and
/// lifetime are verified.
pub fn claims(value: &Value) -> Option<Claims> {
    let text = |name: &str| {
        value[name]
            .as_str()
            .filter(|value| !value.is_empty() && value.len() <= 512)
            .map(str::to_owned)
    };
    let repository = text("repository")?;
    // "owner/repo/.github/workflows/deploy.yml@refs/heads/main"
    let workflow_ref = text("workflow_ref")?;
    let (path, _) = workflow_ref.split_once('@')?;
    let prefix = format!("{repository}/.github/workflows/");
    let workflow = path
        .get(..prefix.len())
        .filter(|start| start.eq_ignore_ascii_case(&prefix))
        .and_then(|_| path.get(prefix.len()..))
        .filter(|workflow| !workflow.is_empty() && !workflow.contains('/'))?;
    Some(Claims {
        workflow: workflow.to_owned(),
        repository,
        repository_id: text("repository_id")?,
        repository_owner_id: text("repository_owner_id")?,
        git_ref: text("ref")?,
        environment: text("environment"),
    })
}

/// Verifies a GitHub Actions token's signature, issuer, audience and lifetime.
fn verify(token: &str, key: &Jwk, issuer: &str, audience: &str) -> Option<Claims> {
    let key = DecodingKey::from_jwk(key).ok()?;
    let mut validation = Validation::new(Algorithm::RS256);
    validation.set_issuer(&[issuer]);
    validation.set_audience(&[audience]);
    validation.set_required_spec_claims(&["iss", "aud", "exp", "iat", "sub"]);
    let data = decode::<Value>(token, &key, &validation).ok()?;
    claims(&data.claims)
}

/// A trust rule, as stored.
#[derive(Clone)]
pub struct Rule {
    pub branch: Option<String>,
    pub environment: Option<String>,
    pub repository_id: Option<String>,
    pub repository_owner_id: Option<String>,
}
/// Why a workflow run that matches a rule's repository and workflow may not deploy.
pub fn refusal(rule: &Rule, claims: &Claims) -> Option<String> {
    if let Some(branch) = &rule.branch
        && claims.git_ref != format!("refs/heads/{branch}")
    {
        return Some(format!(
            "This workflow may deploy only from branch {branch}, not {}",
            claims.git_ref
        ));
    }
    if let Some(environment) = &rule.environment
        && !claims
            .environment
            .as_deref()
            .is_some_and(|value| value.eq_ignore_ascii_case(environment))
    {
        return Some(format!(
            "This workflow may deploy only from a job in the {environment} environment"
        ));
    }
    if rule
        .repository_id
        .as_ref()
        .is_some_and(|id| *id != claims.repository_id)
        || rule
            .repository_owner_id
            .as_ref()
            .is_some_and(|id| *id != claims.repository_owner_id)
    {
        return Some(
            "This repository is not the one the trust rule was first used with. Remove the rule and add it again if it was recreated or transferred".into(),
        );
    }
    None
}

fn unauthorized(message: impl Into<String>) -> ApiError {
    ApiError(StatusCode::UNAUTHORIZED, message.into())
}

/// Exchanges a GitHub Actions token for a short-lived deploy token.
pub async fn exchange(
    State(state): State<AppState>,
    ApiJson(input): ApiJson,
) -> Result<Json<Value>, ApiError> {
    let token = input
        .get("token")
        .and_then(Value::as_str)
        .filter(|token| token.len() <= 8192)
        .ok_or_else(|| ApiError::bad("token: Expected a GitHub Actions token"))?;
    let invalid = || unauthorized("The GitHub Actions token is invalid or expired");
    let header = decode_header(token).map_err(|_| invalid())?;
    let kid = header
        .kid
        .as_deref()
        .filter(|_| header.alg == Algorithm::RS256)
        .ok_or_else(invalid)?;
    let issuer = &state.config.github_actions_issuer;
    let key = match state.github_keys.find(issuer, kid).await {
        Ok(key) => key,
        Err(KeyError::Unknown) => return Err(invalid()),
        Err(KeyError::Unavailable) => {
            return Err(ApiError(
                StatusCode::SERVICE_UNAVAILABLE,
                "GitHub cannot be reached to verify this workflow. Try again shortly.".into(),
            ));
        }
    };
    let claims = verify(token, &key, issuer, &state.config.origin).ok_or_else(invalid)?;
    let row = sqlx::query(
        "SELECT * FROM trusted_publishers WHERE lower(repository)=lower($1) AND workflow=$2",
    )
    .bind(&claims.repository)
    .bind(&claims.workflow)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| {
        unauthorized(format!(
            "No trust rule lets {} deploy from workflow {}. Add one under API access in StillUp",
            claims.repository, claims.workflow
        ))
    })?;
    let id: Uuid = row.try_get("id")?;
    let rule = Rule {
        branch: row.try_get("branch")?,
        environment: row.try_get("environment")?,
        repository_id: row.try_get("repository_id")?,
        repository_owner_id: row.try_get("repository_owner_id")?,
    };
    if let Some(reason) = refusal(&rule, &claims) {
        return Err(ApiError(StatusCode::FORBIDDEN, reason));
    }
    let deploy = api_keys::random_token(PUBLISHER_TOKEN_PREFIX);
    let mut transaction = state.pool.begin().await?;
    // Binds GitHub's numeric IDs on first use; a concurrent first use with other IDs fails here.
    let projects = sqlx::query_scalar::<_, Vec<String>>(
        "UPDATE trusted_publishers SET repository_id=COALESCE(repository_id,$2),repository_owner_id=COALESCE(repository_owner_id,$3),last_used_at=now() WHERE id=$1 AND COALESCE(repository_id,$2)=$2 AND COALESCE(repository_owner_id,$3)=$3 RETURNING projects",
    )
    .bind(id)
    .bind(&claims.repository_id)
    .bind(&claims.repository_owner_id)
    .fetch_optional(&mut *transaction)
    .await?
    .ok_or_else(|| {
        ApiError(
            StatusCode::FORBIDDEN,
            "This trust rule changed while the workflow signed in. Run the workflow again".into(),
        )
    })?;
    sqlx::query("DELETE FROM publisher_tokens WHERE expires_at<=now()")
        .execute(&mut *transaction)
        .await?;
    let expires: chrono::DateTime<chrono::Utc> = sqlx::query_scalar(
        "INSERT INTO publisher_tokens(token_hash,publisher_id,expires_at) VALUES($1,$2,now()+make_interval(mins=>$3)) RETURNING expires_at",
    )
    .bind(api_keys::hash(&deploy))
    .bind(id)
    .bind(TOKEN_MINUTES)
    .fetch_one(&mut *transaction)
    .await?;
    transaction.commit().await?;
    tracing::info!(
        repository = claims.repository,
        workflow = claims.workflow,
        "Trusted GitHub workflow signed in"
    );
    Ok(Json(json!({
        "token": deploy,
        "expiresAt": expires.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "projects": projects,
    })))
}

fn publisher(row: &PgRow) -> Result<Value, sqlx::Error> {
    Ok(json!({
        "id": row.try_get::<Uuid, _>("id")?,
        "repository": row.try_get::<String, _>("repository")?,
        "workflow": row.try_get::<String, _>("workflow")?,
        "branch": row.try_get::<Option<String>, _>("branch")?,
        "environment": row.try_get::<Option<String>, _>("environment")?,
        "projects": row.try_get::<Vec<String>, _>("projects")?,
        "linked": row.try_get::<Option<String>, _>("repository_id")?.is_some(),
        "createdBy": row.try_get::<String, _>("created_by")?,
        "createdAt": timestamp(row, "created_at")?,
        "lastUsedAt": timestamp(row, "last_used_at")?,
    }))
}

pub async fn list(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let rows = sqlx::query("SELECT * FROM trusted_publishers ORDER BY lower(repository),workflow")
        .fetch_all(&state.pool)
        .await?;
    let publishers = rows.iter().map(publisher).collect::<Result<Vec<_>, _>>()?;
    Ok(Json(
        json!({"publishers":publishers,"audience":state.config.origin}),
    ))
}

pub fn repository(value: &str) -> Option<String> {
    let (owner, name) = value.trim().split_once('/')?;
    let owner_ok = (1..=39).contains(&owner.len())
        && owner.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-');
    let name_ok = (1..=100).contains(&name.len())
        && !matches!(name, "." | "..")
        && name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.'));
    (owner_ok && name_ok).then(|| format!("{owner}/{name}"))
}
pub fn workflow(value: &str) -> Option<String> {
    let value = value.trim();
    ((1..=255).contains(&value.len())
        && (value.ends_with(".yml") || value.ends_with(".yaml"))
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.')))
    .then(|| value.to_owned())
}
/// An optional name: a branch or environment. Empty means any.
fn optional_name(input: &Value, field: &str) -> Result<Option<String>, ApiError> {
    match input.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => {
            let value = value.trim();
            let value = if field == "branch" {
                value.strip_prefix("refs/heads/").unwrap_or(value)
            } else {
                value
            };
            if value.is_empty() {
                return Ok(None);
            }
            if value.len() > 255 || value.chars().any(|c| c.is_control() || c.is_whitespace()) {
                return Err(ApiError::bad(format!(
                    "{field}: Expected up to 255 characters without spaces"
                )));
            }
            Ok(Some(value.to_owned()))
        }
        _ => Err(ApiError::bad(format!("{field}: Expected a string"))),
    }
}

pub async fn create(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    ApiJson(input): ApiJson,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let repository = input
        .get("repository")
        .and_then(Value::as_str)
        .and_then(repository)
        .ok_or_else(|| ApiError::bad("repository: Enter it as owner/name, e.g. acme/api"))?;
    let workflow = input
        .get("workflow")
        .and_then(Value::as_str)
        .and_then(workflow)
        .ok_or_else(|| {
            ApiError::bad("workflow: Enter the workflow file name, e.g. monitoring.yml")
        })?;
    let branch = optional_name(&input, "branch")?;
    let environment = optional_name(&input, "environment")?;
    let projects = api_keys::projects(input.get("projects"), 20)?;
    if projects.is_empty() {
        return Err(ApiError::bad(
            "projects: Name at least one project this workflow deploys",
        ));
    }
    let created_by = api_keys::actor(&state.pool, &principal).await?;
    let mut transaction = state.pool.begin().await?;
    sqlx::query("LOCK TABLE trusted_publishers IN SHARE ROW EXCLUSIVE MODE")
        .execute(&mut *transaction)
        .await?;
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM trusted_publishers")
        .fetch_one(&mut *transaction)
        .await?;
    if count >= LIMIT {
        return Err(ApiError::conflict(format!(
            "StillUp keeps up to {LIMIT} trusted workflows. Remove unused ones first."
        )));
    }
    let row = sqlx::query(
        "INSERT INTO trusted_publishers(repository,workflow,branch,environment,projects,created_by) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING *",
    )
    .bind(&repository)
    .bind(&workflow)
    .bind(&branch)
    .bind(&environment)
    .bind(&projects)
    .bind(&created_by)
    .fetch_optional(&mut *transaction)
    .await?
    .ok_or_else(|| {
        ApiError::conflict(format!(
            "{repository} already trusts workflow {workflow}. Remove that rule to change it."
        ))
    })?;
    transaction.commit().await?;
    Ok((StatusCode::CREATED, Json(publisher(&row)?)))
}

/// Removing a rule also ends the deploy tokens it issued.
pub async fn remove(
    State(state): State<AppState>,
    ApiPath(value): ApiPath<String>,
) -> Result<StatusCode, ApiError> {
    if !crate::check_config::valid_uuid(&value) {
        return Err(ApiError::bad("id: Invalid UUID"));
    }
    let id = Uuid::parse_str(&value).map_err(|_| ApiError::bad("id: Invalid UUID"))?;
    let removed = sqlx::query("DELETE FROM trusted_publishers WHERE id=$1")
        .bind(id)
        .execute(&state.pool)
        .await?;
    if removed.rows_affected() == 0 {
        return Err(ApiError(
            StatusCode::NOT_FOUND,
            "Trusted workflow not found".into(),
        ));
    }
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn github() -> Value {
        json!({
            "repository": "Acme/API",
            "repository_id": "42",
            "repository_owner_id": "7",
            "workflow_ref": "Acme/API/.github/workflows/monitoring.yml@refs/heads/main",
            "ref": "refs/heads/main",
            "environment": "production",
        })
    }
    #[test]
    fn claims_name_the_workflow_file() {
        assert_eq!(
            claims(&github()),
            Some(Claims {
                repository: "Acme/API".into(),
                repository_id: "42".into(),
                repository_owner_id: "7".into(),
                workflow: "monitoring.yml".into(),
                git_ref: "refs/heads/main".into(),
                environment: Some("production".into()),
            })
        );
        let mut value = github();
        value["workflow_ref"] = json!("acme/api/.github/workflows/monitoring.yml@refs/heads/x");
        assert_eq!(claims(&value).unwrap().workflow, "monitoring.yml");
        for workflow_ref in [
            "Other/API/.github/workflows/monitoring.yml@refs/heads/main",
            "Acme/API/.github/workflows/@refs/heads/main",
            "Acme/API/.github/workflows/a/b.yml@refs/heads/main",
            "Acme/API/.github/workflows/monitoring.yml",
            "Acme/API",
        ] {
            let mut value = github();
            value["workflow_ref"] = json!(workflow_ref);
            assert_eq!(claims(&value), None, "{workflow_ref}");
        }
        for missing in ["repository", "repository_id", "repository_owner_id", "ref"] {
            let mut value = github();
            value.as_object_mut().unwrap().remove(missing);
            assert_eq!(claims(&value), None, "{missing}");
        }
        let mut value = github();
        value.as_object_mut().unwrap().remove("environment");
        assert_eq!(claims(&value).unwrap().environment, None);
    }
    #[test]
    fn rules_limit_branch_environment_and_repository_identity() {
        let claims = claims(&github()).unwrap();
        let open = Rule {
            branch: None,
            environment: None,
            repository_id: None,
            repository_owner_id: None,
        };
        assert_eq!(refusal(&open, &claims), None);
        let strict = Rule {
            branch: Some("main".into()),
            environment: Some("Production".into()),
            repository_id: Some("42".into()),
            repository_owner_id: Some("7".into()),
        };
        assert_eq!(refusal(&strict, &claims), None);
        for rule in [
            Rule {
                branch: Some("release".into()),
                ..strict.clone()
            },
            Rule {
                environment: Some("staging".into()),
                ..strict.clone()
            },
            Rule {
                repository_id: Some("43".into()),
                ..strict.clone()
            },
            Rule {
                repository_owner_id: Some("8".into()),
                ..strict.clone()
            },
        ] {
            assert!(refusal(&rule, &claims).is_some());
        }
        let mut pull_request = claims;
        pull_request.git_ref = "refs/pull/1/merge".into();
        pull_request.environment = None;
        assert!(refusal(&strict, &pull_request).is_some());
    }
    #[test]
    fn repositories_and_workflows_are_validated() {
        assert_eq!(repository(" acme/api.v2 "), Some("acme/api.v2".into()));
        for invalid in ["acme", "acme/", "/api", "acme/api/x", "acme/..", "ac me/api"] {
            assert_eq!(repository(invalid), None, "{invalid}");
        }
        assert_eq!(workflow("monitoring.yml"), Some("monitoring.yml".into()));
        assert_eq!(workflow("deploy.yaml"), Some("deploy.yaml".into()));
        for invalid in ["monitoring", ".github/workflows/x.yml", "a b.yml", ""] {
            assert_eq!(workflow(invalid), None, "{invalid}");
        }
        assert_eq!(
            optional_name(&json!({"branch":"refs/heads/main"}), "branch").unwrap(),
            Some("main".into())
        );
        assert_eq!(
            optional_name(&json!({"branch":" "}), "branch").unwrap(),
            None
        );
        assert!(optional_name(&json!({"environment":"a b"}), "environment").is_err());
    }
}
