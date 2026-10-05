use crate::server::AppState;
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
    routes(config.clone()).layer(middleware::from_fn_with_state(
        config,
        headers_and_public_host,
    ))
}

pub fn routes(config: WebConfig) -> Router {
    page_routes(PageState { config, app: None })
}

pub fn application_routes(app: AppState) -> Router {
    page_routes(PageState {
        config: app.config.web.clone(),
        app: Some(app),
    })
}

#[derive(Clone)]
struct PageState {
    config: WebConfig,
    app: Option<AppState>,
}

fn page_routes(state: PageState) -> Router {
    let config = &state.config;
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
        .with_state(state)
}

async fn document(State(state): State<PageState>, request: Request) -> Response {
    let config = &state.config;
    let path = request.uri().path();
    let document = if path == "/docs" {
        config.client_dir.join("docs/index.html")
    } else if let Some(slug) = path.strip_prefix("/docs/") {
        if slug.is_empty() || !slug.bytes().all(|c| c.is_ascii_lowercase() || c == b'-') {
            return docs_not_found();
        }
        config.client_dir.join("docs").join(slug).join("index.html")
    } else {
        config.client_dir.join("index.html")
    };
    let public = status_domain::is_status_domain(
        request
            .headers()
            .get(header::HOST)
            .and_then(|v| v.to_str().ok())
            .unwrap_or(""),
        &config.status_domains,
    );
    match tokio::fs::read_to_string(document).await {
        Ok(mut html) => {
            if public || path == "/status" {
                let settings = if let Some(app) = &state.app {
                    match crate::status::settings(app).await {
                        Ok(value) => value["settings"].clone(),
                        Err(_) => crate::status::settings_schema(&serde_json::json!({
                            "title": app.config.status_page_title
                        }))
                        .unwrap(),
                    }
                } else {
                    crate::status::settings_schema(&serde_json::json!({"title":"Service status"}))
                        .unwrap()
                };
                html = status_metadata(html, &settings);
            }
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
        Err(error) if path.starts_with("/docs") && error.kind() == std::io::ErrorKind::NotFound => {
            docs_not_found()
        }
        Err(_) => (
            StatusCode::SERVICE_UNAVAILABLE,
            "Frontend build is unavailable",
        )
            .into_response(),
    }
}

fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn replace_tag(html: &mut String, start: &str, end: &str, replacement: &str) {
    if let Some(from) = html.find(start)
        && let Some(length) = html[from..].find(end)
    {
        html.replace_range(from..from + length + end.len(), replacement);
    }
}

fn status_metadata(mut html: String, settings: &serde_json::Value) -> String {
    let text = |key: &str| settings[key].as_str().unwrap_or("");
    replace_tag(
        &mut html,
        "<title>",
        "</title>",
        &format!("<title>{}</title>", escape(text("title"))),
    );
    replace_tag(
        &mut html,
        "<meta name=\"description\"",
        ">",
        &format!(
            "<meta name=\"description\" content=\"{}\" />",
            escape(text("description"))
        ),
    );
    let favicon = if text("faviconUrl").is_empty() {
        "/brand/stillup-favicon.svg"
    } else {
        text("faviconUrl")
    };
    replace_tag(
        &mut html,
        "<link rel=\"icon\"",
        ">",
        &format!("<link rel=\"icon\" href=\"{}\" />", escape(favicon)),
    );
    let light = text("backgroundColor");
    let dark = if text("darkBackgroundColor").is_empty() {
        "#0a0b0c"
    } else {
        text("darkBackgroundColor")
    };
    let colors = match text("theme") {
        "auto" => format!(
            "<meta name=\"theme-color\" content=\"{light}\" media=\"(prefers-color-scheme: light)\" /><meta name=\"theme-color\" content=\"{dark}\" media=\"(prefers-color-scheme: dark)\" />"
        ),
        "dark" => format!("<meta name=\"theme-color\" content=\"{dark}\" />"),
        _ => format!("<meta name=\"theme-color\" content=\"{light}\" />"),
    };
    html.replace("</head>", &format!("{colors}</head>"))
}

fn docs_not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        Html("<!doctype html><html lang=\"en\"><head><meta charset=\"UTF-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Guide not found · StillUp</title></head><body><main><h1>Guide not found</h1><p>This documentation page does not exist.</p><a href=\"/docs\">Browse documentation</a></main></body></html>"),
    ).into_response()
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
    #[test]
    fn status_metadata_escapes_branding_and_matches_theme_modes() {
        let template = "<head><title>StillUp</title><meta name=\"description\" content=\"Default\" /><link rel=\"icon\" href=\"/brand/stillup-favicon.svg\" /></head>";
        let settings = crate::status::settings_schema(&serde_json::json!({
            "title":"API <status> & uptime",
            "description":"\"Live\" <script> text",
            "faviconUrl":"https://example.com/icon?a=1&b=2",
            "theme":"auto","backgroundColor":"#abcdef","darkBackgroundColor":"#123456"
        }))
        .unwrap();
        let html = status_metadata(template.into(), &settings);
        assert!(html.contains("<title>API &lt;status&gt; &amp; uptime</title>"));
        assert!(html.contains("content=\"&quot;Live&quot; &lt;script&gt; text\""));
        assert!(html.contains("href=\"https://example.com/icon?a=1&amp;b=2\""));
        assert!(html.contains("content=\"#abcdef\" media=\"(prefers-color-scheme: light)\""));
        assert!(html.contains("content=\"#123456\" media=\"(prefers-color-scheme: dark)\""));
        let default =
            crate::status::settings_schema(&serde_json::json!({"title":"Default","theme":"dark"}))
                .unwrap();
        let html = status_metadata(template.into(), &default);
        assert!(html.contains("href=\"/brand/stillup-favicon.svg\""));
        assert!(html.contains("content=\"#0a0b0c\""));
        assert!(!html.contains("prefers-color-scheme"));
    }
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

    #[tokio::test]
    async fn docs_serve_static_prose_and_unknown_guides_return_html_404() {
        let (dir, config) = setup();
        std::fs::create_dir_all(dir.path().join("docs/getting-started")).unwrap();
        std::fs::write(dir.path().join("docs/index.html"), "<h1>Documentation</h1>").unwrap();
        std::fs::write(
            dir.path().join("docs/getting-started/index.html"),
            "<h1>Your first check</h1><p>Static guide prose.</p>",
        )
        .unwrap();
        let app = router(config);
        for (path, text) in [
            ("/docs", "Documentation"),
            ("/docs/getting-started", "Static guide prose."),
        ] {
            let response = call(app.clone(), path, "dashboard.example.com").await;
            assert_eq!(response.status(), StatusCode::OK);
            let body = response.into_body().collect().await.unwrap().to_bytes();
            assert!(std::str::from_utf8(&body).unwrap().contains(text));
        }
        for path in ["/docs/missing", "/docs/%2e%2e", "/docs/%2findex"] {
            let response = call(app.clone(), path, "dashboard.example.com").await;
            assert_eq!(response.status(), StatusCode::NOT_FOUND);
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
            assert_eq!(
                response.headers()[header::CONTENT_TYPE],
                "text/html; charset=utf-8"
            );
        }
    }
}
