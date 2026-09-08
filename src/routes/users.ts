/** Account administration. Every write revalidates the actor in its SQL statement. */
import { Hono } from "hono";
import { readEmailPreferences, patchEmailPreferences, optionalClaimStatement } from "../lib/email-preferences";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import { accountSetupUrl, httpsOrigin, queueAccountEmail, type MailResult } from "../lib/mail";
import type { AppEnv, UserRow } from "../types";
import { requireSession, requireAdmin, assertRecentAuth } from "../lib/auth";
import {
  accountBody, accountWriteError, admitAuth, ADMIN_WRITE_GUARD, adminGuardValues,
  emailValue, isoNow, nameValue, nowSeconds, onlyFields, publicUser,
  PUBLIC_USER_COLUMNS, randomToken, recordAudit, tokenHash,
} from "../lib/accounts";

function roleValue(value: unknown): "admin" | "user" {
  if (value !== "admin" && value !== "user") throw new HTTPException(400, { message: "Invalid role" });
  return value;
}
const noChange = () => new HTTPException(409, { message: "Account operation could not be completed. Refresh and confirm your password" });
function requireSetupOrigin(c: Context<AppEnv>): void {
  if (!httpsOrigin(c.env.PUBLIC_ORIGIN)) {
    throw new HTTPException(503, { message: "A valid HTTPS public origin is required before issuing account links" });
  }
}
function setupResponse(origin: string, token: string, expiry: number) {
  return { setup_url: accountSetupUrl(origin, token), expires_at: new Date(expiry * 1000).toISOString() };
}
/** Re-read recipient and current token together after commit; never mail a stale target snapshot. */
async function accountMail(c: Context<AppEnv>, id: string, kind: "welcome" | "reset" | "invitation", token: string, hash: string, expiry: number): Promise<MailResult> {
  let mail: MailResult;
  try {
    const target = await c.env.DB.prepare(`SELECT u.name,u.email FROM users u
      JOIN password_tokens p ON p.user_id=u.id WHERE u.id=? AND p.token_hash=?
      AND p.expires_at>? AND u.status IN ('active','pending')
      ${kind === "invitation" ? "AND u.status='pending' AND EXISTS(SELECT 1 FROM user_email_preferences ep WHERE ep.user_id=u.id AND ep.invitation_reminders=1)" : ""}`)
      .bind(id, hash, nowSeconds()).first<{ name: string; email: string }>();
    mail = target ? await queueAccountEmail(c.env, { ...target, kind, token, tokenHash: hash, expiresAt: expiry,
      inviter: kind === "invitation" ? c.get("user").name : undefined })
      : { status: "failed", error_code: "expired" };
  } catch { mail = { status: "failed", error_code: "mail_unavailable" }; }
  if (mail.status !== "not_configured") {
    try {
      await recordAudit(c.env.DB, c.get("user").id, id, `account.mail_${mail.status}`, mail.message_id);
    } catch { console.warn("Account mail audit unavailable"); }
  }
  return mail;
}
export const usersRoutes = new Hono<AppEnv>()
  .use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
    c.header("Cache-Control", "no-store");
  })
  .use("*", requireSession, requireAdmin)
  .use("*", async (c, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
      await assertRecentAuth(c);
      await admitAuth(c, c.get("user").id, "admin");
    }
    await next();
  })
  .get("/", async (c) => {
    const users = await c.env.DB.prepare(`SELECT ${PUBLIC_USER_COLUMNS} FROM users ORDER BY created_at,id`).all();
    return c.json({ users: users.results.map(row => ({
      ...row, password_change_required: row.password_change_required === 1,
    })) });
  })
  .get("/:id/email-preferences", async c => c.json(await readEmailPreferences(c.env.DB, c.req.param("id"))))
  .patch("/:id/email-preferences", async c => c.json(await patchEmailPreferences(c, c.req.param("id"), true)))
  .get("/audit", async (c) => {
    const events = await c.env.DB.prepare(`SELECT id,actor_id,target_id,action,detail,created_at
      FROM account_audit ORDER BY id DESC LIMIT 200`).all();
    return c.json({ events: events.results });
  })
  .post("/", async (c) => {
    requireSetupOrigin(c);
    const body = await accountBody(c);
    onlyFields(body, ["name", "email", "role"]);
    const name = nameValue(body.name);
    const email = emailValue(body.email);
    const role = roleValue(body.role ?? "user");
    const id = crypto.randomUUID();
    // A reused email address must not recreate a previous account's proof salt.
    const salt = randomToken().slice(0, 32);
    const token = randomToken();
    const hash = await tokenHash(token);
    const now = nowSeconds();
    const expiry = now + 86400;
    const at = isoNow();
    let results;
    try {
      results = await c.env.DB.batch([
        c.env.DB.prepare(`INSERT INTO users(id,email,name,role,status,password_salt,created_at,updated_at)
          SELECT ?,?,?,?,'pending',?,?,? WHERE ${ADMIN_WRITE_GUARD} RETURNING *`)
          .bind(id, email, name, role, salt, at, at, ...adminGuardValues(c)),
        c.env.DB.prepare(`INSERT INTO password_tokens(token_hash,user_id,expires_at,created_at)
          SELECT ?,id,?,? FROM users WHERE id=?`).bind(hash, expiry, now, id),
        c.env.DB.prepare(`INSERT INTO account_audit(actor_id,target_id,action,created_at)
          SELECT ?,id,'account.invited',? FROM users WHERE id=?`).bind(c.get("user").id, at, id),
      ]);
    } catch (error) { accountWriteError(error); }
    const user = results[0]?.results[0] as UserRow | undefined;
    if (!user) throw noChange();
    const mail = await accountMail(c, user.id, "welcome", token, hash, expiry);
    return c.json({ user: publicUser(user), ...setupResponse(c.env.PUBLIC_ORIGIN, token, expiry), mail }, 201);
  })
  .patch("/:id", async (c) => {
    const body = await accountBody(c);
    onlyFields(body, ["name", "email", "role", "status"]);
    if (!Object.keys(body).length) throw new HTTPException(400, { message: "No changes supplied" });
    const target = await c.env.DB.prepare("SELECT * FROM users WHERE id=?").bind(c.req.param("id")).first<UserRow>();
    if (!target) throw new HTTPException(404, { message: "Account not found" });
    const name = body.name === undefined ? target.name : nameValue(body.name);
    const email = body.email === undefined ? target.email : emailValue(body.email);
    const role = body.role === undefined ? target.role : roleValue(body.role);
    let status = body.status === undefined ? target.status : body.status;
    if (body.status !== undefined && status !== "active" && status !== "disabled") {
      throw new HTTPException(400, { message: "Invalid status" });
    }
    // Reactivating a disabled invitation restores pending, never passwordless
    // active. Admin can then issue a fresh setup link (old links stay revoked).
    if (status === "active" && !target.password_hash) status = "pending";
    let result;
    try {
      result = await c.env.DB.prepare(`UPDATE users SET name=?,email=?,role=?,status=?,updated_at=?
        WHERE id=? AND session_generation=? AND name=? AND updated_at=? AND ${ADMIN_WRITE_GUARD} RETURNING *`)
        .bind(name, email, role, status, isoNow(), target.id, target.session_generation, target.name, target.updated_at, ...adminGuardValues(c)).first<UserRow>();
    } catch (error) { accountWriteError(error); }
    if (!result) throw noChange();
    await recordAudit(c.env.DB, c.get("user").id, target.id, "account.updated", `fields:${Object.keys(body).sort().join(",")}`);
    return c.json(publicUser(result));
  })
  .post("/:id/invitation", async (c) => {
    requireSetupOrigin(c);
    const id = c.req.param("id");
    const allowed = await c.env.DB.prepare(`SELECT u.id FROM users u JOIN user_email_preferences p ON p.user_id=u.id
      WHERE u.id=? AND u.status='pending' AND p.invitation_reminders=1`).bind(id).first();
    if (!allowed) throw new HTTPException(409, { message: "Invitation reminders require a pending account with reminders enabled" });
    const token = randomToken(), hash = await tokenHash(token);
    const eventKey = await tokenHash(`invitation:${id}:${crypto.randomUUID()}`);
    const now = nowSeconds(), expiry = now + 86400;
    const eligibility = `EXISTS(SELECT 1 FROM users u JOIN user_email_preferences p ON p.user_id=u.id
      WHERE u.id=? AND u.status='pending' AND p.invitation_reminders=1) AND ${ADMIN_WRITE_GUARD}`;
    // Admission and rotation are one transaction. Denied quota cannot invalidate a link.
    const results = await c.env.DB.batch([
      optionalClaimStatement(c.env.DB, id, eventKey, eligibility, [id, ...adminGuardValues(c)]),
      c.env.DB.prepare(`INSERT INTO password_tokens(token_hash,user_id,expires_at,created_at)
        SELECT ?,id,?,? FROM users WHERE id=? AND status='pending'
        AND EXISTS(SELECT 1 FROM notification_claims WHERE event_key=? AND user_id=users.id)
        AND ${eligibility}
        ON CONFLICT(user_id) DO UPDATE SET token_hash=excluded.token_hash,expires_at=excluded.expires_at,created_at=excluded.created_at
        RETURNING user_id`).bind(hash, expiry, now, id, eventKey, id, ...adminGuardValues(c)),
      c.env.DB.prepare(`INSERT INTO account_audit(actor_id,target_id,action,created_at)
        SELECT ?,user_id,'account.invitation_issued',? FROM password_tokens WHERE token_hash=?`)
        .bind(c.get("user").id, isoNow(), hash),
    ]);
    if (!results[0]?.results.length) {
      throw new HTTPException(429, { message: "Invitation reminder not admitted. Retry later",
        res: new Response(null, { status: 429, headers: { "Retry-After": "300" } }) });
    }
    if (!results[1]?.results.length) throw noChange();
    const mail = await accountMail(c, id, "invitation", token, hash, expiry);
    return c.json({ ...setupResponse(c.env.PUBLIC_ORIGIN, token, expiry), mail });
  })
  .post("/:id/reset-password", async (c) => {
    requireSetupOrigin(c);
    const token = randomToken();
    const hash = await tokenHash(token);
    const now = nowSeconds();
    const expiry = now + 3600;
    // Guarded token issuance, generation bump and revocation are one D1 transaction.
    const results = await c.env.DB.batch([
      c.env.DB.prepare(`INSERT INTO password_tokens(token_hash,user_id,expires_at,created_at)
        SELECT ?,id,?,? FROM users WHERE id=? AND status IN ('active','pending') AND ${ADMIN_WRITE_GUARD}
        ON CONFLICT(user_id) DO UPDATE SET token_hash=excluded.token_hash,expires_at=excluded.expires_at,created_at=excluded.created_at
        RETURNING user_id`).bind(hash, expiry, now, c.req.param("id"), ...adminGuardValues(c)),
      c.env.DB.prepare(`UPDATE users SET session_generation=session_generation+1,updated_at=?
        WHERE id IN (SELECT user_id FROM password_tokens WHERE token_hash=?)`).bind(isoNow(), hash),
      c.env.DB.prepare(`DELETE FROM user_sessions WHERE user_id IN (SELECT user_id FROM password_tokens WHERE token_hash=?)`).bind(hash),
      c.env.DB.prepare(`INSERT INTO account_audit(actor_id,target_id,action,created_at)
        SELECT ?,user_id,'account.reset_issued',? FROM password_tokens WHERE token_hash=?`).bind(c.get("user").id, isoNow(), hash),
    ]);
    if (!results[0]?.results.length) throw noChange();
    const mail = await accountMail(c, c.req.param("id"), "reset", token, hash, expiry);
    return c.json({ ...setupResponse(c.env.PUBLIC_ORIGIN, token, expiry), mail });
  })
  .post("/:id/revoke-sessions", async (c) => {
    // Generation is authoritative, so concurrent login based on an older user
    // snapshot cannot mint a session after this statement commits.
    const result = await c.env.DB.prepare(`UPDATE users SET session_generation=session_generation+1,updated_at=?
      WHERE id=? AND ${ADMIN_WRITE_GUARD} RETURNING id`)
      .bind(isoNow(), c.req.param("id"), ...adminGuardValues(c)).first<{ id: string }>();
    if (!result) throw noChange();
    await c.env.DB.prepare(`DELETE FROM user_sessions WHERE user_id=? AND generation !=
      (SELECT session_generation FROM users WHERE id=?)`).bind(result.id, result.id).run();
    await recordAudit(c.env.DB, c.get("user").id, result.id, "account.sessions_revoked");
    return c.json({ detail: "Sessions revoked" });
  });
