/** Opaque, DB-authoritative sessions. Old signed cookies are intentionally invalid. */
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { getCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import type { AppEnv, UserRow } from "../types";
import { SESSION_COOKIE } from "../types";
import { timingSafeEqualStr } from "./crypto";
import { nowSeconds, tokenHash } from "./accounts";

export function assertSameOrigin(c: Context<AppEnv>): void {
  if (["GET", "HEAD", "OPTIONS"].includes(c.req.method)) return;
  if (c.req.header("Origin") !== new URL(c.req.url).origin) {
    throw new HTTPException(403, { message: "Same-origin request required" });
  }
}
export const csrfProtection = createMiddleware<AppEnv>(async (c, next) => {
  assertSameOrigin(c);
  await next();
});
export const requireSameOrigin = csrfProtection;

async function loadSession(c: Context<AppEnv>): Promise<UserRow | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const hash = await tokenHash(token);
  const row = await c.env.DB.prepare(`SELECT u.*, s.reauth_at FROM user_sessions s
    JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?
    AND u.status='active' AND s.generation=u.session_generation`)
    .bind(hash, nowSeconds()).first<UserRow & { reauth_at: number }>();
  if (!row) return null;
  const expectedUser = c.req.header("X-Expected-User");
  if (expectedUser !== undefined && expectedUser !== row.id) {
    throw new HTTPException(401, {
      message: "The signed-in account changed. Sign in again before continuing",
      res: new Response(null, {
        status: 401,
        headers: { "X-Identity-Mismatch": "1", "Cache-Control": "no-store" },
      }),
    });
  }
  c.set("user", row);
  c.set("userEmail", row.email);
  c.set("userId", row.id);
  c.set("sessionId", hash);
  c.set("sessionReauthAt", row.reauth_at);
  return row;
}
export async function sessionEmail(c: Context<AppEnv>): Promise<string | null> {
  return (await loadSession(c))?.email ?? null;
}
/** Restricted migration accounts may only inspect/logout or repair themselves.
 * Keep this outside loadSession so reauthentication and recovery retain their
 * existing identity/generation checks without gaining workspace access.
 */
function assertPasswordChanged(c: Context<AppEnv>): void {
  if (!c.get("user").password_change_required) return;
  const allowed = new Set([
    "GET /api/auth/me", "POST /api/auth/logout", "POST /api/auth/reauth",
    "POST /api/auth/password", "GET /api/auth/email-preferences", "PATCH /api/auth/email-preferences",
  ]);
  if (allowed.has(`${c.req.method} ${c.req.path}`)) return;
  throw new HTTPException(403, {
    message: "Change your password before accessing your workspace",
    res: new Response(null, { status: 403, headers: {
      "X-Password-Change-Required": "1", "Cache-Control": "no-store",
    } }),
  });
}
export const requireSession = createMiddleware<AppEnv>(async (c, next) => {
  c.header("Cache-Control", "no-store");
  assertSameOrigin(c);
  if (!(await loadSession(c))) throw new HTTPException(401, { message: "Not authenticated" });
  assertPasswordChanged(c);
  await next();
});
export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  c.header("Cache-Control", "no-store");
  if (!(await loadSession(c))) throw new HTTPException(401, { message: "Not authenticated" });
  assertSameOrigin(c);
  assertPasswordChanged(c);
  if (c.get("user").role !== "admin") throw new HTTPException(403, { message: "Administrator required" });
  await next();
});
/** Re-read rather than trusting cached context; confirmations belong to ONE session. */
export async function assertRecentAuth(c: Context<AppEnv>): Promise<void> {
  if (!(await loadSession(c))) throw new HTTPException(401, { message: "Not authenticated" });
  if (c.get("sessionReauthAt") <= nowSeconds() - 300) {
    throw new HTTPException(403, {
      message: "Recent password confirmation required",
      res: new Response(null, { status: 403, headers: {
        "X-Reauth-Required": "1", "Cache-Control": "no-store",
      } }),
    });
  }
}
export const requireRecentAuth = createMiddleware<AppEnv>(async (c, next) => {
  await assertRecentAuth(c);
  await next();
});
async function loadBearer(c: Context<AppEnv>): Promise<boolean> {
  const expected = c.env.API_BEARER_TOKEN;
  const header = c.req.header("Authorization");
  if (!expected || !header?.startsWith("Bearer ") || header.length > 4096) return false;
  if (!(await timingSafeEqualStr(header.slice(7).trim(), expected))) return false;
  // Global automation credential, not a login, and never a bootstrap path.
  const user = await c.env.DB.prepare(`SELECT u.* FROM users u JOIN app_settings a
    ON a.value=u.id WHERE a.key='bootstrap_admin_id'`).first<UserRow>();
  c.set("userEmail", user?.email ?? c.env.ADMIN_EMAIL);
  c.set("userId", user?.id ?? null);
  if (user) c.set("user", user);
  return true;
}
export const requireBearer = createMiddleware<AppEnv>(async (c, next) => {
  if (!c.env.API_BEARER_TOKEN) throw new HTTPException(503, { message: "API bearer token not configured" });
  if (!(await loadBearer(c))) {
    c.header("WWW-Authenticate", "Bearer");
    throw new HTTPException(401, {
      message: "Bearer token required",
      res: new Response(null, { status: 401, headers: { "WWW-Authenticate": "Bearer", "Cache-Control": "no-store" } }),
    });
  }
  await next();
});
export const requireSessionOrBearer = createMiddleware<AppEnv>(async (c, next) => {
  if (!(await loadBearer(c))) {
    assertSameOrigin(c);
    if (!(await loadSession(c))) throw new HTTPException(401, { message: "Not authenticated" });
    assertPasswordChanged(c);
  }
  await next();
});
