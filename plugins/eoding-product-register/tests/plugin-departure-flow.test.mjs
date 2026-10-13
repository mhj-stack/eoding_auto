import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, cp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { ScheduleSessionBrowser } from '../src/schedule-session.mjs';
import { startProductOnlyLauncher, validateProductOnlyLaunchPlan } from '../src/product-only-launcher.mjs';
import { ProductImportPlugin } from '../src/plugin-runtime.mjs';
import { installProductOnlyFixture, contentControls, addUrl, png, pngHash, tenant } from './fixtures/product-only-page.mjs';
import { installPluginDepartureFixture } from './fixtures/plugin-departure-page.mjs';
import { registration } from './fixtures/plugin-plan.mjs';
const sample = JSON.parse(await readFile(new URL('../examples/product.json', import.meta.url)));
const identity = { accountName: 'Fixture Operator', accountKey: 'fixture-account', sessionKey: 'fixture-session' };
async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'plugin-event-')), imagePath = path.join(root, 'fixture.png');
  await writeFile(imagePath, png);
  const product = structuredClone(sample);
  product.departures[0].prices[0] = { ...product.departures[0].prices[0], adult: { currency: 'KRW', amount: 120000 }, child: { currency: 'KRW', amount: 100000 }, infant: { currency: 'KRW', amount: 10000 } };
  const mapping = registration({ id: 'image-1', name: 'fixture.png' });
  const plan = { ...mapping, target: { mode: 'NEW' }, product, identity, companyId: tenant.companyId, seasonMode: 'included', departure: { create: true, status: '3' }, source: { rows: product.itinerary.map(day => ({ id: `r${day.day}` })), images: [{ id: 'image-1', name: 'fixture.png', path: imagePath, mimeType: 'image/png', sha256: pngHash, alt: 'test image' }] }, itinerary: product.itinerary.map(day => ({ ...day, sourceRowId: `r${day.day}` })), season: {
    fields: { title: 'Test season', currency_code: 'KRW', adult_base_price: '100000', child_base_price: '80000', infant_base_price: '10000', adult_fuel_price: '20000', child_fuel_price: '20000', infant_fuel_price: '0', min_pax_count: '2', max_pax_count: '10', 'depart-0-depart_date': product.departures[0].startDate, 'depart-0-flight_no': 'WE0531', 'depart-0-depart_time': '10:05', 'depart-0-arrive_time': '12:45', 'depart-0-moving_time': '160', 'arrive-0-depart_date': product.departures[0].endDate, 'arrive-0-flight_no': 'WE0532', 'arrive-0-depart_time': '14:05', 'arrive-0-arrive_time': '17:30', 'arrive-0-moving_time': '205' },
    selects: { departport: '1', 'depart-0-airline': '2', 'depart-0-depart_cd': '3', 'depart-0-arrive_cd': '4', 'arrive-0-airline': '2', 'arrive-0-depart_cd': '4', 'arrive-0-arrive_cd': '3' }, selectLabels: { departport: 'Fixture departure', 'depart-0-airline': 'Fixture Air', 'depart-0-depart_cd': 'ICN', 'depart-0-arrive_cd': 'TPE', 'arrive-0-airline': 'Fixture Air', 'arrive-0-depart_cd': 'TPE', 'arrive-0-arrive_cd': 'ICN' }, selectedDates: [product.departures[0].startDate]
  } };
  let server, departureServer, review, launcher; const cleanup = [];
  const browser = new ScheduleSessionBrowser({ dataDir: path.join(root, 'erp'), launcher: { async launchPersistentContext(profile, options) {
    const context = await chromium.launchPersistentContext(profile, { ...options, headless: true, args: ['--host-resolver-rules=MAP * ~NOTFOUND'] });
    server = await installProductOnlyFixture(context, { product });
    server.state.omitSeasonDuration = fixtureOptions.omitSeasonDuration === true;
    await context.route('https://basecamp.team/tour/master_product/', route => route.fulfill({ contentType: 'text/html', body: '<p>Fixture master list</p>' }));
    departureServer = await installPluginDepartureFixture(context, server.state, fixtureOptions);
    return context;
  } } });
  const fixtureOptions = options;
  t.after(async () => { for (const fn of cleanup) await fn(); await launcher?.close(); await review?.close(); await browser.close(); assert.ok(root.startsWith(path.resolve(os.tmpdir()) + path.sep)); await rm(root, { recursive: true, force: true }); });
  launcher = await startProductOnlyLauncher({ plan, dataDir: path.join(root, 'run'), controls: contentControls, identityReader: async () => identity, budgetMode: 'report', browser: { async open() { const page = await browser.ensurePage(); await page.goto(addUrl); return { page, async close() {} }; } }, preflight: async () => ({ identity, baseline: { recordsTotal: 0, rows: [] }, basic: { status: 'fixture', businessWrites: 0 }, schedule: { status: 'fixture' } }), recheckBaseline: async () => ({ recordsTotal: 0, rows: [] }), verifyUploadedImage: async ({ receipt, source }) => ({ tenantId: tenant.companyId, src: receipt.src, sha256: source.sha256 }) });
  const outcome = launcher.completed.then(result => ({ result }), error => ({ error }));
  review = await chromium.launch({ headless: true }); const page = await review.newPage();
  await page.goto(launcher.url); assert.match(await page.textContent('body'), /행사 1건/);
  assert.equal(await page.locator('input[name="scope"]').inputValue(), 'basic,display,content,shell,days,season,departure');
  await page.locator('input[name="company"]').fill(product.company.tenant); await page.locator('input[name="account"]').fill(identity.accountName); await page.locator('button[type="submit"]').click({ noWaitAfter: true });
  const result = await outcome;
  return { ...result, server, departureServer, launcher, root, plan, browser, cleanup };
}
test('one approval saves product, season and a single event with full independent price/flight/schedule reads', { timeout: 90000 }, async t => {
  const run = await fixture(t);
  assert.equal(run.error, undefined, run.error?.cause?.cause?.stack ?? run.error?.cause?.stack ?? run.error?.stack);
  assert.equal(run.result.finalCheck.status, 'verified'); assert.equal(run.result.finalCheck.result.departure.eventId, '60001');
  assert.equal(run.departureServer.createPosts, 1); assert.equal(run.server.state.seasons.length, 1);
  assert.equal(run.result.phases.at(-1).name, 'departure');
  await assert.rejects(() => run.launcher.executeApproved(), /consumed|already/);
});
test('event readback rejects changed fuel and never replays creation', { timeout: 90000 }, async t => {
  const run = await fixture(t, { corruptFuel: true });
  assert.ok(run.error); assert.equal(run.departureServer.createPosts, 1);
  assert.equal(run.server.state.seasons.length, 1);
});
test('an already connected event blocks duplicate creation before POST', { timeout: 90000 }, async t => {
  const run = await fixture(t, { duplicate: true });
  assert.ok(run.error); assert.equal(run.departureServer.createPosts, 0);
});

