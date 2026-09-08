/** Business logic shared between the session-authenticated admin routes and
 * the bearer-authenticated /api/v1 routes. */

import type { Context } from "hono";
import { scheduleOptionalEmail } from "./email-preferences";
import { HTTPException } from "hono/http-exception";
import type { z } from "zod";
import type { AppEnv, Env, FileRow, RequestRow, ShareRow } from "../types";
import { hashPassword } from "./crypto";
import { getShareFiles, getRequestFiles, getFile } from "./db";
import { insertWithUniqueId } from "./ids";
import {
  completeMultipartUpload,
  deleteObjects,
  getObjectSize,
  presignedGet,
} from "./r2";
import type { completeMultipartSchema, requestCreateSchema, shareInitSchema } from "./schemas";
import type { FileUploadResponse } from "./uploads";
import { prepareFileUploads } from "./uploads";
import { formatFileSize, isExpired, isoInDays, isoMinutesAgo, utcNow } from "./util";
import { requestMetaSuffix, sendNotification } from "./notify";
import { recordRequestDownloadUsage } from "./usage";

/** Fallback share lifetime when DEFAULT_EXPIRY_DAYS is unset or malformed. */
const DEFAULT_EXPIRY_DAYS = 365;

/** Fixed-window IP rate limit defaults for the public endpoints. */
const RATE_LIMIT_MAX = 60;
const RATE_LIMIT_WINDOW_MINUTES = 1;

// ── Rate limiting ─────────────────────────────────────────────────────────────

/**
 * Fixed-window IP rate limiter backed by the `rate_hits` table. Counts hits for
 * (bucket, ip) inside the trailing window and throws 429 once the limit is
 * exceeded; otherwise records the current hit. The client IP is read from the
 * Cloudflare-provided `CF-Connecting-IP` header (unspoofable at the edge).
 */
export async function enforceRateLimit(
  c: Context<AppEnv>,
  bucket: string,
  limit: number = RATE_LIMIT_MAX,
  windowMinutes: number = RATE_LIMIT_WINDOW_MINUTES
): Promise<void> {
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  const cutoff = isoMinutesAgo(windowMinutes);
  const row = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM rate_hits WHERE bucket = ? AND ip = ? AND at >= ?"
  )
    .bind(bucket, ip, cutoff)
    .first<{ n: number }>();
  if ((row?.n ?? 0) >= limit) {
    throw new HTTPException(429, { message: "Too many requests. Please slow down." });
  }
  await c.env.DB.prepare("INSERT INTO rate_hits (bucket, ip, at) VALUES (?, ?, ?)")
    .bind(bucket, ip, utcNow())
    .run();
}

// ── Accessibility checks ─────────────────────────────────────────────────────

// Nonexistent, inactive and expired shares/requests all yield an identical 404
// so the public endpoints do not become an existence oracle for enumerating
// valid ids. (The download-limit case stays a distinct 410 - an exhausted share
// is one the caller already knew existed.)

export function assertShareAccessible(share: ShareRow | null): ShareRow {
  if (!share || !share.is_active || share.is_paused || isExpired(share.expires_at)) {
    throw new HTTPException(404, { message: "Share not found" });
  }
  if (share.max_downloads !== null && share.download_count >= share.max_downloads) {
    throw new HTTPException(410, { message: "Download limit reached" });
  }
  return share;
}

export function assertRequestAccessible(req: RequestRow | null): RequestRow {
  if (!req || !req.is_active || isExpired(req.expires_at)) {
    throw new HTTPException(404, { message: "Request not found" });
  }
  return req;
}

// ── Shares ───────────────────────────────────────────────────────────────────

/** Parse DEFAULT_EXPIRY_DAYS, falling back to the default on any non-finite or
 * non-positive value (empty string, NaN, "abc", "0", "-5", …). */
function safeExpiryDays(raw: string | undefined): number {
  const days = Number(raw ?? DEFAULT_EXPIRY_DAYS);
  return Number.isFinite(days) && days > 0 ? days : DEFAULT_EXPIRY_DAYS;
}

