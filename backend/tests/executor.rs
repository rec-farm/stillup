use axum::{
    Router, body::Body, extract::Request, http::StatusCode, response::IntoResponse, routing::get,
};
use serde_json::json;
use std::{collections::HashMap, time::Duration};
use stillup_api::executor::{Options, execute};
#[tokio::test]
async fn actual_http_checks_assertions_secrets_limits_timeouts_and_no_redirects() {
    let app = Router::new()
        .route(
            "/health",
            get(|| async { ([("x-health", "okay")], "{\"ok\":true,\"items\":[1,2]}") }),
        )
        .route(
            "/secret",
            get(|request: Request| async move {
                assert_eq!(request.headers()["authorization"], "Bearer fixture-secret");
                "{}"
            }),
        )
        .route(
            "/redirect",
            get(|| async {
                (
                    StatusCode::FOUND,
                    [("location", "http://169.254.169.254/latest")],
                )
            }),
        )
        .route(
            "/huge",
            get(|| async { Body::from(vec![b'x'; 1024 * 1024 + 1]).into_response() }),
        )
        .route(
            "/slow",
            get(|| async {
                tokio::time::sleep(Duration::from_millis(300)).await;
                "{}"
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                stopped.await.ok();
            })
            .await
            .unwrap();
    });
    let options = Options {
        allow_private_networks: true,
        secrets: HashMap::from([("CHECK_SECRET_TOKEN".into(), "fixture-secret".into())]),
    };
    let config = json!({"name":"Health","url":format!("{origin}/health"),"headerAssertions":[{"name":"x-health","operator":"equals","value":"okay"}],"jsonAssertions":[{"path":"$.ok","equals":true},{"path":"$.items","operator":"length","value":2}],"responseSchema":{"type":"object","required":["ok"]}});
    let result = execute(&config, &options).await;
    assert_eq!(result["outcome"], "pass");
    assert_eq!(result["assertions"].as_array().unwrap().len(), 5);
    let config = json!({"name":"Secret","url":format!("{origin}/secret"),"headers":{"Authorization":"Bearer {{TOKEN}}"}});
    assert_eq!(
        execute(
            &config,
            &Options {
                allow_private_networks: true,
                ..Default::default()
            }
        )
        .await["outcome"],
        "error"
    );
    assert_eq!(execute(&config, &options).await["outcome"], "pass");
    let config = json!({"name":"Redirect","url":format!("{origin}/redirect"),"expectedStatus":302});
    assert_eq!(execute(&config, &options).await["outcome"], "pass");
    let config = json!({"name":"Huge","url":format!("{origin}/huge")});
    let result = execute(&config, &options).await;
    assert_eq!(result["outcome"], "fail");
    assert_eq!(result["statusCode"], 200);
    let config = json!({"name":"Slow","url":format!("{origin}/slow"),"timeoutMs":100});
    let result = execute(&config, &options).await;
    assert_eq!(result["outcome"], "fail");
    assert_eq!(result["failures"][0], "Request timed out after 100 ms");
    stop.send(()).unwrap();
    server.await.unwrap();
}
