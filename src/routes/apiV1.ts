/** Bearer-token API for programmatic/agent access (mirrors the admin routes,
 * plus share/request URLs in responses). */

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "../types";
import { isoInDays } from "../lib/util";
import { requireBearer } from "../lib/auth";
import { getRequest, getRequestFiles, getShare, getShareFiles, toFileInfo } from "../lib/db";
import { estimateCost } from "../lib/cost";
import {
  completeMultipartSchema,
  parseBody,
  requestCreateSchema,
  shareInitSchema,
} from "../lib/schemas";
import {
  assertRequestAccessible,
  assertShareAccessible,
  buildDownloadUrls,
  completeFileMultipart,
  confirmShare,
  createFileRequest,
  createShare,
  deactivateRequest,
  deactivateShare,
  listRequests,
  listShares,
  purgeRequest,
  purgeShare,
  recordShareDownload,
  serializeRequest,
  serializeShare,
} from "../lib/services";

function publicUrl(origin: string, id: string): string {
  return `${origin}/${id}`;
}

const shareUpdateSchema = z
  .object({
    expiry_days: z.number().positive().max(3650).optional(),
    is_paused: z.boolean().optional(),
  })
  .refine((v) => v.expiry_days !== undefined || v.is_paused !== undefined, {
    message: "Provide expiry_days or is_paused",
  });

const requestUpdateSchema = z.object({ expiry_days: z.number().positive().max(3650) });

