import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, json, now } from './helpers/worker.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function setup(t, { incremental = 0, cap = 1 } = {}) {
  const sent = [];
  const f = await fixture(t, {
    bindings: { TRANSACTIONAL_MAIL_API_URL: 'https://mailer.example.test', TRANSACTIONAL_MAIL_API_KEY: 'synthetic-key' },
    outbound: async req => {
      sent.push(await req.json());
      return Response.json({ status: 'queued', id: 'msg_00000000-0000-4000-8000-000000000001' }, { status: 202 });
    },
  });
  const owner = await f.user();
  await f.db.prepare('INSERT INTO user_email_preferences(user_id,request_uploads) VALUES(?,1)').bind(owner.id).run();
  const r = await f.content(owner, undefined, { confirmed: 0, size: 10 });
  await f.db.prepare('UPDATE requests SET allow_incremental=?,max_uploads=? WHERE id=?').bind(incremental, cap, r.request).run();
  const ids = [r.requestFile, `${r.requestFile}-b`, `${r.requestFile}-c`];
  // Copy the request FK (and therefore its owner) while all batches are legal.
  for (const id of ids.slice(1)) {
    await f.db.prepare(`INSERT INTO files(id,original_filename,r2_key,file_size,request_id,confirmed,created_at)
      SELECT ?,original_filename,?,file_size,request_id,0,created_at FROM files WHERE id=?`)
      .bind(id, id, ids[0]).run();
    await f.bucket.put(id, 'payload');
  }
  const confirm = file_ids => f.request(`/api/public/requests/${r.request}/confirm`, { method: 'POST', body: { file_ids } });
  const state = async () => ({
    count: await f.db.prepare('SELECT upload_count FROM requests WHERE id=?').bind(r.request).first('upload_count'),
    files: (await f.db.prepare('SELECT id,confirmed,file_size FROM files WHERE request_id=? ORDER BY id').bind(r.request).all()).results,
    costs: (await f.db.prepare('SELECT event_key,operations,owner_user_id FROM cost_usage ORDER BY event_key').all()).results,
    claims: (await f.db.prepare('SELECT * FROM notification_claims ORDER BY event_key').all()).results,
  });
  const waitMail = async count => {
    for (let i = 0; i < 100 && sent.length < count; i++) await pause(20);
    assert.equal(sent.length, count);
  };
  // Remove cooldown as a confounder: incorrect notifications must not be hidden.
  const ageClaims = () => f.db.prepare('UPDATE notification_claims SET created_at=?').bind(now() - 301).run();
  return { ...f, owner, r, ids, sent, confirm, state, waitMail, ageClaims };
}

for (const incremental of [0, 1]) test(`exact quota rejects second prepared batch without file/cost/email mutations (incremental=${incremental})`, async t => {
  const f = await setup(t, { incremental });
  const [a, b] = f.ids;
  assert.equal((await json(await f.confirm([a]))).detail, 'Upload confirmed');
  await f.waitMail(1);
  await f.ageClaims();
  const before = await f.state();
  assert.equal(before.count, 1);
  assert.equal(before.costs.length, 1);
  assert.equal(before.costs[0].owner_user_id, f.owner.id);
  for (let i = 0; i < 2; i++) {
    await json(await f.confirm([b]), 410);
    assert.deepEqual(await f.state(), before, 'rejected batch must remain unconfirmed, including its declared size');
  }
  assert.equal((await json(await f.confirm([a, a]))).detail, 'Upload already confirmed');
  await pause(100);
  assert.deepEqual(await f.state(), before);
  assert.equal(f.sent.length, 1);
});

test('concurrent different batches at cap one admit exactly one; concurrent duplicate confirms consume one slot', async t => {
  const f = await setup(t);
  const [a, b, c] = f.ids;
  const responses = await Promise.all([f.confirm([a]), f.confirm([b])]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 410]);
  await f.waitMail(1);
  const first = await f.state();
  assert.equal(first.count, 1);
  assert.equal(first.files.filter(row => row.confirmed).length, 1);
  assert.equal(first.costs.length, 1);
  await f.db.prepare('UPDATE requests SET allow_incremental=1,max_uploads=2 WHERE id=?').bind(f.r.request).run();
  await f.ageClaims();
  const duplicates = await Promise.all([f.confirm([c, c]), f.confirm([c])]);
  const details = await Promise.all(duplicates.map(r => json(r)));
  assert.deepEqual(details.map(r => r.detail).sort(), ['Upload already confirmed', 'Upload confirmed']);
  await f.waitMail(2);
  const final = await f.state();
  assert.equal(final.count, 2);
  assert.equal(final.files.filter(row => row.confirmed).length, 2);
  assert.equal(final.costs.length, 2);
  assert.equal(final.claims.length, 2);
  assert.ok(f.sent.every(mail => /Files: 1\b/.test(mail.text)));
});

