use reqwest::header::HeaderMap;
use serde_json::{Value, json};
use std::borrow::Cow;
fn equal(a: &Value, b: &Value) -> bool {
    if a.is_number() && b.is_number() {
        a.as_f64() == b.as_f64()
    } else {
        a == b
    }
}
fn lookup<'a>(root: &'a Value, path: &str) -> Option<Cow<'a, Value>> {
    let mut value = root;
    let mut keys = path.split('.').skip(1).peekable();
    while let Some(key) = keys.next() {
        value = match value {
            Value::Object(map) => map.get(key)?,
            Value::Array(array) => {
                if key == "length" {
                    return if keys.peek().is_none() {
                        Some(Cow::Owned(json!(array.len())))
                    } else {
                        None
                    };
                }
                let i = key.parse::<usize>().ok()?;
                if i.to_string() != key {
                    return None;
                }
                array.get(i)?
            }
            _ => return None,
        };
    }
    Some(Cow::Borrowed(value))
}

fn matches(rule: &Value, value: Option<&Value>) -> bool {
    if let Some(expected) = rule.get("equals") {
        return value.is_some_and(|v| equal(v, expected));
    }
    let op = rule["operator"].as_str().unwrap_or("");
    let expected = &rule["value"];
    match op {
        "exists" => value.is_some(),
        "notExists" => value.is_none(),
        "equals" => value.is_some_and(|v| equal(v, expected)),
        "notEquals" => value.is_some_and(|v| !equal(v, expected)),
        "contains" | "startsWith" | "endsWith" => value
            .and_then(Value::as_str)
            .zip(expected.as_str())
            .is_some_and(|(v, e)| match op {
                "contains" => v.contains(e),
                "startsWith" => v.starts_with(e),
                _ => v.ends_with(e),
            }),
        "gt" | "gte" | "lt" | "lte" => value
            .and_then(Value::as_f64)
            .zip(expected.as_f64())
            .is_some_and(|(v, e)| match op {
                "gt" => v > e,
                "gte" => v >= e,
                "lt" => v < e,
                _ => v <= e,
            }),
        "length" => value
            .and_then(Value::as_array)
            .zip(expected.as_f64())
            .is_some_and(|(v, e)| v.len() as f64 == e),
        _ => false,
    }
}
fn mismatch(rule: &Value, value: Option<&Value>) -> &'static str {
    let Some(value) = value else {
        return "Field is missing";
    };
    let op = if rule.get("equals").is_some() {
        "equals"
    } else {
        rule["operator"].as_str().unwrap_or("")
    };
    if op == "notExists" {
        return "Field exists";
    }
    if op == "length" {
        return if value.is_array() {
            "Array length did not match"
        } else {
            "Expected an array"
        };
    }
    let expected = rule.get("equals").or_else(|| rule.get("value"));
    let same = expected.is_some_and(|e| {
        if e.is_null() {
            value.is_null()
        } else {
            e.is_string() && value.is_string()
                || e.is_number() && value.is_number()
                || e.is_boolean() && value.is_boolean()
        }
    });
    if !same {
        return "Field has the wrong type";
    }
    "Value did not match the condition"
}
// Execute only the bounded draft-07 subset accepted by check_config. No references,
// regexes, formats or external resources can be evaluated by this interpreter.
fn schema_failure(schema: &Value, value: &Value) -> Option<&'static str> {
    if schema == &json!(false) {
        return Some("false schema");
    }
    if schema.is_boolean() {
        return None;
    }
    if let Some(kind) = schema["type"].as_str() {
        let valid = match kind {
            "object" => value.is_object(),
            "array" => value.is_array(),
            "string" => value.is_string(),
            "number" => value.is_number(),
            "integer" => value.as_f64().is_some_and(|v| v.fract() == 0.0),
            "boolean" => value.is_boolean(),
            "null" => value.is_null(),
            _ => false,
        };
        if !valid {
            return Some("type");
        }
    }
    if let Some(enums) = schema["enum"].as_array()
        && !enums.iter().any(|e| equal(e, value))
    {
        return Some("enum");
    }
    if let Some(number) = value.as_f64() {
        if schema["maximum"].as_f64().is_some_and(|v| number > v) {
            return Some("maximum");
        }
        if schema["minimum"].as_f64().is_some_and(|v| number < v) {
            return Some("minimum");
        }
    }
    if let Some(string) = value.as_str() {
        let len = string.chars().count() as u64;
        if schema["maxLength"].as_f64().is_some_and(|v| len as f64 > v) {
            return Some("maxLength");
        }
        if schema["minLength"]
            .as_f64()
            .is_some_and(|v| (len as f64) < v)
        {
            return Some("minLength");
        }
    }
    if let Some(array) = value.as_array() {
        if schema["maxItems"]
            .as_f64()
            .is_some_and(|v| array.len() as f64 > v)
        {
            return Some("maxItems");
        }
        if schema["minItems"]
            .as_f64()
            .is_some_and(|v| (array.len() as f64) < v)
        {
            return Some("minItems");
        }
        if let Some(items) = schema.get("items") {
            for v in array {
                if let Some(keyword) = schema_failure(items, v) {
                    return Some(keyword);
                }
            }
        }
    }
    if let Some(object) = value.as_object() {
        if let Some(fields) = schema["required"].as_array()
            && fields
                .iter()
                .any(|key| !object.contains_key(key.as_str().unwrap_or("")))
        {
            return Some("required");
        }
        if schema["additionalProperties"] == json!(false)
            && object
                .keys()
                .any(|key| schema["properties"].get(key).is_none())
        {
            return Some("additionalProperties");
        }
        if let Some(properties) = schema["properties"].as_object() {
            for (key, schema) in properties {
                if let Some(value) = object.get(key)
                    && let Some(keyword) = schema_failure(schema, value)
                {
                    return Some(keyword);
                }
            }
        }
    }
    None
}
pub fn evaluate(
    config: &Value,
    status: u16,
    duration: u64,
    headers: &HeaderMap,
    body: &str,
) -> Vec<Value> {
    let mut results = Vec::new();
    let mut add = |kind: &str, label: String, passed: bool, failure: String| {
        results.push(json!({"kind":kind,"label":label,"passed":passed,"message":if passed{"Passed".into()}else{failure}}))
    };
    let expected = config["expectedStatus"].as_u64().unwrap_or(200);
    add(
        "status",
        "HTTP status".into(),
        status as u64 == expected,
        format!("Expected HTTP {expected}, received {status}"),
    );
    if let Some(max) = config["maxResponseMs"].as_u64() {
        add(
            "latency",
            "Response time".into(),
            duration <= max,
            format!("Response exceeded {max} ms"),
        );
    }
    if let Some(rules) = config["headerAssertions"].as_array() {
        for rule in rules {
            let name = rule["name"].as_str().unwrap_or("");
            let op = rule["operator"].as_str().unwrap_or("");
            let entries: Vec<String> = headers
                .get_all(name)
                .iter()
                .map(|v| v.as_bytes().iter().map(|byte| *byte as char).collect())
                .collect();
            let value = if entries.is_empty() {
                None
            } else {
                Some(entries.join(", "))
            };
            let passed = match op {
                "exists" => value.is_some(),
                "notExists" => value.is_none(),
                "equals" => value.as_deref() == rule["value"].as_str(),
                _ => value
                    .as_deref()
                    .zip(rule["value"].as_str())
                    .is_some_and(|(v, e)| v.contains(e)),
            };
            let failure = if value.is_none() {
                "Header is missing"
            } else if op == "notExists" {
                "Header exists"
            } else {
                "Value did not match the condition"
            };
            add(
                "header",
                format!("{name} · {op}"),
                passed,
                format!("Header assertion failed: {failure}"),
            );
        }
    }
    if config["jsonAssertions"]
        .as_array()
        .is_some_and(|v| !v.is_empty())
        || config.get("responseSchema").is_some()
    {
        let root = serde_json::from_str::<Value>(body).ok();
        if let Some(rules) = config["jsonAssertions"].as_array() {
            for rule in rules {
                let path = rule["path"].as_str().unwrap_or("$");
                let value = root.as_ref().and_then(|root| lookup(root, path));
                let op = if rule.get("equals").is_some() {
                    "equals"
                } else {
                    rule["operator"].as_str().unwrap_or("")
                };
                add(
                    "json",
                    format!("{path} · {op}"),
                    root.is_some() && matches(rule, value.as_deref()),
                    if root.is_none() {
                        "Response is not valid JSON".into()
                    } else {
                        format!(
                            "JSON assertion failed at {path}: {}",
                            mismatch(rule, value.as_deref())
                        )
                    },
                );
            }
        }
        if let Some(schema) = config.get("responseSchema") {
            let keyword = root.as_ref().and_then(|root| schema_failure(schema, root));
            add(
                "schema",
                "JSON Schema".into(),
                root.is_some() && keyword.is_none(),
                if root.is_none() {
                    "Response is not valid JSON".into()
                } else {
                    format!(
                        "JSON Schema validation failed{}",
                        keyword.map(|v| format!(" ({v})")).unwrap_or_default()
                    )
                },
            );
        }
    }
    results
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn matches_existing_assertion_contract_fixtures() {
        let fixtures: Vec<Value> =
            serde_json::from_str(include_str!("../tests/fixtures/assertion-contracts.json"))
                .unwrap();
        for fixture in fixtures {
            let mut headers = HeaderMap::new();
            for (key, value) in fixture["headers"].as_object().unwrap() {
                headers.insert(
                    reqwest::header::HeaderName::from_bytes(key.as_bytes()).unwrap(),
                    value.as_str().unwrap().parse().unwrap(),
                );
            }
            let result = evaluate(
                &fixture["config"],
                fixture["status"].as_u64().unwrap() as u16,
                fixture["duration"].as_u64().unwrap(),
                &headers,
                fixture["body"].as_str().unwrap(),
            );
            assert_eq!(
                json!(result),
                fixture["expected"],
                "fixture: {}",
                fixture["name"]
            );
        }
    }
}