export async function createShare(
  env: Env,
  body: z.infer<typeof shareInitSchema>,
  createdBy: string,
  ownerUserId?: string
): Promise<{ share_id: string; files: FileUploadResponse[] }> {
  const owner = await resolveCreationOwner(env.DB, createdBy, ownerUserId);
  const expiresAt = isoInDays(body.expiry_days ?? safeExpiryDays(env.DEFAULT_EXPIRY_DAYS));
  const passwordHash = body.password ? await hashPassword(body.password) : null;
  const totalSize = body.files.reduce((sum, f) => sum + f.size, 0);
  const createdAt = utcNow();

  // Register the public id and insert the share in one atomic batch so the
  // shared-namespace registry can never drift from the shares table.
  const shareId = await insertWithUniqueId(
    env.DB,
    "share",
    body.id_format,
    body.id_length,
    (id) => [
      env.DB.prepare(
        `INSERT INTO shares (id, title, id_format, created_at, expires_at, max_downloads,
           download_count, password_hash, is_active, total_size, created_by, owner_user_id)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, 0, ?, ?, ?)`
      ).bind(
        id,
        body.title ?? null,
        body.id_format,
        createdAt,
        expiresAt,
        body.max_downloads ?? null,
        passwordHash,
        totalSize,
        owner.email,
        owner.id
      ),
    ]
  );

  const files = await prepareFileUploads(env, "shares", shareId, body.files);
  return { share_id: shareId, files };
}

export async function completeFileMultipart(
  env: Env,
  parent: { shareId?: string; requestId?: string },
  body: z.infer<typeof completeMultipartSchema>
): Promise<void> {
  const file = await getFile(env.DB, body.file_id);
  const belongs =
    file &&
    ((parent.shareId && file.share_id === parent.shareId) ||
      (parent.requestId && file.request_id === parent.requestId));
  if (!belongs) throw new HTTPException(404, { message: "File not found" });
  await completeMultipartUpload(env, file.r2_key, body.upload_id, body.parts);
}

/** Verify every file landed in R2, persist actual sizes, and activate.
 * Idempotent: a share that is already confirmed is a no-op. Rejects shares
 * that are empty or already expired. */
export async function confirmShare(env: Env, share: ShareRow): Promise<number> {
  // Already confirmed → nothing to do (avoids re-activating a deactivated share
  // or double-processing a retried request).
  if (share.confirmed_at !== null) {
    return share.total_size;
  }
  if (isExpired(share.expires_at)) {
    throw new HTTPException(410, { message: "Share has expired" });
  }

  const files = await getShareFiles(env.DB, share.id);
  if (files.length === 0) {
    throw new HTTPException(400, { message: "Share has no files to confirm" });
  }

  let actualTotal = 0;
  const updates: D1PreparedStatement[] = [];
  for (const f of files) {
    const size = await getObjectSize(env, f.r2_key);
    if (size === null) {
      throw new HTTPException(400, {
        message: `File '${f.original_filename}' was not uploaded to storage`,
      });
    }
    actualTotal += size;
    updates.push(
      env.DB.prepare("UPDATE files SET file_size = ?, confirmed = 1 WHERE id = ?").bind(size, f.id)
    );
  }
  // WHERE confirmed_at IS NULL keeps activation atomic if two confirms race.
  updates.push(
    env.DB.prepare(
      "UPDATE shares SET total_size = ?, is_active = 1, confirmed_at = ? WHERE id = ? AND confirmed_at IS NULL"
    ).bind(actualTotal, utcNow(), share.id)
  );
  await env.DB.batch(updates);
  return actualTotal;
}

export interface ShareListRow extends ShareRow {
  file_count: number;
}

export async function listShares(db: D1Database, ownerUserId?: string): Promise<ShareListRow[]> {
  const query = db
    .prepare(
      `SELECT s.*, COUNT(f.id) AS file_count
       FROM shares s LEFT JOIN files f ON f.share_id = s.id
       ${ownerUserId !== undefined ? "WHERE s.owner_user_id = ?" : ""}
       GROUP BY s.id ORDER BY s.created_at DESC`
    );
  const { results } = await (ownerUserId !== undefined ? query.bind(ownerUserId) : query).all<ShareListRow>();
  return results;
}