test('partial overlap and duplicate IDs notify only unique committed transitions with verified sizes', async t => {
  const f = await setup(t, { incremental: 1, cap: 2 });
  const [a, b, c] = f.ids;
  await json(await f.confirm([a]));
  await f.waitMail(1);
  await f.ageClaims();
  await f.bucket.put(b, 'tiny');
  await json(await f.confirm([a, b, b, c, c]));
  await f.waitMail(2);
  const state = await f.state();
  assert.equal(state.count, 2);
  assert.equal(state.costs.length, 3);
  assert.ok(state.files.every(row => row.confirmed === 1));
  assert.equal(state.files.find(row => row.id === b).file_size, 4);
  assert.match(f.sent[1].text, /Files: 2\b/);
  await f.ageClaims();
  const before = await f.state();
  await json(await f.confirm([c, b, a, b]));
  await pause(100);
  assert.deepEqual(await f.state(), before);
  assert.equal(f.sent.length, 2);
});

test('R2 missing/oversized objects and foreign IDs reject the whole batch before any DB mutations', async t => {
  const f = await setup(t);
  const [a, b] = f.ids;
  const before = await f.state();
  await f.bucket.delete(b);
  await json(await f.confirm([a, b]), 400);
  assert.deepEqual(await f.state(), before);
  await f.bucket.put(b, 'larger than declared');
  await json(await f.confirm([a, b]), 400);
  assert.deepEqual(await f.state(), before);
  await f.bucket.put(b, 'payload');
  await f.db.prepare('UPDATE requests SET max_file_size=5 WHERE id=?').bind(f.r.request).run();
  await json(await f.confirm([a, b]), 400);
  assert.deepEqual(await f.state(), before);
  await json(await f.confirm([f.r.file]), 400);
  assert.deepEqual(await f.state(), before);
  assert.equal(f.sent.length, 0);
});

test('expired/inactive requests reject before confirming files', async t => {
  const f = await setup(t);
  const before = await f.state();
  await f.db.prepare('UPDATE requests SET expires_at=? WHERE id=?').bind(new Date(Date.now() - 1000).toISOString(), f.r.request).run();
  await json(await f.confirm([f.ids[0]]), 404);
  await f.db.prepare('UPDATE requests SET expires_at=NULL,is_active=0 WHERE id=?').bind(f.r.request).run();
  await json(await f.confirm([f.ids[0]]), 404);
  assert.deepEqual(await f.state(), before);
});

test('real multipart R2 size feeds cost triggers without corrupting multi-row changes() gating', async t => {
  const f = await setup(t);
  const [a, b, c] = f.ids;
  const size = 101 * 1024 * 1024;
  await f.db.prepare('UPDATE files SET file_size=? WHERE id=?').bind(size, a).run();
  const upload = await f.bucket.createMultipartUpload(a);
  const parts = [];
  for (const [index, megabytes] of [50, 50, 1].entries()) {
    parts.push(await upload.uploadPart(index + 1, new Uint8Array(megabytes * 1024 * 1024)));
  }
  await upload.complete(parts);
  assert.equal((await f.bucket.head(a)).size, size);
  await json(await f.confirm([a, b, b]));
  await f.waitMail(1);
  const accepted = await f.state();
  assert.equal(accepted.count, 1);
  assert.deepEqual(accepted.costs.map(row => row.operations).sort(), [1, 5]);
  assert.equal(accepted.files.find(row => row.id === a).file_size, size);
  assert.match(f.sent[0].text, /Files: 2\b/);
  await f.ageClaims();
  const before = await f.state();
  await json(await f.confirm([c]), 410);
  await json(await f.confirm([b, a]));
  await pause(100);
  assert.deepEqual(await f.state(), before);
  assert.equal(f.sent.length, 1);
});

test('100-file confirmation uses bounded SQL parameters and accounts each unique transition once', async t => {
  const f = await setup(t);
  const ids = [...f.ids];
  const statements = [];
  for (let i = ids.length; i < 100; i++) {
    const id = `${f.r.requestFile}-${i}`;
    ids.push(id);
    statements.push(f.db.prepare(`INSERT INTO files(id,original_filename,r2_key,file_size,request_id,confirmed,created_at)
      SELECT ?,original_filename,?,file_size,request_id,0,created_at FROM files WHERE id=?`).bind(id, id, ids[0]));
  }
  await f.db.batch(statements);
  await Promise.all(ids.slice(3).map(id => f.bucket.put(id, 'payload')));
  await json(await f.confirm([...ids, ids[0]]));
  await f.waitMail(1);
  const state = await f.state();
  assert.equal(state.count, 1);
  assert.equal(state.costs.length, 100);
  assert.ok(state.costs.every(row => row.operations === 1));
  assert.ok(state.files.every(row => row.confirmed === 1 && row.file_size === 7));
  assert.match(f.sent[0].text, /Files: 100\b/);
});
