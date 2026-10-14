import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProductImportPlugin } from '../src/plugin-runtime.mjs';
import { erpLookup, lookupRow, engineQuery } from '../src/erp-lookup.mjs';
import { png } from './fixtures/product-only-page.mjs';
import { normalized, registration } from './fixtures/plugin-plan.mjs';

const identity = { accountName: '가상계정', accountKey: 'account-key', sessionKey: 'session-key' };
const exists = file => access(file).then(() => true, () => false);

async function fixture(t, launch) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eoding-speedup-'));
  const inputDir = path.join(root, 'input'); await mkdir(inputDir);
  const imagePath = path.join(inputDir, 'source.png'); await writeFile(imagePath, png);
  const page = { url: () => 'https://basecamp.team/tour/master_product/', goto: async () => {} };
  const runtime = new ProductImportPlugin({
    dataDir: path.join(root, 'state'), inputDir,
    browser: { close: async () => {}, ensurePage: async () => page, open: async () => ({}) },
    identityReader: async () => ({ companyId: '999', identity }), launch
  });
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); });
  const job = await runtime.source({ text: 'Synthetic product source', seasonMode: 'excluded' });
  const image = await runtime.image({ id: job.id, filePath: imagePath, alt: 'Source image' });
  const ready = await runtime.prepare({ id: job.id, product: normalized(job), registration: registration(image) });
  assert.equal(ready.status, 'ready-for-review', JSON.stringify(ready.validation));
  return { runtime, job, image };
}

test('a review that fails in read-only preflight can be corrected and reviewed again on the same job', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; throw new Error('treeitem 나고야 not visible'); });
  await assert.rejects(() => f.runtime.review({ id: f.job.id }), /ERP 저장 전 실패/);
  const failed = await f.runtime.get({ id: f.job.id });
  assert.equal(failed.status, 'review-preparation-failed');
  assert.deepEqual({ write: failed.failure.erpWriteStarted, retry: failed.failure.retryable }, { write: false, retry: true });
  assert.equal(await exists(path.join(f.runtime.directory(f.job.id), 'approved-plan.json')), false);
  const corrected = await f.runtime.prepare({ id: f.job.id, product: normalized(f.job), registration: registration(f.image) });
  assert.equal(corrected.status, 'ready-for-review');
  assert.equal(corrected.failure, null);
  await assert.rejects(() => f.runtime.review({ id: f.job.id }), /ERP 저장 전 실패/);
  assert.equal(calls, 2);
});

test('a review failure after the run journal exists stays locked for reconciliation', async t => {
  const f = await fixture(t, async ({ dataDir }) => { await mkdir(dataDir, { recursive: true }); throw new Error('late failure'); });
  await assert.rejects(() => f.runtime.review({ id: f.job.id }), /late failure/);
  const failed = await f.runtime.get({ id: f.job.id });
  assert.equal(failed.failure.retryable, false);
  await assert.rejects(() => f.runtime.prepare({ id: f.job.id, product: normalized(f.job), registration: registration(f.image) }), /이미 검토/);
  await assert.rejects(() => f.runtime.review({ id: f.job.id }), /등록 준비/);
});

test('ERP lookup rows keep exact labels, flag retired staff and expose the engine search text', async t => {
  assert.deepEqual(lookupRow({ id: 3334, text: '나고야(NGO)' }), { value: '3334', label: '나고야(NGO)' });
  assert.deepEqual(lookupRow({ id: '3626', text: '<span style="text-decoration:line-through;">(퇴사자)담당자1 기본부서</span>' }), { value: '3626', label: '(퇴사자)담당자1 기본부서', inactive: true });
  assert.equal(engineQuery('city', '나고야(NGO)'), '나고야');
  assert.equal(engineQuery('manager', '데모13 (기본부서)'), '데모13');
  assert.equal(engineQuery('airport', 'NGO - (공항)나고야(주부)'), 'NGO');
  assert.equal(engineQuery('airline', '7C - 제주항공'), undefined);

  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requested.push({ url, method: options.method });
    return new Response(JSON.stringify({ results: [{ id: '441', text: '7C - 제주항공' }], pagination: { more: false } }), { headers: { 'content-type': 'application/json' } });
  });
  const page = { evaluate: (fn, arg) => fn(arg) };
  const found = await erpLookup(page, { kind: 'airline', query: '제주항공' });
  assert.deepEqual(found.results, [{ value: '441', label: '7C - 제주항공' }]);
  assert.equal(requested.length, 1);
  assert.equal(requested[0].method, 'GET');
  assert.match(requested[0].url, /^\/common\/autocomplete\/airline\/\?q=/);
  await assert.rejects(() => erpLookup(page, { kind: 'hotel', query: 'x' }), /지원하지 않는/);
  await assert.rejects(() => erpLookup(page, { kind: 'city', query: ' ' }), /검색어/);
  await assert.rejects(() => erpLookup(page, { kind: 'departport' }), /상품 ID/);
});

test('shopping centers validate strictly and map to the native ERP form and detail section 8', async () => {
  const { validateShoppingPlan, shoppingCreateFields, expectedDetail, shoppingRows } = await import('../src/product-content-native.mjs');
  const item = { name: '보석백화점', cityLabel: '홍콩(HKG)', time: '약 40분', items: '보석', refund: 'possible', description: '홍콩 단체 쇼핑센터' };
  assert.deepEqual(validateShoppingPlan(undefined), []);
  assert.deepEqual(validateShoppingPlan([item]), [item]);
  assert.throws(() => validateShoppingPlan([{ ...item, refund: 'maybe' }]), /refund/);
  assert.throws(() => validateShoppingPlan([{ ...item, time: '' }]), /time/);
  assert.throws(() => validateShoppingPlan([item, { ...item }]), /Duplicate/);
  assert.throws(() => validateShoppingPlan([{ ...item, extra: 1 }]), /Invalid shopping/);
  const fields = shoppingCreateFields(item, { cityId: '2786', countryId: '40', continentId: '3' });
  assert.deepEqual(fields, { name_ko: '보석백화점', name: '', continent: '3', country: '40', city: '2786', use_flag: 'True', shopping_time: '약 40분', shopping_item: '보석', refund_flag: '1', refund_term: '', homepage: '', description: '홍콩 단체 쇼핑센터', keyword: '', image_sort: '{"old":[],"new":[]}' });
  const before = { 1: { etc: '[]', etc2: '' }, 2: { etc: '[]', etc2: '' }, 3: { etc: '[]' }, 4: { etc: '[]' }, 8: { etc: '[]', etc2: '', etc5: '0' } };
  const detail = { include: [], exclude: [], information: [], mainPoints: [], shoppingCount: '3' };
  assert.equal(expectedDetail(before, detail)['8'].etc, '[]');
  const linked = expectedDetail(before, detail, ['717', '3801']);
  assert.deepEqual(linked['8'], { etc: shoppingRows(['717', '3801']), etc2: '', etc5: '3' });
  assert.equal(linked['8'].etc, '[{"id":"717"},{"id":"3801"}]');
  assert.throws(() => expectedDetail({ ...before, 8: { etc: '[{"id":"1"}]', etc5: '1' } }, detail, ['717']), /Existing native shopping/);
});
