import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fixture, json, now, ORIGIN, BEARER, proofFor, NEW_PASSWORD, setupToken, digest } from './helpers/worker.mjs';

const bindings = { TRANSACTIONAL_MAIL_API_URL: 'https://mailer.example.test', TRANSACTIONAL_MAIL_API_KEY: 'synthetic-key' };
const accepted = () => Response.json({ status: 'queued', id: 'msg_00000000-0000-4000-8000-000000000001' }, { status: 202 });
const bundle = await build({ entryPoints: ['src/lib/email-preferences.ts'], bundle: true, write: false, format: 'esm', platform: 'browser' });
const { queueOptionalEmail, sendExpiryAlerts } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const defaults = { share_downloads: false, request_uploads: false, password_changed: false, expiry_alerts: false, invitation_reminders: false, welcome: true, password_reset: true };
const enable = (f, user) => f.db.prepare('INSERT INTO user_email_preferences(user_id,share_downloads,request_uploads) VALUES(?,1,1)').bind(user.id).run();
const env = f => ({ DB: f.db, PUBLIC_ORIGIN: ORIGIN, ...bindings });
const event = (resourceId, eventId = crypto.randomUUID()) => ({ kind: 'share_downloads', resourceId, eventId, fileCount: 1 });

test('preferences default off, strict optional booleans only, session/role/CSRF/proof guards', async t => {
  const f = await fixture(t);
  const user = await f.user(), admin = await f.user({ role: 'admin' });
  const cookie = await f.session(user), adminCookie = await f.session(admin);
  const self = '/api/auth/email-preferences', target = `/api/users/${user.id}/email-preferences`;
  assert.deepEqual(await json(await f.request(self, { cookie })), defaults);
  assert.deepEqual(await json(await f.request(target, { cookie: adminCookie })), defaults);
  assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM user_email_preferences').first('n'), 0);
  for (const body of [{ welcome: false }, { password_reset: true }, { email_verification: true }, { share_downloads: 1 }, { request_uploads: null }, { request_uploads: 'true' }, { password_changed: 1 }, { expiry_alerts: null }, { invitation_reminders: 'true' }, {}, { email: 'evil@example.test' }]) {
    await json(await f.request(self, { cookie, method: 'PATCH', body }), 400);
    // Clear admin limiter between validation cases: each is an independent validation assertion.
    await f.db.prepare('DELETE FROM auth_attempts').run();
    await json(await f.request(target, { cookie: adminCookie, method: 'PATCH', body }), 400);
  }
  await f.db.prepare('DELETE FROM auth_attempts').run();
  assert.deepEqual(await json(await f.request(self, { cookie, method: 'PATCH', body: { share_downloads: true } })), { ...defaults, share_downloads: true });
  assert.deepEqual(await json(await f.request(target, { cookie: adminCookie, method: 'PATCH', body: { request_uploads: true } })), { ...defaults, share_downloads: true, request_uploads: true });
  const extra = { password_changed: true, expiry_alerts: true, invitation_reminders: true };
  assert.deepEqual(await json(await f.request(self, { cookie, method: 'PATCH', body: extra })), { ...defaults, share_downloads: true, request_uploads: true, ...extra });
  await json(await f.request(target, { cookie }), 403);
  await json(await f.request(self), 401);
  await json(await f.request(self, { cookie, method: 'PATCH', headers: { 'X-Expected-User': admin.id }, body: { share_downloads: false } }), 401);
  await json(await f.request(target, { cookie: adminCookie, method: 'PATCH', headers: { 'X-Expected-User': user.id }, body: { share_downloads: false } }), 401);
  await json(await f.request(self, { cookie, method: 'PATCH', headers: { Origin: 'https://evil.example.test' }, body: { share_downloads: false } }), 403);
  await json(await f.request(target, { cookie: await f.session(admin, { reauthAt: now() - 600 }), method: 'PATCH', body: { share_downloads: false } }), 403);
  await json(await f.request(self, { cookie: await f.session(user, { generation: 99 }), method: 'PATCH', body: { share_downloads: false } }), 401);
  await json(await f.request(self, { cookie: await f.session(user, { expiresAt: now() - 1 }), method: 'PATCH', body: { share_downloads: false } }), 401);
  await assert.rejects(f.db.prepare('UPDATE user_email_preferences SET share_downloads=2').run());
});

