import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture as baseFixture, json, setupToken, PASSWORD, NEW_PASSWORD, EMAIL, digest, now,
  proofFor, verifierFor, bootstrapSalt } from './helpers/worker.mjs';
const fixture = (t, options = {}) => baseFixture(t, { forbidPasswordKdf: true, ...options });

test('bootstrap backfills legacy ownership, uses 90-day opaque hashed sessions, and DB replaces environment credentials', async t => {
  const f = await fixture(t);
  const legacy = await f.content(null, 'legacy');
  const initial = await f.challenge({ email: EMAIL.toUpperCase() });
  assert.equal(initial.bootstrap, true);
  assert.equal(initial.salt, bootstrapSalt(EMAIL));
  const proof = proofFor(initial.salt);
  const response = await f.request('/api/auth/login', { method: 'POST', body: { email: EMAIL.toUpperCase(), proof, bootstrap_password: PASSWORD } });
  const admin = await json(response);
  assert.equal(admin.email, EMAIL);
  assert.equal(admin.role, 'admin');
  assert.equal(admin.password_change_required, false);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const setCookie = response.headers.get('Set-Cookie');
  assert.match(setCookie, /Max-Age=7776000/);
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) assert.ok(setCookie.includes(flag), flag);
  const cookie = setCookie.split(';')[0];
  const raw = cookie.split('=')[1];
  assert.match(raw, /^[a-f0-9]{64}$/);
  const storedSession = await f.db.prepare('SELECT * FROM user_sessions').first();
  assert.equal(storedSession.token_hash, digest(raw));
  assert.notEqual(storedSession.token_hash, raw);
  assert.equal(storedSession.expires_at - storedSession.created_at, 90 * 86400);
  const stored = await f.db.prepare('SELECT * FROM users WHERE id=?').bind(admin.id).first();
  const [scheme, rounds, hash] = stored.password_hash.split('$');
  assert.equal(scheme, 'client-pbkdf2-sha256');
  assert.equal(rounds, '600000');
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(stored.password_salt, initial.salt);
  assert.equal(stored.password_hash, verifierFor(admin.id, initial.salt, proof));
  assert.ok(!stored.password_hash.includes(proof));
  assert.equal((await f.challenge({ email: EMAIL })).bootstrap, false);
  for (const table of ['shares', 'requests']) {
    assert.equal(await f.db.prepare(`SELECT owner_user_id FROM ${table}`).first('owner_user_id'), admin.id);
  }
  assert.equal(await f.db.prepare("SELECT value FROM app_settings WHERE key='bootstrap_admin_id'").first('value'), admin.id);
  await json(await f.request('/api/auth/me', { cookie }));
  await json(await f.request('/api/auth/password', { method: 'POST', cookie,
    body: { current_proof: proof, new_proof: proofFor(initial.salt, NEW_PASSWORD) } }));
  await json(await f.request('/api/auth/me', { cookie }), 401);
  await json(await f.login(EMAIL, PASSWORD), 401);
  const login = await json(await f.login(EMAIL, NEW_PASSWORD));
  assert.equal(login.id, admin.id);
  assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM users').first('n'), 1);
  assert.equal(await f.db.prepare('SELECT owner_user_id FROM shares WHERE id=?').bind(legacy.share).first('owner_user_id'), admin.id);
  const audit = JSON.stringify((await f.db.prepare('SELECT * FROM account_audit').all()).results);
  for (const secret of [PASSWORD, NEW_PASSWORD, raw, stored.password_hash, proof, proofFor(initial.salt, NEW_PASSWORD)]) assert.ok(!audit.includes(secret));
  assert.equal(f.externalRequests.length, 0);
});

test('unknown, pending, disabled and wrong-password signins have one generic response', async t => {
  const f = await fixture(t);
  const active = await f.user();
  const pending = await f.user({ status: 'pending' });
  const disabled = await f.user({ status: 'disabled' });
  const responses = [];
  for (const email of ['absent@example.test', active.email, pending.email, disabled.email]) {
    const r = await f.login(email, NEW_PASSWORD);
    assert.equal(r.headers.get('Cache-Control'), 'no-store');
    assert.equal(r.headers.get('Set-Cookie'), null);
    responses.push(await json(r, 401));
  }
  for (const r of responses) assert.deepEqual(r, { detail: 'Invalid email or password' });
});

