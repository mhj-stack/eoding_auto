import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,readdir,realpath,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {chromium} from 'playwright';
import {digest} from '../src/core.mjs';
import {createProductOnlyAdapters} from '../src/product-only-adapters.mjs';
import {createProductOnlyApprovalBinding} from '../src/product-only-execution.mjs';
import {verifyProductOnlyContinuationEvidence} from '../src/product-only-continuation.mjs';
import {startProductOnlySeasonRecovery,verifySeasonRecoveryEvidence} from '../src/product-only-season-recovery.mjs';
import {verifyUnforwardedSeasonRecovery} from '../src/product-only-season-recovery-unforwarded.mjs';
import {reconcileSavedProductOnlySeason} from '../src/product-only-season-final-reconciliation.mjs';
import {ScheduleSessionBrowser} from '../src/schedule-session.mjs';
import {contentControls,installProductOnlyFixture,addUrl,pageUrl,png,pngHash,tenant} from './fixtures/product-only-page.mjs';

const identity={accountName:'Fixture Operator',accountKey:'fixture-account',sessionKey:'fixture-session'};
const product=JSON.parse(await readFile(new URL('../examples/product.json',import.meta.url),'utf8'));
const json=value=>JSON.stringify(value)+'\n',clone=structuredClone;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const verifier=async({receipt,source})=>({tenantId:tenant.companyId,src:receipt.src,sha256:source.sha256});

function plan(imagePath){
 const normalized=clone(product);normalized.company.tenant=tenant.companyId;normalized.departures[0].prices[0].child={currency:'KRW',amount:80000};normalized.departures[0].prices[0].infant={currency:'KRW',amount:0};
 const value={target:{mode:'NEW'},product:normalized,identity:clone(identity),companyId:tenant.companyId,
  source:{rows:normalized.itinerary.map(day=>({id:`row-${day.day}`})),images:[{id:'image-1',path:imagePath,name:'fixture.png',mimeType:'image/png',sha256:pngHash,alt:'fixture source image'}]},
  basic:{options:{cityLabel:'제주(CJU)',managerLabel:'가상담당자 (테스트팀)',priority:7,cutoffDays:3}},
  display:{fields:{short_description:'Fixture overview'},images:[{sourceImageId:'image-1'}],imageQuery:'fixture'},
  content:{detail:{include:[{name:'Hotel',description:'One night'}],exclude:[],information:['Fixture note'],mainPoints:['Fixture point'],shoppingCount:'0'},elements:[{type:'3',text:'Fixture heading'},{type:'1',text:'Fixture body'}]},
  shell:{title:'Fixture schedule'},itinerary:normalized.itinerary.map(day=>({...day,sourceRowId:`row-${day.day}`})),
  season:{fields:{title:'Fixture season',currency_code:'KRW',adult_base_price:'100000',child_base_price:'80000',infant_base_price:'0',adult_fuel_price:'0',child_fuel_price:'0',infant_fuel_price:'0',min_pax_count:'2',max_pax_count:'10','depart-0-depart_date':'2027-01-10','depart-0-flight_no':'F100','depart-0-depart_time':'09:00','depart-0-arrive_time': '11:00', 'depart-0-moving_time': '120','arrive-0-depart_date':'2027-01-11','arrive-0-flight_no':'F101','arrive-0-depart_time':'12:40','arrive-0-arrive_time': '16:15', 'arrive-0-moving_time': '215','outbound-0-depart_time':'09:00','return-0-arrive_time':'16:15'},
   selects:{departport:'1','depart-0-airline':'2','depart-0-depart_cd':'3','depart-0-arrive_cd':'4','arrive-0-airline':'2','arrive-0-depart_cd':'4','arrive-0-arrive_cd':'3'},
   selectLabels:{departport:'Fixture departure','depart-0-airline':'Fixture Air','depart-0-depart_cd':'ICN','depart-0-arrive_cd':'TPE','arrive-0-airline':'Fixture Air','arrive-0-depart_cd':'TPE','arrive-0-arrive_cd':'ICN'},selectedDates:['2027-01-10']}};
 value.approvalBinding=createProductOnlyApprovalBinding(value);return value;
}
async function originalEvidence(root,value,receipt){
 const journalDir=path.join(root,'original-journal'),runtimeDir=path.join(root,'original-runtime'),planDir=path.join(root,'original-plan'),planPath=path.join(planDir,'plan.json');
 await Promise.all([mkdir(journalDir),mkdir(runtimeDir),mkdir(planDir)]);await writeFile(path.join(runtimeDir,'frozen.mjs'),'export default "frozen";\n');
 const approval={status:'approved',version:1,...value.approvalBinding,tenantObserved:tenant.companyId,accountObserved:identity.accountName,approvedAt:10,expiresAt:100,method:'localhost-human-form'};
 const claim={id:`product-only:${value.approvalBinding.planDigest}`,target:{mode:'NEW'},...value.approvalBinding,claimedAt:11};
 const events=[{kind:'human-approval',approval},{kind:'approval-claim',claim},
  {kind:'coordinator-evidence',value:{status:'receipt-verified',phase:'basic',result:{name:'basic',receipt,verification:true}}},
  {kind:'coordinator-evidence',value:{status:'before-write',phase:'media',targets:{mode:'NEW',productId:receipt.productId,masterCode:receipt.masterCode}}},
  {kind:'adapter-evidence',event:{phase:'result',status:'needs-reconciliation',completed:[],uploads:[],forwarded:0,message:'Missing native CSRF'}},
  {kind:'coordinator-evidence',value:{status:'unknown-save-outcome',phase:'media',message:'Media needs-reconciliation; no automatic retry'}},
  {kind:'needs-reconciliation',result:{status:'needs-reconciliation',message:'media save outcome is unknown; reconcile before any retry'}}];
 await Promise.all([writeFile(planPath,json(value)),writeFile(path.join(journalDir,'journal.jsonl'),events.map(json).join('')),
  writeFile(path.join(journalDir,'checkpoint.json'),json({last:events.at(-1),events:events.length})),
  writeFile(path.join(journalDir,'execution.jsonl'),json({kind:'execution-start',value:{mode:'wx',lifecycle:'product-only-execution',target:{mode:'NEW'},approvalBinding:value.approvalBinding,phases:['basic','display','content','shell','day','season']}}))]);
 return {planPath,journalDir,runtimeDir};
}
async function hashes(dir){return Promise.all((await readdir(dir)).sort().map(async name=>({name,sha256:sha(await readFile(path.join(dir,name)))})));}

