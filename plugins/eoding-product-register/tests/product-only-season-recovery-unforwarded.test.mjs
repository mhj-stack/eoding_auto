import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { digest } from '../src/core.mjs';
import { createProductOnlyApprovalBinding } from '../src/product-only-execution.mjs';
import { verifyUnforwardedSeasonRecovery } from '../src/product-only-season-recovery-unforwarded.mjs';

const clone=structuredClone,json=value=>JSON.stringify(value)+'\n';
async function fixture(t,{closed=true}={}){
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'unforwarded-season-')));t.after(()=>rm(root,{recursive:true,force:true,maxRetries:3}));
 const directory=path.join(root,'failed-recovery');await mkdir(directory);
 const source={target:{mode:'NEW'},companyId:'7',identity:{accountName:'Fixture Operator',accountKey:'fixture-account',sessionKey:'old-fixture-session'},product:{company:{tenant:'Fixture Tenant'}},source:{images:[],rows:[]},display:{images:[]},itinerary:[],season:{selectedDates:['2027-01-10']}};
 source.approvalBinding=createProductOnlyApprovalBinding(source);
 const target={mode:'NEW',productId:123,masterCode:'F123',scheduleId:456};
 const media={target:{productId:'123',masterCode:'F123'},persisted:{payloads:{display:{description:'Approved fixture'}},images:[]}};
 const pinned={plan:source,targets:target,checkpoint:{media},fingerprint:{failed:{directory:path.join(root,'saved-product-run'),files:[]},reservation:{path:path.join(root,'prior-consumed.json'),sha256:'a'.repeat(64)}},claim:{id:'prior-saved-product-claim',scopeDigest:'b'.repeat(64)}};
 const plan=clone(source);plan.identity.sessionKey='failed-review-session';plan.seasonRecovery={kind:'product-only-season-recovery-v1',target,fingerprint:pinned.fingerprint,allowPastDepartureTest:false};plan.approvalBinding=createProductOnlyApprovalBinding(plan);
 const scopeDigest=digest({kind:'product-only-season-recovery-review-v1',target,remaining:['season'],fingerprint:pinned.fingerprint,approvalBinding:plan.approvalBinding});
 const approval={status:'approved',version:1,method:'localhost-human-form',tenantObserved:source.product.company.tenant,accountObserved:source.identity.accountName,planDigest:plan.approvalBinding.planDigest,scopeDigest,approvedAt:1003,expiresAt:2000};
 const claim={id:'product-only:'+plan.approvalBinding.planDigest,target:{mode:'NEW'},planDigest:plan.approvalBinding.planDigest,scopeDigest,claimedAt:1005};
 const reservation=path.join(root,'.season-resumptions',digest({reservation:pinned.fingerprint.reservation.path,claim:pinned.claim.id,scope:pinned.claim.scopeDigest})+'.json');await mkdir(path.dirname(reservation));
 const record={kind:'product-only-season-resumption',failedRun:pinned.fingerprint.failed.directory,consumedReservation:pinned.fingerprint.reservation,dataDir:directory,claim,at:1005};await writeFile(reservation,json(record));
 const proof={status:'season-recovery-preflight-verified',target,seasons:0,forwardedWrites:0,saved:{status:'saved-stages-reconciled',media:{status:'native-content-reverified',...media,forwarded:0},basicSchedule:{status:'saved-basic-schedule-reconciled'}}};
 const message='Unexpected write blocked during season product transition';
 const events=[{kind:'season-recovery-start',at:1001,fingerprint:pinned.fingerprint},{kind:'preflight-verified',at:1002,proof:clone(proof)},{kind:'review-approval',at:1003,approval},
  {kind:'preflight-verified',at:1004,proof:clone(proof)},{kind:'approval-claim',at:1005,claim,reservation},{kind:'adapter-claim-binding',at:1006,reviewClaim:clone(claim),adapterClaim:{...clone(claim),scopeDigest:plan.approvalBinding.scopeDigest}},
  {kind:'before-write',at:1007,phase:'season',targets:target},{kind:'recovery-failed',at:1008,message},{kind:'needs-reconciliation',at:1009,result:{status:'needs-reconciliation',message}}];
 if(closed)events.push({kind:'recovery-closed',at:1010});
 const rewrite=async()=>{await writeFile(path.join(directory,'recovery.jsonl'),events.map(json).join(''));await writeFile(path.join(directory,'recovery-plan.json'),json(plan));};
 await writeFile(path.join(directory,'original-manifest.json'),json(pinned.fingerprint));await rewrite();
 return {root,directory,pinned,plan,events,reservation,record,rewrite,args:{directory,pinned}};
}