test('auth rejects invalid Origin, oversized actual body, malformed JSON and invalid field types', async t => {
  const f = await fixture(t);
  for (const origin of ['https://attacker.example.test', 'null', '']) {
    const response = await f.request('/api/auth/login', { method: 'POST', headers: { Origin: origin },
      body: { email: EMAIL, proof: 'a'.repeat(64) } });
    await json(response, 403);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
  await json(await f.request('/api/auth/login', { method: 'POST', body: { padding: 'x'.repeat(8192) } }), 413);
  for (const body of ['{', 'null', '[]', '"string"', '{}', '{"email":null,"proof":1}', '{"email":"a@example.test","proof":""}']) {
    await json(await f.request('/api/auth/login', { method: 'POST', body }), 400);
  }
  await json(await f.request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' }), 415);
  assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM users').first('n'), 0);
  assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM auth_attempts').first('n'), 0);
});

test('setup validates proof shape and type without activating an invitation', async t => {
  const f = await fixture(t);
  const pending = await f.user({ status: 'pending' });
  const token = 'ab'.repeat(32);
  await f.db.prepare('INSERT INTO password_tokens VALUES(?,?,?,?)').bind(digest(token), pending.id, now() + 3600, now()).run();
  for (const proof of [null, 12345, [], {}, '', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64)]) {
    await f.db.prepare('DELETE FROM auth_attempts').run();
    await json(await f.request('/api/auth/setup-password', { method: 'POST', body: { token, proof } }), 400);
    assert.equal(await f.db.prepare('SELECT status FROM users WHERE id=?').bind(pending.id).first('status'), 'pending');
    assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM password_tokens WHERE user_id=?').bind(pending.id).first('n'), 1);
  }
});

test('user administration rejects duplicates, extra fields and invalid values without partial writes', async t => {
  const f = await fixture(t);
  const admin = await f.user({ role: 'admin' }), cookie = await f.session(admin);
  const valid = { name: 'Unicode Zoë 🦦', email: 'unique@example.test', role: 'user' };
  await json(await f.request('/api/users', { method: 'POST', cookie, body: valid }), 201);
  await json(await f.request('/api/users', { method: 'POST', cookie, body: { ...valid, email: 'UNIQUE@EXAMPLE.TEST' } }), 409);
  for (const patch of [{ name: '' }, { name: 'x'.repeat(101) }, { name: 'line\nbreak' }, { email: 'not-email' },
    { role: 'superadmin' }, { password_hash: 'injected' }, { session_generation: 0 }]) {
    await json(await f.request('/api/users', { method: 'POST', cookie, body: { ...valid, ...patch } }), 400);
  }
  assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM users').first('n'), 2);
  assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM password_tokens').first('n'), 1);
  const users = await json(await f.request('/api/users', { cookie }));
  for (const user of users.users) {
    assert.ok(!('password_hash' in user));
    assert.ok(!('session_generation' in user));
  }
});

test('DB session status, generation, expiry and logout are authoritative; legacy cookies fail closed', async t => {
  const f = await fixture(t);
  const user = await f.user();
  for (const options of [{ expiresAt: now() - 1 }, { generation: 42 }]) {
    await json(await f.request('/api/auth/me', { cookie: await f.session(user, options) }), 401);
  }
  await json(await f.request('/api/auth/me', { cookie: 'itransfer_session=legacy.signed.cookie' }), 401);
  const a = await f.session(user), b = await f.session(user);
  await json(await f.request('/api/auth/logout', { method: 'POST', cookie: a }));
  await json(await f.request('/api/auth/me', { cookie: a }), 401);
  await json(await f.request('/api/auth/me', { cookie: b }));
  await f.db.prepare("UPDATE users SET status='disabled' WHERE id=?").bind(user.id).run();
  await json(await f.request('/api/auth/me', { cookie: b }), 401);
});

test('invite/reset tokens stay in URL fragment, are hashed at rest, expire and have one winner under concurrent use', async t => {
  const f = await fixture(t);
  const admin = await f.user({ role: 'admin' });
  const cookie = await f.session(admin);
  const unknownChallenge = await f.challenge({ email: 'invited@example.test' });
  const response = await f.request('/api/users', { method: 'POST', cookie,
    body: { name: "Zoë 🦦 O'Connor", email: 'INVITED@example.test', role: 'user' } });
  const invite = await json(response, 201);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(invite.user.name, "Zoë 🦦 O'Connor");
  assert.equal(invite.user.email, 'invited@example.test');
  const token = setupToken(invite);
  const stored = await f.db.prepare('SELECT * FROM password_tokens WHERE user_id=?').bind(invite.user.id).first();
  assert.equal(stored.token_hash, digest(token));
  assert.equal(stored.expires_at - stored.created_at, 86400);
  const challenge = await f.challenge({ token });
  assert.equal(challenge.bootstrap, false);
  assert.notEqual(challenge.salt, unknownChallenge.salt, 'new invitations must persist a fresh random salt, not the unknown-email fallback');
  assert.equal((await f.challenge({ email: invite.user.email })).salt, challenge.salt);
  const passwords = [NEW_PASSWORD, PASSWORD];
  const bodies = passwords.map(password => ({ token, proof: proofFor(challenge.salt, password) }));
  const responses = await Promise.all(bodies.map(body => f.request('/api/auth/setup-password', { method: 'POST', body })));
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 400]);
  for (const r of responses) assert.equal(r.headers.get('Cache-Control'), 'no-store');
  await json(await f.request('/api/auth/setup-password', { method: 'POST', body: bodies[0] }), 400);
  assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM password_tokens WHERE user_id=?').bind(invite.user.id).first('n'), 0);
  const winnerPassword = passwords[responses.findIndex(r => r.status === 200)];
  const login = await f.login(invite.user.email, winnerPassword);
  await json(login);
  const memberCookie = login.headers.get('Set-Cookie').split(';')[0];
  const reset = await json(await f.request(`/api/users/${invite.user.id}/reset-password`, { method: 'POST', cookie }));
  const resetToken = setupToken(reset);
  await json(await f.request('/api/auth/me', { cookie: memberCookie }), 401);
  const resetRow = await f.db.prepare('SELECT * FROM password_tokens WHERE user_id=?').bind(invite.user.id).first();
  assert.equal(resetRow.expires_at - resetRow.created_at, 3600);
  await f.db.prepare('UPDATE password_tokens SET expires_at=? WHERE user_id=?').bind(now() - 1, invite.user.id).run();
  await json(await f.request('/api/auth/setup-password', { method: 'POST', body: { token: resetToken, proof: proofFor(challenge.salt, NEW_PASSWORD) } }), 400);
  const audit = JSON.stringify((await f.db.prepare('SELECT * FROM account_audit').all()).results);
  for (const value of [token, resetToken, PASSWORD, NEW_PASSWORD, ...bodies.map(b => b.proof)]) assert.ok(!audit.includes(value));
});

