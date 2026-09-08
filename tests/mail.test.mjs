import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fixture, json, setupToken, digest, now, ORIGIN } from './helpers/worker.mjs';

const API = 'https://mailer.example.test';
const KEY = 'synthetic-mail-test-key';
const ID = 'msg_00000000-0000-4000-8000-000000000001';
const bindings = { TRANSACTIONAL_MAIL_API_URL: API, TRANSACTIONAL_MAIL_API_KEY: KEY };
const bundle = await build({ entryPoints: ['src/lib/mail.ts'], bundle: true, write: false, format: 'esm', platform: 'browser' });
const { queueAccountEmail, accountSetupUrl } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const input = (overrides = {}) => ({ kind: 'welcome', name: '<Pat & "Lee">', email: 'pat@example.test', token: 'a'.repeat(64), tokenHash: digest('a'.repeat(64)), expiresAt: now() + 86400, ...overrides });
const accepted = (status = 'queued', id = ID) => Response.json({ status, id }, { status: 202 });
const submit = (overrides = {}, env = {}) => queueAccountEmail({ PUBLIC_ORIGIN: ORIGIN, ...bindings, ...env }, input(overrides));

async function admin(f) { const actor = await f.user({ role: 'admin' }); return f.session(actor); }
async function create(f, cookie, overrides = {}) {
  return json(await f.request('/api/users', { method: 'POST', cookie,
    body: { name: '<Pat & "Lee">', email: 'pat@example.test', ...overrides } }), 201);
}

test('welcome after commit: recipient, workflow, escaping, fragment link, durable key and secret-free audit', async t => {
  const captured = [];
  const logs = [];
  t.mock.method(console, 'warn', (...args) => logs.push(args.join(' ')));
  const f = await fixture(t, { bindings, outbound: async request => {
    assert.equal(request.url, API + '/v1/emails');
    captured.push({ body: await request.json(), headers: request.headers });
    return accepted();
  } });
  const cookie = await admin(f);
  const result = await create(f, cookie);
  const token = setupToken(result);
  assert.deepEqual(result.mail, { status: 'queued', message_id: ID });
  assert.equal(captured.length, 1);
  const { body, headers } = captured[0];
  assert.deepEqual(Object.keys(body).sort(), ['expires_at', 'subject', 'text', 'to']);
  assert.equal(body.to, result.user.email);
  assert.equal(body.subject, 'Welcome to iTransfer');
  assert.equal(headers.get('authorization'), `Bearer ${KEY}`);
  assert.equal(headers.get('idempotency-key'), `itransfer.welcome.${digest(token)}`);
  assert.match(headers.get('idempotency-key'), /^[A-Za-z0-9._:-]{8,128}$/);
  assert.ok(body.text.includes(result.setup_url));
  assert.equal(body.html, undefined);
  assert.ok(body.text.includes(result.expires_at));
  assert.ok(body.text.includes('<Pat & "Lee">'));
  assert.ok(!body.text.includes('&lt;'));
  for (const phrase of ['Share files:', 'Request files:', 'do not need an account', 'other users cannot see', 'Administrators can manage', 'people with the link unless protected', 'then log in', 'one-use']) assert.ok(body.text.includes(phrase), phrase);
  assert.ok(Date.parse(body.expires_at) <= Date.now() + 900000);
  assert.ok(Date.parse(body.expires_at) > Date.now() + 890000);
  assert.ok(Date.parse(result.expires_at) > Date.now() + 86300000);
  const stored = await f.db.prepare('SELECT * FROM password_tokens WHERE user_id=?').bind(result.user.id).first();
  assert.equal(stored.token_hash, digest(token));
  const audit = (await f.db.prepare('SELECT * FROM account_audit').all()).results;
  assert.equal(audit.find(r => r.action === 'account.mail_queued').detail, ID);
  const safe = JSON.stringify({ audit, stored, logs, mail: result.mail });
  for (const secret of [KEY, token, result.user.email]) assert.ok(!safe.includes(secret));
  assert.ok(!JSON.stringify(result).includes(KEY));
});

