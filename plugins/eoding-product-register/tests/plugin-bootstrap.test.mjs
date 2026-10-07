import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { prepareRuntime, runtimeFiles } from '../scripts/plugin-bootstrap.mjs';

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'eoding-bootstrap-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 3 }));
  const root = path.join(dir, 'plugin'), dataDir = path.join(dir, 'private');
  for (const name of ['src', 'scripts', 'skills/eoding-product-register', 'examples']) await mkdir(path.join(root, name), { recursive: true });
  for (const name of ['plugin.json', 'package.json', 'package-lock.json']) await writeFile(path.join(root, name), '{}');
  await writeFile(path.join(root, 'requirements.txt'), '');
  await writeFile(path.join(root, 'src/plugin-mcp.mjs'), 'export const value = 1;');
  return { root, dataDir };
}

test('concurrent setup installs once, reuses cache, and isolates a changed version from private jobs', async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.dataDir, 'jobs'), { recursive: true });
  await writeFile(path.join(f.dataDir, 'jobs/keep.json'), 'private');
  let count = 0;
  const install = async target => {
    count++;
    assert.equal(await readFile(path.join(target, 'src/plugin-mcp.mjs'), 'utf8'), count === 1 ? 'export const value = 1;' : 'export const value = 2;');
    await new Promise(resolve => setTimeout(resolve, 30));
  };
  const [a, b] = await Promise.all([prepareRuntime({ ...f, install }), prepareRuntime({ ...f, install })]);
  assert.equal(a, b); assert.equal(count, 1);
  await writeFile(path.join(f.root, 'src/plugin-mcp.mjs'), 'export const value = 2;');
  const c = await prepareRuntime({ ...f, install });
  assert.notEqual(c, a); assert.equal(count, 2);
  assert.equal(await readFile(path.join(f.dataDir, 'jobs/keep.json'), 'utf8'), 'private');
  assert.ok(!(await readdir(path.join(f.dataDir, 'runtimes'))).some(name => name.startsWith('.setup-') || name.endsWith('.lock')));
});

test('failed setup leaves no ready runtime, releases its lock, and permits a clean retry', async t => {
  const f = await fixture(t);
  await assert.rejects(prepareRuntime({ ...f, install: async () => { throw new Error('fixture install failed'); } }), /fixture install failed/);
  assert.deepEqual(await readdir(path.join(f.dataDir, 'runtimes')), []);
  const target = await prepareRuntime({ ...f, install: async () => {} });
  assert.ok(JSON.parse(await readFile(path.join(target, 'READY.json'))).key);
});

test('runtime allowlist excludes local state and tests, and rejects linked source directories', async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, '.local'));
  await writeFile(path.join(f.root, '.local/cookies.json'), 'private');
  await mkdir(path.join(f.root, 'tests'));
  await writeFile(path.join(f.root, 'tests/private.json'), 'private');
  assert.ok(!(await runtimeFiles(f.root)).some(name => name.includes('.local') || name.startsWith('tests/')));
  await symlink(path.join(f.root, '.local'), path.join(f.root, 'src/linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(runtimeFiles(f.root), /symlink/);
});

test('marketplace resolves to the portable plugin and uses its bootstrap', async () => {
  const repo = fileURLToPath(new URL('../../../', import.meta.url));
  // Tests run inside plugins/eoding-product-register/tests.
  const catalogPath = path.resolve(repo, '.agents/plugins/marketplace.json');
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  const item = catalog.plugins.find(item => item.name === 'eoding-product-register');
  assert.equal(catalog.name, 'eoding-auto');
  const root = path.resolve(path.dirname(path.dirname(path.dirname(catalogPath))), item.source.path);
  const plugin = JSON.parse(await readFile(path.join(root, 'plugin.json'), 'utf8'));
  const config = JSON.parse(await readFile(path.join(root, 'mcp.json'), 'utf8'));
  assert.equal(plugin.name, item.name);
  assert.deepEqual(config.mcpServers[item.name].args, ['${PLUGIN_ROOT}/scripts/plugin-start.mjs']);
});
