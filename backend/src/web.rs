use crate::status_domain::{self, Action};
use axum::{
    Router,
    extract::{Request, State},
    http::{StatusCode, header},
    middleware::{self, Next},
    response::{Html, IntoResponse, Response},
    routing::get,
};
use std::path::PathBuf;
use tower_http::services::ServeDir;

#[derive(Clone)]
pub struct WebConfig {
    pub client_dir: PathBuf,
    pub status_domains: String,
}

// API routers are merged before this layer is installed. Unknown API paths must never
// return the SPA document, and public hosts never carry dashboard credentials downstream.
pub fn router(config: WebConfig) -> Router {
    Router::new()
        .route("/", get(document))
        .route("/login", get(document))
        .route("/status", get(document))
        .route("/docs", get(document))
        .route("/docs/{slug}", get(document))
        .nest_service("/assets", ServeDir::new(config.client_dir.join("assets")))
        .nest_service("/brand", ServeDir::new(config.client_dir.join("brand")))
        .nest_service(
            "/illustrations",
            ServeDir::new(config.client_dir.join("illustrations")),
        )
        .with_state(config.clone())
        .layer(middleware::from_fn_with_state(
            config,
            headers_and_public_host,
        ))
}

async fn document(State(config): State<WebConfig>, request: Request) -> Response {
    let public = status_domain::is_status_domain(
        request
            .headers()
            .get(header::HOST)
            .and_then(|v| v.to_str().ok())
            .unwrap_or(""),
        &config.status_domains,
    );
    match tokio::fs::read_to_string(config.client_dir.join("index.html")).await {
        Ok(html) => {
            let html = if public {
                html.replace(
                    "data-product=\"stillup\"",
                    "data-product=\"stillup\" data-page=\"status\"",
                )
            } else {
                html
            };
            Html(html).into_response()
        }
        Err(_) => (
            StatusCode::SERVICE_UNAVAILABLE,
            "Frontend build is unavailable",
        )
            .into_response(),
    }
}

pub async fn headers_and_public_host(
    State(config): State<WebConfig>,
    mut request: Request,
    next: Next,
) -> Response {
    let public = status_domain::is_status_domain(
        request
            .headers()
            .get(header::HOST)
            .and_then(|v| v.to_str().ok())
            .unwrap_or(""),
        &config.status_domains,
    );
    if public {
        if status_domain::action(request.uri().path(), request.method().as_str()) == Action::Deny {
            let mut response = (StatusCode::NOT_FOUND, "Not found").into_response();
            response
                .headers_mut()
                .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
            response
                .headers_mut()
                .insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
            return response;
        }
        request.headers_mut().remove(header::COOKIE);
        request.headers_mut().remove(header::AUTHORIZATION);
    }
    let immutable = request.uri().path().starts_with("/assets/");
    let mut response = next.run(request).await;
    let cache = if immutable && response.status().is_success() {
        "public, max-age=31536000, immutable"
    } else {
        "no-store"
    };
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, cache.parse().unwrap());
    response
        .headers_mut()
        .insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use http_body_util::BodyExt;
    use tower::ServiceExt;
    fn setup() -> (tempfile::TempDir, WebConfig) {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("index.html"),
            "<html data-product=\"stillup\"><body>SPA</body></html>",
        )
        .unwrap();
        std::fs::create_dir(dir.path().join("assets")).unwrap();
        std::fs::write(dir.path().join("assets/test-abcd.js"), "export {};").unwrap();
        let config = WebConfig {
            client_dir: dir.path().into(),
            status_domains: "status.example.com".into(),
        };
        (dir, config)
    }
    async fn call(router: Router, path: &str, host: &str) -> Response {
        router
            .oneshot(
                Request::builder()
                    .uri(path)
                    .header(header::HOST, host)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap()
    }
    #[tokio::test]
    async fn public_root_renders_status_and_denies_administration() {
        let (_dir, config) = setup();
        let app = router(config);
        let response = call(app.clone(), "/", "status.example.com").await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        let body = response.into_body().collect().await.unwrap().to_bytes();
        assert!(
            std::str::from_utf8(&body)
                .unwrap()
                .contains("data-page=\"status\"")
        );
        for path in [
            "/login",
            "/docs",
            "/api/v1/status-management",
            "/api/v1/public/workspace",
        ] {
            assert_eq!(
                call(app.clone(), path, "status.example.com").await.status(),
                StatusCode::NOT_FOUND
            );
        }
    }
    #[tokio::test]
    async fn public_api_strips_dashboard_credentials() {
        let (_dir, config) = setup();
        let app = Router::new()
            .route(
                "/api/v1/public/status",
                get(|request: Request| async move {
                    assert!(!request.headers().contains_key(header::COOKIE));
                    assert!(!request.headers().contains_key(header::AUTHORIZATION));
                    "public status"
                }),
            )
            .layer(middleware::from_fn_with_state(
                config,
                headers_and_public_host,
            ));
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/v1/public/status")
                    .header(header::HOST, "status.example.com")
                    .header(header::COOKIE, "stillup_session=private")
                    .header(header::AUTHORIZATION, "Bearer private")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn unknown_api_paths_and_missing_assets_are_not_spa_successes() {
        let (_dir, config) = setup();
        let app = router(config);
        for path in ["/api/v1/missing", "/assets/missing.js", "/missing"] {
            let response = call(app.clone(), path, "dashboard.example.com").await;
            assert_eq!(response.status(), StatusCode::NOT_FOUND);
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        }
        let response = call(app, "/assets/test-abcd.js", "status.example.com").await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[header::CACHE_CONTROL],
            "public, max-age=31536000, immutable"
        );
    }
}