test('administrator actions require recent session-specific auth and advertise X-Reauth-Required', async t => {
  const f = await fixture(t);
  const admin = await f.user({ role: 'admin' });
  const stale = await f.session(admin, { reauthAt: now() - 301 });
  const other = await f.session(admin, { reauthAt: now() - 301 });
  const body = { name: 'Example member', email: 'new@example.test', role: 'user' };
  const denied = await f.request('/api/users', { method: 'POST', cookie: stale, body });
  await json(denied, 403);
  assert.equal(denied.headers.get('X-Reauth-Required'), '1');
  assert.equal(denied.headers.get('Cache-Control'), 'no-store');
  await json(await f.request('/api/auth/reauth', { method: 'POST', cookie: stale, body: { proof: admin.proof } }));
  await json(await f.request('/api/users', { method: 'POST', cookie: stale, body }), 201);
  await json(await f.request('/api/users', { method: 'POST', cookie: other, body }), 403);
});

test('account revoke, disable, role and email changes invalidate every target session', async t => {
  const f = await fixture(t);
  const admin = await f.user({ role: 'admin' }), cookie = await f.session(admin);
  for (const operation of ['revoke-sessions', 'reset-password', 'disable', 'role', 'email']) {
    const member = await f.user();
    const sessions = [await f.session(member), await f.session(member)];
    const patch = { disable: { status: 'disabled' }, role: { role: 'admin' }, email: { email: `${member.id}-changed@example.test` } }[operation];
    await json(await f.request(`/api/users/${member.id}${patch ? '' : '/' + operation}`, {
      method: patch ? 'PATCH' : 'POST', cookie, body: patch,
    }));
    for (const session of sessions) await json(await f.request('/api/auth/me', { cookie: session }), 401);
    assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM user_sessions WHERE user_id=?').bind(member.id).first('n'), 0);
  }
});

