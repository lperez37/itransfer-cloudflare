/** Optional mail is default-off; mandatory account mail never consults this module. */
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv, Env, EmailPreferences } from "../types";
import { accountBody, onlyFields, ADMIN_WRITE_GUARD, adminGuardValues, nowSeconds, tokenHash } from "./accounts";
import { httpsOrigin, plainTextLabel, queuePlainTextEmail } from "./mail";

type OptionalKind = "share_downloads" | "request_uploads";
const OPTIONAL_FIELDS = ["share_downloads", "request_uploads", "password_changed", "expiry_alerts", "invitation_reminders"] as const;
type PreferenceRow = Record<typeof OPTIONAL_FIELDS[number], number>;
const serialize = (row: PreferenceRow | null): EmailPreferences => ({
  share_downloads: !!row?.share_downloads, request_uploads: !!row?.request_uploads,
  password_changed: !!row?.password_changed, expiry_alerts: !!row?.expiry_alerts,
  invitation_reminders: !!row?.invitation_reminders,
  welcome: true, password_reset: true,
});

export async function readEmailPreferences(db: D1Database, id: string): Promise<EmailPreferences> {
  const user = await db.prepare("SELECT id FROM users WHERE id=?").bind(id).first();
  if (!user) throw new HTTPException(404, { message: "Account not found" });
  return serialize(await db.prepare(`SELECT ${OPTIONAL_FIELDS.join(",")} FROM user_email_preferences WHERE user_id=?`)
    .bind(id).first());
}

export async function patchEmailPreferences(c: Context<AppEnv>, id: string, admin = false): Promise<EmailPreferences> {
  const body = await accountBody(c);
  onlyFields(body, [...OPTIONAL_FIELDS]);
  if (!Object.keys(body).length || Object.values(body).some(value => typeof value !== "boolean")) {
    throw new HTTPException(400, { message: "Supply optional email preferences as booleans" });
  }
  const guard = admin ? ADMIN_WRITE_GUARD : `EXISTS (SELECT 1 FROM user_sessions s JOIN users a ON a.id=s.user_id
    WHERE s.token_hash=? AND s.expires_at>? AND s.generation=a.session_generation
    AND a.status='active' AND a.id=? AND a.id=users.id)`;
  const values = admin ? adminGuardValues(c) : [c.get("sessionId"), nowSeconds(), c.get("user").id];
  const changes = OPTIONAL_FIELDS.map(field => body[field] === undefined ? null : Number(body[field]));
  // All interpolated identifiers come from the constant allowlist, never the body.
  const row = await c.env.DB.prepare(`INSERT INTO user_email_preferences(user_id,${OPTIONAL_FIELDS.join(",")})
    SELECT id,${OPTIONAL_FIELDS.map(() => "COALESCE(?,0)").join(",")} FROM users WHERE id=? AND ${guard}
    ON CONFLICT(user_id) DO UPDATE SET ${OPTIONAL_FIELDS.map(field => `${field}=COALESCE(?,user_email_preferences.${field})`).join(",")}
    RETURNING ${OPTIONAL_FIELDS.join(",")}`).bind(...changes, id, ...values, ...changes).first<PreferenceRow>();
  if (!row) throw new HTTPException(409, { message: "Account operation could not be completed" });
  return serialize(row);
}

