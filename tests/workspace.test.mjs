import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, json, now, BEARER } from './helpers/worker.mjs';

test('private lists and all detail/mutation/download paths hide foreign IDs before touching storage', async t => {
  const f = await fixture(t, { forbidR2: true });
  const owner = await f.user(), stranger = await f.user();
  const own = await f.content(stranger, 'own'), foreign = await f.content(owner, 'foreign');
  const cookie = await f.session(stranger);
  assert.deepEqual((await json(await f.request('/api/shares', { cookie }))).map(s => s.id), [own.share]);
  assert.deepEqual((await json(await f.request('/api/requests', { cookie }))).map(r => r.id), [own.request]);
  const attempts = [
    ['GET', `/api/shares/${foreign.share}`],
    ['PATCH', `/api/shares/${foreign.share}`, { is_paused: true }],
    ['DELETE', `/api/shares/${foreign.share}`],
    ['DELETE', `/api/shares/${foreign.share}/purge`],
    ['POST', `/api/shares/${foreign.share}/confirm`],
    ['POST', `/api/shares/${foreign.share}/download`],
    ['POST', `/api/shares/${foreign.share}/files/${foreign.file}/download`],
    ['POST', `/api/shares/${own.share}/files/${foreign.file}/download`],
    ['POST', `/api/shares/${foreign.share}/complete-multipart`, { file_id: foreign.file, upload_id: 'fake-upload', parts: [{ part_number: 1, etag: 'fake-etag' }] }],
    ['POST', `/api/shares/${own.share}/complete-multipart`, { file_id: foreign.file, upload_id: 'fake-upload', parts: [{ part_number: 1, etag: 'fake-etag' }] }],
    ['GET', `/api/requests/${foreign.request}`],
    ['PATCH', `/api/requests/${foreign.request}`, { expiry_days: 2 }],
    ['DELETE', `/api/requests/${foreign.request}`],
    ['DELETE', `/api/requests/${foreign.request}/purge`],
    ['POST', `/api/requests/${foreign.request}/download`],
  ];
  for (const [method, path, body] of attempts) {
    await json(await f.request(path, { method, cookie, body }), 404);
  }
  assert.equal(await (await f.bucket.get(foreign.file)).text(), 'payload');
  assert.equal(await (await f.bucket.get(foreign.requestFile)).text(), 'payload');
  assert.equal(await f.db.prepare('SELECT is_active FROM shares WHERE id=?').bind(foreign.share).first('is_active'), 1);
  assert.equal(await f.db.prepare('SELECT is_active FROM requests WHERE id=?').bind(foreign.request).first('is_active'), 1);
  assert.equal(f.externalRequests.length, 0);
  assert.deepEqual(f.r2Calls, [], 'foreign IDs must fail before any bucket call, including HEAD');
  await json(await f.request('/api/shares', { cookie, headers: { 'X-Workspace-User': owner.id } }), 403);
});

test('admin workspace viewing allows reads/downloads; writes require manage header AND recent auth', async t => {
  const f = await fixture(t);
  const admin = await f.user({ role: 'admin' }), owner = await f.user();
  const foreign = await f.content(owner);
  const stale = await f.session(admin, { reauthAt: now() - 301 });
  const recent = await f.session(admin);
  const headers = { 'X-Workspace-User': owner.id };
  assert.deepEqual(await json(await f.request('/api/shares', { cookie: recent })), []);
  await json(await f.request(`/api/shares/${foreign.share}`, { cookie: recent }), 404);
  assert.equal((await json(await f.request('/api/shares', { cookie: stale, headers })))[0].id, foreign.share);
  for (const path of [`/api/shares/${foreign.share}`, `/api/requests/${foreign.request}`]) {
    await json(await f.request(path, { cookie: stale, headers }));
    const download = await json(await f.request(path + '/download', { method: 'POST', cookie: stale, headers }));
    assert.equal(download.files.length, 1);
    assert.ok(new URL(download.files[0].download_url).searchParams.has('X-Amz-Signature'));
    await json(await f.request(path, { method: 'PATCH', cookie: recent, headers, body: { expiry_days: 3 } }), 403);
    const denied = await f.request(path, { method: 'PATCH', cookie: stale,
      headers: { ...headers, 'X-Workspace-Mode': 'manage' }, body: { expiry_days: 3 } });
    await json(denied, 403);
    assert.equal(denied.headers.get('X-Reauth-Required'), '1');
    await json(await f.request(path, { method: 'PATCH', cookie: recent,
      headers: { ...headers, 'X-Workspace-Mode': 'manage' }, body: { expiry_days: 3 } }));
  }
  const events = (await f.db.prepare("SELECT * FROM account_audit WHERE action LIKE 'workspace.%'").all()).results;
  assert.ok(events.some(e => e.action === 'workspace.denied'));
  assert.ok(events.some(e => e.action === 'workspace.access_succeeded'));
  for (const e of events) {
    assert.equal(e.actor_id, admin.id);
    assert.equal(e.target_id, owner.id);
    assert.ok(!e.detail.includes(foreign.share));
    assert.ok(!e.detail.includes('X-Amz-Signature'));
  }
  assert.equal(f.externalRequests.length, 0);
});

