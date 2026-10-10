use crate::json::ApiPath;
use crate::{
    check_config,
    error::ApiError,
    json::ApiJson,
    server::{AppState, timestamp},
};
use axum::{Json, extract::State, http::StatusCode};
use chrono::{DateTime, Utc};
use serde_json::{Map, Value, json};
use sqlx::{Row, postgres::PgRow};
use std::collections::HashSet;
use uuid::Uuid;
fn object(v: &Value) -> Result<(), ApiError> {
    if v.is_object() {
        Ok(())
    } else {
        Err(ApiError::bad("Expected an object"))
    }
}
fn string(
    v: &Value,
    key: &str,
    default: Option<&str>,
    trim: bool,
    min: usize,
    max: usize,
) -> Result<String, ApiError> {
    let raw = match v.get(key) {
        Some(Value::String(v)) => v.as_str(),
        None => default.ok_or_else(|| ApiError::bad(format!("{key}: Required")))?,
        _ => return Err(ApiError::bad(format!("{key}: Expected a string"))),
    };
    check_config::text(&json!(if trim { raw.trim() } else { raw }), min, max, key)
}
fn flag(v: &Value, key: &str, default: bool) -> Result<bool, ApiError> {
    v.get(key).map_or(Ok(default), |v| {
        v.as_bool()
            .ok_or_else(|| ApiError::bad(format!("{key}: Expected a boolean")))
    })
}
fn array(v: &Value, key: &str, max: usize, default: bool) -> Result<Vec<Value>, ApiError> {
    match v.get(key) {
        None if default => Ok(vec![]),
        Some(Value::Array(a)) if a.len() <= max => Ok(a.clone()),
        _ => Err(ApiError::bad(format!("{key}: Invalid array"))),
    }
}
fn ids(v: &Value, required: bool) -> Result<Vec<String>, ApiError> {
    let a = array(v, "monitorIds", 500, !required)?;
    if required && a.is_empty() {
        return Err(ApiError::bad("Select at least one component"));
    }
    a.iter()
        .map(|v| {
            let id = v
                .as_str()
                .filter(|v| check_config::valid_uuid(v))
                .ok_or_else(|| ApiError::bad("Invalid component id"))?;
            Ok(id.into())
        })
        .collect()
}
fn link(value: &str) -> bool {
    value.is_empty()
        || (value.chars().count() <= 2048
            && url::Url::parse(value).is_ok_and(|u| {
                matches!(u.scheme(), "http" | "https")
                    && u.host_str().is_some()
                    && u.username().is_empty()
                    && u.password().is_none()
            }))
}
fn color(value: &str) -> bool {
    value.len() == 7
        && value.starts_with('#')
        && value.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
}
pub fn settings_schema(input: &Value) -> Result<Value, ApiError> {
    object(input)?;
    let mut out = Map::new();
    for (key, default, trim, min, max) in [
        ("title", None, true, 1, 100),
        ("brandName", Some("StillUp"), true, 1, 80),
        (
            "description",
            Some("A live look at the services you depend on."),
            false,
            0,
            1000,
        ),
        ("headerLabel", Some("SERVICE STATUS"), false, 0, 80),
        (
            "footerText",
            Some("Know before your users do."),
            false,
            0,
            300,
        ),
    ] {
        out.insert(
            key.into(),
            json!(string(input, key, default, trim, min, max)?),
        );
    }
    for key in ["logoUrl", "homepageUrl", "faviconUrl"] {
        let value = string(input, key, Some(""), false, 0, 2048)?;
        if !link(&value) {
            return Err(ApiError::bad("Use an HTTP(S) link without credentials"));
        }
        out.insert(key.into(), json!(value));
    }
    for (key, default) in [
        ("accentColor", "#00856a"),
        ("backgroundColor", "#f6f8f7"),
        ("surfaceColor", "#ffffff"),
        ("textColor", "#243d35"),
        ("darkBackgroundColor", ""),
        ("darkSurfaceColor", ""),
        ("darkTextColor", ""),
    ] {
        let value = string(input, key, Some(default), false, 0, 7)?;
        if !(color(&value) || key.starts_with("dark") && value.is_empty()) {
            return Err(ApiError::bad("Use a six-digit hex color"));
        }
        out.insert(key.into(), json!(value));
    }
    for (key, default, choices) in [
        ("theme", "light", &["light", "dark", "auto"][..]),
        (
            "layout",
            "comfortable",
            &["comfortable", "compact", "wide"][..],
        ),
        ("font", "sans", &["sans", "system", "mono", "serif"][..]),
    ] {
        let value = string(input, key, Some(default), false, 0, 40)?;
        if !choices.contains(&value.as_str()) {
            return Err(ApiError::bad(format!("{key}: Invalid option")));
        }
        out.insert(key.into(), json!(value));
    }
    out.insert(
        "cornerRadius".into(),
        json!(check_config::integer(
            input.get("cornerRadius").unwrap_or(&json!(16)),
            0,
            32,
            "cornerRadius"
        )?),
    );
    for key in ["showPoweredBy", "showIncidentHistory"] {
        out.insert(key.into(), json!(flag(input, key, true)?));
    }
    let links = array(input, "links", 8, true)?
        .iter()
        .map(|v| {
            object(v)?;
            let label = string(v, "label", None, true, 1, 60)?;
            let url = string(v, "url", Some(""), false, 1, 2048)?;
            if !link(&url) {
                return Err(ApiError::bad("Enter a link URL"));
            }
            Ok(json!({"label":label,"url":url}))
        })
        .collect::<Result<Vec<_>, ApiError>>()?;
    out.insert("links".into(), json!(links));
    let mut content_ids = HashSet::new();
    let mut group_ids = HashSet::new();
    let mut monitor_ids = HashSet::new();
    let content=array(input,"content",12,true)?.iter().map(|v|{object(v)?;let id=string(v,"id",None,false,1,80)?;if !check_config::valid_uuid(&id)||!content_ids.insert(id.clone()){return Err(ApiError::bad("Each content section must have a unique ID"));}let position=string(v,"position",None,false,0,40)?;if !matches!(position.as_str(),"before-services"|"after-services"){return Err(ApiError::bad("Invalid content position"));}Ok(json!({"id":id,"title":string(v,"title",None,true,1,120)?,"body":string(v,"body",None,false,0,4000)?,"position":position}))}).collect::<Result<Vec<_>,ApiError>>()?;
    out.insert("content".into(), json!(content));
    let groups = array(input, "groups", 30, true)?
        .iter()
        .map(|v| {
            object(v)?;
            let id = string(v, "id", None, false, 1, 80)?;
            let components = ids(v, false)?;
            if v.get("monitorIds").is_none() {
                return Err(ApiError::bad("monitorIds: Required"));
            }
            if !check_config::valid_uuid(&id)
                || !group_ids.insert(id.clone())
                || components.iter().any(|id| !monitor_ids.insert(id.clone()))
            {
                return Err(ApiError::bad(
                    "Each component and group must appear only once",
                ));
            }
            Ok(json!({"id":id,"name":string(v,"name",None,true,1,80)?,"monitorIds":components}))
        })
        .collect::<Result<Vec<_>, ApiError>>()?;
    out.insert("groups".into(), json!(groups));
    Ok(Value::Object(out))
}
async fn valid_monitors(
    state: &AppState,
    values: &[String],
    published: bool,
) -> Result<Vec<Uuid>, ApiError> {
    let parsed = values
        .iter()
        .map(|v| crate::notifications::id(v))
        .collect::<Result<Vec<_>, _>>()?;
    if !values.is_empty() {
        let rows=sqlx::query("SELECT id FROM monitors WHERE id=ANY($1::uuid[]) AND (NOT $2 OR (config->>'public')::boolean AND archived_at IS NULL)").bind(&parsed).bind(published).fetch_all(&state.pool).await?;
        if rows.len() != values.iter().collect::<HashSet<_>>().len() {
            return Err(ApiError::bad(if published {
                "Select published, active components"
            } else {
                "A component does not exist"
            }));
        }
    }
    Ok(parsed)
}
pub async fn settings(state: &AppState) -> Result<Value, ApiError> {
    let row = sqlx::query("SELECT * FROM status_settings WHERE id=1")
        .fetch_optional(&state.pool)
        .await?;
    match row {
        Some(row) => Ok(
            json!({"settings":settings_schema(&row.get::<Value,_>("config"))?,"revision":row.get::<i32,_>("revision")}),
        ),
        None => Ok(
            json!({"settings":settings_schema(&json!({"title":state.config.status_page_title}))?,"revision":0}),
        ),
    }
}
pub async fn save_settings(
    State(state): State<AppState>,
    ApiJson(input): ApiJson,
) -> Result<Json<Value>, ApiError> {
    let config = settings_schema(&input["config"])?;
    let revision = check_config::integer(
        &input["expectedRevision"],
        0,
        crate::check_config::MAX_SAFE_INTEGER,
        "expectedRevision",
    )?;
    let ids = config["groups"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|v| v["monitorIds"].as_array().unwrap())
        .map(|v| v.as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    valid_monitors(&state, &ids, false).await?;
    let mut tx = state.pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext('stillup-status-settings'))")
        .execute(&mut *tx)
        .await?;
    let current: i32 = sqlx::query_scalar("SELECT revision FROM status_settings WHERE id=1")
        .fetch_optional(&mut *tx)
        .await?
        .unwrap_or(0);
    if i64::from(current) != revision {
        return Err(ApiError::conflict(
            "Public page settings changed elsewhere. Reload before saving.",
        ));
    }
    let revision:i32=sqlx::query_scalar("INSERT INTO status_settings(id,config,revision) VALUES(1,$1,1) ON CONFLICT(id) DO UPDATE SET config=$1,revision=status_settings.revision+1 RETURNING revision").bind(&config).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(json!({"settings":config,"revision":revision})))
}
fn window(row: &PgRow) -> Result<Value, ApiError> {
    Ok(
        json!({"id":row.get::<Uuid,_>("id"),"title":row.get::<String,_>("title"),"description":row.get::<String,_>("description"),"monitorIds":row.get::<Vec<Uuid>,_>("monitor_ids"),"startsAt":timestamp(row,"starts_at")?,"endsAt":timestamp(row,"ends_at")?,"cancelled":row.get::<bool,_>("cancelled"),"revision":row.get::<i32,_>("revision")}),
    )
}
pub fn iso_date(value: &str) -> Option<DateTime<Utc>> {
    let bytes = value.as_bytes();
    if bytes.len() < 20
        || !value.is_ascii()
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return None;
    }
    if ![
        &bytes[..4],
        &bytes[5..7],
        &bytes[8..10],
        &bytes[11..13],
        &bytes[14..16],
        &bytes[17..19],
    ]
    .iter()
    .all(|part| part.iter().all(u8::is_ascii_digit))
        || value[17..19].parse::<u8>().ok()? > 59
    {
        return None;
    }
    let zone = if value.ends_with('Z') {
        bytes.len() - 1
    } else {
        let start = bytes.len().checked_sub(6)?;
        if !matches!(bytes[start], b'+' | b'-')
            || bytes[start + 3] != b':'
            || !bytes[start + 1..start + 3]
                .iter()
                .chain(bytes[start + 4..].iter())
                .all(u8::is_ascii_digit)
            || value[start + 1..start + 3].parse::<u8>().ok()? > 23
            || value[start + 4..].parse::<u8>().ok()? > 59
        {
            return None;
        }
        start
    };
    if zone < 19 {
        return None;
    }
    let fraction = &value[19..zone];
    if !fraction.is_empty()
        && (!fraction.starts_with('.')
            || fraction.len() < 2
            || !fraction.as_bytes()[1..].iter().all(u8::is_ascii_digit))
    {
        return None;
    }
    let normalized = if fraction.len() > 10 {
        format!("{}{}", &value[..29], &value[zone..])
    } else {
        value.into()
    };
    DateTime::parse_from_rfc3339(&normalized)
        .ok()
        .map(|v| v.with_timezone(&Utc))
}

