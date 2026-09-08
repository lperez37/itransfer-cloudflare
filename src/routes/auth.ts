/** Invite-only authentication. No email delivery and no legacy-cookie fallback. */
import { Hono, type Context } from "hono";
import { readEmailPreferences, patchEmailPreferences, schedulePasswordChangedEmail } from "../lib/email-preferences";
import { setCookie, deleteCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import type { AppEnv, UserRow } from "../types";
import { SESSION_COOKIE, sessionMaxAge } from "../types";
import { timingSafeEqualStr } from "../lib/crypto";
import { csrfProtection, requireSession, sessionEmail } from "../lib/auth";
import {
  accountBody, admitAuth, credentialSalt, createPasswordVerifier, emailValue, isoNow, nowSeconds,
  onlyFields, PASSWORD_ITERATIONS, passwordInput, proofInput, publicUser, randomToken, recordAudit, tokenHash,
  validatePassword, verifyPasswordProof,
} from "../lib/accounts";

const invalidLogin = () => new HTTPException(401, { message: "Invalid email or password" });
const invalidPassword = () => new HTTPException(401, { message: "Invalid credentials" });

/** The insert, durable marker and legacy ownership backfill commit together.
 * An empty table alone is NOT enough: the marker permanently closes fallback.
 */
async function bootstrap(c: Context<AppEnv>, email: string, proof: string, password: string | undefined): Promise<UserRow | null> {
  if (password === undefined) return null;
  const state = await c.env.DB.prepare(`SELECT
    (SELECT COUNT(*) FROM users) AS n,
    EXISTS(SELECT 1 FROM app_settings WHERE key='bootstrap_admin_id') AS bootstrapped`)
    .first<{ n: number; bootstrapped: number }>();
  if (!state || state.n !== 0 || state.bootstrapped) return null;
  // Environment credentials are examined ONLY while bootstrap remains open.
  const emailOK = await timingSafeEqualStr(email, c.env.ADMIN_EMAIL.trim().toLowerCase());
  const passwordOK = await timingSafeEqualStr(password, c.env.ADMIN_PASSWORD);
  if (!emailOK || !passwordOK) return null;
  // Preserve first-migration access for the exact legacy secret only. Weak
  // credentials create a restricted account until its password is replaced.
  let passwordChangeRequired = false;
  try { validatePassword(password); } catch (error) {
    if (!(error instanceof HTTPException)) throw error;
    passwordChangeRequired = true;
  }
  const id = crypto.randomUUID();
  const salt = await credentialSalt(c.env, email);
  // Knowledge of the initial secret authorizes installing this client proof.
  // The Worker intentionally does not derive/check PBKDF2(raw password).
  const hash = await createPasswordVerifier(c.env, id, salt, proof);
  const at = isoNow();
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO users(id,email,name,role,status,password_hash,password_salt,created_at,updated_at,password_change_required)
      SELECT ?,?,?,'admin','active',?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM users)
      AND NOT EXISTS(SELECT 1 FROM app_settings WHERE key='bootstrap_admin_id')`)
      .bind(id, email, "Administrator", hash, salt, at, at, Number(passwordChangeRequired)),
    c.env.DB.prepare(`INSERT INTO app_settings(key,value)
      SELECT 'bootstrap_admin_id',id FROM users WHERE id=?`).bind(id),
    c.env.DB.prepare(`UPDATE shares SET owner_user_id=? WHERE owner_user_id IS NULL
      AND EXISTS(SELECT 1 FROM app_settings WHERE key='bootstrap_admin_id' AND value=?)`).bind(id, id),
    c.env.DB.prepare(`UPDATE requests SET owner_user_id=? WHERE owner_user_id IS NULL
      AND EXISTS(SELECT 1 FROM app_settings WHERE key='bootstrap_admin_id' AND value=?)`).bind(id, id),
    c.env.DB.prepare(`INSERT INTO account_audit(actor_id,target_id,action,created_at)
      SELECT id,id,'account.bootstrap',? FROM users WHERE id=?`).bind(at, id),
  ]);
  // A simultaneous winning bootstrap may use a different ID. Never authenticate
  // it using the environment password: the losing request must retry DB login.
  return c.env.DB.prepare("SELECT * FROM users WHERE id=?").bind(id).first<UserRow>();
}

async function createSession(c: Context<AppEnv>, user: UserRow): Promise<void> {
  const token = randomToken();
  const hash = await tokenHash(token);
  const now = nowSeconds();
  const lifetime = sessionMaxAge(c.env);
  const results = await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO user_sessions(token_hash,user_id,generation,created_at,expires_at,reauth_at)
      SELECT ?,id,session_generation,?,?,? FROM users WHERE id=? AND status='active'
      AND password_hash=? AND session_generation=? RETURNING token_hash`)
      .bind(hash, now, now + lifetime, now, user.id, user.password_hash, user.session_generation),
    c.env.DB.prepare(`UPDATE users SET last_login_at=? WHERE id=?
      AND EXISTS(SELECT 1 FROM user_sessions WHERE token_hash=?)`).bind(isoNow(), user.id, hash),
    c.env.DB.prepare(`INSERT INTO account_audit(actor_id,target_id,action,created_at)
      SELECT user_id,user_id,'auth.login',? FROM user_sessions WHERE token_hash=?`).bind(isoNow(), hash),
    c.env.DB.prepare("DELETE FROM user_sessions WHERE token_hash IN (SELECT token_hash FROM user_sessions WHERE expires_at<=? LIMIT 100)").bind(now),
  ]);
  if (!results[0]?.results.length) throw invalidLogin();
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true, secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax", maxAge: lifetime, path: "/",
  });
}