test('request multipart and confirmation reject files from another request before any R2 call', async t => {
  const f = await fixture(t, { forbidR2: true });
  const owner = await f.user();
  const first = await f.content(owner, 'first'), second = await f.content(owner, 'second');
  await json(await f.request(`/api/public/requests/${first.request}/complete-multipart`, { method: 'POST',
    body: { file_id: second.requestFile, upload_id: 'untrusted-upload-id', parts: [{ part_number: 1, etag: 'arbitrary-etag' }] } }), 404);
  await json(await f.request(`/api/public/requests/${first.request}/confirm`, { method: 'POST',
    body: { file_ids: [first.requestFile, second.requestFile] } }), 400);
  assert.deepEqual(f.r2Calls, []);
  assert.deepEqual(f.externalRequests, []);
});

test('nonadmin users/cost APIs are forbidden; bearer is global automation, never user administration', async t => {
  const f = await fixture(t);
  const admin = await f.user({ role: 'admin' }), member = await f.user();
  await f.db.prepare("INSERT INTO app_settings VALUES('bootstrap_admin_id',?)").bind(admin.id).run();
  await f.content(admin, 'admin');
  await f.content(member, 'member');
  const cookie = await f.session(member);
  for (const path of ['/api/users', '/api/users/audit', '/api/cost/estimate']) {
    await json(await f.request(path, { cookie }), 403);
    await json(await f.request(path), 401);
  }
  await json(await f.request('/api/users', { method: 'POST', cookie,
    body: { name: 'Forbidden', email: 'forbidden@example.test' } }), 403);
  const headers = { Authorization: `Bearer ${BEARER}` };
  for (const path of ['/api/users', '/api/auth/me']) await json(await f.request(path, { headers }), 401);
  await json(await f.request('/api/users', { method: 'POST', headers,
    body: { name: 'Forbidden', email: 'forbidden@example.test' } }), 401);
  const cost = await json(await f.request('/api/v1/cost', { headers }));
  assert.equal(cost.total_files, 4);
  assert.equal(cost.users.length, 2);
  assert.deepEqual((await json(await f.request('/api/v1/shares', { headers }))).map(s => s.id).sort(), ['share-admin', 'share-member']);
  assert.deepEqual((await json(await f.request('/api/v1/requests', { headers }))).map(r => r.id).sort(), ['request-admin', 'request-member']);
  // The automation token is global even when a caller tries to supply a UI
  // workspace header; it is not a user session or an impersonation mechanism.
  await json(await f.request('/api/v1/shares/share-member', { method: 'PATCH',
    headers: { ...headers, 'X-Workspace-User': admin.id }, body: { is_paused: true } }));
  assert.equal(await f.db.prepare("SELECT is_paused FROM shares WHERE id='share-member'").first('is_paused'), 1);
  await json(await f.request('/api/v1/cost', { cookie }), 401);
});

test('stale browser expected-user header denies account mismatch before creation, mutation or any R2 access', async t => {
  const f = await fixture(t, { forbidR2: true });
  const previous = await f.user({ role: 'admin' }), current = await f.user({ role: 'admin' });
  const cookie = await f.session(current);
  const content = await f.content(current, 'identity-guard');
  const headers = { 'X-Expected-User': previous.id };
  const before = {};
  for (const table of ['users', 'shares', 'requests', 'files']) before[table] = await f.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first('n');
  for (const [method, path, body] of [
    ['POST', '/api/shares/init', { title: 'Must not be created', files: [{ filename: 'synthetic.txt', size: 7 }] }],
    ['POST', '/api/requests', { title: 'Must not be created' }],
    ['POST', '/api/users', { name: 'Must not be invited', email: 'identity-mismatch@example.test' }],
    ['GET', '/api/auth/me'],
    ['GET', '/api/users'],
    ['GET', '/api/cost/estimate'],
    ['GET', '/api/shares'],
    ['GET', '/api/requests'],
    ['POST', `/api/shares/${content.share}/confirm`],
    ['POST', `/api/shares/${content.share}/download`],
    ['DELETE', `/api/shares/${content.share}`],
    ['POST', '/api/auth/reauth', { proof: current.proof }],
  ]) {
    const response = await f.request(path, { method, cookie, headers, body });
    await json(response, 401);
    assert.equal(response.headers.get('X-Identity-Mismatch'), '1');
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
  for (const table of Object.keys(before)) assert.equal(await f.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first('n'), before[table]);
  assert.deepEqual(f.r2Calls, []);
  assert.deepEqual(f.externalRequests, []);
  assert.equal(await f.db.prepare('SELECT is_active FROM shares WHERE id=?').bind(content.share).first('is_active'), 1);
  assert.equal((await json(await f.request('/api/auth/me', { cookie, headers: { 'X-Expected-User': current.id } }))).id, current.id);
  // Header is optional for compatible non-browser clients, never an identity override.
  assert.equal((await json(await f.request('/api/auth/me', { cookie }))).id, current.id);
});
