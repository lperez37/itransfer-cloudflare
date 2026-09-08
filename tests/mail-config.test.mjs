import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { configureLocal, parseArgs, parseConfig } from '../scripts/configure-mail.mjs';

const urlName = 'TRANSACTIONAL_MAIL_API_URL';
const keyName = 'TRANSACTIONAL_MAIL_API_KEY';
const key = `tm_live_${'0'.repeat(32)}_${'A'.repeat(43)}`;
const source = `${urlName}=https://mail.example.com\n${keyName}=${key}\n`;
const script = fileURLToPath(new URL('../scripts/configure-mail.mjs', import.meta.url));

async function directory(t) {
  const path = await fs.mkdtemp(join(tmpdir(), 'mail-config-test-'));
  t.after(() => fs.rm(path, { recursive: true, force: true }));
  return path;
}

function run(cwd, args = [], env = process.env) {
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', env });
}

test('strict parser supports comments, CRLF, whitespace, and literal quotes', () => {
  assert.deepEqual(parseConfig(` # configuration\r\n\r\n ${urlName} = "https://mail.example.com/" # origin\r\n${keyName}='${key}'\r\n`), {
    [urlName]: 'https://mail.example.com', [keyName]: key,
  });
});

test('parser rejects unknown, duplicate, missing, malformed, or expanding values', () => {
  const bad = [
    '', `${source}OTHER=value`, `${source}${keyName}=${key}`, `${urlName}=https://mail.example.com`,
    `export ${source}`, `${source}extra text`, source.replace(key, '${TOKEN}'),
    source.replace(key, '$(command)'), source.replace(key, `${key};command`),
    source.replace(key, `"${key}'`), source.replace(key, key.slice(1)),
    source.replace(key, key.replace('0000', 'GGGG')), source.replace(key, `${key}=`),
    source.replace(key, `${key} extra`), source.replace(key, `${key}\rextra`),
  ];
  for (const text of bad) assert.throws(() => parseConfig(text), { message: 'Invalid mail configuration' });
});

test('URL must be an HTTPS origin without credentials, query, fragment, or path', () => {
  for (const value of ['http://mail.example.com', 'https://user:pass@mail.example.com', 'https://mail.example.com/api', 'https://mail.example.com?', 'https://mail.example.com#', 'https://mail.example.com/?q=x', 'https://mail.example.com\\evil', 'https://', 'https://mail.example.com:99999', '${HOST}']) {
    assert.throws(() => parseConfig(source.replace('https://mail.example.com', value)), { message: 'Invalid mail configuration' });
  }
});

test('flags are explicit, bounded, and local by default', () => {
  assert.deepEqual(parseArgs([]), { file: 'transactional.key', config: 'wrangler.local.jsonc', remote: false });
  assert.deepEqual(parseArgs(['--remote', '--file', 'input.key', '--config', 'worker.jsonc']), { remote: true, file: 'input.key', config: 'worker.jsonc' });
  for (const args of [['--file'], ['--config', '--remote'], ['--other'], ['--remote', '--remote'], ['--file', 'a', '--file', 'b'], ['extra']]) assert.throws(() => parseArgs(args));
});

test('default invocation creates owner-only local configuration without exposing values', async t => {
  const cwd = await directory(t);
  await fs.writeFile(join(cwd, 'transactional.key'), source, { mode: 0o640 });
  const result = run(cwd);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'Local mail configuration updated\n');
  assert.equal(result.stderr, '');
  assert.equal(await fs.readFile(join(cwd, '.dev.vars'), 'utf8'), source);
  assert.equal((await fs.stat(join(cwd, '.dev.vars'))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(join(cwd, 'transactional.key'))).mode & 0o777, 0o640);
});

test('local update preserves unrelated bytes and deduplicates only mail assignments', async t => {
  const cwd = await directory(t);
  const prefix = Buffer.from('# unrelated \xff\r\nOTHER="unchanged"\r\n', 'latin1');
  await fs.writeFile(join(cwd, '.dev.vars'), Buffer.concat([prefix, Buffer.from(`${keyName}=old\r\n${keyName}=duplicate\r\nexport ${urlName}=old\r\n# final comment`)]), { mode: 0o644 });
  await configureLocal(parseConfig(source), cwd);
  const expected = Buffer.concat([prefix, Buffer.from(`${keyName}=${key}\r\n${urlName}=https://mail.example.com\r\n# final comment`)]);
  assert.deepEqual(await fs.readFile(join(cwd, '.dev.vars')), expected);
  await configureLocal(parseConfig(source), cwd);
  assert.deepEqual(await fs.readFile(join(cwd, '.dev.vars')), expected);
  assert.equal((await fs.stat(join(cwd, '.dev.vars'))).mode & 0o777, 0o600);
});

