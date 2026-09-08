/** Session workspace authorization. The authenticated actor is never replaced. */
import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv, RequestRow, ShareRow, UserRow } from "../types";
import { assertRecentAuth } from "./auth";
import { recordAudit } from "./accounts";

/** Only these POST routes are reads: they issue download capabilities, not uploads. */
function isWorkspaceRead(c: Context<AppEnv>): boolean {
  return c.req.method === "GET" || c.req.method === "HEAD" ||
    (c.req.method === "POST" &&
      /^\/api\/(?:shares\/[^/]+(?:\/files\/[^/]+)?|requests\/[^/]+)\/download\/?$/.test(c.req.path));
}

/** An allowlisted route label, independent of Hono's current middleware index. */
function auditRoute(path: string): string {
  if (/^\/api\/shares\/init\/?$/.test(path)) return "shares/init";
  const match = /^\/api\/(shares|requests)(?:\/([^/]+)(?:\/(complete-multipart|confirm|purge|download|files\/[^/]+\/download))?)?\/?$/.exec(path);
  if (!match) return "unknown";
  const suffix = match[3]?.startsWith("files/") ? "files/:fileId/download" : match[3];
  return [match[1], match[2] ? ":id" : undefined, suffix].filter(Boolean).join("/");
}

export const requireWorkspace: MiddlewareHandler<AppEnv> = async (c, next) => {
  const actor = c.get("user");
  const targetId = c.req.header("X-Workspace-User");
  const mode = c.req.header("X-Workspace-Mode");
  if ((targetId !== undefined && (!targetId.trim() || targetId.length > 128)) ||
      (mode !== undefined && mode !== "manage")) {
    throw new HTTPException(400, { message: "Invalid workspace headers" });
  }
  const crossWorkspace = targetId !== undefined && targetId !== actor.id;
  if (crossWorkspace && actor.role !== "admin") {
    throw new HTTPException(403, { message: "Workspace access forbidden" });
  }
  const owner = crossWorkspace
    ? await c.env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(targetId).first<UserRow>()
    : actor;
  if (!owner) throw new HTTPException(404, { message: "Workspace not found" });
  c.set("workspaceUser", owner);
  c.set("workspaceReadOnly", crossWorkspace && mode !== "manage");
  if (!crossWorkspace) return next();

  // Never persist paths, bodies, query strings, or signed URLs: public IDs and
  // capabilities can be secrets. Route templates are sufficient for this audit.
  const route = auditRoute(c.req.path);
  const detail = JSON.stringify({ method: c.req.method, route, mode: mode ?? "view" });
  try {
    if (!isWorkspaceRead(c) && mode !== "manage") {
      throw new HTTPException(403, { message: "Workspace is read-only" });
    }
    if (mode === "manage" && !isWorkspaceRead(c)) {
      await assertRecentAuth(c);
      if (c.get("user").role !== "admin") {
        throw new HTTPException(403, { message: "Administrator required" });
      }
    }
  } catch (error) {
    await recordAudit(c.env.DB, actor.id, owner.id, "workspace.denied", detail);
    throw error;
  }
  // Fail closed before handing out data/capabilities or performing a mutation.
  await recordAudit(c.env.DB, actor.id, owner.id, "workspace.access_attempt", detail);
  try {
    await next();
  } finally {
    // Hono usually renders route errors before next() returns. Also cover an
    // unhandled throw (no finalized response) without mislabelling it success.
    const status = c.finalized ? c.res.status : 500;
    try {
      await recordAudit(c.env.DB, actor.id, owner.id,
        status < 400 ? "workspace.access_succeeded" : "workspace.access_failed",
        JSON.stringify({ method: c.req.method, route, mode: mode ?? "view", status }));
    } catch {
      // An attempt is already durable. Never mask a completed mutation or
      // encourage a client to repeat it because the outcome audit failed.
      console.error(JSON.stringify({ event: "workspace.audit_outcome_failed" }));
    }
  }
};

export async function getWorkspaceShare(c: Context<AppEnv>, id: string): Promise<ShareRow> {
  const row = await c.env.DB.prepare("SELECT * FROM shares WHERE id = ? AND owner_user_id = ?")
    .bind(id, c.get("workspaceUser").id).first<ShareRow>();
  if (!row) throw new HTTPException(404, { message: "Share not found" });
  return row;
}

export async function getWorkspaceRequest(c: Context<AppEnv>, id: string): Promise<RequestRow> {
  const row = await c.env.DB.prepare("SELECT * FROM requests WHERE id = ? AND owner_user_id = ?")
    .bind(id, c.get("workspaceUser").id).first<RequestRow>();
  if (!row) throw new HTTPException(404, { message: "Request not found" });
  return row;
}