interface OptionalEvent { kind: OptionalKind; resourceId: string; eventId: string; fileCount: number }
/** Owner, recipient and title always come from current persisted resource/account state. */
export async function queueOptionalEmail(env: Env, event: OptionalEvent): Promise<"suppressed" | "attempted"> {
  const table = event.kind === "share_downloads" ? "shares" : "requests";
  const eligible = () => env.DB.prepare(`SELECT u.id,u.email,r.title FROM ${table} r
    JOIN users u ON u.id=COALESCE(r.owner_user_id,(SELECT value FROM app_settings WHERE key='bootstrap_admin_id'))
    JOIN user_email_preferences p ON p.user_id=u.id
    WHERE r.id=? AND u.status='active' AND p.${event.kind}=1`).bind(event.resourceId)
    .first<{ id: string; email: string; title: string }>();
  const owner = await eligible();
  const origin = httpsOrigin(env.PUBLIC_ORIGIN);
  if (!owner || !origin) return "suppressed";
  const key = await tokenHash(`${event.kind}:${event.resourceId}:${event.eventId}`);
  const now = nowSeconds();
  const claim = await optionalClaimStatement(env.DB, owner.id, key).first();
  if (!claim) return "suppressed";
  const current = await eligible();
  if (!current || current.id !== owner.id) return "suppressed";
  const subject = event.kind === "share_downloads" ? "A download was started for your iTransfer share" : "Files uploaded to your iTransfer request";
  const path = event.kind === "share_downloads" ? `/shares/${encodeURIComponent(event.resourceId)}` : "/dashboard";
  await queuePlainTextEmail(env, { email: current.email, subject,
    text: `${subject}\n\n${plainTextLabel(current.title || "Untitled")}\nFiles: ${event.fileCount}\n\nOpen your workspace: ${origin}${path}`,
    expiresAt: now + 900, idempotencyKey: `itransfer.notification.${key}` });
  return "attempted";
}

/** Best effort only; delivery failures must never affect a completed transfer. */
export function scheduleOptionalEmail(c: Context<AppEnv>, event: OptionalEvent): void {
  c.executionCtx.waitUntil(queueOptionalEmail(c.env, event).catch(() => "suppressed"));
}

/** Single-statement admission, usable inside an atomic invitation-issuance batch.
 * Additional guard SQL is internal constant SQL only, not request data.
 */
export function optionalClaimStatement(db: D1Database, userId: string, key: string,
  guard = "1", guardValues: (string | number)[] = []): D1PreparedStatement {
  const now = nowSeconds();
  return db.prepare(`INSERT INTO notification_claims(event_key,user_id,created_at)
    SELECT ?,?,? WHERE NOT EXISTS (SELECT 1 FROM notification_claims WHERE event_key=?)
    AND NOT EXISTS (SELECT 1 FROM notification_claims WHERE user_id=? AND created_at>?)
    AND (SELECT COUNT(*) FROM notification_claims WHERE user_id=? AND created_at>?)<5
    AND (SELECT COUNT(*) FROM notification_claims WHERE created_at>=?)<10
    AND (${guard}) ON CONFLICT(event_key) DO NOTHING RETURNING event_key`)
    .bind(key, userId, now, key, userId, now - 300, userId, now - 3600,
      Math.floor(now / 86400) * 86400, ...guardValues);
}

export async function queuePasswordChangedEmail(env: Env, userId: string, generation: number, changedAt: string): Promise<void> {
  const eligible = () => env.DB.prepare(`SELECT u.email FROM users u JOIN user_email_preferences p ON p.user_id=u.id
    WHERE u.id=? AND u.status='active' AND u.session_generation=? AND p.password_changed=1`)
    .bind(userId, generation).first<{ email: string }>();
  const origin = httpsOrigin(env.PUBLIC_ORIGIN);
  if (!origin || !(await eligible())) return;
  const key = await tokenHash(`password_changed:${userId}:${generation}`);
  if (!(await optionalClaimStatement(env.DB, userId, key).first())) return;
  const current = await eligible();
  if (!current) return;
  const subject = "Your iTransfer password was changed";
  await queuePlainTextEmail(env, { email: current.email, subject,
    text: `${subject}\n\nChanged at: ${changedAt}\n\nIf this was unexpected, contact your administrator.\n\nSign in: ${origin}/login`,
    expiresAt: nowSeconds() + 900, idempotencyKey: `itransfer.password_changed.${key}` });
}

/** Does not depend on a session that the password write has just revoked. */
export function schedulePasswordChangedEmail(c: Context<AppEnv>, userId: string, generation: number, changedAt: string): void {
  c.executionCtx.waitUntil(queuePasswordChangedEmail(c.env, userId, generation, changedAt).catch(() => {}));
}

