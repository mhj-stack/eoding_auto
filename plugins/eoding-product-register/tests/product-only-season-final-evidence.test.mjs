import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { digest } from '../src/core.mjs';
import { createProductOnlyApprovalBinding } from '../src/product-only-execution.mjs';
import { verifyUnforwardedSeasonRecovery } from '../src/product-only-season-recovery-unforwarded.mjs';
import { verifySavedSeasonRecovery } from '../src/product-only-season-final-evidence.mjs';

const clone=structuredClone,json=value=>JSON.stringify(value)+'\n';
async function fixture(t){
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'season-final-evidence-')));t.after(()=>rm(root,{recursive:true,force:true,maxRetries:3}));
 const oldDir=path.join(root,'08'),directory=path.join(root,'09');await mkdir(oldDir);await mkdir(directory);
 const source={target:{mode:'NEW'},companyId:'7',identity:{accountName:'Fixture Operator',accountKey:'fixture-account',sessionKey:'source-fixture-session'},product:{company:{tenant:'Fixture Tenant'}},source:{images:[],rows:[]},display:{images:[]},itinerary:[],season:{fields:{adult_base_price:'123','depart-0-moving_time':'01:50'},selects:{departport:'1'},selectedDates:['2027-01-10']}};
 source.approvalBinding=createProductOnlyApprovalBinding(source);
 const target={mode:'NEW',productId:123,masterCode:'F123',scheduleId:456},media={target:{productId:'123',masterCode:'F123'},persisted:{payloads:{display:{description:'Approved'}},images:[]}};
 const pinned={plan:source,targets:target,checkpoint:{media},fingerprint:{failed:{directory:path.join(root,'06'),files:[]},reservation:{path:path.join(root,'consumed06.json'),sha256:'a'.repeat(64)}},claim:{id:'source-claim',scopeDigest:'b'.repeat(64)}};
 const proof={status:'season-recovery-preflight-verified',target,seasons:0,forwardedWrites:0,saved:{status:'saved-stages-reconciled',media:{status:'native-content-reverified',...media,forwarded:0},basicSchedule:{status:'saved-basic-schedule-reconciled'}}};
 function planFor(session,priorProof){const p=clone(source);p.identity.sessionKey=session;p.seasonRecovery={kind:'product-only-season-recovery-v1',target,fingerprint:pinned.fingerprint,allowPastDepartureTest:false,...(priorProof?{unforwardedRecovery:priorProof}:{})};p.approvalBinding=createProductOnlyApprovalBinding(p);return p;}
 function approvalFor(plan,at,priorProof){return {status:'approved',version:1,method:'localhost-human-form',tenantObserved:source.product.company.tenant,accountObserved:source.identity.accountName,planDigest:plan.approvalBinding.planDigest,scopeDigest:digest({kind:'product-only-season-recovery-review-v1',target,remaining:['season'],fingerprint:pinned.fingerprint,approvalBinding:plan.approvalBinding,...(priorProof?{unforwardedRecovery:priorProof}:{})}),approvedAt:at,expiresAt:2000};}
 const claimFor=(plan,approval,at)=>({id:'product-only:'+plan.approvalBinding.planDigest,target:{mode:'NEW'},planDigest:plan.approvalBinding.planDigest,scopeDigest:approval.scopeDigest,claimedAt:at});
 const oldPlan=planFor('old-review-session'),oldApproval=approvalFor(oldPlan,1003),oldClaim=claimFor(oldPlan,oldApproval,1005);
 const base=path.join(root,'.season-resumptions',digest({reservation:pinned.fingerprint.reservation.path,claim:pinned.claim.id,scope:pinned.claim.scopeDigest})+'.json');await mkdir(path.dirname(base));
 await writeFile(base,json({kind:'product-only-season-resumption',failedRun:pinned.fingerprint.failed.directory,consumedReservation:pinned.fingerprint.reservation,dataDir:oldDir,claim:oldClaim,at:1005}));
 const oldError='Unexpected write blocked during season product transition';
 const oldEvents=[{kind:'season-recovery-start',at:1001,fingerprint:pinned.fingerprint},{kind:'preflight-verified',at:1002,proof},{kind:'review-approval',at:1003,approval:oldApproval},{kind:'preflight-verified',at:1004,proof},
  {kind:'approval-claim',at:1005,claim:oldClaim,reservation:base},{kind:'adapter-claim-binding',at:1006,reviewClaim:oldClaim,adapterClaim:{...oldClaim,scopeDigest:oldPlan.approvalBinding.scopeDigest}},{kind:'before-write',at:1007,phase:'season',targets:target},
  {kind:'recovery-failed',at:1008,message:oldError},{kind:'needs-reconciliation',at:1009,result:{status:'needs-reconciliation',message:oldError}},{kind:'recovery-closed',at:1010}];
 await Promise.all([writeFile(path.join(oldDir,'original-manifest.json'),json(pinned.fingerprint)),writeFile(path.join(oldDir,'recovery-plan.json'),json(oldPlan)),writeFile(path.join(oldDir,'recovery.jsonl'),oldEvents.map(json).join(''))]);
 const prior=await verifyUnforwardedSeasonRecovery({directory:oldDir,pinned}),priorProof={directory:prior.dir,manifest:prior.manifest,approvalBinding:prior.plan.approvalBinding,claim:prior.claim,reservation:prior.reservation};
 const plan=planFor('new-review-session',priorProof),approval=approvalFor(plan,1103,priorProof),claim=claimFor(plan,approval,1105),adapterClaim={...claim,scopeDigest:plan.approvalBinding.scopeDigest};
 const nativePlan={fields:clone(plan.season.fields),selects:clone(plan.season.selects),selectLabels:{},selectQueries:{},selectedDates:clone(plan.season.selectedDates)},form=[['product_id','123'],['id',''],['adult_base_price','123'],['depart-0-moving_time','0150'],['departport','1'],['selected_dates','2027-01-10']];
 const binding={version:1,phase:'season',target:{productId:'123'},origin:'https://basecamp.team',identityDigest:digest({identityDigest:digest(plan.identity)}),planDigest:digest(nativePlan),formDigest:digest(form),baselineSeasonIds:[]};binding.digest=digest(binding);
 const prepared={kind:'season-prepared-v1',target:binding.target,origin:binding.origin,plan:nativePlan,selectedDates:nativePlan.selectedDates,form,identityDigest:binding.identityDigest,planDigest:binding.planDigest,formDigest:binding.formDigest,baselineSeasonIds:[],binding,state:'prepared'};
 const envelope={phase:'season',target,approvalBinding:plan.approvalBinding,approvalClaim:adapterClaim,binding,bindingDigest:binding.digest};
 const error='page.evaluate: Error: saved native select lacks data-init-id: depart-1-airline';
 const events=[{kind:'season-recovery-start',at:1101,fingerprint:pinned.fingerprint,unforwardedRecovery:priorProof},{kind:'preflight-verified',at:1102,proof},{kind:'review-approval',at:1103,approval},{kind:'preflight-verified',at:1104,proof},
  {kind:'approval-claim',at:1105,claim,reservation:prior.retryReservationPath},{kind:'adapter-claim-binding',at:1106,reviewClaim:claim,adapterClaim},{kind:'before-write',at:1107,phase:'season',targets:target},
  {kind:'write-authorized',at:1108,event:{...clone(envelope),prepared}},{kind:'adapter-evidence',at:1109,event:{...clone(envelope),kind:'season-write-authorized',approval:{status:'approved',bindingDigest:binding.digest,approvalId:claim.id}}},
  {kind:'recovery-failed',at:1110,message:error},{kind:'needs-reconciliation',at:1111,result:{status:'needs-reconciliation',message:error}},{kind:'recovery-closed',at:1112}];
 const reservation=prior.retryReservationPath;await mkdir(path.dirname(reservation));await writeFile(reservation,json({kind:'product-only-season-zero-write-resumption',baseFailedRun:pinned.fingerprint.failed.directory,failedRecovery:prior.dir,consumedReservation:prior.reservation,priorClaim:prior.claim,dataDir:directory,claim,at:1105}));
 const rewrite=()=>writeFile(path.join(directory,'recovery.jsonl'),events.map(json).join(''));
 await Promise.all([writeFile(path.join(directory,'original-manifest.json'),json(pinned.fingerprint)),writeFile(path.join(directory,'recovery-plan.json'),json(plan)),rewrite()]);
 return {root,directory,oldDir,pinned,plan,events,prepared,reservation,rewrite,args:{directory,pinned,unforwardedRecoveryDir:oldDir}};
}

