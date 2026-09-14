CREATE TABLE monitors (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), config jsonb NOT NULL, enabled boolean NOT NULL DEFAULT true,
 status text NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown','up','down')),
 failures integer NOT NULL DEFAULT 0, successes integer NOT NULL DEFAULT 0,
 next_run_at timestamptz NOT NULL DEFAULT now(), last_run_at timestamptz, last_observed_at timestamptz,
 last_duration_ms integer, last_outcome text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX monitors_due_idx ON monitors(next_run_at) WHERE enabled;
CREATE TABLE runs (
 id uuid PRIMARY KEY, monitor_id uuid NOT NULL REFERENCES monitors(id), outcome text NOT NULL,
 status_code integer, duration_ms integer NOT NULL, failures jsonb NOT NULL, checked_at timestamptz NOT NULL
);
CREATE INDEX runs_monitor_time_idx ON runs(monitor_id, checked_at DESC);
CREATE TABLE incidents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), monitor_id uuid NOT NULL REFERENCES monitors(id), name text NOT NULL,
 opened_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz
);
CREATE UNIQUE INDEX one_open_incident ON incidents(monitor_id) WHERE resolved_at IS NULL;
CREATE TABLE worker_health (id text PRIMARY KEY, seen_at timestamptz NOT NULL DEFAULT now());
