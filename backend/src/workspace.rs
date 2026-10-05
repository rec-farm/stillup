use crate::error::ApiError;
use serde_json::{Value, json};
use sqlx::{PgPool, Row};

pub fn validate(input: &Value) -> Result<Value, ApiError> {
    let input = input
        .as_object()
        .ok_or_else(|| ApiError::bad("config: Expected an object"))?;
    let string = |name: &str,
                  default: &str,
                  trim: bool,
                  min: usize,
                  max: usize|
     -> Result<String, ApiError> {
        let value = match input.get(name) {
            None => default,
            Some(Value::String(value)) => value,
            _ => return Err(ApiError::bad(format!("{name}: Expected a string"))),
        };
        let value = if trim { value.trim() } else { value };
        // Zod strings measure UTF-16 code units, matching the existing JavaScript contract.
        if !(min..=max).contains(&value.encode_utf16().count()) {
            return Err(ApiError::bad(format!("{name}: Invalid length")));
        }
        Ok(value.to_owned())
    };
    let name = string("name", "StillUp", true, 1, 60)?;
    let tagline = string(
        "tagline",
        "A little peace of mind for everything you build.",
        true,
        0,
        160,
    )?;
    let logo = string("logoUrl", "", false, 0, 2048)?;
    if !logo.is_empty() {
        let url = url::Url::parse(&logo).map_err(|_| {
            ApiError::bad("logoUrl: Use a public HTTPS image URL without credentials")
        })?;
        if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
            return Err(ApiError::bad(
                "logoUrl: Use a public HTTPS image URL without credentials",
            ));
        }
    }
    let accent = string("accentColor", "#087f67", false, 7, 7)?;
    if !accent.starts_with('#') || !accent.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit) {
        return Err(ApiError::bad("accentColor: Use a six-digit hex color"));
    }
    let density = string("density", "comfortable", false, 0, 20)?;
    if !matches!(density.as_str(), "comfortable" | "compact") {
        return Err(ApiError::bad("density: Invalid option"));
    }
    Ok(
        json!({ "name": name, "tagline": tagline, "logoUrl": logo, "accentColor": accent, "density": density }),
    )
}

pub async fn read(pool: &PgPool) -> Result<Value, ApiError> {
    let row = sqlx::query("SELECT config, revision FROM workspace_settings WHERE id=1")
        .fetch_optional(pool)
        .await?;
    match row {
        Some(row) => Ok(
            json!({ "settings": validate(&row.try_get::<Value, _>("config")?)?, "revision": row.try_get::<i32, _>("revision")? }),
        ),
        None => Ok(json!({ "settings": validate(&json!({}))?, "revision": 0 })),
    }
}

pub async fn save(pool: &PgPool, input: &Value, expected: i32) -> Result<Value, ApiError> {
    let config = validate(input)?;
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext('stillup-workspace-settings'))")
        .execute(&mut *tx)
        .await?;
    let revision =
        sqlx::query_scalar::<_, i32>("SELECT revision FROM workspace_settings WHERE id=1")
            .fetch_optional(&mut *tx)
            .await?
            .unwrap_or(0);
    if revision != expected {
        return Err(ApiError::conflict(
            "Appearance changed elsewhere. Close and reopen this editor to load the latest settings.",
        ));
    }
    let revision: i32 = sqlx::query_scalar("INSERT INTO workspace_settings(id,config,revision) VALUES(1,$1,1) ON CONFLICT(id) DO UPDATE SET config=$1,revision=workspace_settings.revision+1 RETURNING revision").bind(&config).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    Ok(json!({ "settings": config, "revision": revision }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn defaults_normalization_and_logo_guards() {
        assert_eq!(validate(&json!({})).unwrap()["name"], "StillUp");
        assert_eq!(
            validate(&json!({"name":" Custom "})).unwrap()["name"],
            "Custom"
        );
        for value in [
            json!({"name":" "}),
            json!({"density":"dense"}),
            json!({"accentColor":"green"}),
            json!({"logoUrl":"http://example.com/logo.svg"}),
            json!({"logoUrl":"https://user:pass@example.com/logo.svg"}),
        ] {
            assert!(validate(&value).is_err());
        }
    }
}
