import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { digest } from '../src/core.mjs';
import { createProductLowLevelAdapters } from '../src/product-execution.mjs';
import { createProductOnlyApprovalBinding } from '../src/product-only-execution.mjs';
import { startProductOnlyContinuation, verifyProductOnlyContinuationEvidence, resumeUnforwardedProductOnlyContinuation, resumeVerifiedUploadProductOnlyContinuation } from '../src/product-only-continuation.mjs';
import { ScheduleSessionBrowser } from '../src/schedule-session.mjs';
import { contentControls, installProductOnlyFixture, pageUrl, png, pngHash, tenant, image as existingImage } from './fixtures/product-only-page.mjs';

const identity = { accountName:'Fixture Operator', accountKey:'fixture-account', sessionKey:'fixture-session' };
const product = JSON.parse(await readFile(new URL('../examples/product.json', import.meta.url), 'utf8'));
const sha256 = value => createHash('sha256').update(value).digest('hex');

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
      selectLabels: { departport: 'Fixture departure', 'depart-0-airline': 'Fixture Air', 'depart-0-depart_cd': 'ICN', 'depart-0-depart_cd': 'ICN', 'depart-0-arrive_cd': 'TPE', 'arrive-0-airline': 'Fixture Air', 'arrive-0-depart_cd': 'TPE', 'arrive-0-arrive_cd': 'ICN' },
      selectedDates: ['2027-01-10']
    }
  };
  value.approvalBinding = createProductOnlyApprovalBinding(value);
  return value;
}

async function originalEvidence(root, value, receipt) {
  const journalDir = path.join(root, 'original-journal');
  const runtimeDir = path.join(root, 'original-runtime');
  await Promise.all([mkdir(journalDir), mkdir(runtimeDir)]);
  await writeFile(path.join(runtimeDir, 'frozen.mjs'), 'export default "frozen";\n');
  const approval = { status: 'approved', version: 1, planDigest: value.approvalBinding.planDigest, scopeDigest: value.approvalBinding.scopeDigest, tenantObserved: tenant.companyId, accountObserved: identity.accountName, approvedAt: 10, expiresAt: 100, method: 'localhost-human-form' };
  const claim = { id: `product-only:${value.approvalBinding.planDigest}`, target: { mode: 'NEW' }, planDigest: value.approvalBinding.planDigest, scopeDigest: value.approvalBinding.scopeDigest, claimedAt: 11 };
  const events = [
    { kind: 'human-approval', approval },
    { kind: 'approval-claim', claim },
    { kind: 'coordinator-evidence', value: { status: 'receipt-verified', phase: 'basic', result: { name: 'basic', receipt, verification: true } } },
    { kind: 'coordinator-evidence', value: { status: 'before-write', phase: 'media', targets: { mode: 'NEW', productId: receipt.productId, masterCode: receipt.masterCode } } },
    { kind: 'adapter-evidence', event: { phase: 'result', status: 'needs-reconciliation', completed: [], uploads: [], forwarded: 0, message: 'Missing native CSRF' } },
    { kind: 'coordinator-evidence', value: { status: 'unknown-save-outcome', phase: 'media', message: 'Media needs-reconciliation; no automatic retry' } },
    { kind: 'needs-reconciliation', result: { status: 'needs-reconciliation', message: 'media save outcome is unknown; reconcile before any retry' } }
  ];
  const journal = events.map(value => JSON.stringify(value)).join('\n') + '\n';
  const execution = JSON.stringify({ kind: 'execution-start', value: { mode: 'wx', lifecycle: 'product-only-execution', target: { mode: 'NEW' }, approvalBinding: value.approvalBinding, phases: ['basic', 'display', 'content', 'shell', 'day', 'season'] } }) + '\n';
  const checkpoint = JSON.stringify({ last: events.at(-1), events: events.length }) + '\n';
  await Promise.all([
    writeFile(path.join(journalDir, 'journal.jsonl'), journal),
    writeFile(path.join(journalDir, 'execution.jsonl'), execution),
    writeFile(path.join(journalDir, 'checkpoint.json'), checkpoint)
  ]);
  const planPath = path.join(root, 'plan.json');
  await writeFile(planPath, JSON.stringify(value));
  return { planPath, journalDir, runtimeDir };
}

