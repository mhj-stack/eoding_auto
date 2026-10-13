import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { digest } from './core.mjs';
import { createProductOnlyApprovalBinding } from './product-only-execution.mjs';

const fail = message => { throw new Error('Unforwarded season recovery blocked: ' + message); };
const hash = value => createHash('sha256').update(value).digest('hex');
const clone = value => structuredClone(value);
async function canonical(value, directory=false) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) fail('absolute evidence path required');
  const stat=await lstat(value);
  if (stat.isSymbolicLink() || (directory?!stat.isDirectory():!stat.isFile()) || await realpath(value)!==value) fail('evidence path is not canonical');
}

/** Pin one already-claimed, terminal season recovery which never authorized a write.
 * The caller supplies freshly verified original saved-stage evidence as `pinned`.
 * This reads historical files only; a successor must open a fresh review and use
 * retryReservationPath with wx, never renew or consume the historical approval.
 */
export async function verifyUnforwardedSeasonRecovery({directory,pinned}={}) {
  await canonical(directory,true);
  if (!pinned?.fingerprint?.reservation || !pinned?.claim || !pinned?.targets || !pinned?.plan || !pinned?.checkpoint?.media) fail('verified original saved-stage evidence required');
  const names=(await readdir(directory)).sort();
  if (!same(names,['original-manifest.json','recovery-plan.json','recovery.jsonl'])) fail('unexpected failed recovery evidence files');
  const buffers={};
  for (const name of names) { const file=path.join(directory,name); await canonical(file); buffers[name]=await readFile(file); }
  const manifest=names.map(name=>({name,sha256:hash(buffers[name])}));
  const plan=JSON.parse(buffers['recovery-plan.json']),text=buffers['recovery.jsonl'].toString('utf8');
  if (!text.trim() || !text.endsWith('\n')) fail('failed recovery journal is truncated');
  const events=text.trimEnd().split('\n').map(JSON.parse),kinds=events.map(row=>row.kind);
  if (kinds.at(-1)==='recovery-closed') kinds.pop();
  if (!same(kinds,['season-recovery-start','preflight-verified','review-approval','preflight-verified','approval-claim','adapter-claim-binding','before-write','recovery-failed','needs-reconciliation'])) fail('requires exactly one claimed terminal failure before any write authorization or attempt');
  if (events.some((row,index)=>!Number.isSafeInteger(row.at)||row.at<0||index&&row.at<events[index-1].at)) fail('failed recovery timestamp ordering changed');
  const take=kind=>events.find(row=>row.kind===kind);
  const original=JSON.parse(buffers['original-manifest.json']);
  if (!same(original,pinned.fingerprint)||!same(events[0].fingerprint,pinned.fingerprint)) fail('failed recovery original fingerprint changed');
  const historical=plan.seasonRecovery;
  if (typeof historical?.allowPastDepartureTest!=='boolean') fail('private-test mode is not explicit');
  const expectedPlan=clone(pinned.plan); expectedPlan.identity=clone(plan.identity);
  expectedPlan.seasonRecovery={kind:'product-only-season-recovery-v1',target:clone(pinned.targets),fingerprint:clone(pinned.fingerprint),allowPastDepartureTest:historical.allowPastDepartureTest};
  expectedPlan.approvalBinding=createProductOnlyApprovalBinding(expectedPlan);
  if (!same(plan,expectedPlan) || !same(Object.keys(plan.identity??{}).sort(),['accountKey','accountName','sessionKey'])
    || Object.values(plan.identity).some(value=>typeof value!=='string'||!value.trim()||value!==value.trim())
    || plan.identity.accountName!==pinned.plan.identity.accountName || plan.identity.accountKey!==pinned.plan.identity.accountKey) fail('failed recovery plan, stable identity or scope changed; nested retries are not supported');
  const scopeDigest=digest({kind:'product-only-season-recovery-review-v1',target:pinned.targets,remaining:['season'],fingerprint:pinned.fingerprint,approvalBinding:plan.approvalBinding});
  const approvalRow=take('review-approval'),claimRow=take('approval-claim'),approval=approvalRow.approval,claim=claimRow.claim;
  if (approval?.status!=='approved'||approval.version!==1||approval.method!=='localhost-human-form'||approval.planDigest!==plan.approvalBinding.planDigest||approval.scopeDigest!==scopeDigest
    || approval.tenantObserved!==String(plan.product.company.tenant)||approval.accountObserved!==plan.identity.accountName
    || ![approval.approvedAt,approval.expiresAt,claim?.claimedAt].every(Number.isSafeInteger)||approval.approvedAt>approvalRow.at||approvalRow.at>claim.claimedAt||claim.claimedAt>=approval.expiresAt||claimRow.at<claim.claimedAt||claimRow.at>=approval.expiresAt
    || !same(claim,{id:'product-only:'+plan.approvalBinding.planDigest,target:{mode:'NEW'},planDigest:plan.approvalBinding.planDigest,scopeDigest,claimedAt:claim.claimedAt})) fail('historical season-only approval or claim changed');
  const binding=take('adapter-claim-binding'),adapterClaim={...clone(claim),scopeDigest:plan.approvalBinding.scopeDigest};
  if (!same(binding.reviewClaim,claim)||!same(binding.adapterClaim,adapterClaim)) fail('historical adapter claim translation changed');
  if (take('before-write').phase!=='season'||!same(take('before-write').targets,pinned.targets)||take('before-write').at>=approval.expiresAt) fail('failed attempt was not the approved remaining season');
  for (const row of events.filter(row=>row.kind==='preflight-verified')) {
    const proof=row.proof;
    if (proof?.status!=='season-recovery-preflight-verified'||!same(proof.target,pinned.targets)||proof.seasons!==0||proof.forwardedWrites!==0
      || proof.saved?.status!=='saved-stages-reconciled'||proof.saved.media?.status!=='native-content-reverified'||proof.saved.media.forwarded!==0
      || !same(proof.saved.media.target,pinned.checkpoint.media.target)||!same(proof.saved.media.persisted,pinned.checkpoint.media.persisted)
      || proof.saved.basicSchedule?.status!=='saved-basic-schedule-reconciled') fail('historical preflight was not a read-only reconciliation of saved content');
  }
  const failure=take('recovery-failed'),result=take('needs-reconciliation').result;
  if (failure.message!=='Unexpected write blocked during season product transition'||!same(result,{status:'needs-reconciliation',message:failure.message})) fail('terminal zero-write failure is not the supported blocked transition');
  const baseReservation=path.join(path.dirname(pinned.fingerprint.reservation.path),'.season-resumptions',digest({reservation:pinned.fingerprint.reservation.path,claim:pinned.claim.id,scope:pinned.claim.scopeDigest})+'.json');
  if (claimRow.reservation!==baseReservation) fail('historical claim is not the canonical consumed base slot');
  await canonical(baseReservation);
  const reservationBytes=await readFile(baseReservation),reserved=JSON.parse(reservationBytes);
  if (!same(reserved,{kind:'product-only-season-resumption',failedRun:pinned.fingerprint.failed.directory,consumedReservation:pinned.fingerprint.reservation,dataDir:directory,claim,at:reserved.at})
    || !Number.isSafeInteger(reserved.at)||reserved.at<claim.claimedAt||reserved.at>claimRow.at) fail('consumed base reservation changed');
  const reservation={path:baseReservation,sha256:hash(reservationBytes)};
  const retryReservationPath=path.join(path.dirname(baseReservation),'.zero-write-resumptions',digest({reservation:baseReservation,claim:claim.id,scopeDigest:claim.scopeDigest})+'.json');
  return {dir:directory,manifest,plan:clone(plan),approval:clone(approval),claim:clone(claim),adapterClaim,reservation,retryReservationPath};
}
