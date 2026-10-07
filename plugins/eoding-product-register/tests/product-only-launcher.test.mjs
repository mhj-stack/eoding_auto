import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { ExistingProfileBrowser, startProductOnlyLauncher, validateProductOnlyLaunchPlan, verifyApprovedProductOnlyCdnImage } from '../src/product-only-launcher.mjs';
import { createProductOnlyApprovalBinding } from '../src/product-only-execution.mjs';
import { ScheduleSessionBrowser } from '../src/schedule-session.mjs';
import { installProductOnlyFixture, addUrl, contentControls, png, pngHash, tenant } from './fixtures/product-only-page.mjs';

const identity = { accountName: 'Fixture Operator', accountKey: 'fixture-account', sessionKey: 'fixture-session' };
const product = JSON.parse(await readFile(new URL('../examples/product.json', import.meta.url), 'utf8'));
const execFile = promisify(execFileCallback);

function plan(imagePath) {
  const normalized = structuredClone(product);
  normalized.departures[0].prices[0].child = { currency: 'KRW', amount: 80000 };
  normalized.departures[0].prices[0].infant = { currency: 'KRW', amount: 0 };
  const value = {
    target: { mode: 'NEW' }, product: normalized, identity: structuredClone(identity), companyId: tenant.companyId,
    source: { rows: normalized.itinerary.map(day => ({ id: `row-${day.day}` })), images: [{ id: 'image-1', path: imagePath, name: 'fixture.png', mimeType: 'image/png', sha256: pngHash, alt: 'fixture source image' }] },
    basic: { options: { cityLabel: '제주(CJU)', managerLabel: '가상담당자 (테스트팀)', priority: 7, cutoffDays: 3 } },
    display: { fields: { short_description: 'Fixture overview' }, images: [{ sourceImageId: 'image-1' }], imageQuery: 'fixture' },
    content: { detail: { include: [{ name: 'Hotel', description: 'One night' }], exclude: [], information: ['Fixture note'], mainPoints: ['Fixture point'], shoppingCount: '0' }, elements: [{ type: '3', text: 'Fixture heading' }, { type: '1', text: 'Fixture body' }] },
    shell: { title: 'Fixture schedule' }, itinerary: normalized.itinerary.map(day => ({ ...day, sourceRowId: `row-${day.day}` })),
    season: {
      fields: { title: 'Fixture season', currency_code: 'KRW', adult_base_price: '100000', child_base_price: '80000', infant_base_price: '0', adult_fuel_price: '0', child_fuel_price: '0', infant_fuel_price: '0', min_pax_count: '2', max_pax_count: '10', 'depart-0-depart_date': '2027-01-10', 'depart-0-flight_no': 'F100', 'depart-0-depart_time': '09:00', 'depart-0-arrive_time': '11:00', 'arrive-0-depart_date': '2027-01-11', 'arrive-0-flight_no': 'F101', 'arrive-0-depart_time': '12:40', 'arrive-0-arrive_time': '16:15', 'outbound-0-depart_time': '09:00', 'return-0-arrive_time': '16:15' },
      selects: { departport: '1', 'depart-0-airline': '2', 'depart-0-depart_cd': '3', 'depart-0-arrive_cd': '4', 'arrive-0-airline': '2', 'arrive-0-depart_cd': '4', 'arrive-0-arrive_cd': '3' },
      selectLabels: { departport: 'Fixture departure', 'depart-0-airline': 'Fixture Air', 'depart-0-depart_cd': 'ICN', 'depart-0-arrive_cd': 'TPE', 'arrive-0-airline': 'Fixture Air', 'arrive-0-depart_cd': 'TPE', 'arrive-0-arrive_cd': 'ICN' },
      selectedDates: ['2027-01-10']
    }
  };
  value.approvalBinding = createProductOnlyApprovalBinding(value);
  return value;
}

function noSeasonPlan(imagePath) {
  const value = plan(imagePath);
  delete value.season;
  value.seasonMode = 'excluded';
  delete value.approvalBinding;
  value.approvalBinding = createProductOnlyApprovalBinding(value);
  return value;
}

function domesticNoSeasonPlan(imagePath) {
  const value = noSeasonPlan(imagePath);
  value.product.destinations = ['Jeju'];
  value.product.includesFlight = false;
  value.product.departures = value.product.departures.map(departure => ({ ...departure, flights: [] }));
  delete value.approvalBinding;
  value.approvalBinding = createProductOnlyApprovalBinding(value);
  return value;
}

