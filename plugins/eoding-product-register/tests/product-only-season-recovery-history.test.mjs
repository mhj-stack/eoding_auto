import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { digest } from '../src/core.mjs';
import { createProductOnlyApprovalBinding } from '../src/product-only-execution.mjs';
import { verifySeasonRecoveryLineage } from '../src/product-only-season-recovery-history.mjs';

const clone=structuredClone, json=value=>JSON.stringify(value)+'\n';
const hash=value=>createHash('sha256').update(value).digest('hex');
async function tree(dir){return Promise.all((await readdir(dir)).sort().map(async name=>({name,sha256:hash(await readFile(path.join(dir,name)))})));}

async function fixture(t, full=true){
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'season-lineage-')));
 t.after(()=>rm(root,{recursive:true,force:true,maxRetries:3}));
 const originalJournal=path.join(root,'original-journal');await mkdir(originalJournal);
 const originalPlan={target:{mode:'NEW'},companyId:'7',identity:{accountName:'Fixture Account',accountKey:'fixture-account',sessionKey:'initial-fixture-session'},
  product:{company:{tenant:'Fixture Tenant'},title:'Fictional source',itinerary:[]},source:{images:[],rows:[]},display:{images:[]},itinerary:[],season:{},seasonMode:'included'};
 originalPlan.approvalBinding=createProductOnlyApprovalBinding(originalPlan);
 const originalManifest={plan:{path:path.join(root,'original-plan.json'),sha256:hash(json(originalPlan))},journal:[],runtime:[]};
 const target={productId:123,masterCode:'FIXTURE123'},runs=[];
 const base=(recovery,prior)=>path.join(root,'.continuation-reservations',(prior?digest({original:originalPlan.approvalBinding.planDigest,recovery:recovery.manifest,priorFailure:prior.reservation}):recovery?digest({original:originalPlan.approvalBinding.planDigest,recovery:recovery.manifest}):originalPlan.approvalBinding.planDigest)+'.json');
 const resumed=(source,type)=>path.join(path.dirname(source.reservation.path),type,digest({reservation:source.reservation.path,claim:source.claim.id,scopeDigest:source.claim.scopeDigest})+'.json');
 async function run(name,{recovery,prior,zero,upload}={}){
  const dir=path.join(root,name);await mkdir(dir);
  const plan=clone(originalPlan);plan.identity.sessionKey=name+'-fixture-session';
  plan.continuation={target,original:{approvalBinding:originalPlan.approvalBinding,manifest:originalManifest}};
  plan.approvalBinding=createProductOnlyApprovalBinding(plan);
  const reservation=upload?resumed(upload,'.verified-upload-resumptions'):zero?resumed(zero,'.zero-write-resumptions'):base(recovery,prior);
  await mkdir(path.dirname(reservation),{recursive:true});
  const events=[];let at=1000+runs.length*100;
  const add=(kind,data={})=>{const row={kind,at:at++,...clone(data)};events.push(row);return row;};
  add('continuation-start',{manifest:originalManifest});add('original-evidence-verified',{target});add('session-renewal-review',{plan});
  if(recovery)add('detail-recovery-verified',{recovery});if(prior)add('prior-failure-verified',{priorFailure:prior});if(zero)add('unforwarded-failure-verified',{source:zero});if(upload)add('verified-upload-failure-verified',{source:upload});
  const scopeDigest=digest({kind:'product-only-continuation-review-v1',target,manifest:originalManifest,
   ...(recovery?{recovery:{directory:recovery.dir,manifest:recovery.manifest,detail:recovery.detail}}:{}),...(prior?{priorFailure:prior}:{}),...(zero?{unforwardedFailure:zero}:{}),...(upload?{verifiedUploadFailure:upload}:{}),phases:['media','shell','day','season','finalCheck'],renewalBinding:plan.approvalBinding});
  const approval={status:'approved',method:'localhost-human-form',tenantObserved:plan.product.company.tenant,accountObserved:plan.identity.accountName,planDigest:plan.approvalBinding.planDigest,scopeDigest,approvedAt:at,expiresAt:at+900000};add('human-approval',{approval});
  const claim={id:'product-only:'+plan.approvalBinding.planDigest,target:{mode:'NEW'},planDigest:plan.approvalBinding.planDigest,scopeDigest,claimedAt:at};const claimRow=add('approval-claim',{claim,reservation});
  const source=upload??zero;
  await writeFile(reservation,json({kind:upload?'product-only-verified-upload-resumption':zero?'product-only-zero-write-resumption':'product-only-continuation-reservation',originalJournal,
   ...(source?{consumedReservation:source.reservation,failedRun:source.dir,approval:source.approval,claim:source.claim}:{}),dataDir:dir,at:claimRow.at}));
  add('continuation-closed');
  await Promise.all([writeFile(path.join(dir,'continuation-plan.json'),json(plan)),writeFile(path.join(dir,'original-manifest.json'),json(originalManifest)),writeFile(path.join(dir,'continuation.jsonl'),events.map(json).join(''))]);
  const result={dir,events,claimRow,source:{dir,manifest:await tree(dir),reservation:{path:reservation,sha256:hash(await readFile(reservation))},plan,approval,claim}};runs.push(result);return result;
 }
 let current;
 if(full){
  const one=await run('01'),recovery={dir:one.dir,manifest:one.source.manifest,detail:{include:[]}};
  const two=await run('02',{recovery}),prior={dir:two.dir,manifest:two.source.manifest,reservation:two.source.reservation.path,reservations:[one.source.reservation,two.source.reservation]};
  const three=await run('03',{recovery,prior}),zero=three.source;
  const five=await run('05',{recovery,prior,zero}),upload=five.source;
  current=await run('06',{recovery,prior,zero,upload});
 }else current=await run('simple-failure');
 return {root,runs,current,options:{events:current.events,claimRow:current.claimRow,originalPlan,originalManifest,originalJournal,failedDir:current.dir}};
}