async fn maintenance(state: &AppState, input: &Value, id: Option<Uuid>) -> Result<Value, ApiError> {
    object(input)?;
    let title = string(input, "title", None, true, 1, 160)?;
    let description = string(input, "description", Some(""), false, 0, 4000)?;
    let monitor_ids = valid_monitors(state, &ids(input, false)?, id.is_none()).await?;
    let date = |key: &str| {
        input[key]
            .as_str()
            .and_then(iso_date)
            .ok_or_else(|| ApiError::bad(format!("{key}: Invalid ISO date")))
    };
    let start = date("startsAt")?;
    let end = date("endsAt")?;
    if end.timestamp_millis() <= start.timestamp_millis() {
        return Err(ApiError::bad("End must be after start"));
    }
    let cancelled = flag(input, "cancelled", false)?;
    let row = if let Some(id) = id {
        let revision = check_config::integer(
            &input["expectedRevision"],
            1,
            crate::check_config::MAX_SAFE_INTEGER,
            "expectedRevision",
        )?;
        sqlx::query("UPDATE maintenance_windows SET title=$1,description=$2,monitor_ids=$3,starts_at=$4,ends_at=$5,cancelled=$6,revision=revision+1 WHERE id=$7 AND revision=$8::bigint RETURNING *").bind(title).bind(description).bind(monitor_ids).bind(start).bind(end).bind(cancelled).bind(id).bind(revision).fetch_optional(&state.pool).await?.ok_or_else(||ApiError::conflict("Maintenance changed elsewhere or was removed. Reload before saving."))?
    } else {
        sqlx::query("INSERT INTO maintenance_windows(title,description,monitor_ids,starts_at,ends_at,cancelled) VALUES($1,$2,$3,$4,$5,$6) RETURNING *").bind(title).bind(description).bind(monitor_ids).bind(start).bind(end).bind(cancelled).fetch_one(&state.pool).await?
    };
    window(&row)
}
pub async fn create_maintenance(
    State(state): State<AppState>,
    ApiJson(input): ApiJson,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    Ok((
        StatusCode::CREATED,
        Json(maintenance(&state, &input, None).await?),
    ))
}
pub async fn edit_maintenance(
    State(state): State<AppState>,
    ApiPath(value): ApiPath<String>,
    ApiJson(input): ApiJson,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        maintenance(&state, &input, Some(crate::notifications::id(&value)?)).await?,
    ))
}
pub async fn create_incident(
    State(state): State<AppState>,
    ApiJson(input): ApiJson,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    object(&input)?;
    let title = string(&input, "title", None, true, 1, 160)?;
    let body = string(&input, "body", None, true, 1, 4000)?;
    let monitor_ids = valid_monitors(&state, &ids(&input, true)?, true).await?;
    let mut tx = state.pool.begin().await?;
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO status_incidents(title,monitor_ids) VALUES($1,$2) RETURNING id",
    )
    .bind(title)
    .bind(monitor_ids)
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query("INSERT INTO status_updates(incident_id,source,stage,body) VALUES($1,'manual','investigating',$2)").bind(id).bind(body).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(json!({"id":id}))))
}
pub async fn update_incident(
    State(state): State<AppState>,
    ApiPath(value): ApiPath<String>,
    ApiJson(input): ApiJson,
) -> Result<Json<Value>, ApiError> {
    object(&input)?;
    let id = crate::notifications::id(&value)?;
    let source = string(&input, "source", None, false, 0, 20)?;
    if !matches!(source.as_str(), "manual" | "automatic") {
        return Err(ApiError::bad("Invalid incident source"));
    }
    let stage = string(&input, "stage", None, false, 0, 20)?;
    if !matches!(
        stage.as_str(),
        "investigating" | "identified" | "monitoring" | "resolved"
    ) {
        return Err(ApiError::bad("Invalid incident stage"));
    }
    let body = string(&input, "body", None, true, 1, 4000)?;
    let revision = check_config::integer(
        &input["expectedRevision"],
        1,
        crate::check_config::MAX_SAFE_INTEGER,
        "expectedRevision",
    )?;
    let mut tx = state.pool.begin().await?;
    let query = if source == "manual" {
        "SELECT revision,resolved_at FROM status_incidents WHERE id=$1 FOR UPDATE"
    } else {
        "SELECT communication_revision AS revision,resolved_at FROM incidents WHERE id=$1 FOR UPDATE"
    };
    let row = sqlx::query(query)
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "Incident not found".into()))?;
    if i64::from(row.get::<i32, _>("revision")) != revision {
        return Err(ApiError::conflict(
            "Incident was updated elsewhere. Reload before publishing.",
        ));
    }
    if source == "automatic"
        && stage == "resolved"
        && row.get::<Option<DateTime<Utc>>, _>("resolved_at").is_none()
    {
        return Err(ApiError::conflict(
            "Monitoring has not confirmed recovery. Use a monitoring update instead.",
        ));
    }
    if source == "manual" {
        sqlx::query("UPDATE status_incidents SET revision=revision+1,resolved_at=CASE WHEN $2 THEN COALESCE(resolved_at,now()) ELSE NULL END WHERE id=$1").bind(id).bind(stage=="resolved").execute(&mut *tx).await?;
    } else {
        sqlx::query(
            "UPDATE incidents SET communication_revision=communication_revision+1 WHERE id=$1",
        )
        .bind(id)
        .execute(&mut *tx)
        .await?;
    }
    sqlx::query("INSERT INTO status_updates(incident_id,source,stage,body) VALUES($1,$2,$3,$4)")
        .bind(id)
        .bind(source)
        .bind(stage)
        .bind(body)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(json!({"ok":true})))
}

