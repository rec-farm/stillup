use crate::{
    check_config,
    error::ApiError,
    json::ApiJson,
    server::{AppState, timestamp},
};
use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use serde_json::{Value, json};
use sqlx::{PgPool, Row, postgres::PgRow};
use uuid::Uuid;

const ENVIRONMENT_ID: &str = "00000000-0000-4000-8000-000000000001";

pub async fn initialize(pool: &PgPool, environment_url: &str) -> Result<(), sqlx::Error> {
    if !environment_url.is_empty() {
        sqlx::query("INSERT INTO notification_channels(id,name,is_default,source) VALUES($1,'Environment webhook',true,'environment') ON CONFLICT DO NOTHING")
            .bind(Uuid::parse_str(ENVIRONMENT_ID).unwrap()).execute(pool).await?;
    }
    Ok(())
}

pub fn effective_url(row: &PgRow, environment_url: &str) -> String {
    if row.get::<String, _>("source") == "environment" {
        environment_url.into()
    } else {
        row.get::<Option<String>, _>("url").unwrap_or_default()
    }
}

pub fn channel(row: &PgRow, environment_url: &str) -> Result<Value, ApiError> {
    let url = effective_url(row, environment_url);
    let refs = crate::secrets::references(std::slice::from_ref(&url));
    let destination = if !refs.is_empty() {
        format!("Secret reference: {}", refs.join(", "))
    } else {
        url::Url::parse(&url)
            .map(|u| u.origin().ascii_serialization())
            .unwrap_or_else(|_| "Not configured".into())
    };
    Ok(
        json!({"id":row.get::<Uuid,_>("id"),"name":row.get::<String,_>("name"),"enabled":row.get::<bool,_>("enabled") && !url.is_empty(),"isDefault":row.get::<bool,_>("is_default"),"source":row.get::<String,_>("source"),"revision":row.get::<i32,_>("revision"),"destination":destination,"createdAt":timestamp(row,"created_at")?}),
    )
}

pub fn id(value: &str) -> Result<Uuid, ApiError> {
    if !check_config::valid_uuid(value) {
        return Err(ApiError::bad("Invalid id"));
    }
    Uuid::parse_str(value).map_err(|_| ApiError::bad("Invalid id"))
}
pub(crate) fn destination(value: &Value) -> Result<String, ApiError> {
    let target = value
        .as_str()
        .ok_or_else(|| ApiError::bad("url: Expected a string"))?;
    let references = crate::secrets::references(&[target.into()]);
    let secret = references
        .first()
        .is_some_and(|name| target == format!("{{{{{name}}}}}"));
    if !secret && crate::webhook::target_url(target).is_none() {
        return Err(ApiError::bad(
            "Use an HTTP(S) URL without embedded credentials or a fragment",
        ));
    }
    Ok(target.into())
}
fn flag(input: &Value, name: &str, default: bool) -> Result<bool, ApiError> {
    input.get(name).map_or(Ok(default), |v| {
        v.as_bool()
            .ok_or_else(|| ApiError::bad(format!("{name}: Expected a boolean")))
    })
}

