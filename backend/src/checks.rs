use crate::{
    error::ApiError,
    json::ApiJson,
    server::{AppState, monitor, timestamp},
};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
};
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use sqlx::{Row, postgres::PgRow};
use std::collections::HashMap;
use uuid::Uuid;
fn id(value: &str) -> Result<Uuid, ApiError> {
    if !crate::check_config::valid_uuid(value) {
        return Err(ApiError::bad("id: Invalid UUID"));
    }
    Uuid::parse_str(value).map_err(|_| ApiError::bad("id: Invalid UUID"))
}
async fn require(state: &AppState, id: Uuid) -> Result<PgRow, ApiError> {
    sqlx::query("SELECT * FROM monitors WHERE id=$1")
        .bind(id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "Check not found".into()))
}
pub async fn read(
    State(state): State<AppState>,
    Path(value): Path<String>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(monitor(&require(&state, id(&value)?).await?)?))
}
pub async fn runs(
    State(state): State<AppState>,
    Path(value): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let id = id(&value)?;
    require(&state, id).await?;
    let rows =
        sqlx::query("SELECT * FROM runs WHERE monitor_id=$1 ORDER BY checked_at DESC LIMIT 50")
            .bind(id)
            .fetch_all(&state.pool)
            .await?;
    let rows = rows.iter().map(|row| -> Result<Value, sqlx::Error> { Ok(json!({
        "id":row.try_get::<Uuid,_>("id")?, "monitorId":id,"configRevision":row.try_get::<i32,_>("config_revision")?,
        "outcome":row.try_get::<String,_>("outcome")?,"statusCode":row.try_get::<Option<i32>,_>("status_code")?,
        "durationMs":row.try_get::<i32,_>("duration_ms")?,"failures":row.try_get::<Value,_>("failures")?,
        "assertions":row.try_get::<Value,_>("assertions")?,"checkedAt":timestamp(row,"checked_at")?
    })) }).collect::<Result<Vec<_>,_>>()?;
    Ok(Json(json!(rows)))
}
fn revision(row: &PgRow) -> Result<Value, sqlx::Error> {
    Ok(
        json!({"monitorId":row.try_get::<Uuid,_>("monitor_id")?,"revision":row.try_get::<i32,_>("revision")?,"config":row.try_get::<Value,_>("config")?,"createdAt":timestamp(row,"created_at")?}),
    )
}
pub async fn revisions(
    State(state): State<AppState>,
    Path(value): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Json<Value>, ApiError> {
    let id = id(&value)?;
    require(&state, id).await?;
    let before = query
        .get("before")
        .map(|v| {
            v.parse::<i32>()
                .ok()
                .filter(|v| *v > 0)
                .ok_or_else(|| ApiError::bad("before: Expected a positive integer"))
        })
        .transpose()?;
    let rows = sqlx::query("SELECT * FROM check_revisions WHERE monitor_id=$1 AND ($2::integer IS NULL OR revision<$2) ORDER BY revision DESC LIMIT 21").bind(id).bind(before).fetch_all(&state.pool).await?;
    let next = if rows.len() > 20 {
        Some(rows[19].try_get::<i32, _>("revision")?)
    } else {
        None
    };
    let rows = rows
        .iter()
        .take(20)
        .map(revision)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Json(json!({"revisions":rows,"nextBefore":next})))
}
pub async fn read_revision(
    State(state): State<AppState>,
    Path((value, number)): Path<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    let number = number
        .parse::<i32>()
        .ok()
        .filter(|v| *v > 0)
        .ok_or_else(|| ApiError::bad("revision: Expected a positive integer"))?;
    let row = sqlx::query("SELECT * FROM check_revisions WHERE monitor_id=$1 AND revision=$2")
        .bind(id(&value)?)
        .bind(number)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| {
            ApiError(
                StatusCode::NOT_FOUND,
                "Configuration revision not found".into(),
            )
        })?;
    Ok(Json(revision(&row)?))
}
enum Change {
    Enabled(bool),
    Edit(Value),
    Archive,
    Restore,
}
fn expected(input: &Value, required: bool) -> Result<Option<i32>, ApiError> {
    match input.get("expectedRevision") {
        None if !required => Ok(None),
        Some(value) => {
            Ok(Some(
                crate::check_config::integer(value, 1, i32::MAX as i64, "expectedRevision")? as i32,
            ))
        }
        _ => Err(ApiError::bad("expectedRevision: Required")),
    }
}
async fn change(
    state: &AppState,
    id: Uuid,
    change: Change,
    expected: Option<i32>,
) -> Result<Value, ApiError> {
    if let Change::Edit(config) = &change {
        validate_routes(state, config).await?;
    }
    let mut tx = state.pool.begin().await?;
    let row = sqlx::query("SELECT * FROM monitors WHERE id=$1 FOR UPDATE")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "Check not found".into()))?;
    if matches!(change, Change::Edit(_))
        && row.try_get::<Option<String>, _>("code_project")?.is_some()
    {
        return Err(ApiError::conflict(
            "This check is managed as code. Edit its project configuration and apply it with the CLI.",
        ));
    }
    let revision: i32 = row.try_get("config_revision")?;
    if expected.is_some_and(|expected| expected != revision) {
        return Err(ApiError::conflict(
            "This check was edited elsewhere. Reopen the editor to load the latest configuration. Your changes have not been saved.",
        ));
    }
    let archived: Option<DateTime<Utc>> = row.try_get("archived_at")?;
    let enabled: bool = row.try_get("enabled")?;
    if matches!(change, Change::Archive) && archived.is_some()
        || matches!(change, Change::Restore) && archived.is_none()
    {
        return Ok(monitor(&row)?);
    }
    if archived.is_some() && !matches!(change, Change::Restore) {
        return Err(ApiError::conflict(
            "Restore this archived check before changing it",
        ));
    }
    if let Change::Enabled(value) = change
        && value == enabled
    {
        return Ok(monitor(&row)?);
    }
    if let Change::Edit(config) = &change {
        if *config == row.try_get::<Value, _>("config")? {
            return Ok(monitor(&row)?);
        }
        sqlx::query("INSERT INTO check_revisions(monitor_id,revision,config) VALUES($1,$2,$3)")
            .bind(id)
            .bind(revision + 1)
            .bind(config)
            .execute(&mut *tx)
            .await?;
        let row=sqlx::query("UPDATE monitors SET config=$2, config_revision=config_revision+1, execution_epoch=execution_epoch+1, next_run_at=now(), failures=0, successes=0, last_observed_at=NULL, last_run_at=NULL, last_outcome=NULL, last_duration_ms=NULL, status=CASE WHEN status='down' THEN 'down' ELSE 'unknown' END WHERE id=$1 RETURNING *").bind(id).bind(config).fetch_one(&mut *tx).await?;
        let result = monitor(&row)?;
        tx.commit().await?;
        return Ok(result);
    }
    let sql = match change {
        Change::Edit(_) => unreachable!("edit handled above"),
        Change::Archive => {
            "UPDATE monitors SET execution_epoch=execution_epoch+1, archived_at=now(), enabled=false WHERE id=$1 RETURNING *"
        }
        Change::Restore => {
            "UPDATE monitors SET execution_epoch=execution_epoch+1, archived_at=NULL, enabled=false WHERE id=$1 RETURNING *"
        }
        Change::Enabled(false) => {
            "UPDATE monitors SET execution_epoch=execution_epoch+1, enabled=false WHERE id=$1 RETURNING *"
        }
        Change::Enabled(true) => {
            "UPDATE monitors SET execution_epoch=execution_epoch+1, enabled=true, next_run_at=now(), failures=0, successes=0, last_observed_at=NULL, last_run_at=NULL, last_outcome=NULL, last_duration_ms=NULL, status=CASE WHEN status='down' THEN 'down' ELSE 'unknown' END WHERE id=$1 RETURNING *"
        }
    };
    let row = sqlx::query(sql).bind(id).fetch_one(&mut *tx).await?;
    let result = monitor(&row)?;
    tx.commit().await?;
    Ok(result)
}
pub async fn set_enabled(
    State(state): State<AppState>,
    Path(value): Path<String>,
    ApiJson(input): ApiJson,
) -> Result<Json<Value>, ApiError> {
    let enabled = input
        .get("enabled")
        .and_then(Value::as_bool)
        .ok_or_else(|| ApiError::bad("enabled: Expected a boolean"))?;
    Ok(Json(
        change(
            &state,
            id(&value)?,
            Change::Enabled(enabled),
            expected(&input, false)?,
        )
        .await?,
    ))
}
pub async fn archive(
    State(state): State<AppState>,
    Path(value): Path<String>,
    ApiJson(input): ApiJson,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        change(
            &state,
            id(&value)?,
            Change::Archive,
            expected(&input, true)?,
        )
        .await?,
    ))
}
pub async fn restore(
    State(state): State<AppState>,
    Path(value): Path<String>,
    ApiJson(input): ApiJson,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        change(
            &state,
            id(&value)?,
            Change::Restore,
            expected(&input, true)?,
        )
        .await?,
    ))
}

