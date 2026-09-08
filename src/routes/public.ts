/** Public, unauthenticated endpoints: share downloads and request uploads. */

import { Hono } from "hono";
import { scheduleOptionalEmail } from "../lib/email-preferences";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv, FileRow } from "../types";
import { verifyPassword } from "../lib/crypto";
import {
  countRecentAttempts,
  getRequest,
  getRequestFiles,
  getShare,
  getShareFiles,
  recordAttempt,
  toFileInfo,
} from "../lib/db";
import { deleteObjects, getObjectSize } from "../lib/r2";
import {
  completeMultipartSchema,
  parseBody,
  requestConfirmSchema,
  requestUploadSchema,
  shareDownloadSchema,
  shareUnlockSchema,
} from "../lib/schemas";
import {
  assertRequestAccessible,
  assertShareAccessible,
  buildDownloadUrls,
  completeFileMultipart,
  enforceRateLimit,
  recordShareDownload,
} from "../lib/services";
import { prepareFileUploads } from "../lib/uploads";
import { requestMetaSuffix, sendNotification } from "../lib/notify";
import { formatFileSize, isoMinutesAgo, utcNow } from "../lib/util";

const LOCKOUT_ATTEMPTS = 3;
const LOCKOUT_WINDOW_MINUTES = 15;

/** Brute-force lockout + password verification. Throws 429/401 on failure. */
async function verifyPasswordWithLockout(
  c: Context<AppEnv>,
  target: { shareId?: string; requestId?: string },
  passwordHash: string,
  password: string | null | undefined
): Promise<void> {
  if (!password) {
    throw new HTTPException(401, { message: "Password required" });
  }
  const cutoff = isoMinutesAgo(LOCKOUT_WINDOW_MINUTES);
  const recent = await countRecentAttempts(c.env.DB, target, cutoff);
  if (recent >= LOCKOUT_ATTEMPTS) {
    throw new HTTPException(429, {
      message: "Too many failed attempts. Try again in 15 minutes.",
    });
  }
  if (!(await verifyPassword(password, passwordHash))) {
    await recordAttempt(c.env.DB, target, utcNow());
    throw new HTTPException(401, { message: "Invalid password" });
  }
}

