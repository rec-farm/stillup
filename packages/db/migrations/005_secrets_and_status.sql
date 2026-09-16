CREATE TABLE managed_secrets (
  name text PRIMARY KEY,
  encrypted_value jsonb NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE status_settings (
  id integer PRIMARY KEY CHECK(id=1),
  config jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 1
);
CREATE TABLE maintenance_windows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  monitor_ids uuid[] NOT NULL DEFAULT '{}',
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL CHECK(ends_at>starts_at),
  cancelled boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE status_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  monitor_ids uuid[] NOT NULL,
  resolved_at timestamptz,
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE incidents ADD COLUMN communication_revision integer NOT NULL DEFAULT 1;
CREATE TABLE status_updates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL,
  source text NOT NULL CHECK(source IN ('automatic','manual')),
  stage text NOT NULL CHECK(stage IN ('investigating','identified','monitoring','resolved')),
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX status_update_incident ON status_updates(incident_id,created_at);
CREATE INDEX maintenance_times ON maintenance_windows(starts_at,ends_at) WHERE NOT cancelled;