test('concurrent demotions cannot remove the final active administrator', async t => {
  const f = await fixture(t);
  const admins = await Promise.all([f.user({ role: 'admin' }), f.user({ role: 'admin' })]);
  const cookies = await Promise.all(admins.map(u => f.session(u)));
  const responses = await Promise.all(admins.map((u, i) => f.request(`/api/users/${u.id}`, {
    method: 'PATCH', cookie: cookies[i], body: { role: 'user' },
  })));
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  assert.equal(await f.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND status='active'").first('n'), 1);
  const remaining = await f.db.prepare("SELECT id FROM users WHERE role='admin'").first('id');
  const stillAdmin = cookies[admins.findIndex(u => u.id === remaining)];
  await json(await f.request(`/api/users/${remaining}`, { method: 'PATCH', cookie: stillAdmin, body: { status: 'disabled' } }), 409);
});

test('concurrent bootstrap installs exactly one account/verifier and backfills all legacy owners atomically', async t => {
  const f = await fixture(t);
  await f.content(null, 'bootstrap-race');
  const { salt, bootstrap } = await f.challenge({ email: EMAIL });
  assert.equal(bootstrap, true);
  const proof = proofFor(salt);
  const responses = await Promise.all([0, 1].map(() => f.request('/api/auth/login', { method: 'POST',
    body: { email: EMAIL, proof, bootstrap_password: PASSWORD } })));
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 401]);
  const rows = (await f.db.prepare('SELECT * FROM users').all()).results;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].password_hash, verifierFor(rows[0].id, salt, proof));
  assert.equal(await f.db.prepare("SELECT value FROM app_settings WHERE key='bootstrap_admin_id'").first('value'), rows[0].id);
  for (const table of ['shares', 'requests']) {
    assert.equal(await f.db.prepare(`SELECT owner_user_id FROM ${table}`).first('owner_user_id'), rows[0].id);
  }
  assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM user_sessions').first('n'), 1);
  assert.equal(await f.db.prepare("SELECT COUNT(*) AS n FROM account_audit WHERE action='account.bootstrap'").first('n'), 1);
  assert.equal((await f.challenge({ email: EMAIL })).bootstrap, false);
  await json(await f.login(EMAIL));
});

test('bootstrap imports exact weak legacy secrets as restricted accounts', async t => {
  for (const password of ['Riv3r!x', 'password123456!']) {
    await t.test(password.length < 8 ? 'minimum length' : 'common password', async st => {
      const f = await fixture(st, { adminPassword: password });
      const { salt } = await f.challenge({ email: EMAIL });
      const response = await f.request('/api/auth/login', { method: 'POST',
        body: { email: EMAIL, proof: proofFor(salt, password), bootstrap_password: password } });
      assert.equal((await json(response)).password_change_required, true);
      assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM users').first('n'), 1);
      assert.equal(await f.db.prepare('SELECT password_change_required FROM users').first('password_change_required'), 1);
      assert.equal(await f.db.prepare("SELECT COUNT(*) AS n FROM app_settings WHERE key='bootstrap_admin_id'").first('n'), 1);
    });
  }
});

test('plaintext password fields are rejected on every credential endpoint after bootstrap', async t => {
  const f = await fixture(t);
  const response = await f.login(EMAIL);
  const admin = await json(response);
  const cookie = response.headers.get('Set-Cookie').split(';')[0];
  const { salt } = await f.challenge({ email: EMAIL });
  const proof = proofFor(salt);
  for (const [path, body] of [
    ['/login', { email: EMAIL, password: PASSWORD }],
    ['/login', { email: EMAIL, proof, password: PASSWORD }],
    ['/reauth', { proof, password: PASSWORD }],
    ['/password', { current_password: PASSWORD, new_password: NEW_PASSWORD }],
    ['/password', { current_proof: proof, new_proof: proof, new_password: NEW_PASSWORD }],
    ['/setup-password', { token: 'aa'.repeat(32), proof, password: PASSWORD }],
    ['/password-challenge', { email: EMAIL, password: PASSWORD }],
  ]) await json(await f.request('/api/auth' + path, { method: 'POST', cookie, body }), 400);
  await json(await f.request('/api/auth/login', { method: 'POST',
    body: { email: EMAIL, proof, bootstrap_password: PASSWORD } }), 401);
  assert.equal((await json(await f.request('/api/auth/me', { cookie }))).id, admin.id);
});

