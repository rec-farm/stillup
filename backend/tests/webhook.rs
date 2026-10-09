use axum::{Json, Router, extract::Request, http::StatusCode, routing::post};
use serde_json::json;
use stillup_api::webhook::{send, target_url};

#[tokio::test]
async fn webhook_preserves_identity_acknowledges_status_and_blocks_unsafe_targets() {
    let app = Router::new()
        .route(
            "/ok",
            post(|request: Request| async move {
                assert_eq!(request.headers()["idempotency-key"], "delivery-fixture");
                assert_eq!(request.headers()["user-agent"], "StillUp/0.1");
                assert_eq!(request.headers()["content-type"], "application/json");
                let bytes = axum::body::to_bytes(request.into_body(), 4096)
                    .await
                    .unwrap();
                let payload: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
                assert_eq!(
                    payload,
                    json!({"type":"incident.opened","eventId":"delivery-fixture"})
                );
                StatusCode::NO_CONTENT
            }),
        )
        .route(
            "/reject",
            post(|| async {
                (
                    StatusCode::BAD_GATEWAY,
                    Json(json!({"secret":"must never be retained"})),
                )
            }),
        )
        .route(
            "/redirect",
            post(|| async {
                (
                    StatusCode::FOUND,
                    [("location", "http://169.254.169.254/latest")],
                )
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let payload = json!({"type":"incident.opened","eventId":"overridden"});
    let result = send(&format!("{origin}/ok"), &payload, "delivery-fixture", true).await;
    assert_eq!(result.status_code, Some(204));
    assert_eq!(result.error, None);
    for (path, code) in [("reject", 502), ("redirect", 302)] {
        let result = send(
            &format!("{origin}/{path}"),
            &payload,
            "delivery-fixture",
            true,
        )
        .await;
        assert_eq!(result.status_code, Some(code));
        assert_eq!(result.error, Some(format!("Webhook returned HTTP {code}")));
    }
    let result = send(&format!("{origin}/ok"), &payload, "delivery-fixture", false).await;
    assert_eq!(result.status_code, None);
    assert!(!result.error.unwrap().contains(&origin));
    for target in [
        "file:///etc/passwd",
        "https://user:secret@example.com",
        "https://example.com/#secret",
        "{{TOKEN}}",
    ] {
        assert!(target_url(target).is_none());
        assert_eq!(
            send(target, &payload, "delivery-fixture", false)
                .await
                .status_code,
            None
        );
    }
    server.abort();
    assert!(server.await.unwrap_err().is_cancelled());
}
