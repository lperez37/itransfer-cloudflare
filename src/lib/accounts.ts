/** Account security primitives. Passwords and bearer capabilities never enter audit. */
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv, Env, UserRow } from "../types";
import { timingSafeEqualStr } from "./crypto";

const encoder = new TextEncoder();
/** Client stretches account passwords; this module NEVER runs a password KDF. */
export const PASSWORD_ITERATIONS = 600_000;
const VERIFIER_PREFIX = `client-pbkdf2-sha256$${PASSWORD_ITERATIONS}$`;
type CredentialEnv = Pick<Env, "SESSION_SECRET">;
type CredentialUser = Pick<UserRow, "id" | "password_salt" | "password_hash">;
export const nowSeconds = () => Math.floor(Date.now() / 1000);
export const isoNow = () => new Date().toISOString();
export const PUBLIC_USER_COLUMNS = "id,email,name,role,status,created_at,updated_at,last_login_at,password_change_required";
export function publicUser(user: Pick<UserRow, "id" | "email" | "name" | "role" | "status" | "created_at" | "updated_at" | "last_login_at" | "password_change_required">) {
  const { id, email, name, role, status, created_at, updated_at, last_login_at } = user;
  return { id, email, name, role, status, created_at, updated_at, last_login_at,
    password_change_required: !!user.password_change_required };
}
function hex(bytes: ArrayBuffer | Uint8Array): string {
  return Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
}
export function randomToken(): string { return hex(crypto.getRandomValues(new Uint8Array(32))); }
export async function tokenHash(token: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(token)));
}
function credentialRoot(env: CredentialEnv): Uint8Array<ArrayBuffer> {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) {
    throw new HTTPException(503, { message: "Credential root must contain at least 32 characters" });
  }
  return encoder.encode(env.SESSION_SECRET);
}
/** Stable dummy salt for unknown emails and the initial administrator bootstrap.
 * Invited accounts use random persisted salts; renaming/reusing an email cannot
 * give two accounts the same password-equivalent proof.
 */
export async function credentialSalt(env: CredentialEnv, email: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", credentialRoot(env), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key,
    encoder.encode(`itransfer/password-salt/v1:${email.trim().toLowerCase()}`))).slice(0, 32);
}
export function proofInput(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new HTTPException(400, { message: "Invalid credential proof" });
  }
  return value;
}
/** Proofs are replayable credentials: TLS only, never log, audit, or store them.
 * SESSION_SECRET must be high-entropy random material (>=32 characters does not
 * itself guarantee entropy). Rotation invalidates ALL password verifiers and
 * requires account resets; never silently fall back to another verifier/root.
 * This native HKDF/HMAC path avoids the browser's 600k-iteration CPU cost.
 */
