use serde_json::Value;
use std::time::Duration;

const FAILURE: &str =
    "Webhook could not be delivered (timeout, connection, TLS, or network policy)";

#[derive(Debug, PartialEq)]
pub struct DeliveryResult {
    pub status_code: Option<u16>,
    pub error: Option<String>,
}

/// Validate a resolved webhook URL. Secret references are resolved before this boundary.
pub fn target_url(target: &str) -> Option<url::Url> {
    if target.chars().count() > 4096 {
        return None;
    }
    let url = url::Url::parse(target).ok()?;
    (matches!(url.scheme(), "http" | "https")
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none_or(str::is_empty))
    .then_some(url)
}

pub async fn send(
    target: &str,
    payload: &Value,
    delivery_id: &str,
    allow_private_networks: bool,
) -> DeliveryResult {
    let result = tokio::time::timeout(Duration::from_secs(10), async {
        let url = target_url(target).ok_or(())?;
        let addresses = crate::network::resolve(&url, allow_private_networks)
            .await
            .map_err(|_| ())?;
        let host = url.host_str().ok_or(())?.trim_matches(['[', ']']);
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .resolve_to_addrs(host, &addresses)
            .build()
            .map_err(|_| ())?;
        let mut body = payload.as_object().cloned().ok_or(())?;
        body.insert("eventId".into(), Value::String(delivery_id.into()));
        let response = client
            .post(url)
            .header("user-agent", "StillUp/0.1")
            .header("idempotency-key", delivery_id)
            .json(&body)
            .send()
            .await
            .map_err(|_| ())?;
        // The acknowledgement is its status. Never consume or retain response bodies.
        let status_code = response.status().as_u16();
        drop(response);
        Ok::<_, ()>(DeliveryResult {
            status_code: Some(status_code),
            error: (!(200..300).contains(&status_code))
                .then(|| format!("Webhook returned HTTP {status_code}")),
        })
    })
    .await;
    result
        .unwrap_or(Err(()))
        .unwrap_or_else(|_| DeliveryResult {
            status_code: None,
            error: Some(FAILURE.into()),
        })
}
