import test from 'node:test';
import assert from 'node:assert/strict';
import { migrationStatements } from './helpers/migrations.mjs';
import { fixture } from './helpers/worker.mjs';

test('migration lexer preserves multi-statement triggers, CASE, comments and quoted semicolons', () => {
  const statements = migrationStatements(`-- heading ;
    CREATE TABLE "a;b"(x TEXT);
    CREATE TRIGGER example AFTER INSERT ON "a;b" BEGIN
      INSERT INTO "a;b" VALUES(CASE WHEN NEW.x='a;''b' THEN 'END;' ELSE 'BEGIN' END);
      /* END; */ UPDATE "a;b" SET x='--not a comment;';
    END;
    SELECT 1; -- trailing
  `);
  assert.equal(statements.length, 3);
  assert.match(statements[1], /UPDATE/);
  assert.match(statements[1], /'a;''b'/);
  assert.throws(() => migrationStatements('CREATE TRIGGER t AFTER INSERT ON a BEGIN SELECT 1;'), /Unterminated/);
});

test('all real migrations execute in workerd D1 including sensitive-change and last-admin triggers', async t => {
  const f = await fixture(t, { databaseOnly: true });
  const admin = await f.user({ role: 'admin' });
  const member = await f.user();
  await f.session(member);
  await f.db.prepare("UPDATE users SET role='admin' WHERE id=?").bind(member.id).run();
  assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM user_sessions').first('n'), 0);
  await f.db.prepare("UPDATE users SET role='user' WHERE id=?").bind(member.id).run();
  await assert.rejects(f.db.prepare("UPDATE users SET role='user' WHERE id=?").bind(admin.id).run(), /last_active_admin/);
  await assert.rejects(f.db.prepare('DELETE FROM users WHERE id=?').bind(member.id).run(), /accounts_cannot_be_deleted/);
  await assert.rejects(f.db.prepare('UPDATE users SET password_salt=? WHERE id=?').bind('fe'.repeat(16), member.id).run(), /credential_salt_immutable/);
  const token = 'aa'.repeat(32);
  await f.db.prepare('INSERT INTO password_tokens VALUES(?,?,?,?)').bind(token, member.id, 9999999999, 1).run();
  await f.session(member);
  const generation = await f.db.prepare('SELECT session_generation FROM users WHERE id=?').bind(member.id).first('session_generation');
  await f.db.prepare('UPDATE users SET password_hash=password_hash WHERE id=?').bind(member.id).run();
  assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM user_sessions').first('n'), 0);
  assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM password_tokens').first('n'), 0);
  assert.equal(await f.db.prepare('SELECT session_generation FROM users WHERE id=?').bind(member.id).first('session_generation'), generation + 1);
});
