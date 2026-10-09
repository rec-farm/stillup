use crate::json::ApiPath;
use crate::{
    error::ApiError,
    executor,
    health::{self, HealthState},
    notifications,
    server::AppState,
};
use axum::{Json, extract::State, http::StatusCode};
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use sqlx::{Row, postgres::PgRow};
use uuid::Uuid;

fn regional(config: &Value) -> bool {
    config["locationIds"]
        .as_array()
        .is_some_and(|ids| ids.iter().any(|id| id != "local"))
}
pub async fn enqueue(state: &AppState, requested: Option<Uuid>) -> Result<i64, ApiError> {
    let mut tx = state.pool.begin().await?;
    let rows = if let Some(id) = requested {
        let row = sqlx::query("SELECT * FROM monitors WHERE id=$1 FOR UPDATE")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "Check not found".into()))?;
        if !row.get::<bool, _>("enabled")
            || row.get::<Option<DateTime<Utc>>, _>("archived_at").is_some()
        {
            return Err(ApiError::conflict(
                "Restore and resume the check before running it",
            ));
        }
        vec![row]
    } else {
        sqlx::query("SELECT * FROM monitors WHERE enabled AND archived_at IS NULL AND next_run_at<=now() ORDER BY next_run_at LIMIT 100 FOR UPDATE SKIP LOCKED").fetch_all(&mut *tx).await?
    };
    let mut count = 0;
    for row in rows {
        let config: Value = row.get("config");
        if regional(&config) {
            if crate::probes::schedule(&mut tx, &row).await? {
                count += 1;
            }
            sqlx::query("UPDATE monitors SET next_run_at=now()+($2::integer * interval '1 second') WHERE id=$1").bind(row.get::<Uuid,_>("id")).bind(config["intervalSeconds"].as_i64().unwrap_or(60) as i32).execute(&mut *tx).await?;
            continue;
        }
        let monitor_id: Uuid = row.get("id");
        let result = sqlx::query("INSERT INTO check_jobs(monitor_id,config_revision,execution_epoch) VALUES($1,$2,$3) ON CONFLICT DO NOTHING")
            .bind(monitor_id).bind(row.get::<i32,_>("config_revision")).bind(row.get::<i32,_>("execution_epoch")).execute(&mut *tx).await?;
        count += result.rows_affected() as i64;
        sqlx::query(
            "UPDATE monitors SET next_run_at=now()+($2::integer * interval '1 second') WHERE id=$1",
        )
        .bind(monitor_id)
        .bind(config["intervalSeconds"].as_i64().unwrap_or(60) as i32)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(count)
}
pub async fn run_now(
    State(state): State<AppState>,
    ApiPath(value): ApiPath<String>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let count = enqueue(&state, Some(notifications::id(&value)?)).await?;
    Ok((
        StatusCode::ACCEPTED,
        Json(
            json!({"queued":count > 0,"message":if count > 0 {"Check queued"} else {"Check already queued or running"}}),
        ),
    ))
}
pub async fn claim(state: &AppState) -> Result<Option<PgRow>, ApiError> {
    let mut tx = state.pool.begin().await?;
    // Claims are committed before network I/O. Expired workers are fenced by claim_id.
    let row = sqlx::query("SELECT * FROM check_jobs WHERE status IN ('pending','running') AND available_at<=now() ORDER BY available_at,id LIMIT 1 FOR UPDATE SKIP LOCKED").fetch_optional(&mut *tx).await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let id: Uuid = row.get("id");
    if row.get::<i32, _>("attempts") >= 3 {
        sqlx::query("UPDATE check_jobs SET status='failed',finished_at=now(),lease_until=NULL,claim_id=NULL WHERE id=$1").bind(id).execute(&mut *tx).await?;
        tx.commit().await?;
        return Ok(None);
    }
    let row = sqlx::query("UPDATE check_jobs SET status='running',attempts=attempts+1,claim_id=$2,lease_until=now()+interval '90 seconds',available_at=now()+interval '90 seconds' WHERE id=$1 RETURNING *")
        .bind(id).bind(Uuid::new_v4()).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    Ok(Some(row))
}

