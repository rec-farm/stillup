use crate::{
    check_config,
    error::ApiError,
    json::ApiJson,
    server::{AppState, timestamp},
};
use aes_gcm::aead::{OsRng, rand_core::RngCore};
use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{Row, postgres::PgRow};
use uuid::Uuid;
fn token() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    hex::encode(bytes)
}
fn hash(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}
fn location_status(row: &PgRow) -> &str {
    if row.get::<Option<DateTime<Utc>>, _>("revoked_at").is_some() {
        "revoked"
    } else if row
        .get::<Option<DateTime<Utc>>, _>("last_seen_at")
        .is_some_and(|at| Utc::now().signed_duration_since(at).num_milliseconds() < 45000)
    {
        "online"
    } else if row.get::<Option<String>, _>("token_hash").is_some()
        || row.get::<String, _>("id") == "local"
    {
        "offline"
    } else {
        "pending"
    }
}
pub async fn list(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let rows = sqlx::query("SELECT * FROM probe_locations ORDER BY created_at")
        .fetch_all(&state.pool)
        .await?;
    let output=rows.iter().map(|row|->Result<Value,ApiError>{Ok(json!({"id":row.get::<String,_>("id"),"name":row.get::<String,_>("name"),"region":row.get::<String,_>("region"),"status":location_status(row),"lastSeenAt":timestamp(row,"last_seen_at")?,"enrollmentExpiresAt":timestamp(row,"enrollment_expires_at")?}))}).collect::<Result<Vec<_>,_>>()?;
    Ok(Json(json!(output)))
}
pub async fn create(
    State(state): State<AppState>,
    ApiJson(input): ApiJson,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let field = |key: &str| {
        check_config::text(
            &input[key]
                .as_str()
                .map(str::trim)
                .map(Value::from)
                .unwrap_or(Value::Null),
            1,
            80,
            key,
        )
    };
    let name = field("name")?;
    let region = field("region")?;
    let enrollment = token();
    let id = Uuid::new_v4().to_string();
    let mut tx = state.pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext('stillup-location-registration'))")
        .execute(&mut *tx)
        .await?;
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM probe_locations")
        .fetch_one(&mut *tx)
        .await?;
    if count >= 100 {
        return Err(ApiError::conflict(
            "This installation supports up to 100 locations",
        ));
    }
    let row=sqlx::query("INSERT INTO probe_locations(id,name,region,enrollment_hash,enrollment_expires_at) VALUES($1,$2,$3,$4,now()+interval '15 minutes') RETURNING enrollment_expires_at").bind(&id).bind(name).bind(region).bind(hash(&enrollment)).fetch_one(&mut *tx).await?;
    let result = json!({"id":id,"enrollmentToken":enrollment,"expiresAt":timestamp(&row,"enrollment_expires_at")?});
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(result)))
}
pub async fn renew(
    State(state): State<AppState>,
    Path(value): Path<String>,
) -> Result<Json<Value>, ApiError> {
    crate::notifications::id(&value)?;
    let id = value;
    let enrollment = token();
    let mut tx = state.pool.begin().await?;
    let row=sqlx::query("UPDATE probe_locations SET enrollment_hash=$2,enrollment_expires_at=now()+interval '15 minutes',token_hash=NULL,last_seen_at=NULL,revoked_at=NULL WHERE id=$1 AND id<>'local' RETURNING enrollment_expires_at").bind(&id).bind(hash(&enrollment)).fetch_optional(&mut *tx).await?.ok_or_else(||ApiError(StatusCode::NOT_FOUND,"Remote location not found".into()))?;
    sqlx::query("UPDATE probe_jobs SET lease_until=NULL,lease_token=NULL WHERE location_id=$1 AND completed_at IS NULL").bind(&id).execute(&mut *tx).await?;
    let result = json!({"id":id,"enrollmentToken":enrollment,"expiresAt":timestamp(&row,"enrollment_expires_at")?});
    tx.commit().await?;
    Ok(Json(result))
}
pub async fn revoke(
    State(state): State<AppState>,
    Path(value): Path<String>,
) -> Result<Json<Value>, ApiError> {
    crate::notifications::id(&value)?;
    let id = value;
    let result=sqlx::query("UPDATE probe_locations SET revoked_at=now(),token_hash=NULL,enrollment_hash=NULL WHERE id=$1 AND id<>'local'").bind(id).execute(&state.pool).await?;
    if result.rows_affected() == 0 {
        return Err(ApiError(
            StatusCode::NOT_FOUND,
            "Remote location not found".into(),
        ));
    }
    Ok(Json(json!({"ok":true})))
}
pub async fn enroll(
    state: &AppState,
    enrollment: &str,
    credential: &str,
) -> Result<Value, ApiError> {
    if ![enrollment, credential].iter().all(|value| {
        value.len() == 64
            && value
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    }) {
        return Err(ApiError::bad("Invalid enrollment token or credential"));
    }
    let row=sqlx::query("UPDATE probe_locations SET token_hash=$2,last_seen_at=now() WHERE enrollment_hash=$1 AND enrollment_expires_at>now() AND revoked_at IS NULL AND (token_hash IS NULL OR token_hash=$2) RETURNING id").bind(hash(enrollment)).bind(hash(credential)).fetch_optional(&state.pool).await?.ok_or_else(||ApiError(StatusCode::UNAUTHORIZED,"Enrollment expired, already used, or revoked".into()))?;
    Ok(json!({"locationId":row.get::<String,_>("id"),"protocolVersion":1}))
}
pub async fn authenticate(state: &AppState, credential: &str) -> Result<String, ApiError> {
    sqlx::query_scalar("SELECT id FROM probe_locations WHERE token_hash=$1 AND revoked_at IS NULL")
        .bind(hash(credential))
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| {
            ApiError(
                StatusCode::UNAUTHORIZED,
                "Probe credential is invalid or revoked".into(),
            )
        })
}
pub fn safe_report(input: &Value) -> Result<Value, ApiError> {
    let outcome = input["outcome"]
        .as_str()
        .filter(|v| matches!(*v, "pass" | "fail" | "error"))
        .ok_or_else(|| ApiError::bad("Invalid probe outcome"))?;
    let status = match input.get("statusCode") {
        Some(Value::Null) => Value::Null,
        Some(v) => json!(check_config::integer(v, 100, 599, "statusCode")?),
        None => return Err(ApiError::bad("statusCode: Required")),
    };
    let duration = check_config::integer(&input["durationMs"], 0, 120000, "durationMs")?;
    let mut result = json!({"outcome":outcome,"statusCode":status,"durationMs":duration,"checkedAt":Utc::now().to_rfc3339_opts(SecondsFormat::Millis,true),"failures":match outcome {"pass"=>vec![],"fail"=>vec!["Check failed at this location"],_=>vec!["Probe could not execute this check"]}});
    if let Some(assertions) = input.get("assertions") {
        let assertions = assertions
            .as_array()
            .filter(|a| a.len() <= 43)
            .ok_or_else(|| ApiError::bad("Invalid probe assertions"))?;
        result["assertions"]=Value::Array(assertions.iter().enumerate().map(|(index,a)| {
            let passed=a["passed"].as_bool().ok_or_else(||ApiError::bad("Invalid probe assertion"))?;
            Ok(json!({"kind":"status","label":format!("Assertion {}",index+1),"passed":passed,"message":if passed {"Passed"} else {"Failed"}}))
        }).collect::<Result<Vec<_>,ApiError>>()?);
    }
    Ok(result)
}
pub fn aggregate(results: &[Value], threshold: usize, checked_at: &str) -> Value {
    let failed = results.iter().filter(|r| r["outcome"] == "fail").count();
    let passed = results.iter().filter(|r| r["outcome"] == "pass").count();
    let outcome = if failed >= threshold {
        "fail"
    } else if passed > results.len().saturating_sub(threshold) {
        "pass"
    } else {
        "error"
    };
    json!({"outcome":outcome,"statusCode":null,"durationMs":results.iter().filter_map(|r|r["durationMs"].as_i64()).max().unwrap_or(0).max(0),"checkedAt":checked_at,"failures":match outcome {"fail"=>vec![format!("{failed} locations failed; threshold is {threshold}")],"error"=>vec!["Insufficient location coverage to determine health".into()],_=>vec![]}})
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn insufficient_coverage_cannot_create_recovery_or_outage_votes() {
        for (outcomes, threshold, expected) in [
            (vec!["fail", "pass", "missing"], 2, "error"),
            (vec!["pass", "pass", "missing"], 2, "pass"),
            (vec!["fail", "fail", "missing"], 2, "fail"),
            (vec!["pass", "error"], 1, "error"),
            (vec!["fail", "error"], 1, "fail"),
            (vec!["missing", "missing"], 1, "error"),
        ] {
            let results: Vec<Value> = outcomes
                .iter()
                .map(|v| {
                    if *v == "missing" {
                        Value::Null
                    } else {
                        json!({"outcome":v,"durationMs":5})
                    }
                })
                .collect();
            assert_eq!(
                aggregate(&results, threshold, "fixture")["outcome"],
                expected
            );
        }
        let report=safe_report(&json!({"outcome":"fail","statusCode":500,"durationMs":3,"failures":["secret"],"checkedAt":"untrusted","assertions":[{"passed":false,"message":"secret"}]})).unwrap();
        assert!(!report.to_string().contains("secret"));
        assert!(!report.to_string().contains("untrusted"));
        assert!(
            safe_report(&json!({"outcome":"pass","statusCode":null,"durationMs":120001})).is_err()
        );
    }
}