for(const closed of [true,false])test(`claimed zero-write failure ${closed?'with':'without'} normal close pins the original approval and returns a separate deterministic slot`,async t=>{
 const f=await fixture(t,{closed}),before=await readFile(f.reservation);
 const result=await verifyUnforwardedSeasonRecovery(f.args);
 assert.deepEqual(result.claim,f.events.find(row=>row.kind==='approval-claim').claim);
 assert.equal(result.approval.expiresAt,2000);
 assert.equal(result.adapterClaim.scopeDigest,f.plan.approvalBinding.scopeDigest);
 assert.notEqual(result.claim.scopeDigest,result.adapterClaim.scopeDigest);
 assert.equal(path.dirname(result.retryReservationPath),path.join(path.dirname(f.reservation),'.zero-write-resumptions'));
 assert.deepEqual(await readFile(f.reservation),before);
 assert.deepEqual(await verifyUnforwardedSeasonRecovery(f.args),result);
});

for(const kind of ['write-authorized','adapter-evidence','receipt-verified','completed'])test(`any ${kind} after the season boundary makes replay inadmissible`,async t=>{
 const f=await fixture(t);f.events.splice(7,0,{kind,at:1007,event:{phase:'season'}});await f.rewrite();
 await assert.rejects(verifyUnforwardedSeasonRecovery(f.args),/before any write authorization or attempt/);
});

test('a copied base reservation with only a changed claim pointer cannot create a different retry slot',async t=>{
 const f=await fixture(t),copy=path.join(f.root,'copied-reservation.json');await writeFile(copy,await readFile(f.reservation));
 f.events.find(row=>row.kind==='approval-claim').reservation=copy;await f.rewrite();
 await assert.rejects(verifyUnforwardedSeasonRecovery(f.args),/canonical consumed base slot/);
});

test('claimed scope and adapter scope must be the exact recorded season-only translation',async t=>{
 const f=await fixture(t);f.events.find(row=>row.kind==='adapter-claim-binding').adapterClaim.scopeDigest='c'.repeat(64);await f.rewrite();
 await assert.rejects(verifyUnforwardedSeasonRecovery(f.args),/adapter claim translation/);
});

test('a preflight with forwarded writes or changed persisted content cannot prove zero-write recovery',async t=>{
 const f=await fixture(t);f.events[3].proof.forwardedWrites=1;await f.rewrite();
 await assert.rejects(verifyUnforwardedSeasonRecovery(f.args),/read-only reconciliation/);
 f.events[3].proof.forwardedWrites=0;f.events[3].proof.saved.media.persisted.payloads.display.description='changed';await f.rewrite();
 await assert.rejects(verifyUnforwardedSeasonRecovery(f.args),/read-only reconciliation/);
});

test('a nested retry or mismatched terminal failure is rejected without modifying the consumed slot',async t=>{
 const f=await fixture(t);f.plan.seasonRecovery.unforwardedRecovery={directory:'another-failed-run'};f.plan.approvalBinding=createProductOnlyApprovalBinding(f.plan);await f.rewrite();
 await assert.rejects(verifyUnforwardedSeasonRecovery(f.args),/nested retries/);
 delete f.plan.seasonRecovery.unforwardedRecovery;f.plan.approvalBinding=createProductOnlyApprovalBinding(f.plan);f.events.find(row=>row.kind==='needs-reconciliation').result.message='different failure';await f.rewrite();
 await assert.rejects(verifyUnforwardedSeasonRecovery(f.args),/terminal zero-write failure/);
 assert.deepEqual(JSON.parse(await readFile(f.reservation)),f.record);
});

test('matching unknown-outcome messages never qualify as the supported blocked transition',async t=>{
 const f=await fixture(t);f.events.find(row=>row.kind==='recovery-failed').message='UNKNOWN_SAVE_OUTCOME';f.events.find(row=>row.kind==='needs-reconciliation').result.message='UNKNOWN_SAVE_OUTCOME';await f.rewrite();
 await assert.rejects(verifyUnforwardedSeasonRecovery(f.args),/supported blocked transition/);
});
