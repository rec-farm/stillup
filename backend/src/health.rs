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

#[derive(Clone, Debug, PartialEq)]
pub struct HealthState {
    pub status: String,
    pub failures: i32,
    pub successes: i32,
}
pub fn evaluate(
    previous: HealthState,
    outcome: &str,
    failure_threshold: i64,
    recovery_threshold: i64,
) -> HealthState {
    if outcome == "error" {
        return previous;
    }
    let failures = if outcome == "fail" {
        previous.failures.saturating_add(1)
    } else {
        0
    };
    let successes = if outcome == "pass" {
        previous.successes.saturating_add(1)
    } else {
        0
    };
    let status = if i64::from(failures) >= failure_threshold {
        "down".into()
    } else if i64::from(successes) >= recovery_threshold {
        "up".into()
    } else {
        previous.status
    };
    HealthState {
        status,
        failures,
        successes,
    }
}

#[cfg(test)]
mod transition_tests {
    use super::*;
    #[test]
    fn errors_preserve_state_and_recovery_requires_consecutive_successes() {
        let initial = HealthState {
            status: "unknown".into(),
            failures: 0,
            successes: 0,
        };
        let first = evaluate(initial, "fail", 2, 2);
        assert_eq!(first.status, "unknown");
        let down = evaluate(first, "fail", 2, 2);
        assert_eq!(down.status, "down");
        assert_eq!(evaluate(down.clone(), "error", 2, 2), down);
        let recovering = evaluate(down, "pass", 2, 2);
        assert_eq!(recovering.status, "down");
        assert_eq!(recovering.failures, 0);
        assert_eq!(evaluate(recovering, "pass", 2, 2).status, "up");
    }
}
