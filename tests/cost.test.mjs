import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, json } from './helpers/worker.mjs';

test('cost upload triggers use indexed file lookups, not per-event full scans', async t => {
  const f = await fixture(t, { databaseOnly: true });
  // Explain the SELECT actually installed by the migration, not a hand-written
  // equivalent that could keep passing after the trigger regresses. Local D1
  // uses the real SQLite planner; bound NEW.id represents one triggering row.
  // https://sqlite.org/eqp.html (SEARCH vs SCAN)
  // https://developers.cloudflare.com/d1/platform/pricing/ (rows read quotas)
  for (const name of ['cost_file_confirmed', 'cost_file_inserted']) {
    const sql = await f.db.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?")
      .bind(name).first('sql');
    assert.equal(typeof sql, 'string', `Missing trigger ${name}`);
    const select = sql.match(/INSERT OR IGNORE INTO cost_usage\s+(SELECT[\s\S]*?);/i)?.[1];
    assert.ok(select, `Cannot extract upload SELECT from ${name}`);
    assert.equal((select.match(/NEW\.id/g) ?? []).length, 1);
    const { results } = await f.db.prepare(`EXPLAIN QUERY PLAN ${select.replace(/NEW\.id/g, '?')}`)
      .bind('query-plan-file').all();
    const plan = results.map(row => row.detail).join('\n');
    assert.doesNotMatch(plan, /\bSCAN (?:f|files)\b/i, `${name} scans files:\n${plan}`);
    assert.match(plan, /\bSEARCH f USING (?:COVERING )?INDEX sqlite_autoindex_files_\d+ \(id=\?\)/i,
      `${name} must use the files primary-key index:\n${plan}`);
  }
});

test('direct cost API denies anonymous and nonadmin callers without disclosing private account data', async t => {
  const f = await fixture(t);
  const admin = await f.user({ role: 'admin' }), member = await f.user();
  await f.content(admin, 'private-cost');
  const privileged = await json(await f.request('/api/cost/estimate', { cookie: await f.session(admin) }));
  const privateFields = privileged.users.flatMap(user => [user.name, user.email, user.user_id]);
  assert.equal(privileged.users.length, 2);
  assert.ok(privateFields.every(value => typeof value === 'string' && value.length > 0));
  for (const [cookie, status] of [[undefined, 401], [await f.session(member), 403]]) {
    const response = await f.request('/api/cost/estimate', { cookie });
    const text = await response.clone().text();
    const body = await json(response, status);
    assert.deepEqual(Object.keys(body), ['detail']);
    assert.equal(typeof body.detail, 'string');
    for (const value of privateFields) assert.ok(!text.includes(value), `Unauthorized cost response disclosed ${value}`);
    for (const field of ['users', 'total_storage_bytes', 'gross_monthly_cost_usd']) assert.ok(!(field in body));
  }
});

test('cost excludes inactive/unconfirmed storage, reports per-user gross, applies one global free tier, preserves purged usage', async t => {
  const f = await fixture(t);
  const admin = await f.user({ role: 'admin' }), member = await f.user();
  const cookie = await f.session(admin);
  const a = await f.content(admin, 'a', { size: 8 * 1024 ** 3 });
  await f.content(member, 'b', { size: 8 * 1024 ** 3 });
  await f.content(member, 'inactive', { size: 100 * 1024 ** 3, active: 0 });
  await f.content(member, 'unconfirmed', { size: 100 * 1024 ** 3, confirmed: 0 });
  await f.db.prepare('UPDATE shares SET is_paused=1 WHERE id=?').bind(a.share).run();
  const at = new Date().toISOString();
  for (const user of [admin, member]) {
    await f.db.prepare('INSERT INTO cost_usage VALUES(?,?,?,?,?)').bind(`large-write-${user.id}`, user.id, 'upload', 750000, at).run();
    await f.db.prepare('INSERT INTO cost_usage VALUES(?,?,?,?,?)').bind(`large-read-${user.id}`, user.id, 'download', 7500000, at).run();
  }
  await f.db.prepare('INSERT INTO cost_usage VALUES(?,?,?,?,?)').bind('outside-window', member.id, 'download', 99999999,
    new Date(Date.now() - 31 * 86400000).toISOString()).run();
  const before = await json(await f.request('/api/cost/estimate', { cookie }));
  assert.equal(before.total_storage_bytes, 32 * 1024 ** 3);
  assert.equal(before.total_files, 4);
  assert.equal(before.breakdown.storage, 0.33);
  assert.equal(before.class_b_ops_month, 15000000);
  assert.equal(before.breakdown.requests_get, 1.8);
  const uploadOps = await f.db.prepare("SELECT SUM(operations) AS n FROM cost_usage WHERE kind='upload'").first('n');
  assert.equal(before.class_a_ops_month, uploadOps);
  const round = n => Math.round(n * 10000) / 10000;
  assert.equal(before.breakdown.requests_put, round((uploadOps - 1000000) * 4.5 / 1000000));
  assert.ok(Math.abs(before.users.reduce((sum, u) => sum + u.gross_monthly_cost_usd, 0) - before.gross_monthly_cost_usd) < 0.0002);
  assert.equal(round(before.gross_monthly_cost_usd - before.free_tier_savings_usd), before.estimated_monthly_cost_usd);
  assert.equal(before.users.find(u => u.user_id === member.id).total_storage_bytes, 16 * 1024 ** 3);
  await json(await f.request(`/api/shares/${a.share}/purge`, { method: 'DELETE', cookie }));
  assert.equal(await f.bucket.get(a.file), null);
  const after = await json(await f.request('/api/cost/estimate', { cookie }));
  assert.equal(after.total_storage_bytes, 24 * 1024 ** 3);
  assert.equal(after.total_files, 3);
  assert.equal(after.class_a_ops_month, before.class_a_ops_month);
  assert.equal(after.class_b_ops_month, before.class_b_ops_month);
});

test('cost migration backfills retained usage idempotently and survives cascading deletion', async t => {
  const f = await fixture(t, { through: '0004_users.sql', databaseOnly: true });
  const admin = await f.user({ role: 'admin' });
  const item = await f.content(admin, 'pre-cost', { size: 104857600 });
  const at = new Date().toISOString();
  await f.db.prepare('INSERT INTO downloads(share_id,file_id,downloaded_at) VALUES(?,?,?)').bind(item.share, item.file, at).run();
  await f.migrate(f.remainingMigrations);
  const before = (await f.db.prepare('SELECT * FROM cost_usage ORDER BY event_key').all()).results;
  assert.equal(before.length, 3);
  assert.deepEqual(before.map(e => e.operations), [1, 1, 1]);
  await f.migrate(['0006_cost_backfill.sql']);
  assert.deepEqual((await f.db.prepare('SELECT * FROM cost_usage ORDER BY event_key').all()).results, before);
  await f.db.prepare('DELETE FROM shares WHERE id=?').bind(item.share).run();
  assert.deepEqual((await f.db.prepare('SELECT * FROM cost_usage ORDER BY event_key').all()).results, before);
});
