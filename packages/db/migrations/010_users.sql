-- Named people who sign in with single sign-on. While this table is empty, everyone the
-- identity provider admits signs in as the installation administrator, as before.
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 254),
  name text CHECK (length(name) <= 200),
  role text NOT NULL CHECK (role IN ('admin', 'viewer')),
  -- Issuer and subject, bound on first sign-in so a later email change keeps the account.
  oidc_subject text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_sign_in_at timestamptz
);

-- Revocable browser sessions for named users; the cookie holds a random token, stored hashed.
CREATE TABLE user_sessions (
  token_hash bytea PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX user_sessions_user ON user_sessions(user_id);
CREATE INDEX user_sessions_expires ON user_sessions(expires_at);