export function serializeShare(row: ShareListRow) {
  return {
    id: row.id,
    title: row.title,
    id_format: row.id_format,
    created_at: row.created_at,
    expires_at: row.expires_at,
    max_downloads: row.max_downloads,
    download_count: row.download_count,
    is_active: !!row.is_active,
    is_paused: !!row.is_paused,
    file_count: row.file_count,
    total_size: row.total_size,
    confirmed_at: row.confirmed_at,
    deactivated_at: row.deactivated_at,
    created_by: row.created_by,
  };
}

/** Soft delete: remove R2 objects, keep the row with is_active = 0. */
export async function deactivateShare(env: Env, share: ShareRow): Promise<void> {
  const files = await getShareFiles(env.DB, share.id);
  await deleteObjects(env, files.map((f) => f.r2_key).filter(Boolean));
  await env.DB.prepare("UPDATE shares SET is_active = 0, deactivated_at = ? WHERE id = ?")
    .bind(utcNow(), share.id)
    .run();
}

/** Hard delete: remove R2 objects and all DB records (files/downloads cascade). */
export async function purgeShare(env: Env, share: ShareRow): Promise<void> {
  const files = await getShareFiles(env.DB, share.id);
  await deleteObjects(env, files.map((f) => f.r2_key).filter(Boolean));
  await env.DB.prepare("DELETE FROM shares WHERE id = ?").bind(share.id).run();
}

export async function buildDownloadUrls(
  env: Env,
  files: FileRow[]
): Promise<Array<{ filename: string; size: number | null; download_url: string }>> {
  const urls = await Promise.all(
    files.map(async (f) => ({
      filename: f.original_filename,
      size: f.file_size,
      download_url: await presignedGet(env, f.r2_key, f.original_filename),
    }))
  );
  await recordRequestDownloadUsage(env.DB, files);
  return urls;
}

/**
 * Atomically claim a download slot, then record the event (per-file rows +
 * notification). Returns `true` when a slot was claimed, `false` when the share
 * is inactive or its download limit is already reached.
 *
 * The claim is a single conditional UPDATE so concurrent downloaders can never
 * push `download_count` past `max_downloads` (the old check-then-increment was a
 * TOCTOU race). Callers MUST run this BEFORE issuing presigned URLs and return
 * 410 on `false`.
 */
export async function recordShareDownload(
  c: Context<AppEnv>,
  share: ShareRow,
  files: FileRow[],
  source: "web" | "api"
): Promise<boolean> {
  const env = c.env;

  const claim = await env.DB.prepare(
    `UPDATE shares SET download_count = download_count + 1
     WHERE id = ?1 AND is_active = 1
       AND (max_downloads IS NULL OR download_count < max_downloads)`
  )
    .bind(share.id)
    .run();
  if ((claim.meta?.changes ?? 0) !== 1) return false;

  scheduleOptionalEmail(c, { kind: "share_downloads", resourceId: share.id,
    eventId: crypto.randomUUID(), fileCount: files.length });

  const now = utcNow();
  const ip = c.req.header("CF-Connecting-IP") ?? null;
  const ua = (c.req.header("User-Agent") ?? "").slice(0, 512) || null;

  const stmts = files.map((f) =>
    env.DB.prepare(
      "INSERT INTO downloads (share_id, file_id, downloaded_at, ip_address, user_agent) VALUES (?, ?, ?, ?, ?)"
    ).bind(share.id, f.id, now, ip, ua)
  );
  if (stmts.length > 0) await env.DB.batch(stmts);

  const newCount = share.download_count + 1;
  let body =
    `Share: ${share.title || share.id}\n` +
    `Files: ${files.length} (${formatFileSize(share.total_size)})\n` +
    `Downloads: ${newCount}`;
  if (share.max_downloads) body += `/${share.max_downloads}`;
  body += source === "api" ? `${requestMetaSuffix(c, false)}\nSource: API` : requestMetaSuffix(c);
  sendNotification(c, "Download from iTransfer", body, "arrow_down");
  return true;
}

