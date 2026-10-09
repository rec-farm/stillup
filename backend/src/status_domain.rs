#[derive(Debug, PartialEq, Eq)]
pub enum Action {
    StatusPage,
    PublicApi,
    Asset,
    Deny,
}

pub fn is_status_domain(host: &str, domains: &str) -> bool {
    let host = host.to_ascii_lowercase();
    let host = match host.rsplit_once(':') {
        Some((name, port)) if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) => name,
        _ => &host,
    }
    .trim_end_matches('.');
    domains.split(',').any(|domain| {
        let domain = domain.trim().trim_end_matches('.');
        !domain.is_empty() && domain.eq_ignore_ascii_case(host)
    })
}

pub fn action(path: &str, method: &str) -> Action {
    if !matches!(method, "GET" | "HEAD") {
        return Action::Deny;
    }
    match path {
        "/" | "/status" => Action::StatusPage,
        "/api/v1/public/status" | "/v1/public/status" => Action::PublicApi,
        "/brand/stillup-favicon.svg"
        | "/brand/stillup-lockup-cream.svg"
        | "/brand/stillup-lockup-ink.svg"
        | "/brand/stillup-endorsed-cream.svg"
        | "/brand/stillup-endorsed-ink.svg" => Action::Asset,
        _ if path.starts_with("/assets/") => Action::Asset,
        _ => Action::Deny,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_hosts_only() {
        assert!(is_status_domain(
            "STATUS.example.com:3000",
            "status.example.com, other.com"
        ));
        assert!(is_status_domain(
            "status.example.com.",
            "status.example.com"
        ));
        for host in [
            "",
            "evilstatus.example.com",
            "status.example.com.evil.com",
            "dashboard.example.com",
        ] {
            assert!(!is_status_domain(host, "status.example.com"));
        }
    }
    #[test]
    fn restrict_public_hosts_to_read_only_status_and_vite_assets() {
        assert_eq!(action("/", "GET"), Action::StatusPage);
        assert_eq!(action("/assets/status-abcd.js", "HEAD"), Action::Asset);
        assert_eq!(action("/api/v1/public/status", "GET"), Action::PublicApi);
        for path in [
            "/login",
            "/docs",
            "/api/v1/status-management",
            "/api/v1/public/workspace",
            "/api/v1/public/status/extra",
        ] {
            assert_eq!(action(path, "GET"), Action::Deny);
        }
        for method in ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"] {
            assert_eq!(action("/api/v1/public/status", method), Action::Deny);
        }
    }
}
