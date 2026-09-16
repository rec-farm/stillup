CREATE TABLE probe_locations (
  id text PRIMARY KEY,
  name text NOT NULL,
  region text NOT NULL,
  token_hash text UNIQUE,
  enrollment_hash text UNIQUE,
  enrollment_expires_at timestamptz,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO probe_locations(id,name,region) VALUES ('local','Local probe','This installation');
CREATE TABLE probe_rounds (
  id uuid PRIMARY KEY,
  monitor_id uuid NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  config_revision integer NOT NULL,
  execution_epoch integer NOT NULL,
  deadline timestamptz NOT NULL,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX probe_round_active ON probe_rounds(monitor_id) WHERE finished_at IS NULL;
CREATE TABLE probe_jobs (
  id uuid PRIMARY KEY,
  round_id uuid NOT NULL REFERENCES probe_rounds(id) ON DELETE CASCADE,
  location_id text NOT NULL REFERENCES probe_locations(id),
  lease_token uuid,
  lease_until timestamptz,
  result jsonb,
  completed_at timestamptz,
  UNIQUE(round_id,location_id)
);
CREATE INDEX probe_job_location ON probe_jobs(location_id,round_id) WHERE completed_at IS NULL;
CREATE INDEX probe_round_history ON probe_rounds(monitor_id,created_at DESC);
