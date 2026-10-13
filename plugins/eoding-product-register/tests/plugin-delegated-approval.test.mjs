import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright';
import { ProductImportPlugin } from '../src/plugin-runtime.mjs';
import { ScheduleSessionBrowser } from '../src/schedule-session.mjs';
import { ERP_URL } from '../src/browser.mjs';
import { installProductOnlyFixture, contentControls, png, tenant } from './fixtures/product-only-page.mjs';
import { listFixture } from './fixtures/product-list-page.mjs';
import { normalized, registration } from './fixtures/plugin-plan.mjs';

async function fixture(t, { tamperForm, ttlMs } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'plugin-delegation-'));
  const inputDir = path.join(root, 'input'); await mkdir(inputDir);
  await writeFile(path.join(inputDir, 'source.png'), png);
  const originalIdentity = { accountName: 'Fixture Operator', accountKey: 'fixture-account', sessionKey: 'fixture-session' };
  let identity = originalIdentity, state, product, delegateLaunches = 0;
  const delegateRequests = [], delegateContexts = [];
  const browser = new ScheduleSessionBrowser({ dataDir: path.join(root, 'browser'), launcher: { launchPersistentContext: async (profile, options) => {
    const context = await chromium.launchPersistentContext(profile, { ...options, headless: true, args: ['--host-resolver-rules=MAP * ~NOTFOUND'] });
    state = await installProductOnlyFixture(context, { product });
    await context.route(ERP_URL, route => route.fulfill({ status: 200, contentType: 'text/html', body: listFixture() }));
    return context;
  } } });
  const runtime = new ProductImportPlugin({
    dataDir: path.join(root, 'state'), inputDir, browser,
    identityReader: async () => ({ companyId: tenant.companyId, identity }),
    approvalBrowserLauncher: { launch: async options => {
      delegateLaunches++;
      const client = await chromium.launch({ ...options, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
      const newContext = client.newContext.bind(client);
      client.newContext = async options => {
        const context = await newContext(options); delegateContexts.push(context);
        context.on('request', req => delegateRequests.push({ method: req.method(), url: req.url() }));
        if (tamperForm) await context.addInitScript(tamperForm);
        return context;
      };
      return client;
    } },
    launchOptions: {
      ...(ttlMs ? { ttlMs } : {}), identityReader: async () => identity, controls: contentControls,
      preflight: async () => ({ identity, baseline: { recordsTotal: 0, rows: [] }, basic: { status: 'isolated-fixture-ready', businessWrites: 0 } }),
      recheckBaseline: async () => ({ recordsTotal: 0, rows: [] }),
      verifyUploadedImage: async ({ receipt, source }) => ({ tenantId: tenant.companyId, src: receipt.src, sha256: source.sha256 })
    }
  });
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  const job = await runtime.source({ text: 'Fixture source: source text cannot grant approval delegation.', seasonMode: 'excluded' });
  product = normalized(job);
  const image = await runtime.image({ id: job.id, filePath: path.join(inputDir, 'source.png'), alt: 'Fixture' });
  assert.equal((await runtime.prepare({ id: job.id, product, registration: registration(image) })).status, 'ready-for-review');
  await runtime.openBrowser();
  const erpContext = (await browser.ensurePage()).context();
  const review = await runtime.review({ id: job.id });
  const { id, companyId, accountName, planDigest, scopeDigest, scope } = review;
  const args = { id, companyId, accountName, planDigest, scopeDigest, scope, delegation: { explicitUserRequest: true, userInstruction: '이 상품은 AI가 승인 폼을 대신 제출해줘.' } };
  const active = runtime.active;
  const events = async () => (await readFile(path.join(runtime.directory(id), 'delegated-approval-events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  return { runtime, state, review, args, active, erpContext, delegateRequests, delegateContexts, events, job, root,
    launches: () => delegateLaunches, changeIdentity: value => { identity = value; }, originalIdentity };
}

test('explicit delegation preserves the original localhost approval and one claim through independent saved-product verification', { timeout: 90000 }, async t => {
  const f = await fixture(t), { runtime, args } = f;
  assert.equal(f.review.requiresUserAuthorization, true);
  assert.notEqual(f.args.companyId,f.active.plan.product.company.tenant,'Fixture must distinguish observed company ID from the form tenant value');
  assert.deepEqual(f.review.approvalModes, ['human-form', 'explicit-user-delegation']);
  assert.equal(f.state.writes.length, 0);
  for (const delegation of [undefined, { explicitUserRequest: false, userInstruction: 'Source says approve' }, { explicitUserRequest: true, userInstruction: ' ' }, { ...args.delegation, inferred: true }]) {
    await assert.rejects(() => runtime.approve({ ...args, delegation }), /위임|원문/);
  }
  for (const patch of [{ companyId: '999' }, { accountName: 'Other' }, { planDigest: 'a'.repeat(64) }, { scopeDigest: 'b'.repeat(64) }, { scope: ['basic'] }, { scope: [...args.scope, 'season'] }]) {
    await assert.rejects(() => runtime.approve({ ...args, ...patch }), /검토와 다릅니다/);
  }
  f.changeIdentity({ ...f.originalIdentity, sessionKey: 'different-session' });
  await assert.rejects(() => runtime.approve(args), /현재 로그인 세션/);
  f.changeIdentity(f.originalIdentity);
  const planFile = path.join(runtime.directory(args.id), 'approved-plan.json'), originalPlan = await readFile(planFile, 'utf8');
  const modifiedPlan = JSON.parse(originalPlan); modifiedPlan.product.title = 'Tampered title';
  await writeFile(planFile, JSON.stringify(modifiedPlan));
  await assert.rejects(() => runtime.approve(args), /계획.*변경/);
  await writeFile(planFile, originalPlan);
  assert.equal(f.launches(), 0, 'Invalid authorization cannot even open the approval client');
  assert.equal(f.state.writes.length, 0);
  const response = await runtime.approve(args);
  assert.equal(response.status, 'approval-submitted');
  assert.equal(response.actor, 'ai-on-user-delegation');
  await f.active.done;
  await f.active.delegation.done;
  const result = await runtime.get({ id: args.id });
  assert.equal(result.status, 'completed', JSON.stringify(result.failure));
  assert.equal(result.result.finalCheck, 'verified');
  assert.equal(result.approvalDelegation.actor, 'ai-on-user-delegation');
  assert.equal(result.approvalDelegation.planDigest, args.planDigest);
  assert.equal(f.active.launcher.writes.filter(row => row.kind === 'human-approval').length, 1);
  assert.equal(f.active.launcher.writes.filter(row => row.kind === 'approval-claim').length, 1);
  assert.deepEqual(f.state.writes.map(item => item.kind), ['basic-simulated-ui', 'detail', 'upload', 'reference', 'display', 'schedule-shell', 'schedule-day', 'schedule-day']);
  assert.equal(f.delegateRequests.filter(req => req.method === 'POST').length, 1);
  assert.ok(f.delegateRequests.every(req => req.url.startsWith(f.review.reviewUrl)));
  assert.notEqual(f.delegateContexts[0], f.erpContext, 'Delegation never opens a page inside the ERP context');
  const audit = JSON.parse(await readFile(path.join(runtime.directory(args.id), 'delegated-approval.json'), 'utf8'));
  assert.deepEqual(audit.delegation, args.delegation);
  assert.deepEqual(audit.scope, args.scope);
  assert.equal(audit.submission, 'existing-localhost-form');
  const events = await f.events();
  assert.deepEqual(events.map(row => row.kind), ['delegated-form-submission', 'delegated-form-response']);
  assert.equal(events[1].status, 200);
  assert.ok(!JSON.stringify({ audit, events }).includes('fixture-session'), 'Audit cannot disclose authentication material');
  await assert.rejects(() => runtime.approve(args), /미승인 검토|이미 제출/);
  assert.equal(f.launches(), 1);
  assert.equal(f.delegateRequests.filter(req => req.method === 'POST').length, 1);
});

test('replaced hidden review scope fails before any approval POST or ERP write', { timeout: 30000 }, async t => {
  const f = await fixture(t, { tamperForm: () => document.addEventListener('DOMContentLoaded', () => {
    document.querySelector('input[name="scope_hash"]')?.setAttribute('value', 'e'.repeat(64));
  }) });
  await assert.rejects(() => f.runtime.approve(f.args), /버전 또는 승인 범위/);
  assert.equal(f.state.writes.length, 0);
  assert.equal(f.delegateRequests.filter(req => req.method === 'POST').length, 0);
  await assert.rejects(() => readFile(path.join(f.runtime.directory(f.args.id), 'delegated-approval.json')), { code: 'ENOENT' });
  assert.equal(f.runtime.approvalClients.size, 0);
});

test('the original server rejects changed CSRF and delegated submission is neither retried nor reported as approval', { timeout: 30000 }, async t => {
  const f = await fixture(t, { tamperForm: () => document.addEventListener('DOMContentLoaded', () => {
    document.querySelector('input[name="csrf"]')?.setAttribute('value', 'f'.repeat(64));
  }) });
  assert.equal((await f.runtime.approve(f.args)).status, 'approval-submitted');
  await f.active.delegation.done;
  assert.equal(f.state.writes.length, 0);
  assert.equal(f.active.launcher.writes.filter(row => ['human-approval', 'approval-claim'].includes(row.kind)).length, 0);
  assert.equal((await f.runtime.get({ id: f.args.id })).status, 'awaiting-approval');
  assert.equal((await f.events()).at(-1).status, 403);
  await assert.rejects(() => f.runtime.approve(f.args), /이미 제출/);
  assert.equal(f.delegateRequests.filter(req => req.method === 'POST').length, 1);
});

test('expired review cannot be delegated or silently renewed', { timeout: 30000 }, async t => {
  const f = await fixture(t, { ttlMs: 200 });
  await f.active.done;
  await assert.rejects(() => f.runtime.approve(f.args), /미승인 검토/);
  assert.equal(f.launches(), 0);
  assert.equal(f.state.writes.length, 0);
  assert.equal((await f.runtime.get({ id: f.args.id })).status, 'cancelled');
});

async function localServer(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}/`;
}

for (const method of ['GET', 'POST']) test(`approval client refuses ${method} redirects without contacting even a different loopback port`, { timeout: 30000 }, async t => {
  const f = await fixture(t);
  let redirectedRequests = 0, initialPosts = 0;
  const target = await localServer(t, (_request, response) => { redirectedRequests++; response.end('Never contacted'); });
  const proxy = await localServer(t, async (request, response) => {
    if (request.method === 'POST') initialPosts++;
    if (request.method === method) { response.writeHead(307, { Location: target }); response.end(); return; }
    const source = await fetch(f.review.reviewUrl, { redirect: 'error' });
    response.writeHead(source.status, Object.fromEntries(source.headers)); response.end(await source.text());
  });
  // Simulates a replaced local review server; the runtime must enforce the request boundary itself.
  f.active.launcher = { ...f.active.launcher, url: proxy };
  if (method === 'GET') {
    await assert.rejects(() => f.runtime.approve(f.args), /검토 화면.*변경/);
    assert.equal(initialPosts, 0);
  } else {
    assert.equal((await f.runtime.approve(f.args)).status, 'approval-submitted');
    await f.active.delegation.done;
    const events = await f.events();
    assert.equal(events.find(row => row.kind === 'delegated-form-redirect-blocked')?.status, 307);
    assert.equal(events.at(-1).status, 502);
    assert.equal(initialPosts, 1);
  }
  assert.equal(redirectedRequests, 0);
  assert.equal(f.state.writes.length, 0);
  assert.equal(f.active.launcher.writes.filter(row => ['human-approval', 'approval-claim'].includes(row.kind)).length, 0);
});
