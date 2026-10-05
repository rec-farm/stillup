use crate::{auth, config::Config, error::ApiError, health, web, workspace};
use crate::{checks, json::ApiJson};
use axum::{
    Json, Router,
    extract::{ConnectInfo, DefaultBodyLimit, Request, State},
    http::{StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{Value, json};
use sqlx::{PgPool, Row, postgres::PgRow};
use std::{
    collections::HashMap,
    net::{IpAddr, SocketAddr},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

type Buckets = HashMap<(IpAddr, &'static str), (Instant, u32)>;
#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    pub config: Config,
    pub oidc: crate::oidc::Runtime,
    limits: Arc<Mutex<Buckets>>,
}
impl AppState {
    pub fn new(pool: PgPool, config: Config) -> Self {
        Self {
            pool,
            config,
            oidc: Default::default(),
            limits: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

pub fn router(state: AppState) -> Router {
    let api = Router::new()
        .route("/health", get(health_check))
        .route("/v1/session", post(sign_in).delete(sign_out))
        .route("/v1/auth/config", get(crate::oidc::config))
        .route("/v1/auth/oidc/start", get(crate::oidc::start))
        .route("/v1/auth/oidc/callback", get(crate::oidc::callback))
        .route("/v1/dashboard", get(dashboard))
        .route(
            "/v1/checks/{id}",
            get(checks::read).patch(checks::set_enabled),
        )
        .route("/v1/checks/{id}/runs", get(checks::runs))
        .route("/v1/checks/{id}/revisions", get(checks::revisions))
        .route(
            "/v1/checks/{id}/revisions/{revision}",
            get(checks::read_revision),
        )
        .route("/v1/checks/{id}/archive", post(checks::archive))
        .route("/v1/checks/{id}/restore", post(checks::restore))
        .route("/v1/public/workspace", get(public_workspace))
        .route("/v1/workspace", get(read_workspace).put(save_workspace))
        .route_layer(middleware::from_fn_with_state(state.clone(), protect))
        .layer(DefaultBodyLimit::max(100_000))
        .with_state(state.clone());
    // Both the SDK's direct /v1 URLs and the browser's /api/v1 URLs use one native router.
    Router::new()
        .merge(api.clone())
        .nest("/api", api)
        .merge(web::routes(state.config.web.clone()))
        .layer(middleware::from_fn_with_state(
            state.config.web.clone(),
            web::headers_and_public_host,
        ))
}

pub fn cookie<'a>(headers: &'a axum::http::HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .find_map(|entry| {
            let (key, value) = entry.trim().split_once('=')?;
            (key == name).then_some(value)
        })
}
fn now_ms() -> u64 {
    Utc::now().timestamp_millis().max(0) as u64
}

async fn protect(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let path = request
        .uri()
        .path()
        .strip_prefix("/api")
        .unwrap_or(request.uri().path());
    let method = request.method().as_str();
    let ip = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|info| info.0.ip())
        .unwrap_or(IpAddr::from([127, 0, 0, 1]));
    {
        let mut buckets = state
            .limits
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let now = Instant::now();
        buckets.retain(|_, (start, _)| now.duration_since(*start) < Duration::from_secs(60));
        let signin = path == "/v1/session" && method == "POST";
        let oidc = path.starts_with("/v1/auth/");
        let categories: &[(&str, u32)] = if signin {
            &[("global", 120), ("sign-in", 5)]
        } else if oidc {
            &[("global", 120), ("oidc", 20)]
        } else {
            &[("global", 120)]
        };
        for &(category, limit) in categories {
            if buckets.len() >= 10_000 && !buckets.contains_key(&(ip, category)) {
                return ApiError(
                    StatusCode::TOO_MANY_REQUESTS,
                    "Too many requests. Try again shortly.".into(),
                )
                .into_response();
            }
            let (_, count) = buckets.entry((ip, category)).or_insert((now, 0));
            *count += 1;
            if *count > limit {
                let mut response = ApiError(
                    StatusCode::TOO_MANY_REQUESTS,
                    "Too many requests. Try again shortly.".into(),
                )
                .into_response();
                response
                    .headers_mut()
                    .insert(header::RETRY_AFTER, "60".parse().unwrap());
                return response;
            }
        }
    }
    if !matches!(method, "GET" | "HEAD" | "OPTIONS") {
        if let Some(origin) = request.headers().get(header::ORIGIN) {
            if origin.to_str().ok() != Some(state.config.origin.as_str()) {
                return ApiError(
                    StatusCode::FORBIDDEN,
                    "Request origin is not allowed".into(),
                )
                .into_response();
            }
        } else if request
            .headers()
            .get("sec-fetch-site")
            .is_some_and(|value| value == "cross-site")
        {
            return ApiError(
                StatusCode::FORBIDDEN,
                "Cross-site request is not allowed".into(),
            )
            .into_response();
        }
    }
    let public = (matches!(
        path,
        "/v1/auth/config" | "/v1/auth/oidc/start" | "/v1/auth/oidc/callback"
    ) && matches!(method, "GET" | "HEAD"))
        || (path == "/health" && matches!(method, "GET" | "HEAD"))
        || (path == "/v1/session" && matches!(method, "POST" | "DELETE"))
        || (path == "/v1/public/workspace" && matches!(method, "GET" | "HEAD"));
    if !public {
        let bearer = request
            .headers()
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "));
        let session = cookie(request.headers(), "stillup_session");
        if !bearer.is_some_and(|value| auth::token_matches(value, &state.config.admin_token))
            && !session.is_some_and(|value| {
                auth::valid_session(value, &state.config.admin_token, now_ms())
            })
        {
            return ApiError(
                StatusCode::UNAUTHORIZED,
                "Sign in to manage your checks".into(),
            )
            .into_response();
        }
    }
    next.run(request).await
}

async fn health_check(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    sqlx::query("SELECT 1").execute(&state.pool).await?;
    Ok(Json(json!({"status":"ok"})))
}
async fn sign_in(
    State(state): State<AppState>,
    ApiJson(input): ApiJson,
) -> Result<Response, ApiError> {
    let token = input
        .get("token")
        .and_then(Value::as_str)
        .filter(|value| value.encode_utf16().count() <= 1024)
        .ok_or_else(|| ApiError::bad("token: Expected a string of at most 1024 characters"))?;
    if !auth::token_matches(token, &state.config.admin_token) {
        return Err(ApiError(
            StatusCode::UNAUTHORIZED,
            "The administrator token is incorrect".into(),
        ));
    }
    let secure = if state.config.origin.starts_with("https:") {
        "; Secure"
    } else {
        ""
    };
    let value = auth::session_value(now_ms() + 86_400_000, &state.config.admin_token);
    let mut response = Json(json!({"ok":true})).into_response();
    response.headers_mut().append(
        header::SET_COOKIE,
        format!(
            "stillup_session={value}; Path=/; Max-Age=86400; HttpOnly; SameSite=Strict{secure}"
        )
        .parse()
        .unwrap(),
    );
    response.headers_mut().append(
        header::SET_COOKIE,
        "stillup_oidc_idt=; Path=/; Max-Age=0".parse().unwrap(),
    );
    Ok(response)
}
async fn sign_out(State(state): State<AppState>, request: Request) -> Response {
    let token = cookie(request.headers(), "stillup_oidc_idt").map(str::to_owned);
    drop(request);
    let logout = crate::oidc::logout(&state, token).await;
    let mut data = json!({"ok":true});
    if let Some(url) = logout {
        data["logoutUrl"] = json!(url);
    }
    let mut response = Json(data).into_response();
    for name in ["stillup_session", "stillup_oidc_idt"] {
        response.headers_mut().append(
            header::SET_COOKIE,
            format!("{name}=; Path=/; Max-Age=0").parse().unwrap(),
        );
    }
    response
}
async fn public_workspace(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        workspace::read(&state.pool).await?["settings"].clone(),
    ))
}
async fn read_workspace(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    Ok(Json(workspace::read(&state.pool).await?))
}
async fn save_workspace(
    State(state): State<AppState>,
    ApiJson(input): ApiJson,
) -> Result<Json<Value>, ApiError> {
    let expected = input
        .get("expectedRevision")
        .and_then(Value::as_i64)
        .filter(|v| *v >= 0 && *v <= i32::MAX as i64)
        .ok_or_else(|| ApiError::bad("expectedRevision: Expected a nonnegative integer"))?;
    let config = input
        .get("config")
        .ok_or_else(|| ApiError::bad("config: Required"))?;
    Ok(Json(
        workspace::save(&state.pool, config, expected as i32).await?,
    ))
}
pub(crate) fn timestamp(row: &PgRow, name: &str) -> Result<Value, sqlx::Error> {
    Ok(row
        .try_get::<Option<DateTime<Utc>>, _>(name)?
        .map(|date| Value::String(date.to_rfc3339_opts(SecondsFormat::Millis, true)))
        .unwrap_or(Value::Null))
}
pub fn monitor(row: &PgRow) -> Result<Value, sqlx::Error> {
    let config: Value = row.try_get("config")?;
    let archived = timestamp(row, "archived_at")?;
    let project: Option<String> = row.try_get("code_project")?;
    let code_key: Option<String> = row.try_get("code_key")?;
    let status: String = row.try_get("status")?;
    let health = if !archived.is_null() {
        "archived"
    } else {
        health::visible(
            &status,
            row.try_get("enabled")?,
            row.try_get("last_observed_at")?,
            config["intervalSeconds"].as_i64().unwrap_or(60),
            Utc::now(),
        )
    };
    Ok(json!({
        "id": row.try_get::<uuid::Uuid,_>("id")?, "config": config,
        "codeOwnership": project.map(|project| json!({"project":project,"id":code_key})),
        "configRevision":row.try_get::<i32,_>("config_revision")?, "archivedAt": archived,
        "enabled":row.try_get::<bool,_>("enabled")?, "health":health,
        "lastRunAt":timestamp(row,"last_run_at")?, "lastObservedAt":timestamp(row,"last_observed_at")?,
        "lastDurationMs":row.try_get::<Option<i32>,_>("last_duration_ms")?, "lastOutcome":row.try_get::<Option<String>,_>("last_outcome")?,
        "createdAt":timestamp(row,"created_at")?,
    }))
}
async fn dashboard(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let (monitors, incidents, heartbeat, enabled) = tokio::try_join!(
        sqlx::query("SELECT * FROM monitors ORDER BY created_at DESC").fetch_all(&state.pool),
        sqlx::query("SELECT * FROM incidents ORDER BY opened_at DESC LIMIT 50")
            .fetch_all(&state.pool),
        sqlx::query_scalar::<_, Option<DateTime<Utc>>>("SELECT max(seen_at) FROM worker_health")
            .fetch_one(&state.pool),
        sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM notification_channels WHERE enabled)"
        )
        .fetch_one(&state.pool),
    )?;
    let monitors = monitors
        .iter()
        .map(monitor)
        .collect::<Result<Vec<_>, _>>()?;
    let incidents = incidents.iter().map(|row| -> Result<Value, sqlx::Error> {
        Ok(json!({"id":row.try_get::<uuid::Uuid,_>("id")?,"monitorId":row.try_get::<uuid::Uuid,_>("monitor_id")?,"name":row.try_get::<String,_>("name")?,"openedAt":timestamp(row,"opened_at")?,"resolvedAt":timestamp(row,"resolved_at")?}))
    }).collect::<Result<Vec<_>,_>>()?;
    Ok(Json(
        json!({"monitors":monitors,"incidents":incidents,"workerAt":heartbeat.map(|date|date.to_rfc3339_opts(SecondsFormat::Millis,true)),"notificationsEnabled":enabled}),
    ))
}
