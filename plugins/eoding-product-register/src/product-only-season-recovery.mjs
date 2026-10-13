import {createHash} from 'node:crypto';
import {mkdir,readFile,readdir,lstat,realpath,open} from 'node:fs/promises';
import path from 'node:path';
import {isDeepStrictEqual as same} from 'node:util';
import {digest} from './core.mjs';
import {createProductOnlyApprovalBinding} from './product-only-execution.mjs';
import {createProductOnlyAdapters} from './product-only-adapters.mjs';
import {validateProductOnlyLaunchPlan,readProductOnlyIdentity,loadApprovedProductOnlyImage,verifyApprovedProductOnlyCdnImage} from './product-only-launcher.mjs';
import {verifyProductOnlyContinuationEvidence} from './product-only-continuation.mjs';
import {ProductOnlyReviewStore} from './product-only-review.mjs';
import {startProductReviewUI} from './product-review-ui.mjs';
import {readback as readSeasons} from './product-season-adapter.mjs';
import {requireScheduleSession} from './schedule-session.mjs';
import {verifySeasonRecoveryLineage} from './product-only-season-recovery-history.mjs';
import {verifyUnforwardedSeasonRecovery} from './product-only-season-recovery-unforwarded.mjs';

const ORIGIN='https://basecamp.team',clone=value=>structuredClone(value);
const fail=message=>{throw Error('Season recovery blocked: '+message);};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const phaseResults=(basic,receipts)=>[{name:'basic',receipt:clone(basic),verification:true},...receipts.map(row=>({name:row.phase,receipt:clone(row.receipt),verification:true}))];
const withoutSession=plan=>{const value=clone(plan);for(const key of ['identity','continuation','approvalBinding'])delete value[key];return value;};
const diagnostic=error=>String(error?.message??'Season recovery failed').split(/\r?\n/,1)[0].replace(/https?:\/\/\S+/gi,'[URL]').replace(/(?:cookie|authorization|csrf|sessionid|token)\s*[:=]\s*[^\s,;]+/gi,'[credential redacted]').slice(0,400);

async function regular(file){const stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink())fail('evidence must be a regular file');return stat;}
async function json(file){await regular(file);return JSON.parse(await readFile(file,'utf8'));}
async function rows(file){await regular(file);const text=await readFile(file,'utf8');if(!text.trim()||!text.endsWith('\n'))fail('journal is empty or truncated');return text.trimEnd().split('\n').map(line=>JSON.parse(line));}
async function manifest(dir){
 const stat=await lstat(dir);if(!stat.isDirectory()||stat.isSymbolicLink())fail('failed run must be a regular directory');
 const names=(await readdir(dir)).sort();if(!same(names,['continuation-plan.json','continuation.jsonl','original-manifest.json']))fail('failed run has unexpected evidence files');
 return Promise.all(names.map(async name=>{const file=path.join(dir,name);await regular(file);return {name,sha256:hash(await readFile(file))};}));
}
async function synced(file,value,flag='wx'){
 const handle=await open(file,flag,0o600);try{await handle.writeFile(JSON.stringify(value)+'\n');await handle.sync();}finally{await handle.close();}
}
function one(events,kind){const found=events.filter(row=>row.kind===kind);if(found.length!==1)fail(`expected one ${kind}`);return found[0];}
function optional(events,kind){const found=events.filter(row=>row.kind===kind);if(found.length>1)fail(`duplicate ${kind}`);return found[0];}

