use crate::{
    assertions, check_config,
    network::{self, ResolveError},
};
use chrono::{SecondsFormat, Utc};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

#[derive(Default)]
pub struct Options {
    pub allow_private_networks: bool,
    pub secrets: HashMap<String, String>,
}
fn secret_name(value: &str) -> bool {
    value.as_bytes().first().is_some_and(u8::is_ascii_uppercase)
        && value
            .bytes()
            .all(|v| v.is_ascii_uppercase() || v.is_ascii_digit() || v == b'_')
}
#[derive(Debug)]
pub struct MissingSecret;
pub fn resolve_secrets(
    value: &str,
    secrets: &HashMap<String, String>,
) -> Result<String, MissingSecret> {
    let mut output = String::new();
    let mut rest = value;
    while let Some(start) = rest.find("{{") {
        output.push_str(&rest[..start]);
        let candidate = &rest[start + 2..];
        if let Some(end) = candidate.find("}}") {
            let name = &candidate[..end];
            if secret_name(name) {
                output.push_str(
                    secrets
                        .get(&format!("CHECK_SECRET_{name}"))
                        .ok_or(MissingSecret)?,
                );
                rest = &candidate[end + 2..];
                continue;
            }
        }
        output.push_str("{{");
        rest = candidate;
    }
    output.push_str(rest);
    Ok(output)
}
#[derive(Debug)]
enum Failure {
    Policy,
    Request,
}
async fn request(
    config: &Value,
    options: &Options,
    status: &mut Option<u16>,
    started: Instant,
) -> Result<Vec<Value>, Failure> {
    let url = url::Url::parse(config["url"].as_str().ok_or(Failure::Policy)?)
        .map_err(|_| Failure::Policy)?;
    let addresses = network::resolve(&url, options.allow_private_networks)
        .await
        .map_err(|v| match v {
            ResolveError::Policy => Failure::Policy,
            ResolveError::Connection => Failure::Request,
        })?;
    let host = url
        .host_str()
        .ok_or(Failure::Policy)?
        .trim_matches(['[', ']']);
    // Disable redirects and environment proxies. Pin the same validated DNS addresses to
    // the connector, keeping TLS SNI and certificate verification on the original hostname.
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .resolve_to_addrs(host, &addresses)
        .build()
        .map_err(|_| Failure::Request)?;
    let method =
        reqwest::Method::from_bytes(config["method"].as_str().ok_or(Failure::Policy)?.as_bytes())
            .map_err(|_| Failure::Policy)?;
    let mut request = client
        .request(method, url.clone())
        .header("user-agent", "StillUp/0.1");
    for (key, value) in config["headers"].as_object().ok_or(Failure::Policy)? {
        let value = resolve_secrets(value.as_str().ok_or(Failure::Policy)?, &options.secrets)
            .map_err(|_| Failure::Policy)?;
        request = request.header(key, value);
    }
    let body = config["body"].as_str().ok_or(Failure::Policy)?;
    if !body.is_empty() {
        request =
            request.body(resolve_secrets(body, &options.secrets).map_err(|_| Failure::Policy)?);
    }
    let mut response = request.send().await.map_err(|_| Failure::Request)?;
    *status = Some(response.status().as_u16());
    let headers = response.headers().clone();
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| Failure::Request)? {
        if body.len() + chunk.len() > 1024 * 1024 {
            return Err(Failure::Request);
        }
        body.extend_from_slice(&chunk);
    }
    let duration = started.elapsed().as_secs_f64().mul_add(1000.0, 0.0).round() as u64;
    Ok(assertions::evaluate(
        config,
        status.unwrap(),
        duration,
        &headers,
        &String::from_utf8_lossy(&body),
    ))
}
pub async fn execute(input: &Value, options: &Options) -> Value {
    let started = Instant::now();
    let checked = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let mut status = None;
    let config = check_config::validate(input);
    let timeout = config
        .as_ref()
        .ok()
        .and_then(|config| config["timeoutMs"].as_u64())
        .unwrap_or(10000);
    let result = match config {
        Err(_) => Ok(Err(Failure::Policy)),
        Ok(config) => {
            tokio::time::timeout(
                Duration::from_millis(timeout),
                request(&config, options, &mut status, started),
            )
            .await
        }
    };
    let duration = (started.elapsed().as_secs_f64() * 1000.0).round() as u64;
    match result {
        Ok(Ok(assertions)) => {
            let failures: Vec<_> = assertions
                .iter()
                .filter(|v| v["passed"] == json!(false))
                .map(|v| v["message"].clone())
                .collect();
            json!({"outcome":if failures.is_empty(){"pass"}else{"fail"},"statusCode":status,"durationMs":duration,"checkedAt":checked,"assertions":assertions,"failures":failures})
        }
        result => {
            json!({"outcome":if matches!(result,Ok(Err(Failure::Policy))){"error"}else{"fail"},"statusCode":status,"durationMs":duration,"checkedAt":checked,"failures":[match result{Ok(Err(Failure::Policy))=>"Check configuration or network policy prevented execution".into(),Err(_)=>format!("Request timed out after {timeout} ms"),_=>"Request failed (connection, TLS, or response limit)".into()}]})
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn network_policy_errors_are_not_outages() {
        let config = json!({"name":"Private","url":"http://127.0.0.1:9"});
        let result = execute(&config, &Options::default()).await;
        assert_eq!(result["outcome"], "error");
        assert!(result["statusCode"].is_null());
    }
    #[test]
    fn missing_secrets_and_nonsecret_templates() {
        let secrets = HashMap::from([("CHECK_SECRET_TOKEN".into(), "secret".into())]);
        assert_eq!(
            resolve_secrets("Bearer {{TOKEN}}", &secrets).unwrap(),
            "Bearer secret"
        );
        assert!(resolve_secrets("{{MISSING}}", &secrets).is_err());
        assert_eq!(
            resolve_secrets("{{lowercase}}", &secrets).unwrap(),
            "{{lowercase}}"
        );
    }
}