const json = value => JSON.stringify(value) + '\n';
const journalText = events => events.map(json).join('');
async function manifestFor(dir) {
  const result = await Promise.all((await readdir(dir)).map(async name => ({ name, sha256:sha256(await readFile(path.join(dir, name))) })));
  return result.sort((a, b) => a.name.localeCompare(b.name));
}
function savedDetail() {
  const value = Object.fromEntries(Array.from({ length:8 }, (_, i) => [String(i + 1), { type:String(i + 1), etc:i < 4 ? '[]' : '', etc2:'', etc5:i === 7 ? '0' : '', untouched:'KEEP' }]));
  value['1'].etc = JSON.stringify([{ value:'Direct', label:'Hotel', remark:'One night' }]);
  value['3'].etc = JSON.stringify([{ content:'Fixture note' }]);
  value['4'].etc = JSON.stringify([{ content:'Fixture point' }]);
  return value;
}
async function recoveryFixture(t, receipt = { productId:812345, masterCode:'CJU-SYNTHETIC' }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'product-only-recovery-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const imagePath = path.join(root, 'fixture.png'); await writeFile(imagePath, png);
  const value = plan(imagePath), original = await originalEvidence(root, value, receipt);
  const pinned = await verifyProductOnlyContinuationEvidence(original), manifest = pinned.manifest;
  const dirs = { planReal:original.planPath, journalReal:original.journalDir, runtimeReal:original.runtimeDir };
  const target = { productId:Number(receipt.productId), masterCode:receipt.masterCode };
  const renewed = structuredClone(value); renewed.identity.sessionKey = 'historical-renewed-session';
  renewed.continuation = {
    kind:'product-only-session-renewal-v1', authentication:{ status:'renewed', companyId:String(value.companyId), identity:structuredClone(renewed.identity) }, target,
    original:{ identity:structuredClone(value.identity), companyId:String(value.companyId), approvalBinding:structuredClone(value.approvalBinding), paths:dirs, manifest, manifestDigest:digest(manifest), images:structuredClone(value.source.images) }
  };
  renewed.approvalBinding = createProductOnlyApprovalBinding(renewed);
  const detail = savedDetail();
  const nativeTarget = { origin:'https://basecamp.team', productId:String(receipt.productId), masterCode:receipt.masterCode, pageUrl };
  async function historical(name, start, recovery, priorFailure) {
    const dir = path.join(root, name); await mkdir(dir);
    const scopeDigest = digest({ kind:'product-only-continuation-review-v1', target, manifest,
      ...(recovery ? { recovery:{ directory:recovery.dir, manifest:recovery.manifest, detail:recovery.detail } } : {}),
      ...(priorFailure ? { priorFailure } : {}), phases:['media','shell','day','season','finalCheck'], renewalBinding:renewed.approvalBinding });
    const reservation = path.join(root, '.continuation-reservations', `${priorFailure ? digest({ original:value.approvalBinding.planDigest, recovery:recovery.manifest, priorFailure:priorFailure.reservation }) : recovery ? digest({ original:value.approvalBinding.planDigest, recovery:recovery.manifest }) : value.approvalBinding.planDigest}.json`);
    let at = start; const events = []; const add = (kind, fields = {}) => { const entry = { kind, at, ...fields }; at += 10; events.push(entry); return entry; };
    add('continuation-start', { manifest }); add('original-evidence-verified', { target }); add('session-renewal-review', { plan:renewed });
    add('preflight-verified', { target:pageUrl, schedules:0, seasons:0, forwardedWrites:0, expectedProbes:3, blockedThirdParty:0 });
    if (recovery) add('detail-recovery-verified', { recovery });
    if (priorFailure) add('prior-failure-verified', { priorFailure });
    const approval = { status:'approved', version:1, scopeDigest, planDigest:renewed.approvalBinding.planDigest, tenantObserved:String(value.product.company.tenant), accountObserved:identity.accountName, approvedAt:at, expiresAt:start < 100000 ? 9000 : start + 900000, method:'localhost-human-form' };
    add('human-approval', { approval });
    const claim = { id:`product-only:${renewed.approvalBinding.planDigest}`, target:{ mode:'NEW' }, planDigest:renewed.approvalBinding.planDigest, scopeDigest, claimedAt:at - 2 };
    const claimRow = add('approval-claim', { claim, reservation });
    add('before-write', { phase:'media', targets:{ mode:'NEW', ...target } });
    if (recovery) add('adapter-evidence', { event:{ phase:'detail-reconciled', target:nativeTarget, payload:detail } });
    else {
      add('write-authorized', { event:{ key:'detail', target:nativeTarget, payload:detail, continuation:{ planDigest:renewed.approvalBinding.planDigest } } });
      add('adapter-evidence', { event:{ phase:'attempt', key:'detail', target:nativeTarget } });
    }
    add('adapter-evidence', { event:{ phase:'result', status:'needs-reconciliation', target:nativeTarget, completed:recovery ? [] : ['detail'], uploads:[], forwarded:recovery ? 0 : 1 } });
    add('needs-reconciliation', { diagnostic:'CONTINUATION_FAILED' }); add('needs-reconciliation', { result:{ status:'needs-reconciliation' } });
    if (!recovery) add('continuation-closed', { status:'closed' });
    await mkdir(path.dirname(reservation), { recursive:true });
    await writeFile(reservation, json({ kind:'product-only-continuation-reservation', originalJournal:original.journalDir, dataDir:dir, at:claimRow.at - 1 }));
    await Promise.all([writeFile(path.join(dir, 'continuation-plan.json'), json(renewed)), writeFile(path.join(dir, 'original-manifest.json'), json(manifest)), writeFile(path.join(dir, 'continuation.jsonl'), journalText(events))]);
    return { dir, events, reservation };
  }
  const first = await historical('detail-only', 1000), recovery = { dir:first.dir, manifest:await manifestFor(first.dir), detail };
  const second = await historical('unforwarded', 2000, recovery);
  const options = { ...original, reconciledRunDir:first.dir, priorFailedRunDir:second.dir };
  return { root, value, renewed, original, first, second, options, detail,
    third:async ({ start = Date.now() - 5000 } = {}) => { const proof = await verifyProductOnlyContinuationEvidence(options); return historical('approved-unforwarded', start, recovery, proof.priorFailure); },
    rewrite:async () => writeFile(path.join(second.dir, 'continuation.jsonl'), journalText(second.events)),
    audit:() => verifyProductOnlyContinuationEvidence(options)
  };
}

test('read-only audit pins the exact original, detail save, unforwarded failure, and both consumed reservations', async t => {
  const f = await recoveryFixture(t), before = await manifestFor(f.second.dir), proof = await f.audit();
  assert.deepEqual(proof.target, { productId:812345, masterCode:'CJU-SYNTHETIC' });
  assert.equal(proof.priorFailure.dir, f.second.dir);
  assert.deepEqual(proof.priorFailure.manifest, before);
  assert.deepEqual(proof.priorFailure.reservations.map(entry => entry.path), [f.first.reservation, f.second.reservation]);
  assert.notEqual(proof.reservationPath, f.second.reservation);
  assert.deepEqual(await manifestFor(f.second.dir), before, 'inspection never appends to historical evidence');
  await assert.rejects(readFile(proof.reservationPath), { code:'ENOENT' }, 'inspection does not consume approval');
});

test('replay slot stays consumed even if a harmless file is added to prior failure evidence', async t => {
  const f = await recoveryFixture(t), first = await f.audit();
  await writeFile(path.join(f.second.dir, 'note.txt'), 'Historical diagnostic note.\n');
  const second = await f.audit();
  assert.notDeepEqual(first.priorFailure.manifest, second.priorFailure.manifest);
  assert.equal(first.reservationPath, second.reservationPath);
  await writeFile(first.reservationPath, json({ fixture:'already claimed' }));
  await assert.rejects(f.audit(), /already has a consumed continuation reservation/);
});

