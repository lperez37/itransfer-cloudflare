import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, json, EMAIL, NEW_PASSWORD, BEARER, proofFor, setupToken, digest, now } from './helpers/worker.mjs';

const legacy = 'Riv3r!x';
const cookieOf = response => response.headers.get('Set-Cookie').split(';')[0];
const makeFixture = t => fixture(t, { adminPassword: legacy, forbidPasswordKdf: true, forbidR2: true });

test('eight-character bootstrap password grants normal access without an upgrade restriction', async t => {
  const password = 'Riv3r!xy';
  const f = await fixture(t, { adminPassword: password, forbidPasswordKdf: true });
  const response = await f.login(EMAIL, password);
  const user = await json(response);
  assert.equal(user.password_change_required, false);
  await json(await f.request('/api/shares', { cookie: cookieOf(response) }));
});

test('legacy upgrade gates workspace/admin access but permits repair, then revokes all sessions and tokens', async t => {
  const f = await makeFixture(t);
  const response = await f.login(EMAIL, legacy);
  const user = await json(response), cookie = cookieOf(response);
  const second = cookieOf(await f.login(EMAIL, legacy));
  assert.equal((await json(await f.request('/api/auth/me', { cookie }))).password_change_required, true);
  const token = 'ab'.repeat(32);
  await f.db.prepare('INSERT INTO password_tokens VALUES(?,?,?,?)').bind(digest(token), user.id, now() + 3600, now()).run();
  for (const path of ['/api/shares', '/api/requests', '/api/users', '/api/cost/estimate']) {
    const denied = await f.request(path, { cookie });
    assert.deepEqual(await json(denied, 403), { detail: 'Change your password before accessing your workspace' });
    assert.equal(denied.headers.get('X-Password-Change-Required'), '1');
  }
  await json(await f.request('/api/users', { method: 'POST', cookie, body: {} }), 403);
  await json(await f.request(`/api/users/${user.id}`, { method: 'PATCH', cookie, body: { password_change_required: 0 } }), 403);
  await json(await f.request('/api/auth/me', { cookie, headers: { 'X-Expected-User': 'another-user' } }), 401);
  await json(await f.request('/api/auth/email-preferences', { cookie }));
  await json(await f.request('/api/auth/email-preferences', { method: 'PATCH', cookie, body: { password_changed: false } }));
  const { salt } = await f.challenge({ email: EMAIL });
  const proof = proofFor(salt, legacy), newProof = proofFor(salt, NEW_PASSWORD);
  await json(await f.request('/api/auth/reauth', { method: 'POST', cookie, body: { proof } }));
  await json(await f.request('/api/auth/password', { method: 'POST', cookie,
    body: { current_proof: newProof, new_proof: newProof } }), 401);
  assert.equal((await json(await f.request('/api/auth/me', { cookie }))).password_change_required, true);
  await json(await f.request('/api/auth/password', { method: 'POST', cookie,
    body: { current_proof: proof, new_proof: newProof } }));
  for (const old of [cookie, second]) await json(await f.request('/api/auth/me', { cookie: old }), 401);
  assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM password_tokens').first('n'), 0);
  await json(await f.login(EMAIL, legacy), 401);
  const login = await f.login(EMAIL, NEW_PASSWORD);
  assert.equal((await json(login)).password_change_required, false);
  await json(await f.request('/api/shares', { cookie: cookieOf(login) }));
  assert.deepEqual(f.r2Calls, []);
  assert.deepEqual(f.externalRequests, []);
});

test('bootstrap requires exact secret and both empty users and absent durable marker', async t => {
  for (const state of ['open', 'users', 'marker']) await t.test(state, async st => {
    const f = await makeFixture(st);
    if (state === 'users') await f.user();
    if (state === 'marker') await f.db.prepare("INSERT INTO app_settings(key,value) VALUES('bootstrap_admin_id','historical-admin')").run();
    const { salt } = await f.challenge({ email: EMAIL });
    for (const password of state === 'open' ? [legacy + ' ', legacy.toUpperCase(), NEW_PASSWORD] : [legacy]) {
      assert.deepEqual(await json(await f.request('/api/auth/login', { method: 'POST', body: {
        email: EMAIL, proof: proofFor(salt, password), bootstrap_password: password,
      } }), 401), { detail: 'Invalid email or password' });
    }
    assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM users').first('n'), state === 'users' ? 1 : 0);
  });
});

test('another admin can reset restricted target but cannot patch away its flag; setup clears it', async t => {
  const f = await makeFixture(t);
  const login = await f.login(EMAIL, legacy), target = await json(login), oldCookie = cookieOf(login);
  const admin = await f.user({ role: 'admin' }), cookie = await f.session(admin);
  await json(await f.request(`/api/users/${target.id}`, { method: 'PATCH', cookie, body: { password_change_required: 0 } }), 400);
  const reset = await json(await f.request(`/api/users/${target.id}/reset-password`, { method: 'POST', cookie }));
  await json(await f.request('/api/auth/me', { cookie: oldCookie }), 401);
  assert.equal(await f.db.prepare('SELECT password_change_required FROM users WHERE id=?').bind(target.id).first('password_change_required'), 1);
  const token = setupToken(reset), { salt } = await f.challenge({ token });
  await json(await f.request('/api/auth/setup-password', { method: 'POST', body: { token, proof: proofFor(salt, NEW_PASSWORD) } }));
  assert.equal((await json(await f.login(EMAIL, NEW_PASSWORD))).password_change_required, false);
  assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM password_tokens').first('n'), 0);
  assert.deepEqual(f.externalRequests, []);
});

test('restricted legacy account leaves logout and independent bearer automation available', async t => {
  const f = await makeFixture(t);
  const login = await f.login(EMAIL, legacy), cookie = cookieOf(login);
  await json(login);
  await json(await f.request('/api/v1/shares', { headers: { Authorization: `Bearer ${BEARER}` } }));
  await json(await f.request('/api/auth/logout', { method: 'POST', cookie }));
  await json(await f.request('/api/auth/me', { cookie }), 401);
});
