/** Login, logout and session check. */

import { Hono } from "hono";
import { setCookie, deleteCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import type { AppEnv, Env } from "../types";
import { SESSION_COOKIE, sessionMaxAge } from "../types";
import { createSessionToken, timingSafeEqualStr } from "../lib/crypto";
import { requireSession, bumpSessionEpoch, sessionEmail } from "../lib/auth";
import { loginSchema, parseBody } from "../lib/schemas";

// Brute-force protection: lock a source IP out of /login after this many
// failed attempts inside the rolling window.
const LOGIN_BUCKET = "login";
const LOGIN_MAX_FAILURES = 5;
const LOGIN_WINDOW_MINUTES = 15;

function clientIp(c: { req: { header: (name: string) => string | undefined } }): string {
  return c.req.header("CF-Connecting-IP") ?? "unknown";
}

/** Count recent failed logins for an IP and throw 429 once over the limit. */
async function enforceLoginRateLimit(env: Pick<Env, "DB">, ip: string): Promise<void> {
  const cutoff = new Date(Date.now() - LOGIN_WINDOW_MINUTES * 60 * 1000).toISOString();
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM rate_hits WHERE bucket = ? AND ip = ? AND at >= ?"
  )
    .bind(LOGIN_BUCKET, ip, cutoff)
    .first<{ n: number }>();
  if ((row?.n ?? 0) >= LOGIN_MAX_FAILURES) {
    throw new HTTPException(429, {
      message: `Too many login attempts. Try again in ${LOGIN_WINDOW_MINUTES} minutes.`,
    });
  }
}

async function recordLoginFailure(env: Pick<Env, "DB">, ip: string): Promise<void> {
  await env.DB.prepare("INSERT INTO rate_hits (bucket, ip, at) VALUES (?, ?, ?)")
    .bind(LOGIN_BUCKET, ip, new Date().toISOString())
    .run();
}

/** Clear an IP's failed-login record after a successful sign-in. */
async function clearLoginFailures(env: Pick<Env, "DB">, ip: string): Promise<void> {
  await env.DB.prepare("DELETE FROM rate_hits WHERE bucket = ? AND ip = ?")
    .bind(LOGIN_BUCKET, ip)
    .run();
}

export const authRoutes = new Hono<AppEnv>()
  .post("/login", async (c) => {
    const ip = clientIp(c);
    await enforceLoginRateLimit(c.env, ip);

    const body = await parseBody(c.req, loginSchema);

    const emailOk = await timingSafeEqualStr(body.email, c.env.ADMIN_EMAIL);
    const passOk = await timingSafeEqualStr(body.password, c.env.ADMIN_PASSWORD);
    if (!emailOk || !passOk) {
      await recordLoginFailure(c.env, ip);
      throw new HTTPException(401, { message: "Invalid email or password" });
    }

    await clearLoginFailures(c.env, ip);

    const token = await createSessionToken(body.email, c.env.SESSION_SECRET);
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      secure: c.env.PUBLIC_ORIGIN.startsWith("https"),
      sameSite: "Lax",
      maxAge: sessionMaxAge(c.env),
      path: "/",
    });
    return c.json({ email: body.email });
  })
  .post("/logout", async (c) => {
    // Bump the revocation epoch so the cleared cookie (and any other
    // outstanding session tokens) can never be replayed server-side.
    // Only a valid session may bump it - otherwise an unauthenticated
    // caller could loop /logout and permanently lock the admin out.
    if ((await sessionEmail(c)) !== null) {
      await bumpSessionEpoch(c.env);
    }
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ detail: "Logged out" });
  })
  .get("/me", requireSession, (c) => c.json({ email: c.get("userEmail") }));