export const publicRoutes = new Hono<AppEnv>()

  // ── Shares ─────────────────────────────────────────────────────────────────

  .get("/shares/:shareId", async (c) => {
    await enforceRateLimit(c, "public-meta");
    const share = assertShareAccessible(await getShare(c.env.DB, c.req.param("shareId")));
    const files = await getShareFiles(c.env.DB, share.id);

    const downloadsRemaining =
      share.max_downloads !== null
        ? Math.max(0, share.max_downloads - share.download_count)
        : null;

    return c.json({
      id: share.id,
      title: share.title,
      expires_at: share.expires_at,
      password_required: share.password_hash !== null,
      downloads_remaining: downloadsRemaining,
      // File names stay hidden until the password is verified.
      files: share.password_hash !== null ? [] : files.map(toFileInfo),
      file_count: files.length,
    });
  })

  .post("/shares/:shareId/unlock", async (c) => {
    const share = assertShareAccessible(await getShare(c.env.DB, c.req.param("shareId")));
    if (share.password_hash === null) {
      throw new HTTPException(400, { message: "Share is not password protected" });
    }
    const body = await parseBody(c.req, shareUnlockSchema);
    await verifyPasswordWithLockout(c, { shareId: share.id }, share.password_hash, body.password);
    const files = await getShareFiles(c.env.DB, share.id);
    return c.json({ files: files.map(toFileInfo) });
  })

  .post("/shares/:shareId/download", async (c) => {
    await enforceRateLimit(c, "public-download");
    const share = assertShareAccessible(await getShare(c.env.DB, c.req.param("shareId")));
    const body = await parseBody(c.req, shareDownloadSchema);

    if (share.password_hash !== null) {
      await verifyPasswordWithLockout(c, { shareId: share.id }, share.password_hash, body.password);
    }

    const files = await getShareFiles(c.env.DB, share.id);
    // Atomically claim a download slot BEFORE handing out presigned URLs so a
    // burst of concurrent requests can never exceed max_downloads.
    const claimed = await recordShareDownload(c, share, files, "web");
    if (!claimed) {
      throw new HTTPException(410, { message: "Download limit reached" });
    }
    const urls = await buildDownloadUrls(c.env, files);
    return c.json({ files: urls });
  })

  // ── Requests ───────────────────────────────────────────────────────────────

  .get("/requests/:requestId", async (c) => {
    await enforceRateLimit(c, "public-meta");
    const req = assertRequestAccessible(await getRequest(c.env.DB, c.req.param("requestId")));

    const remainingUploads =
      req.max_uploads !== null ? Math.max(0, req.max_uploads - req.upload_count) : null;

    const files = req.allow_incremental ? await getRequestFiles(c.env.DB, req.id) : [];

    return c.json({
      id: req.id,
      title: req.title,
      message: req.message,
      expires_at: req.expires_at,
      remaining_uploads: remainingUploads,
      max_file_size: req.max_file_size,
      allow_incremental: !!req.allow_incremental,
      password_required: req.password_hash !== null,
      files: files.map(toFileInfo),
    });
  })

  .post("/requests/:requestId/upload", async (c) => {
    await enforceRateLimit(c, "public-upload");
    const req = assertRequestAccessible(await getRequest(c.env.DB, c.req.param("requestId")));
    const body = await parseBody(c.req, requestUploadSchema);

    if (req.password_hash !== null) {
      await verifyPasswordWithLockout(c, { requestId: req.id }, req.password_hash, body.password);
    }

    if (!req.allow_incremental && req.upload_count >= 1) {
      throw new HTTPException(410, { message: "Upload limit reached" });
    }
    if (req.allow_incremental && req.max_uploads !== null && req.upload_count >= req.max_uploads) {
      throw new HTTPException(410, { message: "Upload limit reached" });
    }

    if (req.max_file_size !== null) {
      for (const f of body.files) {
        if (f.size > req.max_file_size) {
          throw new HTTPException(400, {
            message: `File '${f.filename}' exceeds maximum size of ${formatFileSize(req.max_file_size)}`,
          });
        }
      }
    }

    const files = await prepareFileUploads(c.env, "requests", req.id, body.files);
    return c.json({ files });
  })

  .post("/requests/:requestId/complete-multipart", async (c) => {
    const requestId = c.req.param("requestId");
    assertRequestAccessible(await getRequest(c.env.DB, requestId));
    const body = await parseBody(c.req, completeMultipartSchema);
    await completeFileMultipart(c.env, { requestId }, body);
    return c.json({ detail: "Multipart upload completed" });
  })

  .post("/requests/:requestId/confirm", async (c) => {
    const req = assertRequestAccessible(await getRequest(c.env.DB, c.req.param("requestId")));
    const body = await parseBody(c.req, requestConfirmSchema);

    const allFiles = await getRequestFiles(c.env.DB, req.id);
    const byId = new Map(allFiles.map((f) => [f.id, f]));
    const confirmed = [...new Set(body.file_ids)].map((id) => byId.get(id));
    // Reject any file_id that does not belong to this request (ownership check).
    if (confirmed.some((f) => f === undefined)) {
      throw new HTTPException(400, { message: "One or more file IDs are invalid" });
    }
    const targetFiles = confirmed as FileRow[];

    // Verify each file landed in R2, enforce size limits against the REAL object
    // size. One JSON payload keeps the batch below D1's bound-variable limit
    // without a database statement per file.
    const fileUpdates: { id: string; size: number }[] = [];
    for (const f of targetFiles) {
      const size = await getObjectSize(c.env, f.r2_key);
      if (size === null) {
        throw new HTTPException(400, {
          message: `File '${f.original_filename}' was not uploaded to storage`,
        });
      }
      // The presigned PUT cannot be fully trusted for size, so re-check the
      // actual object here; purge oversized/mismatched objects before rejecting.
      if (req.max_file_size !== null && size > req.max_file_size) {
        await deleteObjects(c.env, [f.r2_key]);
        throw new HTTPException(400, {
          message: `File '${f.original_filename}' exceeds maximum size of ${formatFileSize(req.max_file_size)}`,
        });
      }
      if (f.file_size !== null && size > f.file_size) {
        await deleteObjects(c.env, [f.r2_key]);
        throw new HTTPException(400, {
          message: `File '${f.original_filename}' is larger than its declared size`,
        });
      }
      fileUpdates.push({ id: f.id, size });
    }

    // D1 batches are transactional and serialized. Claim only if at least one
    // owned target still needs confirmation, rechecking live admission limits.
    // Keep these statements adjacent: SQLite changes() sees the preceding
    // UPDATE's direct row count (trigger writes are saved/restored), not D1's
    // trigger-inclusive meta.changes. A denied claim therefore flips NO files.
    const payload = JSON.stringify(fileUpdates);
    const results = await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE requests SET upload_count = upload_count + 1
         WHERE id = ?1 AND is_active = 1
           AND (expires_at IS NULL OR expires_at > ?3)
           AND ((allow_incremental = 0 AND upload_count < 1)
             OR (allow_incremental = 1 AND (max_uploads IS NULL OR upload_count < max_uploads)))
           AND EXISTS (SELECT 1 FROM files WHERE request_id = ?1 AND confirmed = 0
             AND id IN (SELECT json_extract(value, '$.id') FROM json_each(?2)))
         RETURNING id, upload_count`
      ).bind(req.id, payload, utcNow()),
      c.env.DB.prepare(
        `UPDATE files SET confirmed = 1,
           file_size = (SELECT json_extract(value, '$.size') FROM json_each(?2)
             WHERE json_extract(value, '$.id') = files.id)
         WHERE changes() = 1 AND request_id = ?1 AND confirmed = 0
           AND id IN (SELECT json_extract(value, '$.id') FROM json_each(?2))
         RETURNING id, file_size`
      ).bind(req.id, payload),
    ]);
    const claimed = results[0]!.results[0] as { id: string; upload_count: number } | undefined;
    if (!claimed) {
      // Distinguish a concurrent/repeated accepted batch from rejected new work.
      const pending = await c.env.DB.prepare(
        `SELECT 1 FROM files WHERE request_id = ?1 AND confirmed = 0
         AND id IN (SELECT json_extract(value, '$.id') FROM json_each(?2)) LIMIT 1`
      ).bind(req.id, payload).first();
      if (pending) {
        throw new HTTPException(410, { message: "Upload limit reached" });
      }
      return c.json({ detail: "Upload already confirmed" });
    }

    // RETURNING excludes cost-trigger writes and already-confirmed targets.
    const flipped = results[1]!.results as { id: string; file_size: number }[];
    const flippedIds = flipped.map((f) => f.id).sort();
    const totalSize = flipped.reduce((sum, f) => sum + f.file_size, 0);
    scheduleOptionalEmail(c, { kind: "request_uploads", resourceId: req.id,
      eventId: JSON.stringify(flippedIds), fileCount: flippedIds.length });

    const newCount = claimed.upload_count;
    let notification =
      `Request: ${req.title}\n` +
      `Files: ${flippedIds.length} (${formatFileSize(totalSize)})\n` +
      `Uploads: ${newCount}`;
    if (req.max_uploads) notification += `/${req.max_uploads}`;
    if (body.message) notification += `\nMessage: ${body.message}`;
    notification += requestMetaSuffix(c);

    const isIncremental = newCount > 1;
    sendNotification(
      c,
      isIncremental ? "New upload to iTransfer" : "Upload to iTransfer",
      notification,
      isIncremental ? "arrows_counterclockwise" : "arrow_up"
    );

    return c.json({ detail: "Upload confirmed" });
  });