test('resume independently verifies saved content then creates only the missing season and event', { timeout: 120000 }, async t => {
  const first = await fixture(t, { omitSeasonDuration: true });
  assert.ok(first.error); assert.equal(first.server.state.seasons.length, 0);
  const before = first.server.writes.map(item => item.kind);
  assert.deepEqual(before, ['basic-simulated-ui', 'detail', 'upload', 'reference', 'display', 'schedule-shell', 'schedule-day', 'schedule-day']);
  first.server.state.omitSeasonDuration = false;
  const runtime = new ProductImportPlugin({ dataDir: path.join(first.root, 'resume-state'), browser: first.browser, identityReader: async () => ({ companyId: tenant.companyId, identity }), launchOptions: { identityReader: async () => identity, controls: contentControls, verifyUploadedImage: async ({ receipt, source }) => ({ tenantId: tenant.companyId, src: receipt.src, sha256: source.sha256 }) } });
  first.cleanup.push(() => runtime.close());
  const original = await runtime.source({ text: 'Fixture original product source', seasonMode: 'included' });
  const parent = await runtime.load(original.id), bound = validateProductOnlyLaunchPlan(first.plan);
  parent.draft = { product: structuredClone(first.plan.product), registration: Object.fromEntries(['basic', 'display', 'content', 'shell', 'season', 'departure'].map(key => [key, structuredClone(first.plan[key])])) };
  parent.images = bound.source.images; parent.status = 'needs-reconciliation'; await runtime.save(parent);
  await writeFile(path.join(runtime.directory(parent.id), 'approved-plan.json'), JSON.stringify(bound));
  await cp(path.join(first.root, 'run'), path.join(runtime.directory(parent.id), 'run'), { recursive: true });
  const resumed = await runtime.resume({ id: parent.id });
  assert.equal(resumed.status, 'ready-for-review', JSON.stringify(resumed.validation));
  await assert.rejects(() => runtime.resume({ id: parent.id }), /EEXIST/);
  const review = await runtime.review({ id: resumed.id }); assert.deepEqual(review.scope, ['season', 'departure']);
  const done = runtime.active.done;
  const client = await chromium.launch({ headless: true });
  try {
    const page = await client.newPage(); await page.goto(review.reviewUrl);
    await page.locator('input[name="company"]').fill(first.plan.product.company.tenant); await page.locator('input[name="account"]').fill(identity.accountName); await page.locator('button[type="submit"]').click({ noWaitAfter: true });
    await done;
    const result = await runtime.get({ id: resumed.id });
    assert.equal(result.result?.finalCheck, 'verified', JSON.stringify(result.failure));
    assert.deepEqual(first.server.writes.map(item => item.kind), [...before, 'season', 'departure']);
    assert.equal(first.departureServer.createPosts, 1);
  } finally { await client.close(); }
});