async fn communications(
    state: &AppState,
    public_ids: Option<&[Uuid]>,
) -> Result<Vec<Value>, ApiError> {
    let rows=sqlx::query("SELECT * FROM (SELECT id,name,ARRAY[monitor_id] AS monitor_ids,'automatic' AS source,opened_at,resolved_at,communication_revision AS revision FROM incidents WHERE ($1::uuid[] IS NULL OR monitor_id=ANY($1::uuid[])) UNION ALL SELECT id,title AS name,monitor_ids,'manual' AS source,created_at AS opened_at,resolved_at,revision FROM status_incidents WHERE ($1::uuid[] IS NULL OR monitor_ids && $1::uuid[])) combined ORDER BY (resolved_at IS NULL) DESC,opened_at DESC LIMIT 100").bind(public_ids).fetch_all(&state.pool).await?;
    if rows.is_empty() {
        return Ok(vec![]);
    }
    let ids: Vec<Uuid> = rows.iter().map(|r| r.get("id")).collect();
    let updates=sqlx::query("SELECT * FROM (SELECT *,row_number() OVER (PARTITION BY incident_id ORDER BY created_at DESC,id DESC) AS rn FROM status_updates WHERE incident_id=ANY($1::uuid[])) t WHERE rn<=50 ORDER BY created_at DESC,id DESC").bind(&ids).fetch_all(&state.pool).await?;
    rows.iter().map(|row|{
        let id:Uuid=row.get("id");let source:String=row.get("source");let monitors:Vec<Uuid>=row.get("monitor_ids");
        let history=updates.iter().filter(|u|u.get::<Uuid,_>("incident_id")==id&&u.get::<String,_>("source")==source).map(|u|->Result<Value,ApiError>{Ok(json!({"id":u.get::<Uuid,_>("id"),"stage":u.get::<String,_>("stage"),"body":u.get::<String,_>("body"),"createdAt":timestamp(u,"created_at")?}))}).collect::<Result<Vec<_>,_>>()?;
        let stage=if row.get::<Option<DateTime<Utc>>,_>("resolved_at").is_some(){"resolved"}else{history.first().and_then(|v|v["stage"].as_str()).unwrap_or("investigating")};
        Ok(json!({"id":id,"name":row.get::<String,_>("name"),"source":source,"monitorIds":monitors.into_iter().filter(|id|public_ids.is_none_or(|ids|ids.contains(id))).collect::<Vec<_>>(),"openedAt":timestamp(row,"opened_at")?,"resolvedAt":timestamp(row,"resolved_at")?,"revision":row.get::<i32,_>("revision"),"stage":stage,"updates":history}))
    }).collect()
}
pub async fn admin(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let mut config = settings(&state).await?;
    let rows=sqlx::query("SELECT * FROM maintenance_windows ORDER BY (NOT cancelled AND starts_at<=now() AND ends_at>now()) DESC,starts_at DESC LIMIT 100").fetch_all(&state.pool).await?;
    config["maintenance"] = json!(rows.iter().map(window).collect::<Result<Vec<_>, _>>()?);
    config["incidents"] = json!(communications(&state, None).await?);
    Ok(Json(config))
}
pub(crate) const UPTIME_DAYS: i32 = 90;