test('pending authorized save remains readable after expiry and returns its exact prepared evidence without inventing a receipt',async t=>{
 const f=await fixture(t),before=await readFile(f.reservation),value=await verifySavedSeasonRecovery(f.args);
 assert.deepEqual(value.prepared,f.prepared);assert.ok(value.approval.expiresAt<Date.now());assert.equal(Object.hasOwn(value,'receipt'),false);
 assert.equal(value.prepared.plan.fields['depart-0-moving_time'],'01:50');assert.equal(value.prepared.form.find(([name])=>name==='depart-0-moving_time')[1],'0150');
 assert.deepEqual(await readFile(f.reservation),before);
});

test('an inserted historical receipt cannot be mistaken for independently verified success',async t=>{
 const f=await fixture(t);f.events.splice(9,0,{kind:'receipt-verified',at:1109,phase:'season',receipt:{seasonId:'999'}});await f.rewrite();
 await assert.rejects(verifySavedSeasonRecovery(f.args),/no historical success receipt/);
});

test('changed prepared form, approval deadline or native authorization each fail file audit',async t=>{
 const f=await fixture(t);f.prepared.form[2][1]='999';await f.rewrite();await assert.rejects(verifySavedSeasonRecovery(f.args),/prepared binding changed/);
 f.prepared.form[2][1]='123';f.events[2].approval.expiresAt=1108;await f.rewrite();await assert.rejects(verifySavedSeasonRecovery(f.args),/prepared binding changed/);
 f.events[2].approval.expiresAt=2000;f.events[8].event.approval.approvalId='unrelated';await f.rewrite();await assert.rejects(verifySavedSeasonRecovery(f.args),/native durable authorization/);
});

test('copying a child reservation and changing the pointer cannot bypass its canonical consumed slot',async t=>{
 const f=await fixture(t),copy=path.join(f.root,'copied-child.json');await writeFile(copy,await readFile(f.reservation));f.events[4].reservation=copy;await f.rewrite();
 await assert.rejects(verifySavedSeasonRecovery(f.args),/canonical child reservation/);
});

test('only the original parser failure qualifies and predecessor mutations remain visible',async t=>{
 const f=await fixture(t);f.events[9].message='Different unknown result';f.events[10].result.message='Different unknown result';await f.rewrite();
 await assert.rejects(verifySavedSeasonRecovery(f.args),/supported pending outcome/);
 await writeFile(path.join(f.oldDir,'foreign.txt'),'mutation');await assert.rejects(verifySavedSeasonRecovery(f.args),/unexpected failed recovery evidence/);
});
