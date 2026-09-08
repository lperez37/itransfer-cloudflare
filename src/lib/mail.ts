/** Best-effort submission to the durable mail service, not proof of delivery.
 * No local outbox: a crash after account commit requires an admin reset to recover.
 * Never log payloads, credentials, capabilities, or remote response text.
 */
import type { Env } from "../types";

export interface MailResult {
  status: "queued" | "failed" | "unknown" | "not_configured";
  message_id?: string;
  error_code?: string;
}
type MailEnv = Pick<Env, "PUBLIC_ORIGIN" | "TRANSACTIONAL_MAIL_API_URL" | "TRANSACTIONAL_MAIL_API_KEY">;
interface AccountEmail {
  kind: "welcome" | "reset" | "invitation";
  inviter?: string;
  name: string;
  email: string;
  token: string;
  /** Already computed by the account transaction; never recompute or persist raw tokens. */
  tokenHash: string;
  expiresAt: number;
}
const failed = (error_code: string): MailResult => ({ status: "failed", error_code });
const unknown = (): MailResult => ({ status: "unknown", error_code: "submission_uncertain" });
// Workerd explicitly rejects the standard "error" mode. Probe locally (no I/O)
// and emulate it with manual + 3xx rejection, never with follow or a fetch retry.
const redirectMode: "error" | "manual" = (() => {
  try { new Request("https://mail.example.invalid", { redirect: "error" }); return "error"; }
  catch { return "manual"; }
})();
export const plainTextLabel = (s: string) => s.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, " ").slice(0, 200);

/** Check the lexical form too: URL normalization must not hide paths or credentials. */
export function httpsOrigin(value: string | undefined): string | null {
  if (!value || !/^https:\/\/[^/?#\\\s@]+\/?$/.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password &&
      url.pathname === "/" && !url.search && !url.hash ? url.origin : null;
  } catch { return null; }
}

export function accountSetupUrl(origin: string, token: string): string | null {
  const base = httpsOrigin(origin);
  return base && /^[a-f0-9]{64}$/.test(token) ? `${base}/set-password#token=${token}` : null;
}

function content(input: AccountEmail, url: string) {
  const expiry = new Date(input.expiresAt * 1000).toISOString();
  const welcome = input.kind === "welcome";
  const invitation = input.kind === "invitation";
  const subject = invitation ? "Your invitation to iTransfer" : welcome ? "Welcome to iTransfer" : "Reset your iTransfer password";
  const paragraphs = invitation ? [
    `Hi ${plainTextLabel(input.name)},`,
    `${plainTextLabel(input.inviter || "Your administrator")} invited you to join iTransfer.`,
    "Set your password using the link below, then log in to your private workspace for sharing and requesting files.",
    "This new invitation replaces your previous password setup link. Do not share it.",
    `This one-use invitation link expires at ${expiry} (24-hour setup window). If it expires, contact your administrator.`,
  ] : welcome ? [
    `Hi ${plainTextLabel(input.name)},`,
    "Your administrator created your account in iTransfer, your private workspace for sharing and requesting files.",
    "Set your password using the link below, then log in to your workspace.",
    "Share files: upload files and get a share link. You can optionally protect it with a password, an expiry date, or download limits.",
    "Request files: create an upload link for others to send you files. They do not need an account.",
    "Your workspace is private: other users cannot see it. Administrators can manage your workspace and provide support.",
    "Public links can be accessed by people with the link unless protected. Only share them with the intended recipients.",
    `This one-use password setup link expires at ${expiry} (24-hour setup window). If it expires, ask your administrator for a new link.`,
  ] : [
    `Hi ${plainTextLabel(input.name)},`,
    "Your administrator initiated a password reset for your iTransfer account. Existing sessions have been revoked.",
    "Use the link below to choose a new password, then log in. Do not share this link.",
    `This one-use reset link expires at ${expiry} (1-hour reset window). If it expires, ask your administrator for a new link.`,
    "If you were not expecting this reset, contact your administrator before proceeding.",
  ];
  const label = welcome || invitation ? "Set your password" : "Reset your password";
  return {
    subject,
    text: `${subject}\n\n${paragraphs.join("\n\n")}\n\n${label}: ${url}`,
  };
}

/** Read no more than 4096 bytes before decoding. Cancellation must not extend the deadline. */
async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  const bytes = new Uint8Array(4096);
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > bytes.length) { cancel(); return null; }
      bytes.set(value, size); size += value.byteLength;
    }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes.subarray(0, size))); }
    catch { return null; }
  } finally { signal.removeEventListener("abort", cancel); reader.releaseLock(); }
}

