-- Track when a share/request was deactivated (admin delete or expiry cleanup)
-- so history can be auto-purged after HISTORY_RETENTION_DAYS.
ALTER TABLE shares ADD COLUMN deactivated_at TEXT;
ALTER TABLE requests ADD COLUMN deactivated_at TEXT;
