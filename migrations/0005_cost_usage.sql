-- Forward-only additive schema; rollback requires a forward migration removing
-- these views/triggers/table (and loses usage history). Apply 0006 before serving
-- costs. No PII or cascading foreign keys: usage must survive content purges.
CREATE TABLE cost_usage (
  event_key TEXT PRIMARY KEY,
  owner_user_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('upload', 'download')),
  operations INTEGER NOT NULL CHECK (operations >= 0),
  occurred_at TEXT NOT NULL
);
CREATE INDEX idx_cost_usage_time_owner ON cost_usage(occurred_at, owner_user_id);
CREATE INDEX idx_cost_usage_owner_time ON cost_usage(owner_user_id, occurred_at);
CREATE INDEX idx_password_tokens_expiry ON password_tokens(expires_at);

-- Current logical storage, not historical GB-days or verified R2 inventory.
-- Paused shares still occupy storage; expired-but-not-cleaned active rows do too.
-- Unconfirmed uploads and inactive history are deliberately excluded.
CREATE VIEW cost_storage AS
SELECT f.id AS file_id, COALESCE(s.owner_user_id, r.owner_user_id,
  (SELECT value FROM app_settings WHERE key = 'bootstrap_admin_id')) AS owner_user_id,
  COALESCE(f.file_size, 0) AS storage_bytes
FROM files f
LEFT JOIN shares s ON s.id = f.share_id
LEFT JOIN requests r ON r.id = f.request_id
WHERE f.confirmed = 1 AND (s.is_active = 1 OR r.is_active = 1);

-- Frozen upload approximation: 100 MiB single PUT threshold, 50 MiB parts.
-- Keep future migrations aligned with types.ts if upload sizing changes.
-- Expose the raw PK so each trigger can SEARCH files by id. Filtering the
-- concatenated event_key instead causes a full files scan for every upload,
-- wasting D1 rows-read quota on Workers Free. Only the one-time backfill scans.
-- https://sqlite.org/eqp.html
-- https://developers.cloudflare.com/d1/platform/pricing/
CREATE VIEW cost_file_uploads AS
SELECT f.id AS file_id, 'upload:' || f.id AS event_key,
  COALESCE(s.owner_user_id, r.owner_user_id,
    (SELECT value FROM app_settings WHERE key = 'bootstrap_admin_id')) AS owner_user_id,
  CASE WHEN COALESCE(f.file_size, 0) <= 104857600 THEN 1
    ELSE CAST((f.file_size + 52428799) / 52428800 AS INTEGER) + 2 END AS operations,
  f.created_at
FROM files f
LEFT JOIN shares s ON s.id = f.share_id
LEFT JOIN requests r ON r.id = f.request_id
WHERE f.confirmed = 1;

CREATE TRIGGER cost_file_confirmed AFTER UPDATE OF confirmed ON files
WHEN OLD.confirmed = 0 AND NEW.confirmed = 1
BEGIN
  INSERT OR IGNORE INTO cost_usage
  SELECT event_key, owner_user_id, 'upload', operations,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM cost_file_uploads WHERE file_id = NEW.id;
END;
CREATE TRIGGER cost_file_inserted AFTER INSERT ON files
WHEN NEW.confirmed = 1
BEGIN
  INSERT OR IGNORE INTO cost_usage
  SELECT event_key, owner_user_id, 'upload', operations,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM cost_file_uploads WHERE file_id = NEW.id;
END;
CREATE TRIGGER cost_download_inserted AFTER INSERT ON downloads
BEGIN
  INSERT OR IGNORE INTO cost_usage
  VALUES ('download:' || NEW.id,
    COALESCE((SELECT owner_user_id FROM shares WHERE id = NEW.share_id),
      (SELECT value FROM app_settings WHERE key = 'bootstrap_admin_id')),
    'download', 1, NEW.downloaded_at);
END;
