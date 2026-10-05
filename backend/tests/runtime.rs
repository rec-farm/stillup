use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode, header},
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sqlx::{PgPool, postgres::PgPoolOptions};
use stillup_api::{
    config::Config,
    database,
    server::{AppState, router},
    web::WebConfig,
};
use tower::ServiceExt;

// Explicitly ignored without PostgreSQL: CI and local integration runs must opt in.
// Every test uses a uniquely named schema; existing workspace tables are untouched.
struct Fixture {
    pool: PgPool,
    admin: PgPool,
    schema: String,
    dir: tempfile::TempDir,
}
impl Fixture {
    async fn empty() -> Self {
        let url = std::env::var("TEST_DATABASE_URL").expect("TEST_DATABASE_URL is required");
        let admin = PgPoolOptions::new()
            .max_connections(2)
            .connect(&url)
            .await
            .unwrap();
        let schema = format!("rust_test_{}", uuid::Uuid::new_v4().simple());
        sqlx::query(&format!("CREATE SCHEMA {schema}"))
            .execute(&admin)
            .await
            .unwrap();
        let search = format!("SET search_path TO {schema}");
        let pool = PgPoolOptions::new()
            .max_connections(5)
            .after_connect(move |connection, _| {
                let search = search.clone();
                Box::pin(async move {
                    sqlx::query(&search).execute(connection).await?;
                    Ok(())
                })
            })
            .connect(&url)
            .await
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("index.html"),
            "<html data-product=\"stillup\"><body>SPA</body></html>",
        )
        .unwrap();
        Self {
            pool,
            admin,
            schema,
            dir,
        }
    }
    async fn new() -> Self {
        let fixture = Self::empty().await;
        database::migrate(&fixture.pool).await.unwrap();
        fixture
    }
    fn app(&self) -> Router {
        self.app_with_oidc(Default::default())
    }
    fn app_with_oidc(&self, oidc: stillup_api::oidc::OidcConfig) -> Router {
        router(AppState::new(
            self.pool.clone(),
            Config {
                oidc,
                database_url: String::new(),
                admin_token: "01234567890123456789012345678901".into(),
                origin: "https://dashboard.example.com".into(),
                bind: "127.0.0.1:0".into(),
                web: WebConfig {
                    client_dir: self.dir.path().into(),
                    status_domains: "status.example.com".into(),
                },
            },
        ))
    }
    async fn close(self) {
        self.pool.close().await;
        sqlx::query(&format!("DROP SCHEMA {} CASCADE", self.schema))
            .execute(&self.admin)
            .await
            .unwrap();
        self.admin.close().await;
    }
}
async fn request(
    app: Router,
    method: &str,
    path: &str,
    input: Value,
    auth: bool,
) -> (StatusCode, Value, axum::http::HeaderMap) {
    let mut builder = Request::builder()
        .method(method)
        .uri(path)
        .header(header::HOST, "dashboard.example.com");
    if auth {
        builder = builder.header(
            header::AUTHORIZATION,
            "Bearer 01234567890123456789012345678901",
        );
    }
    let body = if input.is_null() {
        Body::empty()
    } else {
        builder = builder.header(header::CONTENT_TYPE, "application/json");
        Body::from(input.to_string())
    };
    let response = app.oneshot(builder.body(body).unwrap()).await.unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let json = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, json, headers)
}
#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL"]
async fn native_sessions_csrf_and_rate_limits() {
    let fixture = Fixture::new().await;
    let app = fixture.app();
    assert_eq!(
        request(app.clone(), "GET", "/api/v1/dashboard", Value::Null, false)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    let (status, _, headers) = request(
        app.clone(),
        "POST",
        "/api/v1/session",
        json!({"token":"01234567890123456789012345678901"}),
        false,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let cookie = headers
        .get_all(header::SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .find(|v| v.starts_with("stillup_session="))
        .unwrap();
    assert!(cookie.contains("HttpOnly"));
    assert!(cookie.contains("SameSite=Strict"));
    assert!(cookie.contains("Secure"));
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v1/dashboard")
                .header(header::COOKIE, cookie.split(';').next().unwrap())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri("/api/v1/session")
                .header(header::ORIGIN, "https://evil.example.com")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    for _ in 0..4 {
        assert_eq!(
            request(
                app.clone(),
                "POST",
                "/v1/session",
                json!({"token":"wrong"}),
                false
            )
            .await
            .0,
            StatusCode::UNAUTHORIZED
        );
    }
    assert_eq!(
        request(app, "POST", "/v1/session", json!({"token":"wrong"}), false)
            .await
            .0,
        StatusCode::TOO_MANY_REQUESTS
    );
    fixture.close().await;
}
#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL"]
async fn migrations_preserve_data_and_workspace_revisions_are_atomic() {
    let fixture = Fixture::new().await;
    let app = fixture.app();
    let (status, data, _) = request(
        app.clone(),
        "GET",
        "/v1/public/workspace",
        Value::Null,
        false,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(data["name"], "StillUp");
    let input = json!({"config":{"name":" QA "},"expectedRevision":0});
    let (a, b) = tokio::join!(
        request(app.clone(), "PUT", "/v1/workspace", input.clone(), true),
        request(app.clone(), "PUT", "/v1/workspace", input, true)
    );
    assert!(
        (a.0 == StatusCode::OK && b.0 == StatusCode::CONFLICT)
            || (b.0 == StatusCode::OK && a.0 == StatusCode::CONFLICT)
    );
    database::migrate(&fixture.pool).await.unwrap();
    let (_, data, _) = request(app.clone(), "GET", "/v1/workspace", Value::Null, true).await;
    assert_eq!(data["revision"], 1);
    assert_eq!(data["settings"]["name"], "QA");
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM stillup_migrations")
        .fetch_one(&fixture.pool)
        .await
        .unwrap();
    assert_eq!(count, 8);
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/workspace")
                .header(header::HOST, "status.example.com")
                .header(
                    header::AUTHORIZATION,
                    "Bearer 01234567890123456789012345678901",
                )
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    fixture.close().await;
}
#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL"]
async fn checks_preserve_history_and_fence_execution_when_paused_or_archived() {
    let fixture = Fixture::new().await;
    let app = fixture.app();
    let id: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO monitors(config,status,last_observed_at) VALUES($1,'down',now()) RETURNING id",
    )
    .bind(json!({"name":"Fixture","intervalSeconds":60}))
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO check_revisions(monitor_id,revision,config) SELECT id,config_revision,config FROM monitors WHERE id=$1").bind(id).execute(&fixture.pool).await.unwrap();
    let (_, data, _) = request(app.clone(), "GET", "/v1/dashboard", Value::Null, true).await;
    assert_eq!(data["monitors"][0]["health"], "down");
    assert!(
        data["monitors"][0]["createdAt"]
            .as_str()
            .unwrap()
            .ends_with('Z')
    );
    let path = format!("/v1/checks/{id}");
    assert_eq!(
        request(
            app.clone(),
            "PATCH",
            &path,
            json!({"enabled":false,"expectedRevision":2}),
            true
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let (_, data, _) = request(
        app.clone(),
        "PATCH",
        &path,
        json!({"enabled":false,"expectedRevision":1}),
        true,
    )
    .await;
    assert_eq!(data["health"], "paused");
    let epoch: i32 = sqlx::query_scalar("SELECT execution_epoch FROM monitors WHERE id=$1")
        .bind(id)
        .fetch_one(&fixture.pool)
        .await
        .unwrap();
    assert_eq!(epoch, 2);
    let (_, data, _) = request(
        app.clone(),
        "POST",
        &format!("{path}/archive"),
        json!({"expectedRevision":1}),
        true,
    )
    .await;
    assert_eq!(data["health"], "archived");
    let (_, data, _) = request(
        app.clone(),
        "POST",
        &format!("{path}/restore"),
        json!({"expectedRevision":1}),
        true,
    )
    .await;
    assert_eq!(data["health"], "paused");
    let (_, data, _) = request(app.clone(), "PATCH", &path, json!({"enabled":true}), true).await;
    assert_eq!(data["health"], "unknown");
    assert!(data["lastObservedAt"].is_null());
    let status: String = sqlx::query_scalar("SELECT status FROM monitors WHERE id=$1")
        .bind(id)
        .fetch_one(&fixture.pool)
        .await
        .unwrap();
    assert_eq!(status, "down");
    let (_, data, _) = request(app, "GET", &format!("{path}/revisions"), Value::Null, true).await;
    assert_eq!(data["revisions"][0]["revision"], 1);
    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL"]
async fn upgrade_existing_initial_schema_keeps_monitor_ids_and_backfills_history() {
    let fixture = Fixture::empty().await;
    sqlx::raw_sql(include_str!("../../packages/db/migrations/001_initial.sql"))
        .execute(&fixture.pool)
        .await
        .unwrap();
    sqlx::raw_sql("CREATE TABLE stillup_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()); INSERT INTO stillup_migrations(name) VALUES('001_initial.sql')").execute(&fixture.pool).await.unwrap();
    let config = json!({"name":"Original monitor", "intervalSeconds":60});
    let id: uuid::Uuid = sqlx::query_scalar("INSERT INTO monitors(config) VALUES($1) RETURNING id")
        .bind(&config)
        .fetch_one(&fixture.pool)
        .await
        .unwrap();
    database::migrate(&fixture.pool).await.unwrap();
    let stored: Value = sqlx::query_scalar("SELECT config FROM monitors WHERE id=$1")
        .bind(id)
        .fetch_one(&fixture.pool)
        .await
        .unwrap();
    assert_eq!(stored, config);
    let revision: Value =
        sqlx::query_scalar("SELECT config FROM check_revisions WHERE monitor_id=$1 AND revision=1")
            .bind(id)
            .fetch_one(&fixture.pool)
            .await
            .unwrap();
    assert_eq!(revision, config);
    database::migrate(&fixture.pool).await.unwrap();
    fixture.close().await;
}
#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL"]
async fn migration_failure_rolls_back_schema_and_ledger_changes() {
    let fixture = Fixture::empty().await;
    sqlx::query("CREATE TABLE runs (fixture integer)")
        .execute(&fixture.pool)
        .await
        .unwrap();
    assert!(database::migrate(&fixture.pool).await.is_err());
    let count:i64=sqlx::query_scalar("SELECT count(*) FROM information_schema.tables WHERE table_schema=current_schema() AND table_name IN ('monitors','stillup_migrations')").fetch_one(&fixture.pool).await.unwrap();
    assert_eq!(count, 0);
    sqlx::query("DROP TABLE runs")
        .execute(&fixture.pool)
        .await
        .unwrap();
    database::migrate(&fixture.pool).await.unwrap();
    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL"]
async fn malformed_and_oversized_json_keep_the_api_error_contract() {
    let fixture = Fixture::new().await;
    for (body, status) in [
        ("{".to_string(), StatusCode::BAD_REQUEST),
        (
            format!("{{\"config\":\"{}\"}}", "x".repeat(100001)),
            StatusCode::PAYLOAD_TOO_LARGE,
        ),
    ] {
        let response = fixture
            .app()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/v1/workspace")
                    .header(header::CONTENT_TYPE, "application/json")
                    .header(
                        header::AUTHORIZATION,
                        "Bearer 01234567890123456789012345678901",
                    )
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), status);
        let data: Value =
            serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert!(data["error"].is_string());
    }
    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL"]
async fn native_http_listener_serves_health_and_shuts_down_gracefully() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let fixture = Fixture::new().await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = fixture.app();
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .with_graceful_shutdown(async {
            stopped.await.ok();
        })
        .await
        .unwrap();
    });
    let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
    stream
        .write_all(
            b"GET /health HTTP/1.1\r\nHost: dashboard.example.com\r\nConnection: close\r\n\r\n",
        )
        .await
        .unwrap();
    let mut response = Vec::new();
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        stream.read_to_end(&mut response),
    )
    .await
    .unwrap()
    .unwrap();
    let response = String::from_utf8(response).unwrap();
    assert!(response.starts_with("HTTP/1.1 200"));
    assert!(response.contains("cache-control: no-store"));
    assert!(response.ends_with("{\"status\":\"ok\"}"));
    stop.send(()).unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), server)
        .await
        .unwrap()
        .unwrap();
    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL"]
async fn oidc_pkce_signed_tokens_callback_and_logout() {
    use axum::{
        Json,
        extract::{Form, State},
        routing::{get, post},
    };
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    use rsa::{
        pkcs1v15::SigningKey,
        pkcs8::DecodePrivateKey,
        signature::{SignatureEncoding, Signer},
    };
    use sha2::{Digest, Sha256};
    use std::{
        collections::HashMap,
        sync::{Arc, Mutex},
    };
    #[derive(Clone)]
    struct Provider {
        issuer: String,
        flow: Arc<Mutex<(String, String, bool)>>,
        mode: Arc<Mutex<String>>,
    }
    async fn metadata(State(p): State<Provider>) -> Json<Value> {
        Json(
            json!({"issuer":p.issuer,"authorization_endpoint":format!("{}/authorize",p.issuer),"token_endpoint":format!("{}/token",p.issuer),"jwks_uri":format!("{}/jwks",p.issuer),"end_session_endpoint":format!("{}/logout",p.issuer),"response_types_supported":["code"],"subject_types_supported":["public"],"id_token_signing_alg_values_supported":["RS256"]}),
        )
    }
    async fn token(
        State(p): State<Provider>,
        Form(form): Form<HashMap<String, String>>,
    ) -> (StatusCode, Json<Value>) {
        let mut flow = p.flow.lock().unwrap();
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(
            form.get("code_verifier")
                .map(String::as_str)
                .unwrap_or("")
                .as_bytes(),
        ));
        if flow.2
            || form.get("code").map(String::as_str) != Some("fixture-code")
            || challenge != flow.1
        {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"error":"invalid_grant"})),
            );
        }
        flow.2 = true;
        let mode = p.mode.lock().unwrap().clone();
        let header = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&json!({"alg":"RS256","kid":if mode=="rotate" { "rotated" } else { "fixture" },"typ":"JWT"})).unwrap());
        let now = chrono::Utc::now().timestamp();
        let mut claims = json!({"iss":p.issuer,"aud":"fixture-client","sub":"administrator","iat":now,"exp":now+300,"nonce":flow.0});
        match mode.as_str() {
            "nonce" => claims["nonce"] = json!("wrong-nonce"),
            "audience" => claims["aud"] = json!("other-client"),
            "issuer" => claims["iss"] = json!("https://other.example.com"),
            "expired" => claims["exp"] = json!(now - 3600),
            "access-hash" => claims["at_hash"] = json!("invalid"),
            _ => (),
        }
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap());
        let message = format!("{header}.{payload}");
        // This checked-in key is only a disposable local test fixture.
        let key =
            rsa::RsaPrivateKey::from_pkcs8_pem(include_str!("fixtures/oidc-test-key.pem")).unwrap();
        let signature = SigningKey::<Sha256>::new(key).sign(message.as_bytes());
        let mut signature = signature.to_vec();
        if mode == "signature" {
            signature[0] ^= 1;
        }
        let jwt = format!("{message}.{}", URL_SAFE_NO_PAD.encode(signature));
        (
            StatusCode::OK,
            Json(
                json!({"access_token":"fixture-access","token_type":"Bearer","expires_in":300,"id_token":jwt}),
            ),
        )
    }
    let fixture = Fixture::new().await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let issuer = format!("http://{}", listener.local_addr().unwrap());
    let provider = Provider {
        issuer: issuer.clone(),
        flow: Arc::new(Mutex::new((String::new(), String::new(), false))),
        mode: Arc::new(Mutex::new(String::new())),
    };
    let provider_app = Router::new()
        .route("/.well-known/openid-configuration", get(metadata))
        .route(
            "/jwks",
            get(|State(p): State<Provider>| async move {
                let mut keys: Value =
                    serde_json::from_str(include_str!("fixtures/oidc-test-jwks.json")).unwrap();
                if *p.mode.lock().unwrap() == "rotate" {
                    keys["keys"][0]["kid"] = json!("rotated");
                }
                Json(keys)
            }),
        )
        .route("/token", post(token))
        .with_state(provider.clone());
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        axum::serve(listener, provider_app)
            .with_graceful_shutdown(async {
                stopped.await.ok();
            })
            .await
            .unwrap();
    });
    let app = fixture.app_with_oidc(stillup_api::oidc::OidcConfig {
        issuer: issuer.clone(),
        client_id: "fixture-client".into(),
        ..Default::default()
    });
    let (status, data, _) = request(
        app.clone(),
        "GET",
        "/api/v1/auth/config",
        Value::Null,
        false,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(data["oidc"], true);
    let (status, _, headers) = request(
        app.clone(),
        "GET",
        "/api/v1/auth/oidc/start?next=/docs",
        Value::Null,
        false,
    )
    .await;
    assert_eq!(status, StatusCode::FOUND);
    let authorization = url::Url::parse(headers[header::LOCATION].to_str().unwrap()).unwrap();
    let params: HashMap<_, _> = authorization.query_pairs().into_owned().collect();
    assert_eq!(params["code_challenge_method"], "S256");
    assert_eq!(
        params["redirect_uri"],
        "https://dashboard.example.com/api/v1/auth/oidc/callback"
    );
    *provider.flow.lock().unwrap() = (
        params["nonce"].clone(),
        params["code_challenge"].clone(),
        false,
    );
    let cookie = headers[header::SET_COOKIE]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap();
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/api/v1/auth/oidc/callback?code=fixture-code&state={}",
                    params["state"]
                ))
                .header(header::COOKIE, cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FOUND);
    assert_eq!(
        response.headers()[header::LOCATION],
        "https://dashboard.example.com/docs"
    );
    let cookies: Vec<_> = response
        .headers()
        .get_all(header::SET_COOKIE)
        .iter()
        .map(|v| v.to_str().unwrap().split(';').next().unwrap().to_string())
        .collect();
    assert!(cookies.iter().any(|v| v.starts_with("stillup_session=")));
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri("/api/v1/session")
                .header(header::COOKIE, cookies.join("; "))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let data: Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    let logout = url::Url::parse(data["logoutUrl"].as_str().unwrap()).unwrap();
    assert_eq!(logout.path(), "/logout");
    let params: HashMap<_, _> = logout.query_pairs().into_owned().collect();
    assert_eq!(
        params["post_logout_redirect_uri"],
        "https://dashboard.example.com/login"
    );
    assert!(params.contains_key("id_token_hint"));
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/auth/oidc/callback?code=fixture-code&state=wrong")
                .header(header::COOKIE, cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        response.headers()[header::LOCATION],
        "https://dashboard.example.com/login?error=oidc_failed"
    );
    let (status, _, headers) = request(
        app.clone(),
        "GET",
        "/v1/auth/oidc/callback?code=missing",
        Value::Null,
        false,
    )
    .await;
    assert_eq!(status, StatusCode::FOUND);
    assert!(
        headers[header::LOCATION]
            .to_str()
            .unwrap()
            .ends_with("oidc_expired")
    );

    for mode in [
        "nonce",
        "audience",
        "issuer",
        "expired",
        "signature",
        "access-hash",
        "rotate",
    ] {
        *provider.mode.lock().unwrap() = mode.into();
        let (status, _, headers) = request(
            app.clone(),
            "GET",
            "/api/v1/auth/oidc/start",
            Value::Null,
            false,
        )
        .await;
        assert_eq!(status, StatusCode::FOUND);
        let authorization = url::Url::parse(headers[header::LOCATION].to_str().unwrap()).unwrap();
        let params: HashMap<_, _> = authorization.query_pairs().into_owned().collect();
        *provider.flow.lock().unwrap() = (
            params["nonce"].clone(),
            params["code_challenge"].clone(),
            false,
        );
        let cookie = headers[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap();
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/api/v1/auth/oidc/callback?code=fixture-code&state={}",
                        params["state"]
                    ))
                    .header(header::COOKIE, cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FOUND);
        if mode == "rotate" {
            assert_eq!(
                response.headers()[header::LOCATION],
                "https://dashboard.example.com/"
            );
            assert!(
                response
                    .headers()
                    .get_all(header::SET_COOKIE)
                    .iter()
                    .any(|v| v.to_str().unwrap().starts_with("stillup_session="))
            );
        } else {
            assert_eq!(
                response.headers()[header::LOCATION],
                "https://dashboard.example.com/login?error=oidc_failed",
                "mode: {mode}"
            );
            assert!(
                !response
                    .headers()
                    .get_all(header::SET_COOKIE)
                    .iter()
                    .any(|v| v.to_str().unwrap().starts_with("stillup_session=")),
                "mode: {mode}"
            );
        }
    }
    stop.send(()).unwrap();
    server.await.unwrap();
    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL"]
async fn disabled_or_unavailable_oidc_returns_existing_login_errors() {
    let fixture = Fixture::new().await;
    let app = fixture.app();
    let (status, data, _) =
        request(app.clone(), "GET", "/v1/auth/config", Value::Null, false).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(data["oidc"], false);
    let (status, _, headers) = request(app, "GET", "/v1/auth/oidc/start", Value::Null, false).await;
    assert_eq!(status, StatusCode::FOUND);
    assert!(
        headers[header::LOCATION]
            .to_str()
            .unwrap()
            .ends_with("oidc_disabled")
    );
    let app = fixture.app_with_oidc(stillup_api::oidc::OidcConfig {
        issuer: "http://127.0.0.1:0".into(),
        client_id: "fixture".into(),
        ..Default::default()
    });
    let (status, _, headers) = request(app, "GET", "/v1/auth/oidc/start", Value::Null, false).await;
    assert_eq!(status, StatusCode::FOUND);
    assert!(
        headers[header::LOCATION]
            .to_str()
            .unwrap()
            .ends_with("oidc_unavailable")
    );
    fixture.close().await;
}