for (const [field, value] of [['forwarded',1], ['completed',['detail']], ['uploads',[{ id:'90' }]]]) {
  test(`rejects prior failure with ${field} evidence of a possible write`, async t => {
    const f = await recoveryFixture(t); f.second.events.find(row => row.event?.phase === 'result').event[field] = value; await f.rewrite();
    await assert.rejects(f.audit(), /not provably unforwarded/);
  });
}

for (const kind of ['write-authorized','receipt-verified','completed','prior-failure-verified']) {
  test(`rejects additional ${kind} evidence instead of generalizing arbitrary recovery chains`, async t => {
    const f = await recoveryFixture(t); f.second.events.splice(8, 0, { kind, at:f.second.events[8].at }); await f.rewrite();
    await assert.rejects(f.audit(), /later, repeated, or ambiguous/);
  });
}

test('rejects a different target, changed saved detail, and stale human approval scope', async t => {
  for (const mutate of [events => { events.find(row => row.event?.phase === 'result').event.target = { productId:'999', masterCode:'OTHER' }; }, events => { events.find(row => row.event?.phase === 'detail-reconciled').event.payload = { changed:true }; }, events => { events.find(row => row.kind === 'human-approval').approval.scopeDigest = 'unbound-scope'; }]) {
    const f = await recoveryFixture(t); mutate(f.second.events); await f.rewrite();
    await assert.rejects(f.audit(), /different detail or target|approval or claim is inconsistent/);
  }
});

test('rejects unknown outcomes and truncated journals even when forwarded is zero', async t => {
  const f = await recoveryFixture(t); f.second.events.find(row => row.kind === 'needs-reconciliation').diagnostic = 'UNKNOWN_SAVE_OUTCOME'; await f.rewrite();
  await assert.rejects(f.audit(), /unknown save outcome/);
  await writeFile(path.join(f.second.dir, 'continuation.jsonl'), journalText(f.second.events).trimEnd());
  await assert.rejects(f.audit(), /incomplete or truncated/);
});

test('rejects missing, changed, or redirected predecessor reservations', async t => {
  const f = await recoveryFixture(t), bytes = await readFile(f.second.reservation);
  await rm(f.second.reservation);
  await assert.rejects(f.audit(), { code:'ENOENT' });
  const reserved = JSON.parse(bytes); reserved.dataDir = f.first.dir; await writeFile(f.second.reservation, json(reserved));
  await assert.rejects(f.audit(), /does not bind this run/);
  await writeFile(f.second.reservation, bytes);
  f.second.events.find(row => row.kind === 'approval-claim').reservation = f.first.reservation; await f.rewrite();
  await assert.rejects(f.audit(), /reservation path differs/);
});

test('requires the exact first recovery manifest and rejects output overlapping historical evidence before opening browser', async t => {
  const f = await recoveryFixture(t); let opened = false;
  await assert.rejects(startProductOnlyContinuation({ ...f.options, dataDir:path.join(f.second.dir,'nested-output'), browser:{ open:async () => { opened = true; } } }), /must not overlap/);
  assert.equal(opened, false);
  await writeFile(path.join(f.first.dir, 'changed.txt'), 'changed historical detail run');
  await assert.rejects(f.audit(), /approval or claim is inconsistent|exact detail recovery/);
});

test('prior failed run cannot be supplied without detail recovery lineage', async t => {
  const f = await recoveryFixture(t);
  await assert.rejects(verifyProductOnlyContinuationEvidence({ ...f.options, reconciledRunDir:undefined }), /requires reconciledRunDir/);
});

async function browserRecoveryFixture(t, { delayedTabs = false } = {}) {
  const browser = await chromium.launch({ headless:true, args:['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1','--disable-background-networking'] });
  let active;
  t.after(async () => { await active?.close(); await browser.close(); });
  const context = await browser.newContext({ serviceWorkers:'block' });
  const fixture = await installProductOnlyFixture(context, { product });
  if (delayedTabs) await context.addInitScript(() => document.addEventListener('DOMContentLoaded', () => {
    // Match the live detail pane: its include table exists without a detail_post form ID.
    document.querySelector('#detail_post')?.removeAttribute('id');
    const selectors = { base:'#homepage_post', detail:'#include', productreference:'#reference_form' };
    for (const [tab, selector] of Object.entries(selectors)) {
      const link = document.querySelector(`a[href="#${tab}"]`), originalClick = link.onclick;
      link.onclick = event => {
        event.preventDefault();
        for (const value of Object.values(selectors)) document.querySelector(value).hidden = true;
        setTimeout(() => { originalClick.call(link, event); document.querySelector(selector).hidden = false; }, 75);
      };
    }
  }));
  const page = await context.newPage(); await page.goto(pageUrl);
  const basic = await createProductLowLevelAdapters({ identity:async () => identity }).basic.read(page);
  const f = await recoveryFixture(t, { ...basic, productId:Number(fixture.productId) });
  const session = new ScheduleSessionBrowser({ dataDir:path.join(f.root, 'owned-browser'), launcher:{ launchPersistentContext:async () => context } });
  assert.equal(await session.ensurePage(), page);
  fixture.state.content.detail = structuredClone(f.detail);
  active = await startProductOnlyContinuation({ ...f.options, dataDir:path.join(f.root,'retry'), identityReader:async () => identity,
    browser:{ open:async () => ({ page, close:async () => {} }) }, controls:contentControls,
    verifyUploadedImage:async ({ receipt, source }) => ({ tenantId:tenant.companyId, src:receipt.src, sha256:source.sha256 }) });
  return { ...f, active, fixture, browser };
}
async function clickFixtureApproval(browser, url) {
  const reviewContext = await browser.newContext();
  try {
    const review = await reviewContext.newPage(); await review.goto(url);
    await review.locator('input[name="company"]').fill(String(product.company.tenant));
    await review.locator('input[name="account"]').fill(identity.accountName);
    await review.locator('button[type="submit"]').click({ timeout:60000 });
  } finally { await reviewContext.close(); }
}

