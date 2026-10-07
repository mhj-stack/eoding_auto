import path from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, readdir, lstat, copyFile, open, unlink, rm, rename } from 'node:fs/promises';
import { spawn } from 'node:child_process';

export const pluginRoot = fileURLToPath(new URL('../', import.meta.url));
const log = message => process.stderr.write(`[eoding-product-register] ${message}\n`);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export function privateDataDir(value = process.env.EODING_DATA_DIR || process.env.PLUGIN_DATA) {
  const dir = path.resolve(value || path.join(homedir(), '.eoding-product-importer-plugin'));
  if (dir === path.parse(dir).root || dir === path.resolve(homedir()) || dir === path.resolve(pluginRoot) || dir.startsWith('\\\\')) {
    throw new Error('Use a dedicated local EODING_DATA_DIR directory.');
  }
  return dir;
}

export async function runtimeFiles(root) {
  const files = ['plugin.json', 'package.json', 'package-lock.json', 'requirements.txt'];
  async function walk(relative) {
    if (!(await lstat(path.join(root, relative))).isDirectory()) throw new Error(`Plugin directory is invalid or a symlink: ${relative}`);
    for (const entry of (await readdir(path.join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`Plugin symlink is unsupported: ${name}`);
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile()) files.push(name);
    }
  }
  for (const relative of ['src', 'scripts', 'skills/eoding-product-register', 'examples']) await walk(relative);
  for (const name of files) if (!(await lstat(path.join(root, name))).isFile()) throw new Error(`Invalid plugin file: ${name}`);
  return files.sort();
}

export async function runtimeKey(root, files) {
  const hash = createHash('sha256').update(`${process.platform}/${process.arch}/node-${process.versions.node.split('.')[0]}\0`);
  for (const name of files) hash.update(name).update('\0').update(await readFile(path.join(root, name))).update('\0');
  return hash.digest('hex');
}

export function run(command, args, { cwd, env = process.env, quiet = false, timeout = 600000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Setup timed out: ${path.basename(command)}`)); }, timeout);
    const forward = chunk => { if (!quiet) process.stderr.write(chunk); };
    child.stdout.on('data', forward); child.stderr.on('data', forward);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`${path.basename(command)} exited with code ${code}`)); });
  });
}

export function findNpmCli(env = process.env) {
  const dirs = [path.dirname(process.execPath), ...(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)];
  const candidates = env.npm_execpath ? [env.npm_execpath] : [];
  for (const dir of dirs) {
    candidates.push(path.join(dir, 'node_modules/npm/bin/npm-cli.js'));
    candidates.push(path.resolve(dir, '../lib/node_modules/npm/bin/npm-cli.js'));
  }
  const found = candidates.find(candidate => path.basename(candidate) === 'npm-cli.js' && existsSync(candidate));
  if (!found) throw new Error('Node.js 22+ with npm is required. Install Node.js, then reconnect the plugin.');
  return found;
}

async function findPython() {
  const candidates = [
    ...(process.env.EODING_PYTHON ? [[process.env.EODING_PYTHON, []]] : []),
    ...(process.platform === 'win32' ? [['python', []], ['py', ['-3']]] : [['python3', []], ['python', []]])
  ];
  for (const [command, prefix] of candidates) {
    try {
      await run(command, [...prefix, '-c', 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)'], { quiet: true, timeout: 10000 });
      return { command, prefix };
    } catch { /* Try the next ordinary Python installation. */ }
  }
  throw new Error('Python 3.10+ is required. Install Python and reconnect, or set EODING_PYTHON to its executable.');
}

export async function installRuntime(root) {
  const npm = findNpmCli();
  const python = await findPython();
  log('Preparing dependencies in the private data folder. First setup may take several minutes.');
  await run(process.execPath, [npm, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: root });
  await run(process.execPath, [path.join(root, 'node_modules/playwright/cli.js'), 'install', 'chromium'], { cwd: root });
  await run(python.command, [...python.prefix, '-m', 'venv', path.join(root, 'python')], { cwd: root });
  const executable = pythonExecutable(root);
  await run(executable, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', path.join(root, 'requirements.txt')], { cwd: root });
  const require = createRequire(path.join(root, 'package.json'));
  if (!existsSync(require('playwright').chromium.executablePath())) throw new Error('Chromium installation was not verified.');
  require.resolve('@modelcontextprotocol/sdk/server/mcp.js');
  await run(executable, ['-c', 'import openpyxl; assert openpyxl.__version__ == "3.1.5"'], { quiet: true });
}

export const pythonExecutable = root => path.join(root, 'python', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');

async function ready(root, key) {
  try { return JSON.parse(await readFile(path.join(root, 'READY.json'), 'utf8')).key === key; }
  catch { return false; }
}

async function acquireLock(file, timeout = 600000) {
  const deadline = Date.now() + timeout;
  while (true) {
    try {
      const handle = await open(file, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      return async () => { await handle.close(); await unlink(file); };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner;
      try { owner = JSON.parse(await readFile(file, 'utf8')); } catch { /* Owner may still be writing the lock. */ }
      if (Number.isInteger(owner?.pid) && owner.pid > 0) {
        try { process.kill(owner.pid, 0); }
        catch (cause) {
          if (cause.code === 'ESRCH') { await unlink(file).catch(() => {}); continue; }
        }
      }
      if (Date.now() >= deadline) throw new Error('Another plugin setup is still running. Wait for it to finish, then reconnect.');
      await pause(500);
    }
  }
}

export async function prepareRuntime({ root = pluginRoot, dataDir = privateDataDir(), install = installRuntime } = {}) {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22 or newer is required.');
  const files = await runtimeFiles(root);
  const key = await runtimeKey(root, files);
  const cache = path.resolve(dataDir, 'runtimes');
  const target = path.join(cache, key);
  if (await ready(target, key)) return target;
  await mkdir(cache, { recursive: true });
  const release = await acquireLock(path.join(cache, 'setup.lock'));
  const temporary = path.join(cache, `.setup-${randomUUID()}`);
  try {
    if (await ready(target, key)) return target;
    await mkdir(temporary);
    for (const name of files) {
      const dest = path.join(temporary, name);
      await mkdir(path.dirname(dest), { recursive: true });
      await copyFile(path.join(root, name), dest);
    }
    await install(temporary);
    await writeFile(path.join(temporary, 'READY.json'), JSON.stringify({ key, installedAt: new Date().toISOString() }));
    await rename(temporary, target);
    return target;
  } finally {
    if (path.dirname(path.resolve(temporary)) !== cache || !path.basename(temporary).startsWith('.setup-')) throw new Error('Invalid setup cleanup target');
    try { await rm(temporary, { recursive: true, force: true, maxRetries: 3 }); }
    finally { await release(); }
  }
}
