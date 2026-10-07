import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { ALLOWED_ORIGIN } from './browser.mjs';
import { digest } from './core.mjs';
import { createProductOnlyAdapters } from './product-only-adapters.mjs';
import { createProductOnlyApprovalBinding } from './product-only-execution.mjs';
import { ExistingProfileBrowser, validateProductOnlyLaunchPlan, loadApprovedProductOnlyImage, verifyApprovedProductOnlyCdnImage } from './product-only-launcher.mjs';
import { ProductOnlyReviewStore } from './product-only-review.mjs';
import { startProductReviewUI } from './product-review-ui.mjs';
import { verifyContinuationPreflight } from './product-only-continuation-preflight.mjs';

const clone = value => structuredClone(value);
const fail = message => { throw new Error(`Continuation blocked: ${message}`); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const id = value => /^[1-9]\d{0,9}$/.test(String(value));
const now = () => Date.now();
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[ch]);
// Keep an actionable local failure class without placing URLs, cookies, tokens, or
// arbitrary server text in the durable continuation evidence.
function safeFailure(error) { return error?.code === 'UNKNOWN_SAVE_OUTCOME' ? 'UNKNOWN_SAVE_OUTCOME' : 'CONTINUATION_FAILED'; }
function renewalNotice(plan) {
 const renewal = plan.continuation;
 if (renewal?.kind !== 'product-only-session-renewal-v1') return '';
 return `<p><strong>Renewed authentication</strong><br>Company ${esc(renewal.authentication.companyId)} / account ${esc(plan.identity.accountName)}<br>Observed session SHA-256: <code>${esc(plan.identity.sessionKey)}</code><br>Original plan SHA-256 (old authentication is lineage only): <code>${esc(renewal.original.approvalBinding.planDigest)}</code><br>New plan SHA-256: <code>${esc(plan.approvalBinding.planDigest)}</code></p>`;
}
function renderContinuationReview(target) { return (session, csrf, message = '') => { const plan = session.approvalContext.executionInput, selected = plan.product.departures?.[0]?.prices?.[plan.product.departures?.[0]?.selectedPrice] ?? {}; return `<!doctype html><html lang="ko"><meta charset="utf-8"><title>기존 상품 이어서 입력</title><body style="font:16px system-ui;max-width:760px;margin:32px auto"><h1>기존 상품 이어서 입력</h1><p><b>기존 상품 ID ${esc(target.productId)} / 코드 ${esc(target.masterCode)}</b></p>${renewalNotice(plan)}<p>기본정보는 보존하며 다시 저장하지 않습니다. 남은 범위: 미디어·상세·참조, ${esc(plan.itinerary.length)}일 일정, 시즌·항공편.</p><p>이벤트 생성, 호텔 배정, 판매 시작, 공개/발행은 실행하지 않습니다.</p><p>이미지 ${esc(plan.source.images.length)}장 · ${esc(plan.itinerary.length)}일 · 성인 ${esc(selected.adult?.amount ?? '')} / 아동 ${esc(selected.child?.amount ?? '')} / 유아 ${esc(selected.infant?.amount ?? '')}</p><p>항공: ${esc(plan.season.fields['depart-0-flight_no'])} / ${esc(plan.season.fields['arrive-0-flight_no'])}</p><form method="post" action="/approve"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="version" value="${esc(session.version)}"><input type="hidden" name="scope_hash" value="${esc(session.scopeDigest)}"><input type="hidden" name="scope" value="basic,display,content,shell,days,season"><label>ERP 회사/테넌트 <input name="company" required></label><br><label>ERP 계정명 <input name="account" required></label><br><button type="submit">사람이 확인하고 이어서 입력</button></form><p>${esc(message)}</p></body></html>`; }; }

