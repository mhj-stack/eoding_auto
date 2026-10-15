import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProductImportPlugin } from '../src/plugin-runtime.mjs';
import { png } from './fixtures/product-only-page.mjs';

const identity = { companyId: '999', identity: { accountName: 'Fixture Operator', accountKey: 'fixture-account', sessionKey: 'fixture-session' } };
const queries = [
  { key: 'city', kind: 'city', query: '장가계' },
  { key: 'manager', kind: 'manager', query: 'Fixture' },
  { key: 'airline', kind: 'airline', query: 'OZ' },
  { key: 'outbound', kind: 'airport', query: 'ICN' },
  { key: 'inbound', kind: 'airport', query: 'CSX' },
  { key: 'secondCity', kind: 'city', query: '장사' }
];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(t, { failQuery, changeIdentity = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'plugin-batch-'));
  let identityReads = 0, concurrent = 0, maxConcurrent = 0;
  const requested = [];
  const page = { url: () => 'https://basecamp.team/tour/master_product/', evaluate: (fn, args) => fn(args) };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.method, 'GET');
    assert.equal(options.credentials, 'same-origin');
    const query = new URL(url, 'https://basecamp.team').searchParams.get('q');
    requested.push(query);
    concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
    try {
      await pause(15);
      if (query === failQuery) return new Response('forbidden', { status: 403 });
      return new Response(JSON.stringify({ results: [{ id: String(requested.indexOf(query) + 1), text: `${query} (관측값)` }] }), { headers: { 'content-type': 'application/json' } });
    } finally { concurrent--; }
  });
  const runtime = new ProductImportPlugin({ dataDir: root,
    browser: { ensurePage: async () => page, close: async () => {} },
    identityReader: async () => {
      identityReads++; await pause(5);
      return changeIdentity && identityReads > 1 ? { ...identity, identity: { ...identity.identity, sessionKey: 'changed-session' } } : identity;
    }
  });
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); });
  return { runtime, requested, counts: () => ({ identityReads, maxConcurrent }) };
}

test('batched selectors preserve sequential lookup results and use one RPC with two identity checks', async t => {
  const f = await fixture(t);
  const before = performance.now();
  const baseline = [];
  for (const { key, ...request } of queries) baseline.push({ key, ...await f.runtime.lookup(request) });
  const sequentialMs = performance.now() - before;
  assert.equal(f.counts().identityReads, 6);
  assert.equal(f.counts().maxConcurrent, 1);
  const start = performance.now();
  const batched = await f.runtime.lookups({ requests: queries });
  const batchedMs = performance.now() - start;
  assert.equal(batched.complete, true);
  assert.deepEqual(batched.errors, []);
  assert.equal(batched.companyId, identity.companyId);
  assert.deepEqual(batched.results.map(({ key, kind, query, results }) => ({ key, kind, query, results })), baseline.map(({ key, kind, query, results }) => ({ key, kind, query, results })));
  assert.equal(f.counts().identityReads, 8);
  assert.equal(f.counts().maxConcurrent, 4);
  assert.equal(f.requested.length, 12);
  process.stdout.write(JSON.stringify({ benchmark: 'synthetic-selector-lookup', sequentialRpcCount: 6, batchedRpcCount: 1, sequentialIdentityChecks: 6, batchedIdentityChecks: 2, sequentialMs: Math.round(sequentialMs), batchedMs: Math.round(batchedMs), erpWrites: 0 }) + '\n');
});

test('only failed batch keys need a retry; successful observed values remain explicit', async t => {
  const f = await fixture(t, { failQuery: 'OZ' });
  const result = await f.runtime.lookups({ requests: queries });
  assert.equal(result.complete, false);
  assert.equal(result.results.length, 5);
  assert.deepEqual(result.errors.map(({ key, kind }) => ({ key, kind })), [{ key: 'airline', kind: 'airline' }]);
  assert.match(result.errors[0].message, /403/);
  assert.equal(f.counts().identityReads, 2);
});

test('changed login identity invalidates the whole batch and never authorizes a write', async t => {
  const f = await fixture(t, { changeIdentity: true });
  await assert.rejects(() => f.runtime.lookups({ requests: queries }), /회사·계정·로그인 세션이 변경/);
  assert.equal(f.requested.length, 6);
  assert.equal(f.runtime.active, null);
});

test('invalid batches are rejected before opening a browser or reading identity', async t => {
  const f = await fixture(t);
  for (const requests of [[], [...queries, queries[0]], [{ key: 'x', kind: 'hotel', query: 'x' }], [{ key: 'x', kind: 'city', query: ' ' }], [{ key: 'x', kind: 'departport', productId: '../bad' }], [{ key: 'x', kind: 'city', query: '서울', identity: 'injected' }]]) {
    await assert.rejects(() => f.runtime.lookups({ requests }));
  }
  assert.equal(f.counts().identityReads, 0);
  assert.equal(f.requested.length, 0);
  f.runtime.active = { id: 'fixture-active' };
  await assert.rejects(() => f.runtime.lookups({ requests: queries }), /검토·실행 중/);
  f.runtime.active = null;
  assert.equal(f.counts().identityReads, 0);
});

test('compact polling preserves all completion/failure fields and omits repeated source-image metadata', async t => {
  const f = await fixture(t);
  const input = path.join(f.runtime.root, 'input'); await mkdir(input);
  f.runtime.inputDir = input;
  const job = await f.runtime.source({ text: 'Synthetic product evidence. '.repeat(1000), seasonMode: 'excluded' });
  const images = [];
  for (let index = 0; index < 20; index++) {
    const filePath = path.join(input, `source-${index}.png`);
    await writeFile(filePath, Buffer.concat([png, Buffer.from([index])]));
    images.push({ filePath, alt: `Synthetic gallery image ${index}` });
  }
  await f.runtime.images({ id: job.id, images });
  const current = await f.runtime.load(job.id);
  current.status = 'completed';
  current.result = { finalCheck: 'verified', productUrl: 'https://basecamp.team/tour/master_product/123/change/' };
  await f.runtime.save(current);
  const full = await f.runtime.get({ id: job.id });
  const compact = await f.runtime.get({ id: job.id, compact: true });
  for (const field of ['id', 'status', 'result', 'failure', 'progress', 'validation', 'approvalDelegation', 'resumeFrom']) assert.deepEqual(compact[field], full[field]);
  assert.equal(compact.imageCount, 20);
  assert.equal(compact.images, undefined);
  assert.equal(compact.sourceDescriptor, undefined);
  assert.equal(compact.sourceDigest, undefined);
  assert.ok((await f.runtime.get({ id: job.id, includeSource: true })).source);
  await assert.rejects(() => f.runtime.get({ id: job.id, compact: true, includeSource: true }), /함께/);
  const fullBytes = Buffer.byteLength(JSON.stringify(full)), compactBytes = Buffer.byteLength(JSON.stringify(compact));
  assert.ok(compactBytes < fullBytes / 2);
  process.stdout.write(JSON.stringify({ benchmark: '20-image-progress-payload', fullBytes, compactBytes, reductionPercent: Math.round((1 - compactBytes / fullBytes) * 100) }) + '\n');
});
