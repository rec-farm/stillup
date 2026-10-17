-- Named API keys for other apps and automation, so they no longer need the installation
-- administrator token. Only a SHA-256 of each key is stored; the key is shown once.
CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  role text NOT NULL CHECK (role IN ('viewer', 'deployer', 'admin')),
  -- Monitoring-as-code projects a deployer may change; null means every project.
  projects text[] CHECK (role = 'deployer' OR projects IS NULL),
  token_hash bytea NOT NULL UNIQUE,
  -- The key's first characters, to tell keys apart without revealing them.
  hint text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  last_used_at timestamptz
);

-- GitHub Actions workflows trusted to deploy monitoring as code without a stored secret. A run
-- presents its GitHub-signed OpenID Connect token and receives a short-lived deploy token.
CREATE TABLE trusted_publishers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository text NOT NULL CHECK (length(repository) BETWEEN 3 AND 140),
  workflow text NOT NULL CHECK (length(workflow) BETWEEN 1 AND 255),
  branch text CHECK (length(branch) BETWEEN 1 AND 255),
  environment text CHECK (length(environment) BETWEEN 1 AND 255),
  projects text[] NOT NULL CHECK (cardinality(projects) BETWEEN 1 AND 20),
  -- GitHub's numeric IDs, bound on first use so a deleted and recreated repository with the
  -- same name cannot deploy.
  repository_id text,
  repository_owner_id text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
CREATE UNIQUE INDEX trusted_publishers_workflow ON trusted_publishers(lower(repository), workflow);

CREATE TABLE publisher_tokens (
  token_hash bytea PRIMARY KEY,
  publisher_id uuid NOT NULL REFERENCES trusted_publishers(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE INDEX publisher_tokens_publisher ON publisher_tokens(publisher_id);
CREATE INDEX publisher_tokens_expires ON publisher_tokens(expires_at);
