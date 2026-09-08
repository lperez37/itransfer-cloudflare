/** Session-authenticated share management (admin UI). */

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "../types";
import { requireSession } from "../lib/auth";
import { getFile, getShareFiles, toFileInfo } from "../lib/db";
import { getWorkspaceShare, requireWorkspace } from "../lib/workspace";
import { presignedGet } from "../lib/r2";
import { completeMultipartSchema, parseBody, shareInitSchema } from "../lib/schemas";
import { isoInDays } from "../lib/util";
import {
  buildDownloadUrls,
  completeFileMultipart,
  confirmShare,
  createShare,
  deactivateShare,
  listShares,
  purgeShare,
  serializeShare,
} from "../lib/services";

const updateSchema = z
  .object({
    expiry_days: z.number().positive().max(3650).optional(),
    is_paused: z.boolean().optional(),
  })
  .refine((v) => v.expiry_days !== undefined || v.is_paused !== undefined, {
    message: "Provide expiry_days or is_paused",
  });

/** Most recent download events for a share, newest first. */
const DOWNLOAD_LOG_LIMIT = 200;

interface DownloadLogRow {
  file_id: string;
  original_filename: string | null;
  downloaded_at: string;
  ip_address: string | null;
  user_agent: string | null;
}

export const shareRoutes = new Hono<AppEnv>()
  .use("*", requireSession)
  .use("*", requireWorkspace)
  .post("/init", async (c) => {
    const body = await parseBody(c.req, shareInitSchema);
    const owner = c.get("workspaceUser");
    const result = await createShare(c.env, body, owner.email, owner.id);
    return c.json(result);
  })
  .post("/:shareId/complete-multipart", async (c) => {
    const shareId = c.req.param("shareId");
    await getWorkspaceShare(c, shareId);
    const body = await parseBody(c.req, completeMultipartSchema);
    await completeFileMultipart(c.env, { shareId }, body);
    return c.json({ detail: "Multipart upload completed" });
  })
  .post("/:shareId/confirm", async (c) => {
    const share = await getWorkspaceShare(c, c.req.param("shareId"));
    if (!share) throw new HTTPException(404, { message: "Share not found" });
    await confirmShare(c.env, share);
    return c.json({ detail: "Share confirmed" });
  })
  .get("/", async (c) => {
    const rows = await listShares(c.env.DB, c.get("workspaceUser").id);
    return c.json(rows.map(serializeShare));
  })
  .get("/:shareId", async (c) => {
    const share = await getWorkspaceShare(c, c.req.param("shareId"));
    if (!share) throw new HTTPException(404, { message: "Share not found" });
    const files = await getShareFiles(c.env.DB, share.id);
    const { results: downloads } = await c.env.DB.prepare(
      `SELECT d.file_id, f.original_filename, d.downloaded_at, d.ip_address, d.user_agent
       FROM downloads d LEFT JOIN files f ON f.id = d.file_id
       WHERE d.share_id = ? ORDER BY d.downloaded_at DESC LIMIT ?`
    )
      .bind(share.id, DOWNLOAD_LOG_LIMIT)
      .all<DownloadLogRow>();
    return c.json({
      ...serializeShare({ ...share, file_count: files.length }),
      files: files.map(toFileInfo),
      downloads,
    });
  })
  .patch("/:shareId", async (c) => {
    // Update a live share: extend expiry (measured from now) and/or toggle
    // the paused flag (temporarily hidden from recipients, files kept).
    const share = await getWorkspaceShare(c, c.req.param("shareId"));
    if (!share) throw new HTTPException(404, { message: "Share not found" });
    if (!share.is_active) {
      throw new HTTPException(409, {
        message: "Share is deleted or expired and its storage was reclaimed - it cannot be updated",
      });
    }
    const body = await parseBody(c.req, updateSchema);

    const expiresAt = body.expiry_days !== undefined ? isoInDays(body.expiry_days) : null;
    const sets: string[] = [];
    const binds: (string | number)[] = [];
    if (expiresAt !== null) {
      sets.push("expires_at = ?");
      binds.push(expiresAt);
    }
    if (body.is_paused !== undefined) {
      sets.push("is_paused = ?");
      binds.push(body.is_paused ? 1 : 0);
    }
    binds.push(share.id, c.get("workspaceUser").id);
    await c.env.DB.prepare(`UPDATE shares SET ${sets.join(", ")} WHERE id = ? AND owner_user_id = ?`)
      .bind(...binds)
      .run();

    return c.json({
      detail: "Share updated",
      expires_at: expiresAt ?? share.expires_at,
      is_paused: body.is_paused ?? !!share.is_paused,
    });
  })
  .post("/:shareId/files/:fileId/download", async (c) => {
    // Admin: presigned URL for a single file of a share.
    const share = await getWorkspaceShare(c, c.req.param("shareId"));
    if (!share) throw new HTTPException(404, { message: "Share not found" });
    if (!share.is_active) {
      throw new HTTPException(410, { message: "Share is no longer available" });
    }
    const file = await getFile(c.env.DB, c.req.param("fileId"));
    if (!file || file.share_id !== share.id) {
      throw new HTTPException(404, { message: "File not found" });
    }
    const url = await presignedGet(c.env, file.r2_key, file.original_filename);
    return c.json({
      files: [{ filename: file.original_filename, size: file.file_size, download_url: url }],
    });
  })
  .delete("/:shareId", async (c) => {
    const share = await getWorkspaceShare(c, c.req.param("shareId"));
    if (!share) throw new HTTPException(404, { message: "Share not found" });
    await deactivateShare(c.env, share);
    return c.json({ detail: "Share deleted" });
  })
  .delete("/:shareId/purge", async (c) => {
    const share = await getWorkspaceShare(c, c.req.param("shareId"));
    if (!share) throw new HTTPException(404, { message: "Share not found" });
    await purgeShare(c.env, share);
    return c.json({ detail: "Share permanently deleted" });
  })
  .post("/:shareId/download", async (c) => {
    // Admin download: bypasses password, does not count as a public download.
    const share = await getWorkspaceShare(c, c.req.param("shareId"));
    if (!share) throw new HTTPException(404, { message: "Share not found" });
    // Deactivated shares have had their R2 objects purged, so presigned URLs
    // would 404 - reject up front rather than hand out dead links.
    if (!share.is_active) {
      throw new HTTPException(410, { message: "Share is no longer available" });
    }
    const files = await getShareFiles(c.env.DB, share.id);
    return c.json({ files: await buildDownloadUrls(c.env, files) });
  });
