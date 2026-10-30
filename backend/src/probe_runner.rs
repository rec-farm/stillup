use aes_gcm::aead::Generate;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::{io::AsyncWriteExt, sync::watch};

#[derive(Clone)]
pub struct Options {
    pub origin: url::Url,
    pub data_dir: PathBuf,
    pub enrollment_token: Option<String>,
    pub allow_private_networks: bool,
}
fn valid_token(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v))
}
impl Options {
    pub fn parse(
        origin: &str,
        data_dir: PathBuf,
        enrollment_token: Option<String>,
        allow_http: bool,
        allow_private_networks: bool,
    ) -> Result<Self, String> {
        let url =
            url::Url::parse(origin).map_err(|_| "STILLUP_URL must be a valid HTTP(S) origin")?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.path() != "/"
            || url.query().is_some_and(|q| !q.is_empty())
            || url.fragment().is_some_and(|q| !q.is_empty())
        {
            return Err(
                "STILLUP_URL must be an HTTP(S) origin without credentials or a path".into(),
            );
        }
        if url.scheme() != "https" && !allow_http {
            return Err(
                "HTTPS is required. Allow HTTP explicitly only for local development.".into(),
            );
        }
        if enrollment_token.as_ref().is_some_and(|v| !valid_token(v)) {
            return Err(
                "STILLUP_ENROLLMENT_TOKEN must be 64 lowercase hexadecimal characters".into(),
            );
        }
        Ok(Self {
            origin: url,
            data_dir,
            enrollment_token,
            allow_private_networks,
        })
    }
    pub fn from_env() -> Result<Self, String> {
        let flag = |name: &str| match std::env::var(name)
            .unwrap_or_else(|_| "false".into())
            .as_str()
        {
            "true" => Ok(true),
            "false" => Ok(false),
            _ => Err(format!("{name} must be true or false")),
        };
        Self::parse(
            &std::env::var("STILLUP_URL").map_err(|_| "STILLUP_URL is required")?,
            std::env::var("STILLUP_PROBE_DATA")
                .unwrap_or_else(|_| "/data".into())
                .into(),
            std::env::var("STILLUP_ENROLLMENT_TOKEN")
                .ok()
                .filter(|v| !v.is_empty()),
            flag("STILLUP_PROBE_ALLOW_HTTP")?,
            flag("STILLUP_PROBE_ALLOW_PRIVATE_NETWORKS")?,
        )
    }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub token: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enrollment_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location_id: Option<String>,
    pub origin: String,
}
impl Identity {
    fn valid(&self) -> bool {
        valid_token(&self.token)
            && self
                .enrollment_token
                .as_ref()
                .is_none_or(|v| valid_token(v))
            && self
                .location_id
                .as_ref()
                .is_none_or(|v| crate::check_config::valid_uuid(v))
    }
}
pub async fn persist(dir: &Path, identity: &Identity) -> Result<(), String> {
    let temporary = dir.join(format!("identity-{}.tmp", uuid::Uuid::new_v4()));
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options
        .open(&temporary)
        .await
        .map_err(|_| "Cannot write probe identity; check data volume permissions")?;
    let bytes = serde_json::to_vec(identity).map_err(|_| "Cannot encode probe identity")?;
    let result = async {
        file.write_all(&bytes).await?;
        file.sync_all().await?;
        drop(file);
        tokio::fs::rename(&temporary, dir.join("identity.json")).await?;
        #[cfg(unix)]
        tokio::fs::File::open(dir).await?.sync_all().await?;
        Ok::<_, std::io::Error>(())
    }
    .await;
    if result.is_err() {
        tokio::fs::remove_file(&temporary).await.ok();
        return Err(
            "Cannot persist probe identity; preserve the data volume and check its permissions"
                .into(),
        );
    }
    Ok(())
}
fn parse_identity(bytes: &[u8]) -> Option<Identity> {
    let value: Value = serde_json::from_slice(bytes).ok()?;
    if ["enrollmentToken", "locationId"]
        .iter()
        .any(|name| value.get(name).is_some_and(|v| !v.is_string()))
    {
        return None;
    }
    serde_json::from_value::<Identity>(value)
        .ok()
        .filter(Identity::valid)
}
pub async fn load_identity(options: &Options) -> Result<Identity, String> {
    let dir = options.data_dir.clone();
    tokio::task::spawn_blocking(move || {
        let mut builder = std::fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(dir)
    })
    .await
    .map_err(|_| "Cannot open probe data volume")?
    .map_err(|_| "Cannot open probe data volume")?;
    let identity = match tokio::fs::read(options.data_dir.join("identity.json")).await {
        Ok(bytes) => parse_identity(&bytes).ok_or(
            "Cannot read probe identity; preserve the data volume and check its permissions",
        )?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let enrollment = options
                .enrollment_token
                .clone()
                .ok_or("Set STILLUP_ENROLLMENT_TOKEN for first enrollment")?;
            let identity = Identity {
                token: hex::encode(<[u8; 32]>::generate()),
                enrollment_token: Some(enrollment),
                location_id: None,
                origin: options.origin.origin().ascii_serialization(),
            };
            persist(&options.data_dir, &identity).await?;
            identity
        }
        Err(_) => {
            return Err(
                "Cannot read probe identity; preserve the data volume and check its permissions"
                    .into(),
            );
        }
    };
    if identity.origin != options.origin.origin().ascii_serialization() {
        return Err("This data volume belongs to a different StillUp installation".into());
    }
    Ok(identity)
}
#[derive(Debug)]
enum CallError {
    Status(u16),
    Unavailable,
}
async fn call(
    client: &reqwest::Client,
    options: &Options,
    path: &str,
    mut body: Value,
    credential: Option<&str>,
) -> Result<Value, CallError> {
    body["protocolVersion"] = json!(1);
    let mut request = client
        .post(
            options
                .origin
                .join(&format!("/v1/probe/{path}"))
                .map_err(|_| CallError::Unavailable)?,
        )
        .json(&body);
    if let Some(credential) = credential {
        request = request.bearer_auth(credential);
    }
    let response = request.send().await.map_err(|_| CallError::Unavailable)?;
    if !response.status().is_success() {
        return Err(CallError::Status(response.status().as_u16()));
    }
    // Bound successful protocol responses too; configs may contain secrets.
    let mut response = response;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| CallError::Unavailable)? {
        if bytes.len() + chunk.len() > 1024 * 1024 {
            return Err(CallError::Unavailable);
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| CallError::Unavailable)
}
fn stopping(stop: &watch::Receiver<bool>) -> bool {
    *stop.borrow() || stop.has_changed().is_err()
}
async fn pause(stop: &mut watch::Receiver<bool>, draining: bool) {
    if !draining && stopping(stop) {
        return;
    }
    if draining {
        tokio::time::sleep(Duration::from_secs(2)).await;
    } else {
        tokio::select! {_=tokio::time::sleep(Duration::from_secs(2))=>{},_=stop.changed()=>{}}
    }
}
struct Job {
    id: String,
    lease_token: String,
    until: DateTime<Utc>,
    config: Value,
    secrets: HashMap<String, String>,
}
fn job(response: Value) -> Result<Option<Job>, CallError> {
    if response["protocolVersion"].as_f64() != Some(1.0) {
        return Err(CallError::Unavailable);
    }
    let input = response.get("job").ok_or(CallError::Unavailable)?;
    if input.is_null() {
        return Ok(None);
    }
    let id = input["id"]
        .as_str()
        .filter(|v| crate::check_config::valid_uuid(v))
        .ok_or(CallError::Unavailable)?
        .into();
    let lease_token = input["leaseToken"]
        .as_str()
        .filter(|v| crate::check_config::valid_uuid(v))
        .ok_or(CallError::Unavailable)?
        .into();
    let until = input["leaseUntil"]
        .as_str()
        .and_then(|v| DateTime::parse_from_rfc3339(v).ok())
        .map(|v| v.with_timezone(&Utc))
        .ok_or(CallError::Unavailable)?;
    let config =
        crate::check_config::validate(&input["config"]).map_err(|_| CallError::Unavailable)?;
    let secrets =
        serde_json::from_value(input["secrets"].clone()).map_err(|_| CallError::Unavailable)?;
    Ok(Some(Job {
        id,
        lease_token,
        until,
        config,
        secrets,
    }))
}
struct Pending {
    until: DateTime<Utc>,
    body: Value,
}
pub async fn run(options: Options, mut stop: watch::Receiver<bool>) -> Result<(), String> {
    let mut identity = load_identity(&options).await?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|_| "Cannot initialize probe HTTP client")?;
    while identity.enrollment_token.is_some() && !stopping(&stop) {
        let result = call(
            &client,
            &options,
            "enroll",
            json!({"enrollmentToken":identity.enrollment_token,"credential":identity.token}),
            None,
        )
        .await;
        match result {
            Ok(result)
                if result["protocolVersion"].as_f64() == Some(1.0)
                    && result["locationId"]
                        .as_str()
                        .is_some_and(crate::check_config::valid_uuid) =>
            {
                identity.location_id = result["locationId"].as_str().map(str::to_owned);
                identity.enrollment_token = None;
                persist(&options.data_dir, &identity).await?;
                tracing::info!("Probe enrolled. Keep the data volume to reconnect after restarts.");
            }
            Err(CallError::Status(400 | 401 | 403)) => return Err(
                "Enrollment rejected. Generate a replacement enrollment and use a new data volume."
                    .into(),
            ),
            _ => {
                tracing::error!("Enrollment unavailable; retrying.");
                pause(&mut stop, false).await;
            }
        }
    }
    let mut pending: Option<Pending> = None;
    tracing::info!("Probe ready; polling for checks.");
    while !stopping(&stop) || pending.is_some() {
        if pending.as_ref().is_some_and(|p| Utc::now() >= p.until) {
            pending = None;
            continue;
        }
        if let Some(report) = &pending {
            match call(
                &client,
                &options,
                "results",
                report.body.clone(),
                Some(&identity.token),
            )
            .await
            {
                Ok(_) => {
                    pending = None;
                    if stopping(&stop) {
                        break;
                    }
                }
                Err(CallError::Status(401 | 403)) => return Err(
                    "Probe credential rejected. Re-enroll this location with a new data volume."
                        .into(),
                ),
                Err(CallError::Status(400 | 404 | 409)) => {
                    pending = None;
                    tracing::error!("Probe report is obsolete or rejected.");
                    continue;
                }
                Err(_) => {
                    tracing::error!(
                        "Probe communication interrupted; retrying without logging request data."
                    );
                    pause(&mut stop, true).await;
                    continue;
                }
            }
        }
        if stopping(&stop) {
            break;
        }
        let response = call(&client, &options, "poll", json!({}), Some(&identity.token))
            .await
            .and_then(job);
        match response {
            Ok(Some(job))
                if job
                    .until
                    .signed_duration_since(Utc::now())
                    .num_milliseconds()
                    >= job.config["timeoutMs"].as_i64().unwrap_or(10000) + 2000 =>
            {
                let result = crate::executor::execute(
                    &job.config,
                    &crate::executor::Options {
                        allow_private_networks: options.allow_private_networks,
                        secrets: job.secrets,
                    },
                )
                .await;
                let mut report = json!({"outcome":result["outcome"],"statusCode":result["statusCode"],"durationMs":result["durationMs"]});
                if let Some(assertions) = result["assertions"].as_array() {
                    report["assertions"] = json!(
                        assertions
                            .iter()
                            .map(|a| json!({"passed":a["passed"]}))
                            .collect::<Vec<_>>()
                    );
                }
                pending = Some(Pending {
                    until: job.until,
                    body: json!({"jobId":job.id,"leaseToken":job.lease_token,"result":report}),
                });
            }
            Err(CallError::Status(401 | 403)) => {
                return Err(
                    "Probe credential rejected. Re-enroll this location with a new data volume."
                        .into(),
                );
            }
            _ => {
                pause(&mut stop, false).await;
            }
        }
    }
    Ok(())
}
