use crate::json::ApiPath;
use crate::{
    check_config,
    error::ApiError,
    json::ApiJson,
    server::{AppState, timestamp},
};
use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, AeadCore, KeyInit, OsRng, Payload},
};
use axum::{Json, extract::State, http::StatusCode};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use sqlx::{PgPool, Row};
use std::collections::{HashMap, HashSet};
#[derive(Clone, Default)]
pub struct SecretConfig {
    pub encryption_key: String,
    pub environment: HashMap<String, String>,
}
impl SecretConfig {
    pub fn from_env() -> Result<Self, String> {
        let key = std::env::var("SECRETS_ENCRYPTION_KEY").unwrap_or_default();
        if !key.is_empty() && (key.len() != 64 || hex::decode(&key).is_err()) {
            return Err("SECRETS_ENCRYPTION_KEY must be a 64-digit hexadecimal key".into());
        }
        Ok(Self {
            encryption_key: key,
            environment: std::env::vars()
                .filter(|(key, _)| {
                    key.strip_prefix("CHECK_SECRET_")
                        .is_some_and(placeholder_name)
                })
                .collect(),
        })
    }
}
fn placeholder_name(value: &str) -> bool {
    value.as_bytes().first().is_some_and(u8::is_ascii_uppercase)
        && value
            .bytes()
            .all(|v| v.is_ascii_uppercase() || v.is_ascii_digit() || v == b'_')
}
fn name(value: &str) -> bool {
    placeholder_name(value) && value.len() <= 80
}
pub fn references(values: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut output = Vec::new();
    for value in values {
        let mut rest = value.as_str();
        while let Some(start) = rest.find("{{") {
            rest = &rest[start + 2..];
            if let Some(end) = rest.find("}}") {
                let candidate = &rest[..end];
                if placeholder_name(candidate) {
                    if seen.insert(candidate.to_owned()) {
                        output.push(candidate.to_owned());
                    }
                    rest = &rest[end + 2..];
                }
            }
        }
    }
    output
}
#[derive(Debug)]
pub struct CryptoError;
fn cipher(key: &str) -> Result<Aes256Gcm, CryptoError> {
    let bytes = hex::decode(key).map_err(|_| CryptoError)?;
    Aes256Gcm::new_from_slice(&bytes).map_err(|_| CryptoError)
}
pub fn encrypt(name: &str, value: &str, key: &str) -> Result<Value, CryptoError> {
    let cipher = cipher(key)?;
    let iv = Aes256Gcm::generate_nonce(&mut OsRng);
    let aad = format!("StillUp secret v1:{name}");
    let mut bytes = cipher
        .encrypt(
            &iv,
            Payload {
                msg: value.as_bytes(),
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| CryptoError)?;
    let tag = bytes.split_off(bytes.len() - 16);
    Ok(
        json!({"version":1,"iv":STANDARD.encode(iv),"tag":STANDARD.encode(tag),"ciphertext":STANDARD.encode(bytes)}),
    )
}
pub fn decrypt(name: &str, value: &Value, key: &str) -> Result<String, CryptoError> {
    if value["version"] != json!(1) {
        return Err(CryptoError);
    }
    let decode = |name: &str| {
        STANDARD
            .decode(value[name].as_str().ok_or(CryptoError)?)
            .map_err(|_| CryptoError)
    };
    let iv = decode("iv")?;
    let tag = decode("tag")?;
    let mut encrypted = decode("ciphertext")?;
    if iv.len() != 12 || tag.len() != 16 {
        return Err(CryptoError);
    }
    encrypted.extend(tag);
    let aad = format!("StillUp secret v1:{name}");
    let bytes = cipher(key)?
        .decrypt(
            Nonce::from_slice(&iv),
            Payload {
                msg: &encrypted,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| CryptoError)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}
pub async fn resolve(
    pool: &PgPool,
    config: &SecretConfig,
    values: &[String],
) -> Result<HashMap<String, String>, sqlx::Error> {
    if references(values).is_empty() {
        return Ok(HashMap::new());
    }
    let mut connection = pool.acquire().await?;
    resolve_connection(&mut connection, config, values).await
}
pub async fn resolve_connection(
    connection: &mut sqlx::PgConnection,
    config: &SecretConfig,
    values: &[String],
) -> Result<HashMap<String, String>, sqlx::Error> {
    let names = references(values);
    if names.is_empty() {
        return Ok(HashMap::new());
    }
    let rows = sqlx::query(
        "SELECT name,enabled,encrypted_value FROM managed_secrets WHERE name=ANY($1::text[])",
    )
    .bind(&names)
    .fetch_all(connection)
    .await?;
    let mut result = HashMap::new();
    for name in names {
        let env_key = format!("CHECK_SECRET_{name}");
        if let Some(row) = rows
            .iter()
            .find(|row| row.try_get::<String, _>("name").is_ok_and(|v| v == name))
        {
            if row.try_get::<bool, _>("enabled")?
                && let Ok(value) = decrypt(
                    &name,
                    &row.try_get::<Value, _>("encrypted_value")?,
                    &config.encryption_key,
                )
            {
                result.insert(env_key, value);
            }
        } else if let Some(value) = config.environment.get(&env_key) {
            result.insert(env_key, value.clone());
        }
    }
    Ok(result)
}
async fn save(state: &AppState, input: &Value, existing: Option<&str>) -> Result<Value, ApiError> {
    let key = if let Some(key) = existing {
        key
    } else {
        input["name"]
            .as_str()
            .ok_or_else(|| ApiError::bad("name: Expected a secret name"))?
    };
    if !name(key) {
        return Err(ApiError::bad(
            "Use uppercase letters, digits, and underscores; start with a letter",
        ));
    }
    let value = match input.get("value") {
        Some(value) => Some(check_config::text(value, 1, 65536, "value")?),
        None if existing.is_some() => None,
        _ => return Err(ApiError::bad("value: Required")),
    };
    let enabled = input
        .get("enabled")
        .and_then(Value::as_bool)
        .or_else(|| {
            if existing.is_none() && !input.as_object().is_some_and(|v| v.contains_key("enabled")) {
                Some(true)
            } else {
                None
            }
        })
        .ok_or_else(|| ApiError::bad("enabled: Expected a boolean"))?;
    let expected = if existing.is_some() {
        Some(check_config::integer(
            &input["expectedRevision"],
            1,
            crate::check_config::MAX_SAFE_INTEGER,
            "expectedRevision",
        )?)
    } else {
        None
    };
    let master = &state.config.secrets.encryption_key;
    if master.is_empty() {
        return Err(ApiError::conflict(
            "Configure SECRETS_ENCRYPTION_KEY on the API and worker to manage encrypted secrets",
        ));
    }
    if existing.is_none()
        && state
            .config
            .secrets
            .environment
            .contains_key(&format!("CHECK_SECRET_{key}"))
    {
        return Err(ApiError::conflict(
            "This name is supplied by the environment; choose a different name",
        ));
    }
    let mut tx = state.pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext('stillup-secrets'))")
        .execute(&mut *tx)
        .await?;
    let row = sqlx::query("SELECT * FROM managed_secrets WHERE name=$1 FOR UPDATE")
        .bind(key)
        .fetch_optional(&mut *tx)
        .await?;
    if existing.is_some() {
        let row = row.ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "Secret not found".into()))?;
        if expected != Some(i64::from(row.try_get::<i32, _>("revision")?)) {
            return Err(ApiError::conflict(
                "Secret changed elsewhere. Reopen it before saving.",
            ));
        }
        decrypt(key, &row.try_get::<Value, _>("encrypted_value")?, master)
            .map_err(|_| ApiError::conflict("The installation key cannot unlock this secret"))?;
        let encrypted = value
            .map(|value| encrypt(key, &value, master))
            .transpose()
            .map_err(|_| ApiError::conflict("Secret encryption key is unavailable"))?;
        sqlx::query("UPDATE managed_secrets SET encrypted_value=COALESCE($2::jsonb,encrypted_value),enabled=$3,revision=revision+1,updated_at=now() WHERE name=$1").bind(key).bind(encrypted).bind(enabled).execute(&mut *tx).await?;
    } else {
        if row.is_some() {
            return Err(ApiError::conflict("A secret with this name already exists"));
        }
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM managed_secrets")
            .fetch_one(&mut *tx)
            .await?;
        if count >= 500 {
            return Err(ApiError::conflict(
                "An installation supports up to 500 stored secrets",
            ));
        }
        if let Some(row) = sqlx::query("SELECT name,encrypted_value FROM managed_secrets LIMIT 1")
            .fetch_optional(&mut *tx)
            .await?
        {
            decrypt(
                &row.try_get::<String, _>("name")?,
                &row.try_get::<Value, _>("encrypted_value")?,
                master,
            )
            .map_err(|_| {
                ApiError::conflict("The installation key cannot unlock existing secrets")
            })?;
        }
        let encrypted = encrypt(key, value.as_deref().unwrap(), master)
            .map_err(|_| ApiError::conflict("Secret encryption key is unavailable"))?;
        sqlx::query("INSERT INTO managed_secrets(name,encrypted_value,enabled) VALUES($1,$2,$3)")
            .bind(key)
            .bind(encrypted)
            .bind(enabled)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(json!({"ok":true}))
}
pub async fn create(
    State(state): State<AppState>,
    ApiJson(input): ApiJson,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    Ok((StatusCode::CREATED, Json(save(&state, &input, None).await?)))
}
pub async fn edit(
    State(state): State<AppState>,
    ApiPath(name): ApiPath<String>,
    ApiJson(input): ApiJson,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(save(&state, &input, Some(&name)).await?))
}
pub async fn overview(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let (stored,checks,channels,pending)=tokio::try_join!(
        sqlx::query("SELECT name,enabled,revision,updated_at FROM managed_secrets ORDER BY name").fetch_all(&state.pool),
        sqlx::query("SELECT id,config,archived_at FROM monitors").fetch_all(&state.pool),
        sqlx::query("SELECT id,name,url,source FROM notification_channels").fetch_all(&state.pool),
        sqlx::query("SELECT id,channel_name,target_url FROM notification_deliveries WHERE status <> 'delivered'").fetch_all(&state.pool),
    )?;
    let mut usages: HashMap<String, Vec<Value>> = HashMap::new();
    let mut add = |values: Vec<String>, usage: Value| {
        for name in references(&values) {
            usages.entry(name).or_default().push(usage.clone());
        }
    };
    for row in checks {
        let config: Value = row.try_get("config")?;
        let mut values: Vec<String> = config["headers"]
            .as_object()
            .map(|v| {
                v.values()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        values.push(config["body"].as_str().unwrap_or("").into());
        add(
            values,
            json!({"kind":"check","id":row.try_get::<uuid::Uuid,_>("id")?,"name":config["name"],"archived":!timestamp(&row,"archived_at")?.is_null()}),
        );
    }
    for row in channels {
        let destination: Option<String> = row.try_get("url")?;
        let source: String = row.try_get("source")?;
        let value = if source == "environment" {
            state.config.alert_webhook_url.clone()
        } else {
            destination.unwrap_or_default()
        };
        add(
            vec![value],
            json!({"kind":"channel","id":row.try_get::<uuid::Uuid,_>("id")?,"name":row.try_get::<String,_>("name")?}),
        );
    }
    for row in pending {
        add(
            vec![row.try_get("target_url")?],
            json!({"kind":"delivery","id":row.try_get::<uuid::Uuid,_>("id")?,"name":row.try_get::<String,_>("channel_name")?}),
        );
    }
    let env_names: HashSet<String> = state
        .config
        .secrets
        .environment
        .keys()
        .filter_map(|v| v.strip_prefix("CHECK_SECRET_").map(str::to_owned))
        .collect();
    let mut names: Vec<String> = stored
        .iter()
        .map(|row| row.try_get("name"))
        .collect::<Result<_, _>>()?;
    names.extend(env_names.iter().cloned());
    names.extend(usages.keys().cloned());
    names.sort();
    names.dedup();
    let secrets=names.into_iter().map(|name|->Result<Value,sqlx::Error>{let row=stored.iter().find(|row|row.try_get::<String,_>("name").is_ok_and(|v|v==name));Ok(json!({"name":name,"source":if row.is_some(){"database"}else if env_names.contains(&name){"environment"}else{"missing"},"enabled":match row{Some(row)=>row.try_get::<bool,_>("enabled")?,None=>env_names.contains(&name)},"revision":row.map(|row|row.try_get::<i32,_>("revision")).transpose()?,"updatedAt":match row{Some(row)=>timestamp(row,"updated_at")?,None=>Value::Null},"usages":usages.remove(&name).unwrap_or_default()}))}).collect::<Result<Vec<_>,_>>()?;
    Ok(Json(
        json!({"encryptionConfigured":!state.config.secrets.encryption_key.is_empty(),"secrets":secrets}),
    ))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn decrypts_node_fixture_and_binds_names_and_keys() {
        let fixture: Value =
            serde_json::from_str(include_str!("../tests/fixtures/secret-contract.json")).unwrap();
        let key = fixture["key"].as_str().unwrap();
        let name = fixture["name"].as_str().unwrap();
        let value = fixture["value"].as_str().unwrap();
        assert_eq!(decrypt(name, &fixture["encrypted"], key).unwrap(), value);
        assert!(decrypt("OTHER", &fixture["encrypted"], key).is_err());
        assert!(decrypt(name, &fixture["encrypted"], &"b".repeat(64)).is_err());
        let encrypted = encrypt(name, value, key).unwrap();
        assert_eq!(decrypt(name, &encrypted, key).unwrap(), value);
    }
    #[test]
    fn references_preserve_order_and_ignore_nonsecret_templates() {
        assert_eq!(
            references(&["{{TOKEN}} {{TOKEN}} {{lowercase}} {{OTHER_1}}".into()]),
            vec!["TOKEN", "OTHER_1"]
        );
    }
}