test('append handles an existing file without a final newline', async t => {
  const cwd = await directory(t);
  await fs.writeFile(join(cwd, '.dev.vars'), 'OTHER=value');
  await configureLocal(parseConfig(source), cwd);
  assert.equal(await fs.readFile(join(cwd, '.dev.vars'), 'utf8'), `OTHER=value\n${source}`);
});

test('input and output symlinks, dangling links, and directories fail closed', async t => {
  for (const target of ['transactional.key', '.dev.vars']) {
    for (const kind of ['symlink', 'dangling', 'directory']) {
      const cwd = await directory(t);
      await fs.writeFile(join(cwd, 'real'), source);
      if (target !== 'transactional.key') await fs.writeFile(join(cwd, 'transactional.key'), source);
      if (kind === 'directory') await fs.mkdir(join(cwd, target));
      else await fs.symlink(join(cwd, kind === 'dangling' ? 'missing' : 'real'), join(cwd, target));
      const result = run(cwd);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, 'Mail configuration failed\n');
      assert.equal(await fs.readFile(join(cwd, 'real'), 'utf8'), source);
      assert.equal((await fs.readdir(cwd)).some(name => name.endsWith('.tmp')), false);
    }
  }
});

test('malformed input never changes the output or prints sensitive content', async t => {
  const cwd = await directory(t);
  await fs.writeFile(join(cwd, 'transactional.key'), `${source}UNKNOWN=${key}`);
  await fs.writeFile(join(cwd, '.dev.vars'), 'OTHER=untouched');
  const result = run(cwd);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'Mail configuration failed\n');
  assert.equal(await fs.readFile(join(cwd, '.dev.vars'), 'utf8'), 'OTHER=untouched');
});

test('failed atomic replacement leaves the original intact and removes temporary secrets', async t => {
  const cwd = await directory(t);
  await fs.writeFile(join(cwd, '.dev.vars'), 'OTHER=untouched');
  t.mock.method(fs, 'rename', async () => { throw new Error('simulated rename failure'); });
  await assert.rejects(configureLocal(parseConfig(source), cwd));
  assert.equal(await fs.readFile(join(cwd, '.dev.vars'), 'utf8'), 'OTHER=untouched');
  assert.deepEqual(await fs.readdir(cwd), ['.dev.vars']);
});

test('remote mode sends both secrets only through stdin and suppresses child diagnostics', async t => {
  const cwd = await directory(t);
  await fs.writeFile(join(cwd, 'custom.key'), source);
  // A local stand-in intercepts npx; this test never invokes Wrangler or a network.
  await fs.writeFile(join(cwd, 'npx'), `#!${process.execPath}
import fs from 'node:fs';
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  fs.writeFileSync('invocation.json', JSON.stringify({ args: process.argv.slice(2), input }), { mode: 0o600 });
  process.stdout.write(input);
  process.stderr.write(input);
  process.exitCode = Number(process.env.MAIL_TEST_EXIT);
});
`, { mode: 0o700 });
  // Ensure the fake executable is treated as an ES module on supported Node versions.
  await fs.writeFile(join(cwd, 'package.json'), '{"type":"module"}');
  for (const exit of [0, 1]) {
    const result = run(cwd, ['--remote', '--file', 'custom.key', '--config', 'custom.jsonc'], { ...process.env, PATH: cwd, MAIL_TEST_EXIT: String(exit) });
    assert.equal(result.status, exit);
    assert.equal(result.stdout, exit === 0 ? 'Remote mail configuration updated\n' : '');
    assert.equal(result.stderr, exit === 0 ? '' : 'Mail configuration failed\n');
    const invocation = JSON.parse(await fs.readFile(join(cwd, 'invocation.json'), 'utf8'));
    assert.deepEqual(invocation.args, ['--no-install', 'wrangler', 'secret', 'bulk', '-c', join(cwd, 'custom.jsonc')]);
    assert.deepEqual(JSON.parse(invocation.input), parseConfig(source));
    await assert.rejects(fs.stat(join(cwd, '.dev.vars')), { code: 'ENOENT' });
  }
});

test('remote spawn failure is sanitized and never falls back to local writes', async t => {
  const cwd = await directory(t);
  await fs.writeFile(join(cwd, 'transactional.key'), source);
  const result = run(cwd, ['--remote'], { ...process.env, PATH: cwd });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'Mail configuration failed\n');
  assert.deepEqual(await fs.readdir(cwd), ['transactional.key']);
});
