-- Forward-only account migration. Rollback requires restoring a pre-migration
-- backup; never re-enable legacy cookie/password fallback on a populated DB.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','user')),
  status TEXT NOT NULL CHECK (status IN ('pending','active','disabled')),
  password_hash TEXT,
  password_salt TEXT NOT NULL CHECK(length(password_salt) = 32 AND password_salt NOT GLOB '*[^0-9a-f]*'),
  session_generation INTEGER NOT NULL DEFAULT 0,
  password_change_required INTEGER NOT NULL DEFAULT 0 CHECK (password_change_required IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_login_at TEXT,
  CHECK (status != 'active' OR password_hash IS NOT NULL)
);
ALTER TABLE shares ADD COLUMN owner_user_id TEXT REFERENCES users(id);
ALTER TABLE requests ADD COLUMN owner_user_id TEXT REFERENCES users(id);
CREATE INDEX idx_shares_owner ON shares(owner_user_id, created_at);
CREATE INDEX idx_requests_owner ON requests(owner_user_id, created_at);

CREATE TABLE user_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  generation INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  reauth_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON user_sessions(user_id);
CREATE INDEX idx_sessions_expiry ON user_sessions(expires_at);
CREATE TABLE password_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE account_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT REFERENCES users(id),
  target_id TEXT REFERENCES users(id),
  action TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_account_audit_created ON account_audit(created_at);
CREATE TABLE auth_attempts (
  id INTEGER PRIMARY KEY,
  ip_key TEXT NOT NULL,
  account_key TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX idx_auth_attempts_ip ON auth_attempts(ip_key, at);
CREATE INDEX idx_auth_attempts_account ON auth_attempts(account_key, at);
CREATE INDEX idx_auth_attempts_at ON auth_attempts(at);

-- SQLite serializes writers: two concurrent demotions cannot remove both admins.
CREATE TRIGGER users_last_admin BEFORE UPDATE OF role, status ON users
WHEN OLD.role = 'admin' AND OLD.status = 'active'
 AND (NEW.role != 'admin' OR NEW.status != 'active')
 AND NOT EXISTS (SELECT 1 FROM users WHERE id != OLD.id AND role = 'admin' AND status = 'active')
BEGIN SELECT RAISE(ABORT, 'last_active_admin'); END;
CREATE TRIGGER users_no_delete BEFORE DELETE ON users
BEGIN SELECT RAISE(ABORT, 'accounts_cannot_be_deleted'); END;
-- Credential salt is permanent even when email/password changes.
CREATE TRIGGER users_salt_immutable BEFORE UPDATE OF password_salt ON users
WHEN NEW.password_salt IS NOT OLD.password_salt
BEGIN SELECT RAISE(ABORT, 'credential_salt_immutable'); END;
CREATE TRIGGER users_revoke_sensitive AFTER UPDATE OF email, role, status ON users
WHEN (NEW.email IS NOT OLD.email OR NEW.role IS NOT OLD.role OR NEW.status IS NOT OLD.status)
 AND NEW.password_hash IS OLD.password_hash
BEGIN
  DELETE FROM user_sessions WHERE user_id = NEW.id;
  DELETE FROM password_tokens WHERE user_id = NEW.id;
  UPDATE users SET session_generation = session_generation + 1 WHERE id = NEW.id;
END;
-- Deterministic verifier: even setting the SAME proof must consume the setup
-- token and revoke sessions. Do not predicate this trigger on hash inequality.
CREATE TRIGGER users_revoke_password AFTER UPDATE OF password_hash ON users
BEGIN
  DELETE FROM user_sessions WHERE user_id = NEW.id;
  DELETE FROM password_tokens WHERE user_id = NEW.id;
  UPDATE users SET session_generation = session_generation + 1 WHERE id = NEW.id;
END;
-- The marker is durable even if the bootstrap account is later disabled.
CREATE TRIGGER bootstrap_marker_immutable BEFORE UPDATE ON app_settings
WHEN OLD.key = 'bootstrap_admin_id'
BEGIN SELECT RAISE(ABORT, 'bootstrap_marker_immutable'); END;
CREATE TRIGGER bootstrap_marker_no_delete BEFORE DELETE ON app_settings
WHEN OLD.key = 'bootstrap_admin_id'
BEGIN SELECT RAISE(ABORT, 'bootstrap_marker_immutable'); END;
-- Defense in depth for legacy bearer writes, including callers that still omit
-- owner_user_id. Pre-bootstrap rows are backfilled by the login transaction.
CREATE TRIGGER shares_legacy_owner AFTER INSERT ON shares
WHEN NEW.owner_user_id IS NULL
BEGIN
  UPDATE shares SET owner_user_id = (SELECT value FROM app_settings WHERE key = 'bootstrap_admin_id') WHERE id = NEW.id;
END;
CREATE TRIGGER requests_legacy_owner AFTER INSERT ON requests
WHEN NEW.owner_user_id IS NULL
BEGIN
  UPDATE requests SET owner_user_id = (SELECT value FROM app_settings WHERE key = 'bootstrap_admin_id') WHERE id = NEW.id;
END;