export async function createPasswordVerifier(env: CredentialEnv, userId: string, salt: string, proof: string): Promise<string> {
  proofInput(proof);
  if (!userId || !/^[a-f0-9]{32}$/.test(salt)) throw new HTTPException(400, { message: "Invalid credential parameters" });
  const root = await crypto.subtle.importKey("raw", credentialRoot(env), "HKDF", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey({
    name: "HKDF", hash: "SHA-256",
    salt: encoder.encode("itransfer/password-verifier/hkdf-salt/v1"),
    info: encoder.encode("itransfer/password-verifier/v1"),
  }, root, { name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key,
    encoder.encode(JSON.stringify(["client-pbkdf2-sha256-v1", userId, salt, proof])));
  return `${VERIFIER_PREFIX}${hex(mac)}`;
}
/** Absent/pending users still compute the same native HMAC. No legacy formats. */
export async function verifyPasswordProof(env: CredentialEnv, user: CredentialUser | null, proof: string, dummySalt: string): Promise<boolean> {
  const verifier = await createPasswordVerifier(env, user?.id ?? "itransfer-dummy-user-v1", user?.password_salt ?? dummySalt, proof);
  const stored = user?.password_hash;
  const validFormat = typeof stored === "string" && /^client-pbkdf2-sha256\$600000\$[a-f0-9]{64}$/.test(stored);
  const equal = await timingSafeEqualStr(verifier, validFormat ? stored : `${VERIFIER_PREFIX}${"0".repeat(64)}`);
  return validFormat && equal;
}
/** Bootstrap-only raw-password policy. Regular proof endpoints cannot enforce
 * password length/complexity: first-party clients must validate before stretching.
 */
export function validatePassword(value: unknown): string {
  if (typeof value !== "string" || value.length < 8 || value.length > 128) {
    throw new HTTPException(400, { message: "Password must contain 8–128 characters" });
  }
  const lower = value.toLowerCase();
  const simple = lower.replace(/[^a-z]/g, "");
  const leet = lower.replace(/@|4/g, "a").replace(/0/g, "o").replace(/3/g, "e")
    .replace(/\$|5/g, "s").replace(/1/g, "i").replace(/[^a-z]/g, "");
  const common = /^(password|passwrd|letmein|welcome|qwerty|admin|administrator|changeme|iloveyou|monkey|dragon|login|test|secret|abc|abcdefgh|asdfghjkl|correcthorsebatterystaple)+$/;
  if (common.test(simple) || common.test(leet)
    || /^[0-9\s!@#$%^&*_.-]+$/.test(value) || /^(.)\1+$/.test(value)
    || /^(1234567890|123456789|qwertyuiop|abcdefghijkl)/i.test(value)) {
    throw new HTTPException(400, { message: "Choose a less common password" });
  }
  return value;
}
export function emailValue(value: unknown): string {
  if (typeof value !== "string" || value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) {
    throw new HTTPException(400, { message: "Invalid email" });
  }
  return value.trim().toLowerCase();
}
export function nameValue(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 100 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new HTTPException(400, { message: "Invalid name" });
  }
  return value.trim();
}
export function passwordInput(value: unknown): string {
  if (typeof value !== "string" || !value.length || value.length > 128) {
    throw new HTTPException(400, { message: "Invalid credentials" });
  }
  return value;
}
/** Streaming cap is enforced before JSON.parse, regardless of Content-Length. */
export async function accountBody(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  if (!c.req.header("Content-Type")?.toLowerCase().startsWith("application/json")) {
    throw new HTTPException(415, { message: "JSON body required" });
  }
  const reader = c.req.raw.body?.getReader();
  if (!reader) throw new HTTPException(400, { message: "Invalid request body" });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8192) {
        await reader.cancel();
        throw new HTTPException(413, { message: "Request body too large" });
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body as Record<string, unknown>;
  } catch { throw new HTTPException(400, { message: "Invalid request body" }); }
}
export function onlyFields(body: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(body).some(k => !allowed.includes(k))) throw new HTTPException(400, { message: "Unknown field" });
}
export async function recordAudit(db: D1Database, actorId: string | null, targetId: string | null, action: string, detail?: string): Promise<void> {
  await db.prepare("INSERT INTO account_audit(actor_id,target_id,action,detail,created_at) VALUES(?,?,?,?,?)")
    .bind(actorId, targetId, action.slice(0, 100), detail?.slice(0, 500) ?? null, isoNow()).run();
}
export type AuthRatePolicy = "login" | "reauth" | "recovery" | "admin" | "challenge";
const RATE_POLICIES = {
  login: { ip: [30, 100], account: [8, 20] },
  reauth: { ip: [60, 180], account: [20, 60] },
  recovery: { ip: [30, 100], account: [8, 20] },
  admin: { ip: [120, 400], account: [60, 200] },
  challenge: { ip: [120, 400], account: [60, 200] },
} as const;

/** One SQLite statement admits every applicable identity atomically before verification.
 * Policies isolate anonymous login, authenticated proofs, recovery and admin work.
 * Reauth additionally reserves a per-user admission (60/15m, 180/hr), preventing
 * many sessions from multiplying the proof-attempt budget without allowing anonymous
 * login failures to consume any of it. Its main account key is session-bound.
 * No success reset: successful logins cannot erase an attacker's admission cost.
 */