/** File-only audit: accepts a completed media/shell/all-days continuation with no season authorization. */
export async function verifySeasonRecoveryEvidence({planPath,journalDir,runtimeDir,failedRunDir}={}){
 const original=await verifyProductOnlyContinuationEvidence({planPath,journalDir,runtimeDir});
 const originalPlan=validateProductOnlyLaunchPlan(await json(planPath));
 const failedDir=await realpath(failedRunDir),files=await manifest(failedDir),events=await rows(path.join(failedDir,'continuation.jsonl'));
 const plan=validateProductOnlyLaunchPlan(await json(path.join(failedDir,'continuation-plan.json')));
 if(plan.seasonMode==='excluded'||!same(withoutSession(plan),withoutSession(originalPlan))||!same(plan.continuation?.original?.approvalBinding,originalPlan.approvalBinding)||!same(plan.continuation?.original?.manifest,original.manifest)||!same(await json(path.join(failedDir,'original-manifest.json')),original.manifest))fail('failed plan lineage or original evidence changed');
 if(events.some((row,index)=>!Number.isSafeInteger(row.at)||row.at<0||index&&row.at<events[index-1].at))fail('journal time ordering changed');
 const basic=original.target,target={productId:Number(basic.productId),masterCode:basic.masterCode};
 if(!same(one(events,'original-evidence-verified').target,target)||!same(one(events,'session-renewal-review').plan,plan))fail('failed target or reviewed plan changed');
 const recovery=optional(events,'detail-recovery-verified')?.recovery,priorFailure=optional(events,'prior-failure-verified')?.priorFailure;
 const unforwardedFailure=optional(events,'unforwarded-failure-verified')?.source,verifiedUploadFailure=optional(events,'verified-upload-failure-verified')?.source;
 const scope=digest({kind:'product-only-continuation-review-v1',target,manifest:original.manifest,
  ...(recovery?{recovery:{directory:recovery.dir,manifest:recovery.manifest,detail:recovery.detail}}:{}),...(priorFailure?{priorFailure}:{}),...(unforwardedFailure?{unforwardedFailure}:{}),...(verifiedUploadFailure?{verifiedUploadFailure}:{}),phases:['media','shell','day','season','finalCheck'],renewalBinding:plan.approvalBinding});
 const approvalRow=one(events,'human-approval'),claimRow=one(events,'approval-claim'),approval=approvalRow.approval,claim=claimRow.claim;
 if(approval?.status!=='approved'||approval.method!=='localhost-human-form'||approval.planDigest!==plan.approvalBinding.planDigest||approval.scopeDigest!==scope||approval.tenantObserved!==String(plan.product.company.tenant)||approval.accountObserved!==plan.identity.accountName||claim?.id!==`product-only:${plan.approvalBinding.planDigest}`||claim.planDigest!==approval.planDigest||claim.scopeDigest!==scope||!same(claim.target,{mode:'NEW'})||![approval.approvedAt,approval.expiresAt,claim.claimedAt].every(Number.isSafeInteger)||approval.approvedAt>approvalRow.at||approvalRow.at>claim.claimedAt||claim.claimedAt>=approval.expiresAt||claimRow.at<claim.claimedAt||claimRow.at>=approval.expiresAt)fail('historical approval or claim changed');
 const lineage=await verifySeasonRecoveryLineage({events,originalPlan,originalManifest:original.manifest,originalJournal:await realpath(journalDir),failedDir,claimRow});
 const {reservationPath,reservation}=lineage;
 if(!['product-only-continuation-reservation','product-only-zero-write-resumption','product-only-verified-upload-resumption'].includes(reservation.kind)||reservation.dataDir!==failedDir||reservation.originalJournal!==await realpath(journalDir)||reservation.at<claim.claimedAt||reservation.at>claimRow.at)fail('consumed reservation does not bind the failed run');
 const receipts=events.filter(row=>row.kind==='receipt-verified'),expected=['media','shell',...plan.itinerary.map(day=>`day:${day.day}`)];
 if(!same(receipts.map(row=>row.phase),expected)||!same(events.filter(row=>row.kind==='before-write').map(row=>row.phase),[...expected,'season']))fail('saved phase order or coverage changed');
 const seasonStart=events.findIndex(row=>row.kind==='before-write'&&row.phase==='season');
 if(events.indexOf(receipts.at(-1))>=seasonStart||events.slice(seasonStart+1).some(row=>!['needs-reconciliation','continuation-closed'].includes(row.kind))||!events.slice(seasonStart+1).some(row=>row.kind==='needs-reconciliation'))fail('season did not stop before its first authorization');
 if(events.some(row=>row.kind==='completed'||row.kind==='write-authorized'&&row.event?.phase==='season'||row.kind==='adapter-evidence'&&(row.event?.phase==='season'||String(row.event?.kind??'').startsWith('season-'))))fail('season has an ambiguous write or completed outcome');
 for(const [index,row]of receipts.entries()){
  const before=events.findIndex(item=>item.kind==='before-write'&&item.phase===row.phase),end=events.indexOf(row);
  if(before<=events.indexOf(claimRow)||before>=end||index&&before<=events.indexOf(receipts[index-1]))fail('receipt is outside its claimed phase');
  if(row.phase!=='media'){
   const writes=events.slice(before,end).filter(item=>item.kind==='write-authorized'&&item.event?.phase===row.phase);
   const attempts=events.slice(before,end).filter(item=>item.kind==='adapter-evidence'&&item.event?.phase==='attempt'&&item.event.stage===row.phase);
   if(writes.length!==1||attempts.length!==1||events.indexOf(writes[0])>=events.indexOf(attempts[0]))fail('saved stage does not have exactly one durable authorization and attempt');
  }
 }
 const media=receipts[0].receipt,shell=receipts[1].receipt,days=receipts.slice(2).map(row=>row.receipt);
 const nativeResult=events.filter(row=>row.kind==='adapter-evidence'&&row.event?.phase==='result'&&row.event.status==='content-verified');
 if(nativeResult.length!==1){fail('media lacks one verified native result');}
 const {phase:ignored,...nativeReceipt}=nativeResult[0].event;
 if(!same(nativeReceipt,media)||media.status!=='content-verified'||media.target?.productId!==String(target.productId)||media.target.masterCode!==target.masterCode||media.uploads?.length!==plan.source.images.length||!media.persisted?.payloads||media.persisted.images?.length!==plan.display.images.length||shell?.productId!==target.productId||!Number.isSafeInteger(shell.scheduleId))fail('saved media or schedule target changed');
 const shellWrite=events.find(row=>row.kind==='write-authorized'&&row.event?.phase==='shell');
 const dayPrepared=days.map(day=>clone(events.find(row=>row.kind==='write-authorized'&&row.event?.phase===`day:${day.day}`).event.prepared));
 const checkpoint={basic:clone(basic),media:clone(media),shell:clone(shell),days:clone(days),dayPrepared,shellBefore:clone(shellWrite.event.prepared.before)};
 const fingerprint={original:original.manifest,failed:{directory:failedDir,files},reservation:{path:reservationPath,sha256:hash(await readFile(reservationPath))},lineage:lineage.fingerprint};
 for(const image of plan.source.images)await loadApprovedProductOnlyImage(image);
 return {plan:clone(plan),checkpoint,results:phaseResults(basic,receipts),targets:{mode:'NEW',...target,scheduleId:shell.scheduleId},fingerprint,approval:clone(approval),claim:clone(claim)};
}

