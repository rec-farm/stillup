use crate::error::ApiError;
use axum::{
    Json,
    extract::{FromRequest, FromRequestParts, Query, Request},
    http::request::Parts,
};
use serde_json::Value;
use std::collections::HashMap;

pub struct ApiQuery<const INCIDENT_FILTER: bool = false>(pub HashMap<String, String>);
impl<S: Send + Sync, const INCIDENT_FILTER: bool> FromRequestParts<S>
    for ApiQuery<INCIDENT_FILTER>
{
    type Rejection = ApiError;
    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let Query(pairs) = Query::<Vec<(String, String)>>::from_request_parts(parts, state)
            .await
            .map_err(|_| ApiError::bad("Invalid query parameters"))?;
        let mut values = HashMap::new();
        for (key, value) in pairs {
            if values.insert(key.clone(), value).is_some()
                && (key == "before" || INCIDENT_FILTER && key == "incidentId")
            {
                return Err(ApiError::bad(format!(
                    "{key}: Expected a single query value"
                )));
            }
        }
        Ok(Self(values))
    }
}

// Match Number(string) followed by Zod's positive safe-integer validation.
pub fn positive_route_integer(value: &str) -> Option<i64> {
    let value = value.trim_matches(|c| matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'));
    let number = if let Some((radix, digits)) = value
        .strip_prefix("0x")
        .or_else(|| value.strip_prefix("0X"))
        .map(|v| (16, v))
        .or_else(|| {
            value
                .strip_prefix("0b")
                .or_else(|| value.strip_prefix("0B"))
                .map(|v| (2, v))
        })
        .or_else(|| {
            value
                .strip_prefix("0o")
                .or_else(|| value.strip_prefix("0O"))
                .map(|v| (8, v))
        }) {
        if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
            return None;
        }
        u64::from_str_radix(digits, radix).ok()? as f64
    } else {
        value.parse::<f64>().ok()?
    };
    (number.is_finite()
        && number > 0.0
        && number.fract() == 0.0
        && number <= 9_007_199_254_740_991.0)
        .then_some(number as i64)
}

pub struct ApiJson(pub Value);
impl<S: Send + Sync> FromRequest<S> for ApiJson {
    type Rejection = ApiError;
    async fn from_request(request: Request, state: &S) -> Result<Self, Self::Rejection> {
        Json::<Value>::from_request(request, state)
            .await
            .map(|Json(value)| Self(value))
            .map_err(|error| {
                ApiError(
                    error.status(),
                    "Request body must be valid JSON and fit the request size limit".into(),
                )
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn coerced_integers_match_original_route_validator() {
        let cases: Vec<Value> = serde_json::from_str(include_str!(
            "../tests/fixtures/route-integer-contracts.json"
        ))
        .unwrap();
        for case in cases {
            assert_eq!(
                positive_route_integer(case["input"].as_str().unwrap()),
                case.get("output").and_then(Value::as_i64),
                "{}",
                case["input"]
            );
        }
    }
}