function domesticDayTripPlan(imagePath) {
  const value = domesticNoSeasonPlan(imagePath);
  value.product.nights = 0;
  value.product.days = 1;
  value.product.itinerary = [value.product.itinerary[0]];
  value.product.departures = [{ ...value.product.departures[0], endDate: value.product.departures[0].startDate }];
  value.source.rows = [{ id: 'row-1' }];
  value.itinerary = [{ ...value.itinerary[0], day: 1, sourceRowId: 'row-1' }];
  delete value.approvalBinding;
  value.approvalBinding = createProductOnlyApprovalBinding(value);
  return value;
}

test('public launcher routes one real approval through the production browser and all stages to final readback', { timeout: 60000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'product-only-launcher-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const imagePath = path.join(root, 'fixture.png');
  await writeFile(imagePath, png);
  let fixtureContext, fixtureState, opened = 0, closed = 0;
  const sessionBrowser = new ExistingProfileBrowser({
    browserDir: path.join(root, 'execution-browser', 'browser-profile'),
    launcher: {
      launchPersistentContext: async (profile, options) => {
        fixtureContext = await chromium.launchPersistentContext(profile, { ...options, headless: true, args: ['--host-resolver-rules=MAP * ~NOTFOUND'] });
        fixtureState = await installProductOnlyFixture(fixtureContext, { product });
        await fixtureContext.route('https://basecamp.team/tour/master_product/', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>Isolated fixture master list</body></html>' }));
        t.after(() => fixtureContext.close());
        return fixtureContext;
      }
    }
  });
  const browser = {
    async open() {
      opened += 1;
      const owned = await sessionBrowser.open();
      await owned.page.goto(addUrl);
      return { page: owned.page, close: async () => { closed += 1; await owned.close(); } };
    }
  };
  const launcher = await startProductOnlyLauncher({
    plan: plan(imagePath), dataDir: path.join(root, 'journal'), browser,
    controls: contentControls,
    identityReader: async () => identity,
    preflight: async () => ({ identity, baseline: { recordsTotal: 0, rows: [] }, basic: { status: 'fixture-ready', businessWrites: 0 }, schedule: { status: 'unverified-live-form' } }),
    recheckBaseline: async () => ({ recordsTotal: 0, rows: [] }),
    verifyUploadedImage: async ({ receipt, source }) => ({ tenantId: tenant.companyId, src: receipt.src, sha256: source.sha256 })
  });
  t.after(() => launcher.close());
  const outcome = launcher.completed.then(result => ({ result }), error => ({ error }));
  assert.equal(opened, 0);
  assert.deepEqual(launcher.writes, []);
  const review = await chromium.launch({ headless: true });
  t.after(() => review.close());
  const page = await review.newPage();
  await page.goto(launcher.url);
  assert.match(await page.textContent('body'), /상품 등록 최종 검토/);
  assert.equal(fixtureContext, undefined);
  await page.locator('input[name="company"]').fill(product.company.tenant);
  await page.locator('input[name="account"]').fill(identity.accountName);
  await page.locator('button[type="submit"]').click();
  const settled = await outcome;
  assert.equal(settled.error, undefined, JSON.stringify({ error: settled.error?.cause?.stack ?? settled.error?.stack, unexpected: fixtureState?.state?.unexpected, writes: fixtureState?.writes }));
  assert.equal(settled.result.status, 'completed');
  assert.equal(opened, 1);
  assert.equal(closed, 1);
  assert.deepEqual(launcher.preflight.baseline, { recordsTotal: 0, rows: [] });
  assert.deepEqual(fixtureState.writes.map(write => write.kind), ['basic-simulated-ui', 'detail', 'upload', 'reference', 'display', 'schedule-shell', 'schedule-day', 'schedule-day', 'season']);
  assert.equal(fixtureState.writes.filter(write => write.kind === 'schedule-shell').length, 1);
  await assert.rejects(() => launcher.executeApproved(), /consumed|already/i);
  assert.equal(createHash('sha256').update(png).digest('hex'), pngHash);
});

test('public launcher registers a NEW no-season plan and final readback proves zero seasons', { timeout: 60000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'product-only-no-season-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const imagePath = path.join(root, 'fixture.png');
  await writeFile(imagePath, png);
  const noSeason = noSeasonPlan(imagePath);
  let fixtureContext, fixtureState;
  const sessionBrowser = new ExistingProfileBrowser({
    browserDir: path.join(root, 'execution-browser', 'browser-profile'),
    launcher: { launchPersistentContext: async (profile, options) => {
      fixtureContext = await chromium.launchPersistentContext(profile, { ...options, headless: true, args: ['--host-resolver-rules=MAP * ~NOTFOUND'] });
      fixtureState = await installProductOnlyFixture(fixtureContext, { product });
      await fixtureContext.route('https://basecamp.team/tour/master_product/', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>Isolated fixture master list</body></html>' }));
      t.after(() => fixtureContext.close());
      return fixtureContext;
    } }
  });
  const launcher = await startProductOnlyLauncher({
    plan: noSeason, dataDir: path.join(root, 'journal'), controls: contentControls, identityReader: async () => identity,
    browser: { open: async () => { const owned = await sessionBrowser.open(); await owned.page.goto(addUrl); return owned; } },
    preflight: async () => ({ identity, baseline: { recordsTotal: 0, rows: [] }, basic: { status: 'fixture-ready', businessWrites: 0 }, schedule: { status: 'unverified-live-form' } }),
    recheckBaseline: async () => ({ recordsTotal: 0, rows: [] }),
    verifyUploadedImage: async ({ receipt, source }) => ({ tenantId: tenant.companyId, src: receipt.src, sha256: source.sha256 })
  });
  t.after(() => launcher.close());
  const outcome = launcher.completed.then(result => ({ result }), error => ({ error }));
  const review = await chromium.launch({ headless: true });
  t.after(() => review.close());
  const page = await review.newPage();
  await page.goto(launcher.url);
  assert.match(await page.textContent('body'), /시즌 제외/);
  assert.match(await page.textContent('body'), /1박 2일/);
  await page.locator('input[name="company"]').fill(noSeason.product.company.tenant);
  await page.locator('input[name="account"]').fill(identity.accountName);
  await page.locator('button[type="submit"]').click();
  const settled = await outcome;
  assert.equal(settled.error, undefined, JSON.stringify({ error: settled.error?.cause?.stack ?? settled.error?.stack, writes: fixtureState?.writes, unexpected: fixtureState?.state?.unexpected }));
  assert.deepEqual(settled.result.phases.map(item => item.name), ['basic', 'media', 'shell', ...noSeason.itinerary.map(day => `day:${day.day}`)]);
  assert.equal(settled.result.finalCheck.result.season.mode, 'excluded');
  assert.equal(settled.result.finalCheck.result.season.count, 0);
  assert.equal(fixtureState.state.seasons.length, 0);
  assert.equal(fixtureState.writes.some(write => write.kind === 'season'), false);
  assert.equal(fixtureState.writes.some(write => /event/i.test(write.kind)), false);
});

test('launcher accepts an explicit domestic 0-night 1-day no-season contract and rejects an implicit missing season', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'product-only-missing-season-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const imagePath = path.join(root, 'fixture.png');
  await writeFile(imagePath, png);
  const dayTrip = validateProductOnlyLaunchPlan(domesticDayTripPlan(imagePath));
  assert.equal(dayTrip.seasonMode, 'excluded');
  assert.equal(Object.hasOwn(dayTrip, 'season'), false);
  assert.equal(dayTrip.product.nights, 0);
  assert.equal(dayTrip.product.days, 1);
  assert.equal(dayTrip.product.includesFlight, false);
  const value = plan(imagePath);
  delete value.season;
  delete value.approvalBinding;
  assert.throws(() => validateProductOnlyLaunchPlan(value), /season.*required|season fields/i);
});

test('public CLI performs a local-only preflight smoke without opening a browser', { timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'product-only-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const imagePath = path.join(root, 'fixture.png'), planPath = path.join(root, 'plan.json'), dataDir = path.join(root, 'journal');
  await Promise.all([writeFile(imagePath, png), mkdir(dataDir)]);
  const rawPlan = plan(imagePath); delete rawPlan.approvalBinding;
  await writeFile(planPath, JSON.stringify(rawPlan));
  const { stdout, stderr } = await execFile(process.execPath, ['scripts/product-only-start.mjs', '--plan', planPath, '--data-dir', dataDir, '--preflight-only'], { cwd: process.cwd() });
  assert.equal(stderr, '');
  assert.match(stdout, /^PREFLIGHT /);
  assert.match(stdout, /local-inputs-verified/);
});

test('changed source plan is rejected at claim before the browser opens or any ERP write', { timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'product-only-plan-drift-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const imagePath = path.join(root, 'fixture.png'), planPath = path.join(root, 'plan.json');
  await writeFile(imagePath, png);
  const rawPlan = plan(imagePath); await writeFile(planPath, JSON.stringify(rawPlan));
  let opened = 0;
  const launcher = await startProductOnlyLauncher({
    plan: rawPlan, planPath, dataDir: path.join(root, 'journal'), browser: { open: async () => { opened += 1; throw new Error('must not open'); } }, identityReader: async () => identity,
    preflight: async () => ({ identity, baseline: { recordsTotal: 0, rows: [] }, basic: { businessWrites: 0 }, schedule: { status: 'unverified' } })
  });
  t.after(() => launcher.close());
  const modified = structuredClone(rawPlan); modified.basic.options.priority = 8;
  delete modified.approvalBinding;
  await writeFile(planPath, JSON.stringify(modified));
  const review = await chromium.launch({ headless: true }); t.after(() => review.close());
  const page = await review.newPage(); await page.goto(launcher.url);
  const outcome = launcher.completed.then(value => ({ value }), error => ({ error }));
  await page.locator('input[name="company"]').fill(product.company.tenant);
  await page.locator('input[name="account"]').fill(identity.accountName);
  await page.locator('button[type="submit"]').click();
  assert.match((await outcome).error?.message ?? '', /source plan changed|reconciliation/i);
  assert.equal(opened, 0);
  await launcher.close();
});

test('changed image bytes are rejected before the first basic write', { timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'product-only-image-drift-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const imagePath = path.join(root, 'fixture.png'); await writeFile(imagePath, png);
  let fixtureContext, fixtureState;
  const sessionBrowser = new ScheduleSessionBrowser({ dataDir: path.join(root, 'execution-browser'), launcher: { launchPersistentContext: async (profile, options) => {
    fixtureContext = await chromium.launchPersistentContext(profile, { ...options, headless: true, args: ['--host-resolver-rules=MAP * ~NOTFOUND'] });
    fixtureState = await installProductOnlyFixture(fixtureContext, { product }); return fixtureContext;
  } } });
  const launcher = await startProductOnlyLauncher({
    plan: plan(imagePath), dataDir: path.join(root, 'journal'), controls: contentControls, identityReader: async () => identity,
    browser: { open: async () => { const page = await sessionBrowser.ensurePage(); await page.goto(addUrl); return { page, close: async () => sessionBrowser.close() }; } },
    preflight: async () => ({ identity, baseline: { recordsTotal: 0, rows: [] }, basic: { businessWrites: 0 }, schedule: { status: 'unverified' } }),
    recheckBaseline: async () => ({ recordsTotal: 0, rows: [] })
  });
  t.after(() => launcher.close());
  await writeFile(imagePath, Buffer.from('changed image bytes'));
  const review = await chromium.launch({ headless: true }); t.after(() => review.close());
  const page = await review.newPage(); await page.goto(launcher.url);
  const outcome = launcher.completed.then(value => ({ value }), error => ({ error }));
  await page.locator('input[name="company"]').fill(product.company.tenant);
  await page.locator('input[name="account"]').fill(identity.accountName);
  await page.locator('button[type="submit"]').click();
  assert.match((await outcome).error?.message ?? '', /image|reconciliation/i);
  assert.ok(fixtureContext);
  assert.deepEqual(fixtureState.writes, []);
});

test('CDN verification streams an approved image when content-length is absent', async () => {
  const source = { id: 'image-1', path: 'C:\\private\\fixture.png', name: 'fixture.png', mimeType: 'image/png', sha256: pngHash, alt: 'fixture' };
  const src = `${tenant.imageUrlPrefix}chunked.png`;
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(png)); controller.close(); } });
  const result = await verifyApprovedProductOnlyCdnImage({ receipt: { src }, source, companyId: tenant.companyId, fetchImpl: async () => ({ ok: true, url: src, redirected: false, headers: new Headers({ 'content-type': 'image/png' }), body }) });
  assert.deepEqual(result, { tenantId: tenant.companyId, src, sha256: pngHash, bytes: png.length });
});