test('reset mail is administrator initiated, one-hour, bound to current token; failure never rolls back', async t => {
  const sent = [];
  const f = await fixture(t, { bindings, outbound: async req => { sent.push({ body: await req.json(), key: req.headers.get('idempotency-key') }); return new Response(KEY, { status: 429 }); } });
  const cookie = await admin(f);
  const target = await f.user();
  await f.session(target);
  const result = await json(await f.request(`/api/users/${target.id}/reset-password`, { method: 'POST', cookie }));
  const token = setupToken(result);
  assert.deepEqual(result.mail, { status: 'failed', error_code: 'quota' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.to, target.email);
  assert.equal(sent[0].key, `itransfer.reset.${digest(token)}`);
  assert.match(sent[0].body.text, /administrator initiated/);
  assert.match(sent[0].body.text, /one-use/);
  assert.ok(sent[0].body.text.includes(result.expires_at));
  assert.doesNotMatch(sent[0].body.text, /Share files|delivered/);
  assert.ok(Date.parse(result.expires_at) <= Date.now() + 3600000);
  assert.ok(Date.parse(result.expires_at) > Date.now() + 3590000);
  assert.equal((await f.db.prepare('SELECT token_hash FROM password_tokens WHERE user_id=?').bind(target.id).first()).token_hash, digest(token));
  assert.equal((await f.db.prepare('SELECT session_generation FROM users WHERE id=?').bind(target.id).first()).session_generation, 1);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM user_sessions WHERE user_id=?').bind(target.id).first()).n, 0);
});

test('disabled integration and partial/bad configuration preserve accounts and manual recovery', async t => {
  for (const [config, status] of [[{}, 'not_configured'], [{ TRANSACTIONAL_MAIL_API_KEY: KEY }, 'failed'], [{ ...bindings, TRANSACTIONAL_MAIL_API_URL: 'http://mailer.example.test' }, 'failed']]) {
    await t.test(status + JSON.stringify(Object.keys(config)), async t => {
      const f = await fixture(t, { bindings: config });
      const result = await create(f, await admin(f));
      assert.equal(result.mail.status, status);
      setupToken(result);
      assert.equal((await f.db.prepare('SELECT status FROM users WHERE id=?').bind(result.user.id).first()).status, 'pending');
      assert.deepEqual(f.externalRequests, []);
    });
  }
});

test('nonadmins cannot create/reset or trigger mail; Unicode account email remains stored but is not mailed', async t => {
  const f = await fixture(t, { bindings });
  const user = await f.user();
  const cookie = await f.session(user);
  for (const path of ['/api/users', `/api/users/${user.id}/reset-password`]) {
    assert.equal((await f.request(path, { method: 'POST', cookie, body: {} })).status, 403);
  }
  const result = await create(f, await admin(f), { email: 'pát@example.test' });
  assert.deepEqual(result.mail, { status: 'failed', error_code: 'invalid_recipient' });
  assert.equal(result.user.email, 'pát@example.test');
  assert.deepEqual(f.externalRequests, []);
});

test('post-commit stale token is not emailed; audit write failure does not turn success into 500', async t => {
  const f = await fixture(t, { bindings, outbound: () => accepted() });
  const cookie = await admin(f);
  const target = await f.user();
  await f.db.prepare(`CREATE TRIGGER test_stale AFTER INSERT ON account_audit WHEN NEW.action='account.reset_issued'
    BEGIN DELETE FROM password_tokens WHERE user_id=NEW.target_id; END`).run();
  const reset = await json(await f.request(`/api/users/${target.id}/reset-password`, { method: 'POST', cookie }));
  assert.deepEqual(reset.mail, { status: 'failed', error_code: 'expired' });
  assert.deepEqual(f.externalRequests, []);
  await f.db.prepare(`CREATE TRIGGER test_audit_fail BEFORE INSERT ON account_audit WHEN NEW.action='account.mail_queued'
    BEGIN SELECT RAISE(FAIL, 'synthetic audit failure'); END`).run();
  const result = await create(f, cookie);
  assert.equal(result.mail.status, 'queued');
});

test('Workers manual redirect rejection never contacts the redirect target or rolls back creation', async t => {
  const f = await fixture(t, { bindings, outbound: req => {
    assert.equal(req.url, API + '/v1/emails');
    return new Response(null, { status: 307, headers: { Location: 'https://untrusted.example.test/steal' } });
  } });
  const result = await create(f, await admin(f));
  assert.deepEqual(result.mail, { status: 'failed', error_code: 'redirect_rejected' });
  assert.equal(result.user.status, 'pending');
  assert.deepEqual(f.externalRequests, [API + '/v1/emails']);
});

test('origin/configuration and ASCII recipient validation fail closed without network', async t => {
  t.mock.method(globalThis, 'fetch', () => { assert.fail('unexpected network'); });
  for (const invalid of ['http://example.test', 'https://u:p@example.test', 'https://@example.test', 'https://example.test/path', 'https://example.test/a/..', 'https://example.test/?q=1', 'https://example.test/#x', 'https://example.test?', 'https://example.test#', ' https://example.test', 'https://example.test\\evil', '']) {
    assert.equal(accountSetupUrl(invalid, input().token), null);
    assert.equal((await submit({}, { TRANSACTIONAL_MAIL_API_URL: invalid })).error_code, 'invalid_config');
    assert.equal((await submit({}, { PUBLIC_ORIGIN: invalid })).error_code, 'invalid_public_origin');
  }
  assert.equal(accountSetupUrl(ORIGIN + '/', input().token), ORIGIN + '/set-password#token=' + input().token);
  for (const email of ['é@example.test', 'a@example.test,b@example.test', 'x\r\n@example.test', 'a..b@example.test', 'a@localhost']) assert.equal((await submit({ email })).error_code, 'invalid_recipient');
  assert.equal((await submit({}, { TRANSACTIONAL_MAIL_API_KEY: 'bad\r\nkey' })).error_code, 'invalid_config');
  assert.equal((await submit({ expiresAt: now() + 59 })).error_code, 'expired');
});

test('plain-text names are bounded and control sanitized, not HTML escaped', async t => {
  let body;
  t.mock.method(globalThis, 'fetch', async (_url, init) => { body = JSON.parse(init.body); return accepted(); });
  assert.equal((await submit({ name: '<Pat>\r\n\u202e' + 'x'.repeat(50001) })).status, 'queued');
  assert.equal(body.html, undefined);
  assert.match(body.text, /Hi <Pat>   x/);
  assert.ok(body.text.length < 3000);
  assert.ok(!body.text.includes('\u202e'));
});

test('202 statuses are submission outcomes only, with strict IDs and no remote echo or retry', async t => {
  for (const [remote, local] of [['queued', 'queued'], ['sending', 'queued'], ['submitted', 'queued'], ['unknown', 'unknown'], ['failed', 'failed'], ['expired', 'failed'], ['delivered', 'unknown'], [KEY, 'unknown'], [{ toString: null }, 'unknown']]) {
    const mock = t.mock.method(globalThis, 'fetch', async () => accepted(remote));
    const result = await submit();
    assert.equal(result.status, local);
    assert.equal(result.message_id, ID);
    assert.ok(!JSON.stringify(result).includes(KEY));
    assert.equal(mock.mock.callCount(), 1);
    mock.mock.restore();
  }
  for (const id of [KEY, ID + input().token, 'msg_not-a-uuid', undefined]) {
    const mock = t.mock.method(globalThis, 'fetch', async () => Response.json({ id, status: 'queued', secret: KEY }, { status: 202 }));
    assert.deepEqual(await submit(), { status: 'unknown', error_code: 'submission_uncertain' });
    mock.mock.restore();
  }
});

test('network and 5xx replay at most once with identical frozen body/key and redirect:error', async t => {
  for (const mode of ['network', '5xx', 'both-fail', 'timeout']) {
    const calls = [];
    const mock = t.mock.method(globalThis, 'fetch', async (url, options) => {
      calls.push({ url, ...options });
      if (calls.length === 1 || mode === 'both-fail') {
        if (mode === 'timeout') return new Promise(() => {});
        if (mode === 'network') throw new Error(KEY + input().token);
        return new Response(KEY, { status: 503 });
      }
      return accepted();
    });
    const start = Date.now();
    const result = await submit();
    assert.equal(result.status, mode === 'both-fail' ? 'unknown' : 'queued');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].body, calls[1].body);
    assert.deepEqual(calls[0].headers, calls[1].headers);
    for (const call of calls) { assert.equal(call.redirect, 'error'); assert.ok(call.signal instanceof AbortSignal); assert.equal(call.url, API + '/v1/emails'); }
    if (mode === 'timeout') { assert.ok(Date.now() - start >= 4000); assert.ok(calls[0].signal.aborted); }
    mock.mock.restore();
  }
});