// All ERP-shaped requests are served by this in-memory fixture. No real ERP,
// user profile, cookies, or authentication state are read or copied.
async function fixture(t,{dayTitleInput=true}={}){
 const tempRoot=await realpath(os.tmpdir());
 const root=await realpath(await mkdtemp(path.join(tempRoot,'product-only-season-recovery-')));
 const imagePath=path.join(root,'fixture.png');await writeFile(imagePath,png);const originalPlan=plan(imagePath);
 const browsers=[];let started;t.after(async()=>{await started?.close().catch(()=>{});for(const b of browsers)await b.close().catch(()=>{});const resolved=path.resolve(root);assert.ok(resolved.startsWith(tempRoot+path.sep));await rm(resolved,{recursive:true,force:true});});
 async function open(name,persisted){
  let server;
  const browser=new ScheduleSessionBrowser({dataDir:path.join(root,name),launcher:{launchPersistentContext:async(profile,options)=>{
   const ctx=await chromium.launchPersistentContext(profile,{...options,headless:true,args:['--host-resolver-rules=MAP * ~NOTFOUND']});server=await installProductOnlyFixture(ctx,{product,dayTitleInput});
   if(persisted)for(const key of ['product','addServed','basicRecorded','schedule','days','seasons','content'])server.state[key]=clone(persisted[key]);return ctx;
  }}});browsers.push(browser);const page=await browser.ensurePage();await page.goto(persisted?pageUrl:addUrl);return {page,server,close:()=>browser.close()};
 }
 const old=await open('old-browser');
 const basicAdapters=createProductOnlyAdapters({plan:originalPlan,identity:async()=>identity,authorizeWrite:async()=>({durable:true}),record:async()=>({durable:true}),loadImage:async()=>png,verifyUploadedImage:verifier,controls:contentControls});
 const basicContext={phase:'basic',day:null,targets:{mode:'NEW'},verifiedPreviousPhases:[],approvalBinding:originalPlan.approvalBinding,approvalClaim:{id:'fixture-basic-claim',target:{mode:'NEW'},...originalPlan.approvalBinding}};
 const basic=await basicAdapters.basic.save(old.page,originalPlan,basicContext);assert.equal(await basicAdapters.basic.verifyReceipt(old.page,basic,basicContext),true);
 const original=await originalEvidence(root,originalPlan,basic),proof=await verifyProductOnlyContinuationEvidence(original),manifest=proof.manifest,target={productId:basic.productId,masterCode:basic.masterCode};
 const renewed=clone(originalPlan);renewed.identity.sessionKey='historical-renewed-session';
 renewed.continuation={kind:'product-only-session-renewal-v1',authentication:{status:'renewed',companyId:tenant.companyId,identity:clone(renewed.identity)},target,
  original:{identity:clone(identity),companyId:tenant.companyId,approvalBinding:originalPlan.approvalBinding,paths:{planReal:original.planPath,journalReal:original.journalDir,runtimeReal:original.runtimeDir},manifest,manifestDigest:digest(manifest),images:clone(originalPlan.source.images)}};
 renewed.approvalBinding=createProductOnlyApprovalBinding(renewed);
 const failedRunDir=path.join(root,'failed-season'),reservation=path.join(root,'.continuation-reservations',originalPlan.approvalBinding.planDigest+'.json');await mkdir(failedRunDir);await mkdir(path.dirname(reservation));
 let at=Date.now()-10000;const events=[],add=(kind,fields={})=>{const row={kind,at,...clone(fields)};at+=10;events.push(row);return row;};
 add('continuation-start',{manifest});add('original-evidence-verified',{target});add('session-renewal-review',{plan:renewed});
 const scopeDigest=digest({kind:'product-only-continuation-review-v1',target,manifest,phases:['media','shell','day','season','finalCheck'],renewalBinding:renewed.approvalBinding});
 const approval={status:'approved',version:1,scopeDigest,planDigest:renewed.approvalBinding.planDigest,tenantObserved:tenant.companyId,accountObserved:identity.accountName,approvedAt:at,expiresAt:at+900000,method:'localhost-human-form'};add('human-approval',{approval});
 const claim={id:`product-only:${renewed.approvalBinding.planDigest}`,target:{mode:'NEW'},planDigest:renewed.approvalBinding.planDigest,scopeDigest,claimedAt:at-1},claimRow=add('approval-claim',{claim,reservation});
 await writeFile(reservation,json({kind:'product-only-continuation-reservation',originalJournal:original.journalDir,dataDir:failedRunDir,at:claimRow.at}));
 const saved=createProductOnlyAdapters({plan:renewed,identity:async()=>renewed.identity,seedBasicReceipt:basic,controls:contentControls,loadImage:async()=>png,verifyUploadedImage:verifier,
  authorizeWrite:async event=>{add('write-authorized',{event});return {durable:true,status:'approved',bindingDigest:event.bindingDigest,approvalId:claim.id};},
  record:async event=>{add('adapter-evidence',{event});return {durable:true,bindingDigest:event.bindingDigest??event.binding?.digest,evidenceId:'fixture-evidence'};}});
 const results=[{name:'basic',receipt:basic,verification:true}],targets={mode:'NEW',...target};
 for(const name of ['media','shell',...renewed.itinerary.map(day=>`day:${day.day}`)]){
  const phase=name.startsWith('day:')?'day':name,day=phase==='day'?renewed.itinerary[Number(name.split(':')[1])-1]:null;
  const context={phase,day,targets:clone(targets),verifiedPreviousPhases:clone(results),approvalBinding:renewed.approvalBinding,approvalClaim:{...claim,scopeDigest:renewed.approvalBinding.scopeDigest}};
  add('before-write',{phase:name,targets});const receipt=await saved[phase].save(old.page,{...clone(renewed),target:clone(targets)},context);
  assert.equal(await saved[phase].verifyReceipt(old.page,receipt,context),true);add('receipt-verified',{phase:name,receipt});results.push({name,receipt,verification:true});if(name==='shell')targets.scheduleId=receipt.scheduleId;
 }
 add('before-write',{phase:'season',targets});add('needs-reconciliation',{result:{status:'needs-reconciliation',message:'Fixture season stopped before first authorization'}});add('continuation-closed');
 const rewrite=()=>writeFile(path.join(failedRunDir,'continuation.jsonl'),events.map(json).join(''));
 await Promise.all([writeFile(path.join(failedRunDir,'continuation-plan.json'),json(renewed)),writeFile(path.join(failedRunDir,'original-manifest.json'),json(manifest)),rewrite()]);
 const state=clone(old.server.state);await old.close();const fresh=await open('fresh-browser',state);
 let currentIdentity={...renewed.identity,sessionKey:'fresh-season-session'};
 const options={...original,failedRunDir,failedPage:old.page,dataDir:path.join(root,'season-recovery'),browser:{open:async()=>({page:fresh.page,close:fresh.close})},identityReader:async()=>currentIdentity,controls:contentControls,verifyUploadedImage:verifier};
 return {root,original,failedRunDir,events,rewrite,fresh,options,targets,open,setIdentity:value=>{currentIdentity=value;},start:async overrides=>(started=await startProductOnlySeasonRecovery({...options,...overrides}))};
}
async function approve(t,active,{scope}={}){
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage();await page.goto(active.url);
 assert.equal(await page.locator('input[name="scope"]').inputValue(),'season');assert.equal(await page.locator('input[name="scope_hash"]').inputValue(),active.reviewBinding.scopeDigest);
 if(scope)await page.locator('input[name="scope"]').evaluate((node,value)=>{node.value=value;},scope);
 await page.locator('[name="company"]').fill(tenant.companyId);await page.locator('[name="account"]').fill(identity.accountName);await page.locator('button[type="submit"]').click();return page;
}

