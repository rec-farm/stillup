//! A record of every change made through the API, for every kind of caller. Reads are not
//! recorded, nor are request bodies, which can hold credentials.
use crate::{error::ApiError, server::AppState, users::Principal};
use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{PgPool, Row};
use uuid::Uuid;

/// A change about to be made, recorded once its status is known.
pub struct Entry {
    actor: &'static str,
    user_id: Option<Uuid>,
    credential_id: Option<Uuid>,
    agent: Option<String>,
    method: String,
    path: String,
}
impl Entry {
    /// None for requests that change nothing.
    pub fn of(principal: &Principal, method: &str, path: &str) -> Option<Self> {
        if matches!(method, "GET" | "HEAD" | "OPTIONS") {
            return None;
        }
        let (actor, user_id, credential_id, agent) = match principal {
            Principal::Installation => ("installation", None, None, None),
            Principal::User { id, .. } => ("user", Some(*id), None, None),
            Principal::Credential { id, .. } => ("credential", None, Some(*id), None),
            Principal::Delegated { user_id, agent, .. } => {
                ("agent", Some(*user_id), None, Some(agent.clone()))
            }
        };
        Some(Self {
            actor,
            user_id,
            credential_id,
            agent,
            method: method.to_owned(),
            path: path.chars().take(512).collect(),
        })
    }
    /// The change already happened, so a failure to record it is logged, not returned.
    pub async fn record(self, pool: &PgPool, status: StatusCode) {
        let result = sqlx::query(
            "INSERT INTO audit_log(actor,user_id,credential_id,agent,method,path,status) VALUES($1,$2,$3,$4,$5,$6,$7)",
        )
        .bind(self.actor)
        .bind(self.user_id)
        .bind(self.credential_id)
        .bind(&self.agent)
        .bind(&self.method)
        .bind(&self.path)
        .bind(status.as_u16() as i16)
        .execute(pool)
        .await;
        if let Err(error) = result {
            tracing::error!(%error, "could not record a change in the audit log");
        }
    }
}

#[derive(Deserialize)]
pub struct Page {
    before: Option<i64>,
    limit: Option<i64>,
}

/// `GET /v1/audit-log?before=<id>&limit=100`, newest first.
pub async fn list(
    State(state): State<AppState>,
    Query(page): Query<Page>,
) -> Result<Json<Value>, ApiError> {
    let limit = page.limit.unwrap_or(100).clamp(1, 500);
    let rows = sqlx::query(
        "SELECT a.id,a.at,a.actor,a.user_id,u.email,a.credential_id,a.agent,a.method,a.path,a.status
         FROM audit_log a LEFT JOIN users u ON u.id=a.user_id
         WHERE $1::bigint IS NULL OR a.id<$1 ORDER BY a.id DESC LIMIT $2",
    )
    .bind(page.before)
    .bind(limit)
    .fetch_all(&state.pool)
    .await?;
    let entries = rows
        .iter()
        .map(|row| {
            Ok(json!({
                "id": row.try_get::<i64, _>("id")?,
                "at": crate::server::timestamp(row, "at")?,
                "actor": row.try_get::<String, _>("actor")?,
                "userId": row.try_get::<Option<Uuid>, _>("user_id")?,
                "userEmail": row.try_get::<Option<String>, _>("email")?,
                "credentialId": row.try_get::<Option<Uuid>, _>("credential_id")?,
                "agent": row.try_get::<Option<String>, _>("agent")?,
                "method": row.try_get::<String, _>("method")?,
                "path": row.try_get::<String, _>("path")?,
                "status": row.try_get::<i16, _>("status")?,
            }))
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()?;
    Ok(Json(json!({ "entries": entries })))
}