pub async fn record_result(
    connection: &mut sqlx::PgConnection,
    state: &AppState,
    row: &PgRow,
    result: &Value,
    run_id: Uuid,
) -> Result<bool, ApiError> {
    let config: Value = row.get("config");
    let outcome = result["outcome"]
        .as_str()
        .ok_or_else(|| ApiError::bad("Invalid check result"))?;
    let checked_at = result["checkedAt"]
        .as_str()
        .and_then(|v| DateTime::parse_from_rfc3339(v).ok())
        .map(|v| v.with_timezone(&Utc))
        .ok_or_else(|| ApiError::bad("Invalid check timestamp"))?;
    let duration = result["durationMs"]
        .as_i64()
        .ok_or_else(|| ApiError::bad("Invalid check duration"))? as i32;
    let next = health::evaluate(
        HealthState {
            status: row.get("status"),
            failures: row.get("failures"),
            successes: row.get("successes"),
        },
        outcome,
        config["failureThreshold"].as_i64().unwrap_or(2),
        config["recoveryThreshold"].as_i64().unwrap_or(1),
    );
    let monitor_id: Uuid = row.get("id");
    let inserted = sqlx::query("INSERT INTO runs(id,monitor_id,outcome,status_code,duration_ms,failures,checked_at,config_revision,assertions) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING")
        .bind(run_id).bind(monitor_id).bind(outcome).bind(result["statusCode"].as_i64().map(|v|v as i32)).bind(duration).bind(&result["failures"]).bind(checked_at).bind(row.get::<i32,_>("config_revision")).bind(result.get("assertions").cloned().unwrap_or_else(||json!([]))).execute(&mut *connection).await?;
    if inserted.rows_affected() == 0 {
        return Ok(false);
    }
    sqlx::query("UPDATE monitors SET status=$2,failures=$3,successes=$4,last_run_at=$5,last_duration_ms=$6,last_outcome=$7,last_observed_at=CASE WHEN $7='error' THEN last_observed_at ELSE $5 END WHERE id=$1")
        .bind(monitor_id).bind(&next.status).bind(next.failures).bind(next.successes).bind(checked_at).bind(duration).bind(outcome).execute(&mut *connection).await?;
    if outcome != "error" {
        let seconds = config["intervalSeconds"]
            .as_i64()
            .unwrap_or(60)
            .clamp(30, 86_400);
        let down = if next.status == "down" { seconds } else { 0 };
        sqlx::query("INSERT INTO monitor_daily_uptime(monitor_id,day,observed_seconds,down_seconds) VALUES($1,($2 AT TIME ZONE 'UTC')::date,$3,$4) ON CONFLICT(monitor_id,day) DO UPDATE SET observed_seconds=monitor_daily_uptime.observed_seconds+EXCLUDED.observed_seconds,down_seconds=monitor_daily_uptime.down_seconds+EXCLUDED.down_seconds")
            .bind(monitor_id).bind(checked_at).bind(seconds).bind(down).execute(&mut *connection).await?;
    }
    let previous: String = row.get("status");
    let incident = if next.status == "down" && previous != "down" {
        sqlx::query_scalar::<_, Uuid>(
            "INSERT INTO incidents(monitor_id,name,opened_at) VALUES($1,$2,$3) RETURNING id",
        )
        .bind(monitor_id)
        .bind(config["name"].as_str().unwrap_or_default())
        .bind(checked_at)
        .fetch_optional(&mut *connection)
        .await?
        .map(|id| (id, "incident.opened"))
    } else if next.status == "up" && previous == "down" {
        sqlx::query_scalar::<_,Uuid>("UPDATE incidents SET resolved_at=$2 WHERE monitor_id=$1 AND resolved_at IS NULL RETURNING id").bind(monitor_id).bind(checked_at).fetch_optional(&mut *connection).await?.map(|id|(id,"incident.resolved"))
    } else {
        None
    };
    if let Some((incident_id, event_type)) = incident {
        let revision: i32 = row.get("config_revision");
        let event = json!({"id":incident_id,"type":event_type,"name":config["name"],"at":result["checkedAt"],"monitorId":monitor_id,"runId":run_id,"configRevision":revision});
        sqlx::query("INSERT INTO incident_events(incident_id,type,at,run_id,config_revision,result) VALUES($1,$2,$3,$4,$5,$6)").bind(incident_id).bind(event_type).bind(checked_at).bind(run_id).bind(revision).bind(result).execute(&mut *connection).await?;
        notifications::queue_event(
            connection,
            &state.config.alert_webhook_url,
            &event,
            &config,
            &format!("{incident_id}:{event_type}"),
            None,
            None,
        )
        .await?;
    }
    Ok(true)
}

