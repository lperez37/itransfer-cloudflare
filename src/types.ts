/** Worker bindings and configuration. Secrets are set via `wrangler secret put`. */
export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  ASSETS: Fetcher;

  // Vars (wrangler.jsonc)
  PUBLIC_ORIGIN: string;
  R2_BUCKET_NAME: string;
  DEFAULT_EXPIRY_DAYS?: string;
  SESSION_MAX_AGE_DAYS?: string;
  HISTORY_RETENTION_DAYS?: string;

  // Secrets
  // High-entropy credential root, minimum 32 characters. Rotation invalidates
  // account password verifiers and requires explicit password resets.
  SESSION_SECRET: string;
  ADMIN_EMAIL: string;
  ADMIN_PASSWORD: string;
  API_BEARER_TOKEN?: string;
  NTFY_URL?: string;
  TRANSACTIONAL_MAIL_API_URL?: string;
  TRANSACTIONAL_MAIL_API_KEY?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_ACCOUNT_ID?: string;
}

/** Hono context variables set by auth middleware. */
export interface Variables {
  userEmail: string;
  user: UserRow;
  userId: string | null;
  workspaceUser: UserRow;
  workspaceReadOnly: boolean;
  sessionId: string;
  sessionReauthAt: number;
}

export type AppEnv = { Bindings: Env; Variables: Variables };

// ── D1 row shapes ────────────────────────────────────────────────────────────

export interface UserRow {
  id: string;
  email: string;
  name: string;
  role: "admin" | "user";
  status: "pending" | "active" | "disabled";
  password_hash: string | null;
  password_salt: string;
  password_change_required: number;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
  session_generation: number;
}

export interface ShareRow {
  id: string;
  owner_user_id: string | null;
  title: string | null;
  id_format: string;
  created_at: string;
  expires_at: string | null;
  max_downloads: number | null;
  download_count: number;
  password_hash: string | null;
  is_active: number;
  is_paused: number;
  total_size: number;
  confirmed_at: string | null;
  deactivated_at: string | null;
  created_by: string | null;
}

export interface RequestRow {
  id: string;
  owner_user_id: string | null;
  title: string;
  message: string | null;
  id_format: string;
  created_at: string;
  expires_at: string | null;
  max_uploads: number | null;
  max_file_size: number | null;
  upload_count: number;
  allow_incremental: number;
  password_hash: string | null;
  is_active: number;
  deactivated_at: string | null;
  created_by: string | null;
}

export interface FileRow {
  id: string;
  original_filename: string;
  r2_key: string;
  file_size: number | null;
  content_type: string | null;
  share_id: string | null;
  request_id: string | null;
  confirmed: number;
  created_at: string;
}

// ── Upload constants (must stay in sync with frontend PART_SIZE) ────────────

/** Files larger than this use multipart upload. */
export const MULTIPART_THRESHOLD = 100 * 1024 * 1024;
/** Multipart part size - mirrored in frontend/src/hooks/useUpload.ts. */
export const MULTIPART_PART_SIZE = 50 * 1024 * 1024;

export const UPLOAD_URL_EXPIRY = 3600;
export const DOWNLOAD_URL_EXPIRY = 900;
export const SESSION_COOKIE = "itransfer_session";

/** app_settings key holding the session-revocation epoch (unix seconds).
 * Tokens issued before this value are rejected - see lib/crypto.ts. */
export const SESSION_EPOCH_KEY = "session_epoch";

// Owner-approved lifetime; DB revocation is checked on every request.
const DEFAULT_SESSION_MAX_AGE_DAYS = 90;

/** Session lifetime in seconds, configurable via SESSION_MAX_AGE_DAYS. */
export function sessionMaxAge(env: Pick<Env, "SESSION_MAX_AGE_DAYS">): number {
  const days = Number(env.SESSION_MAX_AGE_DAYS ?? DEFAULT_SESSION_MAX_AGE_DAYS);
  const safeDays = Number.isFinite(days) && days > 0 ? days : DEFAULT_SESSION_MAX_AGE_DAYS;
  return Math.round(safeDays * 24 * 3600);
}

/** Placeholder admin password shipped in examples; refused at runtime. */
export const INSECURE_DEFAULT_PASSWORD = "change-me";

/** Fail fast if required secrets are missing (or left at an unsafe default),
 * so misconfiguration surfaces as a clear 500 instead of silent auth bypass
 * or opaque downstream errors. Called at the top of fetch and scheduled. */
export function assertEnv(env: Env): void {
  const missing = (["SESSION_SECRET", "ADMIN_EMAIL", "ADMIN_PASSWORD"] as const).filter(
    (k) => !env[k]
  );
  if (missing.length > 0) {
    throw new Error(`Missing required secrets: ${missing.join(", ")}. Set them via 'wrangler secret put'.`);
  }
  if (env.ADMIN_PASSWORD === INSECURE_DEFAULT_PASSWORD) {
    throw new Error("ADMIN_PASSWORD is set to the insecure default 'change-me'. Set a real password.");
  }
  if (env.SESSION_SECRET.length < 32) {
    throw new Error("SESSION_SECRET must contain at least 32 characters of high-entropy random material. Rotation requires account password resets.");
  }
}
export interface EmailPreferences {
  share_downloads: boolean;
  request_uploads: boolean;
  password_changed: boolean;
  expiry_alerts: boolean;
  invitation_reminders: boolean;
  welcome: true;
  password_reset: true;
}