test('definitive 4xx never retries or returns provider errors; short queue expiry is frozen before token expiry', async t => {
  for (const [status, code] of [[400, 'invalid_request'], [401, 'unauthorized'], [403, 'forbidden'], [409, 'idempotency_conflict'], [429, 'quota']]) {
    const mock = t.mock.method(globalThis, 'fetch', async () => new Response(KEY + input().token, { status }));
    assert.deepEqual(await submit(), { status: 'failed', error_code: code });
    assert.equal(mock.mock.callCount(), 1);
    mock.mock.restore();
  }
  const expiry = now() + 120;
  t.mock.method(globalThis, 'fetch', async (_, options) => {
    assert.equal(JSON.parse(options.body).expires_at, new Date((expiry - 60) * 1000).toISOString());
    return accepted();
  });
  assert.equal((await submit({ expiresAt: expiry })).status, 'queued');
});

test('oversized and malformed 202 bodies are bounded and uncertain without retry', async t => {
  for (const body of ['x'.repeat(4097), '{', JSON.stringify({ id: ID, status: 'queued', extra: 'x'.repeat(4096) })]) {
    let cancelled = false;
    const mock = t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(body)); if (body.length <= 4096) controller.close(); },
      cancel() { cancelled = true; },
    }), { status: 202 }));
    assert.equal((await submit()).status, 'unknown');
    assert.equal(mock.mock.callCount(), 1);
    if (body.length > 4096) assert.ok(cancelled);
    mock.mock.restore();
  }
});