async function regular(file, name) { const stat = await lstat(file); if (!stat.isFile() || stat.isSymbolicLink()) fail(`${name} must be a regular non-symlink file`); return stat; }
async function lines(file) { const text = await readFile(file, 'utf8'); if (!text.endsWith('\n') || !text.trim()) fail(`${path.basename(file)} is incomplete or truncated`); return text.trimEnd().split('\n').map((line, index) => { try { return JSON.parse(line); } catch { fail(`${path.basename(file)} line ${index + 1} is invalid JSON`); } }); }
async function tree(dir, prefix = '', { runtimeRoot = false } = {}) { const result = []; for (const name of await readdir(dir)) { const file = path.join(dir, name), stat = await lstat(file), relative = path.join(prefix, name).replace(/\\/g, '/'); if (stat.isSymbolicLink()) { if (!(runtimeRoot && name === 'node_modules')) fail('original evidence must not contain symlinks'); result.push({ name: relative, dependencyReference: 'shared-node-modules', canonicalTarget: await realpath(file) }); continue; } if (stat.isDirectory()) result.push(...await tree(file, relative)); else if (stat.isFile()) result.push({ name: relative, sha256: hash(await readFile(file)) }); else fail('original evidence contains a non-regular file'); } return result.sort((a,b) => a.name.localeCompare(b.name)); }
function eventValue(event) { return event?.value ?? event?.event ?? event; }
function verifiedBasic(events) { const found = events.filter(event => event.kind === 'coordinator-evidence' && event.value?.status === 'receipt-verified' && event.value?.phase === 'basic').map(event => event.value.result?.receipt); if (found.length !== 1 || !found[0] || !id(found[0].productId) || typeof found[0].masterCode !== 'string' || !found[0].masterCode) fail('original journal must contain exactly one verified basic receipt'); return clone(found[0]); }
function validateHistory(events, plan) {
 const approvals = events.filter(event => event.kind === 'human-approval'), claims = events.filter(event => event.kind === 'approval-claim'); if (approvals.length !== 1 || claims.length !== 1) fail('original journal must contain exactly one historical approval and claim');
 const approval = approvals[0].approval, claim = claims[0].claim;
 if (!approval || !claim || approval.status !== 'approved' || approval.planDigest !== plan.approvalBinding.planDigest || approval.scopeDigest !== plan.approvalBinding.scopeDigest || claim.planDigest !== approval.planDigest || claim.scopeDigest !== approval.scopeDigest || !same(claim.target, { mode: 'NEW' }) || !Number.isSafeInteger(approval.approvedAt) || !Number.isSafeInteger(approval.expiresAt) || !Number.isSafeInteger(claim.claimedAt) || claim.claimedAt < approval.approvedAt || claim.claimedAt >= approval.expiresAt) fail('historical approval/claim is inconsistent');
 const receipt = verifiedBasic(events), receiptIndex = events.findIndex(event => event.kind === 'coordinator-evidence' && event.value?.status === 'receipt-verified' && event.value?.phase === 'basic'), mediaBefore = events.findIndex(event => eventValue(event)?.phase === 'media' && eventValue(event)?.status === 'before-write');
 const failed = events.findIndex(event => event.kind === 'adapter-evidence' && event.event?.status === 'needs-reconciliation');
 if (events.indexOf(approvals[0]) >= events.indexOf(claims[0]) || receiptIndex < events.indexOf(claims[0]) || mediaBefore < receiptIndex || failed < mediaBefore || events.slice(mediaBefore).some(event => { const value = eventValue(event); return ['shell','day','season'].includes(value?.phase) || ['receipt-verified','adapter-result'].includes(value?.status) && ['media','shell','day','season'].includes(value?.phase); })) fail('original journal does not prove a clean media failure before later stages');
 if (events.some(event => event.kind === 'write-authorized' && event.event?.phase !== 'basic') || events.some(event => event.kind === 'adapter-evidence' && event.event?.phase === 'attempt' && event.event?.stage !== 'basic')) fail('original journal has an ambiguous write attempt after basic');
 const media = events[failed].event; if (media.forwarded !== 0 || !same(media.completed, []) || !same(media.uploads, [])) fail('original media attempt was not provably unforwarded');
 return { approval: clone(approval), claim: clone(claim), receipt };
}
async function pin({ planPath, journalDir, runtimeDir }) {
 const [planReal, journalReal, runtimeReal] = await Promise.all([realpath(planPath), realpath(journalDir), realpath(runtimeDir)]);
 await Promise.all([regular(planReal, 'planPath'), lstat(journalReal), lstat(runtimeReal)]);
 const [journal, execution, checkpoint] = await Promise.all(['journal.jsonl','execution.jsonl','checkpoint.json'].map(name => readFile(path.join(journalReal, name))));
 const parsedPlan = validateProductOnlyLaunchPlan(JSON.parse(await readFile(planReal, 'utf8'))), events = await lines(path.join(journalReal, 'journal.jsonl'));
 const history = validateHistory(events, parsedPlan);
 let checkpointValue; try { checkpointValue = JSON.parse(checkpoint); } catch { fail('original checkpoint is invalid JSON'); } if (checkpointValue?.events !== events.length || !same(checkpointValue?.last, events.at(-1))) fail('original checkpoint does not match journal tail');
 if (!execution.toString('utf8').endsWith('\n')) fail('original execution evidence is incomplete'); let executionRows; try { executionRows = execution.toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line)); } catch { fail('original execution evidence is invalid JSON'); } if (executionRows.length !== 1 || executionRows[0]?.value?.approvalBinding?.planDigest !== parsedPlan.approvalBinding.planDigest) fail('original execution evidence does not bind the plan');
 return { plan: parsedPlan, history, dirs: { planReal, journalReal, runtimeReal }, manifest: { plan: { path: planReal, sha256: hash(await readFile(planReal)) }, journal: await tree(journalReal), runtime: await tree(runtimeReal, '', { runtimeRoot:true }) } };
}
async function assertPinned(pinned) { const fresh = await pin({ planPath: pinned.dirs.planReal, journalDir: pinned.dirs.journalReal, runtimeDir: pinned.dirs.runtimeReal }); if (!same(fresh.manifest, pinned.manifest)) fail('original plan, journal, or runtime evidence changed'); for (const source of pinned.plan.source.images) await loadApprovedProductOnlyImage(source); return fresh; }
async function existingCanonical(value) { try { return await realpath(value); } catch { return path.resolve(value); } }
async function freshDirectory(value, pinned, browserDir) {
 const resolved = path.resolve(value), origins = [pinned.dirs.planReal, pinned.dirs.journalReal, pinned.dirs.runtimeReal, ...(browserDir ? [await existingCanonical(browserDir)] : [])];
 if (origins.some(origin => resolved === origin || resolved.startsWith(origin + path.sep) || origin.startsWith(resolved + path.sep))) fail('dataDir must not overlap original evidence or browser profile');
 await mkdir(resolved, { recursive: true, mode: 0o700 }); const real = await realpath(resolved), entries = await readdir(real);
 if (entries.length) fail('dataDir must be a fresh private directory');
 if (origins.some(origin => real === origin || real.startsWith(origin + path.sep) || origin.startsWith(real + path.sep))) fail('dataDir must not overlap original evidence or browser profile'); return real;
}
async function reserveOriginal(pinned, dataDir) { const registry = path.join(path.dirname(pinned.dirs.journalReal), '.continuation-reservations'); await mkdir(registry, { recursive:true, mode:0o700 }); const file = path.join(registry, `${pinned.plan.approvalBinding.planDigest}.json`); try { await writeJson(file, { kind:'product-only-continuation-reservation', originalJournal:pinned.dirs.journalReal, dataDir, at:now() }); } catch (error) { if (error?.code === 'EEXIST') fail('this original journal already has a consumed continuation reservation'); throw error; } return file; }
async function writeJson(file, value, flag = 'wx') { const handle = await open(file, flag, 0o600); try { await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync(); } finally { await handle.close(); } }
class Journal {
 constructor(dir, manifest) { this.dir = dir; this.file = path.join(dir, 'continuation.jsonl'); this.manifest = manifest; this.events = []; }
 async start() { await writeJson(path.join(this.dir, 'original-manifest.json'), this.manifest); await writeJson(this.file, { kind: 'continuation-start', at: now(), manifest: this.manifest }); }
 async add(kind, value) { const event = { kind, at: now(), ...clone(value) }; const h = await open(this.file, 'a', 0o600); try { await h.writeFile(JSON.stringify(event) + '\n'); await h.sync(); } finally { await h.close(); } this.events.push(event); return event; }
 async authorize(event) { await this.add('write-authorized', { event }); return { durable: true, status: 'approved', bindingDigest: event.bindingDigest ?? event.binding?.digest, approvalId: 'continuation-review' }; }
 async record(event) { const row = await this.add('adapter-evidence', { event }); return { durable: true, bindingDigest: event.bindingDigest ?? event.binding?.digest, evidenceId: String(row.at) }; }
}
function continuationPlan(plan, target) { const result = clone(plan); result.target = target; return result; }
function assertStableIdentity(observed, plan) {
 if (!observed || Object.keys(observed).sort().join(',') !== 'accountKey,accountName,sessionKey' || Object.values(observed).some(value => typeof value !== 'string' || !value.trim() || value !== value.trim()) || observed.accountName !== plan.identity.accountName || observed.accountKey !== plan.identity.accountKey) fail('observed ERP account differs from original stable identity');
}
async function assertCompany(page, plan) {
 const url = new URL(page.url()); if (url.origin !== ALLOWED_ORIGIN || await page.locator('input[type="password"]:visible').count()) fail('ERP login/origin is not the approved session');
 const companyIds = await page.locator('img').evaluateAll(nodes => [...new Set(nodes.map(node => /\/travelagent\/(\d+)\/erp_logo\//.exec(node.src)?.[1]).filter(Boolean))]);
 if (companyIds.length !== 1 || companyIds[0] !== String(plan.companyId)) fail('observed ERP company differs from original company');
}
function defaultIdentityReader(plan, renewSessionReview = false) {
 return async page => {
  const url = new URL(page.url()); if (url.origin !== ALLOWED_ORIGIN || await page.locator('input[type="password"]:visible').count()) fail('ERP login/origin is not the approved session');
  const accountName = (await page.locator('#eoding-name').innerText()).trim();
  const cookies = (await page.context().cookies(ALLOWED_ORIGIN)).filter(cookie => cookie.httpOnly).map(cookie => ({ name:cookie.name, value:cookie.value, domain:cookie.domain, path:cookie.path })).sort((a,b) => (a.name+a.domain+a.path).localeCompare(b.name+b.domain+b.path));
  await assertCompany(page, plan);
  const observed = { accountName, accountKey:digest({ origin:ALLOWED_ORIGIN, label:accountName, declaredTenant:String(plan.companyId) }), sessionKey:digest(cookies) };
  assertStableIdentity(observed, plan);
  if (!cookies.length || (!renewSessionReview && !same(observed, plan.identity))) fail('observed ERP account, company, or session differs from approved identity');
  return observed;
 };
}

/** Continue only an exactly evidenced, otherwise-empty NEW product through a fresh localhost human approval. */
export async function startProductOnlyContinuation({ planPath, journalDir, originalJournal, runtimeDir, originalRuntime, dataDir, browser, browserDir, preflightOnly = false, renewSessionReview = false, identityReader, controls, loadImage = loadApprovedProductOnlyImage, verifyUploadedImage, ttlMs = 15 * 60 * 1000, fetchImpl, clock = now } = {}) {
 if (originalJournal) journalDir = originalJournal; if (originalRuntime) runtimeDir = originalRuntime;
 if (typeof preflightOnly !== 'boolean' || typeof clock !== 'function') fail('preflightOnly must be boolean and clock must be a function'); if (!planPath || !journalDir || !runtimeDir || !dataDir) fail('planPath, original journal/runtime, and dataDir are required');
 if (typeof renewSessionReview !== 'boolean' || (renewSessionReview && preflightOnly)) fail('renewSessionReview must be an exclusive review mode');
 const pinned = await pin({ planPath, journalDir, runtimeDir }); const dir = await freshDirectory(dataDir, pinned, browserDir); let reservation = null; const journal = new Journal(dir, pinned.manifest); await journal.start(); await journal.add('original-evidence-verified', { target: { productId: pinned.history.receipt.productId, masterCode: pinned.history.receipt.masterCode } });
 if (!browser && browserDir) browser = new ExistingProfileBrowser({ browserDir: path.resolve(browserDir) });
 if (!browser || typeof browser.open !== 'function') fail('an owned ScheduleSessionBrowser-compatible browser is required');
 await assertPinned(pinned);
 let executionPlan = pinned.plan;
 const readIdentity = identityReader ?? defaultIdentityReader(pinned.plan, renewSessionReview);
 const identity = async page => {
  if (renewSessionReview) await assertCompany(page, pinned.plan);
  const observed = await readIdentity(page);
  if (!same(observed, executionPlan.identity)) fail('observed ERP account or session drifted from the reviewed identity');
  return observed;
 };
 const currentTime = () => { const value = clock(); if (!Number.isSafeInteger(value) || value < 0) fail('continuation clock is invalid'); return value; };
 let owned, closed = false, terminal = false, busy = false, writePermit = false, currentWrite = null, executionDeadline = 0, barrier;
 let resolveCompleted; const completed = new Promise(resolve => { resolveCompleted = resolve; }); let settled = false;
 const settle = value => { if (!settled) { settled = true; resolveCompleted(Object.freeze(clone(value))); } };
 const close = async () => { if (closed) return; closed = true; terminal = true; writePermit = false; await owned?.close(); };
 const open = async () => { if (!owned) { owned = await browser.open(); if (!owned?.page || typeof owned.close !== 'function') fail('browser.open must return page and close'); } return owned.page; };
 const page = await open(); const owner = page.context();
 // This guard is deliberately never removed.  Stage-local native guards run above
 // it; the coordinator opens this final gate only after a durable authorization.
 barrier = async route => {
  if (['GET','HEAD'].includes(route.request().method())) return route.fallback();
  if (closed || terminal || !writePermit || currentTime() >= executionDeadline) return route.abort();
  writePermit = false;
  try { await identity(page); if (closed || terminal || currentTime() >= executionDeadline) return route.abort(); }
  catch { terminal = true; return route.abort(); }
  return route.fallback();
 };
 const runPreflight = async () => {
  // The helper installs/removes its narrower probe guard above this permanent
  // outer route; expected probe POSTs are aborted without reaching ERP.
  return verifyContinuationPreflight({ page, plan: executionPlan, receipt: pinned.history.receipt, identity });
 };
 await owner.route('**/*', barrier);
 let proof; try {
  if (renewSessionReview) {
   const target = { productId:Number(pinned.history.receipt.productId), masterCode:pinned.history.receipt.masterCode };
   const url = `${ALLOWED_ORIGIN}/tour/master_product/${target.productId}/change/`;
   const response = await page.goto(url, { waitUntil:'domcontentloaded', timeout:15000 });
   if (!response || response.status() !== 200 || response.url() !== url || page.url() !== url || response.fromServiceWorker()) fail('renewal exact existing product GET failed');
   await assertCompany(page, pinned.plan);
   const observed = clone(await readIdentity(page)); assertStableIdentity(observed, pinned.plan);
   if (observed.sessionKey === pinned.plan.identity.sessionKey) fail('session renewal requires a changed observed session; use --review for the original session');
   executionPlan = clone(pinned.plan);
   executionPlan.identity = observed;
   executionPlan.continuation = {
    kind:'product-only-session-renewal-v1', authentication:{ status:'renewed', companyId:String(pinned.plan.companyId), identity:clone(observed) }, target,
    original:{ identity:clone(pinned.plan.identity), companyId:String(pinned.plan.companyId), approvalBinding:clone(pinned.plan.approvalBinding), paths:clone(pinned.dirs), manifest:clone(pinned.manifest), manifestDigest:digest(pinned.manifest), images:clone(pinned.plan.source.images) }
   };
   executionPlan.approvalBinding = createProductOnlyApprovalBinding(executionPlan);
   executionPlan = validateProductOnlyLaunchPlan(executionPlan);
  }
  proof = await runPreflight();
  await assertPinned(pinned);
  if (renewSessionReview) { await writeJson(path.join(dir, 'continuation-plan.json'), executionPlan); await journal.add('session-renewal-review', { plan:executionPlan }); }
 } catch (error) { await close(); throw error; } await journal.add('preflight-verified', proof);
 if (preflightOnly) { await close(); return Object.freeze({ status: 'preflight-complete', target: { productId: pinned.history.receipt.productId, masterCode: pinned.history.receipt.masterCode }, manifest: clone(pinned.manifest) }); }
 const store = new ProductOnlyReviewStore({ plan: executionPlan, sourceLabel: `existing:${pinned.history.receipt.productId}`, sourceDigest: pinned.plan.approvalBinding.planDigest,
  onApprove: approval => journal.add('human-approval', { approval }),
  onCancel: async approval => { terminal = true; writePermit = false; await journal.add('approval-cancelled', { approval }); settle({ status:'cancelled' }); },
  onClaim: async claim => { reservation = await reserveOriginal(pinned, dir); await journal.add('approval-claim', { claim, reservation }); },
  onReconcile: result => journal.add('needs-reconciliation', { result: { status:'needs-reconciliation', message:'Continuation failed; inspect durable journal.' } }),
  beforeClaim: async () => { if (closed || terminal) fail('continuation is closed'); await assertPinned(pinned); await runPreflight(); if (closed || terminal || currentTime() >= store.state.approval.expiresAt) fail('continuation closed or approval expired during preflight'); }, clock: currentTime
 });
 // The form binds the exact existing target and pinned original evidence; only the
 // internally returned scope is translated to the exact adapter-compatible plan.
 const adapterScopeDigest = executionPlan.approvalBinding.scopeDigest, reviewScopeDigest = digest({ kind:'product-only-continuation-review-v1', target:{ productId:pinned.history.receipt.productId, masterCode:pinned.history.receipt.masterCode }, manifest:pinned.manifest, phases:['media','shell','day','season','finalCheck'], ...(renewSessionReview ? { renewalBinding:executionPlan.approvalBinding } : {}) });
 store.state.scopeDigest = reviewScopeDigest;
 const claimForReview = store.claim.bind(store); store.claim = async request => { const claimed = await claimForReview({ ...request, scopeDigest:reviewScopeDigest }); return { ...claimed, scopeDigest:adapterScopeDigest }; };
 const run = async () => {
  if (busy || terminal) fail('continuation is already terminal or executing'); busy = true;
  try {
   const claim = await store.claim({ target: { mode: 'NEW' }, ...executionPlan.approvalBinding }); const targets = { mode: 'NEW', productId: Number(pinned.history.receipt.productId), masterCode: pinned.history.receipt.masterCode };
   const approvedDeadline = store.state.approval?.expiresAt;
   if (!Number.isSafeInteger(approvedDeadline) || !Number.isSafeInteger(claim.claimedAt) || claim.claimedAt >= approvedDeadline || currentTime() >= approvedDeadline) fail('claimed approval deadline is invalid or expired');
   executionDeadline = approvedDeadline;
   const authorizeWrite = async (event, context) => {
    const eventTarget = event?.target;
    if (closed || terminal || !busy || !currentWrite || currentTime() >= executionDeadline || store.state.execution?.status !== 'executing' || !same(context?.approvalClaim, claim) || !same(context?.targets, targets) || !eventTarget || (eventTarget.mode !== undefined && eventTarget.mode !== 'NEW') || Number(eventTarget.productId) !== targets.productId || eventTarget.masterCode !== targets.masterCode) fail('write authorization is no longer active');
    const allowed = currentWrite === 'media' ? ['detail','upload','reference','display','media'] : currentWrite === 'shell' ? ['shell'] : currentWrite === 'season' ? ['season'] : [currentWrite];
    const operation = event.phase ?? event.key;
    if (!(allowed.includes(operation) || (currentWrite === 'media' && typeof operation === 'string' && operation.startsWith('upload:')))) fail('write phase is outside the approved continuation scope');
    await assertPinned(pinned); await identity(page); if (closed || terminal || currentTime() >= executionDeadline) fail('write authorization expired');
    const authorization = await journal.authorize({ ...event, continuation: { target: clone(targets), planDigest:executionPlan.approvalBinding.planDigest, ...(renewSessionReview ? { originalPlanDigest:pinned.plan.approvalBinding.planDigest, authentication:clone(executionPlan.continuation.authentication) } : {}), runtimeDigest:hash(JSON.stringify(pinned.manifest.runtime)), imageDigest:hash(JSON.stringify(pinned.manifest.plan)), executionDeadline } });
    if (closed || terminal || currentTime() >= executionDeadline) fail('write authorization expired');
    writePermit = true; return authorization;
   };
   const adapters = createProductOnlyAdapters({ plan: executionPlan, identity, authorizeWrite, record: event => journal.record(event), loadImage, verifyUploadedImage: verifyUploadedImage ?? (value => verifyApprovedProductOnlyCdnImage({ ...value, companyId: pinned.plan.companyId, fetchImpl })), controls, seedBasicReceipt: pinned.history.receipt });
   const results = [{ name: 'basic', receipt: clone(pinned.history.receipt), verification: true }];
   for (const step of [{ name:'media', adapter:adapters.media }, { name:'shell', adapter:adapters.shell }, ...pinned.plan.itinerary.map(day => ({ name:`day:${day.day}`, adapter:adapters.day, day })), { name:'season', adapter:adapters.season }]) {
    writePermit = false; currentWrite = step.name.startsWith('day:') ? step.name : step.name; await assertPinned(pinned); const context = { phase: step.name, day: step.day ?? null, targets: clone(targets), verifiedPreviousPhases: clone(results), approvalClaim: claim, approvalBinding: executionPlan.approvalBinding };
    // Each native adapter owns a narrower capture/allowlist guard while active.
    // The context-wide deny barrier remains installed throughout receipt readback.
    writePermit = false;
    let receipt; try { await journal.add('before-write', { phase: step.name, targets }); receipt = await step.adapter.save(page, continuationPlan(executionPlan, targets), context); }
    finally { writePermit = false; }
    if (closed || terminal || currentTime() >= executionDeadline) fail('continuation closed or approval expired after native write attempt');
    const verification = await step.adapter.verifyReceipt(page, receipt, context); if (!verification || closed || terminal || currentTime() >= executionDeadline) fail(`${step.name} receipt verification failed or continuation is terminal`); results.push({ name: step.name, receipt: clone(receipt), verification: true }); if (step.name === 'shell') targets.scheduleId = Number(receipt.scheduleId); await journal.add('receipt-verified', { phase: step.name, receipt });
   }
   if (closed || terminal || currentTime() >= executionDeadline) fail('continuation closed or approval expired before final verification');
   await assertPinned(pinned); const context = { phase:'final-get', targets:clone(targets), verifiedPreviousPhases:clone(results), approvalClaim:claim, approvalBinding:executionPlan.approvalBinding }; const final = await adapters.finalCheck.get(page, continuationPlan(executionPlan, targets), context); if (!await adapters.finalCheck.verify(page, final, { plan: continuationPlan(executionPlan, targets), ...context }) || closed || terminal || currentTime() >= executionDeadline) fail('final independent check failed or continuation is terminal');
   const result = { status:'continued', targets, phases:results, finalCheck:{status:'verified',result:final} }; await journal.add('completed', { result }); if (closed || terminal || currentTime() >= executionDeadline) fail('continuation closed or approval expired before completion'); await store.completed(result); terminal = true; writePermit = false; return result;
  } catch (error) { terminal = true; writePermit = false; await journal.add('needs-reconciliation', { message:'Continuation failed; inspect durable journal.', diagnostic:safeFailure(error) }); await store.reconcile(new Error('Continuation failed; inspect durable journal.')).catch(() => {}); throw new Error('Continuation failed; inspect durable journal.'); } finally { busy = false; currentWrite = null; }
 };
 const approvedRun = async () => { try { const result = await run(); settle(result); return result; } catch (error) { settle({ status:'needs-reconciliation' }); throw error; } };
 let ui; try { ui = await startProductReviewUI({ store, sessionId: store.state.id, ttlMs, onApproved: approvedRun, renderPage: renderContinuationReview({ productId:pinned.history.receipt.productId, masterCode:pinned.history.receipt.masterCode }) }); } catch (error) { await close(); throw error; }
 let closingPromise;
 return Object.freeze({ url: ui.url, preflight: proof, completed, close: () => {
  if (!closingPromise) closingPromise = (async () => {
   terminal = true; writePermit = false;
   if (busy) {
    await journal.add('needs-reconciliation', { message:'Continuation closed during execution; inspect durable journal.' });
    settle({ status:'needs-reconciliation' });
   } else {
    await journal.add('continuation-closed', { status:'closed' });
    settle({ status:'closed' });
   }
   await close();
   // Stop listening immediately, without waiting for an adapter promise stranded
   // by the closed browser. The immutable terminal flag prevents future permits.
   void ui.close().catch(() => {});
  })();
  return closingPromise;
 }, execute: async () => fail('a fresh localhost human review form approval is required; execute() cannot bypass it') });
}