pub async fn execute_job(state: &AppState, job: &PgRow) -> Result<(), ApiError> {
    let mut tx = state.pool.begin().await?;
    let monitor_id: Uuid = job.get("monitor_id");
    let monitor = sqlx::query("SELECT * FROM monitors WHERE id=$1 FOR UPDATE")
        .bind(monitor_id)
        .fetch_optional(&mut *tx)
        .await?;
    // Lock the monitor before the job everywhere execution needs both locks.
    let current = sqlx::query("SELECT * FROM check_jobs WHERE id=$1 FOR UPDATE")
        .bind(job.get::<Uuid, _>("id"))
        .fetch_optional(&mut *tx)
        .await?;
    let active = current.as_ref().is_some_and(|current| {
        current.get::<Option<Uuid>, _>("claim_id") == job.get::<Option<Uuid>, _>("claim_id")
            && current.get::<String, _>("status") == "running"
    });
    if !active {
        return Ok(());
    }
    let valid = monitor.as_ref().is_some_and(|row| {
        let config: Value = row.get("config");
        row.get::<bool, _>("enabled")
            && row.get::<Option<DateTime<Utc>>, _>("archived_at").is_none()
            && !regional(&config)
            && row.get::<i32, _>("config_revision") == job.get::<i32, _>("config_revision")
            && row.get::<i32, _>("execution_epoch") == job.get::<i32, _>("execution_epoch")
            && Utc::now()
                .signed_duration_since(job.get::<DateTime<Utc>, _>("scheduled_at"))
                .num_milliseconds()
                <= config["intervalSeconds"]
                    .as_i64()
                    .unwrap_or(60)
                    .saturating_mul(2)
                    .max(120)
                    .saturating_mul(1000)
    });
    if valid {
        let row = monitor.as_ref().unwrap();
        let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM runs WHERE id=$1)")
            .bind(job.get::<Uuid, _>("id"))
            .fetch_one(&mut *tx)
            .await?;
        if !exists {
            let config: Value = row.get("config");
            let mut values: Vec<String> = config["headers"]
                .as_object()
                .into_iter()
                .flat_map(|headers| headers.values())
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect();
            if let Some(body) = config["body"].as_str() {
                values.push(body.into());
            }
            let secrets =
                crate::secrets::resolve_connection(&mut tx, &state.config.secrets, &values).await?;
            let result = executor::execute(
                &config,
                &executor::Options {
                    allow_private_networks: state.config.allow_private_networks,
                    secrets,
                },
            )
            .await;
            record_result(&mut tx, state, row, &result, job.get("id")).await?;
        }
    }
    sqlx::query("UPDATE check_jobs SET status='completed',finished_at=now(),lease_until=NULL,claim_id=NULL WHERE id=$1").bind(job.get::<Uuid,_>("id")).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}
pub async fn run_one(state: &AppState) -> Result<bool, ApiError> {
    let Some(job) = claim(state).await? else {
        return Ok(false);
    };
    if let Err(error) = execute_job(state, &job).await {
        let attempt: i32 = job.get("attempts");
        sqlx::query("UPDATE check_jobs SET status=CASE WHEN $3>=3 THEN 'failed' ELSE 'pending' END,available_at=now()+interval '10 seconds',finished_at=CASE WHEN $3>=3 THEN now() ELSE NULL END,claim_id=NULL,lease_until=NULL WHERE id=$1 AND claim_id=$2")
            .bind(job.get::<Uuid,_>("id")).bind(job.get::<Uuid,_>("claim_id")).bind(attempt).execute(&state.pool).await?;
        return Err(error);
    }
    Ok(true)
}