pub async fn list(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let rows = sqlx::query("SELECT * FROM notification_channels ORDER BY created_at,id")
        .fetch_all(&state.pool)
        .await?;
    Ok(Json(Value::Array(
        rows.iter()
            .map(|row| channel(row, &state.config.alert_webhook_url))
            .collect::<Result<Vec<_>, _>>()?,
    )))
}
pub async fn create(
    State(state): State<AppState>,
    ApiJson(input): ApiJson,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    Ok((StatusCode::CREATED, Json(save(&state, &input, None).await?)))
}
pub async fn edit(
    State(state): State<AppState>,
    Path(value): Path<String>,
    ApiJson(input): ApiJson,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(save(&state, &input, Some(id(&value)?)).await?))
}
async fn save(state: &AppState, input: &Value, id: Option<Uuid>) -> Result<Value, ApiError> {
    let name = input["name"]
        .as_str()
        .map(str::trim)
        .map(Value::from)
        .unwrap_or(Value::Null);
    let name = check_config::text(&name, 1, 80, "name")?;
    let url = input.get("url").map(destination).transpose()?;
    if id.is_none() && url.is_none() {
        return Err(ApiError::bad("url: Required"));
    }
    let enabled = flag(input, "enabled", true)?;
    let default = flag(input, "isDefault", false)?;
    let revision = if id.is_some() {
        Some(check_config::integer(
            &input["expectedRevision"],
            1,
            i32::MAX.into(),
            "expectedRevision",
        )?)
    } else {
        None
    };
    let mut tx = state.pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext('stillup-notification-channels'))")
        .execute(&mut *tx)
        .await?;
    let row = if let Some(id) = id {
        let current = sqlx::query("SELECT * FROM notification_channels WHERE id=$1 FOR UPDATE")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "Channel not found".into()))?;
        if Some(i64::from(current.get::<i32, _>("revision"))) != revision {
            return Err(ApiError::conflict(
                "Channel changed elsewhere. Reopen it before saving.",
            ));
        }
        if current.get::<String, _>("source") == "environment" && url.is_some() {
            return Err(ApiError::bad(
                "Update the environment webhook URL in your installation configuration",
            ));
        }
        sqlx::query("UPDATE notification_channels SET name=$2,url=COALESCE($3,url),enabled=$4,is_default=$5,revision=revision+1 WHERE id=$1 RETURNING *").bind(id).bind(name).bind(url).bind(enabled).bind(default).fetch_one(&mut *tx).await?
    } else {
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM notification_channels")
            .fetch_one(&mut *tx)
            .await?;
        if count >= 100 {
            return Err(ApiError::conflict(
                "An installation supports up to 100 channels",
            ));
        }
        sqlx::query("INSERT INTO notification_channels(name,url,enabled,is_default) VALUES($1,$2,$3,$4) RETURNING *").bind(name).bind(url).bind(enabled).bind(default).fetch_one(&mut *tx).await?
    };
    tx.commit().await?;
    channel(&row, &state.config.alert_webhook_url)
}

pub async fn queue_event(
    tx: &mut sqlx::PgConnection,
    environment_url: &str,
    event: &Value,
    config: &Value,
    dedupe: &str,
    explicit_channel: Option<Uuid>,
    delivery_id: Option<Uuid>,
) -> Result<Vec<Uuid>, ApiError> {
    let routes = config
        .get("notificationChannelIds")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .map(|v| id(v.as_str().unwrap_or_default()))
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()?;
    let rows = sqlx::query("SELECT * FROM notification_channels WHERE enabled AND ($1::uuid IS NOT NULL AND id=$1 OR $1::uuid IS NULL AND ($2::uuid[] IS NULL AND is_default OR id=ANY($2::uuid[])))")
        .bind(explicit_channel).bind(routes).fetch_all(&mut *tx).await?;
    let incident = if event["type"] == "notification.test" {
        None
    } else {
        Some(id(event["id"].as_str().unwrap_or_default())?)
    };
    let mut ids = Vec::new();
    for row in rows {
        let target = effective_url(&row, environment_url);
        if target.is_empty() {
            continue;
        }
        let channel_id: Uuid = row.get("id");
        let next_id = delivery_id.unwrap_or_else(Uuid::new_v4);
        let inserted = sqlx::query("INSERT INTO notification_deliveries(id,channel_id,channel_name,incident_id,event,target_url,dedupe_key) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING id")
            .bind(next_id).bind(channel_id).bind(row.get::<String,_>("name")).bind(incident).bind(event).bind(target).bind(format!("{dedupe}:{channel_id}"))
            .fetch_optional(&mut *tx).await?;
        if inserted.is_some() {
            ids.push(next_id);
        }
    }
    Ok(ids)
}

