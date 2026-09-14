CREATE TABLE notification_channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  url text,
  enabled boolean NOT NULL DEFAULT true,
  is_default boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1,
  source text NOT NULL DEFAULT 'database' CHECK(source IN ('database','environment')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE notification_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id uuid NOT NULL REFERENCES notification_channels(id),
  channel_name text NOT NULL,
  incident_id uuid REFERENCES incidents(id),
  event jsonb NOT NULL,
  target_url text NOT NULL,
  dedupe_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','delivering','retrying','delivered','failed','cancelled')),
  attempts integer NOT NULL DEFAULT 0,
  cycle_attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz DEFAULT now(),
  lease_until timestamptz,
  claim_id uuid,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);
CREATE INDEX notification_due ON notification_deliveries(next_attempt_at) WHERE status IN ('pending','retrying','delivering');
CREATE INDEX notification_ordering ON notification_deliveries(incident_id,channel_id,created_at,id) WHERE status IN ('pending','retrying','delivering');
CREATE INDEX notification_history ON notification_deliveries(created_at DESC,id DESC);
CREATE INDEX notification_incident ON notification_deliveries(incident_id);
CREATE TABLE notification_attempts (
  id uuid PRIMARY KEY,
  delivery_id uuid NOT NULL REFERENCES notification_deliveries(id),
  number integer NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status_code integer,
  error text,
  UNIQUE(delivery_id,number)
);
CREATE TABLE incident_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL REFERENCES incidents(id),
  type text NOT NULL CHECK(type IN ('incident.opened','incident.resolved')),
  at timestamptz NOT NULL,
  run_id uuid NOT NULL,
  config_revision integer NOT NULL,
  result jsonb NOT NULL,
  UNIQUE(incident_id,type)
);
ALTER TABLE incidents ADD COLUMN last_reminder_at timestamptz;