test('file-only lineage pins all four predecessors and five canonical consumed reservations without changing bytes',async t=>{
 const f=await fixture(t),before=await Promise.all(f.runs.map(row=>tree(row.dir)));
 const result=await verifySeasonRecoveryLineage(f.options);
 assert.equal(result.fingerprint.runs.length,4);assert.equal(result.fingerprint.reservations.length,5);
 assert.equal(result.reservationPath,f.current.source.reservation.path);
 assert.deepEqual(await Promise.all(f.runs.map(row=>tree(row.dir))),before);
});

test('simple original-to-failed continuation uses the original plan reservation slot',async t=>{
 const f=await fixture(t,false),result=await verifySeasonRecoveryLineage(f.options);
 assert.equal(result.fingerprint.runs.length,0);assert.equal(result.fingerprint.reservations.length,1);
 assert.equal(path.basename(result.reservationPath),f.options.originalPlan.approvalBinding.planDigest+'.json');
});

for(const index of [0,1,2,3])test(`modified predecessor ${['01','02','03','05'][index]} is rejected even when the current failed journal is unchanged`,async t=>{
 const f=await fixture(t);const currentBefore=await tree(f.current.dir);
 await writeFile(path.join(f.runs[index].dir,'continuation.jsonl'),'changed history\n');
 await assert.rejects(verifySeasonRecoveryLineage(f.options),/historical manifest changed/);
 assert.deepEqual(await tree(f.current.dir),currentBefore);
});

test('copying the current consumed reservation and changing only its journal pointer cannot obtain a new retry slot',async t=>{
 const f=await fixture(t),copy=path.join(f.root,'copied-consumed.json');
 await writeFile(copy,await readFile(f.current.source.reservation.path));f.current.claimRow.reservation=copy;
 await assert.rejects(verifySeasonRecoveryLineage(f.options),/canonical one-use slot/);
});

test('unchanged predecessor files with a changed consumed reservation are rejected',async t=>{
 const f=await fixture(t),file=f.runs[2].source.reservation.path,value=JSON.parse(await readFile(file,'utf8'));
 value.at++;await writeFile(file,json(value));
 await assert.rejects(verifySeasonRecoveryLineage(f.options),/reservation contents changed|snapshot differs/);
});
