import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProductImportPlugin } from '../src/plugin-runtime.mjs';
import { png } from './fixtures/product-only-page.mjs';

import { normalized, registration } from './fixtures/plugin-plan.mjs';
async function fixture(t, extra = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eoding-plugin-'));
  const inputDir = path.join(root, 'input'); await mkdir(inputDir);
  const imagePath = path.join(inputDir, 'source.png'); await writeFile(imagePath, png);
  const runtime = new ProductImportPlugin({ dataDir: path.join(root, 'state'), inputDir, browser: { close: async () => {} }, ...extra });
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); });
  const job = await runtime.source({ text: 'Synthetic product source', seasonMode: 'excluded' });
  return { runtime, job, root, inputDir, imagePath };
}

test('source → byte-bound image → normalized draft produces one reviewable product with no writes', async t => {
  const f = await fixture(t);
  const image = await f.runtime.image({ id: f.job.id, filePath: f.imagePath, alt: 'Source image' });
  const result = await f.runtime.prepare({ id: f.job.id, product: normalized(f.job), registration: registration(image) });
  assert.equal(result.status, 'ready-for-review', JSON.stringify(result.validation));
  assert.equal(result.validation.erpVerified, false);
  assert.equal((await f.runtime.get({ id: f.job.id, includeSource: true })).source.evidence.text, 'Synthetic product source');
  assert.deepEqual(await f.runtime.image({ id: f.job.id, filePath: f.imagePath, alt: 'same bytes' }), image);
});

test('incomplete data returns grouped questions and rejects foreign source/extra write instructions', async t => {
  const f = await fixture(t), product = normalized(f.job);
  const result = await f.runtime.prepare({ id: f.job.id, product, registration: {} });
  assert.equal(result.status, 'needs-input');
  assert.ok(result.validation.questions.length);
  await assert.rejects(() => f.runtime.prepare({ id: f.job.id, product, registration: { events: [] } }), /registration/);
  product.sources[0] = { ...product.sources[0], reference: 'unrelated source' };
  await assert.rejects(() => f.runtime.prepare({ id: f.job.id, product, registration: {} }), /sourceDescriptor/);
});

test('out-of-root image, changed source and a competing host fail before any review', async t => {
  const f = await fixture(t);
  const outside = path.join(f.root, 'outside.png'); await writeFile(outside, png);
  await assert.rejects(() => f.runtime.image({ id: f.job.id, filePath: outside, alt: 'outside' }), /EODING_INPUT_DIR/);
  const second = new ProductImportPlugin({ dataDir: f.runtime.root, inputDir: f.inputDir, browser: { close: async () => {} } });
  await assert.rejects(() => second.source({ text: 'Other', seasonMode: 'excluded' }), /다른 AI/);
  const file = path.join(f.runtime.directory(f.job.id), 'job.json');
  const stored = JSON.parse(await readFile(file, 'utf8')); stored.source.evidence.text = 'changed';
  await writeFile(file, JSON.stringify(stored));
  await assert.rejects(() => f.runtime.get({ id: f.job.id }), /원문이 변경/);
});

test('persisted pending execution is never silently made retryable after restart', async t => {
  const f = await fixture(t);
  const file = path.join(f.runtime.directory(f.job.id), 'job.json');
  const stored = JSON.parse(await readFile(file, 'utf8')); stored.status = 'awaiting-approval';
  await writeFile(file, JSON.stringify(stored));
  assert.equal((await f.runtime.get({ id: f.job.id })).status, 'interrupted-needs-reconciliation');
  await assert.rejects(() => f.runtime.prepare({ id: f.job.id, product: normalized(f.job), registration: {} }), /이미 검토/);
  await assert.rejects(() => f.runtime.review({ id: f.job.id }), /등록 준비/);
});
