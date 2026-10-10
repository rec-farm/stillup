-- OpenID Connect back-channel logout: the provider names a person (sub) and/or one of its
-- sessions (sid), so each single sign-on session records where it came from. Sessions from
-- before this migration have neither and are matched through their user's bound subject.
ALTER TABLE user_sessions ADD COLUMN oidc_subject text, ADD COLUMN oidc_sid text;
CREATE INDEX user_sessions_oidc_subject ON user_sessions(oidc_subject);
CREATE INDEX user_sessions_oidc_sid ON user_sessions(oidc_sid);

-- Logout token IDs already processed, kept only while the token could still be accepted.
CREATE TABLE oidc_logout_tokens (
  jti_hash bytea PRIMARY KEY,
  expires_at timestamptz NOT NULL
);
CREATE INDEX oidc_logout_tokens_expires ON oidc_logout_tokens(expires_at);
