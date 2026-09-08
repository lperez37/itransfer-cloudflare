// Local: node scripts/configure-mail.mjs [--file transactional.key]
// Remote (explicit Worker secret update): add --remote [--config wrangler.local.jsonc].
// The input accepts only TRANSACTIONAL_MAIL_API_URL and TRANSACTIONAL_MAIL_API_KEY.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const names = ['TRANSACTIONAL_MAIL_API_URL', 'TRANSACTIONAL_MAIL_API_KEY'];
const invalid = () => new Error('Invalid mail configuration');

export function parseConfig(text) {
  const config = {};
  for (const line of text.split(/\r?\n/)) {
    if (/^[\t ]*(?:#.*)?$/.test(line)) continue;
    const match = line.match(/^[\t ]*([A-Z_]+)[\t ]*=[\t ]*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s'"#]+))[\t ]*(?:[\t ]#.*)?$/);
    if (!match || !names.includes(match[1]) || Object.hasOwn(config, match[1])) throw invalid();
    config[match[1]] = match[2] ?? match[3] ?? match[4];
  }
  if (Object.keys(config).length !== 2 || !/^tm_live_[0-9a-f]{32}_[A-Za-z0-9_-]{43}$/.test(config[names[1]])) throw invalid();
  const value = config[names[0]];
  if (!/^https:\/\/[A-Za-z0-9.:[\]-]+\/?$/.test(value)) throw invalid();
  let url;
  try { url = new URL(value); } catch { throw invalid(); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw invalid();
  config[names[0]] = url.origin;
  return config;
}

async function readRegular(path, optional = false) {
  let handle;
  try {
    // NONBLOCK prevents a substituted FIFO from blocking before the type check.
    handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) throw invalid();
    return { bytes: await handle.readFile(), stat };
  } catch (error) {
    if (optional && error.code === 'ENOENT') {
      // A dangling symlink is not a missing output file.
      try { await fs.lstat(path); } catch (missing) {
        if (missing.code === 'ENOENT') return null;
      }
    }
    throw invalid();
  } finally {
    await handle?.close();
  }
}

export async function configureLocal(config, directory = process.cwd()) {
  const output = join(directory, '.dev.vars');
  const previous = await readRegular(output, true);
  // Latin-1 round-trips unrelated bytes, including comments and line endings.
  const text = previous?.bytes.toString('latin1') ?? '';
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const seen = new Set();
  let updated = '';
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const match = line.match(/^[\t ]*(?:export[\t ]+)?(TRANSACTIONAL_MAIL_API_URL|TRANSACTIONAL_MAIL_API_KEY)[\t ]*=/);
    if (!match) { updated += line; continue; }
    if (!seen.has(match[1])) {
      const ending = line.endsWith('\r\n') ? '\r\n' : line.endsWith('\n') ? '\n' : '';
      updated += `${match[1]}=${config[match[1]]}${ending}`;
      seen.add(match[1]);
    }
  }
  for (const name of names) {
    if (seen.has(name)) continue;
    if (updated && !updated.endsWith('\n')) updated += newline;
    updated += `${name}=${config[name]}${newline}`;
  }
  const temporary = join(directory, `.dev.vars.${randomUUID()}.tmp`);
  let handle;
  let created = false;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    created = true;
    await handle.chmod(0o600);
    await handle.writeFile(Buffer.from(updated, 'latin1'));
    await handle.sync();
    await handle.close();
    handle = null;
    let current;
    try { current = await fs.lstat(output); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (previous ? !current?.isFile() || current.dev !== previous.stat.dev || current.ino !== previous.stat.ino || current.size !== previous.stat.size || current.mtimeMs !== previous.stat.mtimeMs || current.ctimeMs !== previous.stat.ctimeMs : current) throw invalid();
    await fs.rename(temporary, output);
  } finally {
    await handle?.close();
    if (created) await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw invalid(); });
  }
}

export function parseArgs(args) {
  const options = { file: 'transactional.key', config: 'wrangler.local.jsonc', remote: false };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!['--file', '--config', '--remote'].includes(flag) || seen.has(flag)) throw invalid();
    seen.add(flag);
    if (flag === '--remote') { options.remote = true; continue; }
    const value = args[++i];
    if (!value || value.startsWith('-') || value.includes('\0')) throw invalid();
    options[flag.slice(2)] = value;
  }
  return options;
}

async function configureRemote(config, path) {
  await new Promise((accept, reject) => {
    const child = spawn('npx', ['--no-install', 'wrangler', 'secret', 'bulk', '-c', resolve(path)], {
      shell: false,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.on('error', () => reject(invalid()));
    child.stdin.on('error', () => reject(invalid()));
    child.on('close', code => code === 0 ? accept() : reject(invalid()));
    child.stdin.end(JSON.stringify(config));
  });
}

export async function main(args = process.argv.slice(2)) {
  try {
    const options = parseArgs(args);
    const input = await readRegular(resolve(options.file));
    const config = parseConfig(new TextDecoder('utf-8', { fatal: true }).decode(input.bytes));
    if (options.remote) {
      await configureRemote(config, options.config);
      console.log('Remote mail configuration updated');
    } else {
      await configureLocal(config);
      console.log('Local mail configuration updated');
    }
    return 0;
  } catch {
    // Never expose input, filesystem errors, or Wrangler diagnostics.
    console.error('Mail configuration failed');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