export const authRoutes = new Hono<AppEnv>()
  .use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");
    await next();
    // The parent error handler creates a fresh Response; set these again after
    // it runs so even rejected login/setup requests cannot be cached.
    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");
  })
  .use("*", csrfProtection)
  .get("/email-preferences", requireSession, async c => c.json(await readEmailPreferences(c.env.DB, c.get("user").id)))
  .patch("/email-preferences", requireSession, async c => c.json(await patchEmailPreferences(c, c.get("user").id)))
  .post("/password-challenge", async (c) => {
    const body = await accountBody(c);
    onlyFields(body, ["email", "token"]);
    if ((body.email !== undefined) === (body.token !== undefined)) {
      throw new HTTPException(400, { message: "Supply exactly one email or token" });
    }
    if (body.email !== undefined) {
      const email = emailValue(body.email);
      await admitAuth(c, `email:${email}`, "challenge");
      // Do the secret-derived salt computation for known and unknown accounts.
      const derivedSalt = await credentialSalt(c.env, email);
      const row = await c.env.DB.prepare(`SELECT
        (SELECT password_salt FROM users WHERE email=?) AS salt,
        (NOT EXISTS(SELECT 1 FROM users) AND NOT EXISTS(
          SELECT 1 FROM app_settings WHERE key='bootstrap_admin_id')) AS bootstrap`)
        .bind(email).first<{ salt: string | null; bootstrap: number }>();
      return c.json({ salt: row?.salt ?? derivedSalt, iterations: PASSWORD_ITERATIONS, bootstrap: !!row?.bootstrap });
    }
    const validToken = typeof body.token === "string" && /^[a-f0-9]{64}$/.test(body.token);
    const hash = await tokenHash(validToken ? body.token as string : "invalid");
    await admitAuth(c, validToken ? `token:${hash}` : "invalid-setup-token", "challenge");
    const target = validToken ? await c.env.DB.prepare(`SELECT u.password_salt FROM password_tokens t
      JOIN users u ON u.id=t.user_id WHERE t.token_hash=? AND t.expires_at>?
      AND u.status IN ('pending','active')`).bind(hash, nowSeconds()).first<{ password_salt: string }>() : null;
    if (!target) throw new HTTPException(400, { message: "Invalid or expired setup link" });
    return c.json({ salt: target.password_salt, iterations: PASSWORD_ITERATIONS, bootstrap: false });
  })
  .post("/login", async (c) => {
    const body = await accountBody(c);
    onlyFields(body, ["email", "proof", "bootstrap_password"]);
    const email = emailValue(body.email);
    const proof = proofInput(body.proof);
    const initialPassword = body.bootstrap_password === undefined ? undefined : passwordInput(body.bootstrap_password);
    await admitAuth(c, email);
    let user = await c.env.DB.prepare("SELECT * FROM users WHERE email=?").bind(email).first<UserRow>();
    const dummySalt = await credentialSalt(c.env, email);
    const verified = await verifyPasswordProof(c.env, user, proof, dummySalt);
    if (!user) user = await bootstrap(c, email, proof, initialPassword);
    else if (!verified || user.status !== "active" || initialPassword !== undefined) user = null;
    if (!user) {
      await recordAudit(c.env.DB, null, null, "auth.login_invalid");
      throw invalidLogin();
    }
    await createSession(c, user);
    const fresh = await c.env.DB.prepare("SELECT * FROM users WHERE id=?").bind(user.id).first<UserRow>();
    return c.json(publicUser(fresh ?? user));
  })
  .get("/me", requireSession, (c) => c.json(publicUser(c.get("user"))))
  .post("/logout", requireSession, async (c) => {
    await c.env.DB.prepare("DELETE FROM user_sessions WHERE token_hash=?").bind(c.get("sessionId")).run();
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    await recordAudit(c.env.DB, c.get("user").id, null, "auth.logout");
    return c.json({ detail: "Logged out" });
  })
  .post("/reauth", requireSession, async (c) => {
    const body = await accountBody(c);
    onlyFields(body, ["proof"]);
    const user = c.get("user");
    await admitAuth(c, user.id, "reauth");
    if (!(await verifyPasswordProof(c.env, user, proofInput(body.proof), user.password_salt))) {
      await recordAudit(c.env.DB, user.id, user.id, "auth.reauth_invalid");
      throw invalidPassword();
    }
    const now = nowSeconds();
    const result = await c.env.DB.prepare(`UPDATE user_sessions SET reauth_at=? WHERE token_hash=? AND expires_at>?
      AND EXISTS(SELECT 1 FROM users u WHERE u.id=user_sessions.user_id AND u.status='active'
      AND u.password_hash=? AND u.session_generation=user_sessions.generation) RETURNING token_hash`)
      .bind(now, c.get("sessionId"), now, user.password_hash).first();
    if (!result) throw invalidPassword();
    await recordAudit(c.env.DB, user.id, user.id, "auth.reauth");
    return c.json({ detail: "Password confirmed" });
  })
  .post("/password", requireSession, async (c) => {
    const body = await accountBody(c);
    onlyFields(body, ["current_proof", "new_proof"]);
    const user = c.get("user");
    await admitAuth(c, user.id, "reauth");
    const newProof = proofInput(body.new_proof);
    if (!(await verifyPasswordProof(c.env, user, proofInput(body.current_proof), user.password_salt))) {
      await recordAudit(c.env.DB, user.id, user.id, "auth.password_invalid");
      throw invalidPassword();
    }
    const hash = await createPasswordVerifier(c.env, user.id, user.password_salt, newProof);
    const result = await c.env.DB.prepare(`UPDATE users SET password_hash=?,updated_at=?,password_change_required=0
      WHERE id=? AND password_hash=? AND status='active' AND EXISTS(
        SELECT 1 FROM user_sessions s WHERE s.token_hash=? AND s.user_id=users.id
        AND s.generation=users.session_generation AND s.expires_at>?) RETURNING id`)
      .bind(hash, isoNow(), user.id, user.password_hash, c.get("sessionId"), nowSeconds()).first();
    if (!result) throw invalidPassword();
    // The DB trigger revokes every session (including this one) and setup link.
    schedulePasswordChangedEmail(c, user.id, user.session_generation + 1, isoNow());
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    await recordAudit(c.env.DB, user.id, user.id, "auth.password_changed");
    return c.json({ detail: "Password changed. Sign in again" });
  })
  .post("/setup-password", async (c) => {
    const body = await accountBody(c);
    onlyFields(body, ["token", "proof"]);
    const proof = proofInput(body.proof);
    const validToken = typeof body.token === "string" && /^[a-f0-9]{64}$/.test(body.token);
    const hash = await tokenHash(validToken ? body.token as string : "invalid");
    const target = validToken ? await c.env.DB.prepare(`SELECT u.* FROM password_tokens t JOIN users u ON u.id=t.user_id
      WHERE t.token_hash=? AND t.expires_at>? AND u.status IN ('pending','active')`)
      .bind(hash, nowSeconds()).first<UserRow>() : null;
    await admitAuth(c, target ? `token:${hash}` : "invalid-setup-token", "recovery");
    if (!target) {
      await recordAudit(c.env.DB, null, null, "auth.setup_invalid");
      throw new HTTPException(400, { message: "Invalid or expired setup link" });
    }
    const passwordHash = await createPasswordVerifier(c.env, target.id, target.password_salt, proof);
    const result = await c.env.DB.prepare(`UPDATE users SET password_hash=?,status='active',updated_at=?,password_change_required=0
      WHERE id=? AND status IN ('pending','active') AND id IN (
        SELECT user_id FROM password_tokens WHERE token_hash=? AND expires_at>?) RETURNING id`)
      .bind(passwordHash, isoNow(), target.id, hash, nowSeconds()).first<{ id: string }>();
    if (!result) {
      await recordAudit(c.env.DB, null, null, "auth.setup_invalid");
      throw new HTTPException(400, { message: "Invalid or expired setup link" });
    }
    if (target.status === "active") {
      schedulePasswordChangedEmail(c, target.id, target.session_generation + 1, isoNow());
    }
    await recordAudit(c.env.DB, null, result.id, "auth.password_setup");
    // A setup link may be opened in a browser signed into a different account.
    // End that browser session too so the UI's sign-in step cannot restore it.
    if ((await sessionEmail(c)) !== null) {
      await c.env.DB.prepare("DELETE FROM user_sessions WHERE token_hash=?").bind(c.get("sessionId")).run();
    }
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ detail: "Password set. Sign in to continue" });
  });
