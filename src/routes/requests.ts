/** Session-authenticated file-request management (admin UI). */

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "../types";
import { requireSession } from "../lib/auth";
import { getRequestFiles, toFileInfo } from "../lib/db";
import { getWorkspaceRequest, requireWorkspace } from "../lib/workspace";
import { parseBody, requestCreateSchema } from "../lib/schemas";
import { isoInDays } from "../lib/util";

const extendSchema = z.object({ expiry_days: z.number().positive().max(3650) });
import {
  buildDownloadUrls,
  createFileRequest,
  deactivateRequest,
  listRequests,
  purgeRequest,
  serializeRequest,
} from "../lib/services";

export const requestRoutes = new Hono<AppEnv>()
  .use("*", requireSession)
  .use("*", requireWorkspace)
  .post("/", async (c) => {
    const body = await parseBody(c.req, requestCreateSchema);
    const owner = c.get("workspaceUser");
    const requestId = await createFileRequest(c.env, body, owner.email, owner.id);
    return c.json({ request_id: requestId });
  })
  .get("/", async (c) => {
    const rows = await listRequests(c.env.DB, c.get("workspaceUser").id);
    return c.json(rows.map(serializeRequest));
  })
  .patch("/:requestId", async (c) => {
    // Extend (or shorten) the expiry of a live request, measured from now.
    const req = await getWorkspaceRequest(c, c.req.param("requestId"));
    if (!req) throw new HTTPException(404, { message: "Request not found" });
    if (!req.is_active) {
      throw new HTTPException(409, {
        message: "Request is deleted or expired and its storage was reclaimed - it cannot be extended",
      });
    }
    const body = await parseBody(c.req, extendSchema);
    const expiresAt = isoInDays(body.expiry_days);
    await c.env.DB.prepare("UPDATE requests SET expires_at = ? WHERE id = ? AND owner_user_id = ?")
      .bind(expiresAt, req.id, c.get("workspaceUser").id)
      .run();
    return c.json({ detail: "Expiry updated", expires_at: expiresAt });
  })
  .get("/:requestId", async (c) => {
    const req = await getWorkspaceRequest(c, c.req.param("requestId"));
    if (!req) throw new HTTPException(404, { message: "Request not found" });
    const files = await getRequestFiles(c.env.DB, req.id);
    return c.json({
      id: req.id,
      title: req.title,
      message: req.message,
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
  .delete("/:requestId", async (c) => {
    const req = await getWorkspaceRequest(c, c.req.param("requestId"));
    if (!req) throw new HTTPException(404, { message: "Request not found" });
    await deactivateRequest(c.env, req);
    return c.json({ detail: "Request deleted" });
  })
  .delete("/:requestId/purge", async (c) => {
    const req = await getWorkspaceRequest(c, c.req.param("requestId"));
    if (!req) throw new HTTPException(404, { message: "Request not found" });
    await purgeRequest(c.env, req);
    return c.json({ detail: "Request permanently deleted" });
  })
  .post("/:requestId/download", async (c) => {
    const req = await getWorkspaceRequest(c, c.req.param("requestId"));
    if (!req) throw new HTTPException(404, { message: "Request not found" });
    // Deactivated requests have had their uploaded R2 objects purged, so
    // presigned URLs would 404 - reject rather than return dead links.
    if (!req.is_active) {
      throw new HTTPException(410, { message: "Request is no longer available" });
    }
    const files = await getRequestFiles(c.env.DB, req.id);
    return c.json({ files: await buildDownloadUrls(c.env, files) });
  });