test('proof validation and wrong current proof never change verifier or revoke a valid session', async t => {
  const f = await fixture(t);
  const member = await f.user(), cookie = await f.session(member, { reauthAt: now() - 600 });
  const before = await f.db.prepare('SELECT * FROM users WHERE id=?').bind(member.id).first();
  for (const proof of [null, 7, [], '', '0'.repeat(63), '0'.repeat(65), 'G'.repeat(64), 'A'.repeat(64)]) {
    await f.db.prepare('DELETE FROM auth_attempts').run();
    await json(await f.request('/api/auth/login', { method: 'POST', body: { email: member.email, proof } }), 400);
    await json(await f.request('/api/auth/reauth', { method: 'POST', cookie, body: { proof } }), 400);
    await json(await f.request('/api/auth/password', { method: 'POST', cookie,
      body: { current_proof: proof, new_proof: member.proof } }), 400);
    await json(await f.request('/api/auth/password', { method: 'POST', cookie,
      body: { current_proof: member.proof, new_proof: proof } }), 400);
  }
  const wrong = proofFor(member.password_salt, NEW_PASSWORD);
  await json(await f.request('/api/auth/reauth', { method: 'POST', cookie, body: { proof: wrong } }), 401);
  await json(await f.request('/api/auth/password', { method: 'POST', cookie,
    body: { current_proof: wrong, new_proof: wrong } }), 401);
  assert.deepEqual(await f.db.prepare('SELECT * FROM users WHERE id=?').bind(member.id).first(), before);
  const session = await f.db.prepare('SELECT reauth_at FROM user_sessions WHERE token_hash=?').bind(digest(cookie.split('=')[1])).first();
  assert.ok(session.reauth_at < now() - 300);
  await json(await f.request('/api/auth/me', { cookie }));
});

test('same-proof reset has exactly one winner, consumes token and revokes sessions even when verifier is unchanged', async t => {
  const f = await fixture(t);
  const admin = await f.user({ role: 'admin' }), member = await f.user();
  const adminCookie = await f.session(admin), oldCookie = await f.session(member);
  const reset = await json(await f.request(`/api/users/${member.id}/reset-password`, { method: 'POST', cookie: adminCookie }));
  const token = setupToken(reset);
  await json(await f.request('/api/auth/me', { cookie: oldCookie }), 401);
  const { salt } = await f.challenge({ token });
  assert.equal(salt, member.password_salt);
  const interim = await f.session(member);
  const before = await f.db.prepare('SELECT * FROM users WHERE id=?').bind(member.id).first();
  const body = { token, proof: proofFor(salt) };
  const responses = await Promise.all([0, 1].map(() => f.request('/api/auth/setup-password', { method: 'POST', body })));
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 400]);
  const after = await f.db.prepare('SELECT * FROM users WHERE id=?').bind(member.id).first();
  assert.equal(after.password_hash, before.password_hash);
  assert.equal(after.session_generation, before.session_generation + 1);
  assert.equal(after.password_salt, before.password_salt);
  assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM password_tokens WHERE user_id=?').bind(member.id).first('n'), 0);
  await json(await f.request('/api/auth/me', { cookie: interim }), 401);
  await json(await f.request('/api/auth/setup-password', { method: 'POST', body }), 400);
  await json(await f.request('/api/auth/password-challenge', { method: 'POST', body: { token } }), 400);
  const login = await f.login(member.email);
  await json(login);
  const cookie = login.headers.get('Set-Cookie').split(';')[0];
  await json(await f.request('/api/auth/password', { method: 'POST', cookie,
    body: { current_proof: member.proof, new_proof: member.proof } }));
  await json(await f.request('/api/auth/me', { cookie }), 401);
});