test('fresh fixture approval continues only remaining stages and consumes the fixed retry slot once', { timeout:90000 }, async t => {
  const f = await browserRecoveryFixture(t, { delayedTabs:true });
  assert.deepEqual(f.fixture.writes, [], 'preflight and review forward no writes');
  await assert.rejects(f.active.execute(), /human review form approval is required/);
  const pinned = await f.audit();
  await clickFixtureApproval(f.browser, f.active.url);
  const outcome = await f.active.completed;
  const events = (await readFile(path.join(f.root, 'retry/continuation.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(outcome.status, 'continued', JSON.stringify({ events:events.filter(row => ['adapter-evidence','needs-reconciliation'].includes(row.kind)), writes:f.fixture.writes }));
  assert.deepEqual(f.fixture.writes.map(write => write.kind), ['upload','reference','display','schedule-shell','schedule-day','schedule-day','season']);
  assert.deepEqual(events.find(row => row.kind === 'prior-failure-verified').priorFailure, pinned.priorFailure);
  const expectedScope = digest({ kind:'product-only-continuation-review-v1', target:{ productId:812345, masterCode:'CJU-SYNTHETIC' }, manifest:pinned.manifest,
    recovery:{ directory:pinned.recovery.dir, manifest:pinned.recovery.manifest, detail:pinned.recovery.detail }, priorFailure:pinned.priorFailure, phases:['media','shell','day','season','finalCheck'] });
  assert.equal(events.find(row => row.kind === 'human-approval').approval.scopeDigest, expectedScope);
  assert.equal(events.find(row => row.kind === 'approval-claim').reservation, pinned.reservationPath);
  assert.equal(events.at(-1).kind, 'completed');
  await assert.rejects(f.audit(), /consumed continuation reservation/);
});

test('historical evidence changing after the fresh review prevents claiming or forwarding a write', { timeout:60000 }, async t => {
  const f = await browserRecoveryFixture(t);
  await writeFile(path.join(f.second.dir, 'changed-after-review.txt'), 'must invalidate pinned review');
  await clickFixtureApproval(f.browser, f.active.url);
  assert.equal((await f.active.completed).status, 'needs-reconciliation');
  assert.deepEqual(f.fixture.writes, []);
  const evidence = await readFile(path.join(f.root, 'retry/continuation.jsonl'), 'utf8');
  assert.doesNotMatch(evidence, /"kind":"approval-claim"|"kind":"write-authorized"/);
});

async function approvedResumeFixture(t, { expired = false, preserveOpenedContext = false, referenceExistingPicker = false } = {}) {
  const engine = await chromium.launch({ headless:true, args:['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1','--disable-background-networking'] });
  let active;
  t.after(async () => { await active?.close(); await engine.close(); });
  const oldContext = await engine.newContext({ serviceWorkers:'block' });
  const oldFixture = await installProductOnlyFixture(oldContext, { product });
  const failedPage = await oldContext.newPage(); await failedPage.goto(pageUrl);
  const basic = await createProductLowLevelAdapters({ identity:async () => identity }).basic.read(failedPage);
  const f = await recoveryFixture(t, { ...basic, productId:Number(oldFixture.productId) });
  const oldSession = new ScheduleSessionBrowser({ dataDir:path.join(f.root, 'failed-browser'), launcher:{ launchPersistentContext:async () => oldContext } });
  await oldSession.ensurePage();
  await oldContext.route('**/*', route => ['GET','HEAD'].includes(route.request().method()) ? route.fallback() : route.abort());
  const third = await f.third(expired ? { start:Date.now() - 1200000 } : {}), originalDeadline = third.events.find(row => row.kind === 'human-approval').approval.expiresAt;
  let opened = 0, freshFixture, freshPage, observed = structuredClone(f.renewed.identity), time = Date.now(), expireAfterUpload = false;
  const browser = { open:async () => {
    opened += 1;
    const context = await engine.newContext({ serviceWorkers:'block' });
    freshFixture = await installProductOnlyFixture(context, { product });
    freshFixture.state.content.detail = structuredClone(f.detail);
    await context.addInitScript(({ companyId, referenceExistingPicker, receipt }) => document.addEventListener('DOMContentLoaded', () => {
      document.querySelectorAll('input[type="password"]').forEach(node => node.remove());
      const logo = document.createElement('img'); logo.src = `https://media.eoding.com/media/travelagent/${companyId}/logo/fixture.png`; document.body.append(logo);
      if (referenceExistingPicker) {
        const add = document.querySelector('#add_reference_element'), original = add.onclick;
        add.onclick = event => {
          original.call(add,event); const control = document.querySelector('#reference_body .control:last-child');
          if (control?.dataset.type !== '4') return;
          const button=document.createElement('button'); button.type='button';button.className='add_reference_image';button.textContent='Choose existing';control.append(button);
          button.onclick=()=>{
            document.querySelector('#image_popup').click();const modal=document.querySelector('#content-modal');
            modal.querySelector('#import-image-btn').onclick=()=>{
              const picture=modal.querySelector('.import-image');if(!picture||picture.dataset.id!==receipt.id||picture.src!==receipt.src)throw Error('fixture picker selection mismatch');
              const row=document.createElement('div');row.className='tr_image_list';row.dataset.id=receipt.id;row.append(picture.cloneNode());control.append(row);modal.hidden=true;
            };
          };
        };
      }
    }), { companyId:tenant.companyId, referenceExistingPicker, receipt:existingImage });
    const session = new ScheduleSessionBrowser({ dataDir:path.join(f.root, `resumed-browser-${opened}`), launcher:{ launchPersistentContext:async () => context } });
    freshPage = await session.ensurePage();
    return { page:freshPage, close:preserveOpenedContext ? async () => {} : () => session.close() };
  } };
  const options = { ...f.options, failedRunDir:third.dir, failedPage, dataDir:path.join(f.root,'resumed'), browser, identityReader:async () => observed, clock:() => time, controls:contentControls,
    verifyUploadedImage:async ({ receipt, source }) => { if (expireAfterUpload) time = originalDeadline; return { tenantId:tenant.companyId, src:receipt.src, sha256:source.sha256 }; } };
  return { ...f, third, originalDeadline, options, engine, failedPage,
    get freshFixture() { return freshFixture; }, get freshPage() { return freshPage; }, get opened() { return opened; },
    setTime(value) { time = value; }, setIdentity(value) { observed = value; }, expireAfterUpload() { expireAfterUpload = true; },
    rewriteThird:async () => writeFile(path.join(third.dir, 'continuation.jsonl'), journalText(third.events)),
    async partialStart(overrides = {}) { active = await resumeVerifiedUploadProductOnlyContinuation({ ...options, ...overrides }); return active; },
    async start(overrides = {}) { active = await resumeUnforwardedProductOnlyContinuation({ ...options, ...overrides }); return active; }
  };
}

test('unexpired consumed approval resumes through the common runner once without manufacturing another human approval', { timeout:90000 }, async t => {
  const f = await approvedResumeFixture(t), before = await manifestFor(f.third.dir), reserved = await readFile(f.third.reservation);
  const active = await f.start();
  assert.equal(active.url, null);
  assert.equal(f.failedPage.isClosed(), true, 'the failed context is retired instead of removing anonymous guards');
  assert.equal((await active.completed).status, 'continued');
  assert.deepEqual(f.freshFixture.writes.map(row => row.kind), ['upload','reference','display','schedule-shell','schedule-day','schedule-day','season']);
  const events = (await readFile(path.join(f.root,'resumed/continuation.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(row => row.kind === 'approval-carried-forward').length, 1);
  assert.equal(events.filter(row => row.kind === 'human-approval' || row.kind === 'approval-claim').length, 0);
  const carried = events.find(row => row.kind === 'approval-carried-forward');
  assert.deepEqual(carried.originalApproval, f.third.events.find(row => row.kind === 'human-approval').approval);
  assert.deepEqual(carried.originalClaim, f.third.events.find(row => row.kind === 'approval-claim').claim);
  for (const row of events.filter(row => row.kind === 'write-authorized')) assert.equal(row.event.continuation.executionDeadline, f.originalDeadline);
  assert.deepEqual(await manifestFor(f.third.dir), before);
  assert.deepEqual(await readFile(f.third.reservation), reserved);
  await assert.rejects(f.start({ dataDir:path.join(f.root,'duplicate') }), /already has a zero-write resumption/);
});

test('an expired consumed approval is rejected before closing its browser or reserving another execution', { timeout:30000 }, async t => {
  const f = await approvedResumeFixture(t, { expired:true }); f.setTime(0);
  await assert.rejects(f.start(), /original human approval expired/);
  assert.equal(f.failedPage.isClosed(), false);
  assert.equal(f.opened, 0);
  await assert.rejects(readdir(path.join(path.dirname(f.third.reservation), '.zero-write-resumptions')), { code:'ENOENT' });
});

for (const change of ['authorization','attempt','forwarded','upload','unknown-outcome']) {
  test(`carried approval refuses ${change} evidence before touching the browser`, { timeout:30000 }, async t => {
    const f = await approvedResumeFixture(t), rows = f.third.events;
    if (change === 'authorization') rows.splice(10,0,{ kind:'write-authorized', at:rows[10].at, event:{key:'upload'} });
    if (change === 'attempt') rows.splice(10,0,{ kind:'adapter-evidence', at:rows[10].at, event:{phase:'attempt',key:'upload'} });
    if (change === 'forwarded') rows.find(row => row.event?.phase === 'result').event.forwarded = 1;
    if (change === 'upload') rows.find(row => row.event?.phase === 'result').event.uploads = [{id:'90'}];
    if (change === 'unknown-outcome') rows.find(row => row.kind === 'needs-reconciliation').diagnostic = 'UNKNOWN_SAVE_OUTCOME';
    await f.rewriteThird();
    await assert.rejects(f.start(), /ambiguous events|not provably unforwarded|unknown save outcome/);
    assert.equal(f.failedPage.isClosed(), false); assert.equal(f.opened,0);
  });
}

test('carried approval rejects a changed session and leaves all original evidence intact', { timeout:30000 }, async t => {
  const f = await approvedResumeFixture(t), before = await manifestFor(f.third.dir);
  f.setIdentity({ ...f.renewed.identity, sessionKey:'different-session' });
  await assert.rejects(f.start(), /session drifted/);
  assert.deepEqual(f.freshFixture.writes, []);
  assert.deepEqual(await manifestFor(f.third.dir), before);
});

test('carried approval keeps its original deadline even after an upload succeeds', { timeout:60000 }, async t => {
  const f = await approvedResumeFixture(t); f.expireAfterUpload();
  const active = await f.start(); assert.equal((await active.completed).status,'needs-reconciliation');
  assert.deepEqual(f.freshFixture.writes.map(row => row.kind), ['upload']);
  await assert.rejects(f.start({ dataDir:path.join(f.root,'after-expiry') }), /zero-write resumption|expired/);
});

test('expired approval can only be renewed by a fresh human form for the same account and new session', { timeout:90000 }, async t => {
  const f = await approvedResumeFixture(t, { expired:true }), before = await manifestFor(f.third.dir);
  f.setIdentity({ ...f.renewed.identity, sessionKey:'fresh-human-reviewed-session' });
  const active = await f.start({ renewApproval:true, clock:Date.now });
  assert.match(active.url, /^http:\/\/127\.0\.0\.1:/);
  assert.deepEqual(f.freshFixture.writes, []);
  await assert.rejects(active.execute(), /fresh localhost human review form approval is required/);
  let html = await (await fetch(active.url)).text(); assert.match(html, /<form method="post"/);
  await clickFixtureApproval(f.engine, active.url);
  assert.equal((await active.completed).status,'continued');
  const events = (await readFile(path.join(f.root,'resumed/continuation.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(row => row.kind === 'human-approval').length,1);
  assert.ok(events.find(row => row.kind === 'human-approval').approval.approvedAt > f.originalDeadline);
  assert.equal(events.filter(row => row.kind === 'approval-carried-forward').length,0);
  assert.deepEqual(await manifestFor(f.third.dir),before);
  html = await (await fetch(active.url)).text(); assert.doesNotMatch(html, /<form method="post"/); assert.match(html,/등록이 완료/);
});

test('changing the failed approval evidence after review prevents a claim and removes the approval form', { timeout:30000 }, async t => {
  const f = await approvedResumeFixture(t, { expired:true });
  const active = await f.start({ renewApproval:true, clock:Date.now });
  await writeFile(path.join(f.third.dir, 'changed-after-review.txt'), 'invalidate pinned source');
  await clickFixtureApproval(f.engine, active.url);
  assert.equal((await active.completed).status, 'needs-reconciliation');
  assert.deepEqual(f.freshFixture.writes, []);
  const journal = await readFile(path.join(f.root, 'resumed/continuation.jsonl'), 'utf8');
  assert.doesNotMatch(journal, /"kind":"approval-claim"|"kind":"write-authorized"/);
  const html = await (await fetch(active.url)).text();
  assert.doesNotMatch(html, /<form method="post"/); assert.match(html, /처리가 중단됐습니다/);
  await assert.rejects(readdir(path.join(path.dirname(f.third.reservation), '.zero-write-resumptions')), { code:'ENOENT' });
});

test('renewed approval still rejects a different stable account before producing its form', { timeout:30000 }, async t => {
  const f = await approvedResumeFixture(t); f.setIdentity({ ...f.renewed.identity, accountName:'Another Operator' });
  await assert.rejects(f.start({ renewApproval:true, clock:Date.now }), /stable identity/);
  assert.deepEqual(f.freshFixture.writes,[]);
});

test('cancelled unapproved review closes only its owned guard and a deny bridge protects same-session successor review', { timeout:90000 }, async t => {
  const f = await approvedResumeFixture(t, { expired:true, preserveOpenedContext:true });
  const original = await manifestFor(f.third.dir), active = await f.start({ renewApproval:true, clock:Date.now, ttlMs:50 });
  assert.equal((await active.completed).status, 'cancelled');
  const previous = (await readFile(path.join(f.root, 'resumed/continuation.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(previous.filter(row => row.kind === 'approval-cancelled').length, 1);
  assert.equal(previous.filter(row => ['human-approval','approval-claim','write-authorized'].includes(row.kind)).length, 0);
  await assert.rejects(readdir(path.join(path.dirname(f.third.reservation), '.zero-write-resumptions')), { code:'ENOENT' });
  const page = f.freshPage, owner = page.context(), bridge = route => ['GET','HEAD'].includes(route.request().method()) ? route.fallback() : route.abort();
  await owner.route('**/*', bridge);
  await active.close();
  assert.equal(page.isClosed(), false);
  const closedHistory = await readFile(path.join(f.root, 'resumed/continuation.jsonl'), 'utf8');
  assert.equal(JSON.parse(closedHistory.trim().split('\n').at(-1)).kind, 'continuation-closed');
  const successor = await f.start({ renewApproval:true, clock:Date.now, dataDir:path.join(f.root,'successor'), browser:{open:async () => ({page,close:async () => {}})} });
  assert.equal(f.opened, 1, 'the existing logged-in context is reused');
  assert.deepEqual(f.freshFixture.writes, []);
  await owner.unroute('**/*', bridge);
  await clickFixtureApproval(f.engine, successor.url);
  assert.equal((await successor.completed).status, 'continued');
  assert.deepEqual(f.freshFixture.writes.map(row => row.kind), ['upload','reference','display','schedule-shell','schedule-day','schedule-day','season']);
  assert.equal(await readFile(path.join(f.root,'resumed/continuation.jsonl'),'utf8'), closedHistory);
  assert.deepEqual(await manifestFor(f.third.dir), original);
});

test('failed same-session successor leaves the caller-owned deny bridge installed', { timeout:30000 }, async t => {
  const f = await approvedResumeFixture(t, { expired:true, preserveOpenedContext:true });
  const active = await f.start({ renewApproval:true, clock:Date.now, ttlMs:50 });
  assert.equal((await active.completed).status, 'cancelled');
  const page = f.freshPage, owner = page.context(); let blocked = 0;
  const bridge = route => { if (['GET','HEAD'].includes(route.request().method())) return route.fallback(); blocked += 1; return route.abort(); };
  await owner.route('**/*', bridge); await active.close();
  f.setIdentity({ ...f.renewed.identity, accountName:'Another Operator' });
  await assert.rejects(f.start({ renewApproval:true, clock:Date.now, dataDir:path.join(f.root,'failed-successor'), browser:{open:async () => ({page,close:async () => {}})} }), /stable identity/);
  assert.equal(page.isClosed(), false);
  const beforeProbe = blocked;
  const requestBlocked = await page.evaluate(async () => { try { await fetch(location.href, {method:'POST',body:'test-only-probe'}); return false; } catch { return true; } });
  assert.equal(requestBlocked, true); assert.equal(blocked, beforeProbe + 1);
  assert.deepEqual(f.freshFixture.writes, []);
  await assert.rejects(readdir(path.join(path.dirname(f.third.reservation), '.zero-write-resumptions')), { code:'ENOENT' });
});

async function partialUploadFixture(t, {expired=false}={}) {
  const f = await approvedResumeFixture(t,{expired,referenceExistingPicker:true});
  const priorRows = f.third.events, priorApproval = priorRows.find(row=>row.kind==='human-approval').approval, priorClaim = priorRows.find(row=>row.kind==='approval-claim').claim;
  const predecessor = {dir:f.third.dir,manifest:await manifestFor(f.third.dir),reservation:{path:f.third.reservation,sha256:sha256(await readFile(f.third.reservation))},approval:priorApproval,claim:priorClaim,plan:f.renewed};
  const manifest = priorRows[0].manifest, recovery = priorRows.find(row=>row.kind==='detail-recovery-verified').recovery, priorFailure = priorRows.find(row=>row.kind==='prior-failure-verified').priorFailure;
  const target = priorRows.find(row=>row.kind==='original-evidence-verified').target, source = f.renewed.source.images[0];
  const nativeTarget = {origin:'https://basecamp.team',productId:String(target.productId),masterCode:target.masterCode,pageUrl,controls:contentControls,endpoints:{display:`https://basecamp.team/tour/master_product/homepage/${target.productId}/`,detail:`https://basecamp.team/tour/master_product_detail/${target.productId}/change/`,reference:`https://basecamp.team/tour/master_product_reference/${target.productId}/change/`,upload:'https://basecamp.team/contents/image/create_modal/?managed_flag=false'}};
  const scopeDigest = digest({kind:'product-only-continuation-review-v1',target,manifest,recovery:{directory:recovery.dir,manifest:recovery.manifest,detail:recovery.detail},priorFailure,unforwardedFailure:predecessor,phases:['media','shell','day','season','finalCheck'],renewalBinding:f.renewed.approvalBinding});
  const dir = path.join(f.root,'partial-upload'); await mkdir(dir);
  const reservation = path.join(path.dirname(f.third.reservation),'.zero-write-resumptions',`${digest({reservation:f.third.reservation,claim:priorClaim.id,scopeDigest:priorClaim.scopeDigest})}.json`);
  let at = Date.now() - (expired ? 1100000 : 1000); const start = at, events=[];
  const add=(kind,value={})=>{const row={kind,at,...value};events.push(row);at+=10;return row;};
  add('continuation-start',{manifest}); add('original-evidence-verified',{target}); add('session-renewal-review',{plan:f.renewed});
  add('preflight-verified',{target:pageUrl,schedules:0,seasons:0,forwardedWrites:0}); add('detail-recovery-verified',{recovery}); add('prior-failure-verified',{priorFailure});
  add('unforwarded-failure-verified',{source:predecessor,mode:'fresh-human-review'});
  const approval={...priorApproval,scopeDigest,approvedAt:at-1,expiresAt:start+900000}; add('human-approval',{approval});
  const claim={...priorClaim,scopeDigest,claimedAt:at-2}, claimRow=add('approval-claim',{claim,reservation});
  add('before-write',{phase:'media',targets:{mode:'NEW',...target}}); add('adapter-evidence',{event:{phase:'detail-reconciled',target:nativeTarget,payload:f.detail}});
  const key=`upload:${source.sha256}`,url=nativeTarget.endpoints.upload;
  add('write-authorized',{event:{key,target:nativeTarget,url,payload:{alt:source.alt,'pc-image':{name:source.name,mimeType:source.mimeType,size:png.length,sha256:source.sha256}},continuation:{target:{mode:'NEW',...target},planDigest:f.renewed.approvalBinding.planDigest,originalPlanDigest:f.value.approvalBinding.planDigest,authentication:f.renewed.continuation.authentication,runtimeDigest:sha256(JSON.stringify(manifest.runtime)),imageDigest:sha256(JSON.stringify(manifest.plan)),executionDeadline:approval.expiresAt}}});
  add('adapter-evidence',{event:{phase:'attempt',key,target:nativeTarget,url}});
  add('adapter-evidence',{event:{phase:'upload-receipt',target:nativeTarget,source:{name:source.name,sha256:source.sha256},receipt:existingImage}});
  add('adapter-evidence',{event:{phase:'result',status:'needs-reconciliation',target:nativeTarget,completed:[key],uploads:[],forwarded:1,message:'CDN image MIME differs from the approved source'}});
  add('needs-reconciliation',{diagnostic:'CONTINUATION_FAILED'}); add('needs-reconciliation',{result:{status:'needs-reconciliation'}}); add('continuation-closed',{status:'closed'});
  await mkdir(path.dirname(reservation),{recursive:true});
  await writeFile(reservation,json({kind:'product-only-zero-write-resumption',originalJournal:f.original.journalDir,consumedReservation:predecessor.reservation,failedRun:predecessor.dir,approval:predecessor.approval,claim:predecessor.claim,dataDir:dir,at:claimRow.at-1}));
  await Promise.all([writeFile(path.join(dir,'original-manifest.json'),json(manifest)),writeFile(path.join(dir,'continuation-plan.json'),json(f.renewed)),writeFile(path.join(dir,'continuation.jsonl'),journalText(events))]);
  let verifications=0;
  const options={failedRunDir:dir,unforwardedRunDir:f.third.dir,dataDir:path.join(f.root,'partial-resumed'),verifyUploadedImage:async ({receipt,source})=>{verifications++;assert.equal(source.mimeType,'image/png');return {tenantId:tenant.companyId,src:receipt.src,sha256:source.sha256,bytes:png.length};}};
  return {...f,get freshFixture(){return f.freshFixture;},get freshPage(){return f.freshPage;},get opened(){return f.opened;},partial:{dir,events,reservation,approval},get verifications(){return verifications;},rewritePartial:()=>writeFile(path.join(dir,'continuation.jsonl'),journalText(events)),startPartial:overrides=>f.partialStart({...options,...overrides})};
}

for (const mutation of ['second-authorization','forwarded','receipt-source','receipt-tenant','deadline','unknown-outcome']) test(`partial upload resumption rejects ${mutation} before browser or image verification`, {timeout:30000}, async t=>{
  const f=await partialUploadFixture(t), rows=f.partial.events;
  if(mutation==='second-authorization')rows.splice(12,0,{...structuredClone(rows[11]),at:rows[12].at});
  if(mutation==='forwarded')rows.find(row=>row.event?.phase==='result').event.forwarded=2;
  if(mutation==='receipt-source')rows.find(row=>row.event?.phase==='upload-receipt').event.source.sha256='a'.repeat(64);
  if(mutation==='receipt-tenant')rows.find(row=>row.event?.phase==='upload-receipt').event.receipt={id:'90',src:'https://media.eoding.com/media/travelagent/8/imagecontent/90.png'};
  if(mutation==='deadline')rows.find(row=>row.kind==='write-authorized').event.continuation.executionDeadline+=1;
  if(mutation==='unknown-outcome')rows.find(row=>row.kind==='needs-reconciliation').diagnostic='UNKNOWN_SAVE_OUTCOME';
  await f.rewritePartial(); await assert.rejects(f.startPartial(), /ambiguous|partial|tenant/i); assert.equal(f.opened,0); assert.equal(f.verifications,0);
});

test('partial upload expired approval cannot be revived by a backdated clock', {timeout:30000}, async t=>{
 const f=await partialUploadFixture(t,{expired:true});
 await assert.rejects(f.startPartial({clock:()=>0}),/approval expired/); assert.equal(f.opened,0); assert.equal(f.failedPage.isClosed(),false);
});

test('partial upload cannot resume until independent CDN bytes match', {timeout:30000}, async t=>{
 const f=await partialUploadFixture(t);
 await assert.rejects(f.startPartial({verifyUploadedImage:async ({receipt})=>({tenantId:tenant.companyId,src:receipt.src,sha256:'a'.repeat(64),bytes:png.length})}),/CDN evidence differs/);
 assert.equal(f.opened,0); assert.equal(f.failedPage.isClosed(),false);
});

test('expired partial upload opens only a fresh human review after CDN and empty-product preflight', {timeout:30000}, async t=>{
 const f=await partialUploadFixture(t,{expired:true}), before=await manifestFor(f.partial.dir), reserved=await readFile(f.partial.reservation);
 f.setIdentity({...f.renewed.identity,sessionKey:'new-partial-session'});
 const active=await f.startPartial({renewApproval:true,clock:Date.now});
 assert.match(active.url,/^http:\/\/127\.0\.0\.1:/); assert.equal(f.verifications,2); assert.deepEqual(f.freshFixture.writes,[]);
 await assert.rejects(active.execute(),/human review/);
 assert.deepEqual(await manifestFor(f.partial.dir),before); assert.deepEqual(await readFile(f.partial.reservation),reserved);
 await assert.rejects(readdir(path.join(path.dirname(f.partial.reservation),'.verified-upload-resumptions')),{code:'ENOENT'});
});

test('partial upload carried approval rejects a new session before any write', {timeout:30000}, async t=>{
 const f=await partialUploadFixture(t); f.setIdentity({...f.renewed.identity,sessionKey:'changed-partial-session'});
 await assert.rejects(f.startPartial(),/session drifted/); assert.deepEqual(f.freshFixture.writes,[]);
 await assert.rejects(readdir(path.join(path.dirname(f.partial.reservation),'.verified-upload-resumptions')),{code:'ENOENT'});
});

test('partial upload evidence changed after review prevents claim and further uploads', {timeout:30000}, async t=>{
 const f=await partialUploadFixture(t,{expired:true}), active=await f.startPartial({renewApproval:true,clock:Date.now});
 await writeFile(path.join(f.partial.dir,'late-note.txt'),'changed frozen partial-upload evidence');
 await clickFixtureApproval(f.engine,active.url); assert.equal((await active.completed).status,'needs-reconciliation');
 assert.deepEqual(f.freshFixture.writes,[]);
 await assert.rejects(readdir(path.join(path.dirname(f.partial.reservation),'.verified-upload-resumptions')),{code:'ENOENT'});
});

test('partial upload carry reuses its exact receipt with zero duplicate uploads through independent final read', {timeout:90000}, async t=>{
 const f=await partialUploadFixture(t), before=await manifestFor(f.partial.dir), original=await manifestFor(f.third.dir), reserved=await readFile(f.partial.reservation);
 const active=await f.startPartial(); assert.equal(active.url,null);
 assert.equal((await active.completed).status,'continued');
 assert.deepEqual(f.freshFixture.writes.map(row=>row.kind),['reference','display','schedule-shell','schedule-day','schedule-day','season']);
 const events=(await readFile(path.join(f.root,'partial-resumed/continuation.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(events.filter(row=>row.kind==='approval-carried-forward').length,1);
 assert.equal(events.filter(row=>row.kind==='human-approval').length,0);
 assert.deepEqual(events.find(row=>row.kind==='approval-carried-forward').originalApproval,f.partial.approval);
 assert.equal(events.filter(row=>row.event?.phase==='upload-reconciled').length,1);
 for(const row of events.filter(row=>row.kind==='write-authorized'))assert.equal(row.event.continuation.executionDeadline,f.partial.approval.expiresAt);
 assert.deepEqual(await manifestFor(f.partial.dir),before); assert.deepEqual(await manifestFor(f.third.dir),original); assert.deepEqual(await readFile(f.partial.reservation),reserved);
 await assert.rejects(f.startPartial({dataDir:path.join(f.root,'duplicate-partial')}),/already has a partial resumption/);
});

test('partial upload renewed human approval still preserves the receipt and never uploads it again', {timeout:90000}, async t=>{
 const f=await partialUploadFixture(t,{expired:true}), before=await manifestFor(f.partial.dir);
 f.setIdentity({...f.renewed.identity,sessionKey:'freshly-reviewed-partial'});
 const active=await f.startPartial({renewApproval:true,clock:Date.now}); assert.deepEqual(f.freshFixture.writes,[]);
 await clickFixtureApproval(f.engine,active.url); assert.equal((await active.completed).status,'continued');
 assert.deepEqual(f.freshFixture.writes.map(row=>row.kind),['reference','display','schedule-shell','schedule-day','schedule-day','season']);
 assert.deepEqual(await manifestFor(f.partial.dir),before);
 const events=(await readFile(path.join(f.root,'partial-resumed/continuation.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(events.filter(row=>row.kind==='human-approval').length,1); assert.equal(events.filter(row=>row.kind==='approval-carried-forward').length,0);
});