function renderReview(session,csrf,message=''){
 const plan=session.approvalContext.executionInput,target=plan.seasonRecovery.target;
 const terminal=session.execution||session.approval;
 const fields=plan.season.fields;
 return `<!doctype html><html lang="ko"><meta charset="utf-8"><title>남은 시즌 저장</title><body style="font:16px system-ui;max-width:800px;margin:32px auto"><h1>남은 시즌·요금 저장</h1><p><strong>${esc(plan.product.title)}</strong><br>기존 상품 ${esc(target.masterCode)} · ${esc(target.productId)} · 비공개 유지</p><p>이미지·상세와 ${esc(plan.itinerary.length)}일 일정은 저장 완료되어 다시 조회해 확인합니다. 이번 저장은 시즌 1건뿐입니다.</p>${plan.seasonRecovery.unforwardedRecovery?'<p>이전 시도에서 시즌은 저장되지 않았습니다. 동일한 시즌 1건을 다시 확인하고 저장합니다.</p>':''}<p>출발 ${esc(plan.season.selectedDates.join(', '))}<br>성인 ${esc(Number(fields.adult_base_price)+Number(fields.adult_fuel_price))} / 아동 ${esc(Number(fields.child_base_price)+Number(fields.child_fuel_price))} / 유아 ${esc(Number(fields.infant_base_price)+Number(fields.infant_fuel_price))} ${esc(plan.product.currency)}<br>항공 ${esc(fields['depart-0-flight_no'])} / ${esc(fields['arrive-0-flight_no'])}</p>${plan.seasonRecovery.allowPastDepartureTest?'<p>지난 출발일을 유지하는 비공개 테스트입니다.</p>':''}${terminal?'<p role="status">검토가 처리됐습니다. 실행 결과를 확인하세요.</p>':`<form method="post" action="/approve"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="version" value="${session.version}"><input type="hidden" name="scope_hash" value="${esc(session.scopeDigest)}"><input type="hidden" name="scope" value="${session.requestedScope.join(',')}"><label>회사 <input name="company" required></label><br><label>계정 <input name="account" required></label><br><button type="submit">확인한 남은 시즌 저장</button></form>`}<p>${esc(message)}</p></body></html>`;
}

