import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { digest } from './core.mjs';
import { createProductOnlyApprovalBinding } from './product-only-execution.mjs';
import { verifyUnforwardedSeasonRecovery } from './product-only-season-recovery-unforwarded.mjs';

const clone=value=>structuredClone(value),hash=value=>createHash('sha256').update(value).digest('hex');
const fail=message=>{throw new Error('Season final evidence blocked: '+message);};
async function canonical(value,directory=false){
 if(typeof value!=='string'||!path.isAbsolute(value))fail('absolute evidence path required');
 const stat=await lstat(value);
 if(stat.isSymbolicLink()||(directory?!stat.isDirectory():!stat.isFile())||await realpath(value)!==value)fail('noncanonical historical evidence path');
}

/** Pin pending season-save evidence for read-only reconciliation, never a replay.
 * No success receipt is inferred from an authorization or a parser error.
 */
export async function verifySavedSeasonRecovery({directory,pinned,unforwardedRecoveryDir}={}){
 const prior=await verifyUnforwardedSeasonRecovery({directory:unforwardedRecoveryDir,pinned});
 await canonical(directory,true);if(directory===prior.dir)fail('saved and unforwarded recoveries must differ');
 const names=(await readdir(directory)).sort();
 if(!same(names,['original-manifest.json','recovery-plan.json','recovery.jsonl']))fail('unexpected recovery evidence files');
 const buffers={};for(const name of names){await canonical(path.join(directory,name));buffers[name]=await readFile(path.join(directory,name));}
 const manifest=names.map(name=>({name,sha256:hash(buffers[name])})),plan=JSON.parse(buffers['recovery-plan.json']);
 const text=buffers['recovery.jsonl'].toString('utf8');if(!text.trim()||!text.endsWith('\n'))fail('truncated historical journal');
 const events=text.trimEnd().split('\n').map(JSON.parse),kinds=events.map(row=>row.kind);if(kinds.at(-1)==='recovery-closed')kinds.pop();
 if(!same(kinds,['season-recovery-start','preflight-verified','review-approval','preflight-verified','approval-claim','adapter-claim-binding','before-write','write-authorized','adapter-evidence','recovery-failed','needs-reconciliation']))fail('expected one pending authorized save and no historical success receipt');
 if(events.some((row,index)=>!Number.isSafeInteger(row.at)||row.at<0||index&&row.at<events[index-1].at))fail('historical time ordering changed');
 const take=kind=>events.find(row=>row.kind===kind),priorProof={directory:prior.dir,manifest:clone(prior.manifest),approvalBinding:clone(prior.plan.approvalBinding),claim:clone(prior.claim),reservation:clone(prior.reservation)};
 if(!same(JSON.parse(buffers['original-manifest.json']),pinned.fingerprint)||!same(events[0].fingerprint,pinned.fingerprint)||!same(events[0].unforwardedRecovery,priorProof))fail('historical predecessor fingerprint changed');
 if(typeof plan.seasonRecovery?.allowPastDepartureTest!=='boolean')fail('historical private-test scope missing');
 const expectedPlan=clone(pinned.plan);expectedPlan.identity=clone(plan.identity);expectedPlan.seasonRecovery={kind:'product-only-season-recovery-v1',target:clone(pinned.targets),fingerprint:clone(pinned.fingerprint),allowPastDepartureTest:plan.seasonRecovery.allowPastDepartureTest,unforwardedRecovery:priorProof};expectedPlan.approvalBinding=createProductOnlyApprovalBinding(expectedPlan);
 if(!same(plan,expectedPlan)||!same(Object.keys(plan.identity??{}).sort(),['accountKey','accountName','sessionKey'])||Object.values(plan.identity).some(value=>typeof value!=='string'||!value.trim()||value!==value.trim())||plan.identity.accountName!==pinned.plan.identity.accountName||plan.identity.accountKey!==pinned.plan.identity.accountKey)fail('historical plan or stable identity changed');
 const scopeDigest=digest({kind:'product-only-season-recovery-review-v1',target:pinned.targets,remaining:['season'],fingerprint:pinned.fingerprint,approvalBinding:plan.approvalBinding,unforwardedRecovery:priorProof});
 const approvalRow=take('review-approval'),claimRow=take('approval-claim'),approval=approvalRow.approval,claim=claimRow.claim;
 // Check validity at the historical claim and authorization times. Read-only
 // reconciliation remains permitted after that original deadline has elapsed.
 if(approval?.status!=='approved'||approval.version!==1||approval.method!=='localhost-human-form'||approval.planDigest!==plan.approvalBinding.planDigest||approval.scopeDigest!==scopeDigest||approval.tenantObserved!==String(plan.product.company.tenant)||approval.accountObserved!==plan.identity.accountName
  ||![approval.approvedAt,approval.expiresAt,claim?.claimedAt].every(Number.isSafeInteger)||approval.approvedAt>approvalRow.at||approvalRow.at>claim.claimedAt||claim.claimedAt>=approval.expiresAt||claimRow.at<claim.claimedAt||claimRow.at>=approval.expiresAt
  ||!same(claim,{id:'product-only:'+plan.approvalBinding.planDigest,target:{mode:'NEW'},planDigest:plan.approvalBinding.planDigest,scopeDigest,claimedAt:claim.claimedAt}))fail('historical season-only approval or claim changed');
 const adapterClaim={...clone(claim),scopeDigest:plan.approvalBinding.scopeDigest},bindingRow=take('adapter-claim-binding');
 if(!same(bindingRow.reviewClaim,claim)||!same(bindingRow.adapterClaim,adapterClaim)||take('before-write').phase!=='season'||!same(take('before-write').targets,pinned.targets))fail('historical adapter claim or target changed');
 for(const row of events.filter(row=>row.kind==='preflight-verified')){
  const p=row.proof;
  if(p?.status!=='season-recovery-preflight-verified'||!same(p.target,pinned.targets)||p.seasons!==0||p.forwardedWrites!==0||p.saved?.status!=='saved-stages-reconciled'||p.saved.media?.status!=='native-content-reverified'||p.saved.media.forwarded!==0||!same(p.saved.media.target,pinned.checkpoint.media.target)||!same(p.saved.media.persisted,pinned.checkpoint.media.persisted)||p.saved.basicSchedule?.status!=='saved-basic-schedule-reconciled')fail('historical saved-content preflight changed');
 }
 const authorization=take('write-authorized'),nativeRow=take('adapter-evidence'),event=authorization.event,prepared=event?.prepared;
 const nativePlan={fields:clone(plan.season.fields),selects:clone(plan.season.selects),selectLabels:clone(plan.season.selectLabels??{}),selectQueries:clone(plan.season.selectQueries??{}),selectedDates:clone(plan.season.selectedDates)};
 const target={productId:String(pinned.targets.productId)},origin='https://basecamp.team',identityDigest=digest({identityDigest:digest(plan.identity)});
 if(!prepared||!Array.isArray(prepared.form)||prepared.form.some(tuple=>!Array.isArray(tuple)||tuple.length!==2||tuple.some(value=>typeof value!=='string')))fail('durable native prepared form is missing');
 const binding={version:1,phase:'season',target,origin,identityDigest,planDigest:digest(nativePlan),formDigest:digest(prepared.form),baselineSeasonIds:[]};binding.digest=digest(binding);
 const expectedPrepared={kind:'season-prepared-v1',target,origin,plan:nativePlan,selectedDates:nativePlan.selectedDates,form:clone(prepared.form),identityDigest,planDigest:binding.planDigest,formDigest:binding.formDigest,baselineSeasonIds:[],binding,state:'prepared'};
 if(!same(prepared,expectedPrepared)||!same(event,{phase:'season',target:clone(pinned.targets),approvalBinding:clone(plan.approvalBinding),approvalClaim:adapterClaim,binding,bindingDigest:binding.digest,prepared:expectedPrepared})||authorization.at<claim.claimedAt||authorization.at>=approval.expiresAt||nativeRow.at>=approval.expiresAt)fail('durable native authorization or prepared binding changed');
 const fields=[...Object.entries(nativePlan.fields),...Object.entries(nativePlan.selects),['selected_dates',nativePlan.selectedDates.join(',')]];
 for(const [name,value]of fields){
  const matches=prepared.form.filter(tuple=>tuple[0]===name);
  const normalize=value=>/^(adult|child|infant)_(base|fuel)_price$/.test(name)?value.replaceAll(',',''):/^(depart|arrive)-\d+-moving_time$/.test(name)&&/^\d{2}:\d{2}$/.test(value)?value.replace(':',''):value;
  if(matches.length!==1||normalize(matches[0][1])!==normalize(value))fail('durable native form differs from the approved season');
 }
 const ids=prepared.form.filter(([name])=>name==='id'),products=prepared.form.filter(([name])=>name==='product_id');
 if(!ids.length||ids.some(([,value])=>value!=='')||!products.length||products.some(([,value])=>value!==target.productId)||prepared.form.some(([name])=>name==='csrfmiddlewaretoken'))fail('durable native create target changed');
 const expectedNative={phase:'season',target:clone(pinned.targets),approvalBinding:clone(plan.approvalBinding),approvalClaim:adapterClaim,kind:'season-write-authorized',binding,approval:{status:'approved',bindingDigest:binding.digest,approvalId:claim.id},bindingDigest:binding.digest};
 if(!same(nativeRow.event,expectedNative))fail('native durable authorization changed');
 const failure='page.evaluate: Error: saved native select lacks data-init-id: depart-1-airline';
 if(take('recovery-failed').message!==failure||!same(take('needs-reconciliation').result,{status:'needs-reconciliation',message:failure}))fail('historical verification failure is not the supported pending outcome');
 if(claimRow.reservation!==prior.retryReservationPath)fail('historical claim does not use the canonical child reservation');
 await canonical(prior.retryReservationPath);const bytes=await readFile(prior.retryReservationPath),reserved=JSON.parse(bytes);
 if(!same(reserved,{kind:'product-only-season-zero-write-resumption',baseFailedRun:pinned.fingerprint.failed.directory,failedRecovery:prior.dir,consumedReservation:prior.reservation,priorClaim:prior.claim,dataDir:directory,claim,at:reserved.at})||!Number.isSafeInteger(reserved.at)||reserved.at<claim.claimedAt||reserved.at>claimRow.at)fail('consumed child reservation changed');
 const reservation={path:prior.retryReservationPath,sha256:hash(bytes)},fingerprint={original:clone(pinned.fingerprint),unforwardedRecovery:priorProof,pendingRecovery:{directory,manifest},reservation};
 return {dir:directory,manifest,plan:clone(plan),approval:clone(approval),claim:clone(claim),prepared:clone(prepared),reservation,fingerprint};
}
