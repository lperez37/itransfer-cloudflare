import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { readFile, readdir } from 'node:fs/promises';
import { createHash, createHmac, hkdfSync, pbkdf2Sync, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { migrationStatements } from './migrations.mjs';

export const ORIGIN = 'https://transfer.example.test';
export const PASSWORD = 'Cobalt!river-otter-792';
export const NEW_PASSWORD = 'Amber!forest-heron-463';
export const EMAIL = 'admin@example.test';
export const SECRET = 'isolated-test-session-secret-not-a-real-credential';
export const BEARER = 'isolated-test-automation-token';
export const now = () => Math.floor(Date.now() / 1000);
export const digest = token => createHash('sha256').update(token).digest('hex');
const root = fileURLToPath(new URL('../../', import.meta.url));
const bundles = new Map();
const proofs = new Map();
/** Reference browser-side stretching, deliberately outside workerd. */
export function proofFor(salt, password = PASSWORD) {
  assert.match(salt, /^[a-f0-9]{32}$/);
  const key = JSON.stringify([salt, password]);
  if (!proofs.has(key)) proofs.set(key, pbkdf2Sync(password, Buffer.from(salt, 'hex'), 600000, 32, 'sha256').toString('hex'));
  return proofs.get(key);
}
export const bootstrapSalt = email => createHmac('sha256', SECRET)
  .update(`itransfer/password-salt/v1:${email.trim().toLowerCase()}`).digest('hex').slice(0, 32);
/** Independent Node implementation of the account-bound native HKDF/HMAC verifier. */
export function verifierFor(id, salt, proof, secret = SECRET) {
  const key = hkdfSync('sha256', secret, 'itransfer/password-verifier/hkdf-salt/v1', 'itransfer/password-verifier/v1', 32);
  const mac = createHmac('sha256', Buffer.from(key))
    .update(JSON.stringify(['client-pbkdf2-sha256-v1', id, salt, proof])).digest('hex');
  return `client-pbkdf2-sha256$600000$${mac}`;
}

export async function fixture(t, { through, forbidR2 = false, databaseOnly = false, forbidPasswordKdf = false, adminPassword = PASSWORD, bindings = {}, outbound } = {}) {
  const bundleKey = JSON.stringify([forbidR2, forbidPasswordKdf]);
  if (!databaseOnly && !bundles.has(bundleKey)) {
    // For authorization-denial tests only, observe and reject *any* bucket call,
    // including HEADs and errors swallowed by cleanup. The real entrypoint and
    // authorization code are unchanged. All other fixtures use real R2 directly.
    const entry = forbidR2 || forbidPasswordKdf ? { stdin: { resolveDir: root, contents: `
      import worker from './src/index.ts';
      let guarded = false;
      export default { ...worker, fetch(request, env, ctx) {
        if (${forbidPasswordKdf} && !guarded) {
          guarded = true;
          for (const method of ['deriveBits', 'deriveKey']) {
            const native = crypto.subtle[method].bind(crypto.subtle);
            Object.defineProperty(crypto.subtle, method, { value: async (algorithm, ...args) => {
              if ((typeof algorithm === 'string' ? algorithm : algorithm.name).toUpperCase() === 'PBKDF2') {
                await env.TEST_KDF_OBSERVER.fetch('https://observer.example.test/' + method);
                throw new Error('Account paths must not run server PBKDF2');
              }
              return native(algorithm, ...args);
            }});
          }
        }
        const BUCKET = ${forbidR2} ? new Proxy(env.BUCKET, { get(target, method) {
          return async (...args) => {
            await env.TEST_R2_OBSERVER.fetch('https://observer.example.test/' + String(method));
            throw new Error('R2 must not be touched before authorization');
          };
        }}) : env.BUCKET;
        return worker.fetch(request, { ...env, BUCKET }, ctx);
      }};
    ` } } : { entryPoints: [root + 'src/index.ts'] };
    bundles.set(bundleKey, build({ ...entry, bundle: true, write: false,
      format: 'esm', platform: 'browser', target: 'es2022' }));
  }
  const script = databaseOnly ? 'export default { fetch() { return new Response("DB-only migration fixture", { status: 501 }); } };'
    : (await bundles.get(bundleKey)).outputFiles[0].text;
  const externalRequests = [];
  const r2Calls = [];
  const passwordKdfCalls = [];
  const mf = new Miniflare({
    modules: true, script, compatibilityDate: '2026-07-14',
    d1Databases: { DB: 'isolated-test-db' }, r2Buckets: ['BUCKET'],
    d1Persist: false, r2Persist: false,
    serviceBindings: { TEST_R2_OBSERVER: request => {
      r2Calls.push(new URL(request.url).pathname);
      return new Response('recorded');
    }, TEST_KDF_OBSERVER: request => {
      passwordKdfCalls.push(new URL(request.url).pathname);
      return new Response('recorded');
    } },
    bindings: { PUBLIC_ORIGIN: ORIGIN, R2_BUCKET_NAME: 'test-files',
      SESSION_SECRET: SECRET, ADMIN_EMAIL: EMAIL, ADMIN_PASSWORD: adminPassword,
      API_BEARER_TOKEN: BEARER, R2_ACCESS_KEY_ID: 'test-access-key',
      R2_SECRET_ACCESS_KEY: 'test-secret-key', R2_ACCOUNT_ID: '0'.repeat(32), ...bindings },
    // No production networking, including notification and signed-R2 traffic.
    outboundService: request => {
      externalRequests.push(request.url);
      if (outbound) return outbound(request);
      return new Response('Unexpected outbound request in test', { status: 599 });
    },
  });
  t.after(() => mf.dispose());
  if (forbidPasswordKdf) t.after(() => assert.deepEqual(passwordKdfCalls, [], 'account requests attempted server-side PBKDF2'));
  const db = await mf.getD1Database('DB');
  const bucket = await mf.getR2Bucket('BUCKET');
  const migrations = (await readdir(root + 'migrations')).filter(n => n.endsWith('.sql')).sort();
  async function migrate(names) {
    for (const name of names) {
      const sql = await readFile(root + 'migrations/' + name, 'utf8');
      const statements = migrationStatements(sql);
      await db.batch(statements.map(statement => db.prepare(statement)));
    }
  }
  await migrate(migrations.filter(n => !through || n <= through));
  async function request(path, { method = 'GET', cookie, body, headers = {} } = {}) {
    const h = new Headers({ Origin: ORIGIN, 'CF-Connecting-IP': '192.0.2.10', ...headers });
    if (cookie) h.set('Cookie', cookie);
    if (body !== undefined && !h.has('Content-Type')) h.set('Content-Type', 'application/json');
    return mf.dispatchFetch(ORIGIN + path, { method, headers: h,
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  }
  async function user({ id = randomUUID(), email = `${id}@example.test`, role = 'user', status = 'active', password = PASSWORD,
    password_salt = randomBytes(16).toString('hex') } = {}) {
    const at = new Date().toISOString();
    const proof = proofFor(password_salt, password);
    await db.prepare('INSERT INTO users(id,email,name,role,status,password_hash,password_salt,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .bind(id, email, `User ${id}`, role, status, status === 'pending' ? null : verifierFor(id, password_salt, proof), password_salt, at, at).run();
    return { id, email, role, status, password_salt, proof };
  }
  async function challenge(identity, options = {}) {
    const response = await request('/api/auth/password-challenge', { ...options, method: 'POST', body: identity });
    const data = await json(response);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.match(data.salt, /^[a-f0-9]{32}$/);
    assert.equal(data.iterations, 600000);
    assert.equal(typeof data.bootstrap, 'boolean');
    assert.deepEqual(Object.keys(data).sort(), ['bootstrap', 'iterations', 'salt']);
    return data;
  }
  async function login(email, password = PASSWORD, options = {}) {
    const data = await challenge({ email });
    return request('/api/auth/login', { ...options, method: 'POST', body: {
      email, proof: proofFor(data.salt, password), ...(data.bootstrap ? { bootstrap_password: password } : {}),
    } });
  }
  async function session(user, { reauthAt = now(), expiresAt = now() + 86400, generation } = {}) {
    const token = randomBytes(32).toString('hex');
    const row = await db.prepare('SELECT session_generation FROM users WHERE id=?').bind(user.id).first();
    await db.prepare('INSERT INTO user_sessions VALUES(?,?,?,?,?,?)')
      .bind(digest(token), user.id, generation ?? row.session_generation, now(), expiresAt, reauthAt).run();
    return `itransfer_session=${token}`;
  }
  async function content(owner, suffix = randomUUID(), { size = 7, confirmed = 1, active = 1 } = {}) {
    const at = new Date().toISOString();
    const share = `share-${suffix}`, req = `request-${suffix}`;
    await db.prepare('INSERT INTO shares(id,title,created_at,owner_user_id,is_active,confirmed_at) VALUES(?,?,?,?,?,?)')
      .bind(share, 'Synthetic share', at, owner?.id ?? null, active, confirmed ? at : null).run();
    await db.prepare('INSERT INTO requests(id,title,created_at,owner_user_id,is_active) VALUES(?,?,?,?,?)')
      .bind(req, 'Synthetic request', at, owner?.id ?? null, active).run();
    const file = `file-${suffix}`, requestFile = `request-file-${suffix}`;
    for (const [id, parent, column] of [[file, share, 'share_id'], [requestFile, req, 'request_id']]) {
      await db.prepare(`INSERT INTO files(id,original_filename,r2_key,file_size,${column},confirmed,created_at) VALUES(?,?,?,?,?,?,?)`)
        .bind(id, 'Résumé 🦦.txt', id, size, parent, confirmed, at).run();
      await bucket.put(id, 'payload');
    }
    return { share, request: req, file, requestFile };
  }
  return { mf, db, bucket, request, user, session, content, challenge, login, externalRequests, r2Calls, passwordKdfCalls, migrate,
    remainingMigrations: migrations.filter(n => through && n > through) };
}

export async function json(response, status = 200) {
  const text = await response.text();
  assert.equal(response.status, status, `${response.url}: ${text}`);
  return JSON.parse(text);
}
export function setupToken(data) {
  const url = new URL(data.setup_url);
  assert.equal(url.origin, ORIGIN);
  assert.equal(url.pathname, '/set-password');
  assert.equal(url.search, '');
  const token = new URLSearchParams(url.hash.slice(1)).get('token');
  assert.match(token, /^[a-f0-9]{64}$/);
  return token;
}
