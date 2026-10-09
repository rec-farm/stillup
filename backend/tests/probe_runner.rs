use serde_json::json;
use stillup_api::probe_runner::{Options, load_identity};
#[tokio::test]
async fn identity_compatibility_origin_binding_and_corruption_preservation() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let options = Options::parse(
        "https://stillup.example.com",
        data.clone(),
        Some("ab".repeat(32)),
        false,
        false,
    )
    .unwrap();
    let initial = load_identity(&options).await.unwrap();
    assert_eq!(initial.enrollment_token, options.enrollment_token);
    let repeated = load_identity(&Options {
        enrollment_token: Some("cd".repeat(32)),
        ..options.clone()
    })
    .await
    .unwrap();
    assert_eq!(initial.token, repeated.token);
    assert_eq!(repeated.enrollment_token, initial.enrollment_token);
    let existing = json!({"token":"ef".repeat(32),"locationId":"00000000-0000-4000-8000-000000000001","origin":"https://stillup.example.com"});
    tokio::fs::write(data.join("identity.json"), existing.to_string())
        .await
        .unwrap();
    let identity = load_identity(&options).await.unwrap();
    assert_eq!(identity.token, "ef".repeat(32));
    assert!(identity.enrollment_token.is_none());
    let wrong = Options::parse(
        "https://other.example.com",
        data.clone(),
        None,
        false,
        false,
    )
    .unwrap();
    assert!(
        load_identity(&wrong)
            .await
            .err()
            .unwrap()
            .contains("different StillUp")
    );
    for invalid in ["not JSON".into(),json!({"token":"ef".repeat(32),"enrollmentToken":null,"origin":"https://stillup.example.com"}).to_string()] {
        tokio::fs::write(data.join("identity.json"),&invalid).await.unwrap();assert!(load_identity(&options).await.is_err());assert_eq!(tokio::fs::read_to_string(data.join("identity.json")).await.unwrap(),invalid);
    }
    for origin in [
        "https://user:secret@example.com",
        "https://example.com/path",
        "https://example.com/?key=secret",
        "https://example.com/#secret",
        "file:///tmp",
    ] {
        assert!(Options::parse(origin, data.clone(), None, false, false).is_err());
    }
    assert!(Options::parse("http://127.0.0.1:3001", data.clone(), None, false, false).is_err());
    assert!(Options::parse("http://127.0.0.1:3001", data, None, true, false).is_ok());
}

#[tokio::test]
async fn lost_enrollment_and_report_acknowledgements_reuse_persisted_identity_and_result() {
    use axum::{Json, Router, http::StatusCode, routing::post};
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    };
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let enrollment = "ab".repeat(32);
    let enrolled = Arc::new(AtomicUsize::new(0));
    let reports = Arc::new(Mutex::new(Vec::new()));
    let polls = Arc::new(AtomicUsize::new(0));
    let (stop, stopped) = tokio::sync::watch::channel(false);
    let e = enrolled.clone();
    let d = data.clone();
    let r = reports.clone();
    let p = polls.clone();
    let app=Router::new().route("/v1/probe/enroll",post(move |Json(body):Json<serde_json::Value>| {
        let e=e.clone();let d=d.clone();async move {
            let disk:serde_json::Value=serde_json::from_slice(&tokio::fs::read(d.join("identity.json")).await.unwrap()).unwrap();
            assert_eq!(disk["token"],body["credential"]);assert_eq!(disk["enrollmentToken"],body["enrollmentToken"]);
            if e.fetch_add(1,Ordering::SeqCst)==0 {(StatusCode::SERVICE_UNAVAILABLE,Json(json!({"error":"retry"})))}else{(StatusCode::OK,Json(json!({"protocolVersion":1,"locationId":"00000000-0000-4000-8000-000000000001"})))}
        }
    })).route("/v1/probe/poll",post(move || {
        p.fetch_add(1,Ordering::SeqCst);async {
            Json(json!({"protocolVersion":1,"job":{"id":"00000000-0000-4000-8000-000000000002","leaseToken":"00000000-0000-4000-8000-000000000003","leaseUntil":(chrono::Utc::now()+chrono::Duration::seconds(45)).to_rfc3339_opts(chrono::SecondsFormat::Millis,true),"config":{"name":"Fixture","url":"http://127.0.0.1/"},"secrets":{}}}))
        }
    })).route("/v1/probe/results",post(move |Json(body):Json<serde_json::Value>| {
        let r=r.clone();let stop=stop.clone();async move {
            let mut reports=r.lock().unwrap();reports.push(body);
            if reports.len()==1 {(StatusCode::SERVICE_UNAVAILABLE,Json(json!({"error":"retry"})))}else{stop.send(true).unwrap();(StatusCode::OK,Json(json!({"ok":true})))}
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let options = Options::parse(&origin, data.clone(), Some(enrollment), true, false).unwrap();
    tokio::time::timeout(
        std::time::Duration::from_secs(10),
        stillup_api::probe_runner::run(options, stopped),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(enrolled.load(Ordering::SeqCst), 2);
    assert_eq!(polls.load(Ordering::SeqCst), 1);
    {
        let reports = reports.lock().unwrap();
        assert_eq!(reports.len(), 2);
        assert_eq!(reports[0], reports[1]);
        assert_eq!(reports[0]["result"]["outcome"], "error");
        assert!(reports[0]["result"].get("failures").is_none());
        assert!(reports[0]["result"].get("checkedAt").is_none());
    }
    server.abort();
    assert!(server.await.unwrap_err().is_cancelled());
}
