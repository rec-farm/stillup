-- Every change made through the API: who made it (the installation, a person, an API key or
-- trusted workflow, or an agent acting for a person through farmhand), what they asked for and
-- how it ended. Request bodies are never recorded; they can hold credentials.
CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL CHECK (actor IN ('installation', 'user', 'credential', 'agent')),
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  credential_id uuid,
  agent text CHECK (length(agent) <= 100),
  method text NOT NULL,
  path text NOT NULL CHECK (length(path) <= 512),
  status smallint NOT NULL
);
CREATE INDEX audit_log_at ON audit_log(at DESC);