export async function admitAuth(c: Context<AppEnv>, identity: string, policy: AuthRatePolicy = "login"): Promise<void> {
  const proof = policy === "reauth";
  if (proof && (!c.get("sessionId") || !c.get("user")?.id)) {
    throw new HTTPException(401, { message: "Not authenticated" });
  }
  const invalidRecovery = policy === "recovery" && identity === "invalid-setup-token";
  const namespace = invalidRecovery ? "recovery-invalid" : policy;
  const limits = invalidRecovery ? { ip: [10, 30], account: [8, 20] } : RATE_POLICIES[policy];
  const key = await crypto.subtle.importKey("raw", encoder.encode(c.env.SESSION_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const pseudonym = async (s: string) => hex(await crypto.subtle.sign("HMAC", key, encoder.encode(s)));
  const ip = await pseudonym(`${namespace}:ip:${c.req.header("CF-Connecting-IP") ?? "unknown"}`);
  const accountIdentity = proof ? `${c.get("user").id}:${c.get("sessionId")}` : identity;
  const account = await pseudonym(`${namespace}:account:${accountIdentity}`);
  const user = await pseudonym(`${namespace}:user:${proof ? c.get("user").id : "unused"}`);
  // Auxiliary user rows do not count against an IP or a session a second time.
  const userLedger = await pseudonym(`${namespace}:user-ledger`);
  const now = nowSeconds();
  const admitted = await c.env.DB.prepare(`WITH admission AS MATERIALIZED (
    SELECT 1 WHERE
      (SELECT COUNT(*) FROM auth_attempts WHERE ip_key=? AND at>?) < ? AND
      (SELECT COUNT(*) FROM auth_attempts WHERE ip_key=? AND at>?) < ? AND
      (SELECT COUNT(*) FROM auth_attempts WHERE account_key=? AND at>?) < ? AND
      (SELECT COUNT(*) FROM auth_attempts WHERE account_key=? AND at>?) < ? AND
      (?=0 OR ((SELECT COUNT(*) FROM auth_attempts WHERE account_key=? AND at>?) < 60 AND
        (SELECT COUNT(*) FROM auth_attempts WHERE account_key=? AND at>?) < 180))
    ), identities(ip_key,account_key) AS (
      SELECT ?,? UNION ALL SELECT ?,? WHERE ?=1
    ) INSERT INTO auth_attempts(ip_key,account_key,at)
      SELECT identities.ip_key,identities.account_key,? FROM admission CROSS JOIN identities RETURNING id`)
    .bind(ip, now - 900, limits.ip[0], ip, now - 3600, limits.ip[1],
      account, now - 900, limits.account[0], account, now - 3600, limits.account[1],
      Number(proof), user, now - 900, user, now - 3600,
      ip, account, userLedger, user, Number(proof), now).all();
  if (!admitted.results.length) {
    // Structured, pseudonymous abuse telemetry without an unbounded DB write on denial.
    console.warn(JSON.stringify({ event: "auth.rate_denied", policy: namespace, ip_key: ip, account_key: account }));
    c.header("Retry-After", "900");
    throw new HTTPException(429, {
      message: "Too many attempts. Try again later",
      res: new Response(null, { status: 429, headers: { "Retry-After": "900", "Cache-Control": "no-store" } }),
    });
  }
  await c.env.DB.prepare("DELETE FROM auth_attempts WHERE id IN (SELECT id FROM auth_attempts WHERE at < ? LIMIT 100)")
    .bind(now - 3600).run();
}
/** SQL guard used in the same statement as each admin mutation (TOCTOU safe). */
export const ADMIN_WRITE_GUARD = `EXISTS (SELECT 1 FROM user_sessions s JOIN users a ON a.id=s.user_id
  WHERE s.token_hash=? AND s.expires_at>? AND s.reauth_at>? AND s.generation=a.session_generation
  AND a.status='active' AND a.role='admin')`;
export function adminGuardValues(c: Context<AppEnv>): [string, number, number] {
  const now = nowSeconds();
  return [c.get("sessionId"), now, now - 300];
}
export function accountWriteError(error: unknown): never {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("last_active_admin")) throw new HTTPException(409, { message: "At least one active administrator is required" });
  if (message.includes("UNIQUE constraint failed: users.email")) throw new HTTPException(409, { message: "Account cannot be created or updated" });
  throw new HTTPException(500, { message: "Account operation failed" });
}
