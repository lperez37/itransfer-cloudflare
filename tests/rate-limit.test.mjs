import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { fixture as baseFixture, json, setupToken, SECRET, NEW_PASSWORD, now, digest, proofFor } from './helpers/worker.mjs';
const fixture = t => baseFixture(t, { forbidPasswordKdf: true });

const pseudonym = text => createHmac('sha256', SECRET).update(text).digest('hex');
async function attempts(f, { policy = 'login', identity, dimension = 'account', count, age = 0 }) {
  const ip = pseudonym(`${policy}:ip:192.0.2.10`);
  const account = pseudonym(`${policy}:account:${identity}`);
  // One fixture-only statement seeds the same exact ledger rows without
  // hundreds of Miniflare RPCs. Admission itself always uses the real route.
  await f.db.prepare(`WITH RECURSIVE sequence(i) AS (
      SELECT 0 WHERE ?>0 UNION ALL SELECT i+1 FROM sequence WHERE i+1<?
    ) INSERT INTO auth_attempts(ip_key,account_key,at)
    SELECT CASE WHEN ?='ip' THEN ? ELSE 'other-ip-'||i END,
      CASE WHEN ?='account' THEN ? ELSE 'other-account-'||i END, ? FROM sequence`)
    .bind(count, count, dimension, ip, dimension, account, now() - age).run();
}

test('login account 8/15m and 20/hr, IP 30/15m and 100/hr quotas deny without admission', async t => {
  const f = await fixture(t);
  const member = await f.user();
  for (const [dimension, count, age] of [['account', 8, 0], ['account', 20, 1000], ['ip', 30, 0], ['ip', 100, 1000]]) {
    await f.db.prepare('DELETE FROM auth_attempts').run();
    await attempts(f, { identity: member.email, dimension, count, age });
    const r = await f.request('/api/auth/login', { method: 'POST', body: { email: member.email, proof: member.proof } });
    await json(r, 429);
    assert.equal(r.headers.get('Retry-After'), '900');
    assert.equal(r.headers.get('Cache-Control'), 'no-store');
    assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM auth_attempts').first('n'), count);
  }
});

test('concurrent logins compete atomically for the final account admission', async t => {
  const f = await fixture(t), member = await f.user();
  await attempts(f, { identity: member.email, count: 7 });
  const responses = await Promise.all([1, 2].map(() => f.request('/api/auth/login', {
    method: 'POST', body: { email: member.email, proof: member.proof },
  })));
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 429]);
  assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM auth_attempts').first('n'), 8);
  assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM user_sessions').first('n'), 1);
});

test('login exhaustion cannot block an existing administrator reauth/invite or a valid reset token', async t => {
  const f = await fixture(t);
  const admin = await f.user({ role: 'admin' }), cookie = await f.session(admin, { reauthAt: now() - 301 });
  const member = await f.user();
  await attempts(f, { identity: admin.email, count: 8 });
  await attempts(f, { identity: member.email, count: 8 });
  await attempts(f, { dimension: 'ip', identity: admin.email, count: 30 });
  await attempts(f, { policy: 'recovery-invalid', dimension: 'ip', identity: 'invalid-setup-token', count: 10 });
  await json(await f.request('/api/auth/login', { method: 'POST', body: { email: admin.email, proof: admin.proof } }), 429);
  assert.equal((await f.challenge({ email: admin.email })).salt, admin.password_salt);
  await json(await f.request('/api/auth/reauth', { method: 'POST', cookie, body: { proof: admin.proof } }));
  const invite = await json(await f.request('/api/users', { method: 'POST', cookie,
    body: { name: 'Recovery test', email: 'recovery@example.test' } }), 201);
  assert.ok(setupToken(invite));
  const reset = await json(await f.request(`/api/users/${member.id}/reset-password`, { method: 'POST', cookie }));
  const token = setupToken(reset);
  const { salt } = await f.challenge({ token });
  await json(await f.request('/api/auth/setup-password', { method: 'POST',
    body: { token, proof: proofFor(salt, NEW_PASSWORD) } }));
});

test('reauth, admin, recovery and challenge policies enforce their own exact IP/account windows', async t => {
  const f = await fixture(t);
  const admin = await f.user({ role: 'admin' }), cookie = await f.session(admin);
  const hash = digest(cookie.split('=')[1]);
  const member = await f.user();
  const token = randomBytes(32).toString('hex');
  await f.db.prepare('INSERT INTO password_tokens VALUES(?,?,?,?)').bind(digest(token), member.id, now() + 3600, now()).run();
  const policies = [
    { policy: 'reauth', identity: `${admin.id}:${hash}`, limits: [20, 60, 60, 180],
      path: '/api/auth/reauth', body: { proof: admin.proof } },
    // Administration is keyed by immutable actor ID, not mutable email.
    { policy: 'admin', identity: admin.id, limits: [60, 200, 120, 400],
      path: '/api/users', body: { name: 'No insert', email: 'blocked@example.test' } },
    // Valid recovery admission belongs to this hashed capability, not its owner.
    { policy: 'recovery', identity: `token:${digest(token)}`, limits: [8, 20, 30, 100],
      path: '/api/auth/setup-password', body: { token, proof: member.proof } },
    { policy: 'recovery-invalid', identity: 'invalid-setup-token', limits: [8, 20, 10, 30],
      path: '/api/auth/setup-password', body: { token: 'bad', proof: member.proof } },
    { policy: 'challenge', identity: `email:${member.email}`, limits: [60, 200, 120, 400],
      path: '/api/auth/password-challenge', body: { email: member.email } },
    { policy: 'challenge', identity: `token:${digest(token)}`, limits: [60, 200, 120, 400],
      path: '/api/auth/password-challenge', body: { token } },
    { policy: 'challenge', identity: 'invalid-setup-token', limits: [60, 200, 120, 400],
      path: '/api/auth/password-challenge', body: { token: 'bad' } },
  ];
  for (const p of policies) {
    for (const [i, [dimension, age]] of [['account', 0], ['account', 1000], ['ip', 0], ['ip', 1000]].entries()) {
      await f.db.prepare('DELETE FROM auth_attempts').run();
      await attempts(f, { ...p, dimension, age, count: p.limits[i] });
      await json(await f.request(p.path, { method: 'POST', cookie, body: p.body }), 429);
      assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM auth_attempts').first('n'), p.limits[i]);
    }
  }
});

test('reauth has a user-wide cap across sessions, separate from each session admission', async t => {
  const f = await fixture(t);
  const member = await f.user(), cookie = await f.session(member);
  for (const [count, age] of [[60, 0], [180, 1000]]) {
    await f.db.prepare('DELETE FROM auth_attempts').run();
    await f.db.prepare(`WITH RECURSIVE sequence(i) AS (
      SELECT 0 UNION ALL SELECT i+1 FROM sequence WHERE i+1<?
    ) INSERT INTO auth_attempts(ip_key,account_key,at) SELECT ?,?,? FROM sequence`)
      .bind(count, pseudonym('reauth:user-ledger'), pseudonym(`reauth:user:${member.id}`), now() - age).run();
    await json(await f.request('/api/auth/reauth', { method: 'POST', cookie, body: { proof: member.proof } }), 429);
    assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM auth_attempts').first('n'), count);
  }
});
