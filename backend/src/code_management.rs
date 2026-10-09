use crate::{
    check_config, checks,
    error::ApiError,
    json::ApiJson,
    server::{AppState, timestamp},
};
use axum::{Json, extract::State};
use icu_collator::{Collator, CollatorBorrowed};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::Row;
use std::{collections::HashSet, sync::OnceLock};
use uuid::Uuid;

fn collator() -> &'static CollatorBorrowed<'static> {
    static COLLATOR: OnceLock<CollatorBorrowed<'static>> = OnceLock::new();
    COLLATOR.get_or_init(|| {
        Collator::try_new(Default::default(), Default::default())
            .expect("compiled root collation data")
    })
}
pub fn canonical(value: &Value) -> String {
    match value {
        Value::Array(values) => format!(
            "[{}]",
            values.iter().map(canonical).collect::<Vec<_>>().join(",")
        ),
        Value::Object(values) => {
            let mut entries: Vec<_> = values.iter().collect();
            entries.sort_by(|(a, _), (b, _)| collator().compare(a, b));
            format!(
                "{{{}}}",
                entries
                    .into_iter()
                    .map(|(key, value)| format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap(),
                        canonical(value)
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        Value::Number(number) => ryu_js::Buffer::new()
            .format(number.as_f64().unwrap())
            .into(),
        _ => serde_json::to_string(value).unwrap(),
    }
}
pub fn changed_fields(before: &Value, after: &Value) -> Vec<String> {
    let mut keys = before
        .as_object()
        .into_iter()
        .flat_map(|v| v.keys())
        .chain(after.as_object().into_iter().flat_map(|v| v.keys()))
        .cloned()
        .collect::<Vec<_>>();
    keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    keys.dedup();
    keys.into_iter()
        .filter(|key| canonical(&before[key]) != canonical(&after[key]))
        .collect()
}
fn strict(value: &Value, keys: &[&str]) -> Result<(), ApiError> {
    let object = value
        .as_object()
        .ok_or_else(|| ApiError::bad("Expected an object"))?;
    if object.keys().any(|k| !keys.contains(&k.as_str())) {
        return Err(ApiError::bad("Unknown configuration field"));
    }
    Ok(())
}
fn identity(value: &Value) -> Result<String, ApiError> {
    let v = value
        .as_str()
        .ok_or_else(|| ApiError::bad("Invalid code identity"))?;
    if v.is_empty()
        || v.len() > 64
        || !v.as_bytes()[0].is_ascii_lowercase()
        || !v
            .bytes()
            .all(|v| v.is_ascii_lowercase() || v.is_ascii_digit() || v == b'-')
    {
        return Err(ApiError::bad(
            "Use 1–64 lowercase letters, digits, or hyphens, starting with a letter",
        ));
    }
    Ok(v.into())
}
pub fn validate(input: &Value) -> Result<Value, ApiError> {
    strict(input, &["version", "project", "checks"])?;
    if input["version"].as_f64() != Some(1.0) {
        return Err(ApiError::bad("Unsupported code configuration version"));
    }
    let project = identity(&input["project"])?;
    let checks = input["checks"]
        .as_array()
        .filter(|v| v.len() <= 100)
        .ok_or_else(|| ApiError::bad("A project supports up to 100 checks"))?;
    let mut ids = HashSet::new();
    let checks = checks
        .iter()
        .map(|check| {
            strict(check, &["id", "config"])?;
            let id = identity(&check["id"])?;
            if !ids.insert(id.clone()) {
                return Err(ApiError::bad("Check IDs must be unique within a project"));
            }
            strict(
                &check["config"],
                &[
                    "name",
                    "url",
                    "method",
                    "headers",
                    "body",
                    "intervalSeconds",
                    "timeoutMs",
                    "expectedStatus",
                    "maxResponseMs",
                    "failureThreshold",
                    "recoveryThreshold",
                    "public",
                    "jsonAssertions",
                    "headerAssertions",
                    "responseSchema",
                    "locationIds",
                    "locationFailureThreshold",
                    "notificationChannelIds",
                    "reminderIntervalSeconds",
                ],
            )?;
            Ok(json!({"id":id,"config":check_config::validate(&check["config"])?}))
        })
        .collect::<Result<Vec<_>, ApiError>>()?;
    Ok(json!({"version":1,"project":project,"checks":checks}))
}
async fn reconcile(
    state: &AppState,
    config: Value,
    expected: Option<&str>,
) -> Result<Value, ApiError> {
    let desired = config["checks"].as_array().unwrap();
    for check in desired {
        checks::validate_routes(state, &check["config"]).await?;
    }
    let project = config["project"].as_str().unwrap();
    let mut tx = state.pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!("stillup-code:{project}"))
        .execute(&mut *tx)
        .await?;
    let rows =
        sqlx::query("SELECT * FROM monitors WHERE code_project=$1 ORDER BY code_key FOR UPDATE")
            .bind(project)
            .fetch_all(&mut *tx)
            .await?;
    let mut changes = Vec::new();
    for check in desired {
        let id = check["id"].as_str().unwrap();
        let row = rows.iter().find(|r| r.get::<String, _>("code_key") == id);
        let fields = if let Some(row) = row {
            changed_fields(&row.get::<Value, _>("config"), &check["config"])
        } else {
            let mut keys = check["config"]
                .as_object()
                .unwrap()
                .keys()
                .cloned()
                .collect::<Vec<_>>();
            keys.sort();
            keys
        };
        let mut change = json!({"id":id,"action":if row.is_none(){"create"}else if fields.is_empty(){"unchanged"}else{"update"},"fields":fields});
        if let Some(row) = row {
            change["monitorId"] = json!(row.get::<Uuid, _>("id"));
            change["revision"] = json!(row.get::<i32, _>("config_revision"));
            change["paused"] = json!(!row.get::<bool, _>("enabled"));
            change["archived"] = json!(
                row.get::<Option<chrono::DateTime<chrono::Utc>>, _>("archived_at")
                    .is_some()
            );
        }
        changes.push(change);
    }
    for row in &rows {
        let id = row.get::<String, _>("code_key");
        if !desired.iter().any(|c| c["id"] == id) {
            changes.push(json!({"id":id,"action":"retained","fields":[],"monitorId":row.get::<Uuid,_>("id"),"revision":row.get::<i32,_>("config_revision"),"paused":!row.get::<bool,_>("enabled"),"archived":row.get::<Option<chrono::DateTime<chrono::Utc>>,_>("archived_at").is_some()}));
        }
    }
    let mut sorted = config.clone();
    sorted["checks"]
        .as_array_mut()
        .unwrap()
        .sort_by(|a, b| collator().compare(a["id"].as_str().unwrap(), b["id"].as_str().unwrap()));
    let existing=rows.iter().map(|r|->Result<Value,ApiError>{Ok(json!({"id":r.get::<Uuid,_>("id"),"key":r.get::<String,_>("code_key"),"config":r.get::<Value,_>("config"),"revision":r.get::<i32,_>("config_revision"),"epoch":r.get::<i32,_>("execution_epoch"),"archived":timestamp(r,"archived_at")?,"enabled":r.get::<bool,_>("enabled")}))}).collect::<Result<Vec<_>,_>>()?;
    let token = hex::encode(Sha256::digest(
        canonical(&json!({"desired":sorted,"existing":existing})).as_bytes(),
    ));
    let plan = json!({"project":project,"token":token,"changes":changes});
    if let Some(expected) = expected {
        if expected != token {
            return Err(ApiError::conflict(
                "The project changed after this preview. Run diff and apply again. Nothing was applied.",
            ));
        }
        for check in desired {
            let key = check["id"].as_str().unwrap();
            let row = rows.iter().find(|r| r.get::<String, _>("code_key") == key);
            if let Some(row) = row {
                if changed_fields(&row.get::<Value, _>("config"), &check["config"]).is_empty() {
                    continue;
                }
                if row
                    .get::<Option<chrono::DateTime<chrono::Utc>>, _>("archived_at")
                    .is_some()
                {
                    return Err(ApiError::conflict(format!(
                        "Restore code check {key} in the dashboard before updating it. Nothing was applied."
                    )));
                }
                let id: Uuid = row.get("id");
                let revision = row.get::<i32, _>("config_revision") + 1;
                sqlx::query(
                    "INSERT INTO check_revisions(monitor_id,revision,config) VALUES($1,$2,$3)",
                )
                .bind(id)
                .bind(revision)
                .bind(&check["config"])
                .execute(&mut *tx)
                .await?;
                sqlx::query("UPDATE monitors SET config=$2,config_revision=$3,execution_epoch=execution_epoch+1,next_run_at=now(),failures=0,successes=0,last_observed_at=NULL,last_run_at=NULL,last_outcome=NULL,last_duration_ms=NULL,status=CASE WHEN status='down' THEN 'down' ELSE 'unknown' END WHERE id=$1").bind(id).bind(&check["config"]).bind(revision).execute(&mut *tx).await?;
            } else {
                let id:Uuid=sqlx::query_scalar("INSERT INTO monitors(config,code_project,code_key) VALUES($1,$2,$3) RETURNING id").bind(&check["config"]).bind(project).bind(key).fetch_one(&mut *tx).await?;
                sqlx::query(
                    "INSERT INTO check_revisions(monitor_id,revision,config) VALUES($1,1,$2)",
                )
                .bind(id)
                .bind(&check["config"])
                .execute(&mut *tx)
                .await?;
            }
        }
    }
    tx.commit().await?;
    Ok(plan)
}
pub async fn plan(
    State(state): State<AppState>,
    ApiJson(input): ApiJson,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(reconcile(&state, validate(&input)?, None).await?))
}
pub async fn apply(
    State(state): State<AppState>,
    ApiJson(input): ApiJson,
) -> Result<Json<Value>, ApiError> {
    strict(&input, &["config", "token"])?;
    let token = input["token"]
        .as_str()
        .filter(|v| {
            v.len() == 64
                && v.bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        })
        .ok_or_else(|| ApiError::bad("Invalid plan token"))?;
    Ok(Json(
        reconcile(&state, validate(&input["config"])?, Some(token)).await?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn schemas_and_canonicalization_match_node_fixtures() {
        let cases: Vec<Value> =
            serde_json::from_str(include_str!("../tests/fixtures/code-contracts.json")).unwrap();
        for case in cases {
            let result = validate(&case["input"]);
            assert_eq!(result.is_ok(), case["valid"].as_bool().unwrap());
            if let Ok(output) = result {
                assert_eq!(output, case["output"]);
            }
        }
        let cases: Vec<Value> =
            serde_json::from_str(include_str!("../tests/fixtures/canonical-contracts.json"))
                .unwrap();
        for case in cases {
            assert_eq!(
                canonical(&case["input"]),
                case["canonical"].as_str().unwrap()
            );
        }
        assert_eq!(canonical(&json!(-0.0)), "0");
        assert!(changed_fields(&json!({"value":1.0}), &json!({"value":1})).is_empty());
    }
}
