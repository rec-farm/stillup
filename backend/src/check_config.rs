use crate::error::ApiError;
use serde_json::{Map, Value, json};
use std::collections::HashSet;
pub fn text(value: &Value, min: usize, max: usize, field: &str) -> Result<String, ApiError> {
    let value = value
        .as_str()
        .ok_or_else(|| ApiError::bad(format!("{field}: Expected a string")))?;
    if !(min..=max).contains(&value.chars().count()) {
        return Err(ApiError::bad(format!("{field}: Invalid length")));
    }
    Ok(value.into())
}
pub fn integer(value: &Value, min: i64, max: i64, field: &str) -> Result<i64, ApiError> {
    let number = value
        .as_f64()
        .filter(|v| v.is_finite() && v.fract() == 0.0 && *v >= min as f64 && *v <= max as f64)
        .ok_or_else(|| {
            ApiError::bad(format!(
                "{field}: Expected an integer between {min} and {max}"
            ))
        })?;
    Ok(number as i64)
}
pub fn valid_uuid(value: &str) -> bool {
    let Ok(id) = uuid::Uuid::parse_str(value) else {
        return false;
    };
    if id.hyphenated().to_string() != value.to_ascii_lowercase() {
        return false;
    }
    id.is_nil()
        || (id == uuid::Uuid::max() && value == "ffffffff-ffff-ffff-ffff-ffffffffffff")
        || (matches!(id.get_version_num(), 1..=8) && id.get_variant() == uuid::Variant::RFC4122)
}
fn strict(input: &Map<String, Value>, keys: &[&str]) -> Result<(), ApiError> {
    if input.keys().any(|key| !keys.contains(&key.as_str())) {
        return Err(ApiError::bad("Unexpected assertion or schema field"));
    }
    Ok(())
}
fn scalar(value: &Value, bounded: bool) -> bool {
    value.is_null()
        || value.is_boolean()
        || value.is_number()
        || value
            .as_str()
            .is_some_and(|v| !bounded || v.chars().count() <= 4096)
}
pub fn header_name(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|v| v.is_ascii_alphanumeric() || b"!#$%&'*+.^_`|~-".contains(&v))
}
fn path(value: &str) -> bool {
    value == "$"
        || value.strip_prefix("$.").is_some_and(|v| {
            v.split('.').all(|v| {
                !v.is_empty()
                    && v.bytes()
                        .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
            })
        })
}
fn assertion(value: &Value, header: bool) -> Result<(), ApiError> {
    let input = value
        .as_object()
        .ok_or_else(|| ApiError::bad("Assertion: Expected an object"))?;
    if !header && input.contains_key("equals") {
        strict(input, &["path", "equals"])?;
        let p = input
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| ApiError::bad("path: Required"))?;
        if !path(p) || !scalar(&input["equals"], false) {
            return Err(ApiError::bad("Invalid legacy JSON assertion"));
        }
        return Ok(());
    }
    let field = if header { "name" } else { "path" };
    let p = text(
        input.get(field).unwrap_or(&Value::Null),
        if header { 1 } else { 0 },
        256,
        field,
    )?;
    if if header { !header_name(&p) } else { !path(&p) } {
        return Err(ApiError::bad("Invalid assertion name/path"));
    }
    let op = input
        .get("operator")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::bad("operator: Required"))?;
    if matches!(op, "exists" | "notExists") {
        strict(input, &[field, "operator"])?;
        return Ok(());
    }
    strict(input, &[field, "operator", "value"])?;
    let value = input
        .get("value")
        .ok_or_else(|| ApiError::bad("value: Required"))?;
    let valid = if header {
        matches!(op, "equals" | "contains")
            && value.as_str().is_some_and(|v| v.chars().count() <= 4096)
    } else {
        match op {
            "equals" | "notEquals" => scalar(value, true),
            "contains" | "startsWith" | "endsWith" => {
                value.as_str().is_some_and(|v| v.chars().count() <= 4096)
            }
            "gt" | "gte" | "lt" | "lte" => value.is_number(),
            "length" => integer(value, 0, 1048576, "value").is_ok(),
            _ => false,
        }
    };
    if !valid {
        return Err(ApiError::bad("Invalid assertion operator/value"));
    }
    Ok(())
}
fn schema_at(value: &Value, depth: usize) -> Result<(), ApiError> {
    if value.is_boolean() {
        return Ok(());
    }
    if depth > 8 {
        return Err(ApiError::bad(
            "Response schema nesting exceeds the supported depth",
        ));
    }
    let input = value
        .as_object()
        .ok_or_else(|| ApiError::bad("responseSchema: Expected a boolean or object"))?;
    strict(
        input,
        &[
            "type",
            "title",
            "description",
            "properties",
            "required",
            "additionalProperties",
            "items",
            "enum",
            "minimum",
            "maximum",
            "minLength",
            "maxLength",
            "minItems",
            "maxItems",
        ],
    )?;
    for (key, value) in input {
        match key.as_str() {
            "type" => {
                if !matches!(
                    value.as_str(),
                    Some("object" | "array" | "string" | "number" | "integer" | "boolean" | "null")
                ) {
                    return Err(ApiError::bad("Invalid response schema type"));
                }
            }
            "title" => {
                text(value, 0, 256, "title")?;
            }
            "description" => {
                text(value, 0, 2048, "description")?;
            }
            "properties" => {
                let properties = value
                    .as_object()
                    .ok_or_else(|| ApiError::bad("properties: Expected an object"))?;
                for (name, value) in properties {
                    if name.chars().count() > 256 {
                        return Err(ApiError::bad("Schema property name is too long"));
                    }
                    schema_at(value, depth + 1)?;
                }
            }
            "required" => {
                let array = value
                    .as_array()
                    .filter(|v| v.len() <= 100)
                    .ok_or_else(|| ApiError::bad("required: Expected up to 100 unique fields"))?;
                let mut seen = HashSet::new();
                for v in array {
                    let name = text(v, 0, 256, "required")?;
                    if !seen.insert(name) {
                        return Err(ApiError::bad("Required fields must be unique"));
                    }
                }
            }
            "additionalProperties" => {
                if !value.is_boolean() {
                    return Err(ApiError::bad("additionalProperties: Expected a boolean"));
                }
            }
            "items" => schema_at(value, depth + 1)?,
            "enum" => {
                let array = value
                    .as_array()
                    .filter(|v| !v.is_empty() && v.len() <= 100)
                    .ok_or_else(|| ApiError::bad("enum: Expected 1 to 100 scalar values"))?;
                for (i, v) in array.iter().enumerate() {
                    if !scalar(v, true)
                        || array[..i].iter().any(|e| {
                            if e.is_number() && v.is_number() {
                                e.as_f64() == v.as_f64()
                            } else {
                                e == v
                            }
                        })
                    {
                        return Err(ApiError::bad("Enum values must be unique scalars"));
                    }
                }
            }
            "minimum" | "maximum" => {
                if !value.is_number() {
                    return Err(ApiError::bad("Schema bounds must be numbers"));
                }
            }
            _ => {
                integer(value, 0, 1048576, key)?;
            }
        }
    }
    Ok(())
}
pub fn validate(value: &Value) -> Result<Value, ApiError> {
    let input = value
        .as_object()
        .ok_or_else(|| ApiError::bad("Expected a check configuration object"))?;
    let mut output = Map::new();
    let name = text(
        input.get("name").unwrap_or(&Value::Null),
        0,
        usize::MAX,
        "name",
    )?
    .trim()
    .to_string();
    if name.is_empty() || name.chars().count() > 80 {
        return Err(ApiError::bad("name: Expected 1 to 80 characters"));
    }
    output.insert("name".into(), json!(name));
    let value = text(input.get("url").unwrap_or(&Value::Null), 1, 2048, "url")?;
    let url = url::Url::parse(&value).map_err(|_| ApiError::bad("url: Invalid URL"))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(ApiError::bad(
            "Use an HTTP(S) URL without embedded credentials or a fragment",
        ));
    }
    output.insert("url".into(), json!(value));
    let method = input.get("method").unwrap_or(&json!("GET")).clone();
    if !matches!(
        method.as_str(),
        Some("GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE")
    ) {
        return Err(ApiError::bad("method: Invalid option"));
    }
    let body = text(input.get("body").unwrap_or(&json!("")), 0, 65536, "body")?;
    if matches!(method.as_str(), Some("GET" | "HEAD")) && !body.is_empty() {
        return Err(ApiError::bad(
            "GET and HEAD checks cannot have a request body",
        ));
    }
    output.insert("method".into(), method);
    output.insert("body".into(), json!(body));
    let headers = input.get("headers").cloned().unwrap_or(json!({}));
    let fields = headers
        .as_object()
        .filter(|v| v.len() <= 30)
        .ok_or_else(|| ApiError::bad("At most 30 headers are supported"))?;
    for (key, value) in fields {
        let value = text(value, 0, 4096, "headers")?;
        if !header_name(key) || value.contains(['\r', '\n']) {
            return Err(ApiError::bad("Invalid request header"));
        }
    }
    output.insert("headers".into(), headers);
    for (key, min, max, default) in [
        ("intervalSeconds", 30, 86400, Some(60)),
        ("timeoutMs", 100, 30000, Some(10000)),
        ("expectedStatus", 100, 599, Some(200)),
        ("failureThreshold", 1, 10, Some(2)),
        ("recoveryThreshold", 1, 10, Some(1)),
        ("reminderIntervalSeconds", 300, 86400, None),
        ("locationFailureThreshold", 1, 10, None),
    ] {
        if let Some(value) = input.get(key) {
            output.insert(key.into(), json!(integer(value, min, max, key)?));
        } else if let Some(value) = default {
            output.insert(key.into(), json!(value));
        }
    }
    let max = input.get("maxResponseMs").unwrap_or(&Value::Null);
    output.insert(
        "maxResponseMs".into(),
        if max.is_null() {
            Value::Null
        } else {
            json!(integer(max, 1, 30000, "maxResponseMs")?)
        },
    );
    let public = input.get("public").cloned().unwrap_or(json!(false));
    if !public.is_boolean() {
        return Err(ApiError::bad("public: Expected a boolean"));
    }
    output.insert("public".into(), public);
    for key in ["jsonAssertions", "headerAssertions"] {
        if let Some(value) = input.get(key) {
            let values = value
                .as_array()
                .filter(|v| v.len() <= 20)
                .ok_or_else(|| ApiError::bad("At most 20 assertions are supported"))?;
            for value in values {
                assertion(value, key == "headerAssertions")?;
            }
            output.insert(key.into(), value.clone());
        } else if key == "jsonAssertions" {
            output.insert(key.into(), json!([]));
        }
    }
    if let Some(value) = input.get("responseSchema") {
        if value.to_string().encode_utf16().count() > 16384 {
            return Err(ApiError::bad("Schema must be at most 16 KiB"));
        }
        schema_at(value, 0)?;
        output.insert("responseSchema".into(), value.clone());
    }
    for (key, min, max) in [("locationIds", 1, 10), ("notificationChannelIds", 0, 20)] {
        if let Some(value) = input.get(key) {
            let values = value
                .as_array()
                .filter(|v| (min..=max).contains(&v.len()))
                .ok_or_else(|| ApiError::bad("Invalid routing selection"))?;
            let mut seen = HashSet::new();
            for value in values {
                let value = value
                    .as_str()
                    .ok_or_else(|| ApiError::bad("Invalid routing ID"))?;
                if !seen.insert(value)
                    || !(key == "locationIds" && value == "local" || valid_uuid(value))
                {
                    return Err(ApiError::bad("Choose each valid routing ID once"));
                }
            }
            output.insert(key.into(), value.clone());
        }
    }
    let threshold = output
        .get("locationFailureThreshold")
        .and_then(Value::as_i64)
        .unwrap_or(1);
    let count = output
        .get("locationIds")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(1);
    if threshold > count as i64 {
        return Err(ApiError::bad(
            "Failure threshold cannot exceed the selected locations",
        ));
    }
    Ok(Value::Object(output))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn matches_typescript_configuration_contract_fixtures() {
        let fixtures: Vec<Value> =
            serde_json::from_str(include_str!("../tests/fixtures/check-contracts.json")).unwrap();
        for fixture in fixtures {
            let result = validate(&fixture["input"]);
            assert_eq!(
                result.is_ok(),
                fixture["accepted"].as_bool().unwrap(),
                "fixture: {}",
                fixture["name"]
            );
            if let Ok(result) = result {
                assert_eq!(
                    result, fixture["normalized"],
                    "fixture: {}",
                    fixture["name"]
                );
            }
        }
    }
}