test('mandatory welcome and reset stay enabled with all optional preferences off', async t => {
  const sent = [];
  const f = await fixture(t, { bindings, outbound: async req => { sent.push(await req.json()); return accepted(); } });
  const admin = await f.user({ role: 'admin' }), cookie = await f.session(admin);
  const created = await json(await f.request('/api/users', { cookie, method: 'POST', body: { name: 'Pat', email: 'pat@example.test' } }), 201);
  await json(await f.request(`/api/users/${created.user.id}/email-preferences`, { cookie, method: 'PATCH', body: { share_downloads: false, request_uploads: false, password_changed: false, expiry_alerts: false, invitation_reminders: false } }));
  for (let i = 0; i < 10; i++) await f.db.prepare('INSERT INTO notification_claims VALUES(?,?,?)').bind(`full-${i}`, admin.id, now()).run();
  await json(await f.request(`/api/users/${created.user.id}/reset-password`, { cookie, method: 'POST' }));
  assert.equal(sent.length, 2);
  for (const body of sent) { assert.equal(body.html, undefined); assert.equal(body.to, created.user.email); }
});

test('only current opted-in active owner receives plain text; event dedup and simultaneous per-owner admission', async t => {
  const f = await fixture(t, { databaseOnly: true });
  const sent = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => { sent.push(JSON.parse(init.body)); return accepted(); });
  const owner = await f.user(), resource = await f.content(owner);
  assert.equal(await queueOptionalEmail(env(f), event(resource.share)), 'suppressed');
  await enable(f, owner);
  await Promise.all(Array.from({ length: 12 }, () => queueOptionalEmail(env(f), event(resource.share))));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, owner.email);
  assert.equal(sent[0].html, undefined);
  assert.ok(sent[0].text.includes(`${ORIGIN}/shares/${resource.share}`));
  assert.ok(!sent[0].text.includes('192.0.2.10'));
  const key = await f.db.prepare('SELECT event_key FROM notification_claims').first('event_key');
  assert.match(key, /^[a-f0-9]{64}$/);
  await f.db.prepare('DELETE FROM notification_claims').run();
  const same = event(resource.share);
  await queueOptionalEmail(env(f), same);
  await f.db.prepare('UPDATE notification_claims SET created_at=?').bind(now() - 301).run();
  await queueOptionalEmail(env(f), same);
  assert.equal(sent.length, 2, 'dedup survives cooldown');
  await f.db.prepare("UPDATE users SET status='disabled' WHERE id=?").bind(owner.id).run();
  assert.equal(await queueOptionalEmail(env(f), event(resource.share)), 'suppressed');
});

test('hourly owner quota and global daily quota use atomic claims', async t => {
  const f = await fixture(t, { databaseOnly: true });
  const sent = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => { sent.push(JSON.parse(init.body)); return accepted(); });
  const owner = await f.user(), resource = await f.content(owner);
  await enable(f, owner);
  for (let i = 0; i < 5; i++) await f.db.prepare('INSERT INTO notification_claims VALUES(?,?,?)').bind(`prior-${i}`, owner.id, now() - 301 - i).run();
  assert.equal(await queueOptionalEmail(env(f), event(resource.share)), 'suppressed');
  await f.db.prepare('DELETE FROM notification_claims').run();
  const owners = [];
  for (let i = 0; i < 12; i++) {
    const u = await f.user(); await enable(f, u); owners.push(await f.content(u));
  }
  await Promise.all(owners.map(r => queueOptionalEmail(env(f), event(r.share))));
  assert.equal(sent.length, 10);
  assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM notification_claims').first('n'), 10);
});

test('public confirmation sends only newly flipped files once; authenticated API views do not notify', async t => {
  const sent = [];
  const f = await fixture(t, { bindings, outbound: async req => { sent.push(await req.json()); return accepted(); } });
  const owner = await f.user({ role: 'admin' }); await enable(f, owner);
  await f.db.prepare("INSERT INTO app_settings VALUES('bootstrap_admin_id',?)").bind(owner.id).run();
  const r = await f.content(owner, undefined, { confirmed: 0 });
  const url = `/api/public/requests/${r.request}/confirm`;
  await json(await f.request(url, { method: 'POST', body: { file_ids: [r.requestFile] } }));
  for (let i = 0; i < 100 && !sent.length; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, owner.email);
  assert.match(sent[0].text, /Files: 1/);
  await json(await f.request(url, { method: 'POST', body: { file_ids: [r.requestFile] } }));
  await json(await f.request(`/api/requests/${r.request}`, { cookie: await f.session(owner) }));
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(sent.length, 1);
});

