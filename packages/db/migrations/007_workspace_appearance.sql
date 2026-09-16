CREATE TABLE workspace_settings (
  id integer PRIMARY KEY CHECK (id = 1),
  config jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0)
);
