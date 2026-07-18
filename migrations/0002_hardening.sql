-- Hardening migration for iTransfer on D1.
-- Adds security/operational infrastructure on top of the initial schema:
--   * public_ids  - cross-namespace uniqueness for the shared /{id} URL space
--   * rate_hits   - IP-based rate limiting for public endpoints and admin login
--   * app_settings - key/value store (e.g. session-revocation epoch)
-- Plus supporting indexes for cascaded deletes and the hourly cleanup cron.
-- All timestamps are ISO 8601 UTC strings with a trailing "Z".

-- Cross-namespace public ID uniqueness registry (shares + requests share the /{id} URL space)
CREATE TABLE IF NOT EXISTS public_ids (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('share','request')),
  created_at TEXT NOT NULL
);

-- IP-based rate limiting store (public endpoints + admin login)
CREATE TABLE IF NOT EXISTS rate_hits (
  id INTEGER PRIMARY KEY,
  bucket TEXT NOT NULL,
  ip TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_hits ON rate_hits (bucket, ip, at);

-- Key/value settings (used for session-revocation epoch)
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- FK index: cascaded file deletes otherwise full-scan the append-only downloads table
CREATE INDEX IF NOT EXISTS idx_downloads_file ON downloads (file_id);
CREATE INDEX IF NOT EXISTS idx_downloads_at ON downloads (downloaded_at);

-- Partial indexes serving the hourly cron predicates
CREATE INDEX IF NOT EXISTS idx_files_unconfirmed ON files (created_at) WHERE confirmed = 0;
CREATE INDEX IF NOT EXISTS idx_shares_orphan ON shares (created_at) WHERE confirmed_at IS NULL AND is_active = 0;
CREATE INDEX IF NOT EXISTS idx_shares_expiring ON shares (expires_at) WHERE is_active = 1 AND expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_requests_expiring ON requests (expires_at) WHERE is_active = 1 AND expires_at IS NOT NULL;
