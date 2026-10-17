use crate::web::WebConfig;
use std::{env, path::PathBuf};

#[derive(Clone)]
pub struct Config {
    pub database_url: String,
    pub admin_token: String,
    pub origin: String,
    pub bind: String,
    pub web: WebConfig,
    pub oidc: crate::oidc::OidcConfig,
    /// The issuer of the GitHub Actions tokens that trusted workflows present.
    pub github_actions_issuer: String,
    pub secrets: crate::secrets::SecretConfig,
    pub allow_private_networks: bool,
    pub alert_webhook_url: String,
    pub run_retention_days: i32,
    pub status_page_title: String,
}
impl Config {
    pub fn from_env() -> Result<Self, String> {
        let database_url = env::var("DATABASE_URL").map_err(|_| "DATABASE_URL is required")?;
        let admin_token = env::var("ADMIN_TOKEN").map_err(|_| "ADMIN_TOKEN is required")?;
        if admin_token.encode_utf16().count() < 32 {
            return Err("ADMIN_TOKEN must contain at least 32 characters".into());
        }
        let origin = env::var("APP_ORIGIN").unwrap_or_else(|_| "http://localhost:3000".into());
        let url = url::Url::parse(&origin).map_err(|_| "APP_ORIGIN must be a valid URL")?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err("APP_ORIGIN must be an HTTP(S) URL without credentials".into());
        }
        let port = env::var("PORT")
            .unwrap_or_else(|_| "3001".into())
            .parse::<u16>()
            .map_err(|_| "PORT must be a valid port")?;
        let alert_webhook_url = env::var("ALERT_WEBHOOK_URL").unwrap_or_default();
        if !alert_webhook_url.is_empty() {
            crate::notifications::destination(&serde_json::Value::String(
                alert_webhook_url.clone(),
            ))
            .map_err(|_| "ALERT_WEBHOOK_URL must be a webhook URL or secret reference")?;
        }
        let run_retention_days = env::var("RUN_RETENTION_DAYS")
            .unwrap_or_else(|_| "30".into())
            .parse::<i32>()
            .ok()
            .filter(|days| (1..=365).contains(days))
            .ok_or("RUN_RETENTION_DAYS must be an integer between 1 and 365")?;
        Ok(Self {
            status_page_title: env::var("STATUS_PAGE_TITLE")
                .unwrap_or_else(|_| "Service status".into()),
            run_retention_days,
            alert_webhook_url,
            database_url,
            admin_token,
            origin: url.origin().ascii_serialization(),
            bind: format!(
                "{}:{port}",
                env::var("HOST").unwrap_or_else(|_| "127.0.0.1".into())
            ),
            oidc: crate::oidc::OidcConfig::from_env()?,
            github_actions_issuer: crate::trusted_publishing::issuer_from_env()?,
            secrets: crate::secrets::SecretConfig::from_env()?,
            allow_private_networks: match env::var("ALLOW_PRIVATE_NETWORKS")
                .unwrap_or_else(|_| "false".into())
                .as_str()
            {
                "false" => false,
                "true" => true,
                _ => return Err("ALLOW_PRIVATE_NETWORKS must be true or false".into()),
            },
            web: WebConfig {
                client_dir: PathBuf::from(
                    env::var("CLIENT_DIR").unwrap_or_else(|_| "apps/web/dist".into()),
                ),
                status_domains: env::var("STATUS_PAGE_DOMAINS").unwrap_or_default(),
            },
        })
    }
}
