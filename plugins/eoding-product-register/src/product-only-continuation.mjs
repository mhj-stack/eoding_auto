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
import { requireScheduleSession } from './schedule-session.mjs';
import { validateDisplayImages } from './display-image.mjs';

const clone = value => structuredClone(value);
const fail = message => { throw new Error(`Continuation blocked: ${message}`); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const id = value => /^[1-9]\d{0,9}$/.test(String(value));
const now = () => Date.now();
const approvedResumeCapability = Symbol('verified-unforwarded-continuation');
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[ch]);
// Keep an actionable local failure class without placing URLs, cookies, tokens, or
// arbitrary server text in the durable continuation evidence.
function safeFailure(error) { return error?.code === 'UNKNOWN_SAVE_OUTCOME' ? 'UNKNOWN_SAVE_OUTCOME' : 'CONTINUATION_FAILED'; }
function renewalNotice(plan) {
 const renewal = plan.continuation;
 if (renewal?.kind !== 'product-only-session-renewal-v1') return '';
 return `<p><strong>${esc(plan.product.title)}</strong><br>선택 출발일: ${esc(plan.season.selectedDates.join(', '))}<br>상품 상태: 비공개 유지</p><p>현재 로그인: 회사 ${esc(renewal.authentication.companyId)} / 계정 ${esc(plan.identity.accountName)}<br>아래에서 같은 회사와 계정을 확인하면 남은 항목을 이어서 저장합니다.</p>`;
}
function renderContinuationReview(target, failed = () => false) { return (session, csrf, message = '') => {
 const plan = session.approvalContext.executionInput, selected = plan.product.departures?.[0]?.prices?.[plan.product.departures?.[0]?.selectedPrice] ?? {};
 const approval = session.approval, execution = session.execution, expired = approval && Date.now() >= approval.expiresAt;
 const status = execution?.status === 'completed' ? '등록이 완료됐습니다. 최종 확인 결과를 확인하세요.'
  : failed() || execution?.status === 'needs-reconciliation' ? '처리가 중단됐습니다. 실행 기록과 저장 결과를 확인한 뒤 이어서 진행합니다.'
  : execution ? '승인을 받았습니다. 등록 처리 중입니다.'
  : approval?.status === 'cancelled' ? '검토가 종료됐습니다.'
  : expired ? '승인 시간이 만료됐습니다. 새 검토가 필요합니다.'
  : approval ? '승인을 받았습니다. 처리 결과를 기다려주세요.' : '';
 const form = status ? `<p role="status"><strong>${esc(status)}</strong></p>` : `<form method="post" action="/approve"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="version" value="${esc(session.version)}"><input type="hidden" name="scope_hash" value="${esc(session.scopeDigest)}"><input type="hidden" name="scope" value="basic,display,content,shell,days,season"><label>ERP 회사/테넌트 <input name="company" required></label><br><label>ERP 계정명 <input name="account" required></label><br><button type="submit">확인한 범위로 이어서 입력</button></form>`;
 return `<!doctype html><html lang="ko"><meta charset="utf-8"><title>기존 상품 이어서 입력</title><body style="font:16px system-ui;max-width:760px;margin:32px auto"><h1>기존 상품 이어서 입력</h1><p><b>기존 상품 ID ${esc(target.productId)} / 코드 ${esc(target.masterCode)}</b></p>${renewalNotice(plan)}<p>기본정보는 보존하며 다시 저장하지 않습니다. 남은 범위: 미디어·상세·참조, ${esc(plan.itinerary.length)}일 일정, 시즌·항공편.</p><p>이벤트 생성, 호텔 배정, 판매 시작, 공개/발행은 실행하지 않습니다.</p><p>이미지 ${esc(plan.source.images.length)}장 · ${esc(plan.itinerary.length)}일 · 성인 ${esc(selected.adult?.amount ?? '')} / 아동 ${esc(selected.child?.amount ?? '')} / 유아 ${esc(selected.infant?.amount ?? '')}</p><p>항공: ${esc(plan.season.fields['depart-0-flight_no'])} / ${esc(plan.season.fields['arrive-0-flight_no'])}</p>${form}<p>${esc(message)}</p></body></html>`;
}; }


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
async function assertPinned(pinned) {
 if (pinned.recovery && !same(await tree(pinned.recovery.dir), pinned.recovery.manifest)) fail('reconciled continuation evidence changed');
 if (pinned.priorFailure) {
  if (!same(await tree(pinned.priorFailure.dir), pinned.priorFailure.manifest)) fail('prior failed continuation evidence changed');
  for (const entry of pinned.priorFailure.reservations) {
   await regular(entry.path, 'historical continuation reservation');
   if (hash(await readFile(entry.path)) !== entry.sha256) fail('historical continuation reservation changed');
  }
 }
 for (const source of [pinned.approvedResume, pinned.uploadRecovery].filter(Boolean)) {
  if (!same(await tree(source.dir), source.manifest)) fail('approved failed continuation evidence changed');
  await regular(source.reservation.path, 'consumed approval reservation');
  if (hash(await readFile(source.reservation.path)) !== source.reservation.sha256) fail('consumed approval reservation changed');
 }
 const fresh = await pin({ planPath:pinned.dirs.planReal, journalDir:pinned.dirs.journalReal, runtimeDir:pinned.dirs.runtimeReal });
 if (!same(fresh.manifest, pinned.manifest)) fail('original plan, journal, or runtime evidence changed');
 for (const source of pinned.plan.source.images) await loadApprovedProductOnlyImage(source);
 return fresh;
}
async function existingCanonical(value) { try { return await realpath(value); } catch { return path.resolve(value); } }
async function freshDirectory(value, pinned, browserDir) {
 const resolved = path.resolve(value), origins = [pinned.dirs.planReal, pinned.dirs.journalReal, pinned.dirs.runtimeReal, ...[pinned.recovery?.dir, pinned.priorFailure?.dir, pinned.approvedResume?.dir, pinned.uploadRecovery?.dir].filter(Boolean), ...(browserDir ? [await existingCanonical(browserDir)] : [])];
 if (origins.some(origin => resolved === origin || resolved.startsWith(origin + path.sep) || origin.startsWith(resolved + path.sep))) fail('dataDir must not overlap original evidence or browser profile');
 await mkdir(resolved, { recursive: true, mode: 0o700 }); const real = await realpath(resolved), entries = await readdir(real);
 if (entries.length) fail('dataDir must be a fresh private directory');
 if (origins.some(origin => real === origin || real.startsWith(origin + path.sep) || origin.startsWith(real + path.sep))) fail('dataDir must not overlap original evidence or browser profile'); return real;
}
function reservationPath(pinned) {
 // The retry slot follows the already-consumed reservation, not mutable file
 // hashes. Adding a file to an old failure must never create another retry slot.
 const key = pinned.priorFailure ? digest({ original:pinned.plan.approvalBinding.planDigest, recovery:pinned.recovery.manifest, priorFailure:pinned.priorFailure.reservation })
  : pinned.recovery ? digest({ original:pinned.plan.approvalBinding.planDigest, recovery:pinned.recovery.manifest }) : pinned.plan.approvalBinding.planDigest;
 return path.join(path.dirname(pinned.dirs.journalReal), '.continuation-reservations', `${key}.json`);
}
async function reserveOriginal(pinned, dataDir) {
 const source = pinned.uploadRecovery ?? pinned.approvedResume;
 const file = pinned.uploadRecovery ? partialUploadReservationPath(source) : source ? resumeReservationPath(source) : reservationPath(pinned);
 await mkdir(path.dirname(file), { recursive:true, mode:0o700 });
 try { await writeJson(file, { kind:pinned.uploadRecovery ? 'product-only-verified-upload-resumption' : source ? 'product-only-zero-write-resumption' : 'product-only-continuation-reservation', originalJournal:pinned.dirs.journalReal,
  ...(source ? { consumedReservation:source.reservation, failedRun:source.dir, approval:source.approval, claim:source.claim } : {}), dataDir, at:now() }); }
 catch (error) { if (error?.code === 'EEXIST') fail('this original journal already has a consumed continuation reservation'); throw error; }
 return file;
}
function reviewScope(pinned, executionPlan, renewed) {
 return digest({ kind:'product-only-continuation-review-v1', target:{ productId:pinned.history.receipt.productId, masterCode:pinned.history.receipt.masterCode }, manifest:pinned.manifest,
  ...(pinned.recovery ? { recovery:{ directory:pinned.recovery.dir, manifest:pinned.recovery.manifest, detail:pinned.recovery.detail } } : {}),
  ...(pinned.priorFailure ? { priorFailure:pinned.priorFailure } : {}), ...(pinned.approvedResume ? { unforwardedFailure:pinned.approvedResume } : {}), ...(pinned.uploadRecovery ? { verifiedUploadFailure:pinned.uploadRecovery } : {}), phases:['media','shell','day','season','finalCheck'], ...(renewed ? { renewalBinding:executionPlan.approvalBinding } : {}) });
}
async function pinDetailRecovery(pinned, directory) {
 const dir=await realpath(directory), events=await lines(path.join(dir,'continuation.jsonl'));
 const plan=validateProductOnlyLaunchPlan(JSON.parse(await readFile(path.join(dir,'continuation-plan.json'),'utf8')));
 const original=clone(pinned.plan), previous=clone(plan);
 for(const value of [original,previous])for(const key of ['identity','continuation','approvalBinding'])delete value[key];
 if(!same(original,previous)||plan.continuation?.original?.approvalBinding?.planDigest!==pinned.plan.approvalBinding.planDigest)fail('recovery plan lineage differs');
 const approvals=events.filter(e=>e.kind==='human-approval'),claims=events.filter(e=>e.kind==='approval-claim');
 if(approvals.length!==1||claims.length!==1||approvals[0].approval.planDigest!==plan.approvalBinding.planDigest||claims[0].claim.planDigest!==plan.approvalBinding.planDigest||claims[0].claim.claimedAt>=approvals[0].approval.expiresAt||claims[0].claim.claimedAt<approvals[0].approval.approvedAt)fail('recovery requires one historical human approval and claim');
 const writes=events.filter(e=>e.kind==='write-authorized'),attempts=events.filter(e=>e.kind==='adapter-evidence'&&e.event?.phase==='attempt'),results=events.filter(e=>e.kind==='adapter-evidence'&&e.event?.phase==='result');
 const target={productId:String(pinned.history.receipt.productId),masterCode:pinned.history.receipt.masterCode};
 if(writes.length!==1||writes[0].event.key!=='detail'||writes[0].event.target.productId!==target.productId||writes[0].event.target.masterCode!==target.masterCode||writes[0].event.continuation.planDigest!==plan.approvalBinding.planDigest||attempts.length!==1||attempts[0].event.key!=='detail'||!same(attempts[0].event.target,writes[0].event.target)||results.length!==1||results[0].event.status!=='needs-reconciliation'||results[0].event.forwarded!==1||!same(results[0].event.completed,['detail'])||!same(results[0].event.uploads,[]))fail('only an exactly evidenced detail-only continuation failure can resume');
 if(events.some(e=>e.kind==='receipt-verified'||e.kind==='completed'||e.kind==='before-write'&&e.phase!=='media')||!events.some(e=>e.kind==='needs-reconciliation'))fail('recovery contains later or ambiguous writes');
 const manifest=await tree(dir);
 return {dir,manifest,detail:clone(writes[0].event.payload)};
}
async function historicalRun(pinned, directory, recovery, priorFailure, approvedResume) {
 const directoryStat = await lstat(directory);
 if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) fail('historical continuation must be a non-symlink directory');
 const dir = await realpath(directory);
 for (const name of ['continuation.jsonl','continuation-plan.json','original-manifest.json']) await regular(path.join(dir, name), name);
 const events = await lines(path.join(dir, 'continuation.jsonl'));
 if (events.some((event, index) => !Number.isSafeInteger(event.at) || event.at < 0 || index && event.at < events[index - 1].at)) fail('historical continuation timestamps are inconsistent');
 const plan = validateProductOnlyLaunchPlan(JSON.parse(await readFile(path.join(dir, 'continuation-plan.json'), 'utf8')));
 const original = clone(pinned.plan), previous = clone(plan);
 for (const value of [original, previous]) for (const key of ['identity','continuation','approvalBinding']) delete value[key];
 if (!same(original, previous)) fail('historical continuation plan differs from original content');
 assertStableIdentity(plan.identity, pinned.plan);
 const target = { productId:Number(pinned.history.receipt.productId), masterCode:pinned.history.receipt.masterCode };
 const expectedContinuation = {
  kind:'product-only-session-renewal-v1', authentication:{ status:'renewed', companyId:String(pinned.plan.companyId), identity:clone(plan.identity) }, target,
  original:{ identity:clone(pinned.plan.identity), companyId:String(pinned.plan.companyId), approvalBinding:clone(pinned.plan.approvalBinding), paths:clone(pinned.dirs), manifest:clone(pinned.manifest), manifestDigest:digest(pinned.manifest), images:clone(pinned.plan.source.images) }
 };
 if (!same(plan.continuation, expectedContinuation) || plan.identity.sessionKey === pinned.plan.identity.sessionKey) fail('historical continuation authentication or lineage differs');
 if (!same(JSON.parse(await readFile(path.join(dir, 'original-manifest.json'), 'utf8')), pinned.manifest) || !same(events[0]?.manifest, pinned.manifest)) fail('historical original evidence manifest differs');
 const exactly = kind => { const matching = events.filter(event => event.kind === kind); if (matching.length !== 1) fail(`historical continuation requires exactly one ${kind}`); return matching[0]; };
 if (!same(exactly('original-evidence-verified').target, target) || !same(exactly('session-renewal-review').plan, plan)) fail('historical continuation target or reviewed plan differs');
 const preflight = exactly('preflight-verified');
 if (preflight.target !== `${ALLOWED_ORIGIN}/tour/master_product/${target.productId}/change/` || preflight.schedules !== 0 || preflight.seasons !== 0 || preflight.forwardedWrites !== 0) fail('historical continuation preflight was not empty and read-only');
 const approvalRow = exactly('human-approval'), claimRow = exactly('approval-claim'), approval = approvalRow.approval, claim = claimRow.claim;
 const scopeDigest = reviewScope({ ...pinned, recovery, priorFailure, approvedResume }, plan, true);
 if (approval?.status !== 'approved' || approval.method !== 'localhost-human-form' || approval.planDigest !== plan.approvalBinding.planDigest || approval.scopeDigest !== scopeDigest || approval.accountObserved !== plan.identity.accountName || approval.tenantObserved !== String(plan.product.company.tenant)
  || claim?.id !== `product-only:${plan.approvalBinding.planDigest}` || claim.planDigest !== approval.planDigest || claim.scopeDigest !== scopeDigest || !same(claim.target, { mode:'NEW' })
  || ![approval.approvedAt, approval.expiresAt, claim.claimedAt].every(Number.isSafeInteger) || approval.approvedAt > approvalRow.at || approvalRow.at > claim.claimedAt || claim.claimedAt < approval.approvedAt || claim.claimedAt >= approval.expiresAt || claimRow.at < claim.claimedAt || claimRow.at >= approval.expiresAt) fail('historical human approval or claim is inconsistent');
 const reservation = approvedResume ? resumeReservationPath(approvedResume) : reservationPath({ ...pinned, recovery, priorFailure });
 if (claimRow.reservation !== reservation) fail('historical continuation reservation path differs');
 await regular(reservation, 'historical continuation reservation');
 const reservationBytes = await readFile(reservation), reserved = JSON.parse(reservationBytes);
 if (reserved.kind !== (approvedResume ? 'product-only-zero-write-resumption' : 'product-only-continuation-reservation') || (approvedResume && (!same(reserved.consumedReservation, approvedResume.reservation) || reserved.failedRun !== approvedResume.dir || !same(reserved.approval, approvedResume.approval) || !same(reserved.claim, approvedResume.claim))) || reserved.originalJournal !== pinned.dirs.journalReal || reserved.dataDir !== dir || !Number.isSafeInteger(reserved.at) || reserved.at < claim.claimedAt || reserved.at > claimRow.at) fail('historical continuation reservation does not bind this run');
 return { dir, events, plan, target, approval:clone(approval), claim:clone(claim), reservation:{ path:reservation, sha256:hash(reservationBytes) } };
}
function assertEventSequence(events, expected) {
 const kinds = events.map(event => event.kind === 'adapter-evidence' ? `adapter-evidence:${event.event?.phase}` : event.kind);
 if (kinds.at(-1) === 'continuation-closed') kinds.pop();
 if (!same(kinds, expected)) fail('historical continuation contains later, repeated, or ambiguous events');
}
async function pinPriorFailedRun(pinned, directory) {
 if (!pinned.recovery) fail('priorFailedRunDir requires reconciledRunDir');
 const detailRun = await historicalRun(pinned, pinned.recovery.dir);
 assertEventSequence(detailRun.events, ['continuation-start','original-evidence-verified','session-renewal-review','preflight-verified','human-approval','approval-claim','before-write','write-authorized','adapter-evidence:attempt','adapter-evidence:result','needs-reconciliation','needs-reconciliation']);
 const previous = await historicalRun(pinned, directory, pinned.recovery);
 if (previous.dir === pinned.recovery.dir) fail('prior failed run must differ from the detail recovery run');
 assertEventSequence(previous.events, ['continuation-start','original-evidence-verified','session-renewal-review','preflight-verified','detail-recovery-verified','human-approval','approval-claim','before-write','adapter-evidence:detail-reconciled','adapter-evidence:result','needs-reconciliation','needs-reconciliation']);
 const event = kind => previous.events.find(row => row.kind === kind);
 if (!same(event('detail-recovery-verified').recovery, pinned.recovery)) fail('prior failure does not pin the exact detail recovery evidence');
 const before = event('before-write'), target = { mode:'NEW', ...previous.target };
 if (before.phase !== 'media' || !same(before.targets, target)) fail('prior failure attempted a different phase or target');
 const reconciled = previous.events.find(row => row.event?.phase === 'detail-reconciled').event;
 const result = previous.events.find(row => row.event?.phase === 'result').event;
 const detailWrite = detailRun.events.find(row => row.kind === 'write-authorized').event;
 if (!same(reconciled.target, detailWrite.target) || !same(reconciled.payload, pinned.recovery.detail) || !same(result.target, reconciled.target)) fail('prior failure reconciled a different detail or target');
 if (result.status !== 'needs-reconciliation' || result.forwarded !== 0 || !same(result.completed, []) || !same(result.uploads, [])) fail('prior continuation was not provably unforwarded');
 if (previous.events.some(row => row.kind === 'needs-reconciliation' && row.diagnostic && row.diagnostic !== 'CONTINUATION_FAILED')) fail('prior continuation has an unknown save outcome');
 const manifest = await tree(previous.dir);
 return { dir:previous.dir, manifest, reservation:previous.reservation.path, reservations:[detailRun.reservation, previous.reservation] };
}
async function pinContinuationEvidence(options, { consumedForResume = false } = {}) {
 const pinned = await pin(options);
 if (options.reconciledRunDir) pinned.recovery = await pinDetailRecovery(pinned, options.reconciledRunDir);
 if (options.priorFailedRunDir) {
  pinned.priorFailure = await pinPriorFailedRun(pinned, options.priorFailedRunDir);
  if (!consumedForResume) {
   try { await lstat(reservationPath(pinned)); fail('this prior failed run already has a consumed continuation reservation'); }
   catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
 }
 await assertPinned(pinned);
 return pinned;
}
/** Read-only lineage audit. This never opens ERP, reserves a retry, or approves execution. */
export async function verifyProductOnlyContinuationEvidence(options = {}) {
 const pinned = await pinContinuationEvidence(options);
 return { target:clone(pinned.history.receipt), manifest:clone(pinned.manifest), recovery:clone(pinned.recovery), priorFailure:clone(pinned.priorFailure), reservationPath:reservationPath(pinned) };
}
function resumeReservationPath(source) {
 return path.join(path.dirname(source.reservation.path), '.zero-write-resumptions', `${digest({ reservation:source.reservation.path, claim:source.claim.id, scopeDigest:source.claim.scopeDigest })}.json`);
}
function partialUploadReservationPath(source) {
 return path.join(path.dirname(source.reservation.path), '.verified-upload-resumptions', `${digest({ reservation:source.reservation.path, claim:source.claim.id, scopeDigest:source.claim.scopeDigest })}.json`);
}
function assertResumeDeadline(source, clock) {
 const time = clock();
 if (!Number.isSafeInteger(time) || time < 0 || Math.max(time, now()) >= source.approval.expiresAt) fail('original human approval expired; a new human review is required');
}
async function pinApprovedZeroWriteFailure(pinned, directory, { consumedForUploadRecovery = false } = {}) {
 if (!pinned.recovery || !pinned.priorFailure) fail('resumption requires explicit original, detail recovery, and prior failed run evidence');
 const source = await historicalRun(pinned, directory, pinned.recovery, pinned.priorFailure);
 assertEventSequence(source.events, ['continuation-start','original-evidence-verified','session-renewal-review','preflight-verified','detail-recovery-verified','prior-failure-verified','human-approval','approval-claim','before-write','adapter-evidence:detail-reconciled','adapter-evidence:result','needs-reconciliation','needs-reconciliation']);
 const event = kind => source.events.find(row => row.kind === kind);
 if (!same(event('detail-recovery-verified').recovery, pinned.recovery) || !same(event('prior-failure-verified').priorFailure, pinned.priorFailure)) fail('approved failure evidence lineage differs');
 const before = event('before-write'), reconciled = source.events.find(row => row.event?.phase === 'detail-reconciled').event, result = source.events.find(row => row.event?.phase === 'result').event;
 const expectedTarget = { mode:'NEW', ...source.target };
 if (before.phase !== 'media' || !same(before.targets, expectedTarget) || reconciled.target?.origin !== ALLOWED_ORIGIN || reconciled.target?.productId !== String(source.target.productId) || reconciled.target?.masterCode !== source.target.masterCode || reconciled.target?.pageUrl !== `${ALLOWED_ORIGIN}/tour/master_product/${source.target.productId}/change/`
  || !same(reconciled.payload, pinned.recovery.detail) || !same(result.target, reconciled.target)) fail('approved failure target or reconciled detail differs');
 if (result.status !== 'needs-reconciliation' || result.forwarded !== 0 || !same(result.completed, []) || !same(result.uploads, [])) fail('approved continuation was not provably unforwarded');
 if (source.events.some(row => row.kind === 'needs-reconciliation' && row.diagnostic && row.diagnostic !== 'CONTINUATION_FAILED')) fail('approved continuation has an unknown save outcome');
 const approved = { dir:source.dir, manifest:await tree(source.dir), reservation:source.reservation, approval:source.approval, claim:source.claim, plan:source.plan };
 try { if (!consumedForUploadRecovery) { await lstat(resumeReservationPath(approved)); fail('this consumed approval already has a zero-write resumption'); } }
 catch (error) { if (error.code !== 'ENOENT') throw error; }
 return approved;
}
async function pinVerifiedUploadFailure(pinned, directory) {
 const source = await historicalRun(pinned, directory, pinned.recovery, pinned.priorFailure, pinned.approvedResume);
 if (source.events[0].at < (await lines(path.join(pinned.approvedResume.dir,'continuation.jsonl'))).at(-1).at) fail('partial upload predates its approved predecessor');
 assertEventSequence(source.events, ['continuation-start','original-evidence-verified','session-renewal-review','preflight-verified','detail-recovery-verified','prior-failure-verified','unforwarded-failure-verified','human-approval','approval-claim','before-write','adapter-evidence:detail-reconciled','write-authorized','adapter-evidence:attempt','adapter-evidence:upload-receipt','adapter-evidence:result','needs-reconciliation','needs-reconciliation']);
 const row = kind => source.events.find(value => value.kind === kind), phase = key => source.events.find(value => value.event?.phase === key).event;
 if (!same(row('detail-recovery-verified').recovery, pinned.recovery) || !same(row('prior-failure-verified').priorFailure, pinned.priorFailure) || !same(row('unforwarded-failure-verified').source, pinned.approvedResume) || row('unforwarded-failure-verified').mode !== 'fresh-human-review') fail('partial upload recovery lineage differs');
 const before = row('before-write'), detail = phase('detail-reconciled'), authorized = row('write-authorized'), attempted = phase('attempt'), uploaded = phase('upload-receipt'), result = phase('result');
 const target = detail.target, expectedTarget = {mode:'NEW', ...source.target}, pageUrl = `${ALLOWED_ORIGIN}/tour/master_product/${source.target.productId}/change/`;
 if (before.phase !== 'media' || !same(before.targets, expectedTarget) || target?.origin !== ALLOWED_ORIGIN || target.productId !== String(source.target.productId) || target.masterCode !== source.target.masterCode || target.pageUrl !== pageUrl || !same(detail.payload, pinned.recovery.detail)) fail('partial upload recovery target or detail differs');
 const firstId = source.plan.display.sourceMode === 'reference-subset' ? source.plan.source.images[0].id : source.plan.display.images[0].sourceImageId;
 const image = source.plan.source.images.find(value => value.id === firstId), bytes = await loadApprovedProductOnlyImage(image), key = `upload:${image.sha256}`, url = `${ALLOWED_ORIGIN}/contents/image/create_modal/?managed_flag=false`;
 const continuation = {target:expectedTarget, planDigest:source.plan.approvalBinding.planDigest, originalPlanDigest:pinned.plan.approvalBinding.planDigest, authentication:source.plan.continuation.authentication, runtimeDigest:hash(JSON.stringify(pinned.manifest.runtime)), imageDigest:hash(JSON.stringify(pinned.manifest.plan)), executionDeadline:source.approval.expiresAt};
 if (!same(authorized.event, {key,target,url,payload:{alt:image.alt,'pc-image':{name:image.name,mimeType:image.mimeType,size:bytes.length,sha256:image.sha256}},continuation}) || authorized.at >= source.approval.expiresAt || authorized.at < source.claim.claimedAt) fail('partial upload authorization differs from the first approved image');
 if (!same(attempted, {phase:'attempt',key,target,url}) || !same(uploaded.target,target) || !same(uploaded.source,{name:image.name,sha256:image.sha256}) || !same(result.target,target)) fail('partial upload attempt or receipt source differs');
 const receipt = validateDisplayImages([uploaded.receipt], source.plan.companyId)[0];
 if (result.status !== 'needs-reconciliation' || result.forwarded !== 1 || !same(result.completed,[key]) || !same(result.uploads,[]) || result.message !== 'CDN image MIME differs from the approved source') fail('partial recovery requires exactly one known upload and no later writes');
 if (source.events.some(value => value.kind === 'needs-reconciliation' && value.diagnostic && value.diagnostic !== 'CONTINUATION_FAILED')) fail('partial upload has an unknown save outcome');
 const approved = {dir:source.dir,manifest:await tree(source.dir),reservation:source.reservation,approval:source.approval,claim:source.claim,plan:source.plan,target:clone(target),reconciledUploads:[{sourceSha256:image.sha256,receipt:clone(receipt)}]};
 try { await lstat(partialUploadReservationPath(approved)); fail('this upload approval already has a partial resumption'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
 return approved;
}
async function verifyRecoveredUpload(pinned, verifyUploadedImage, fetchImpl) {
 const recovery = pinned.uploadRecovery, saved = recovery.reconciledUploads[0], source = recovery.plan.source.images.find(image => image.sha256 === saved.sourceSha256);
 const verify = verifyUploadedImage ?? (value => verifyApprovedProductOnlyCdnImage({...value,companyId:recovery.plan.companyId,fetchImpl}));
 const proof = await verify({receipt:clone(saved.receipt),source:clone(source),target:clone(recovery.target)});
 if (proof?.tenantId !== recovery.plan.companyId || proof.src !== saved.receipt.src || proof.sha256 !== source.sha256 || !Number.isSafeInteger(proof.bytes) || proof.bytes !== (await loadApprovedProductOnlyImage(source)).length) fail('recovered upload CDN evidence differs from the approved bytes');
 return [{...clone(saved),proof:clone(proof)}];
}
/** Reconcile precisely the first completed upload; never resend its approved bytes. */
export async function resumeVerifiedUploadProductOnlyContinuation({failedRunDir,unforwardedRunDir,failedPage,renewApproval=false,planPath,journalDir,runtimeDir,reconciledRunDir,priorFailedRunDir,dataDir,browser,browserDir,clock=now,...executionOptions}={}) {
 if (typeof renewApproval !== 'boolean' || typeof clock !== 'function' || !failedRunDir || !unforwardedRunDir || !dataDir) fail('partial recovery requires explicit failed and unforwarded runs, fresh dataDir, and boolean renewApproval');
 const pinned = await pinContinuationEvidence({planPath,journalDir,runtimeDir,reconciledRunDir,priorFailedRunDir},{consumedForResume:true});
 pinned.approvedResume = await pinApprovedZeroWriteFailure(pinned,unforwardedRunDir,{consumedForUploadRecovery:true});
 pinned.uploadRecovery = await pinVerifiedUploadFailure(pinned,failedRunDir);
 if (!renewApproval) assertResumeDeadline(pinned.uploadRecovery,clock);
 await assertPinned(pinned); await verifyRecoveredUpload(pinned,executionOptions.verifyUploadedImage,executionOptions.fetchImpl);
 return resumePinnedContinuation({...executionOptions,pinned,failedPage,renewApproval,planPath,journalDir,runtimeDir,reconciledRunDir,priorFailedRunDir,dataDir,browser,browserDir,clock});
}
/** Resume an already-claimed human approval only after proving zero authorization
 * and zero forwarding. renewApproval explicitly opens a new human form instead.
 * Historical files and reservations are read-only; the retry gets one wx slot.
 */
export async function resumeUnforwardedProductOnlyContinuation({ failedRunDir, failedPage, renewApproval = false, planPath, journalDir, runtimeDir, reconciledRunDir, priorFailedRunDir, dataDir, browser, browserDir, clock = now, ...executionOptions } = {}) {
 if (typeof renewApproval !== 'boolean' || typeof clock !== 'function' || !failedRunDir || !dataDir) fail('explicit failedRunDir, dataDir, boolean renewApproval, and valid clock are required');
 const pinned = await pinContinuationEvidence({ planPath, journalDir, runtimeDir, reconciledRunDir, priorFailedRunDir }, { consumedForResume:true });
 pinned.approvedResume = await pinApprovedZeroWriteFailure(pinned, failedRunDir);
 return resumePinnedContinuation({ ...executionOptions, pinned, failedPage, renewApproval, planPath, journalDir, runtimeDir, reconciledRunDir, priorFailedRunDir, dataDir, browser, browserDir, clock });
}
async function resumePinnedContinuation({ pinned, failedPage, renewApproval, planPath, journalDir, runtimeDir, reconciledRunDir, priorFailedRunDir, dataDir, browser, browserDir, clock, ...executionOptions }) {
 const approvalSource = pinned.uploadRecovery ?? pinned.approvedResume;
 if (!renewApproval) assertResumeDeadline(approvalSource, clock);
 await assertPinned(pinned);
 if (!failedPage || typeof failedPage.context !== 'function' || typeof failedPage.isClosed !== 'function') fail('the failed dedicated page is required to retire its transport safely');
 const oldContext = failedPage.context(), targetUrl = `${ALLOWED_ORIGIN}/tour/master_product/${pinned.history.receipt.productId}/change/`;
 if (failedPage.url().split('#')[0] !== targetUrl) fail('failed browser page is not the exact approved product');
 if (!browser && browserDir) browser = new ExistingProfileBrowser({ browserDir:path.resolve(browserDir) });
 if (!browser || typeof browser.open !== 'function') fail('a fresh owned browser opener is required');
 // Native failures leave a context-wide deny guard with no public ownership
 // handle. Closing that dedicated context retires every pending request without
 // identifying private Playwright routes or removing another caller's guard.
 if (!failedPage.isClosed()) { requireScheduleSession(failedPage); await oldContext.close(); }
 if (!failedPage.isClosed() || oldContext.pages().length) fail('failed browser context has not been fully retired');
 const ownedBrowser = { open:async () => {
  const owned = await browser.open();
  if (!owned?.page || owned.page.context() === oldContext || typeof owned.close !== 'function') fail('resumption requires a new dedicated browser context');
  requireScheduleSession(owned.page);
  return owned;
 } };
 return startProductOnlyContinuation({ ...executionOptions, planPath, journalDir, runtimeDir, reconciledRunDir, priorFailedRunDir, dataDir, browser:ownedBrowser, browserDir, clock, renewSessionReview:renewApproval, preflightOnly:false,
  [approvedResumeCapability]:{ pinned, renewApproval } });
}
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
 const companyIds = await page.locator('img').evaluateAll(nodes => [...new Set(nodes.map(node => {
  try { const source = new URL(node.src); if (source.origin !== 'https://media.eoding.com') return null; return /^\/media\/travelagent\/(\d+)\/(?:erp_logo|logo)\//.exec(source.pathname)?.[1]; } catch { return null; }
 }).filter(Boolean))]);
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
export async function startProductOnlyContinuation({ planPath, journalDir, originalJournal, runtimeDir, originalRuntime, dataDir, browser, browserDir, preflightOnly = false, renewSessionReview = false, reconciledRunDir, priorFailedRunDir, identityReader, controls, loadImage = loadApprovedProductOnlyImage, verifyUploadedImage, ttlMs = 15 * 60 * 1000, fetchImpl, clock = now, [approvedResumeCapability]:resume } = {}) {
 if (originalJournal) journalDir = originalJournal; if (originalRuntime) runtimeDir = originalRuntime;
 if (typeof preflightOnly !== 'boolean' || typeof clock !== 'function') fail('preflightOnly must be boolean and clock must be a function'); if (!planPath || !journalDir || !runtimeDir || !dataDir) fail('planPath, original journal/runtime, and dataDir are required');
 if (typeof renewSessionReview !== 'boolean' || (renewSessionReview && preflightOnly)) fail('renewSessionReview must be an exclusive review mode');
 const pinned = resume?.pinned ?? await pinContinuationEvidence({ planPath, journalDir, runtimeDir, reconciledRunDir, priorFailedRunDir }); const carryApproval = Boolean(resume && !resume.renewApproval); const approvalSource = pinned.uploadRecovery ?? pinned.approvedResume; const dir = await freshDirectory(dataDir, pinned, browserDir); let reservation = null; const journal = new Journal(dir, pinned.manifest); await journal.start(); await journal.add('original-evidence-verified', { target: { productId: pinned.history.receipt.productId, masterCode: pinned.history.receipt.masterCode } });
 if (!browser && browserDir) browser = new ExistingProfileBrowser({ browserDir: path.resolve(browserDir) });
 if (!browser || typeof browser.open !== 'function') fail('an owned ScheduleSessionBrowser-compatible browser is required');
 await assertPinned(pinned);
 let executionPlan = resume ? approvalSource.plan : pinned.plan;
 const readIdentity = identityReader ?? defaultIdentityReader(carryApproval ? executionPlan : pinned.plan, renewSessionReview);
 const identity = async page => {
  if (renewSessionReview || resume) await assertCompany(page, pinned.plan);
  const observed = await readIdentity(page);
  if (!same(observed, executionPlan.identity)) fail('observed ERP account or session drifted from the reviewed identity');
  return observed;
 };
 const currentTime = () => { const value = clock(); if (!Number.isSafeInteger(value) || value < 0) fail('continuation clock is invalid'); return carryApproval ? Math.max(value, now()) : value; };
 let owned, closed = false, terminal = false, busy = false, reviewFailed = false, writePermit = false, currentWrite = null, executionDeadline = 0, barrier;
 let resolveCompleted; const completed = new Promise(resolve => { resolveCompleted = resolve; }); let settled = false;
 const settle = value => { if (!settled) { settled = true; resolveCompleted(Object.freeze(clone(value))); } };
 const close = async () => { if (closed) return; closed = true; terminal = true; writePermit = false; await owned?.close(); if(barrier)await owner.unroute('**/*',barrier).catch(error => { if (!page.isClosed() || owner.pages().length) throw error; }); };
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
  const checked = await verifyContinuationPreflight({ page, plan: executionPlan, receipt: pinned.history.receipt, identity, reconciledDetail:pinned.recovery?.detail });
  if (!pinned.uploadRecovery) return checked;
  const uploadProof = await verifyRecoveredUpload(pinned, verifyUploadedImage, fetchImpl);
  return { ...checked, reconciledUploads:uploadProof };
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
   if (!resume && observed.sessionKey === pinned.plan.identity.sessionKey) fail('session renewal requires a changed observed session; use --review for the original session');
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
  if (carryApproval) assertResumeDeadline(approvalSource, currentTime);
  if (renewSessionReview) { await writeJson(path.join(dir, 'continuation-plan.json'), executionPlan); await journal.add('session-renewal-review', { plan:executionPlan }); }
  else if (carryApproval) await writeJson(path.join(dir, 'continuation-plan.json'), executionPlan);
 } catch (error) { await close(); throw error; } await journal.add('preflight-verified', proof);
 if(pinned.recovery)await journal.add('detail-recovery-verified',{recovery:pinned.recovery});
 if(pinned.priorFailure)await journal.add('prior-failure-verified',{priorFailure:pinned.priorFailure});
 if(resume)await journal.add('unforwarded-failure-verified',{source:pinned.approvedResume,mode:carryApproval?'carry-unexpired-approval':'fresh-human-review'});
 if(pinned.uploadRecovery)await journal.add('verified-upload-failure-verified',{source:pinned.uploadRecovery,mode:carryApproval?'carry-unexpired-approval':'fresh-human-review'});
 if (preflightOnly) { await close(); return Object.freeze({ status: 'preflight-complete', target: { productId: pinned.history.receipt.productId, masterCode: pinned.history.receipt.masterCode }, manifest: clone(pinned.manifest) }); }
 const store = carryApproval ? {
  state:{ approval:{ ...clone(approvalSource.approval), status:'consumed' }, execution:null },
  async claim(request) {
   if (closed || terminal || this.state.execution || !same(request, { target:{ mode:'NEW' }, ...executionPlan.approvalBinding })) fail('carried approval is changed or already executing');
   assertResumeDeadline(approvalSource, currentTime); await assertPinned(pinned); await runPreflight();
   if (closed || terminal || this.state.execution) fail('carried approval was closed during preflight');
   assertResumeDeadline(approvalSource, currentTime);
   reservation = await reserveOriginal(pinned, dir);
   const originalClaim = clone(approvalSource.claim), claim = { ...originalClaim, scopeDigest:executionPlan.approvalBinding.scopeDigest };
   await journal.add('approval-carried-forward', { sourceDirectory:approvalSource.dir, sourceManifest:approvalSource.manifest, originalApproval:clone(approvalSource.approval), originalClaim, reservation });
   assertResumeDeadline(approvalSource, currentTime);
   this.state.execution = { status:'executing', claim:clone(claim) };
   return claim;
  },
  async completed(result) { this.state.execution = { status:'completed', result:clone(result) }; },
  async reconcile() { this.state.execution = { status:'needs-reconciliation' }; }
 } : new ProductOnlyReviewStore({ plan: executionPlan, sourceLabel: `existing:${pinned.history.receipt.productId}`, sourceDigest: pinned.plan.approvalBinding.planDigest,
  onApprove: approval => journal.add('human-approval', { approval }),
  onCancel: async approval => { terminal = true; writePermit = false; await journal.add('approval-cancelled', { approval }); settle({ status:'cancelled' }); },
  onClaim: async claim => { reservation = await reserveOriginal(pinned, dir); await journal.add('approval-claim', { claim, reservation }); },
  onReconcile: result => journal.add('needs-reconciliation', { result: { status:'needs-reconciliation', message:'Continuation failed; inspect durable journal.' } }),
  beforeClaim: async () => { if (closed || terminal) fail('continuation is closed'); await assertPinned(pinned); await runPreflight(); if (closed || terminal || currentTime() >= store.state.approval.expiresAt) fail('continuation closed or approval expired during preflight'); }, clock: currentTime
 });
 // The form binds the exact existing target and pinned original evidence; only the
 // internally returned scope is translated to the exact adapter-compatible plan.
 const adapterScopeDigest = executionPlan.approvalBinding.scopeDigest, reviewScopeDigest = reviewScope(pinned, executionPlan, renewSessionReview);
 if (!carryApproval) {
  store.state.scopeDigest = reviewScopeDigest;
  const claimForReview = store.claim.bind(store); store.claim = async request => { const claimed = await claimForReview({ ...request, scopeDigest:reviewScopeDigest }); return { ...claimed, scopeDigest:adapterScopeDigest }; };
 }
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
    if (pinned.uploadRecovery?.reconciledUploads.some(saved => event.key === `upload:${saved.sourceSha256}` || event.payload?.['pc-image']?.sha256 === saved.sourceSha256)) fail('an independently reconciled image must never be uploaded again');
    await assertPinned(pinned); await identity(page); if (closed || terminal || currentTime() >= executionDeadline) fail('write authorization expired');
    const authorization = await journal.authorize({ ...event, continuation: { target: clone(targets), planDigest:executionPlan.approvalBinding.planDigest, ...(renewSessionReview ? { originalPlanDigest:pinned.plan.approvalBinding.planDigest, authentication:clone(executionPlan.continuation.authentication) } : {}), runtimeDigest:hash(JSON.stringify(pinned.manifest.runtime)), imageDigest:hash(JSON.stringify(pinned.manifest.plan)), executionDeadline } });
    if (closed || terminal || currentTime() >= executionDeadline) fail('write authorization expired');
    writePermit = true; return authorization;
   };
   const adapters = createProductOnlyAdapters({ plan: executionPlan, identity, authorizeWrite, record: event => journal.record(event), loadImage, verifyUploadedImage: verifyUploadedImage ?? (value => verifyApprovedProductOnlyCdnImage({ ...value, companyId: pinned.plan.companyId, fetchImpl })), controls, seedBasicReceipt: pinned.history.receipt, reconciledDetail:pinned.recovery?.detail, reconciledUploads:pinned.uploadRecovery?.reconciledUploads });
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
  } catch (error) { terminal = true; reviewFailed = true; writePermit = false; await journal.add('needs-reconciliation', { message:'Continuation failed; inspect durable journal.', diagnostic:safeFailure(error) }); await store.reconcile(new Error('Continuation failed; inspect durable journal.')).catch(() => {}); throw new Error('Continuation failed; inspect durable journal.'); } finally { busy = false; currentWrite = null; }
 };
 const approvedRun = async () => { try { const result = await run(); settle(result); return result; } catch (error) { settle({ status:'needs-reconciliation' }); throw error; } };
 let ui; if (!carryApproval) try { ui = await startProductReviewUI({ store, sessionId: store.state.id, ttlMs, onApproved: approvedRun, renderPage: renderContinuationReview({ productId:pinned.history.receipt.productId, masterCode:pinned.history.receipt.masterCode }, () => reviewFailed) }); } catch (error) { await close(); throw error; }
 let closingPromise;
 if (carryApproval) void Promise.resolve().then(approvedRun).catch(() => {});
 return Object.freeze({ url: ui?.url ?? null, preflight: proof, completed, close: () => {
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
   void ui?.close().catch(() => {});
  })();
  return closingPromise;
 }, execute: async () => fail('a fresh localhost human review form approval is required; execute() cannot bypass it') });
}