test('verifiers are bound to account ID, and another account proof cannot reauthenticate the current account', async t => {
  const f = await fixture(t);
  const a = await f.user(), b = await f.user();
  const cookie = await f.session(a, { reauthAt: now() - 600 });
  assert.notEqual(a.password_salt, b.password_salt);
  const challengeA = await f.challenge({ email: a.email }), challengeB = await f.challenge({ email: b.email });
  await json(await f.request('/api/auth/reauth', { method: 'POST', cookie,
    body: { proof: proofFor(challengeB.salt) } }), 401);
  await json(await f.request('/api/auth/reauth', { method: 'POST', cookie,
    body: { proof: proofFor(challengeA.salt) } }));
  // Equal salts/proofs deliberately isolate account-ID binding from salt binding.
  const c = await f.user({ password_salt: a.password_salt });
  const verifierA = await f.db.prepare('SELECT password_hash FROM users WHERE id=?').bind(a.id).first('password_hash');
  assert.notEqual(verifierA, await f.db.prepare('SELECT password_hash FROM users WHERE id=?').bind(c.id).first('password_hash'));
  await f.db.prepare('UPDATE users SET password_hash=? WHERE id=?').bind(verifierA, c.id).run();
  await json(await f.login(c.email), 401);
  await json(await f.login(a.email));
});

test('email changes retain immutable credential salt and verifier while revoking old sessions', async t => {
  const f = await fixture(t);
  const admin = await f.user({ role: 'admin' }), member = await f.user();
  const cookie = await f.session(member), adminCookie = await f.session(admin);
  const before = await f.db.prepare('SELECT * FROM users WHERE id=?').bind(member.id).first();
  const email = 'renamed@example.test';
  await json(await f.request(`/api/users/${member.id}`, { method: 'PATCH', cookie: adminCookie, body: { email } }));
  const after = await f.db.prepare('SELECT * FROM users WHERE id=?').bind(member.id).first();
  assert.equal(after.password_salt, before.password_salt);
  assert.equal(after.password_hash, before.password_hash);
  assert.equal((await f.challenge({ email })).salt, before.password_salt);
  await json(await f.request('/api/auth/me', { cookie }), 401);
  await json(await f.login(email));
  await json(await f.login(member.email), 401);
  await assert.rejects(f.db.prepare('UPDATE users SET password_salt=? WHERE id=?').bind('ff'.repeat(16), member.id).run(), /credential_salt_immutable/);
});

test('challenge enforces exclusive typed identity, returns no verifier and rejects expired token capabilities', async t => {
  const f = await fixture(t);
  const member = await f.user();
  for (const body of [{}, { email: member.email, token: 'aa'.repeat(32) }, { email: null }, { token: null },
    { token: [] }, { email: 2 }, { email: member.email, proof: member.proof }]) {
    await json(await f.request('/api/auth/password-challenge', { method: 'POST', body }), 400);
  }
  for (const user of [member, await f.user({ status: 'pending' }), await f.user({ status: 'disabled' })]) {
    const challenge = await f.challenge({ email: user.email });
    assert.equal(challenge.salt, user.password_salt);
    assert.equal(challenge.bootstrap, false);
  }
  assert.deepEqual(await f.challenge({ email: 'unknown@example.test' }), await f.challenge({ email: 'UNKNOWN@example.test' }));
  const token = 'aa'.repeat(32);
  await f.db.prepare('INSERT INTO password_tokens VALUES(?,?,?,?)').bind(digest(token), member.id, now() - 1, now() - 100).run();
  await json(await f.request('/api/auth/password-challenge', { method: 'POST', body: { token } }), 400);
});

test('old-root verifier fails closed and reset installs a current-root verifier without the old secret', async t => {
  const f = await fixture(t);
  const admin = await f.user({ role: 'admin' }), member = await f.user();
  const oldVerifier = verifierFor(member.id, member.password_salt, member.proof,
    'old-test-credential-root-not-configured-in-worker');
  await f.db.prepare('UPDATE users SET password_hash=? WHERE id=?').bind(oldVerifier, member.id).run();
  await json(await f.login(member.email), 401);
  const reset = await json(await f.request(`/api/users/${member.id}/reset-password`, { method: 'POST', cookie: await f.session(admin) }));
  const token = setupToken(reset);
  const { salt } = await f.challenge({ token });
  assert.equal(salt, member.password_salt);
  await json(await f.request('/api/auth/setup-password', { method: 'POST', body: { token, proof: proofFor(salt) } }));
  const currentVerifier = await f.db.prepare('SELECT password_hash FROM users WHERE id=?').bind(member.id).first('password_hash');
  assert.equal(currentVerifier, verifierFor(member.id, salt, member.proof));
  assert.notEqual(currentVerifier, oldVerifier);
  await json(await f.login(member.email));
});