test('stalled response body deadline cancels the stream and safely replays once', async t => {
  let cancelled = false;
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (_, options) => {
    calls.push(options);
    if (calls.length === 2) return accepted();
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{')); },
      cancel() { cancelled = true; },
    }), { status: 202 });
  });
  assert.equal((await submit()).status, 'queued');
  assert.ok(cancelled);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body, calls[1].body);
});

test('a rejected replay cannot disprove earlier uncertain acceptance', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: ++calls === 1 ? 503 : 401 }));
  assert.deepEqual(await submit(), { status: 'unknown', error_code: 'submission_uncertain' });
  assert.equal(calls, 2);
});

test('two remote failures preserve created account and token and audit only the unknown outcome', async t => {
  const f = await fixture(t, { bindings, outbound: () => new Response(KEY, { status: 503 }) });
  const result = await create(f, await admin(f));
  const token = setupToken(result);
  assert.deepEqual(result.mail, { status: 'unknown', error_code: 'submission_uncertain' });
  assert.equal(f.externalRequests.length, 2);
  assert.equal((await f.db.prepare('SELECT token_hash FROM password_tokens WHERE user_id=?').bind(result.user.id).first()).token_hash, digest(token));
  const audit = await f.db.prepare("SELECT detail FROM account_audit WHERE action='account.mail_unknown'").first();
  assert.equal(audit.detail, null);
});
