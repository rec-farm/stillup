use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
fn v4(ip: Ipv4Addr) -> bool {
    let value = u32::from(ip);
    // Match the deployed ipaddr.js non-unicast ranges, including AS112 and AMT.
    let ranges: [([u8; 4], u32); 18] = [
        ([0, 0, 0, 0], 8),
        ([224, 0, 0, 0], 4),
        ([169, 254, 0, 0], 16),
        ([127, 0, 0, 0], 8),
        ([100, 64, 0, 0], 10),
        ([10, 0, 0, 0], 8),
        ([172, 16, 0, 0], 12),
        ([192, 168, 0, 0], 16),
        ([192, 0, 0, 0], 24),
        ([192, 0, 2, 0], 24),
        ([192, 88, 99, 0], 24),
        ([198, 18, 0, 0], 15),
        ([198, 51, 100, 0], 24),
        ([203, 0, 113, 0], 24),
        ([240, 0, 0, 0], 4),
        ([192, 175, 48, 0], 24),
        ([192, 31, 196, 0], 24),
        ([192, 52, 193, 0], 24),
    ];
    !ranges
        .iter()
        .any(|(base, bits)| value >> (32 - bits) == u32::from(Ipv4Addr::from(*base)) >> (32 - bits))
}
fn v6(ip: Ipv6Addr) -> bool {
    if let Some(ip) = ip.to_ipv4_mapped() {
        return v4(ip);
    }
    if ip.is_unspecified() || ip.is_loopback() {
        return false;
    }
    let value = u128::from(ip);
    let ranges = [
        (0xfe80u128 << 112, 10),
        (0xff00 << 112, 8),
        (0xfc00 << 112, 7),
        (0xfec0 << 112, 10),
        (0x100 << 112, 64),
        (0xffff << 64, 96),
        (0x64ff9bu128 << 96, 96),
        (0x64ff9b0001u128 << 80, 48),
        (0x2002 << 112, 16),
        (0x2001 << 112, 23),
        (0x20010db8u128 << 96, 32),
        (0x2620004f8000u128 << 80, 48),
        (0x5f00 << 112, 16),
        (0x3fff << 112, 20),
    ];
    !ranges
        .iter()
        .any(|(base, bits)| value >> (128 - bits) == base >> (128 - bits))
}
pub fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => v4(ip),
        IpAddr::V6(ip) => v6(ip),
    }
}
pub async fn resolve(url: &url::Url, allow_private: bool) -> Result<Vec<SocketAddr>, ResolveError> {
    let host = url
        .host_str()
        .ok_or(ResolveError::Policy)?
        .trim_matches(['[', ']']);
    let port = url.port_or_known_default().ok_or(ResolveError::Policy)?;
    let addresses = if let Ok(ip) = host.parse::<IpAddr>() {
        vec![SocketAddr::new(ip, port)]
    } else {
        tokio::net::lookup_host((host, port))
            .await
            .map_err(|_| ResolveError::Connection)?
            .collect::<Vec<_>>()
    };
    if addresses.is_empty() {
        return Err(ResolveError::Connection);
    }
    if !allow_private && addresses.iter().any(|address| !is_public(address.ip())) {
        return Err(ResolveError::Policy);
    }
    Ok(addresses)
}
#[derive(Debug)]
pub enum ResolveError {
    Policy,
    Connection,
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn matches_existing_network_policy_fixtures() {
        let fixtures: Vec<serde_json::Value> =
            serde_json::from_str(include_str!("../tests/fixtures/network-contracts.json")).unwrap();
        for fixture in fixtures {
            let address = fixture["address"].as_str().unwrap();
            assert_eq!(
                is_public(address.parse().unwrap()),
                fixture["public"].as_bool().unwrap(),
                "address: {address}"
            );
        }
    }
}
