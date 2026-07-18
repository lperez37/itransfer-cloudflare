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
  SESSION_SECRET: string;
  ADMIN_EMAIL: string;
  ADMIN_PASSWORD: string;
  API_BEARER_TOKEN?: string;
  NTFY_URL?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_ACCOUNT_ID?: string;
}

/** Hono context variables set by auth middleware. */
export interface Variables {
  userEmail: string;
}

export type AppEnv = { Bindings: Env; Variables: Variables };

// ── D1 row shapes ────────────────────────────────────────────────────────────

export interface ShareRow {
  id: string;
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

// A short default keeps a leaked/forgotten cookie from staying valid for
// months; operators can extend it via SESSION_MAX_AGE_DAYS if desired.
const DEFAULT_SESSION_MAX_AGE_DAYS = 7;

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
}