pub(crate) fn uptime_percentage(observed: i64, down: i64) -> Option<f64> {
    (observed > 0)
        .then(|| ((observed - down) as f64 * 100_000.0 / observed as f64).floor() / 1000.0)
}

/// Daily rollups, oldest first, as `(UTC date, observed seconds, down seconds)`.
pub(crate) fn uptime_summary(days: &[(String, i64, i64)]) -> Value {
    let (observed, down) = days.iter().fold((0, 0), |(o, d), (_, observed, down)| {
        (o + observed, d + down)
    });
    json!({
        "windowDays": UPTIME_DAYS,
        "percentage": uptime_percentage(observed, down),
        "days": days.iter().map(|(date, observed, down)| json!({"date": date, "percentage": uptime_percentage(*observed, *down)})).collect::<Vec<_>>(),
    })
}

pub async fn public_status(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let (rows, history, settings) = tokio::try_join!(
        async {
            sqlx::query("SELECT id,config,status,enabled,last_observed_at FROM monitors WHERE (config->>'public')::boolean IS TRUE AND archived_at IS NULL ORDER BY created_at").fetch_all(&state.pool).await.map_err(ApiError::from)
        },
        async {
            sqlx::query("SELECT i.id,i.monitor_id,i.name,i.opened_at,i.resolved_at FROM incidents i JOIN monitors m ON m.id=i.monitor_id WHERE (m.config->>'public')::boolean IS TRUE AND m.archived_at IS NULL ORDER BY i.opened_at DESC LIMIT 50").fetch_all(&state.pool).await.map_err(ApiError::from)
        },
        settings(&state),
    )?;
    let ids: Vec<Uuid> = rows.iter().map(|r| r.get("id")).collect();
    let config = &settings["settings"];
    let (windows, impact, communication, daily) = tokio::try_join!(
        async {
            sqlx::query("SELECT * FROM maintenance_windows WHERE NOT cancelled AND ends_at>now() AND (cardinality(monitor_ids)=0 OR monitor_ids && $1::uuid[]) ORDER BY starts_at LIMIT 100").bind(&ids).fetch_all(&state.pool).await.map_err(ApiError::from)
        },
        async {
            sqlx::query("SELECT m.id,EXISTS(SELECT 1 FROM maintenance_windows w WHERE NOT w.cancelled AND w.starts_at<=now() AND w.ends_at>now() AND (cardinality(w.monitor_ids)=0 OR m.id=ANY(w.monitor_ids))) AS maintenance,EXISTS(SELECT 1 FROM status_incidents i WHERE i.resolved_at IS NULL AND m.id=ANY(i.monitor_ids)) AS incident FROM monitors m WHERE m.id=ANY($1::uuid[])").bind(&ids).fetch_all(&state.pool).await.map_err(ApiError::from)
        },
        communications(&state, Some(&ids)),
        async {
            sqlx::query("SELECT monitor_id,day::text AS day,observed_seconds,down_seconds FROM monitor_daily_uptime WHERE monitor_id=ANY($1::uuid[]) AND day>(now() AT TIME ZONE 'UTC')::date-$2::integer ORDER BY day").bind(&ids).bind(UPTIME_DAYS).fetch_all(&state.pool).await.map_err(ApiError::from)
        },
    )?;
    let components=rows.iter().map(|row|->Result<Value,ApiError>{
        let id:Uuid=row.get("id");let check:Value=row.get("config");let status:String=row.get("status");
        let current=impact.iter().find(|r|r.get::<Uuid,_>("id")==id);
        let health=if current.is_some_and(|r|r.get::<bool,_>("maintenance")){"maintenance"}else if current.is_some_and(|r|r.get::<bool,_>("incident")){"down"}else{crate::health::visible(&status,row.get("enabled"),row.get("last_observed_at"),check["intervalSeconds"].as_i64().unwrap_or(60),Utc::now())};
        let days:Vec<(String,i64,i64)>=daily.iter().filter(|r|r.get::<Uuid,_>("monitor_id")==id).map(|r|(r.get("day"),r.get("observed_seconds"),r.get("down_seconds"))).collect();
        let mut component=json!({"id":id,"name":check["name"],"health":health,"lastObservedAt":timestamp(row,"last_observed_at")?,"uptime":uptime_summary(&days)});
        if let Some(group)=config["groups"].as_array().unwrap().iter().find(|g|g["monitorIds"].as_array().unwrap().contains(&json!(id))){component["groupId"]=group["id"].clone();}Ok(component)
    }).collect::<Result<Vec<_>,_>>()?;
    let groups = config["groups"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|g| {
            components
                .iter()
                .any(|c| c.get("groupId") == Some(&g["id"]))
        })
        .map(|g| json!({"id":g["id"],"name":g["name"]}))
        .collect::<Vec<_>>();
    let mut branding = config.clone();
    branding.as_object_mut().unwrap().remove("groups");
    let maintenance = if ids.is_empty() {
        vec![]
    } else {
        windows
            .iter()
            .map(|row| {
                let mut result = window(row)?;
                let monitors: Vec<Uuid> = row.get("monitor_ids");
                result["monitorIds"] = json!(if monitors.is_empty() {
                    ids.clone()
                } else {
                    monitors.into_iter().filter(|id| ids.contains(id)).collect()
                });
                Ok(result)
            })
            .collect::<Result<Vec<_>, ApiError>>()?
    };
    let incidents=history.iter().map(|r|->Result<Value,ApiError>{Ok(json!({"id":r.get::<Uuid,_>("id"),"monitorId":r.get::<Uuid,_>("monitor_id"),"name":r.get::<String,_>("name"),"openedAt":timestamp(r,"opened_at")?,"resolvedAt":timestamp(r,"resolved_at")?}))}).collect::<Result<Vec<_>,_>>()?;
    Ok(Json(
        json!({"title":config["title"],"updatedAt":Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true),"branding":branding,"groups":groups,"components":components,"incidents":incidents,"maintenance":maintenance,"communications":communication}),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn uptime_is_interval_weighted_and_never_rounds_up() {
        assert_eq!(uptime_percentage(0, 0), None);
        assert_eq!(uptime_percentage(86_400, 0), Some(100.0));
        assert_eq!(uptime_percentage(86_400, 60), Some(99.930));
        assert_eq!(uptime_percentage(1_000_000, 1), Some(99.999));
        let summary = uptime_summary(&[
            ("2026-10-07".into(), 86_400, 0),
            ("2026-10-08".into(), 86_400, 86_400),
        ]);
        assert_eq!(summary["percentage"], 50.0);
        assert_eq!(
            summary["days"][1],
            json!({"date":"2026-10-08","percentage":0.0})
        );
        assert_eq!(uptime_summary(&[])["percentage"], Value::Null);
    }
    #[test]
    fn status_settings_and_dates_match_typescript_contracts() {
        let fixtures: Vec<Value> =
            serde_json::from_str(include_str!("../tests/fixtures/status-contracts.json")).unwrap();
        for case in fixtures {
            let result = settings_schema(&case["input"]);
            assert_eq!(
                result.is_ok(),
                case["valid"].as_bool().unwrap(),
                "{}",
                case["name"]
            );
            if let Ok(output) = result {
                assert_eq!(output, case["output"], "{}", case["name"]);
            }
        }
        let fixtures: Vec<Value> =
            serde_json::from_str(include_str!("../tests/fixtures/status-date-contracts.json"))
                .unwrap();
        for case in fixtures {
            assert_eq!(
                iso_date(case["date"].as_str().unwrap()).is_some(),
                case["valid"].as_bool().unwrap(),
                "{}",
                case["date"]
            );
        }
    }
}