function accepted(value: unknown): MailResult {
  if (!value || typeof value !== "object") return unknown();
  const { id, status } = value as Record<string, unknown>;
  // Only the provider's generated message ID shape may cross the trust boundary.
  if (typeof id !== "string" || !/^msg_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)) return unknown();
  if (status === "queued" || status === "sending" || status === "submitted") return { status: "queued", message_id: id };
  if (status === "failed" || status === "expired") return { ...failed(status === "expired" ? "expired" : "provider_failed"), message_id: id };
  return { ...unknown(), message_id: id };
}

async function attempt(endpoint: string, key: string, idempotencyKey: string, body: string): Promise<MailResult> {
  const signal = AbortSignal.timeout(4500);
  let onAbort: () => void = () => {};
  const deadline = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error("mail_timeout"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([deadline, (async () => {
      const response = await fetch(endpoint, {
        method: "POST", redirect: redirectMode, signal,
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "Idempotency-Key": idempotencyKey }, body,
      });
      if (response.status === 202) return accepted(await boundedJson(response, signal));
      void response.body?.cancel().catch(() => {});
      if (response.status >= 300 && response.status < 400) return failed("redirect_rejected");
      if (response.status >= 500) throw new Error("mail_uncertain");
      const codes: Record<number, string> = { 400: "invalid_request", 401: "unauthorized", 403: "forbidden", 409: "idempotency_conflict", 429: "quota" };
      return response.status >= 400 && response.status < 500
        ? failed(codes[response.status] ?? "request_rejected") : unknown();
    })()]);
  } finally { signal.removeEventListener("abort", onAbort); }
}

/** At most two attempts, with identical serialized payload and idempotency key.
 * Unknown means it may already be queued: callers must not automatically reset/resend.
 */
export async function queueAccountEmail(env: MailEnv, input: AccountEmail): Promise<MailResult> {
  const url = accountSetupUrl(env.PUBLIC_ORIGIN, input.token);
  if (!url) return failed("invalid_public_origin");
  if (!/^[a-f0-9]{64}$/.test(input.tokenHash)) return failed("invalid_request");
  try {
    return await queuePlainTextEmail(env, { email: input.email, ...content(input, url),
      expiresAt: input.expiresAt - 60, idempotencyKey: `itransfer.${input.kind}.${input.tokenHash}` });
  } catch { return failed("invalid_content"); }
}

/** Internal raw plain-text transport shared by mandatory and optional mail. */
export async function queuePlainTextEmail(env: MailEnv, input: {
  email: string; subject: string; text: string; expiresAt: number; idempotencyKey: string;
}): Promise<MailResult> {
  const base = httpsOrigin(env.TRANSACTIONAL_MAIL_API_URL);
  const key = env.TRANSACTIONAL_MAIL_API_KEY;
  if (!env.TRANSACTIONAL_MAIL_API_URL && !key) return { status: "not_configured" };
  if (!base || !key || !/^[\x21-\x7e]+$/.test(key)) return failed("invalid_config");
  // Same ASCII mailbox grammar as the service's z.email(), including dotted domain.
  if (input.email.length > 254 || !/^[\x21-\x7e]+$/.test(input.email) ||
    !/^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$/.test(input.email)) return failed("invalid_recipient");
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(input.idempotencyKey)) return failed("invalid_request");
  const now = Date.now();
  const expires = Math.min(now + 15 * 60_000, input.expiresAt * 1000);
  if (!Number.isFinite(expires) || expires <= now) return failed("expired");
  try {
    const mail = { subject: input.subject, text: input.text };
    if (mail.subject.length > 200 || mail.text.length > 50_000) return failed("invalid_content");
    const body = JSON.stringify({ to: input.email, ...mail, expires_at: new Date(expires).toISOString() });
    if (new TextEncoder().encode(body).byteLength > 65536) return failed("invalid_content");
    const idem = input.idempotencyKey;
    for (let n = 0; n < 2; n++) {
      try {
        const result = await attempt(`${base}/v1/emails`, key, idem, body);
        // A rejected replay cannot disprove acceptance of the lost first request.
        // A 202 terminal state, identified by its message ID, can resolve it.
        return n > 0 && result.status === "failed" && !result.message_id ? unknown() : result;
      }
      catch { /* Network, abort or 5xx: acceptance is uncertain; one safe replay only. */ }
    }
    return unknown();
  } catch { return failed("invalid_content"); }
}
