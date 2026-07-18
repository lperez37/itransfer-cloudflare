/** Auth middleware: signed session cookies for the admin UI, bearer token for
 * the programmatic /api/v1 API, and a combined variant that accepts either. */

import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { getCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import type { AppEnv, Env } from "../types";
import { SESSION_COOKIE, SESSION_EPOCH_KEY, sessionMaxAge } from "../types";
import { timingSafeEqualStr, verifySessionToken } from "./crypto";

/** Current session-revocation epoch (unix seconds); 0 when never bumped. */
export async function getSessionEpoch(env: Pick<Env, "DB">): Promise<number> {
  const row = await env.DB.prepare("SELECT value FROM app_settings WHERE key = ?")
    .bind(SESSION_EPOCH_KEY)
    .first<{ value: string }>();
  const epoch = row ? Number(row.value) : 0;
  return Number.isFinite(epoch) && epoch > 0 ? epoch : 0;
}

/** Bump the epoch to now, invalidating every session issued so far. */
export async function bumpSessionEpoch(env: Pick<Env, "DB">): Promise<void> {
  const now = String(Math.floor(Date.now() / 1000));
  await env.DB.prepare(
    "INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  )
    .bind(SESSION_EPOCH_KEY, now)
    .run();
}

function isAdminEmail(c: Context<AppEnv>, email: string): boolean {
  return email === c.env.ADMIN_EMAIL;
}

/** Admin email from a valid session cookie, or null if absent/invalid/revoked. */
export async function sessionEmail(c: Context<AppEnv>): Promise<string | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const epoch = await getSessionEpoch(c.env);
  const email = await verifySessionToken(
    token,
    c.env.SESSION_SECRET,
    sessionMaxAge(c.env),
    epoch
  );
  if (email === null || !isAdminEmail(c, email)) return null;
  return email;
}

async function bearerEmail(c: Context<AppEnv>): Promise<string | null> {
  if (!c.env.API_BEARER_TOKEN) return null;
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  if (!token) return null;
  if (!(await timingSafeEqualStr(token, c.env.API_BEARER_TOKEN))) return null;
  return c.env.ADMIN_EMAIL;
}

/** Session-cookie auth for the admin UI routes. */
export const requireSession = createMiddleware<AppEnv>(async (c, next) => {
  const email = await sessionEmail(c);
  if (email === null) {
    throw new HTTPException(401, { message: "Not authenticated" });
  }
  c.set("userEmail", email);
  await next();
});

/** Bearer-token auth for /api/v1 routes. */
export const requireBearer = createMiddleware<AppEnv>(async (c, next) => {
  if (!c.env.API_BEARER_TOKEN) {
    throw new HTTPException(503, { message: "API bearer token not configured" });
  }
  const email = await bearerEmail(c);
  if (email === null) {
    throw new HTTPException(401, {
      message: "Bearer token required",
      res: new Response(null, { headers: { "WWW-Authenticate": "Bearer" } }),
    });
  }
  c.set("userEmail", email);
  await next();
});

/** Accepts a valid session cookie OR a valid bearer token. */
export const requireSessionOrBearer = createMiddleware<AppEnv>(async (c, next) => {
  const email = (await sessionEmail(c)) ?? (await bearerEmail(c));
  if (email === null) {
    throw new HTTPException(401, {
      message: "Not authenticated",
      res: new Response(null, { headers: { "WWW-Authenticate": "Bearer" } }),
    });
  }
  c.set("userEmail", email);
  await next();
});