test('share previews stay silent; real web/API downloads notify, failed admission remains best effort', async t => {
  const sent = [];
  const f = await fixture(t, { bindings, outbound: async req => { sent.push(await req.json()); return accepted(); } });
  const owner = await f.user({ role: 'admin' }); await enable(f, owner);
  await f.db.prepare("INSERT INTO app_settings VALUES('bootstrap_admin_id',?)").bind(owner.id).run();
  const r = await f.content(owner), cookie = await f.session(owner);
  const headers = { Authorization: `Bearer ${BEARER}` };
  await json(await f.request(`/api/public/shares/${r.share}`));
  await json(await f.request(`/api/shares/${r.share}`, { cookie }));
  await json(await f.request(`/api/v1/shares/${r.share}`, { headers }));
  assert.equal(sent.length, 0);
  await json(await f.request(`/api/public/shares/${r.share}/download`, { method: 'POST', body: {} }));
  for (let i = 0; i < 100 && sent.length < 1; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(sent.length, 1);
  await f.db.prepare('UPDATE notification_claims SET created_at=?').bind(now() - 301).run();
  await json(await f.request(`/api/v1/shares/${r.share}/download`, { method: 'POST', headers }));
  for (let i = 0; i < 100 && sent.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(sent.length, 2);
  assert.ok(sent.every(body => body.to === owner.email && body.html === undefined));
  await f.db.prepare('DROP TABLE notification_claims').run();
  await json(await f.request(`/api/public/shares/${r.share}/download`, { method: 'POST', body: {} }));
});

test('legacy null owner uses only bootstrap marker; opt-out after admission is rechecked', async t => {
  const f = await fixture(t, { databaseOnly: true });
  let sent = 0;
  t.mock.method(globalThis, 'fetch', async () => { sent++; return accepted(); });
  const owner = await f.user({ role: 'admin' }), r = await f.content(null);
  await enable(f, owner);
  assert.equal(await queueOptionalEmail(env(f), event(r.share)), 'suppressed');
  await f.db.prepare("INSERT INTO app_settings VALUES('bootstrap_admin_id',?)").bind(owner.id).run();
  assert.equal(await queueOptionalEmail(env(f), event(r.share)), 'attempted');
  assert.equal(sent, 1);
  await f.db.prepare('DELETE FROM notification_claims').run();
  const DB = { prepare(sql) {
    const stmt = f.db.prepare(sql);
    if (!sql.startsWith('INSERT INTO notification_claims')) return stmt;
    return { bind(...values) { const bound = stmt.bind(...values); return { async first() {
      const result = await bound.first();
      await f.db.prepare('UPDATE user_email_preferences SET share_downloads=0 WHERE user_id=?').bind(owner.id).run();
      return result;
    } }; } };
  } };
  assert.equal(await queueOptionalEmail({ ...env(f), DB }, event(r.share)), 'suppressed');
  assert.equal(sent, 1);
});

async function waitForCount(sent, count) {
  for (let i = 0; i < 100 && sent.length < count; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(sent.length, count);
}

test('password-change opt-in notifies owner after revoked session, active reset only; initial setup and default-off silent', async t => {
  const sent = [];
  const f = await fixture(t, { bindings, outbound: async req => { sent.push(await req.json()); return accepted(); } });
  const owner = await f.user(), pending = await f.user({ status: 'pending' }), disabled = await f.user();
  for (const u of [owner, pending]) await f.db.prepare('INSERT INTO user_email_preferences(user_id,password_changed) VALUES(?,1)').bind(u.id).run();
  const cookie = await f.session(owner);
  await json(await f.request('/api/auth/password', { cookie, method: 'POST', body: { current_proof: owner.proof, new_proof: proofFor(owner.password_salt, NEW_PASSWORD) } }));
  await waitForCount(sent, 1);
  assert.equal(sent[0].subject, 'Your iTransfer password was changed');
  assert.equal(sent[0].to, owner.email);
  assert.equal(sent[0].html, undefined);
  assert.match(sent[0].text, /Changed at: \d{4}-\d{2}-\d{2}T/);
  assert.ok(sent[0].text.includes(`${ORIGIN}/login`));
  assert.match(sent[0].text, /unexpected, contact your administrator/);
  for (const secret of [owner.proof, NEW_PASSWORD, 'set-password', '#token=']) assert.ok(!sent[0].text.includes(secret));
  await json(await f.request('/api/auth/me', { cookie }), 401);
  await f.db.prepare('UPDATE notification_claims SET created_at=?').bind(now() - 301).run();
  for (const [u, count] of [[pending, 1], [owner, 2], [disabled, 2]]) {
    const token = crypto.randomUUID().replaceAll('-', '').repeat(2);
    await f.db.prepare('INSERT INTO password_tokens VALUES(?,?,?,?)').bind(digest(token), u.id, now() + 3600, now()).run();
    await json(await f.request('/api/auth/setup-password', { method: 'POST', body: { token, proof: u.proof } }));
    await waitForCount(sent, count);
  }
  await json(await f.request('/api/auth/password', { cookie: await f.session(disabled), method: 'POST',
    body: { current_proof: disabled.proof, new_proof: proofFor(disabled.password_salt, NEW_PASSWORD) } }));
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(sent.length, 2);
});

test('invitation reminder requires pending opt-in and proof; quota denial never rotates token; local plaintext only', async t => {
  const sent = [];
  const f = await fixture(t, { bindings, outbound: async req => { sent.push({ body: await req.json(), key: req.headers.get('idempotency-key') }); return accepted(); } });
  const admin = await f.user({ role: 'admin' }), target = await f.user({ status: 'pending' }), active = await f.user();
  const cookie = await f.session(admin), path = `/api/users/${target.id}/invitation`;
  const original = 'a'.repeat(64);
  await f.db.prepare('INSERT INTO password_tokens VALUES(?,?,?,?)').bind(digest(original), target.id, now() + 3600, now()).run();
  const stored = () => f.db.prepare('SELECT token_hash FROM password_tokens WHERE user_id=?').bind(target.id).first('token_hash');
  await json(await f.request(path, { cookie, method: 'POST' }), 409);
  assert.equal(await stored(), digest(original));
  await f.db.prepare('INSERT INTO user_email_preferences(user_id,invitation_reminders) VALUES(?,1)').bind(target.id).run();
  await json(await f.request(path, { cookie: await f.session(active), method: 'POST' }), 403);
  await json(await f.request(path, { cookie: await f.session(admin, { reauthAt: now() - 600 }), method: 'POST' }), 403);
  await json(await f.request(`/api/users/${active.id}/invitation`, { cookie, method: 'POST' }), 409);
  assert.equal(await stored(), digest(original));
  const result = await json(await f.request(path, { cookie, method: 'POST' }));
  assert.equal(result.mail.status, 'queued');
  assert.notEqual(await stored(), digest(original));
  assert.equal(await stored(), digest(setupToken(result)));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.subject, 'Your invitation to iTransfer');
  assert.equal(sent[0].body.html, undefined);
  assert.equal(sent[0].body.to, target.email);
  assert.match(sent[0].body.text, /24-hour setup window/);
  assert.ok(sent[0].body.text.includes(`User ${admin.id}`));
  assert.ok(sent[0].body.text.includes(result.setup_url));
  assert.match(sent[0].key, /^itransfer.invitation\.[a-f0-9]{64}$/);
  const issuedHash = await stored();
  const denied = await f.request(path, { cookie, method: 'POST' });
  assert.equal(denied.headers.get('Retry-After'), '300');
  await json(denied, 429);
  assert.equal(await stored(), issuedHash);
  assert.equal(sent.length, 1);
  assert.equal(await f.db.prepare("SELECT COUNT(*) AS n FROM account_audit WHERE action='account.invitation_issued'").first('n'), 1);
  await f.db.prepare('DELETE FROM notification_claims').run();
  await f.db.prepare('DELETE FROM auth_attempts').run();
  for (let i = 0; i < 10; i++) await f.db.prepare('INSERT INTO notification_claims VALUES(?,?,?)').bind(`global-${i}`, admin.id, now()).run();
  await json(await f.request(path, { cookie, method: 'POST' }), 429);
  assert.equal(await stored(), issuedHash, 'global quota denial preserves the link too');
});

test('expiry alerts: default-off silent, active owners only, exact deadline dedup, title sanitized, share/request namespaces', async t => {
  const sent = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => { sent.push(JSON.parse(init.body)); return accepted(); });
  const f = await fixture(t, { databaseOnly: true });
  const owner = await f.user(), r = await f.content(owner);
  const expiry = new Date(Date.now() + 3600000).toISOString();
  await f.db.prepare('UPDATE shares SET expires_at=?,title=? WHERE id=?').bind(expiry, '<Title>\r\n\u202e', r.share).run();
  await f.db.prepare('UPDATE requests SET expires_at=? WHERE id=?').bind(expiry, r.request).run();
  await sendExpiryAlerts(env(f)); assert.equal(sent.length, 0);
  await f.db.prepare('INSERT INTO user_email_preferences(user_id,expiry_alerts) VALUES(?,1)').bind(owner.id).run();
  await sendExpiryAlerts(env(f)); assert.equal(sent.length, 1);
  assert.equal(sent[0].to, owner.email); assert.equal(sent[0].html, undefined);
  assert.equal(sent[0].subject, 'Transfer expires soon');
  assert.ok(sent[0].text.includes(expiry));
  await f.db.prepare('UPDATE notification_claims SET created_at=?').bind(now() - 301).run();
  await sendExpiryAlerts(env(f)); assert.equal(sent.length, 2);
  const shareMail = sent.find(mail => mail.text.includes('Type: share'));
  assert.ok(shareMail.text.includes(`${ORIGIN}/shares/${r.share}`));
  assert.ok(shareMail.text.includes('<Title>   '));
  assert.ok(!shareMail.text.includes('\u202e'));
  await f.db.prepare('UPDATE notification_claims SET created_at=?').bind(now() - 301).run();
  await sendExpiryAlerts(env(f)); assert.equal(sent.length, 2);
  const later = new Date(Date.now() + 7200000).toISOString();
  await f.db.prepare('UPDATE shares SET expires_at=? WHERE id=?').bind(later, r.share).run();
  await sendExpiryAlerts(env(f)); assert.equal(sent.length, 3);
  assert.ok(sent[2].text.includes(later));
  await f.db.prepare('UPDATE notification_claims SET created_at=?').bind(now() - 301).run();
  await f.db.prepare("UPDATE users SET status='disabled' WHERE id=?").bind(owner.id).run();
  await f.db.prepare('UPDATE shares SET expires_at=? WHERE id=?').bind(expiry, r.share).run();
  await sendExpiryAlerts(env(f)); assert.equal(sent.length, 3);
});

test('expiry selection is bounded to 20 and ignores expired, distant, inactive and unconfirmed resources', async t => {
  const f = await fixture(t, { databaseOnly: true });
  const owner = await f.user(); await f.db.prepare('INSERT INTO user_email_preferences(user_id,expiry_alerts) VALUES(?,1)').bind(owner.id).run();
  const future = new Date(Date.now() + 3600000).toISOString();
  for (let i = 0; i < 25; i++) { const r = await f.content(owner, `expiry-${i}`); await f.db.prepare('UPDATE shares SET expires_at=? WHERE id=?').bind(future, r.share).run(); }
  const invalid = await f.content(owner, 'invalid');
  await f.db.prepare('UPDATE shares SET expires_at=?,confirmed_at=NULL WHERE id=?').bind(future, invalid.share).run();
  await f.db.prepare('UPDATE requests SET expires_at=?,is_active=0 WHERE id=?').bind(future, invalid.request).run();
  const expired = await f.content(owner, 'past'), distant = await f.content(owner, 'distant');
  await f.db.prepare('UPDATE shares SET expires_at=? WHERE id=?').bind(new Date(Date.now() - 3600000).toISOString(), expired.share).run();
  await f.db.prepare('UPDATE shares SET expires_at=? WHERE id=?').bind(new Date(Date.now() + 172800000).toISOString(), distant.share).run();
  let candidates;
  const DB = { prepare(sql) {
    const stmt = f.db.prepare(sql);
    if (!sql.includes('UNION ALL SELECT')) return stmt;
    return { bind(...values) { return { async all() { const result = await stmt.bind(...values).all(); candidates = result.results; return { results: [] }; } }; } };
  } };
  await sendExpiryAlerts({ ...env(f), DB });
  assert.equal(candidates.length, 20);
  assert.ok(candidates.every(r => r.kind === 'share' && ![invalid.share, expired.share, distant.share].includes(r.id)));
});