pub async fn test_channel(
    State(state): State<AppState>,
    Path(value): Path<String>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let channel_id = id(&value)?;
    let mut tx = state.pool.begin().await?;
    let row = sqlx::query("SELECT * FROM notification_channels WHERE id=$1 FOR UPDATE")
        .bind(channel_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "Channel not found".into()))?;
    if !row.get::<bool, _>("enabled")
        || effective_url(&row, &state.config.alert_webhook_url).is_empty()
    {
        return Err(ApiError::conflict(
            "Enable and configure this channel before sending a test",
        ));
    }
    let event_id = Uuid::new_v4();
    let event = json!({"id":event_id,"type":"notification.test","name":"StillUp test notification","at":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true)});
    let ids = queue_event(
        &mut tx,
        &state.config.alert_webhook_url,
        &event,
        &json!({}),
        &event_id.to_string(),
        Some(channel_id),
        None,
    )
    .await?;
    tx.commit().await?;
    Ok((
        StatusCode::ACCEPTED,
        Json(json!({"deliveryId":ids.first()})),
    ))
}
fn delivery(row: &PgRow) -> Result<Value, ApiError> {
    Ok(
        json!({"id":row.get::<Uuid,_>("id"),"channelId":row.get::<Uuid,_>("channel_id"),"channelName":row.get::<String,_>("channel_name"),"incidentId":row.get::<Option<Uuid>,_>("incident_id"),"event":row.get::<Value,_>("event"),"status":row.get::<String,_>("status"),"attempts":row.get::<i32,_>("attempts"),"cycleAttempts":row.get::<i32,_>("cycle_attempts"),"nextAttemptAt":timestamp(row,"next_attempt_at")?,"lastError":row.get::<Option<String>,_>("last_error"),"createdAt":timestamp(row,"created_at")?,"deliveredAt":timestamp(row,"delivered_at")?}),
    )
}
pub async fn history(
    State(state): State<AppState>,
    crate::json::ApiQuery(query): crate::json::ApiQuery<true>,
) -> Result<Json<Value>, ApiError> {
    let incident = query.get("incidentId").map(|v| id(v)).transpose()?;
    let before = query.get("before").map(|v| id(v)).transpose()?;
    let rows = sqlx::query("SELECT * FROM notification_deliveries WHERE ($1::uuid IS NULL OR incident_id=$1) AND ($2::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM notification_deliveries WHERE id=$2)) ORDER BY created_at DESC,id DESC LIMIT 26").bind(incident).bind(before).fetch_all(&state.pool).await?;
    let next = (rows.len() > 25).then(|| rows[24].get::<Uuid, _>("id"));
    let mapped = rows
        .iter()
        .take(25)
        .map(delivery)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Json(json!({"deliveries":mapped,"nextBefore":next})))
}
pub async fn attempts(
    State(state): State<AppState>,
    Path(value): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let delivery_id = id(&value)?;
    let row = sqlx::query("SELECT * FROM notification_deliveries WHERE id=$1")
        .bind(delivery_id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "Delivery not found".into()))?;
    let rows = sqlx::query(
        "SELECT * FROM notification_attempts WHERE delivery_id=$1 ORDER BY number DESC LIMIT 100",
    )
    .bind(delivery_id)
    .fetch_all(&state.pool)
    .await?;
    let mapped = rows.iter().map(|row| -> Result<Value,ApiError> { Ok(json!({"id":row.get::<Uuid,_>("id"),"number":row.get::<i32,_>("number"),"startedAt":timestamp(row,"started_at")?,"finishedAt":timestamp(row,"finished_at")?,"statusCode":row.get::<Option<i32>,_>("status_code"),"error":row.get::<Option<String>,_>("error")})) }).collect::<Result<Vec<_>,_>>()?;
    Ok(Json(json!({"delivery":delivery(&row)?,"attempts":mapped})))
}
pub async fn retry(
    State(state): State<AppState>,
    Path(value): Path<String>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let delivery_id = id(&value)?;
    let mut tx = state.pool.begin().await?;
    let row = sqlx::query("SELECT * FROM notification_deliveries WHERE id=$1 FOR UPDATE")
        .bind(delivery_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "Delivery not found".into()))?;
    if !matches!(
        row.get::<String, _>("status").as_str(),
        "failed" | "cancelled"
    ) {
        return Err(ApiError::conflict(
            "Only failed or cancelled deliveries can be retried",
        ));
    }
    let ch = sqlx::query("SELECT * FROM notification_channels WHERE id=$1")
        .bind(row.get::<Uuid, _>("channel_id"))
        .fetch_one(&mut *tx)
        .await?;
    if !ch.get::<bool, _>("enabled")
        || effective_url(&ch, &state.config.alert_webhook_url).is_empty()
    {
        return Err(ApiError::conflict(
            "Enable and configure the channel before retrying",
        ));
    }
    sqlx::query("UPDATE notification_deliveries SET status='pending',cycle_attempts=0,next_attempt_at=now(),last_error=NULL WHERE id=$1").bind(delivery_id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok((StatusCode::ACCEPTED, Json(json!({"queued":true}))))
}

fn reminder_eligible(row: &PgRow) -> bool {
    let config: Value = row.get("config");
    row.get::<Option<chrono::DateTime<chrono::Utc>>, _>("resolved_at")
        .is_none()
        && row.get::<bool, _>("enabled")
        && row
            .get::<Option<chrono::DateTime<chrono::Utc>>, _>("archived_at")
            .is_none()
        && row.get::<String, _>("status") == "down"
        && row.get::<Option<String>, _>("last_outcome").as_deref() == Some("fail")
        && config["reminderIntervalSeconds"]
            .as_i64()
            .is_some_and(|v| v > 0)
        && row
            .get::<Option<chrono::DateTime<chrono::Utc>>, _>("last_observed_at")
            .is_some_and(|observed| {
                chrono::Utc::now()
                    .signed_duration_since(observed)
                    .num_milliseconds()
                    <= config["intervalSeconds"]
                        .as_i64()
                        .unwrap_or(60)
                        .saturating_mul(3)
                        .max(120)
                        .saturating_mul(1000)
            })
}

