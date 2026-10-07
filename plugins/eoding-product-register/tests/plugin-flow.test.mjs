import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { ProductImportPlugin } from '../src/plugin-runtime.mjs';
import { ScheduleSessionBrowser } from '../src/schedule-session.mjs';
import { ERP_URL } from '../src/browser.mjs';
import { installProductOnlyFixture, contentControls, png, tenant } from './fixtures/product-only-page.mjs';
import { listFixture } from './fixtures/product-list-page.mjs';
import { normalized, registration } from './fixtures/plugin-plan.mjs';

for (const dropMediaPersistence of [false, true]) test('plugin full flow: ' + (dropMediaPersistence ? 'partial product is reported without retry' : 'one review and final saved-product result'), { timeout: 90000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'plugin-flow-'));
  const inputDir = path.join(root, 'input'); await mkdir(inputDir);
  await writeFile(path.join(inputDir, 'source.png'), png);
  const identity = { accountName: 'Fixture Operator', accountKey: 'fixture-account', sessionKey: 'fixture-session' };
  let state, product;
  const browser = new ScheduleSessionBrowser({ dataDir: path.join(root, 'browser'), launcher: { launchPersistentContext: async (profile, options) => {
    const context = await chromium.launchPersistentContext(profile, { ...options, headless: true, args: ['--host-resolver-rules=MAP * ~NOTFOUND'] });
    state = await installProductOnlyFixture(context, { product, dropMediaPersistence });
    await context.route(ERP_URL, route => route.fulfill({ status: 200, contentType: 'text/html', body: listFixture() }));
    return context;
  } } });
  const runtime = new ProductImportPlugin({
    dataDir: path.join(root, 'state'), inputDir, browser,
    identityReader: async () => ({ companyId: tenant.companyId, identity }),
    launchOptions: {
      identityReader: async () => identity, controls: contentControls,
      preflight: async () => ({ identity, baseline: { recordsTotal: 0, rows: [] }, basic: { status: 'isolated-fixture-ready', businessWrites: 0 } }),
      recheckBaseline: async () => ({ recordsTotal: 0, rows: [] }),
      verifyUploadedImage: async ({ receipt, source }) => ({ tenantId: tenant.companyId, src: receipt.src, sha256: source.sha256 })
    }
  });
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  const job = await runtime.source({ text: 'Fixture whole product source', seasonMode: 'excluded' });
  product = normalized(job);
  const image = await runtime.image({ id: job.id, filePath: path.join(inputDir, 'source.png'), alt: 'Fixture' });
  assert.equal((await runtime.prepare({ id: job.id, product, registration: registration(image) })).status, 'ready-for-review');
  await runtime.openBrowser();
  const review = await runtime.review({ id: job.id });
  assert.equal(state.writes.length, 0, 'Opening a review cannot write');
  const done = runtime.active.done;
  const client = await chromium.launch({ headless: true });
  t.after(() => client.close());
  const page = await client.newPage();
  await page.goto(review.reviewUrl);
  await page.locator('input[name="company"]').fill(product.company.tenant);
  await page.locator('input[name="account"]').fill(identity.accountName);
  await page.locator('button[type=submit]').click();
  await done;
  const result = await runtime.get({ id: job.id });
  if (dropMediaPersistence) {
    assert.equal(result.status, 'needs-reconciliation', JSON.stringify(result));
    assert.ok(result.failure.erpWriteStarted);
    assert.ok(result.progress.target.productId);
    assert.match(result.progress.productUrl, /master_product/);
    assert.deepEqual(result.progress.verifiedPhases, ['basic']);
    assert.equal(state.writes.filter(item => item.kind === 'schedule-shell').length, 0);
    await assert.rejects(() => runtime.review({ id: job.id }), /등록 준비/);
    return;
  }
  assert.equal(result.status, 'completed', JSON.stringify(result.failure));
  assert.equal(result.result.finalCheck, 'verified');
  assert.match(result.result.productUrl, /\/tour\/master_product\/\d+\/change\//);
  assert.deepEqual(state.writes.map(item => item.kind), ['basic-simulated-ui', 'detail', 'upload', 'reference', 'display', 'schedule-shell', 'schedule-day', 'schedule-day']);
  assert.equal(state.state.seasons.length, 0);
  await assert.rejects(() => runtime.review({ id: job.id }), /등록 준비/);
});