test('fresh season-only review verifies persisted stages and forwards exactly one season through final readback',{timeout:120000},async t=>{
 const f=await fixture(t),before=await hashes(f.failedRunDir),active=await f.start();
 assert.equal(active.preflight.status,'season-recovery-preflight-verified');assert.deepEqual(active.reviewBinding.scope,['season']);assert.deepEqual(active.reviewBinding.target,f.targets);assert.deepEqual(f.fresh.server.writes,[]);
 await assert.rejects(active.execute(),/fresh review form/);await approve(t,active);const result=await active.completed;
 assert.equal(result.status,'continued',JSON.stringify(result));assert.equal(result.finalCheck.status,'verified');assert.deepEqual(f.fresh.server.writes.map(row=>row.kind),['season']);assert.deepEqual(await hashes(f.failedRunDir),before);
 const journal=(await readFile(path.join(f.root,'season-recovery/recovery.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(journal.filter(row=>row.kind==='preflight-verified').length,2);assert.equal(journal.filter(row=>row.kind==='write-authorized').length,1);assert.equal(journal.find(row=>row.kind==='approval-claim').claim.scopeDigest,active.reviewBinding.scopeDigest);
 assert.notEqual(journal.find(row=>row.kind==='adapter-claim-binding').adapterClaim.scopeDigest,active.reviewBinding.scopeDigest);
});

test('saved content drift blocks recovery before approval and before a write',{timeout:90000},async t=>{
 const f=await fixture(t);f.fresh.server.state.content.display.short_description='Changed outside approved plan';
 await assert.rejects(f.start(),/differ|changed|match/i);assert.deepEqual(f.fresh.server.writes,[]);
});

test('failed-run file mutation after review prevents the fresh claim and all writes',{timeout:120000},async t=>{
 const f=await fixture(t),active=await f.start();await writeFile(path.join(f.failedRunDir,'foreign-note.txt'),'changed evidence');
 await approve(t,active);assert.equal((await active.completed).status,'needs-reconciliation');assert.deepEqual(f.fresh.server.writes,[]);
 const journal=await readFile(path.join(f.root,'season-recovery/recovery.jsonl'),'utf8');assert.doesNotMatch(journal,/"kind":"approval-claim"|"kind":"write-authorized"/);
});

test('broadened form scope is refused without a season write',{timeout:120000},async t=>{
 const f=await fixture(t),active=await f.start(),page=await approve(t,active,{scope:'basic,display,content,shell,days,season'});
 assert.match(await page.textContent('body'),/only the remaining season/);assert.deepEqual(f.fresh.server.writes,[]);
});

test('ambiguous season authorization and incomplete saved-day evidence are rejected by file audit',{timeout:90000},async t=>{
 const f=await fixture(t);await verifySeasonRecoveryEvidence(f.options);
 const baseline=clone(f.events);f.events.splice(-1,0,{kind:'write-authorized',at:f.events.at(-1).at,event:{phase:'season'}});await f.rewrite();await assert.rejects(verifySeasonRecoveryEvidence(f.options),/first authorization|ambiguous/);
 f.events.splice(0,f.events.length,...baseline.filter(row=>!(row.kind==='receipt-verified'&&row.phase==='day:2')));await f.rewrite();await assert.rejects(verifySeasonRecoveryEvidence(f.options),/order or coverage/);assert.deepEqual(f.fresh.server.writes,[]);
});

test('native layout without a day-title input recovers each exact persisted save and completes only the season',{timeout:120000},async t=>{
 const f=await fixture(t,{dayTitleInput:false}),before=await hashes(f.failedRunDir),audit=await verifySeasonRecoveryEvidence(f.options);
 assert.deepEqual(audit.checkpoint.dayPrepared.map(item=>item.expected.title),[null,null]);
 assert.deepEqual(audit.checkpoint.dayPrepared.map(item=>item.before.tree.length),[2,3]);
 const {productId,...basic}=audit.checkpoint.basic;assert.deepEqual(audit.checkpoint.dayPrepared[0].expected.basic,{...basic,url:basic.url+'#schedule'});
 const active=await f.start();assert.deepEqual(f.fresh.server.writes,[]);await approve(t,active);const result=await active.completed;
 assert.equal(result.status,'continued',JSON.stringify(result));assert.equal(result.finalCheck.status,'verified');assert.deepEqual(f.fresh.server.writes.map(row=>row.kind),['season']);assert.deepEqual(await hashes(f.failedRunDir),before);
 assert.ok(result.finalCheck.result.basicSchedule.detail.tree.every(row=>row.dayTitle===''));
});

test('missing day-title input does not permit changed custom detail or native meal persistence',{timeout:120000},async t=>{
 const f=await fixture(t,{dayTitleInput:false}),source=clone(f.fresh.server.state.days[1]);
 f.fresh.server.state.days[1].created_list[0].etc1='Unapproved detail title';
 await assert.rejects(f.start(),/Other day changed|Persisted custom detail mismatch/);assert.deepEqual(f.fresh.server.writes,[]);
 f.fresh.server.state.days[1]=clone(source);f.fresh.server.state.days[1].meal_list.breakfast_text='Unapproved meal';
 await assert.rejects(f.start({dataDir:path.join(f.root,'second-check')}),/Other day changed|Persisted custom detail mismatch/);assert.deepEqual(f.fresh.server.writes,[]);
});

async function unforwardedFixture(t){
 const f=await fixture(t,{dayTitleInput:false}),failedRecoveryDir=f.options.dataDir;
 const failedJournal=path.join(failedRecoveryDir,'recovery.jsonl');let claimedIdentityReads=0;
 const first=await f.start({identityReader:async page=>{
  const observed=await f.options.identityReader(page),text=await readFile(failedJournal,'utf8');
  // The third identity assertion after the claim is inside the product
  // transition guard, after its independent GET. Attempt a forbidden fixture
  // POST there to reproduce the exact fail-closed, unforwarded native outcome.
  if(text.includes('"kind":"approval-claim"')&&++claimedIdentityReads===3)await page.evaluate(async()=>{try{await fetch('/fixture-must-never-write/',{method:'POST',body:'isolated-test'});}catch{}});
  return observed;
 }});
 await approve(t,first);const failed=await first.completed;
 assert.equal(failed.status,'needs-reconciliation');assert.equal(failed.message,'Unexpected write blocked during season product transition');assert.deepEqual(f.fresh.server.writes,[]);
 await first.close();const prior=await verifyUnforwardedSeasonRecovery({directory:failedRecoveryDir,pinned:await verifySeasonRecoveryEvidence(f.options)});
 const next=await f.open('zero-write-retry-browser',clone(f.fresh.server.state));
 const retryOptions={unforwardedRecoveryDir:failedRecoveryDir,failedPage:f.fresh.page,dataDir:path.join(f.root,'retried-season'),browser:{open:async()=>({page:next.page,close:next.close})}};
 return {...f,failedRecoveryDir,failedJournal,prior,next,retryOptions,retry:overrides=>f.start({...retryOptions,...overrides})};
}

test('claimed but unforwarded season failure needs a fresh exact review and consumes a distinct child slot',{timeout:150000},async t=>{
 const f=await unforwardedFixture(t),before=await hashes(f.failedRecoveryDir),reserved=await readFile(f.prior.reservation.path),active=await f.retry();
 assert.deepEqual(active.reviewBinding.scope,['season']);assert.notEqual(active.reviewBinding.scopeDigest,f.prior.claim.scopeDigest);assert.deepEqual(f.next.server.writes,[]);
 await assert.rejects(active.execute(),/fresh review form/);await approve(t,active);const result=await active.completed;
 assert.equal(result.status,'continued',JSON.stringify(result));assert.equal(result.finalCheck.status,'verified');assert.deepEqual(f.next.server.writes.map(row=>row.kind),['season']);
 assert.deepEqual(await hashes(f.failedRecoveryDir),before);assert.deepEqual(await readFile(f.prior.reservation.path),reserved);
 const child=JSON.parse(await readFile(f.prior.retryReservationPath,'utf8'));assert.equal(child.kind,'product-only-season-zero-write-resumption');assert.equal(child.failedRecovery,f.failedRecoveryDir);assert.deepEqual(child.consumedReservation,f.prior.reservation);assert.deepEqual(child.priorClaim,f.prior.claim);
 await assert.rejects(f.retry({dataDir:path.join(f.root,'duplicate-retry')}),/slot is already consumed/);
 await assert.rejects(f.start({dataDir:path.join(f.root,'reuse-base')}),/slot is already consumed/);
});

test('season retry rejects any authorization, native evidence, receipt, or unknown terminal outcome',{timeout:120000},async t=>{
 const f=await unforwardedFixture(t),original=await readFile(f.failedJournal,'utf8'),base=original.trim().split('\n').map(JSON.parse);
 for(const item of [{kind:'write-authorized',event:{phase:'season'}},{kind:'adapter-evidence',event:{kind:'season-attempt',phase:'season'}},{kind:'receipt-verified',phase:'season'}]){
  const changed=clone(base);changed.splice(-3,0,{...item,at:changed.at(-3).at});await writeFile(f.failedJournal,changed.map(json).join(''));
  await assert.rejects(f.retry(),/unforwarded|sequence|write|outcome/i);assert.deepEqual(f.next.server.writes,[]);
 }
 const changed=clone(base);changed.find(row=>row.kind==='recovery-failed').message='UNKNOWN_SAVE_OUTCOME';changed.find(row=>row.kind==='needs-reconciliation').result.message='UNKNOWN_SAVE_OUTCOME';await writeFile(f.failedJournal,changed.map(json).join(''));
 await assert.rejects(f.retry(),/unforwarded|failure|outcome|terminal/i);assert.deepEqual(f.next.server.writes,[]);await writeFile(f.failedJournal,original);
});

test('unforwarded failure evidence changed after its new review prevents a child claim and write',{timeout:150000},async t=>{
 const f=await unforwardedFixture(t),active=await f.retry();await writeFile(path.join(f.failedRecoveryDir,'changed-after-review.txt'),'changed source evidence');
 await approve(t,active);assert.equal((await active.completed).status,'needs-reconciliation');assert.deepEqual(f.next.server.writes,[]);
 const journal=await readFile(path.join(f.root,'retried-season/recovery.jsonl'),'utf8');assert.doesNotMatch(journal,/"kind":"approval-claim"|"kind":"write-authorized"/);
 await assert.rejects(readFile(f.prior.retryReservationPath),{code:'ENOENT'});
});

async function savedPendingFixture(t){
 const f=await unforwardedFixture(t),active=await f.retry();await approve(t,active);
 const complete=await active.completed;assert.equal(complete.status,'continued',JSON.stringify(complete));
 assert.deepEqual(f.next.server.writes.map(row=>row.kind),['season']);await active.close();
 const savedRecoveryDir=f.retryOptions.dataDir,savedJournal=path.join(savedRecoveryDir,'recovery.jsonl');
 const rows=(await readFile(savedJournal,'utf8')).trim().split('\n').map(JSON.parse);
 const end=rows.findIndex(row=>row.kind==='adapter-evidence'&&row.event?.kind==='season-write-authorized');assert.ok(end>0);
 // Model the legacy parser failure using real fixture-generated approvals,
 // preparation and durable authorization. Only this synthetic test history is
 // rewritten; its in-memory fake ERP retains the single season already saved.
 const pending=rows.slice(0,end+1),at=pending.at(-1).at;
 const message='page.evaluate: Error: saved native select lacks data-init-id: depart-1-airline';
 pending.push({kind:'recovery-failed',at:at+1,message},{kind:'needs-reconciliation',at:at+2,result:{status:'needs-reconciliation',message}},{kind:'recovery-closed',at:at+3});
 await writeFile(savedJournal,pending.map(json).join(''));
 const readonly=await f.open('read-only-browser',clone(f.next.server.state));
 const current={...(await f.options.identityReader()),sessionKey:'new-read-only-session'};
 const options={...f.original,failedRunDir:f.failedRunDir,unforwardedRecoveryDir:f.failedRecoveryDir,savedRecoveryDir,dataDir:path.join(f.root,'final-read-only'),page:readonly.page,identityReader:async()=>({companyId:tenant.companyId,identity:clone(current)}),controls:contentControls,verifyUploadedImage:verifier};
 return {...f,savedRecoveryDir,savedJournal,readonly,current,reconcile:overrides=>reconcileSavedProductOnlySeason({...options,...overrides})};
}

test('read-only final reconciliation proves a saved season without replay or a synthetic historical receipt',{timeout:180000},async t=>{
 const f=await savedPendingFixture(t),before={base:await hashes(f.failedRunDir),prior:await hashes(f.failedRecoveryDir),saved:await hashes(f.savedRecoveryDir),baseSlot:sha(await readFile(f.prior.reservation.path)),childSlot:sha(await readFile(f.prior.retryReservationPath))};
 // A historical approval can be expired now; it authorized the past attempt,
 // while this fresh owned session is permitted to perform read-only checks.
 const result=await f.reconcile({clock:()=>Date.now()+86400000});
 assert.equal(result.status,'reconciled-read-only');assert.equal(result.finalCheck.status,'verified');
 const proof=result.finalCheck.result;assert.equal(proof.kind,'product-only-read-only-reconciliation-v1');assert.equal(proof.forwardedWrites,0);assert.equal(proof.images.length,1);assert.equal(proof.media.status,'native-content-reverified');assert.equal(proof.basicSchedule.status,'saved-basic-schedule-reconciled');
 assert.equal(proof.season.kind,'season-read-only-reconciliation-v1');assert.equal(proof.season.seasonId,'50000');assert.equal(proof.season.forwardedWrites,0);assert.equal(proof.season.identityDigest,digest(f.current));assert.notEqual(proof.season.identityDigest,proof.season.originalIdentityDigest);
 assert.deepEqual(f.readonly.server.writes,[]);assert.deepEqual({base:await hashes(f.failedRunDir),prior:await hashes(f.failedRecoveryDir),saved:await hashes(f.savedRecoveryDir),baseSlot:sha(await readFile(f.prior.reservation.path)),childSlot:sha(await readFile(f.prior.retryReservationPath))},before);
 assert.deepEqual(JSON.parse(await readFile(path.join(result.evidenceDir,'result.json'),'utf8')),result);
 assert.doesNotMatch(await readFile(f.savedJournal,'utf8'),/"kind":"receipt-verified"|"kind":"continued"/);
});

test('read-only final reconciliation refuses changed saved season pricing and forwards no write',{timeout:180000},async t=>{
 const f=await savedPendingFixture(t);f.readonly.server.state.seasons[0].adult_base_price='999';
 await assert.rejects(f.reconcile(),/saved native season field differs: adult_base_price/);assert.deepEqual(f.readonly.server.writes,[]);
 await assert.rejects(readFile(path.join(f.root,'final-read-only/result.json')),{code:'ENOENT'});
});

test('read-only final reconciliation rechecks pinned history after independent image validation',{timeout:180000},async t=>{
 const f=await savedPendingFixture(t);let changed=false;
 await assert.rejects(f.reconcile({verifyUploadedImage:async input=>{if(!changed){changed=true;await writeFile(path.join(f.savedRecoveryDir,'foreign-change.txt'),'changed pinned pending evidence');}return verifier(input);}}),/unexpected recovery evidence|changed/);
 assert.equal(changed,true);assert.deepEqual(f.readonly.server.writes,[]);await assert.rejects(readFile(path.join(f.root,'final-read-only/result.json')),{code:'ENOENT'});
});