// ── Requests ─────────────────────────────────────────────────────────────────

/** Bearer callers inherit the immutable bootstrap admin, never an email match.
 * Before bootstrap their records remain unowned for the bootstrap backfill. */
async function resolveCreationOwner(db: D1Database, createdBy: string, ownerUserId?: string): Promise<{ id: string | null; email: string }> {
  let id: string | null = ownerUserId ?? null;
  if (ownerUserId === undefined) {
    const setting = await db.prepare("SELECT value FROM app_settings WHERE key = ?")
      .bind("bootstrap_admin_id").first<{ value: string }>();
    id = setting?.value ?? null;
  }
  if (id === null) return { id: null, email: createdBy };
  const owner = await db.prepare("SELECT id, email FROM users WHERE id = ?")
    .bind(id).first<{ id: string; email: string }>();
  if (!owner) throw new HTTPException(409, { message: "Workspace owner is unavailable" });
  return owner;
}

export async function createFileRequest(
  env: Env,
  body: z.infer<typeof requestCreateSchema>,
  createdBy: string,
  ownerUserId?: string
): Promise<string> {
  const owner = await resolveCreationOwner(env.DB, createdBy, ownerUserId);
  const expiresAt = body.expiry_days != null ? isoInDays(body.expiry_days) : null;
  const passwordHash = body.password ? await hashPassword(body.password) : null;
  const createdAt = utcNow();

  // Register the public id and insert the request in one atomic batch, sharing
  // the id namespace with shares via the public_ids PRIMARY KEY.
  const requestId = await insertWithUniqueId(
    env.DB,
    "request",
    body.id_format,
    body.id_length,
    (id) => [
      env.DB.prepare(
        `INSERT INTO requests (id, title, message, id_format, created_at, expires_at, max_uploads,
           max_file_size, upload_count, allow_incremental, password_hash, is_active, created_by, owner_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 1, ?, ?)`
      ).bind(
        id,
        body.title,
        body.message ?? null,
        body.id_format,
        createdAt,
        expiresAt,
        body.max_uploads ?? null,
        body.max_file_size ?? null,
        body.allow_incremental ? 1 : 0,
        passwordHash,
        owner.email,
        owner.id
      ),
    ]
  );

  return requestId;
}

export interface RequestListRow extends RequestRow {
  file_count: number;
}

export async function listRequests(db: D1Database, ownerUserId?: string): Promise<RequestListRow[]> {
  const query = db
    .prepare(
      `SELECT r.*, COUNT(f.id) AS file_count
       FROM requests r LEFT JOIN files f ON f.request_id = r.id
       ${ownerUserId !== undefined ? "WHERE r.owner_user_id = ?" : ""}
       GROUP BY r.id ORDER BY r.created_at DESC`
    );
  const { results } = await (ownerUserId !== undefined ? query.bind(ownerUserId) : query).all<RequestListRow>();
  return results;
}

export function serializeRequest(row: RequestListRow) {
  return {
    id: row.id,
    title: row.title,
    message: row.message,
    id_format: row.id_format,
    created_at: row.created_at,
    expires_at: row.expires_at,
    max_uploads: row.max_uploads,
    upload_count: row.upload_count,
    allow_incremental: !!row.allow_incremental,
    is_active: !!row.is_active,
    file_count: row.file_count,
    deactivated_at: row.deactivated_at,
    created_by: row.created_by,
  };
}

export async function deactivateRequest(env: Env, req: RequestRow): Promise<void> {
  const files = await getRequestFiles(env.DB, req.id);
  await deleteObjects(env, files.map((f) => f.r2_key).filter(Boolean));
  await env.DB.prepare("UPDATE requests SET is_active = 0, deactivated_at = ? WHERE id = ?")
    .bind(utcNow(), req.id)
    .run();
}

export async function purgeRequest(env: Env, req: RequestRow): Promise<void> {
  const files = await getRequestFiles(env.DB, req.id);
  await deleteObjects(env, files.map((f) => f.r2_key).filter(Boolean));
  await env.DB.prepare("DELETE FROM requests WHERE id = ?").bind(req.id).run();
}
