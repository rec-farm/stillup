CREATE TABLE check_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  monitor_id uuid NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  config_revision integer NOT NULL,
  execution_epoch integer NOT NULL,
  scheduled_at timestamptz NOT NULL DEFAULT now(),
  available_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  claim_id uuid,
  lease_until timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX check_jobs_exclusive ON check_jobs(monitor_id,execution_epoch) WHERE status IN ('pending','running');
CREATE INDEX check_jobs_due ON check_jobs(available_at,id) WHERE status IN ('pending','running');