export const apiV1Routes = new Hono<AppEnv>()
  .use("*", requireBearer)

  // ── Shares ─────────────────────────────────────────────────────────────────

  .post("/shares", async (c) => {
    const body = await parseBody(c.req, shareInitSchema);
    const result = await createShare(c.env, body, c.get("userEmail"));
    return c.json(
      {
        share_id: result.share_id,
        share_url: publicUrl(c.env.PUBLIC_ORIGIN, result.share_id),
        files: result.files,
      },
      201
    );
  })
  .post("/shares/:shareId/complete-multipart", async (c) => {
    const shareId = c.req.param("shareId");
    if (!(await getShare(c.env.DB, shareId))) {
      throw new HTTPException(404, { message: "Share not found" });
    }
    const body = await parseBody(c.req, completeMultipartSchema);
    await completeFileMultipart(c.env, { shareId }, body);
    return c.json({ detail: "Multipart upload completed" });
  })
  .post("/shares/:shareId/confirm", async (c) => {
    const share = await getShare(c.env.DB, c.req.param("shareId"));
    if (!share) throw new HTTPException(404, { message: "Share not found" });
    await confirmShare(c.env, share);
    return c.json({
      share_id: share.id,
      share_url: publicUrl(c.env.PUBLIC_ORIGIN, share.id),
      status: "active",
    });
  })
  .get("/shares", async (c) => {
    const rows = await listShares(c.env.DB);
    return c.json(
      rows.map((row) => ({
        ...serializeShare(row),
        share_url: publicUrl(c.env.PUBLIC_ORIGIN, row.id),
      }))
    );
  })
  .get("/shares/:shareId", async (c) => {
    const share = await getShare(c.env.DB, c.req.param("shareId"));
    if (!share) throw new HTTPException(404, { message: "Share not found" });
    const files = await getShareFiles(c.env.DB, share.id);
    return c.json({
      id: share.id,
      title: share.title,
      share_url: publicUrl(c.env.PUBLIC_ORIGIN, share.id),
      id_format: share.id_format,
      created_at: share.created_at,
      expires_at: share.expires_at,
      max_downloads: share.max_downloads,
      download_count: share.download_count,
      is_active: !!share.is_active,
      total_size: share.total_size,
      files: files.map(toFileInfo),
    });
  })
  .patch("/shares/:shareId", async (c) => {
    // Update a live share: extend expiry (from now) and/or toggle is_paused.
    const share = await getShare(c.env.DB, c.req.param("shareId"));
    if (!share) throw new HTTPException(404, { message: "Share not found" });
    if (!share.is_active) {
      throw new HTTPException(409, {
        message: "Share is deleted or expired and its storage was reclaimed - it cannot be updated",
      });
    }
    const body = await parseBody(c.req, shareUpdateSchema);
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
    binds.push(share.id);
    await c.env.DB.prepare(`UPDATE shares SET ${sets.join(", ")} WHERE id = ?`)
      .bind(...binds)
      .run();
    return c.json({
      detail: "Share updated",
      share_url: publicUrl(c.env.PUBLIC_ORIGIN, share.id),
      expires_at: expiresAt ?? share.expires_at,
      is_paused: body.is_paused ?? !!share.is_paused,
    });
  })
  .delete("/shares/:shareId", async (c) => {
    const share = await getShare(c.env.DB, c.req.param("shareId"));
    if (!share) throw new HTTPException(404, { message: "Share not found" });
    await deactivateShare(c.env, share);
    return c.json({ detail: "Share deleted" });
  })
  .delete("/shares/:shareId/purge", async (c) => {
    const share = await getShare(c.env.DB, c.req.param("shareId"));
    if (!share) throw new HTTPException(404, { message: "Share not found" });
    await purgeShare(c.env, share);
    return c.json({ detail: "Share permanently deleted" });
  })
  .post("/shares/:shareId/download", async (c) => {
    // Bearer access is trusted: password verification is skipped, but the
    // download still counts and notifies like a public one.
    const share = assertShareAccessible(await getShare(c.env.DB, c.req.param("shareId")));
    const files = await getShareFiles(c.env.DB, share.id);
    const urls = await buildDownloadUrls(c.env, files);
    await recordShareDownload(c, share, files, "api");
    return c.json({ files: urls });
  })

  // ── Requests ───────────────────────────────────────────────────────────────

  .post("/requests", async (c) => {
    const body = await parseBody(c.req, requestCreateSchema);
    const requestId = await createFileRequest(c.env, body, c.get("userEmail"));
    return c.json(
      { request_id: requestId, request_url: publicUrl(c.env.PUBLIC_ORIGIN, requestId) },
      201
    );
  })
  .get("/requests", async (c) => {
    const rows = await listRequests(c.env.DB);
    return c.json(
      rows.map((row) => ({
        ...serializeRequest(row),
        request_url: publicUrl(c.env.PUBLIC_ORIGIN, row.id),
      }))
    );
  })
  .get("/requests/:requestId", async (c) => {
    const req = await getRequest(c.env.DB, c.req.param("requestId"));
    if (!req) throw new HTTPException(404, { message: "Request not found" });
    const files = await getRequestFiles(c.env.DB, req.id);
    return c.json({
      id: req.id,
      title: req.title,
      message: req.message,
      request_url: publicUrl(c.env.PUBLIC_ORIGIN, req.id),
      id_format: req.id_format,
      created_at: req.created_at,
      expires_at: req.expires_at,
      max_uploads: req.max_uploads,
      max_file_size: req.max_file_size,
      upload_count: req.upload_count,
      allow_incremental: !!req.allow_incremental,
      is_active: !!req.is_active,
      files: files.map(toFileInfo),
    });
  })
  .patch("/requests/:requestId", async (c) => {
    // Extend (or shorten) the expiry of a live request, measured from now.
    const req = await getRequest(c.env.DB, c.req.param("requestId"));
    if (!req) throw new HTTPException(404, { message: "Request not found" });
    if (!req.is_active) {
      throw new HTTPException(409, {
        message: "Request is deleted or expired and its storage was reclaimed - it cannot be updated",
      });
    }
    const body = await parseBody(c.req, requestUpdateSchema);
    const expiresAt = isoInDays(body.expiry_days);
    await c.env.DB.prepare("UPDATE requests SET expires_at = ? WHERE id = ?")
      .bind(expiresAt, req.id)
      .run();
    return c.json({
      detail: "Expiry updated",
      request_url: publicUrl(c.env.PUBLIC_ORIGIN, req.id),
      expires_at: expiresAt,
    });
  })
  .delete("/requests/:requestId", async (c) => {
    const req = await getRequest(c.env.DB, c.req.param("requestId"));
    if (!req) throw new HTTPException(404, { message: "Request not found" });
    await deactivateRequest(c.env, req);
    return c.json({ detail: "Request deleted" });
  })
  .delete("/requests/:requestId/purge", async (c) => {
    const req = await getRequest(c.env.DB, c.req.param("requestId"));
    if (!req) throw new HTTPException(404, { message: "Request not found" });
    await purgeRequest(c.env, req);
    return c.json({ detail: "Request permanently deleted" });
  })
  .post("/requests/:requestId/download", async (c) => {
    const req = assertRequestAccessible(await getRequest(c.env.DB, c.req.param("requestId")));
    const files = await getRequestFiles(c.env.DB, req.id);
    return c.json({ files: await buildDownloadUrls(c.env, files) });
  })

  // ── Cost ───────────────────────────────────────────────────────────────────

  .get("/cost", async (c) => c.json(await estimateCost(c.env.DB)));
