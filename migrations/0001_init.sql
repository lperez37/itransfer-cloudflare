-- Initial schema for iTransfer on D1.
-- All timestamps are ISO 8601 UTC strings with a trailing "Z".

CREATE TABLE shares (
    id TEXT PRIMARY KEY,
    title TEXT,
    id_format TEXT NOT NULL DEFAULT 'random',
    created_at TEXT NOT NULL,
    expires_at TEXT,
    max_downloads INTEGER,
    download_count INTEGER NOT NULL DEFAULT 0,
    password_hash TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    total_size INTEGER NOT NULL DEFAULT 0,
    -- set once uploads are verified; NULL marks abandoned uploads for cleanup
    confirmed_at TEXT,
    created_by TEXT
);

CREATE TABLE requests (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    message TEXT,
    id_format TEXT NOT NULL DEFAULT 'random',
    created_at TEXT NOT NULL,
    expires_at TEXT,
    max_uploads INTEGER,
    max_file_size INTEGER,
    upload_count INTEGER NOT NULL DEFAULT 0,
    allow_incremental INTEGER NOT NULL DEFAULT 0,
    password_hash TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_by TEXT
);

CREATE TABLE files (
    id TEXT PRIMARY KEY,
    original_filename TEXT NOT NULL,
    r2_key TEXT NOT NULL,
    file_size INTEGER,
    content_type TEXT,
    share_id TEXT REFERENCES shares(id) ON DELETE CASCADE,
    request_id TEXT REFERENCES requests(id) ON DELETE CASCADE,
    -- 0 until the upload is verified in R2; unconfirmed files are garbage-collected
    confirmed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE TABLE downloads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
    file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    downloaded_at TEXT NOT NULL,
    ip_address TEXT,
    user_agent TEXT
);

CREATE TABLE password_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    share_id TEXT REFERENCES shares(id) ON DELETE CASCADE,
    request_id TEXT REFERENCES requests(id) ON DELETE CASCADE,
    attempted_at TEXT NOT NULL
);

CREATE INDEX idx_files_share ON files (share_id);
CREATE INDEX idx_files_request ON files (request_id);
CREATE INDEX idx_downloads_share ON downloads (share_id);
CREATE INDEX idx_attempts_share ON password_attempts (share_id, attempted_at);
CREATE INDEX idx_attempts_request ON password_attempts (request_id, attempted_at);