pub async fn incident_timeline(
    State(state): State<AppState>,
    ApiPath(value): ApiPath<String>,
    crate::json::ApiQuery(query): crate::json::ApiQuery,
) -> Result<Json<Value>, ApiError> {
    let incident_id = notifications::id(&value)?;
    let before = query
        .get("before")
        .map(|v| notifications::id(v))
        .transpose()?;
    let incident = sqlx::query("SELECT * FROM incidents WHERE id=$1")
        .bind(incident_id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "Incident not found".into()))?;
    let monitor_id: Uuid = incident.get("monitor_id");
    let opened_at: DateTime<Utc> = incident.get("opened_at");
    let resolved_at: Option<DateTime<Utc>> = incident.get("resolved_at");
    let events = sqlx::query("SELECT * FROM incident_events WHERE incident_id=$1 ORDER BY at,id")
        .bind(incident_id)
        .fetch_all(&state.pool)
        .await?;
    let rows = sqlx::query("SELECT * FROM runs WHERE monitor_id=$1 AND checked_at>=$2 AND ($3::timestamptz IS NULL OR checked_at<=$3) AND ($4::uuid IS NULL OR (checked_at,id)<(SELECT checked_at,id FROM runs WHERE id=$4)) ORDER BY checked_at DESC,id DESC LIMIT 51").bind(monitor_id).bind(opened_at).bind(resolved_at).bind(before).fetch_all(&state.pool).await?;
    let next = (rows.len() > 50).then(|| rows[49].get::<Uuid, _>("id"));
    let observations = rows.iter().take(50).map(|row| -> Result<Value,ApiError> {Ok(json!({"id":row.get::<Uuid,_>("id"),"monitorId":monitor_id,"configRevision":row.get::<i32,_>("config_revision"),"outcome":row.get::<String,_>("outcome"),"statusCode":row.get::<Option<i32>,_>("status_code"),"durationMs":row.get::<i32,_>("duration_ms"),"failures":row.get::<Value,_>("failures"),"assertions":row.get::<Value,_>("assertions"),"checkedAt":crate::server::timestamp(row,"checked_at")?}))}).collect::<Result<Vec<_>,_>>()?;
    let events = events.iter().map(|row| -> Result<Value,ApiError> {Ok(json!({"id":row.get::<Uuid,_>("id"),"type":row.get::<String,_>("type"),"at":crate::server::timestamp(row,"at")?,"runId":row.get::<Uuid,_>("run_id"),"configRevision":row.get::<i32,_>("config_revision"),"result":row.get::<Value,_>("result")}))}).collect::<Result<Vec<_>,_>>()?;
    Ok(Json(
        json!({"incident":{"id":incident_id,"monitorId":monitor_id,"name":incident.get::<String,_>("name"),"openedAt":crate::server::timestamp(&incident,"opened_at")?,"resolvedAt":crate::server::timestamp(&incident,"resolved_at")?},"events":events,"observations":observations,"nextBefore":next}),
    ))
}

