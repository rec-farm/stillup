use chrono::{DateTime, Utc};

pub fn visible(
    status: &str,
    enabled: bool,
    observed: Option<DateTime<Utc>>,
    interval_seconds: i64,
    now: DateTime<Utc>,
) -> &str {
    if !enabled {
        return "paused";
    }
    match observed {
        None => "unknown",
        Some(observed)
            if now.signed_duration_since(observed).num_milliseconds()
                > interval_seconds
                    .saturating_mul(3)
                    .max(120)
                    .saturating_mul(1000) =>
        {
            "unknown"
        }
        _ => status,
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn observations_expire_at_the_existing_threshold() {
        let time = DateTime::from_timestamp_millis(0).unwrap();
        assert_eq!(visible("up", true, None, 60, time), "unknown");
        assert_eq!(visible("down", false, None, 60, time), "paused");
        assert_eq!(
            visible(
                "up",
                true,
                Some(time),
                60,
                DateTime::from_timestamp_millis(180000).unwrap()
            ),
            "up"
        );
        assert_eq!(
            visible(
                "up",
                true,
                Some(time),
                60,
                DateTime::from_timestamp_millis(180001).unwrap()
            ),
            "unknown"
        );
    }
}
