-- Data only. Idempotent event keys also prevent double counting writes between
-- 0005 and this migration. Retained confirmed files use created_at because no
-- per-file confirmation timestamp existed. Previously purged usage and request
-- downloads cannot be reconstructed. Inactive files contribute uploads, never
-- storage. Null legacy owners resolve via bootstrap_admin_id at reporting time.
INSERT OR IGNORE INTO cost_usage
SELECT event_key, owner_user_id, 'upload', operations, created_at
FROM cost_file_uploads;

INSERT OR IGNORE INTO cost_usage
SELECT 'download:' || d.id,
  COALESCE(s.owner_user_id,
    (SELECT value FROM app_settings WHERE key = 'bootstrap_admin_id')),
  'download', 1, d.downloaded_at
FROM downloads d JOIN shares s ON s.id = d.share_id;