type ExpiryCandidate = { id: string; kind: "share" | "request"; expires_at: string; owner_id: string };
async function queueExpiryAlert(env: Env, candidate: ExpiryCandidate): Promise<void> {
  const table = candidate.kind === "share" ? "shares" : "requests";
  const eligibility = `SELECT u.id,u.email,r.title FROM ${table} r
    JOIN users u ON u.id=COALESCE(r.owner_user_id,(SELECT value FROM app_settings WHERE key='bootstrap_admin_id'))
    JOIN user_email_preferences p ON p.user_id=u.id WHERE r.id=? AND r.expires_at=?
    AND r.is_active=1 ${candidate.kind === "share" ? "AND r.confirmed_at IS NOT NULL" : ""}
    AND r.expires_at>? AND r.expires_at<=? AND u.status='active' AND p.expiry_alerts=1 AND u.id=?`;
  const values = () => [candidate.id, candidate.expires_at, new Date().toISOString(),
    new Date(Date.now() + 86400000).toISOString(), candidate.owner_id];
  const origin = httpsOrigin(env.PUBLIC_ORIGIN);
  if (!origin) return;
  const eventKey = `expiry_alerts:${candidate.kind}:${candidate.id}:${candidate.expires_at}`;
  const key = await tokenHash(eventKey);
  // Revalidate the scan's owner/preference/deadline inside admission itself.
  if (!(await optionalClaimStatement(env.DB, candidate.owner_id, eventKey, `EXISTS(${eligibility})`, values()).first())) return;
  const current = await env.DB.prepare(eligibility).bind(...values()).first<{ id: string; email: string; title: string }>();
  if (!current) return;
  const subject = "Transfer expires soon";
  const path = candidate.kind === "share" ? `/shares/${encodeURIComponent(candidate.id)}` : "/dashboard";
  await queuePlainTextEmail(env, { email: current.email, subject,
    text: `${subject}\n\nType: ${candidate.kind}\n${plainTextLabel(current.title || "Untitled")}\nExpires at: ${candidate.expires_at}\n\nManage in your workspace: ${origin}${path}`,
    expiresAt: Math.min(nowSeconds() + 900, Date.parse(candidate.expires_at) / 1000),
    idempotencyKey: `itransfer.expiry_alerts.${key}` });
}

/** Hourly bounded scan; no network without opt-in and successful shared admission. */
export async function sendExpiryAlerts(env: Env): Promise<void> {
  const now = new Date().toISOString(), until = new Date(Date.now() + 86400000).toISOString();
  const { results } = await env.DB.prepare(`SELECT r.id,'share' AS kind,r.expires_at,u.id AS owner_id FROM shares r
    JOIN users u ON u.id=COALESCE(r.owner_user_id,(SELECT value FROM app_settings WHERE key='bootstrap_admin_id'))
    JOIN user_email_preferences p ON p.user_id=u.id
    WHERE r.is_active=1 AND r.confirmed_at IS NOT NULL AND r.expires_at>? AND r.expires_at<=?
    AND u.status='active' AND p.expiry_alerts=1
    AND NOT EXISTS(SELECT 1 FROM notification_claims n WHERE n.event_key='expiry_alerts:share:'||r.id||':'||r.expires_at)
    UNION ALL SELECT r.id,'request' AS kind,r.expires_at,u.id AS owner_id FROM requests r
    JOIN users u ON u.id=COALESCE(r.owner_user_id,(SELECT value FROM app_settings WHERE key='bootstrap_admin_id'))
    JOIN user_email_preferences p ON p.user_id=u.id
    WHERE r.is_active=1 AND r.expires_at>? AND r.expires_at<=? AND u.status='active' AND p.expiry_alerts=1
    AND NOT EXISTS(SELECT 1 FROM notification_claims n WHERE n.event_key='expiry_alerts:request:'||r.id||':'||r.expires_at)
    ORDER BY 3,1 LIMIT 20`).bind(now, until, now, until).all<ExpiryCandidate>();
  // A failed submission neither breaks cleanup nor triggers an unsafe resend.
  for (const candidate of results) {
    try { await queueExpiryAlert(env, candidate); } catch { /* best effort */ }
  }
}
