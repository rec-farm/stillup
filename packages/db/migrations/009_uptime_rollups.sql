-- Daily, retention-independent uptime. Each pass/fail observation contributes its check
-- interval; time spent in a confirmed outage (status down) counts as downtime.
CREATE TABLE monitor_daily_uptime (
  monitor_id uuid NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  day date NOT NULL,
  observed_seconds bigint NOT NULL DEFAULT 0 CHECK (observed_seconds >= 0),
  down_seconds bigint NOT NULL DEFAULT 0 CHECK (down_seconds BETWEEN 0 AND observed_seconds),
  PRIMARY KEY (monitor_id, day)
);
CREATE INDEX monitor_daily_uptime_day ON monitor_daily_uptime(day);

-- Backfill from retained runs. A run inside an incident's open window was observed down.
INSERT INTO monitor_daily_uptime (monitor_id, day, observed_seconds, down_seconds)
SELECT r.monitor_id,
       (r.checked_at AT TIME ZONE 'UTC')::date,
       sum(s.seconds),
       sum(CASE WHEN EXISTS (
             SELECT 1 FROM incidents i
             WHERE i.monitor_id = r.monitor_id AND i.opened_at <= r.checked_at
               AND (i.resolved_at IS NULL OR r.checked_at < i.resolved_at)
           ) THEN s.seconds ELSE 0 END)
FROM runs r
JOIN check_revisions c ON c.monitor_id = r.monitor_id AND c.revision = r.config_revision
CROSS JOIN LATERAL (
  SELECT LEAST(GREATEST(COALESCE((c.config->>'intervalSeconds')::bigint, 60), 30), 86400) AS seconds
) s
WHERE r.outcome IN ('pass', 'fail')
GROUP BY r.monitor_id, (r.checked_at AT TIME ZONE 'UTC')::date;
