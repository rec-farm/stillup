use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

type HmacSha256 = Hmac<Sha256>;

pub fn token_matches(candidate: &str, expected: &str) -> bool {
    bool::from(Sha256::digest(candidate.as_bytes()).ct_eq(&Sha256::digest(expected.as_bytes())))
}

// Preserve existing sessions during migration: expiration in milliseconds, dot, hex HMAC.
pub fn session_value(expires_ms: u64, secret: &str) -> String {
    let expires = expires_ms.to_string();
    let mut mac =
        HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key length");
    mac.update(expires.as_bytes());
    format!("{expires}.{}", hex::encode(mac.finalize().into_bytes()))
}

pub fn valid_session(value: &str, secret: &str, now_ms: u64) -> bool {
    let Some((expires, signature)) = value.split_once('.') else {
        return false;
    };
    let Ok(expiration) = expires.parse::<u64>() else {
        return false;
    };
    if expiration <= now_ms {
        return false;
    }
    let Ok(signature) = hex::decode(signature) else {
        return false;
    };
    let mut mac =
        HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key length");
    mac.update(expires.as_bytes());
    mac.verify_slice(&signature).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn node_session_contract_and_expiration() {
        // Independently computed with Node createHmac('sha256', 'secret').update('1000').
        let value = "1000.915a6547f63136914911a498d0a8e18869c29b2ede913579e8125a336d6b7543";
        assert_eq!(session_value(1000, "secret"), value);
        assert!(valid_session(value, "secret", 999));
        assert!(!valid_session(value, "secret", 1000));
        assert!(!valid_session(value, "other", 999));
        for malformed in ["", "1001", "1001.x", "NaN.00", "1000.00.extra"] {
            assert!(!valid_session(malformed, "secret", 999));
        }
    }
    #[test]
    fn administrator_tokens_require_exact_match() {
        assert!(token_matches("secret", "secret"));
        assert!(!token_matches("secret ", "secret"));
        assert!(!token_matches("", "secret"));
    }
}
