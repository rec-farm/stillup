use crate::json::ApiPath;
use crate::{
    check_config,
    error::ApiError,
    json::ApiJson,
    server::{AppState, timestamp},
};
use aes_gcm::aead::{OsRng, rand_core::RngCore};
use axum::{Json, extract::State, http::StatusCode};
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
pub(crate) fn hash(value: &str) -> String {
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
    ApiPath(value): ApiPath<String>,
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
    ApiPath(value): ApiPath<String>,
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
pub async fn schedule(connection: &mut sqlx::PgConnection, row: &PgRow) -> Result<bool, ApiError> {
    let monitor_id: Uuid = row.get("id");
    let revision: i32 = row.get("config_revision");
    let epoch: i32 = row.get("execution_epoch");
    sqlx::query("UPDATE probe_rounds SET finished_at=now() WHERE monitor_id=$1 AND finished_at IS NULL AND (execution_epoch<>$2 OR config_revision<>$3)").bind(monitor_id).bind(epoch).bind(revision).execute(&mut *connection).await?;
    let round_id = Uuid::new_v4();
    let inserted=sqlx::query("INSERT INTO probe_rounds(id,monitor_id,config_revision,execution_epoch,deadline) VALUES($1,$2,$3,$4,now()+interval '60 seconds') ON CONFLICT DO NOTHING").bind(round_id).bind(monitor_id).bind(revision).bind(epoch).execute(&mut *connection).await?;
    if inserted.rows_affected() == 0 {
        return Ok(false);
    }
    let config: Value = row.get("config");
    let locations = config
        .get("locationIds")
        .cloned()
        .unwrap_or_else(|| json!(["local"]));
    for location in locations.as_array().unwrap() {
        sqlx::query("INSERT INTO probe_jobs(id,round_id,location_id) VALUES($1,$2,$3)")
            .bind(Uuid::new_v4())
            .bind(round_id)
            .bind(location.as_str().unwrap())
            .execute(&mut *connection)
            .await?;
    }
    Ok(true)
}
pub async fn claim(
    state: &AppState,
    location_id: &str,
    credential: Option<&str>,
) -> Result<Value, ApiError> {
    let mut tx = state.pool.begin().await?;
    let location =
        sqlx::query("SELECT * FROM probe_locations WHERE id=$1 AND revoked_at IS NULL FOR UPDATE")
            .bind(location_id)
            .fetch_optional(&mut *tx)
            .await?;
    if !location.as_ref().is_some_and(|row| {
        credential.is_none_or(|c| {
            row.get::<Option<String>, _>("token_hash").as_deref() == Some(hash(c).as_str())
        })
    }) {
        return Err(ApiError(
            StatusCode::UNAUTHORIZED,
            "Probe credential is invalid or revoked".into(),
        ));
    }
    sqlx::query("UPDATE probe_locations SET last_seen_at=now() WHERE id=$1")
        .bind(location_id)
        .execute(&mut *tx)
        .await?;
    let row=sqlx::query("SELECT j.id,j.round_id,m.config FROM probe_jobs j JOIN probe_rounds r ON r.id=j.round_id JOIN monitors m ON m.id=r.monitor_id WHERE j.location_id=$1 AND j.completed_at IS NULL AND (j.lease_until IS NULL OR j.lease_until<now()) AND r.finished_at IS NULL AND r.deadline>now()+interval '5 seconds' AND m.enabled AND m.archived_at IS NULL AND m.config_revision=r.config_revision AND m.execution_epoch=r.execution_epoch ORDER BY r.created_at LIMIT 1 FOR UPDATE OF j SKIP LOCKED").bind(location_id).fetch_optional(&mut *tx).await?;
    let Some(row) = row else {
        tx.commit().await?;
        return Ok(json!({"job":null,"protocolVersion":1}));
    };
    let job_id: Uuid = row.get("id");
    let lease_token = Uuid::new_v4();
    let lease=sqlx::query("UPDATE probe_jobs SET lease_token=$2,lease_until=LEAST(now()+interval '45 seconds',(SELECT deadline FROM probe_rounds WHERE id=round_id)) WHERE id=$1 RETURNING lease_until").bind(job_id).bind(lease_token).fetch_one(&mut *tx).await?;
    let config: Value = row.get("config");
    let mut values: Vec<String> = config["headers"]
        .as_object()
        .into_iter()
        .flat_map(|h| h.values())
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect();
    if let Some(body) = config["body"].as_str() {
        values.push(body.into());
    }
    let secrets =
        crate::secrets::resolve_connection(&mut tx, &state.config.secrets, &values).await?;
    let result = json!({"protocolVersion":1,"job":{"id":job_id,"leaseToken":lease_token,"leaseUntil":timestamp(&lease,"lease_until")?,"config":config,"secrets":secrets}});
    tx.commit().await?;
    Ok(result)
}
async fn finish(
    connection: &mut sqlx::PgConnection,
    state: &AppState,
    monitor: &PgRow,
    round: &PgRow,
) -> Result<(), ApiError> {
    if round
        .get::<Option<DateTime<Utc>>, _>("finished_at")
        .is_some()
    {
        return Ok(());
    }
    let round_id: Uuid = round.get("id");
    if !monitor.get::<bool, _>("enabled")
        || monitor
            .get::<Option<DateTime<Utc>>, _>("archived_at")
            .is_some()
        || monitor.get::<i32, _>("config_revision") != round.get::<i32, _>("config_revision")
        || monitor.get::<i32, _>("execution_epoch") != round.get::<i32, _>("execution_epoch")
    {
        sqlx::query("UPDATE probe_rounds SET finished_at=now() WHERE id=$1")
            .bind(round_id)
            .execute(connection)
            .await?;
        return Ok(());
    }
    let jobs = sqlx::query("SELECT result FROM probe_jobs WHERE round_id=$1")
        .bind(round_id)
        .fetch_all(&mut *connection)
        .await?;
    let results: Vec<Value> = jobs
        .iter()
        .map(|j| j.get::<Option<Value>, _>("result").unwrap_or(Value::Null))
        .collect();
    if results.iter().any(Value::is_null) && round.get::<DateTime<Utc>, _>("deadline") > Utc::now()
    {
        return Ok(());
    }
    let config: Value = monitor.get("config");
    let result = aggregate(
        &results,
        config["locationFailureThreshold"].as_u64().unwrap_or(1) as usize,
        &Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
    );
    crate::monitoring::record_result(connection, state, monitor, &result, round_id).await?;
    sqlx::query("UPDATE probe_rounds SET finished_at=now() WHERE id=$1")
        .bind(round_id)
        .execute(connection)
        .await?;
    Ok(())
}
pub async fn complete(
    state: &AppState,
    location_id: &str,
    job_id: Uuid,
    lease_token: Uuid,
    input: &Value,
    credential: Option<&str>,
) -> Result<Value, ApiError> {
    let result = safe_report(input)?;
    let mut tx = state.pool.begin().await?;
    let location = sqlx::query(
        "SELECT token_hash FROM probe_locations WHERE id=$1 AND revoked_at IS NULL FOR SHARE",
    )
    .bind(location_id)
    .fetch_optional(&mut *tx)
    .await?;
    if !location.as_ref().is_some_and(|row| {
        credential.is_none_or(|c| {
            row.get::<Option<String>, _>("token_hash").as_deref() == Some(hash(c).as_str())
        })
    }) {
        return Err(ApiError(
            StatusCode::UNAUTHORIZED,
            "Probe credential is invalid or revoked".into(),
        ));
    }
    let info=sqlx::query("SELECT r.monitor_id,r.id FROM probe_rounds r JOIN probe_jobs j ON j.round_id=r.id WHERE j.id=$1 AND j.location_id=$2").bind(job_id).bind(location_id).fetch_optional(&mut *tx).await?.ok_or_else(||ApiError(StatusCode::NOT_FOUND,"Probe job not found".into()))?;
    let monitor = sqlx::query("SELECT * FROM monitors WHERE id=$1 FOR UPDATE")
        .bind(info.get::<Uuid, _>("monitor_id"))
        .fetch_one(&mut *tx)
        .await?;
    let round = sqlx::query("SELECT * FROM probe_rounds WHERE id=$1 FOR UPDATE")
        .bind(info.get::<Uuid, _>("id"))
        .fetch_one(&mut *tx)
        .await?;
    let job = sqlx::query("SELECT * FROM probe_jobs WHERE id=$1 FOR UPDATE")
        .bind(job_id)
        .fetch_one(&mut *tx)
        .await?;
    if job.get::<Option<Uuid>, _>("lease_token") != Some(lease_token) {
        return Err(ApiError::conflict("Probe lease has been replaced"));
    }
    if job
        .get::<Option<DateTime<Utc>>, _>("completed_at")
        .is_some()
    {
        tx.commit().await?;
        return Ok(json!({"ok":true}));
    }
    if round
        .get::<Option<DateTime<Utc>>, _>("finished_at")
        .is_some()
        || job
            .get::<Option<DateTime<Utc>>, _>("lease_until")
            .is_none_or(|until| Utc::now() > until)
        || Utc::now() > round.get::<DateTime<Utc>, _>("deadline")
        || !monitor.get::<bool, _>("enabled")
        || monitor
            .get::<Option<DateTime<Utc>>, _>("archived_at")
            .is_some()
        || monitor.get::<i32, _>("execution_epoch") != round.get::<i32, _>("execution_epoch")
        || monitor.get::<i32, _>("config_revision") != round.get::<i32, _>("config_revision")
    {
        return Err(ApiError::conflict("Probe job is expired or obsolete"));
    }
    sqlx::query("UPDATE probe_jobs SET result=$2,completed_at=now() WHERE id=$1")
        .bind(job_id)
        .bind(result)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE probe_locations SET last_seen_at=now() WHERE id=$1")
        .bind(location_id)
        .execute(&mut *tx)
        .await?;
    finish(&mut tx, state, &monitor, &round).await?;
    tx.commit().await?;
    Ok(json!({"ok":true}))
}
pub async fn expire(state: &AppState) -> Result<(), ApiError> {
    let due=sqlx::query("SELECT id,monitor_id FROM probe_rounds WHERE finished_at IS NULL AND deadline<=now() ORDER BY deadline LIMIT 100").fetch_all(&state.pool).await?;
    for row in due {
        let mut tx = state.pool.begin().await?;
        let monitor = sqlx::query("SELECT * FROM monitors WHERE id=$1 FOR UPDATE")
            .bind(row.get::<Uuid, _>("monitor_id"))
            .fetch_optional(&mut *tx)
            .await?;
        let round = sqlx::query("SELECT * FROM probe_rounds WHERE id=$1 FOR UPDATE")
            .bind(row.get::<Uuid, _>("id"))
            .fetch_optional(&mut *tx)
            .await?;
        if let (Some(monitor), Some(round)) = (monitor, round) {
            finish(&mut tx, state, &monitor, &round).await?;
        }
        tx.commit().await?;
    }
    Ok(())
}
pub async fn local(state: &AppState) -> Result<(), ApiError> {
    let response = claim(state, "local", None).await?;
    let job = &response["job"];
    if job.is_null() {
        return Ok(());
    }
    let result = crate::executor::execute(
        &job["config"],
        &crate::executor::Options {
            allow_private_networks: state.config.allow_private_networks,
            secrets: serde_json::from_value(job["secrets"].clone())
                .map_err(|_| ApiError::bad("Invalid local probe secrets"))?,
        },
    )
    .await;
    match complete(
        state,
        "local",
        crate::notifications::id(job["id"].as_str().unwrap())?,
        crate::notifications::id(job["leaseToken"].as_str().unwrap())?,
        &result,
        None,
    )
    .await
    {
        Err(error) if error.0 == StatusCode::CONFLICT => Ok(()),
        result => result.map(|_| ()),
    }
}

fn protocol(input: &Value) -> Result<(), ApiError> {
    if input["protocolVersion"].as_f64() != Some(1.0) {
        return Err(ApiError::bad("Unsupported probe protocol version"));
    }
    Ok(())
}
fn bearer(headers: &axum::http::HeaderMap) -> &str {
    headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
        .unwrap_or_default()
}
pub async fn enroll_route(
    State(state): State<AppState>,
    ApiJson(input): ApiJson,
) -> Result<Json<Value>, ApiError> {
    protocol(&input)?;
    Ok(Json(
        enroll(
            &state,
            input["enrollmentToken"].as_str().unwrap_or_default(),
            input["credential"].as_str().unwrap_or_default(),
        )
        .await?,
    ))
}
pub async fn poll_route(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    ApiJson(input): ApiJson,
) -> Result<Json<Value>, ApiError> {
    protocol(&input)?;
    let credential = bearer(&headers);
    let location = authenticate(&state, credential).await?;
    Ok(Json(claim(&state, &location, Some(credential)).await?))
}
pub async fn report_route(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    ApiJson(input): ApiJson,
) -> Result<Json<Value>, ApiError> {
    let credential = bearer(&headers);
    let location = authenticate(&state, credential).await?;
    protocol(&input)?;
    Ok(Json(
        complete(
            &state,
            &location,
            crate::notifications::id(input["jobId"].as_str().unwrap_or_default())?,
            crate::notifications::id(input["leaseToken"].as_str().unwrap_or_default())?,
            &input["result"],
            Some(credential),
        )
        .await?,
    ))
}

pub async fn observations(
    State(state): State<AppState>,
    ApiPath(value): ApiPath<String>,
) -> Result<Json<Value>, ApiError> {
    let monitor_id = crate::notifications::id(&value)?;
    let monitor = sqlx::query("SELECT * FROM monitors WHERE id=$1")
        .bind(monitor_id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "Check not found".into()))?;
    let config: Value = monitor.get("config");
    let ids: Vec<String> = config
        .get("locationIds")
        .cloned()
        .unwrap_or_else(|| json!(["local"]))
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().into())
        .collect();
    let rows=sqlx::query("SELECT p.*,o.result,o.completed_at FROM probe_locations p LEFT JOIN LATERAL (SELECT j.result,j.completed_at FROM probe_jobs j JOIN probe_rounds r ON r.id=j.round_id WHERE j.location_id=p.id AND r.monitor_id=$1 AND r.execution_epoch=$3 AND r.config_revision=$4 ORDER BY r.created_at DESC LIMIT 1) o ON true WHERE p.id=ANY($2::text[]) ORDER BY p.created_at").bind(monitor_id).bind(&ids).bind(monitor.get::<i32,_>("execution_epoch")).bind(monitor.get::<i32,_>("config_revision")).fetch_all(&state.pool).await?;
    let legacy = ids.len() == 1 && ids[0] == "local";
    let output=rows.iter().map(|row| {
        let at=if legacy {monitor.get::<Option<DateTime<Utc>>,_>("last_run_at")} else {row.get("completed_at")};
        let result:Value=row.get::<Option<Value>,_>("result").unwrap_or(Value::Null);
        json!({"locationId":row.get::<String,_>("id"),"name":row.get::<String,_>("name"),"region":row.get::<String,_>("region"),"probeStatus":location_status(row),"outcome":if legacy {json!(monitor.get::<Option<String>,_>("last_outcome"))}else{result["outcome"].clone()},"statusCode":if legacy {Value::Null}else{result["statusCode"].clone()},"durationMs":if legacy {json!(monitor.get::<Option<i32>,_>("last_duration_ms"))}else{result["durationMs"].clone()},"checkedAt":at.map(|at|at.to_rfc3339_opts(SecondsFormat::Millis,true)),"fresh":at.is_some_and(|at|monitor.get::<bool,_>("enabled") && monitor.get::<Option<DateTime<Utc>>,_>("archived_at").is_none() && Utc::now().signed_duration_since(at).num_milliseconds()<config["intervalSeconds"].as_i64().unwrap_or(60).saturating_mul(3).max(120).saturating_mul(1000))})
    }).collect::<Vec<_>>();
    Ok(Json(json!(output)))
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
