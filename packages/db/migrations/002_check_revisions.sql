ALTER TABLE monitors ADD COLUMN config_revision integer NOT NULL DEFAULT 1;
ALTER TABLE monitors ADD COLUMN execution_epoch integer NOT NULL DEFAULT 1;
ALTER TABLE monitors ADD COLUMN archived_at timestamptz;
CREATE TABLE check_revisions (
  monitor_id uuid NOT NULL REFERENCES monitors(id),
  revision integer NOT NULL CHECK (revision > 0),
  config jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (monitor_id, revision)
);
INSERT INTO check_revisions (monitor_id, revision, config, created_at)
  SELECT id, 1, config, created_at FROM monitors;
ALTER TABLE runs ADD COLUMN config_revision integer NOT NULL DEFAULT 1;
ALTER TABLE runs ADD CONSTRAINT runs_config_revision_fk
  FOREIGN KEY (monitor_id, config_revision) REFERENCES check_revisions(monitor_id, revision);