pub async fn claim(state: &AppState, requested: Option<Uuid>) -> Result<Option<PgRow>, ApiError> {
    let mut tx = state.pool.begin().await?;
    let row = sqlx::query("SELECT d.* FROM notification_deliveries d WHERE d.status IN ('pending','retrying','delivering') AND d.next_attempt_at<=now() AND ($1::uuid IS NULL OR d.id=$1) AND NOT EXISTS (SELECT 1 FROM notification_deliveries earlier WHERE earlier.incident_id=d.incident_id AND earlier.channel_id=d.channel_id AND earlier.status IN ('pending','retrying','delivering') AND (earlier.created_at,earlier.id)<(d.created_at,d.id)) ORDER BY d.next_attempt_at,d.id LIMIT 1 FOR UPDATE OF d SKIP LOCKED")
        .bind(requested).fetch_optional(&mut *tx).await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let delivery_id: Uuid = row.get("id");
    if let Some(previous) = row.get::<Option<Uuid>, _>("claim_id") {
        sqlx::query("UPDATE notification_attempts SET finished_at=now(),error='Worker interrupted before acknowledgement was recorded' WHERE id=$1 AND finished_at IS NULL").bind(previous).execute(&mut *tx).await?;
    }
    let channel_id: Uuid = row.get("channel_id");
    let ch = sqlx::query("SELECT * FROM notification_channels WHERE id=$1")
        .bind(channel_id)
        .fetch_optional(&mut *tx)
        .await?;
    let exhausted = row.get::<i32, _>("cycle_attempts") >= 6;
    let configured = ch.as_ref().is_some_and(|ch| {
        ch.get::<bool, _>("enabled")
            && !effective_url(ch, &state.config.alert_webhook_url).is_empty()
    });
    let mut cancellation = if exhausted {
        Some((
            "failed",
            "Delivery retry limit reached after worker interruption",
        ))
    } else if !configured {
        Some(("cancelled", "Channel is disabled or unconfigured"))
    } else {
        None
    };
    if cancellation.is_none() && row.get::<Value, _>("event")["type"] == "incident.reminder" {
        let current = sqlx::query("SELECT m.*,i.resolved_at FROM incidents i JOIN monitors m ON m.id=i.monitor_id WHERE i.id=$1").bind(row.get::<Option<Uuid>,_>("incident_id")).fetch_optional(&mut *tx).await?;
        let applicable = current.as_ref().is_some_and(|current| {
            let config: Value = current.get("config");
            let routed = if let Some(routes) = config
                .get("notificationChannelIds")
                .and_then(Value::as_array)
            {
                routes.iter().any(|route| {
                    route
                        .as_str()
                        .is_some_and(|v| Uuid::parse_str(v).ok() == Some(channel_id))
                })
            } else {
                ch.as_ref()
                    .is_some_and(|ch| ch.get::<bool, _>("is_default"))
            };
            reminder_eligible(current) && routed
        });
        if !applicable {
            cancellation = Some(("cancelled", "Outage reminder is no longer applicable"));
        }
    }
    if let Some((status, error)) = cancellation {
        sqlx::query("UPDATE notification_deliveries SET status=$2,last_error=$3,next_attempt_at=NULL,lease_until=NULL,claim_id=NULL WHERE id=$1").bind(delivery_id).bind(status).bind(error).execute(&mut *tx).await?;
        tx.commit().await?;
        return Ok(None);
    }
    let claim_id = Uuid::new_v4();
    let updated = sqlx::query("UPDATE notification_deliveries SET status='delivering',attempts=attempts+1,cycle_attempts=cycle_attempts+1,claim_id=$2,lease_until=now()+interval '30 seconds',next_attempt_at=now()+interval '30 seconds' WHERE id=$1 RETURNING *").bind(delivery_id).bind(claim_id).fetch_one(&mut *tx).await?;
    sqlx::query("INSERT INTO notification_attempts(id,delivery_id,number) VALUES($1,$2,$3)")
        .bind(claim_id)
        .bind(delivery_id)
        .bind(updated.get::<i32, _>("attempts"))
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Some(updated))
}

