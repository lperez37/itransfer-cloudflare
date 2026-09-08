import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, json, digest, now } from './helpers/worker.mjs';

test('invalid public origin rejects account links before user, token or session changes', async t => {
  for (const origin of ['http://transfer.example.test', 'https://transfer.example.test/unsafe', '']) {
    await t.test(origin || 'missing origin', async t => {
      const f = await fixture(t, { bindings: { PUBLIC_ORIGIN: origin } });
      const admin = await f.user({ role: 'admin' }), pending = await f.user({ status: 'pending' });
      const cookie = await f.session(admin);
      await f.db.prepare('INSERT INTO user_email_preferences(user_id,invitation_reminders) VALUES(?,1)').bind(pending.id).run();
      const token = 'af'.repeat(32);
      await f.db.prepare('INSERT INTO password_tokens VALUES(?,?,?,?)')
        .bind(digest(token), pending.id, now() + 3600, now()).run();
      const readState = async () => Promise.all(['users', 'password_tokens', 'user_sessions', 'notification_claims']
        .map(async table => (await f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results));
      const before = await readState();
      for (const [path, body] of [
        ['/api/users', { name: 'No new account', email: 'new@example.test' }],
        [`/api/users/${admin.id}/reset-password`, undefined],
        [`/api/users/${pending.id}/reset-password`, undefined],
        [`/api/users/${pending.id}/invitation`, undefined],
      ]) {
        await json(await f.request(path, { cookie, method: 'POST', body }), 503);
        assert.deepEqual(await readState(), before);
        await json(await f.request('/api/auth/me', { cookie }));
      }
      assert.deepEqual(f.externalRequests, []);
    });
  }
});
