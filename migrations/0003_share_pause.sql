-- Temporarily hide a share from recipients without deleting its files.
-- Paused shares return 404 publicly but keep their R2 objects and expiry.
ALTER TABLE shares ADD COLUMN is_paused INTEGER NOT NULL DEFAULT 0;