pub async fn acknowledge(
    state: &AppState,
    row: &PgRow,
    result: crate::webhook::DeliveryResult,
) -> Result<(), ApiError> {
    let delivery_id: Uuid = row.get("id");
    let claim_id: Uuid = row.get("claim_id");
    let mut tx = state.pool.begin().await?;
    let current =
        sqlx::query("SELECT claim_id FROM notification_deliveries WHERE id=$1 FOR UPDATE")
            .bind(delivery_id)
            .fetch_optional(&mut *tx)
            .await?;
    if current.is_none_or(|current| current.get::<Option<Uuid>, _>("claim_id") != Some(claim_id)) {
        return Ok(());
    }
    sqlx::query(
        "UPDATE notification_attempts SET finished_at=now(),status_code=$2,error=$3 WHERE id=$1",
    )
    .bind(claim_id)
    .bind(result.status_code.map(i32::from))
    .bind(&result.error)
    .execute(&mut *tx)
    .await?;
    let cycle: i32 = row.get("cycle_attempts");
    let status = if result.error.is_none() {
        "delivered"
    } else if cycle >= 6 {
        "failed"
    } else {
        "retrying"
    };
    let delay = (30_i32 * 2_i32.pow((cycle - 1).clamp(0, 6) as u32)).min(1800);
    sqlx::query("UPDATE notification_deliveries SET status=$2,last_error=$3,next_attempt_at=CASE WHEN $2='retrying' THEN now()+($4::integer * interval '1 second') ELSE NULL END,delivered_at=CASE WHEN $2='delivered' THEN now() ELSE NULL END,claim_id=NULL,lease_until=NULL WHERE id=$1").bind(delivery_id).bind(status).bind(result.error).bind(delay).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}
pub async fn deliver_one(state: &AppState, requested: Option<Uuid>) -> Result<bool, ApiError> {
    let Some(row) = claim(state, requested).await? else {
        return Ok(false);
    };
    let target: String = row.get("target_url");
    let resolved = crate::secrets::resolve(
        &state.pool,
        &state.config.secrets,
        std::slice::from_ref(&target),
    )
    .await;
    let destination = resolved
        .ok()
        .and_then(|values| crate::executor::resolve_secrets(&target, &values).ok());
    let result = if let Some(destination) = destination {
        crate::webhook::send(
            &destination,
            &row.get::<Value, _>("event"),
            &row.get::<Uuid, _>("id").to_string(),
            state.config.allow_private_networks,
        )
        .await
    } else {
        crate::webhook::DeliveryResult {
            status_code: None,
            error: Some("A referenced webhook secret is unavailable".into()),
        }
    };
    acknowledge(state, &row, result).await?;
    Ok(true)
}

pub async fn reminders(state: &AppState) -> Result<(), ApiError> {
    let mut tx = state.pool.begin().await?;
    let due = sqlx::query("SELECT i.id AS incident_id,i.name AS incident_name,i.opened_at,i.resolved_at,i.last_reminder_at,m.* FROM incidents i JOIN monitors m ON m.id=i.monitor_id WHERE i.resolved_at IS NULL AND m.enabled AND m.archived_at IS NULL AND (m.config->>'reminderIntervalSeconds')::int IS NOT NULL AND COALESCE(i.last_reminder_at,i.opened_at) + ((m.config->>'reminderIntervalSeconds')::int * interval '1 second') <= now() ORDER BY i.opened_at LIMIT 100 FOR UPDATE OF i SKIP LOCKED").fetch_all(&mut *tx).await?;
    for row in due {
        if !reminder_eligible(&row) {
            continue;
        }
        let incident_id: Uuid = row.get("incident_id");
        let at = chrono::Utc::now();
        let event = json!({"id":incident_id,"type":"incident.reminder","name":row.get::<String,_>("incident_name"),"at":at.to_rfc3339_opts(chrono::SecondsFormat::Millis,true),"monitorId":row.get::<Uuid,_>("id")});
        queue_event(
            &mut tx,
            &state.config.alert_webhook_url,
            &event,
            &row.get::<Value, _>("config"),
            &format!("reminder:{incident_id}:{}", event["at"].as_str().unwrap()),
            None,
            None,
        )
        .await?;
        sqlx::query("UPDATE incidents SET last_reminder_at=$2 WHERE id=$1")
            .bind(incident_id)
            .bind(at)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}