/** New review/claim, one season save, and the unchanged whole-product final verifier. */
export async function startProductOnlySeasonRecovery({planPath,journalDir,runtimeDir,failedRunDir,unforwardedRecoveryDir,failedPage,dataDir,browser,identityReader,controls,verifyUploadedImage,fetchImpl,allowPastDepartureTest=false,ttlMs=15*60*1000,clock=()=>Date.now(),timeoutMs=15000}={}){
 if(typeof allowPastDepartureTest!=='boolean'||typeof clock!=='function'||typeof browser?.open!=='function')fail('explicit browser, clock and past-departure mode required');
 const evidenceOptions={planPath,journalDir,runtimeDir,failedRunDir},pinned=await verifySeasonRecoveryEvidence(evidenceOptions);
 const prior=unforwardedRecoveryDir===undefined?null:await verifyUnforwardedSeasonRecovery({directory:unforwardedRecoveryDir,pinned});
 const priorProof=prior?{directory:prior.dir,manifest:clone(prior.manifest),approvalBinding:clone(prior.plan.approvalBinding),claim:clone(prior.claim),reservation:clone(prior.reservation)}:null;
 const reservationFile=prior?.retryReservationPath??path.join(path.dirname(pinned.fingerprint.reservation.path),'.season-resumptions',digest({reservation:pinned.fingerprint.reservation.path,claim:pinned.claim.id,scope:pinned.claim.scopeDigest})+'.json');
 try{await lstat(reservationFile);fail('season resumption slot is already consumed');}catch(error){if(error.code!=='ENOENT')throw error;}
 if(pinned.plan.season.selectedDates.some(date=>date<new Date(clock()).toISOString().slice(0,10))&&!allowPastDepartureTest)fail('past departure requires explicit private-test acceptance');
 if(!failedPage?.isClosed()||failedPage.context().pages().length)fail('failed context must be fully retired');
 const destination=path.resolve(dataDir),roots=[await realpath(failedRunDir),await realpath(journalDir),await realpath(runtimeDir),path.dirname(await realpath(planPath)),...(prior?[prior.dir]:[])];
 if(roots.some(root=>destination===root||destination.startsWith(root+path.sep)||root.startsWith(destination+path.sep)))fail('recovery directory overlaps evidence');
 await mkdir(destination,{recursive:false,mode:0o700});const dir=await realpath(destination);
 if(dir!==destination)fail('recovery directory must be canonical');
 let closed=false,terminal=false,busy=false,permit=false,attempted=false,deadline=0,adapters,owned,store,ui,activeClaim;
 const journalFile=path.join(dir,'recovery.jsonl');await synced(journalFile,{kind:'season-recovery-start',at:clock(),fingerprint:pinned.fingerprint,...(prior?{unforwardedRecovery:priorProof}:{})});
 const record=async(kind,value={})=>{const event={kind,at:clock(),...clone(value)};await synced(journalFile,event,'a');return event;};
 const assertPinned=async()=>{const current=await verifySeasonRecoveryEvidence(evidenceOptions);if(!same(current,pinned))fail('pinned failed-run evidence changed');if(prior&&!same(await verifyUnforwardedSeasonRecovery({directory:unforwardedRecoveryDir,pinned:current}),prior))fail('pinned unforwarded recovery evidence changed');};
 owned=await browser.open();const page=owned?.page;if(!page||typeof owned.close!=='function'||page.context()===failedPage.context())fail('fresh owned context required');requireScheduleSession(page);
 const readIdentity=identityReader??(async current=>(await readProductOnlyIdentity(current)).identity);
 const observed=clone(await readIdentity(page));
 if(observed?.accountName!==pinned.plan.identity.accountName||observed?.accountKey!==pinned.plan.identity.accountKey||Object.keys(observed).sort().join(',')!=='accountKey,accountName,sessionKey'||Object.values(observed).some(value=>typeof value!=='string'||!value))fail('current account differs from the original approval');
 const nextPlan=clone(pinned.plan);nextPlan.identity=observed;nextPlan.seasonRecovery={kind:'product-only-season-recovery-v1',target:clone(pinned.targets),fingerprint:clone(pinned.fingerprint),allowPastDepartureTest,...(prior?{unforwardedRecovery:priorProof}:{})};nextPlan.approvalBinding=createProductOnlyApprovalBinding(nextPlan);
 const plan=validateProductOnlyLaunchPlan(nextPlan),targets=clone(pinned.targets),results=clone(pinned.results);
 await synced(path.join(dir,'recovery-plan.json'),plan);await synced(path.join(dir,'original-manifest.json'),pinned.fingerprint);
 const identity=async current=>{requireScheduleSession(current);const value=await readIdentity(current);if(!same(value,plan.identity))fail('reviewed identity changed');return value;};
 const barrier=async route=>{
  const req=route.request();if(['GET','HEAD'].includes(req.method()))return route.fallback();
  if(closed||terminal||!busy||!permit||clock()>=deadline||req.method()!=='POST'||req.url()!==ORIGIN+'/tour/master_product_season/add/')return route.abort();
  permit=false;try{await identity(page);if(closed||terminal||clock()>=deadline)return route.abort();return route.fallback();}catch{terminal=true;return route.abort();}
 };
 await page.context().route('**/*',barrier);
 let resolveCompleted;const completed=new Promise(resolve=>{resolveCompleted=resolve;});
 const authorized=async(event,context)=>{
  if(closed||terminal||!busy||attempted||store.state.execution?.status!=='executing'||clock()>=deadline||event.phase!=='season'||!same(event.target,targets)||!same(context.approvalClaim,activeClaim)||store.state.execution.claim.id!==activeClaim?.id||!same(context.approvalBinding,plan.approvalBinding)||!same(context.targets,targets)||!same(event.approvalBinding,plan.approvalBinding)||!same(event.approvalClaim,context.approvalClaim))fail('season write is outside the current claim');
  await assertPinned();await identity(page);if(clock()>=deadline||closed||terminal)fail('approval expired during authorization');
  await record('write-authorized',{event});attempted=true;permit=true;
  return {durable:true,status:'approved',bindingDigest:event.bindingDigest,approvalId:store.state.execution.claim.id};
 };
 const adapterRecord=async event=>{await record('adapter-evidence',{event});return {durable:true,bindingDigest:event.bindingDigest??event.binding?.digest,evidenceId:`season-recovery:${clock()}`};};
 const preflight=async()=>{
  await assertPinned();await identity(page);
  const verifyImage=verifyUploadedImage??(value=>verifyApprovedProductOnlyCdnImage({...value,companyId:plan.companyId,fetchImpl}));
  const created=createProductOnlyAdapters({plan,identity,authorizeWrite:authorized,record:adapterRecord,seedBasicReceipt:pinned.checkpoint.basic,controls,timeoutMs,loadImage:async()=>fail('saved media must never upload again'),verifyUploadedImage:verifyImage});
  const saved=await created.reconcileSavedStages(page,clone(pinned.checkpoint));
  const season=await readSeasons(page,{target:{productId:String(targets.productId)},assertIdentity:async()=>({identityDigest:digest(await identity(page))})});
  if(season.seasons.length)fail('target already has a season; no replay is allowed');
  for(const [index,source]of plan.source.images.entries()){
   const receipt=pinned.checkpoint.media.uploads[index],proof=await verifyImage({receipt:clone(receipt),source:clone(source)});
   if(proof?.sha256!==source.sha256||proof.tenantId!==String(plan.companyId)||proof.src!==receipt.src)fail('saved image no longer matches the approved source');
  }
  await assertPinned();await identity(page);adapters=created;
  const proof={status:'season-recovery-preflight-verified',target:clone(targets),saved,seasons:0,forwardedWrites:0};await record('preflight-verified',{proof});return proof;
 };
 let proof;
 try{proof=await preflight();}catch(error){terminal=true;await record('preflight-failed',{message:diagnostic(error)});throw error;}
 store=new ProductOnlyReviewStore({plan,sourceLabel:`season-only:${targets.masterCode}`,sourceDigest:digest(prior?{original:pinned.fingerprint,unforwardedRecovery:priorProof}:pinned.fingerprint),clock,
  onApprove:approval=>record('review-approval',{approval}),onCancel:async approval=>{terminal=true;await record('approval-cancelled',{approval});resolveCompleted({status:'cancelled'});},
  onClaim:async claim=>{
   const reservationDir=path.dirname(reservationFile);await mkdir(reservationDir,{recursive:true,mode:0o700});
   if((await lstat(reservationDir)).isSymbolicLink()||await realpath(reservationDir)!==reservationDir)fail('season reservation directory must be canonical');
   const reservation=prior?{kind:'product-only-season-zero-write-resumption',baseFailedRun:pinned.fingerprint.failed.directory,failedRecovery:prior.dir,consumedReservation:prior.reservation,priorClaim:prior.claim,dataDir:dir,claim,at:clock()}:{kind:'product-only-season-resumption',failedRun:pinned.fingerprint.failed.directory,consumedReservation:pinned.fingerprint.reservation,dataDir:dir,claim,at:clock()};
   await synced(reservationFile,reservation);await record('approval-claim',{claim,reservation:reservationFile});
  },onReconcile:result=>record('needs-reconciliation',{result}),beforeClaim:preflight});
 // The visible review grants only the remaining season. Translate that narrower
 // claimed scope internally to the original adapter plan binding; never widen
 // the browser permit or expose already-saved stage execution.
 const completeScope=clone(store.state.requestedScope);
 store.state.requestedScope=['season'];
 store.state.scopeDigest=digest({kind:'product-only-season-recovery-review-v1',target:targets,remaining:['season'],fingerprint:pinned.fingerprint,approvalBinding:plan.approvalBinding,...(prior?{unforwardedRecovery:priorProof}:{})});
 const approveReview=store.approve.bind(store),claimReview=store.claim.bind(store);
 store.approve=(id,args)=>{if(!same(args?.scope,['season']))fail('review must approve only the remaining season');return approveReview(id,{...args,scope:completeScope});};
 store.claim=async request=>{
  if(!same(request,{target:{mode:'NEW'},...plan.approvalBinding}))fail('adapter claim binding changed');
  const claimed=await claimReview({...request,scopeDigest:store.state.scopeDigest});
  const translated={...claimed,scopeDigest:plan.approvalBinding.scopeDigest};
  await record('adapter-claim-binding',{reviewClaim:claimed,adapterClaim:translated});return translated;
 };
 const run=async()=>{
  if(closed||terminal||busy)fail('review is closed or already executing');busy=true;
  try{
   const claim=await store.claim({target:{mode:'NEW'},...plan.approvalBinding});activeClaim=clone(claim);deadline=store.state.approval.expiresAt;
   if(clock()>=deadline)fail('approval expired');
   const context={phase:'season',day:null,targets:clone(targets),verifiedPreviousPhases:clone(results),approvalClaim:claim,approvalBinding:clone(plan.approvalBinding)};
   await record('before-write',{phase:'season',targets});
   let receipt;try{receipt=await adapters.season.save(page,{...clone(plan),target:clone(targets)},context);}finally{permit=false;}
   if(!await adapters.season.verifyReceipt(page,receipt,context)||clock()>=deadline)fail('season verification failed or approval expired');
   results.push({name:'season',receipt:clone(receipt),verification:true});await record('receipt-verified',{phase:'season',receipt});
   await assertPinned();const finalContext={...context,phase:'final-get',verifiedPreviousPhases:clone(results)},finalPlan={...clone(plan),target:clone(targets)};
   const final=await adapters.finalCheck.get(page,finalPlan,finalContext);
   if(!await adapters.finalCheck.verify(page,final,{plan:finalPlan,...finalContext})||closed||terminal||clock()>=deadline)fail('whole-product final check failed');
   const result={status:'continued',targets:clone(targets),phases:clone(results),finalCheck:{status:'verified',result:final}};
   await record('completed',{result});await store.completed(result);terminal=true;resolveCompleted(result);return result;
  }catch(error){terminal=true;permit=false;const message=diagnostic(error);await record('recovery-failed',{message});await store.reconcile(new Error(message)).catch(()=>{});resolveCompleted({status:'needs-reconciliation',message});throw new Error(message);}finally{busy=false;permit=false;}
 };
 ui=await startProductReviewUI({store,sessionId:store.state.id,ttlMs,onApproved:run,renderPage:renderReview});
 return Object.freeze({url:ui.url,preflight:proof,reviewBinding:{planDigest:plan.approvalBinding.planDigest,scopeDigest:store.state.scopeDigest,scope:clone(store.state.requestedScope),companyId:String(plan.companyId),accountName:plan.identity.accountName,target:clone(targets)},completed,execute:async()=>fail('the fresh review form must approve this remaining season'),close:async()=>{if(closed)return;closed=true;terminal=true;permit=false;await ui.close();await owned.close();await page.context().unroute('**/*',barrier).catch(()=>{});await record('recovery-closed');resolveCompleted({status:'closed'});}});
}