pub async fn validate_routes(state: &AppState, config: &Value) -> Result<(), ApiError> {
    let locations: Vec<String> = config
        .get("locationIds")
        .and_then(Value::as_array)
        .map(|v| v.iter().map(|v| v.as_str().unwrap().to_string()).collect())
        .unwrap_or_else(|| vec!["local".into()]);
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM probe_locations WHERE id=ANY($1::text[]) AND revoked_at IS NULL",
    )
    .bind(&locations)
    .fetch_one(&state.pool)
    .await?;
    if count != locations.len() as i64 {
        return Err(ApiError::bad("Choose existing, non-revoked locations"));
    }
    if let Some(ids) = config["notificationChannelIds"].as_array() {
        let ids: Vec<Uuid> = ids
            .iter()
            .map(|v| Uuid::parse_str(v.as_str().unwrap()).unwrap())
            .collect();
        let count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM notification_channels WHERE id=ANY($1::uuid[])",
        )
        .bind(&ids)
        .fetch_one(&state.pool)
        .await?;
        if count != ids.len() as i64 {
            return Err(ApiError::bad(
                "A selected notification channel does not exist",
            ));
        }
    }
    Ok(())
}
pub async fn create(
    State(state): State<AppState>,
    ApiJson(input): ApiJson,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let config = crate::check_config::validate(&input)?;
    validate_routes(&state, &config).await?;
    let mut tx = state.pool.begin().await?;
    let row = sqlx::query("INSERT INTO monitors(config) VALUES($1) RETURNING *")
        .bind(&config)
        .fetch_one(&mut *tx)
        .await?;
    let id: Uuid = row.try_get("id")?;
    sqlx::query("INSERT INTO check_revisions(monitor_id,revision,config,created_at) SELECT id,config_revision,config,created_at FROM monitors WHERE id=$1").bind(id).execute(&mut *tx).await?;
    let result = monitor(&row)?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(result)))
}
pub async fn edit(
    State(state): State<AppState>,
    Path(value): Path<String>,
    ApiJson(input): ApiJson,
) -> Result<Json<Value>, ApiError> {
    let config = crate::check_config::validate(input.get("config").unwrap_or(&Value::Null))?;
    Ok(Json(
        change(
            &state,
            id(&value)?,
            Change::Edit(config),
            expected(&input, true)?,
        )
        .await?,
    ))
}

pub async fn test_request(
    State(state): State<AppState>,
    ApiJson(input): ApiJson,
) -> Result<Json<Value>, ApiError> {
    let config = crate::check_config::validate(&input)?;
    let _permit = state.previews.try_acquire().map_err(|_| {
        ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            "Two request tests are already running. Try again shortly.".into(),
        )
    })?;
    let mut values: Vec<String> = config["headers"]
        .as_object()
        .unwrap()
        .values()
        .map(|v| v.as_str().unwrap().into())
        .collect();
    values.push(config["body"].as_str().unwrap().into());
    let secrets = crate::secrets::resolve(&state.pool, &state.config.secrets, &values).await?;
    Ok(Json(
        crate::executor::execute(
            &config,
            &crate::executor::Options {
                allow_private_networks: state.config.allow_private_networks,
                secrets,
            },
        )
        .await,
    ))
}