/// Deployment handoff: stop the old API/worker before calling this. Legacy rows remain
/// as completed audit records. A still-live claim prevents the whole transaction.
pub async fn handoff(state: &AppState, schema: &str) -> Result<i64, ApiError> {
    if schema.is_empty()
        || !schema
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_')
        || schema.as_bytes()[0].is_ascii_digit()
    {
        return Err(ApiError::bad("Invalid legacy queue schema"));
    }
    let mut tx = state.pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(782315)")
        .execute(&mut *tx)
        .await?;
    let relation = format!("{schema}.job");
    let exists: bool = sqlx::query_scalar("SELECT to_regclass($1) IS NOT NULL")
        .bind(&relation)
        .fetch_one(&mut *tx)
        .await?;
    if !exists {
        return Ok(0);
    }
    let table = format!("\"{schema}\".job");
    // Prevent enqueue/claim/completion writes while snapshots are transferred.
    sqlx::query(&format!("LOCK TABLE {table} IN SHARE ROW EXCLUSIVE MODE"))
        .execute(&mut *tx)
        .await?;
    let live:bool = sqlx::query_scalar(&format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE name IN ('http-check','notify') AND state::text='active' AND (started_on IS NULL OR started_on+(expire_seconds * interval '1 second')>now()))")).fetch_one(&mut *tx).await?;
    if live {
        return Err(ApiError::conflict(
            "Stop the old API and worker, then wait for their active queue leases to finish before the Rust handoff",
        ));
    }
    let rows = sqlx::query(&format!("SELECT id,name,data,state::text AS state,retry_count,start_after,created_on FROM {table} WHERE name IN ('http-check','notify') AND state::text IN ('created','retry','active') ORDER BY created_on,id FOR UPDATE")).fetch_all(&mut *tx).await?;
    let mut transferred = 0;
    for row in rows {
        let job_id: Uuid = row.get("id");
        let data: Value = row.get("data");
        if row.get::<String, _>("name") == "notify" {
            notifications::queue_event(
                &mut tx,
                &state.config.alert_webhook_url,
                &data,
                &json!({}),
                &format!("legacy:{job_id}"),
                Some(Uuid::parse_str("00000000-0000-4000-8000-000000000001").unwrap()),
                Some(job_id),
            )
            .await?;
        } else {
            let monitor_id = notifications::id(data["monitorId"].as_str().unwrap_or_default())?;
            let monitor_exists: bool =
                sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM monitors WHERE id=$1)")
                    .bind(monitor_id)
                    .fetch_one(&mut *tx)
                    .await?;
            if monitor_exists {
                let revision = crate::check_config::integer(
                    data.get("configRevision").unwrap_or(&json!(1)),
                    1,
                    i32::MAX.into(),
                    "configRevision",
                )? as i32;
                let epoch = crate::check_config::integer(
                    data.get("executionEpoch").unwrap_or(&json!(1)),
                    1,
                    i32::MAX.into(),
                    "executionEpoch",
                )? as i32;
                let scheduled_at = match data.get("scheduledAt") {
                    Some(v) => v
                        .as_i64()
                        .and_then(DateTime::from_timestamp_millis)
                        .ok_or_else(|| ApiError::bad("Invalid legacy schedule timestamp"))?,
                    None => row.get("created_on"),
                };
                let attempts = row
                    .get::<i32, _>("retry_count")
                    .saturating_add(i32::from(row.get::<String, _>("state") == "active"))
                    .clamp(0, 3);
                let observed: bool =
                    sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM runs WHERE id=$1)")
                        .bind(job_id)
                        .fetch_one(&mut *tx)
                        .await?;
                let status = if observed {
                    "completed"
                } else if attempts >= 3 {
                    "failed"
                } else {
                    "pending"
                };
                sqlx::query("INSERT INTO check_jobs(id,monitor_id,config_revision,execution_epoch,scheduled_at,available_at,attempts,status,created_at,finished_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,CASE WHEN $8='pending' THEN NULL ELSE now() END) ON CONFLICT(id) DO NOTHING")
                    .bind(job_id).bind(monitor_id).bind(revision).bind(epoch).bind(scheduled_at).bind(row.get::<DateTime<Utc>,_>("start_after")).bind(attempts).bind(status).bind(row.get::<DateTime<Utc>,_>("created_on")).execute(&mut *tx).await?;
            }
        }
        sqlx::query(&format!(
            "UPDATE {table} SET state='completed',completed_on=now(),output=$2 WHERE id=$1"
        ))
        .bind(job_id)
        .bind(json!({"migratedTo":"rust"}))
        .execute(&mut *tx)
        .await?;
        transferred += 1;
    }
    tx.commit().await?;
    Ok(transferred)
}
