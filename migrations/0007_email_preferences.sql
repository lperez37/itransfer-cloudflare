-- Additive migration: apply before deploying preference endpoints. To roll back
-- code, leave these tables in place; removal would discard opt-ins and dedup history.
CREATE TABLE user_email_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  share_downloads INTEGER NOT NULL DEFAULT 0 CHECK (share_downloads IN (0,1)),
  request_uploads INTEGER NOT NULL DEFAULT 0 CHECK (request_uploads IN (0,1)),
  password_changed INTEGER NOT NULL DEFAULT 0 CHECK (password_changed IN (0,1)),
  expiry_alerts INTEGER NOT NULL DEFAULT 0 CHECK (expiry_alerts IN (0,1)),
  invitation_reminders INTEGER NOT NULL DEFAULT 0 CHECK (invitation_reminders IN (0,1))
);
-- Admission ledger only: never store recipients, bodies or bearer capabilities.
CREATE TABLE notification_claims (
  event_key TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE INDEX notification_claims_owner_time ON notification_claims(user_id, created_at);
CREATE INDEX notification_claims_time ON notification_claims(created_at);
CREATE INDEX shares_email_expiry ON shares(expires_at) WHERE is_active=1 AND confirmed_at IS NOT NULL;
CREATE INDEX requests_email_expiry ON requests(expires_at) WHERE is_active=1;
