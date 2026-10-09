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
        let pool = database::pool_options(5)
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
            "<html data-product=\"stillup\"><head><title>StillUp</title><meta name=\"description\" content=\"Default\" /><link rel=\"icon\" href=\"/brand/stillup-favicon.svg\" /></head><body>SPA</body></html>",
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
        self.app_configure(|config| config.oidc = oidc)
    }
    fn app_configure(&self, configure: impl FnOnce(&mut Config)) -> Router {
        router(self.state_configure(configure))
    }
    fn state_configure(&self, configure: impl FnOnce(&mut Config)) -> AppState {
        let mut config = Config {
            alert_webhook_url: String::new(),
            run_retention_days: 30,
            status_page_title: "Service status".into(),
            oidc: Default::default(),
            secrets: Default::default(),
            allow_private_networks: false,
            database_url: String::new(),
            admin_token: "01234567890123456789012345678901".into(),
            origin: "https://dashboard.example.com".into(),
            bind: "127.0.0.1:0".into(),
            web: WebConfig {
                client_dir: self.dir.path().into(),
                status_domains: "status.example.com".into(),
            },
        };
        configure(&mut config);
        AppState::new(self.pool.clone(), config)
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
    assert_eq!(count, 10);
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
        "INSERT INTO monitors(config,status,last_observed_at,created_at) VALUES($1,'down',now(),'2026-10-05T03:00:00.123456-03:00') RETURNING id",
    )
    .bind(json!({"name":"Fixture","intervalSeconds":60}))
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO check_revisions(monitor_id,revision,config) SELECT id,config_revision,config FROM monitors WHERE id=$1").bind(id).execute(&fixture.pool).await.unwrap();
    let (_, data, _) = request(app.clone(), "GET", "/v1/dashboard", Value::Null, true).await;
    assert_eq!(data["monitors"][0]["health"], "down");
    assert_eq!(
        data["monitors"][0]["createdAt"],
        "2026-10-05T06:00:00.123456Z"
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
async fn upgrade_current_legacy_schema_preserves_every_existing_table_and_ledger_entry() {
    let fixture = Fixture::empty().await;
    sqlx::query("CREATE TABLE stillup_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())").execute(&fixture.pool).await.unwrap();
    let directory =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../packages/db/migrations");
    let mut migrations: Vec<_> = std::fs::read_dir(directory)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.extension().is_some_and(|extension| extension == "sql")
                && !matches!(
                    path.file_name().unwrap().to_str().unwrap(),
                    "008_rust_check_jobs.sql" | "009_uptime_rollups.sql"
                )
        })
        .collect();
    migrations.sort();
    assert_eq!(migrations.len(), 8);
    for path in migrations {
        sqlx::raw_sql(&std::fs::read_to_string(&path).unwrap())
            .execute(&fixture.pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO stillup_migrations(name) VALUES($1)")
            .bind(path.file_name().unwrap().to_str().unwrap())
            .execute(&fixture.pool)
            .await
            .unwrap();
    }
    sqlx::raw_sql(r#"DO $$
    DECLARE m uuid := gen_random_uuid(); r uuid := gen_random_uuid(); i uuid := gen_random_uuid(); c uuid := gen_random_uuid(); d uuid := gen_random_uuid(); p uuid := gen_random_uuid(); si uuid := gen_random_uuid();
    BEGIN
      INSERT INTO monitors(id,config,code_project,code_key,config_revision,execution_epoch) VALUES(m,'{"name":"Retained","url":"https://example.com","intervalSeconds":60,"public":true}','legacy','api',2,7);
      INSERT INTO check_revisions(monitor_id,revision,config) VALUES(m,1,'{"name":"Original"}'),(m,2,'{"name":"Retained"}');
      INSERT INTO runs(id,monitor_id,outcome,status_code,duration_ms,failures,checked_at,config_revision,assertions) VALUES(r,m,'fail',503,12,'["HTTP 503"]','2026-10-01T01:02:03.123456Z',2,'[]');
      INSERT INTO incidents(id,monitor_id,name,opened_at) VALUES(i,m,'Retained incident','2026-10-01T01:02:03.123456Z');
      INSERT INTO worker_health(id) VALUES('worker');
      INSERT INTO notification_channels(id,name,url,is_default) VALUES(c,'Retained channel','https://example.com/hook',true);
      INSERT INTO notification_deliveries(id,channel_id,channel_name,incident_id,event,target_url,dedupe_key,status,attempts,cycle_attempts) VALUES(d,c,'Retained channel',i,'{"type":"incident.opened"}','https://example.com/hook','retained-delivery','retrying',2,2);
      INSERT INTO notification_attempts(id,delivery_id,number,status_code,error) VALUES(gen_random_uuid(),d,1,503,'HTTP 503');
      INSERT INTO incident_events(incident_id,type,at,run_id,config_revision,result) VALUES(i,'incident.opened','2026-10-01T01:02:03.123456Z',r,2,'{"outcome":"fail"}');
      INSERT INTO managed_secrets(name,encrypted_value,revision) VALUES('RETAINED','{"iv":"retained","tag":"retained","ciphertext":"retained"}',3);
      INSERT INTO status_settings(id,config,revision) VALUES(1,'{"title":"Retained status"}',4);
      INSERT INTO maintenance_windows(title,monitor_ids,starts_at,ends_at) VALUES('Retained maintenance',ARRAY[m],'2026-10-02T00:00:00Z','2026-10-02T01:00:00Z');
      INSERT INTO status_incidents(id,title,monitor_ids) VALUES(si,'Retained manual incident',ARRAY[m]);
      INSERT INTO status_updates(incident_id,source,stage,body) VALUES(si,'manual','investigating','Retained update');
      INSERT INTO probe_locations(id,name,region,token_hash) VALUES('retained-region','Retained region','test','retained-token-hash');
      INSERT INTO probe_rounds(id,monitor_id,config_revision,execution_epoch,deadline) VALUES(p,m,2,7,'2026-10-02T00:00:00Z');
      INSERT INTO probe_jobs(id,round_id,location_id,result) VALUES(gen_random_uuid(),p,'retained-region','{"outcome":"pass"}');
      INSERT INTO workspace_settings(id,config,revision) VALUES(1,'{"name":"Retained workspace"}',5);
    END $$"#).execute(&fixture.pool).await.unwrap();
    let tables: Vec<String> = sqlx::query_scalar(
        "SELECT tablename FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename",
    )
    .fetch_all(&fixture.pool)
    .await
    .unwrap();
    let mut snapshots = Vec::new();
    for table in &tables {
        let query = format!(
            "SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM \"{}\" t",
            table.replace('"', "\"\"")
        );
        let data: Value = sqlx::query_scalar(&query)
            .fetch_one(&fixture.pool)
            .await
            .unwrap();
        assert!(
            data.as_array().is_some_and(|rows| !rows.is_empty()),
            "unseeded table {table}"
        );
        snapshots.push((table.clone(), query, data));
    }
    for _ in 0..2 {
        database::migrate(&fixture.pool).await.unwrap();
        for (table, query, before) in &snapshots {
            let query = if table == "stillup_migrations" {
                "SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM stillup_migrations t WHERE name NOT IN ('008_rust_check_jobs.sql','009_uptime_rollups.sql')"
            } else {
                query.as_str()
            };
            let after: Value = sqlx::query_scalar(query)
                .fetch_one(&fixture.pool)
                .await
                .unwrap();
            assert_eq!(&after, before, "changed legacy table {table}");
        }
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM stillup_migrations")
            .fetch_one(&fixture.pool)
            .await
            .unwrap();
        assert_eq!(count, 10);
        let uptime: (String, i64, i64) = sqlx::query_as(
            "SELECT day::text,observed_seconds,down_seconds FROM monitor_daily_uptime",
        )
        .fetch_one(&fixture.pool)
        .await
        .unwrap();
        assert_eq!(uptime, ("2026-10-01".into(), 60, 60));
        let jobs: i64 = sqlx::query_scalar("SELECT count(*) FROM check_jobs")
            .fetch_one(&fixture.pool)
            .await
            .unwrap();
        assert_eq!(jobs, 0);
    }
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
async fn malformed_paths_keep_json_errors_on_all_parameterized_route_families() {
    let fixture = Fixture::new().await;
    let app = fixture.app();
    for prefix in ["/v1", "/api/v1"] {
        for (method, suffix) in [
            ("GET", "/checks/%FF"),
            ("GET", "/checks/id/revisions/%FF"),
            ("GET", "/notification-deliveries/%FF"),
            ("PUT", "/notification-channels/%FF"),
            ("PUT", "/status-management/maintenance/%FF"),
            ("PUT", "/secrets/%FF"),
            ("DELETE", "/locations/%FF"),
            ("GET", "/incidents/%FF"),
        ] {
            let path = format!("{prefix}{suffix}");
            let (status, body, headers) =
                request(app.clone(), method, &path, json!({}), true).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{method} {path}");
            assert_eq!(headers[header::CONTENT_TYPE], "application/json");
            assert_eq!(body["error"], "Invalid route parameters");
        }
    }
    let (status, _, _) = request(app, "GET", "/v1/checks/%FF", Value::Null, false).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL"]
async fn unsupported_api_methods_match_legacy_not_found_and_keep_authentication() {
    let fixture = Fixture::new().await;
    let app = fixture.app();
    for prefix in ["/v1", "/api/v1"] {
        for (method, suffix) in [
            ("PATCH", "/session"),
            ("POST", "/dashboard"),
            ("DELETE", "/workspace"),
        ] {
            let path = format!("{prefix}{suffix}");
            let (status, body, headers) =
                request(app.clone(), method, &path, Value::Null, true).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{method} {path}");
            assert_eq!(headers[header::CONTENT_TYPE], "application/json");
            assert_eq!(body["error"], "Not found");
            let (status, body, _) = request(app.clone(), method, &path, Value::Null, false).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED);
            assert!(body["error"].is_string());
        }
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
async fn native_assets_negotiate_gzip_without_changing_identity_or_cache_policy() {
    let fixture = Fixture::new().await;
    std::fs::create_dir(fixture.dir.path().join("assets")).unwrap();
    let asset = "export const fixture = 'gzip negotiation';\n".repeat(200);
    std::fs::write(fixture.dir.path().join("assets/fixture-123.js"), &asset).unwrap();
    let app = fixture.app();
    for encoding in ["identity", "gzip", "gzip;q=0"] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/assets/fixture-123.js")
                    .header(header::ACCEPT_ENCODING, encoding)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(
            response.headers()[header::CACHE_CONTROL]
                .to_str()
                .unwrap()
                .contains("immutable")
        );
        let content_encoding = response.headers().get(header::CONTENT_ENCODING).cloned();
        if encoding == "gzip" {
            assert_eq!(content_encoding.unwrap(), "gzip");
            assert!(
                response
                    .headers()
                    .get_all(header::VARY)
                    .iter()
                    .any(|value| value
                        .to_str()
                        .unwrap()
                        .to_ascii_lowercase()
                        .contains("accept-encoding"))
            );
            let body = response.into_body().collect().await.unwrap().to_bytes();
            assert!(body.starts_with(&[0x1f, 0x8b]));
            assert!(body.len() < asset.len() / 10);
        } else {
            assert!(content_encoding.is_none());
            let body = response.into_body().collect().await.unwrap().to_bytes();
            assert_eq!(body.as_ref(), asset.as_bytes());
        }
    }
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

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL"]
async fn create_and_edit_checks_keep_revisions_routing_and_code_ownership() {
    let fixture = Fixture::new().await;
    let app = fixture.app();
    let input = json!({"name":" Example ","url":"https://example.com/health"});
    let (status, data, _) =
        request(app.clone(), "POST", "/api/v1/checks", input.clone(), true).await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(data["config"]["name"], "Example");
    assert_eq!(data["config"]["method"], "GET");
    assert_eq!(data["configRevision"], 1);
    let id = data["id"].as_str().unwrap();
    let path = format!("/v1/checks/{id}");
    let changed = json!({"config":{"name":"Changed","url":"https://example.com/health"},"expectedRevision":1});
    let (a, b) = tokio::join!(
        request(app.clone(), "PUT", &path, changed.clone(), true),
        request(
            app.clone(),
            "PUT",
            &path,
            json!({"config":{"name":"Concurrent","url":"https://example.com/health"},"expectedRevision":1}),
            true
        )
    );
    assert!(
        (a.0 == StatusCode::OK && b.0 == StatusCode::CONFLICT)
            || (b.0 == StatusCode::OK && a.0 == StatusCode::CONFLICT)
    );
    let (_, data, _) = request(app.clone(), "GET", &path, Value::Null, true).await;
    assert_eq!(data["configRevision"], 2);
    assert_eq!(data["health"], "unknown");
    let uid = uuid::Uuid::parse_str(id).unwrap();
    let epoch: i32 = sqlx::query_scalar("SELECT execution_epoch FROM monitors WHERE id=$1")
        .bind(uid)
        .fetch_one(&fixture.pool)
        .await
        .unwrap();
    let (_, same, _) = request(
        app.clone(),
        "PUT",
        &path,
        json!({"config":data["config"],"expectedRevision":2}),
        true,
    )
    .await;
    assert_eq!(same["configRevision"], 2);
    let new_epoch: i32 = sqlx::query_scalar("SELECT execution_epoch FROM monitors WHERE id=$1")
        .bind(uid)
        .fetch_one(&fixture.pool)
        .await
        .unwrap();
    assert_eq!(epoch, new_epoch);
    let (_, history, _) = request(
        app.clone(),
        "GET",
        &format!("{path}/revisions"),
        Value::Null,
        true,
    )
    .await;
    assert_eq!(history["revisions"].as_array().unwrap().len(), 2);
    sqlx::query("UPDATE monitors SET code_project='fixture',code_key='example' WHERE id=$1")
        .bind(uid)
        .execute(&fixture.pool)
        .await
        .unwrap();
    assert_eq!(
        request(
            app.clone(),
            "PUT",
            &path,
            json!({"config":input,"expectedRevision":2}),
            true
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    for patch in [
        json!({"locationIds":["12d5f625-8487-4400-ae00-9a3ee6616cc6"]}),
        json!({"notificationChannelIds":["12d5f625-8487-4400-ae00-9a3ee6616cc6"]}),
        json!({"body":"x"}),
    ] {
        let mut config = input.clone();
        for (key, value) in patch.as_object().unwrap() {
            config[key] = value.clone();
        }
        assert_eq!(
            request(app.clone(), "POST", "/v1/checks", config, true)
                .await
                .0,
            StatusCode::BAD_REQUEST
        );
    }
    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL"]
async fn managed_secrets_encrypt_guard_revisions_and_override_environment() {
    use stillup_api::secrets::{SecretConfig, resolve};
    let fixture = Fixture::new().await;
    let settings = SecretConfig {
        encryption_key: "a".repeat(64),
        environment: std::collections::HashMap::new(),
    };
    let app = fixture.app_configure(|config| config.secrets = settings.clone());
    assert_eq!(
        request(
            app.clone(),
            "POST",
            "/v1/secrets",
            json!({"name":"TOKEN","value":"fixture-secret"}),
            true
        )
        .await
        .0,
        StatusCode::CREATED
    );
    let encrypted: Value =
        sqlx::query_scalar("SELECT encrypted_value FROM managed_secrets WHERE name='TOKEN'")
            .fetch_one(&fixture.pool)
            .await
            .unwrap();
    assert!(!encrypted.to_string().contains("fixture-secret"));
    let refs = vec!["Bearer {{TOKEN}}".into()];
    let mut settings = settings;
    settings
        .environment
        .insert("CHECK_SECRET_TOKEN".into(), "environment-secret".into());
    assert_eq!(
        resolve(&fixture.pool, &settings, &refs).await.unwrap()["CHECK_SECRET_TOKEN"],
        "fixture-secret"
    );
    assert_eq!(
        request(
            app.clone(),
            "PUT",
            "/v1/secrets/TOKEN",
            json!({"enabled":false,"expectedRevision":2}),
            true
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        request(
            app.clone(),
            "PUT",
            "/v1/secrets/TOKEN",
            json!({"enabled":false,"expectedRevision":1}),
            true
        )
        .await
        .0,
        StatusCode::OK
    );
    assert!(
        !resolve(&fixture.pool, &settings, &refs)
            .await
            .unwrap()
            .contains_key("CHECK_SECRET_TOKEN")
    );
    let (status, overview, _) = request(app.clone(), "GET", "/v1/secrets", Value::Null, true).await;
    assert_eq!(status, StatusCode::OK);
    assert!(!overview.to_string().contains("fixture-secret"));
    assert_eq!(overview["secrets"][0]["revision"], 2);
    let bad = fixture.app_configure(|config| config.secrets.encryption_key = "b".repeat(64));
    assert_eq!(
        request(
            bad,
            "POST",
            "/v1/secrets",
            json!({"name":"OTHER","value":"x"}),
            true
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let env = fixture.app_configure(|config| config.secrets = settings.clone());
    assert_eq!(
        request(
            env,
            "POST",
            "/v1/secrets",
            json!({"name":"TOKEN","value":"x"}),
            true
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let (_,result,_)=request(app,"POST","/v1/checks/test",json!({"name":"Private","url":"http://127.0.0.1:9","headers":{"Authorization":"Bearer {{TOKEN}}"}}),true).await;
    assert_eq!(result["outcome"], "error");
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM monitors")
        .fetch_one(&fixture.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    fixture.close().await;
}
#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL"]
async fn test_request_resolves_stored_secrets_without_saving_monitoring_state() {
    use axum::{extract::Request, routing::get};
    let fixture = Fixture::new().await;
    let app = fixture.app_configure(|config| {
        config.allow_private_networks = true;
        config.secrets.encryption_key = "a".repeat(64);
    });
    request(
        app.clone(),
        "POST",
        "/v1/secrets",
        json!({"name":"TOKEN","value":"fixture-secret"}),
        true,
    )
    .await;
    let target = Router::new().route(
        "/",
        get(|request: Request| async move {
            assert_eq!(request.headers()["authorization"], "Bearer fixture-secret");
            "{\"healthy\":true}"
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/", listener.local_addr().unwrap());
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        axum::serve(listener, target)
            .with_graceful_shutdown(async {
                stopped.await.ok();
            })
            .await
            .unwrap();
    });
    let (status,data,_)=request(app,"POST","/api/v1/checks/test",json!({"name":"Preview","url":url,"headers":{"Authorization":"Bearer {{TOKEN}}"},"jsonAssertions":[{"path":"$.healthy","equals":true}]}),true).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(data["outcome"], "pass");
    assert!(!data.to_string().contains("fixture-secret"));
    for table in ["monitors", "runs", "incidents", "notification_deliveries"] {
        let count: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
            .fetch_one(&fixture.pool)
            .await
            .unwrap();
        assert_eq!(count, 0);
    }
    stop.send(()).unwrap();
    server.await.unwrap();
    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL"]
async fn notification_channels_are_revision_guarded_and_never_expose_destinations() {
    let fixture = Fixture::new().await;
    stillup_api::notifications::initialize(&fixture.pool, "{{ENV_URL}}")
        .await
        .unwrap();
    stillup_api::notifications::initialize(&fixture.pool, "{{ENV_URL}}")
        .await
        .unwrap();
    let app = fixture.app_configure(|config| config.alert_webhook_url = "{{ENV_URL}}".into());
    let (status, channels, _) = request(
        app.clone(),
        "GET",
        "/v1/notification-channels",
        Value::Null,
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(channels.as_array().unwrap().len(), 1);
    assert_eq!(channels[0]["destination"], "Secret reference: ENV_URL");
    let env_id = channels[0]["id"].as_str().unwrap();
    assert_eq!(
        request(
            app.clone(),
            "PUT",
            &format!("/v1/notification-channels/{env_id}"),
            json!({"name":"Environment","expectedRevision":1,"url":"https://example.com"}),
            true
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let (status, ch, _) = request(app.clone(), "POST", "/api/v1/notification-channels", json!({"name":" Webhook ","url":"https://example.com/private?secret=hidden","isDefault":true}), true).await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(ch["name"], "Webhook");
    assert_eq!(ch["destination"], "https://example.com");
    assert!(ch.get("url").is_none());
    assert!(!ch.to_string().contains("hidden"));
    let path = format!("/v1/notification-channels/{}", ch["id"].as_str().unwrap());
    let edit = json!({"name":"Renamed","expectedRevision":1,"url":"{{HOOK}}","enabled":false});
    let (first, second) = tokio::join!(
        request(app.clone(), "PUT", &path, edit.clone(), true),
        request(app.clone(), "PUT", &path, edit, true)
    );
    assert!([first.0, second.0].contains(&StatusCode::OK));
    assert!([first.0, second.0].contains(&StatusCode::CONFLICT));
    let saved = if first.0 == StatusCode::OK {
        first.1
    } else {
        second.1
    };
    assert_eq!(saved["revision"], 2);
    assert_eq!(saved["destination"], "Secret reference: HOOK");
    assert_eq!(saved["enabled"], false);
    for url in [
        "file:///etc/passwd",
        "https://user:secret@example.com",
        "https://example.com/#secret",
        "prefix{{HOOK}}",
    ] {
        assert_eq!(
            request(
                app.clone(),
                "POST",
                "/v1/notification-channels",
                json!({"name":"Bad","url":url}),
                true
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
    }
    assert_eq!(
        request(app, "GET", "/v1/notification-channels", Value::Null, false)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL"]
async fn notification_delivery_leases_retry_ordering_fencing_and_diagnostics() {
    use sqlx::Row;
    use stillup_api::{notifications as alerts, webhook::DeliveryResult};
    use uuid::Uuid;
    let fixture = Fixture::new().await;
    let state = fixture.state_configure(|_| {});
    let app = router(state.clone());
    let (_, channel, _) = request(
        app.clone(),
        "POST",
        "/v1/notification-channels",
        json!({"name":"Alerts","url":"{{HOOK}}","isDefault":true}),
        true,
    )
    .await;
    let channel_id = channel["id"].as_str().unwrap();
    let (status, test, _) = request(
        app.clone(),
        "POST",
        &format!("/v1/notification-channels/{channel_id}/test"),
        Value::Null,
        true,
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let delivery_id = Uuid::parse_str(test["deliveryId"].as_str().unwrap()).unwrap();
    let (left, right) = tokio::join!(
        alerts::claim(&state, Some(delivery_id)),
        alerts::claim(&state, Some(delivery_id))
    );
    let (left, right) = (left.unwrap(), right.unwrap());
    assert_ne!(left.is_some(), right.is_some());
    let first = left.or(right).unwrap();
    assert_eq!(first.get::<i32, _>("attempts"), 1);
    assert!(
        alerts::claim(&state, Some(delivery_id))
            .await
            .unwrap()
            .is_none()
    );
    sqlx::query(
        "UPDATE notification_deliveries SET next_attempt_at=now()-interval '1 second' WHERE id=$1",
    )
    .bind(delivery_id)
    .execute(&fixture.pool)
    .await
    .unwrap();
    let second = alerts::claim(&state, Some(delivery_id))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(second.get::<i32, _>("attempts"), 2);
    alerts::acknowledge(
        &state,
        &first,
        DeliveryResult {
            status_code: Some(204),
            error: None,
        },
    )
    .await
    .unwrap();
    let active: String =
        sqlx::query_scalar("SELECT status FROM notification_deliveries WHERE id=$1")
            .bind(delivery_id)
            .fetch_one(&fixture.pool)
            .await
            .unwrap();
    assert_eq!(active, "delivering");
    alerts::acknowledge(
        &state,
        &second,
        DeliveryResult {
            status_code: Some(503),
            error: Some("Webhook returned HTTP 503".into()),
        },
    )
    .await
    .unwrap();
    let (_, detail, _) = request(
        app.clone(),
        "GET",
        &format!("/v1/notification-deliveries/{delivery_id}"),
        Value::Null,
        true,
    )
    .await;
    assert_eq!(detail["delivery"]["status"], "retrying");
    assert_eq!(detail["attempts"][0]["statusCode"], 503);
    assert_eq!(
        detail["attempts"][1]["error"],
        "Worker interrupted before acknowledgement was recorded"
    );
    assert!(!detail.to_string().contains("{{HOOK}}"));
    assert_eq!(
        request(
            app.clone(),
            "POST",
            &format!("/v1/notification-deliveries/{delivery_id}/retry"),
            Value::Null,
            true
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    sqlx::query("UPDATE notification_deliveries SET next_attempt_at=now()-interval '1 second',cycle_attempts=5 WHERE id=$1").bind(delivery_id).execute(&fixture.pool).await.unwrap();
    assert!(
        alerts::deliver_one(&state, Some(delivery_id))
            .await
            .unwrap()
    );
    let (_, detail, _) = request(
        app.clone(),
        "GET",
        &format!("/v1/notification-deliveries/{delivery_id}"),
        Value::Null,
        true,
    )
    .await;
    assert_eq!(detail["delivery"]["status"], "failed");
    assert_eq!(
        detail["delivery"]["lastError"],
        "A referenced webhook secret is unavailable"
    );
    assert_eq!(
        request(
            app.clone(),
            "POST",
            &format!("/v1/notification-deliveries/{delivery_id}/retry"),
            Value::Null,
            true
        )
        .await
        .0,
        StatusCode::ACCEPTED
    );
    let retried = alerts::claim(&state, Some(delivery_id))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(retried.get::<i32, _>("cycle_attempts"), 1);
    assert_eq!(retried.get::<i32, _>("attempts"), 4);
    alerts::acknowledge(
        &state,
        &retried,
        DeliveryResult {
            status_code: Some(204),
            error: None,
        },
    )
    .await
    .unwrap();
    let monitor_id: Uuid =
        sqlx::query_scalar("INSERT INTO monitors(config) VALUES($1) RETURNING id")
            .bind(json!({"name":"API","url":"https://example.com","intervalSeconds":60}))
            .fetch_one(&fixture.pool)
            .await
            .unwrap();
    let incident_id: Uuid =
        sqlx::query_scalar("INSERT INTO incidents(monitor_id,name) VALUES($1,'API') RETURNING id")
            .bind(monitor_id)
            .fetch_one(&fixture.pool)
            .await
            .unwrap();
    let event = json!({"id":incident_id,"type":"incident.opened","name":"API","at":"2026-01-01T00:00:00.000Z"});
    let mut tx = fixture.pool.begin().await.unwrap();
    let ids = alerts::queue_event(&mut tx, "", &event, &json!({}), "opened", None, None)
        .await
        .unwrap();
    assert_eq!(ids.len(), 1);
    assert!(
        alerts::queue_event(&mut tx, "", &event, &json!({}), "opened", None, None)
            .await
            .unwrap()
            .is_empty()
    );
    let mut resolved = event.clone();
    resolved["type"] = json!("incident.resolved");
    let later = alerts::queue_event(&mut tx, "", &resolved, &json!({}), "resolved", None, None)
        .await
        .unwrap();
    assert!(
        alerts::queue_event(
            &mut tx,
            "",
            &event,
            &json!({"notificationChannelIds":[]}),
            "no-routes",
            None,
            None
        )
        .await
        .unwrap()
        .is_empty()
    );
    sqlx::query("UPDATE notification_deliveries SET created_at=created_at+interval '1 microsecond' WHERE id=$1").bind(later[0]).execute(&mut *tx).await.unwrap();
    tx.commit().await.unwrap();
    assert!(
        alerts::claim(&state, Some(later[0]))
            .await
            .unwrap()
            .is_none()
    );
    let opened = alerts::claim(&state, Some(ids[0])).await.unwrap().unwrap();
    alerts::acknowledge(
        &state,
        &opened,
        DeliveryResult {
            status_code: Some(200),
            error: None,
        },
    )
    .await
    .unwrap();
    let resolved = alerts::claim(&state, Some(later[0]))
        .await
        .unwrap()
        .unwrap();
    alerts::acknowledge(
        &state,
        &resolved,
        DeliveryResult {
            status_code: Some(200),
            error: None,
        },
    )
    .await
    .unwrap();
    let (_, history, _) = request(
        app.clone(),
        "GET",
        &format!("/v1/notification-deliveries?incidentId={incident_id}"),
        Value::Null,
        true,
    )
    .await;
    assert_eq!(history["deliveries"].as_array().unwrap().len(), 2);
    assert_eq!(history["nextBefore"], Value::Null);
    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL"]
async fn native_alerts_deliver_managed_webhooks_and_cancel_obsolete_reminders() {
    use sqlx::Row;
    use stillup_api::notifications as alerts;
    use uuid::Uuid;
    let fixture = Fixture::new().await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let target = format!(
        "http://{}/hook/private?token=hidden",
        listener.local_addr().unwrap()
    );
    let receipts = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let captured = receipts.clone();
    let receiver = Router::new().route(
        "/hook/private",
        axum::routing::post(
            move |headers: axum::http::HeaderMap, axum::Json(payload): axum::Json<Value>| {
                let captured = captured.clone();
                async move {
                    assert_eq!(
                        headers["idempotency-key"],
                        payload["eventId"].as_str().unwrap()
                    );
                    captured.lock().unwrap().push(payload);
                    StatusCode::NO_CONTENT
                }
            },
        ),
    );
    let server = tokio::spawn(async move { axum::serve(listener, receiver).await.unwrap() });
    let state = fixture.state_configure(|config| {
        config.allow_private_networks = true;
        config.secrets.encryption_key = "24".repeat(32);
    });
    let app = router(state.clone());
    assert_eq!(
        request(
            app.clone(),
            "POST",
            "/v1/secrets",
            json!({"name":"HOOK","value":target}),
            true
        )
        .await
        .0,
        StatusCode::CREATED
    );
    let (_, channel, _) = request(
        app.clone(),
        "POST",
        "/v1/notification-channels",
        json!({"name":"Webhook","url":"{{HOOK}}","isDefault":true}),
        true,
    )
    .await;
    let channel_id = channel["id"].as_str().unwrap();
    let (_, test, _) = request(
        app.clone(),
        "POST",
        &format!("/v1/notification-channels/{channel_id}/test"),
        Value::Null,
        true,
    )
    .await;
    let delivery_id = Uuid::parse_str(test["deliveryId"].as_str().unwrap()).unwrap();
    assert!(
        alerts::deliver_one(&state, Some(delivery_id))
            .await
            .unwrap()
    );
    let (_, details, _) = request(
        app.clone(),
        "GET",
        &format!("/v1/notification-deliveries/{delivery_id}"),
        Value::Null,
        true,
    )
    .await;
    assert_eq!(details["delivery"]["status"], "delivered");
    assert_eq!(details["attempts"][0]["statusCode"], 204);
    assert!(details["delivery"]["deliveredAt"].is_string());
    assert!(!details.to_string().contains("hidden"));
    assert_eq!(receipts.lock().unwrap().len(), 1);
    let monitor_id: Uuid = sqlx::query_scalar("INSERT INTO monitors(config,status,last_outcome,last_observed_at) VALUES($1,'down','fail',now()) RETURNING id")
        .bind(json!({"name":"API","url":"https://example.com","intervalSeconds":60,"reminderIntervalSeconds":300})).fetch_one(&fixture.pool).await.unwrap();
    let incident_id: Uuid = sqlx::query_scalar("INSERT INTO incidents(monitor_id,name,opened_at) VALUES($1,'API',now()-interval '301 seconds') RETURNING id")
        .bind(monitor_id).fetch_one(&fixture.pool).await.unwrap();
    alerts::reminders(&state).await.unwrap();
    alerts::reminders(&state).await.unwrap();
    let reminders = sqlx::query("SELECT * FROM notification_deliveries WHERE incident_id=$1")
        .bind(incident_id)
        .fetch_all(&fixture.pool)
        .await
        .unwrap();
    assert_eq!(reminders.len(), 1);
    let reminder_id: Uuid = reminders[0].get("id");
    sqlx::query("UPDATE monitors SET last_observed_at=now()-interval '181 seconds' WHERE id=$1")
        .bind(monitor_id)
        .execute(&fixture.pool)
        .await
        .unwrap();
    assert!(
        alerts::claim(&state, Some(reminder_id))
            .await
            .unwrap()
            .is_none()
    );
    let (_, details, _) = request(
        app,
        "GET",
        &format!("/v1/notification-deliveries/{reminder_id}"),
        Value::Null,
        true,
    )
    .await;
    assert_eq!(details["delivery"]["status"], "cancelled");
    assert_eq!(
        details["delivery"]["lastError"],
        "Outage reminder is no longer applicable"
    );
    assert_eq!(receipts.lock().unwrap().len(), 1);
    server.abort();
    assert!(server.await.unwrap_err().is_cancelled());
    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL"]
async fn native_queue_executes_http_and_records_incident_lifecycle_atomically() {
    use sqlx::Row;
    use std::sync::{
        Arc,
        atomic::{AtomicU16, AtomicUsize, Ordering},
    };
    use stillup_api::monitoring;
    use uuid::Uuid;
    let fixture = Fixture::new().await;
    let code = Arc::new(AtomicU16::new(500));
    let requests = Arc::new(AtomicUsize::new(0));
    let response_code = code.clone();
    let received = requests.clone();
    let target = Router::new().route(
        "/",
        axum::routing::get(move || {
            let code = response_code.clone();
            let received = received.clone();
            async move {
                received.fetch_add(1, Ordering::SeqCst);
                StatusCode::from_u16(code.load(Ordering::SeqCst)).unwrap()
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, target).await.unwrap() });
    let state = fixture.state_configure(|config| {
        config.allow_private_networks = true;
        config.secrets.encryption_key = "57".repeat(32);
    });
    let app = router(state.clone());
    assert_eq!(
        request(
            app.clone(),
            "POST",
            "/v1/notification-channels",
            json!({"name":"Alerts","url":"https://example.com/webhook","isDefault":true}),
            true
        )
        .await
        .0,
        StatusCode::CREATED
    );
    let (status,monitor,_) = request(app.clone(),"POST","/v1/checks",json!({"name":"HTTP","url":url,"failureThreshold":2,"recoveryThreshold":2,"headers":{"Authorization":"Bearer {{TOKEN}}"}}),true).await;
    assert_eq!(status, StatusCode::CREATED);
    let monitor_id = Uuid::parse_str(monitor["id"].as_str().unwrap()).unwrap();
    assert_eq!(
        request(
            app.clone(),
            "POST",
            "/v1/secrets",
            json!({"name":"TOKEN","value":"managed-token"}),
            true
        )
        .await
        .0,
        StatusCode::CREATED
    );
    let run_path = format!("/v1/checks/{monitor_id}/run");
    let mut observed = None;
    for index in 0..5 {
        if index == 2 {
            assert_eq!(
                request(
                    app.clone(),
                    "PUT",
                    "/v1/secrets/TOKEN",
                    json!({"expectedRevision":1,"enabled":false}),
                    true
                )
                .await
                .0,
                StatusCode::OK
            );
        }
        if index == 3 {
            sqlx::query("UPDATE managed_secrets SET enabled=true WHERE name='TOKEN'")
                .execute(&fixture.pool)
                .await
                .unwrap();
            code.store(200, Ordering::SeqCst);
        }
        let (status, queued, _) = request(app.clone(), "POST", &run_path, Value::Null, true).await;
        assert_eq!(status, StatusCode::ACCEPTED);
        assert_eq!(queued["queued"], true);
        assert_eq!(
            request(app.clone(), "POST", &run_path, Value::Null, true)
                .await
                .1["queued"],
            false
        );
        assert!(monitoring::run_one(&state).await.unwrap());
        assert!(!monitoring::run_one(&state).await.unwrap());
        let row = sqlx::query("SELECT * FROM monitors WHERE id=$1")
            .bind(monitor_id)
            .fetch_one(&fixture.pool)
            .await
            .unwrap();
        assert_eq!(
            row.get::<String, _>("status"),
            if index == 0 {
                "unknown"
            } else if index == 4 {
                "up"
            } else {
                "down"
            }
        );
        if index == 1 {
            observed = row.get::<Option<chrono::DateTime<chrono::Utc>>, _>("last_observed_at");
        }
        if index == 2 {
            assert_eq!(
                row.get::<Option<String>, _>("last_outcome").as_deref(),
                Some("error")
            );
            assert_eq!(
                row.get::<Option<chrono::DateTime<chrono::Utc>>, _>("last_observed_at"),
                observed
            );
            assert_eq!(row.get::<i32, _>("failures"), 2);
        }
    }
    assert_eq!(requests.load(Ordering::SeqCst), 4);
    let incidents = sqlx::query("SELECT * FROM incidents WHERE monitor_id=$1")
        .bind(monitor_id)
        .fetch_all(&fixture.pool)
        .await
        .unwrap();
    assert_eq!(incidents.len(), 1);
    assert!(
        incidents[0]
            .get::<Option<chrono::DateTime<chrono::Utc>>, _>("resolved_at")
            .is_some()
    );
    let incident_id: Uuid = incidents[0].get("id");
    let (_, timeline, _) = request(
        app.clone(),
        "GET",
        &format!("/v1/incidents/{incident_id}"),
        Value::Null,
        true,
    )
    .await;
    assert_eq!(timeline["events"].as_array().unwrap().len(), 2);
    assert_eq!(timeline["events"][0]["type"], "incident.opened");
    assert_eq!(timeline["events"][1]["type"], "incident.resolved");
    assert_eq!(timeline["observations"].as_array().unwrap().len(), 4);
    // fail, fail(down), error, pass(still down), pass(up): errors are excluded and
    // observations count as downtime only while the check is in a confirmed outage.
    let (observed, down): (i64, i64) = sqlx::query_as("SELECT sum(observed_seconds)::bigint,sum(down_seconds)::bigint FROM monitor_daily_uptime WHERE monitor_id=$1")
        .bind(monitor_id)
        .fetch_one(&fixture.pool)
        .await
        .unwrap();
    let interval = monitor["config"]["intervalSeconds"].as_i64().unwrap();
    assert_eq!((observed, down), (4 * interval, 2 * interval));
    let (_, dashboard, _) = request(app.clone(), "GET", "/v1/dashboard", Value::Null, true).await;
    let listed = dashboard["monitors"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["id"] == monitor["id"])
        .unwrap();
    assert_eq!(listed["uptime30d"], 50.0);
    let (status, history, _) = request(
        app.clone(),
        "GET",
        &format!("/v1/checks/{monitor_id}/uptime"),
        Value::Null,
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(history["percentage"], 50.0);
    assert_eq!(history["windowDays"], 90);
    assert_eq!(
        request(
            app.clone(),
            "GET",
            &format!("/v1/checks/{monitor_id}/uptime"),
            Value::Null,
            false
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    let (_, deliveries, _) = request(
        app.clone(),
        "GET",
        &format!("/v1/notification-deliveries?incidentId={incident_id}"),
        Value::Null,
        true,
    )
    .await;
    assert_eq!(deliveries["deliveries"].as_array().unwrap().len(), 2);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM runs WHERE monitor_id=$1")
            .bind(monitor_id)
            .fetch_one(&fixture.pool)
            .await
            .unwrap(),
        5
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM check_jobs WHERE monitor_id=$1 AND status='completed'"
        )
        .bind(monitor_id)
        .fetch_one(&fixture.pool)
        .await
        .unwrap(),
        5
    );
    server.abort();
    assert!(server.await.unwrap_err().is_cancelled());
    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL"]
async fn check_jobs_fence_changes_recover_leases_and_bound_database_retries() {
    use sqlx::Row;
    use stillup_api::monitoring;
    use uuid::Uuid;
    let fixture = Fixture::new().await;
    let state = fixture.state_configure(|_| {});
    let app = router(state.clone());
    let (_, monitor, _) = request(
        app.clone(),
        "POST",
        "/v1/checks",
        json!({"name":"Fenced","url":"http://127.0.0.1/"}),
        true,
    )
    .await;
    let monitor_id = Uuid::parse_str(monitor["id"].as_str().unwrap()).unwrap();
    let original = monitor["config"].clone();
    for change in ["pause", "archive", "revision", "epoch", "stale", "regional"] {
        sqlx::query("UPDATE monitors SET enabled=true,archived_at=NULL,config_revision=1,execution_epoch=1,config=$2,next_run_at=now() WHERE id=$1").bind(monitor_id).bind(&original).execute(&fixture.pool).await.unwrap();
        let (a, b) = tokio::join!(
            monitoring::enqueue(&state, None),
            monitoring::enqueue(&state, None)
        );
        assert_eq!(a.unwrap() + b.unwrap(), 1);
        let (a, b) = tokio::join!(monitoring::claim(&state), monitoring::claim(&state));
        let (a, b) = (a.unwrap(), b.unwrap());
        assert_ne!(a.is_some(), b.is_some());
        let job = a.or(b).unwrap();
        match change {
            "pause" => {
                sqlx::query("UPDATE monitors SET enabled=false WHERE id=$1")
                    .bind(monitor_id)
                    .execute(&fixture.pool)
                    .await
                    .unwrap();
            }
            "archive" => {
                sqlx::query("UPDATE monitors SET archived_at=now() WHERE id=$1")
                    .bind(monitor_id)
                    .execute(&fixture.pool)
                    .await
                    .unwrap();
            }
            "revision" => {
                sqlx::query("UPDATE monitors SET config_revision=2 WHERE id=$1")
                    .bind(monitor_id)
                    .execute(&fixture.pool)
                    .await
                    .unwrap();
            }
            "epoch" => {
                sqlx::query("UPDATE monitors SET execution_epoch=2 WHERE id=$1")
                    .bind(monitor_id)
                    .execute(&fixture.pool)
                    .await
                    .unwrap();
            }
            "stale" => {
                // execute_job rechecks the stored job, while scheduled_at comes from the
                // committed claim. Refresh the claim after changing the fixture timestamp.
                sqlx::query(
                    "UPDATE check_jobs SET scheduled_at=now()-interval '121 seconds' WHERE id=$1",
                )
                .bind(job.get::<Uuid, _>("id"))
                .execute(&fixture.pool)
                .await
                .unwrap();
            }
            "regional" => {
                sqlx::query(
                    "UPDATE monitors SET config=jsonb_set(config,'{locationIds}',$2) WHERE id=$1",
                )
                .bind(monitor_id)
                .bind(json!([Uuid::new_v4()]))
                .execute(&fixture.pool)
                .await
                .unwrap();
            }
            _ => unreachable!(),
        }
        let stored = sqlx::query("SELECT * FROM check_jobs WHERE id=$1")
            .bind(job.get::<Uuid, _>("id"))
            .fetch_one(&fixture.pool)
            .await
            .unwrap();
        monitoring::execute_job(&state, &stored).await.unwrap();
        monitoring::execute_job(&state, &stored).await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM runs")
                .fetch_one(&fixture.pool)
                .await
                .unwrap(),
            0,
            "case {change}"
        );
    }
    sqlx::query("UPDATE monitors SET config=$2,enabled=true,archived_at=NULL,config_revision=1,execution_epoch=1 WHERE id=$1").bind(monitor_id).bind(&original).execute(&fixture.pool).await.unwrap();
    assert_eq!(
        monitoring::enqueue(&state, Some(monitor_id)).await.unwrap(),
        1
    );
    let first = monitoring::claim(&state).await.unwrap().unwrap();
    let job_id: Uuid = first.get("id");
    sqlx::query("UPDATE check_jobs SET available_at=now()-interval '1 second' WHERE id=$1")
        .bind(job_id)
        .execute(&fixture.pool)
        .await
        .unwrap();
    let second = monitoring::claim(&state).await.unwrap().unwrap();
    monitoring::execute_job(&state, &first).await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM runs")
            .fetch_one(&fixture.pool)
            .await
            .unwrap(),
        0
    );
    monitoring::execute_job(&state, &second).await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM runs")
            .fetch_one(&fixture.pool)
            .await
            .unwrap(),
        1
    );
    // Policy errors are not target observations, so they add no uptime or downtime.
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM monitor_daily_uptime")
            .fetch_one(&fixture.pool)
            .await
            .unwrap(),
        0
    );
    // Inject a database write failure to exercise retry behavior independently of an
    // HTTP failure (HTTP failures are observations, not queue failures).
    sqlx::raw_sql("CREATE FUNCTION reject_test_run() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture failure'; END $$; CREATE TRIGGER reject_run BEFORE INSERT ON runs FOR EACH ROW EXECUTE FUNCTION reject_test_run()")
        .execute(&fixture.pool).await.unwrap();
    assert_eq!(
        monitoring::enqueue(&state, Some(monitor_id)).await.unwrap(),
        1
    );
    for attempt in 1..=3 {
        assert!(monitoring::run_one(&state).await.is_err());
        let row = sqlx::query(
            "SELECT * FROM check_jobs WHERE monitor_id=$1 ORDER BY created_at DESC LIMIT 1",
        )
        .bind(monitor_id)
        .fetch_one(&fixture.pool)
        .await
        .unwrap();
        assert_eq!(row.get::<i32, _>("attempts"), attempt);
        assert_eq!(
            row.get::<String, _>("status"),
            if attempt == 3 { "failed" } else { "pending" }
        );
        if attempt < 3 {
            assert!(
                row.get::<chrono::DateTime<chrono::Utc>, _>("available_at") > chrono::Utc::now()
            );
            sqlx::query("UPDATE check_jobs SET available_at=now() WHERE id=$1")
                .bind(row.get::<Uuid, _>("id"))
                .execute(&fixture.pool)
                .await
                .unwrap();
        }
    }
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM runs")
            .fetch_one(&fixture.pool)
            .await
            .unwrap(),
        1
    );
    assert!(!monitoring::run_one(&state).await.unwrap());
    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL and installed legacy test dependencies"]
async fn handoff_preserves_real_pg_boss_jobs_and_refuses_live_claims_atomically() {
    use stillup_api::{monitoring, notifications};
    use uuid::Uuid;
    let fixture = Fixture::new().await;
    let state = fixture
        .state_configure(|config| config.alert_webhook_url = "https://example.com/hook".into());
    notifications::initialize(&fixture.pool, &state.config.alert_webhook_url)
        .await
        .unwrap();
    let (_, monitor, _) = request(
        router(state.clone()),
        "POST",
        "/v1/checks",
        json!({"name":"Migrated","url":"http://127.0.0.1/"}),
        true,
    )
    .await;
    let monitor_id = monitor["id"].as_str().unwrap();
    let output = std::process::Command::new("node")
        .arg(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../scripts/seed-legacy-queue.mjs"),
        )
        .arg(&fixture.schema)
        .arg(monitor_id)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "Legacy queue fixture failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let jobs: Value = serde_json::from_slice(&output.stdout).unwrap();
    let check_id = Uuid::parse_str(jobs["check"].as_str().unwrap()).unwrap();
    let notify_id = Uuid::parse_str(jobs["notify"].as_str().unwrap()).unwrap();
    sqlx::query("UPDATE job SET state='active',started_on=now() WHERE id=$1")
        .bind(check_id)
        .execute(&fixture.pool)
        .await
        .unwrap();
    assert_eq!(
        monitoring::handoff(&state, &fixture.schema)
            .await
            .unwrap_err()
            .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM check_jobs")
            .fetch_one(&fixture.pool)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM notification_deliveries")
            .fetch_one(&fixture.pool)
            .await
            .unwrap(),
        0
    );
    sqlx::query("UPDATE job SET started_on=now()-interval '91 seconds' WHERE id=$1")
        .bind(check_id)
        .execute(&fixture.pool)
        .await
        .unwrap();
    assert_eq!(
        monitoring::handoff(&state, &fixture.schema).await.unwrap(),
        2
    );
    assert_eq!(
        monitoring::handoff(&state, &fixture.schema).await.unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, i32>("SELECT attempts FROM check_jobs WHERE id=$1")
            .bind(check_id)
            .fetch_one(&fixture.pool)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            "SELECT target_url FROM notification_deliveries WHERE id=$1"
        )
        .bind(notify_id)
        .fetch_one(&fixture.pool)
        .await
        .unwrap(),
        "https://example.com/hook"
    );
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM job WHERE state::text='completed' AND output->>'migratedTo'='rust'").fetch_one(&fixture.pool).await.unwrap(),2);
    assert!(monitoring::run_one(&state).await.unwrap());
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM runs WHERE id=$1")
            .bind(check_id)
            .fetch_one(&fixture.pool)
            .await
            .unwrap(),
        1
    );
    assert!(!monitoring::run_one(&state).await.unwrap());
    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL"]
async fn native_worker_schedules_reports_health_retains_active_work_and_stops() {
    use uuid::Uuid;
    let fixture = Fixture::new().await;
    let state = fixture.state_configure(|_| {});
    let (_, monitor, _) = request(
        router(state.clone()),
        "POST",
        "/v1/checks",
        json!({"name":"Scheduled","url":"http://127.0.0.1/"}),
        true,
    )
    .await;
    let monitor_id = Uuid::parse_str(monitor["id"].as_str().unwrap()).unwrap();
    let old_run = Uuid::new_v4();
    sqlx::query("INSERT INTO runs(id,monitor_id,outcome,duration_ms,failures,checked_at) VALUES($1,$2,'pass',1,'[]',now()-interval '31 days')").bind(old_run).bind(monitor_id).execute(&fixture.pool).await.unwrap();
    let old_job = Uuid::new_v4();
    sqlx::query("INSERT INTO check_jobs(id,monitor_id,config_revision,execution_epoch,status,finished_at) VALUES($1,$2,1,998,'completed',now()-interval '2 days')").bind(old_job).bind(monitor_id).execute(&fixture.pool).await.unwrap();
    let future_job = Uuid::new_v4();
    sqlx::query("INSERT INTO check_jobs(id,monitor_id,config_revision,execution_epoch,available_at) VALUES($1,$2,1,999,now()+interval '1 day')").bind(future_job).bind(monitor_id).execute(&fixture.pool).await.unwrap();
    let (stop, stopped) = tokio::sync::watch::channel(false);
    let running = tokio::spawn(stillup_api::worker::run(state.clone(), stopped));
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let count: i64 =
                sqlx::query_scalar("SELECT count(*) FROM runs WHERE monitor_id=$1 AND id<>$2")
                    .bind(monitor_id)
                    .bind(old_run)
                    .fetch_one(&fixture.pool)
                    .await
                    .unwrap();
            let cleaned: bool =
                sqlx::query_scalar("SELECT NOT EXISTS(SELECT 1 FROM runs WHERE id=$1)")
                    .bind(old_run)
                    .fetch_one(&fixture.pool)
                    .await
                    .unwrap();
            if count == 1 && cleaned {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("Worker did not schedule or clean up its cycle");
    stop.send(true).unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), running)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM worker_health WHERE id='primary'")
            .fetch_one(&fixture.pool)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM check_jobs WHERE id=$1")
            .bind(old_job)
            .fetch_one(&fixture.pool)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM check_jobs WHERE id=$1 AND status='pending'"
        )
        .bind(future_job)
        .fetch_one(&fixture.pool)
        .await
        .unwrap(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM runs WHERE monitor_id=$1")
            .bind(monitor_id)
            .fetch_one(&fixture.pool)
            .await
            .unwrap(),
        1
    );
    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL"]
async fn probe_locations_hash_enrollment_rotate_credentials_and_preserve_scope() {
    use stillup_api::probes;
    let fixture = Fixture::new().await;
    let state = fixture.state_configure(|_| {});
    let app = router(state.clone());
    let (status, created, _) = request(
        app.clone(),
        "POST",
        "/v1/locations",
        json!({"name":" Europe ","region":" eu-west "}),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let id = created["id"].as_str().unwrap();
    let enrollment = created["enrollmentToken"].as_str().unwrap();
    let credential = "ab".repeat(32);
    let stored: String =
        sqlx::query_scalar("SELECT enrollment_hash FROM probe_locations WHERE id=$1")
            .bind(id)
            .fetch_one(&fixture.pool)
            .await
            .unwrap();
    assert_ne!(stored, enrollment);
    assert_eq!(stored.len(), 64);
    let (_, locations, _) = request(app.clone(), "GET", "/v1/locations", Value::Null, true).await;
    assert_eq!(locations[1]["status"], "pending");
    assert_eq!(locations[1]["name"], "Europe");
    assert!(!locations.to_string().contains(enrollment));
    assert!(!locations.to_string().contains(&stored));
    assert_eq!(
        probes::enroll(&state, enrollment, &credential)
            .await
            .unwrap()["locationId"],
        id
    );
    assert!(
        probes::enroll(&state, enrollment, &credential)
            .await
            .is_ok()
    );
    assert_eq!(
        probes::enroll(&state, enrollment, &"cd".repeat(32))
            .await
            .unwrap_err()
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(probes::authenticate(&state, &credential).await.unwrap(), id);
    let (_, locations, _) = request(app.clone(), "GET", "/v1/locations", Value::Null, true).await;
    assert_eq!(locations[1]["status"], "online");
    let (status, renewed, _) = request(
        app.clone(),
        "POST",
        &format!("/v1/locations/{id}/enrollment"),
        Value::Null,
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_ne!(renewed["enrollmentToken"], enrollment);
    assert_eq!(
        probes::authenticate(&state, &credential)
            .await
            .unwrap_err()
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        probes::enroll(&state, enrollment, &credential)
            .await
            .unwrap_err()
            .0,
        StatusCode::UNAUTHORIZED
    );
    let new_token = renewed["enrollmentToken"].as_str().unwrap();
    probes::enroll(&state, new_token, &credential)
        .await
        .unwrap();
    assert_eq!(
        request(
            app.clone(),
            "DELETE",
            &format!("/v1/locations/{id}"),
            Value::Null,
            true
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        probes::authenticate(&state, &credential)
            .await
            .unwrap_err()
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        probes::enroll(&state, new_token, &credential)
            .await
            .unwrap_err()
            .0,
        StatusCode::UNAUTHORIZED
    );
    let (_, locations, _) = request(app.clone(), "GET", "/v1/locations", Value::Null, true).await;
    assert_eq!(locations[1]["status"], "revoked");
    assert_eq!(
        request(app, "GET", "/v1/locations", Value::Null, false)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL"]
async fn regional_rounds_scope_leases_sanitize_reports_and_expire_missing_coverage() {
    use stillup_api::{monitoring, probes};
    use uuid::Uuid;
    let fixture = Fixture::new().await;
    let state = fixture.state_configure(|_| {});
    let app = router(state.clone());
    let (_, created, _) = request(
        app.clone(),
        "POST",
        "/v1/locations",
        json!({"name":"Remote","region":"eu"}),
        true,
    )
    .await;
    let remote = created["id"].as_str().unwrap();
    let credential = "ab".repeat(32);
    probes::enroll(
        &state,
        created["enrollmentToken"].as_str().unwrap(),
        &credential,
    )
    .await
    .unwrap();
    let (_,monitor,_)=request(app.clone(),"POST","/v1/checks",json!({"name":"Regional","url":"http://127.0.0.1/","locationIds":["local",remote],"locationFailureThreshold":2,"failureThreshold":1}),true).await;
    let monitor_id = Uuid::parse_str(monitor["id"].as_str().unwrap()).unwrap();
    assert_eq!(
        monitoring::enqueue(&state, Some(monitor_id)).await.unwrap(),
        1
    );
    assert_eq!(
        monitoring::enqueue(&state, Some(monitor_id)).await.unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM check_jobs")
            .fetch_one(&fixture.pool)
            .await
            .unwrap(),
        0
    );
    let local = probes::claim(&state, "local", None).await.unwrap();
    let first = probes::claim(&state, remote, Some(&credential))
        .await
        .unwrap();
    assert!(
        probes::claim(&state, remote, Some(&credential))
            .await
            .unwrap()["job"]
            .is_null()
    );
    let job_id = Uuid::parse_str(first["job"]["id"].as_str().unwrap()).unwrap();
    let old_lease = Uuid::parse_str(first["job"]["leaseToken"].as_str().unwrap()).unwrap();
    sqlx::query("UPDATE probe_jobs SET lease_until=now()-interval '1 second' WHERE id=$1")
        .bind(job_id)
        .execute(&fixture.pool)
        .await
        .unwrap();
    let replacement = probes::claim(&state, remote, Some(&credential))
        .await
        .unwrap();
    let lease = Uuid::parse_str(replacement["job"]["leaseToken"].as_str().unwrap()).unwrap();
    assert_ne!(lease, old_lease);
    let failed = json!({"outcome":"fail","statusCode":503,"durationMs":8,"failures":["private-response"],"assertions":[{"passed":false,"message":"private-response"}]});
    assert_eq!(
        probes::complete(
            &state,
            remote,
            job_id,
            old_lease,
            &failed,
            Some(&credential)
        )
        .await
        .unwrap_err()
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        probes::complete(&state, "local", job_id, lease, &failed, None)
            .await
            .unwrap_err()
            .0,
        StatusCode::NOT_FOUND
    );
    probes::complete(&state, remote, job_id, lease, &failed, Some(&credential))
        .await
        .unwrap();
    probes::complete(&state, remote, job_id, lease, &failed, Some(&credential))
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM runs")
            .fetch_one(&fixture.pool)
            .await
            .unwrap(),
        0
    );
    probes::complete(
        &state,
        "local",
        Uuid::parse_str(local["job"]["id"].as_str().unwrap()).unwrap(),
        Uuid::parse_str(local["job"]["leaseToken"].as_str().unwrap()).unwrap(),
        &failed,
        None,
    )
    .await
    .unwrap();
    let result: Value = sqlx::query_scalar("SELECT result FROM incident_events")
        .fetch_one(&fixture.pool)
        .await
        .unwrap();
    assert_eq!(result["outcome"], "fail");
    assert_eq!(result["failures"][0], "2 locations failed; threshold is 2");
    assert!(!result.to_string().contains("private-response"));
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM runs")
            .fetch_one(&fixture.pool)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        monitoring::enqueue(&state, Some(monitor_id)).await.unwrap(),
        1
    );
    let local = probes::claim(&state, "local", None).await.unwrap();
    probes::complete(
        &state,
        "local",
        Uuid::parse_str(local["job"]["id"].as_str().unwrap()).unwrap(),
        Uuid::parse_str(local["job"]["leaseToken"].as_str().unwrap()).unwrap(),
        &json!({"outcome":"pass","statusCode":200,"durationMs":3}),
        None,
    )
    .await
    .unwrap();
    sqlx::query(
        "UPDATE probe_rounds SET deadline=now()-interval '1 second' WHERE finished_at IS NULL",
    )
    .execute(&fixture.pool)
    .await
    .unwrap();
    probes::expire(&state).await.unwrap();
    probes::expire(&state).await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM runs")
            .fetch_one(&fixture.pool)
            .await
            .unwrap(),
        2
    );
    // With threshold two, one successful location is enough to rule out two failures.
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT status FROM monitors WHERE id=$1")
            .bind(monitor_id)
            .fetch_one(&fixture.pool)
            .await
            .unwrap(),
        "up"
    );
    assert_eq!(
        monitoring::enqueue(&state, Some(monitor_id)).await.unwrap(),
        1
    );
    sqlx::query(
        "UPDATE probe_rounds SET deadline=now()-interval '1 second' WHERE finished_at IS NULL",
    )
    .execute(&fixture.pool)
    .await
    .unwrap();
    probes::expire(&state).await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT last_outcome FROM monitors WHERE id=$1")
            .bind(monitor_id)
            .fetch_one(&fixture.pool)
            .await
            .unwrap(),
        "error"
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT status FROM monitors WHERE id=$1")
            .bind(monitor_id)
            .fetch_one(&fixture.pool)
            .await
            .unwrap(),
        "up"
    );
    assert_eq!(
        monitoring::enqueue(&state, Some(monitor_id)).await.unwrap(),
        1
    );
    probes::local(&state).await.unwrap();
    let local_result:Value=sqlx::query_scalar("SELECT j.result FROM probe_jobs j JOIN probe_rounds r ON r.id=j.round_id WHERE j.location_id='local' AND r.finished_at IS NULL").fetch_one(&fixture.pool).await.unwrap();
    assert_eq!(local_result["outcome"], "error");
    assert_eq!(
        local_result["failures"][0],
        "Probe could not execute this check"
    );
    fixture.close().await;
}

async fn probe_request(
    app: Router,
    path: &str,
    input: Value,
    credential: Option<&str>,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method("POST")
        .uri(path)
        .header(header::HOST, "dashboard.example.com")
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(credential) = credential {
        request = request.header(header::AUTHORIZATION, format!("Bearer {credential}"));
    }
    let response = app
        .oneshot(request.body(Body::from(input.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap())
}
#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL"]
async fn probe_http_protocol_credentials_secrets_observations_and_epoch_fencing() {
    use stillup_api::monitoring;
    use uuid::Uuid;
    let fixture = Fixture::new().await;
    let state = fixture.state_configure(|config| {
        config
            .secrets
            .environment
            .insert("CHECK_SECRET_TOKEN".into(), "bound-secret".into());
    });
    let app = router(state.clone());
    let (_, created, _) = request(
        app.clone(),
        "POST",
        "/v1/locations",
        json!({"name":"Remote","region":"eu"}),
        true,
    )
    .await;
    let remote = created["id"].as_str().unwrap();
    let credential = "ab".repeat(32);
    let enroll = json!({"protocolVersion":1,"enrollmentToken":created["enrollmentToken"],"credential":credential});
    assert_eq!(
        probe_request(app.clone(), "/api/v1/probe/enroll", enroll.clone(), None)
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        probe_request(app.clone(), "/v1/probe/enroll", enroll, None)
            .await
            .0,
        StatusCode::OK
    );
    let admin = "01234567890123456789012345678901";
    assert_eq!(
        probe_request(
            app.clone(),
            "/v1/probe/poll",
            json!({"protocolVersion":1}),
            Some(admin)
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        probe_request(
            app.clone(),
            "/v1/probe/poll",
            json!({"protocolVersion":2}),
            Some(&credential)
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let (_,monitor,_)=request(app.clone(),"POST","/v1/checks",json!({"name":"Remote check","url":"https://example.com","locationIds":[remote],"headers":{"Authorization":"Bearer {{TOKEN}}"},"failureThreshold":1}),true).await;
    let monitor_id = Uuid::parse_str(monitor["id"].as_str().unwrap()).unwrap();
    monitoring::enqueue(&state, Some(monitor_id)).await.unwrap();
    let (status, poll) = probe_request(
        app.clone(),
        "/v1/probe/poll",
        json!({"protocolVersion":1}),
        Some(&credential),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(poll["job"]["secrets"]["CHECK_SECRET_TOKEN"], "bound-secret");
    let report = json!({"protocolVersion":1,"jobId":poll["job"]["id"],"leaseToken":poll["job"]["leaseToken"],"result":{"outcome":"fail","statusCode":503,"durationMs":10,"failures":["bound-secret"]}});
    assert_eq!(
        probe_request(app.clone(), "/v1/probe/results", report.clone(), None)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        probe_request(
            app.clone(),
            "/v1/probe/results",
            report.clone(),
            Some(&credential)
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        probe_request(app.clone(), "/v1/probe/results", report, Some(&credential))
            .await
            .0,
        StatusCode::OK
    );
    let (_, observations, _) = request(
        app.clone(),
        "GET",
        &format!("/v1/checks/{monitor_id}/locations"),
        Value::Null,
        true,
    )
    .await;
    assert_eq!(observations[0]["outcome"], "fail");
    assert_eq!(observations[0]["fresh"], true);
    assert_eq!(observations[0]["probeStatus"], "online");
    assert!(!observations.to_string().contains("bound-secret"));
    monitoring::enqueue(&state, Some(monitor_id)).await.unwrap();
    let (_, poll) = probe_request(
        app.clone(),
        "/v1/probe/poll",
        json!({"protocolVersion":1}),
        Some(&credential),
    )
    .await;
    sqlx::query("UPDATE monitors SET execution_epoch=execution_epoch+1 WHERE id=$1")
        .bind(monitor_id)
        .execute(&fixture.pool)
        .await
        .unwrap();
    let report = json!({"protocolVersion":1,"jobId":poll["job"]["id"],"leaseToken":poll["job"]["leaseToken"],"result":{"outcome":"pass","statusCode":200,"durationMs":2}});
    assert_eq!(
        probe_request(app.clone(), "/v1/probe/results", report, Some(&credential))
            .await
            .0,
        StatusCode::CONFLICT
    );
    let (_, observations, _) = request(
        app.clone(),
        "GET",
        &format!("/v1/checks/{monitor_id}/locations"),
        Value::Null,
        true,
    )
    .await;
    assert!(observations[0]["outcome"].is_null());
    assert_eq!(observations[0]["fresh"], false);
    assert_eq!(
        monitoring::enqueue(&state, Some(monitor_id)).await.unwrap(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM probe_rounds WHERE finished_at IS NULL")
            .fetch_one(&fixture.pool)
            .await
            .unwrap(),
        1
    );
    let dashboard = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/v1/dashboard")
                .header(header::HOST, "dashboard.example.com")
                .header(header::AUTHORIZATION, format!("Bearer {credential}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(dashboard.status(), StatusCode::UNAUTHORIZED);
    let limited = fixture.app();
    for _ in 0..600 {
        assert_eq!(
            probe_request(
                limited.clone(),
                "/v1/probe/poll",
                json!({"protocolVersion":2}),
                Some(&credential)
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
    }
    assert_eq!(
        probe_request(
            limited,
            "/v1/probe/poll",
            json!({"protocolVersion":2}),
            Some(&credential)
        )
        .await
        .0,
        StatusCode::TOO_MANY_REQUESTS
    );
    let (stop, stopped) = tokio::sync::watch::channel(false);
    stop.send(true).unwrap();
    stillup_api::worker::run(state, stopped).await.unwrap();
    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL; starts bounded test-only native listeners and probe child"]
async fn standalone_rust_probe_enrolls_executes_and_drains_sigterm_report() {
    use stillup_api::monitoring;
    use uuid::Uuid;
    let fixture = Fixture::new().await;
    let state = fixture.state_configure(|config| {
        config.secrets.encryption_key = "89".repeat(32);
    });
    let app = router(state.clone());
    assert_eq!(
        request(
            app.clone(),
            "POST",
            "/v1/secrets",
            json!({"name":"TOKEN","value":"fixture-private-token"}),
            true
        )
        .await
        .0,
        StatusCode::CREATED
    );
    let (_, created, _) = request(
        app.clone(),
        "POST",
        "/v1/locations",
        json!({"name":"Standalone","region":"test"}),
        true,
    )
    .await;
    let remote = created["id"].as_str().unwrap();
    let (entered, started) = tokio::sync::oneshot::channel();
    let (release, released) = tokio::sync::oneshot::channel();
    let entered = std::sync::Arc::new(std::sync::Mutex::new(Some(entered)));
    let released = std::sync::Arc::new(tokio::sync::Mutex::new(Some(released)));
    let target = Router::new().route(
        "/",
        axum::routing::get(move |headers: axum::http::HeaderMap| {
            let entered = entered.clone();
            let released = released.clone();
            async move {
                assert_eq!(headers["authorization"], "Bearer fixture-private-token");
                if let Some(sender) = entered.lock().unwrap().take() {
                    sender.send(()).ok();
                }
                let receiver = released.lock().await.take();
                if let Some(receiver) = receiver {
                    receiver.await.ok();
                }
                (
                    StatusCode::SERVICE_UNAVAILABLE,
                    "private-body-must-not-be-sent",
                )
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let target_url = format!("http://{}/", listener.local_addr().unwrap());
    let target_server = tokio::spawn(async move { axum::serve(listener, target).await.unwrap() });
    let (_,monitor,_)=request(app.clone(),"POST","/v1/checks",json!({"name":"Standalone HTTP","url":target_url,"locationIds":[remote],"failureThreshold":1,"headers":{"Authorization":"Bearer {{TOKEN}}"}}),true).await;
    let monitor_id = Uuid::parse_str(monitor["id"].as_str().unwrap()).unwrap();
    monitoring::enqueue(&state, Some(monitor_id)).await.unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let (api_stop, api_stopped) = tokio::sync::oneshot::channel();
    let api_server = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                api_stopped.await.ok();
            })
            .await
            .unwrap()
    });
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("identity");
    let mut child = tokio::process::Command::new(env!("CARGO_BIN_EXE_stillup-probe"))
        .env_clear()
        .env("STILLUP_URL", &origin)
        .env("STILLUP_PROBE_DATA", &data)
        .env(
            "STILLUP_ENROLLMENT_TOKEN",
            created["enrollmentToken"].as_str().unwrap(),
        )
        .env("STILLUP_PROBE_ALLOW_HTTP", "true")
        .env("STILLUP_PROBE_ALLOW_PRIVATE_NETWORKS", "true")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(10), started)
        .await
        .unwrap()
        .unwrap();
    let identity: Value =
        serde_json::from_slice(&tokio::fs::read(data.join("identity.json")).await.unwrap())
            .unwrap();
    assert_eq!(identity["locationId"], remote);
    assert!(identity.get("enrollmentToken").is_none());
    assert_eq!(identity["token"].as_str().unwrap().len(), 64);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(data.join("identity.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(
            std::fs::metadata(&data).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert!(
            std::process::Command::new("kill")
                .arg("-TERM")
                .arg(child.id().unwrap().to_string())
                .status()
                .unwrap()
                .success()
        );
    }
    #[cfg(not(unix))]
    {
        panic!("This signal test requires Unix");
    }
    // Ensure SIGTERM is handled while execution is still in flight.
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    release.send(()).unwrap();
    assert!(
        tokio::time::timeout(std::time::Duration::from_secs(10), child.wait())
            .await
            .unwrap()
            .unwrap()
            .success()
    );
    let result: Value = sqlx::query_scalar("SELECT result FROM incident_events")
        .fetch_one(&fixture.pool)
        .await
        .unwrap();
    assert_eq!(result["outcome"], "fail");
    assert!(!result.to_string().contains("private-body"));
    assert!(!result.to_string().contains("fixture-private-token"));
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM runs WHERE monitor_id=$1")
            .bind(monitor_id)
            .fetch_one(&fixture.pool)
            .await
            .unwrap(),
        1
    );
    api_stop.send(()).unwrap();
    api_server.await.unwrap();
    target_server.abort();
    assert!(target_server.await.unwrap_err().is_cancelled());
    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL"]
async fn native_status_management_guards_revisions_and_filters_public_components() {
    use uuid::Uuid;
    let fixture = Fixture::new().await;
    let app = fixture.app();
    let (_,published,_)=request(app.clone(),"POST","/v1/checks",json!({"name":"Public API","url":"https://example.com/private-path","headers":{"Authorization":"private-header"},"public":true}),true).await;
    let (_,private,_)=request(app.clone(),"POST","/v1/checks",json!({"name":"Private-only-name","url":"https://example.com/private-check","public":false}),true).await;
    let public_id = published["id"].as_str().unwrap();
    let private_id = private["id"].as_str().unwrap();
    let config = json!({"title":" My status ","groups":[{"id":Uuid::new_v4(),"name":"Public group","monitorIds":[public_id]},{"id":Uuid::new_v4(),"name":"Hidden group","monitorIds":[private_id]}],"content":[{"id":Uuid::new_v4(),"title":"Help","body":"<script>plain text</script>","position":"after-services"}]});
    let input = json!({"config":config,"expectedRevision":0});
    let (a, b) = tokio::join!(
        request(
            app.clone(),
            "PUT",
            "/v1/status-management/settings",
            input.clone(),
            true
        ),
        request(
            app.clone(),
            "PUT",
            "/v1/status-management/settings",
            input,
            true
        )
    );
    assert!([a.0, b.0].contains(&StatusCode::OK));
    assert!([a.0, b.0].contains(&StatusCode::CONFLICT));
    for (path, host) in [
        ("/status", "dashboard.example.com"),
        ("/", "status.example.com"),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(path)
                    .header(header::HOST, host)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let html = std::str::from_utf8(&bytes).unwrap();
        assert!(html.contains("<title>My status</title>"));
        assert!(html.contains("name=\"theme-color\" content=\"#f6f8f7\""));
        assert!(!html.contains("Private-only-name"));
    }
    let now = chrono::Utc::now();
    let start = (now - chrono::Duration::minutes(1)).to_rfc3339();
    let end = (now + chrono::Duration::minutes(10)).to_rfc3339();
    let (status, window, _) = request(
        app.clone(),
        "POST",
        "/v1/status-management/maintenance",
        json!({"title":"Deploy","monitorIds":[public_id],"startsAt":start,"endsAt":end}),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(
        request(
            app.clone(),
            "POST",
            "/v1/status-management/maintenance",
            json!({"title":"Private","monitorIds":[private_id],"startsAt":start,"endsAt":end}),
            true
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let window_path = format!(
        "/v1/status-management/maintenance/{}",
        window["id"].as_str().unwrap()
    );
    let edit = json!({"title":"Deploy","monitorIds":[public_id,private_id],"startsAt":start,"endsAt":end,"expectedRevision":1});
    assert_eq!(
        request(app.clone(), "PUT", &window_path, edit.clone(), true)
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        request(app.clone(), "PUT", &window_path, edit, true)
            .await
            .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        request(
            app.clone(),
            "POST",
            "/v1/status-management/incidents",
            json!({"title":"Private","monitorIds":[private_id],"body":"Body"}),
            true
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let (_, incident, _) = request(
        app.clone(),
        "POST",
        "/v1/status-management/incidents",
        json!({"title":"Investigating","monitorIds":[public_id],"body":"Initial update"}),
        true,
    )
    .await;
    let updates_path = format!(
        "/v1/status-management/incidents/{}/updates",
        incident["id"].as_str().unwrap()
    );
    let update =
        json!({"source":"manual","stage":"resolved","body":"Recovered","expectedRevision":1});
    assert_eq!(
        request(app.clone(), "POST", &updates_path, update.clone(), true)
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        request(app.clone(), "POST", &updates_path, update, true)
            .await
            .0,
        StatusCode::CONFLICT
    );
    // Rollups outside the window, or for unpublished checks, are not exposed.
    sqlx::query("INSERT INTO monitor_daily_uptime(monitor_id,day,observed_seconds,down_seconds) SELECT m,d,o,x FROM (VALUES($1::uuid,0,86400,60),($1,400,86400,86400),($2,0,60,60)) v(m,ago,o,x),LATERAL (SELECT (now() AT TIME ZONE 'UTC')::date-ago AS d) t")
        .bind(Uuid::parse_str(public_id).unwrap())
        .bind(Uuid::parse_str(private_id).unwrap())
        .execute(&fixture.pool)
        .await
        .unwrap();
    let (status, public, _) = request(
        app.clone(),
        "GET",
        "/api/v1/public/status",
        Value::Null,
        false,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(public["title"], "My status");
    assert_eq!(public["components"].as_array().unwrap().len(), 1);
    assert_eq!(public["components"][0]["health"], "maintenance");
    assert_eq!(public["groups"].as_array().unwrap().len(), 1);
    assert_eq!(public["maintenance"][0]["monitorIds"], json!([public_id]));
    assert_eq!(public["communications"][0]["stage"], "resolved");
    assert_eq!(public["components"][0]["uptime"]["percentage"], 99.93);
    assert_eq!(
        public["components"][0]["uptime"]["days"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let serialized = public.to_string();
    for secret in [
        private_id,
        "Private-only-name",
        "Hidden group",
        "private-path",
        "private-header",
    ] {
        assert!(!serialized.contains(secret));
    }
    assert!(public["branding"].get("groups").is_none());
    let cancelled = json!({"title":"Deploy","monitorIds":[public_id],"startsAt":start,"endsAt":end,"expectedRevision":2,"cancelled":true});
    assert_eq!(
        request(app.clone(), "PUT", &window_path, cancelled, true)
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        request(
            app.clone(),
            "POST",
            &updates_path,
            json!({"source":"manual","stage":"identified","body":"Reopened","expectedRevision":2}),
            true
        )
        .await
        .0,
        StatusCode::OK
    );
    let (_, public, _) = request(app.clone(), "GET", "/v1/public/status", Value::Null, false).await;
    assert_eq!(public["components"][0]["health"], "down");
    assert_eq!(public["communications"][0]["stage"], "identified");
    let automatic: Uuid = sqlx::query_scalar(
        "INSERT INTO incidents(monitor_id,name) VALUES($1,'Automatic API') RETURNING id",
    )
    .bind(Uuid::parse_str(public_id).unwrap())
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    let automatic_path = format!("/v1/status-management/incidents/{automatic}/updates");
    let resolve =
        json!({"source":"automatic","stage":"resolved","body":"Resolved","expectedRevision":1});
    assert_eq!(
        request(app.clone(), "POST", &automatic_path, resolve.clone(), true)
            .await
            .0,
        StatusCode::CONFLICT
    );
    sqlx::query("UPDATE incidents SET resolved_at=now() WHERE id=$1")
        .bind(automatic)
        .execute(&fixture.pool)
        .await
        .unwrap();
    assert_eq!(
        request(app.clone(), "POST", &automatic_path, resolve, true)
            .await
            .0,
        StatusCode::OK
    );
    let (_, admin, _) = request(
        app.clone(),
        "GET",
        "/v1/status-management",
        Value::Null,
        true,
    )
    .await;
    assert_eq!(admin["revision"], 1);
    assert_eq!(admin["incidents"].as_array().unwrap().len(), 2);
    assert_eq!(
        request(
            app.clone(),
            "GET",
            "/v1/status-management",
            Value::Null,
            false
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/api/v1/public/status")
                .header(header::HOST, "status.example.com")
                .header(header::COOKIE, "stillup_session=invalid")
                .header(header::AUTHORIZATION, "Bearer invalid")
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
                .method("POST")
                .uri("/v1/status-management/incidents")
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
    assert_eq!(
        request(
            app.clone(),
            "POST",
            &format!("/v1/checks/{public_id}/archive"),
            json!({"expectedRevision":1}),
            true
        )
        .await
        .0,
        StatusCode::OK
    );
    let (_, empty, _) = request(app.clone(), "GET", "/v1/public/status", Value::Null, false).await;
    for key in [
        "components",
        "groups",
        "maintenance",
        "incidents",
        "communications",
    ] {
        assert!(empty[key].as_array().unwrap().is_empty(), "{key}");
    }
    fixture.pool.close().await;
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/status")
                .header(header::HOST, "dashboard.example.com")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    assert!(
        std::str::from_utf8(&bytes)
            .unwrap()
            .contains("<title>Service status</title>")
    );
    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL"]
async fn code_plan_apply_preserves_ownership_state_and_rejects_drift_atomically() {
    use uuid::Uuid;
    let fixture = Fixture::new().await;
    let app = fixture.app();
    let config = json!({"version":1,"project":"production","checks":[{"id":"api","config":{"name":"API","url":"https://example.com","headers":{"Authorization":"private-token","Accept":"json"}}},{"id":"worker","config":{"name":"Worker","url":"https://example.com/worker"}}]});
    let (status, plan, _) =
        request(app.clone(), "POST", "/v1/code/plan", config.clone(), true).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(plan["changes"][0]["action"], "create");
    assert!(!plan.to_string().contains("private-token"));
    let apply = json!({"config":config,"token":plan["token"]});
    let (a, b) = tokio::join!(
        request(app.clone(), "POST", "/v1/code/apply", apply.clone(), true),
        request(app.clone(), "POST", "/v1/code/apply", apply, true)
    );
    assert!([a.0, b.0].contains(&StatusCode::OK));
    assert!([a.0, b.0].contains(&StatusCode::CONFLICT));
    let (_, plan, _) = request(app.clone(), "POST", "/v1/code/plan", config.clone(), true).await;
    assert_eq!(plan["changes"][0]["action"], "unchanged");
    let api_id = plan["changes"][0]["monitorId"].as_str().unwrap();
    let worker_id = plan["changes"][1]["monitorId"].as_str().unwrap();
    let reordered = json!({"version":1,"project":"production","checks":[{"id":"worker","config":{"name":"Worker","url":"https://example.com/worker"}},{"id":"api","config":{"name":"API","url":"https://example.com","headers":{"Accept":"json","Authorization":"private-token"}}}]});
    let (_, same, _) = request(
        app.clone(),
        "POST",
        "/api/v1/code/plan",
        reordered.clone(),
        true,
    )
    .await;
    assert_eq!(same["token"], plan["token"]);
    assert_eq!(
        request(
            app.clone(),
            "POST",
            "/v1/code/apply",
            json!({"config":reordered,"token":plan["token"]}),
            true
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM check_revisions")
            .fetch_one(&fixture.pool)
            .await
            .unwrap(),
        2
    );
    assert_eq!(
        request(
            app.clone(),
            "PATCH",
            &format!("/v1/checks/{api_id}"),
            json!({"enabled":false,"expectedRevision":1}),
            true
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        request(
            app.clone(),
            "POST",
            "/v1/code/apply",
            json!({"config":config,"token":plan["token"]}),
            true
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let mut changed = config.clone();
    changed["checks"][0]["config"]["name"] = json!("Updated API");
    let (_, fresh, _) = request(app.clone(), "POST", "/v1/code/plan", changed.clone(), true).await;
    assert_eq!(fresh["changes"][0]["fields"], json!(["name"]));
    assert_eq!(fresh["changes"][0]["paused"], true);
    assert_eq!(
        request(
            app.clone(),
            "POST",
            "/v1/code/apply",
            json!({"config":changed,"token":fresh["token"]}),
            true
        )
        .await
        .0,
        StatusCode::OK
    );
    let (_, updated, _) = request(
        app.clone(),
        "GET",
        &format!("/v1/checks/{api_id}"),
        Value::Null,
        true,
    )
    .await;
    assert_eq!(updated["enabled"], false);
    assert_eq!(updated["configRevision"], 2);
    assert_eq!(updated["codeOwnership"]["id"], "api");
    assert_eq!(
        request(
            app.clone(),
            "PUT",
            &format!("/v1/checks/{api_id}"),
            json!({"config":{"name":"UI edit","url":"https://example.com"},"expectedRevision":2}),
            true
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        request(
            app.clone(),
            "POST",
            &format!("/v1/checks/{worker_id}/archive"),
            json!({"expectedRevision":1}),
            true
        )
        .await
        .0,
        StatusCode::OK
    );
    let mut atomic = changed.clone();
    atomic["checks"][0]["config"]["name"] = json!("Must roll back");
    atomic["checks"][1]["config"]["name"] = json!("Archived edit");
    let (_, preview, _) = request(app.clone(), "POST", "/v1/code/plan", atomic.clone(), true).await;
    assert_eq!(
        request(
            app.clone(),
            "POST",
            "/v1/code/apply",
            json!({"config":atomic,"token":preview["token"]}),
            true
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let (_, current, _) = request(
        app.clone(),
        "GET",
        &format!("/v1/checks/{api_id}"),
        Value::Null,
        true,
    )
    .await;
    assert_eq!(current["config"]["name"], "Updated API");
    assert_eq!(current["configRevision"], 2);
    let retain = json!({"version":1,"project":"production","checks":[]});
    let (_, plan, _) = request(app.clone(), "POST", "/v1/code/plan", retain.clone(), true).await;
    assert_eq!(plan["changes"].as_array().unwrap().len(), 2);
    assert!(
        plan["changes"]
            .as_array()
            .unwrap()
            .iter()
            .all(|c| c["action"] == "retained")
    );
    assert_eq!(
        request(
            app.clone(),
            "POST",
            "/v1/code/apply",
            json!({"config":retain,"token":plan["token"]}),
            true
        )
        .await
        .0,
        StatusCode::OK
    );
    let independent = json!({"version":1,"project":"other","checks":[{"id":"api","config":{"name":"Other","url":"https://example.com"}}]});
    let (_, plan, _) = request(
        app.clone(),
        "POST",
        "/v1/code/plan",
        independent.clone(),
        true,
    )
    .await;
    assert_eq!(
        request(
            app.clone(),
            "POST",
            "/v1/code/apply",
            json!({"config":independent,"token":plan["token"]}),
            true
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM monitors")
            .fetch_one(&fixture.pool)
            .await
            .unwrap(),
        3
    );
    let invalid = json!({"version":1,"project":"bad","checks":[{"id":"api","config":{"name":"Bad","url":"https://example.com","notificationChannelIds":[Uuid::new_v4()]}}]});
    assert_eq!(
        request(app, "POST", "/v1/code/plan", invalid, true).await.0,
        StatusCode::BAD_REQUEST
    );
    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL"]
async fn revision_routes_coerce_numbers_and_reject_repeated_query_values() {
    let fixture = Fixture::new().await;
    let app = fixture.app();
    let (status, check, _) = request(
        app.clone(),
        "POST",
        "/v1/checks",
        json!({"name":"Query contract","url":"https://example.com"}),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let id = check["id"].as_str().unwrap();
    for before in [
        "1e2",
        "0x10",
        "0b10",
        "0o10",
        "2.0",
        "%EF%BB%BF2",
        "9007199254740991",
        "2147483648",
    ] {
        let (status, page, _) = request(
            app.clone(),
            "GET",
            &format!("/v1/checks/{id}/revisions?before={before}"),
            Value::Null,
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{before}");
        assert_eq!(page["revisions"][0]["revision"], 1);
    }
    for number in ["1e0", "0x1", "1.0"] {
        let (status, revision, _) = request(
            app.clone(),
            "GET",
            &format!("/v1/checks/{id}/revisions/{number}"),
            Value::Null,
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(revision["revision"], 1);
    }
    assert_eq!(
        request(
            app.clone(),
            "GET",
            &format!("/v1/checks/{id}/revisions/2147483648"),
            Value::Null,
            true
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    for before in [
        "1.5",
        "9007199254740992",
        "0x%2B1",
        "before",
        "0",
        "1&before=2",
    ] {
        let (status, error, headers) = request(
            app.clone(),
            "GET",
            &format!("/v1/checks/{id}/revisions?before={before}"),
            Value::Null,
            true,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{before}");
        assert!(error["error"].is_string());
        assert!(
            headers[header::CONTENT_TYPE]
                .to_str()
                .unwrap()
                .starts_with("application/json")
        );
    }
    let uuid = uuid::Uuid::new_v4();
    assert_eq!(
        request(
            app.clone(),
            "GET",
            &format!("/v1/checks/{uuid}/revisions?before=invalid"),
            Value::Null,
            true
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    for path in [
        format!("/v1/notification-deliveries?incidentId={uuid}&incidentId={uuid}"),
        format!("/v1/notification-deliveries?before={uuid}&before={uuid}"),
        format!("/v1/incidents/{uuid}?before={uuid}&before={uuid}"),
    ] {
        let (status, error, _) = request(app.clone(), "GET", &path, Value::Null, true).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(error["error"].is_string());
    }
    for path in [
        format!(
            "/v1/checks/{id}/revisions?ignored=1&ignored=2&incidentId=unknown&incidentId=also-unknown"
        ),
        "/v1/notification-deliveries?ignored=1&ignored=2".into(),
    ] {
        assert_eq!(
            request(app.clone(), "GET", &path, Value::Null, true)
                .await
                .0,
            StatusCode::OK
        );
    }
    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL"]
async fn wide_revision_guards_return_conflicts_instead_of_storage_range_errors() {
    let fixture = Fixture::new().await;
    let app = fixture.app_configure(|config| config.secrets.encryption_key = "11".repeat(32));
    let monitor: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO monitors(config) VALUES('{\"name\":\"Wide guard\"}') RETURNING id",
    )
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    let channel: uuid::Uuid = sqlx::query_scalar("INSERT INTO notification_channels(name,url) VALUES('Wide guard','https://example.com/hook') RETURNING id").fetch_one(&fixture.pool).await.unwrap();
    let window: uuid::Uuid = sqlx::query_scalar("INSERT INTO maintenance_windows(title,starts_at,ends_at) VALUES('Wide guard',now(),now()+interval '1 hour') RETURNING id").fetch_one(&fixture.pool).await.unwrap();
    let incident: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO status_incidents(title,monitor_ids) VALUES('Wide guard','{}') RETURNING id",
    )
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO managed_secrets(name,encrypted_value) VALUES('WIDE_GUARD','{}')")
        .execute(&fixture.pool)
        .await
        .unwrap();
    for revision in [
        2_147_483_648_i64,
        stillup_api::check_config::MAX_SAFE_INTEGER,
        stillup_api::check_config::MAX_SAFE_INTEGER + 1,
    ] {
        let expected = if revision <= stillup_api::check_config::MAX_SAFE_INTEGER {
            StatusCode::CONFLICT
        } else {
            StatusCode::BAD_REQUEST
        };
        for (method, path, body) in [
            (
                "PATCH",
                format!("/v1/checks/{monitor}"),
                json!({"enabled":false,"expectedRevision":revision}),
            ),
            (
                "PUT",
                "/v1/workspace".into(),
                json!({"config":{},"expectedRevision":revision}),
            ),
            (
                "PUT",
                "/v1/status-management/settings".into(),
                json!({"config":{"title":"Wide guard"},"expectedRevision":revision}),
            ),
            (
                "PUT",
                format!("/v1/notification-channels/{channel}"),
                json!({"name":"Wide guard","url":"https://example.com/hook","expectedRevision":revision}),
            ),
            (
                "PUT",
                "/v1/secrets/WIDE_GUARD".into(),
                json!({"enabled":false,"expectedRevision":revision}),
            ),
            (
                "PUT",
                format!("/v1/status-management/maintenance/{window}"),
                json!({"title":"Wide guard","startsAt":"2026-10-05T00:00:00Z","endsAt":"2026-10-05T01:00:00Z","expectedRevision":revision}),
            ),
            (
                "POST",
                format!("/v1/status-management/incidents/{incident}/updates"),
                json!({"source":"manual","stage":"investigating","body":"Wide guard","expectedRevision":revision}),
            ),
        ] {
            let (status, body, _) = request(app.clone(), method, &path, body, true).await;
            assert_eq!(status, expected, "{method} {path}: {body}");
            assert!(body["error"].is_string());
        }
    }
    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL"]
async fn native_pool_replaces_terminated_idle_connections() {
    let fixture = Fixture::empty().await;
    let url = std::env::var("TEST_DATABASE_URL").unwrap();
    let pool = database::pool_options(1).connect(&url).await.unwrap();
    let original: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(
        sqlx::query_scalar::<_, bool>("SELECT pg_terminate_backend($1)")
            .bind(original)
            .fetch_one(&fixture.admin)
            .await
            .unwrap()
    );
    tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
    let replacement: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_ne!(original, replacement);
    pool.close().await;
    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL"]
async fn login_utf16_limits_and_dashboard_effective_channels_match_legacy() {
    let fixture = Fixture::new().await;
    for (length, expected) in [
        (512, StatusCode::UNAUTHORIZED),
        (513, StatusCode::BAD_REQUEST),
    ] {
        let (status, _, _) = request(
            fixture.app(),
            "POST",
            "/v1/session",
            json!({"token":"🙂".repeat(length)}),
            false,
        )
        .await;
        assert_eq!(status, expected);
    }
    stillup_api::notifications::initialize(&fixture.pool, "https://example.com/hook")
        .await
        .unwrap();
    for (url, enabled) in [("", false), ("https://example.com/hook", true)] {
        let app = fixture.app_configure(|config| config.alert_webhook_url = url.into());
        let (_, dashboard, _) =
            request(app.clone(), "GET", "/v1/dashboard", Value::Null, true).await;
        let (_, channels, _) =
            request(app, "GET", "/v1/notification-channels", Value::Null, true).await;
        assert_eq!(dashboard["notificationsEnabled"], enabled);
        assert_eq!(channels[0]["enabled"], enabled);
    }
    sqlx::query("INSERT INTO notification_channels(name,url) VALUES('Managed','https://example.com/managed')").execute(&fixture.pool).await.unwrap();
    let (_, dashboard, _) = request(fixture.app(), "GET", "/v1/dashboard", Value::Null, true).await;
    assert_eq!(dashboard["notificationsEnabled"], true);
    fixture.close().await;
}
