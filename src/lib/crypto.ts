/** Web Crypto based primitives: constant-time compare, PBKDF2 password
 * hashing, and HMAC-signed session tokens. */

const encoder = new TextEncoder();

const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_KEYLEN = 32;

function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const b of arr) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Constant-time string comparison (hashes both sides so lengths never leak). */
export async function timingSafeEqualStr(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const va = new Uint8Array(da);
  const vb = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i]! ^ vb[i]!;
  return diff === 0;
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    key,
    PBKDF2_KEYLEN * 8
  );
  return new Uint8Array(bits);
}

/** Hash a password. Format: pbkdf2-sha256$<iterations>$<salt>$<hash> (base64url). */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${toBase64Url(salt)}$${toBase64Url(hash)}`;
}

/** Verify a plaintext password against a stored hash. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2-sha256") return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 10_000_000) return false;
  try {
    const salt = fromBase64Url(parts[2]!);
    const expected = fromBase64Url(parts[3]!);
    const actual = await pbkdf2(password, salt, iterations);
    if (actual.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < actual.length; i++) diff |= actual[i]! ^ expected[i]!;
    return diff === 0;
  } catch {
    // A corrupt stored hash (e.g. invalid base64) must fail closed, not throw.
    return false;
  }
}

async function hmacSign(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return toBase64Url(sig);
}

/** Create a signed session token: base64url(email).issuedAtSeconds.signature */
export async function createSessionToken(email: string, secret: string): Promise<string> {
  const payload = `${toBase64Url(encoder.encode(email))}.${Math.floor(Date.now() / 1000)}`;
  const sig = await hmacSign(secret, payload);
  return `${payload}.${sig}`;
}

/** Verify a session token and return the email, or null if invalid/expired.
 * Tokens issued before `minIssuedAt` (the server-side revocation epoch) are
 * rejected, giving logout / admin a way to invalidate all outstanding sessions. */
export async function verifySessionToken(
  token: string,
  secret: string,
  maxAgeSeconds: number,
  minIssuedAt = 0
): Promise<string | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [emailB64, issuedStr, sig] = parts as [string, string, string];
  const expected = await hmacSign(secret, `${emailB64}.${issuedStr}`);
  if (!(await timingSafeEqualStr(sig, expected))) return null;
  const issued = Number(issuedStr);
  if (!Number.isFinite(issued)) return null;
  if (issued < minIssuedAt) return null;
  const age = Math.floor(Date.now() / 1000) - issued;
  if (age < 0 || age > maxAgeSeconds) return null;
  try {
    return new TextDecoder().decode(fromBase64Url(emailB64));
  } catch {
    return null;
  }
}
