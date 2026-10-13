import {mkdir,lstat,realpath,open} from 'node:fs/promises';
import path from 'node:path';
import {isDeepStrictEqual as same} from 'node:util';
import {digest} from './core.mjs';
import {createProductOnlyApprovalBinding} from './product-only-execution.mjs';
import {createProductOnlyAdapters} from './product-only-adapters.mjs';
import {verifySeasonRecoveryEvidence} from './product-only-season-recovery.mjs';
import {verifySavedSeasonRecovery} from './product-only-season-final-evidence.mjs';
import {readProductOnlyIdentity,verifyApprovedProductOnlyCdnImage} from './product-only-launcher.mjs';
import {reconcileSavedSeason} from './product-season-adapter.mjs';
import {requireScheduleSession} from './schedule-session.mjs';

const ORIGIN='https://basecamp.team',clone=structuredClone;
const fail=message=>{throw Error('Read-only product reconciliation blocked: '+message);};
const diagnostic=error=>String(error?.message??'Read-only reconciliation failed').split(/\r?\n/,1)[0].replace(/https?:\/\/\S+/gi,'[URL]').replace(/(?:cookie|authorization|csrf|sessionid|token)\s*[:=]\s*[^\s,;]+/gi,'[credential redacted]').slice(0,400);
async function write(file,value,flag='wx'){
 const handle=await open(file,flag,0o600);try{await handle.writeFile(JSON.stringify(value)+'\n');await handle.sync();}finally{await handle.close();}
}

/** Verify an already attempted season and all preceding product content by reads.
 * This API never claims an approval, invokes a save, or manufactures a historical
 * write receipt. A renewed session is bound as a separate read-only identity.
 * identityReader returns {companyId, identity:{accountName,accountKey,sessionKey}}.
 */
export async function reconcileSavedProductOnlySeason({planPath,journalDir,runtimeDir,failedRunDir,unforwardedRecoveryDir,savedRecoveryDir,dataDir,page,identityReader=readProductOnlyIdentity,verifyUploadedImage,fetchImpl,controls,timeoutMs=15000,clock=()=>Date.now()}={}){
 if(typeof identityReader!=='function'||typeof clock!=='function')fail('current read-only identity assertion required');
 requireScheduleSession(page);
 const evidenceOptions={planPath,journalDir,runtimeDir,failedRunDir};
 const audit=async()=>{const pinned=await verifySeasonRecoveryEvidence(evidenceOptions);return {pinned,saved:await verifySavedSeasonRecovery({directory:savedRecoveryDir,pinned,unforwardedRecoveryDir})};};
 const original=await audit(),{pinned,saved}=original;
 const destination=path.resolve(dataDir),roots=await Promise.all([failedRunDir,unforwardedRecoveryDir,savedRecoveryDir,journalDir,runtimeDir,path.dirname(planPath)].map(value=>realpath(value)));
 if(roots.some(root=>destination===root||destination.startsWith(root+path.sep)||root.startsWith(destination+path.sep)))fail('new read-only output overlaps historical evidence');
 await mkdir(destination,{recursive:false,mode:0o700});const dir=await realpath(destination);
 if(dir!==destination||(await lstat(dir)).isSymbolicLink())fail('read-only output must be a new canonical directory');
 const journal=path.join(dir,'reconciliation.jsonl');
 const record=async(kind,value={})=>write(journal,{kind,at:clock(),...clone(value)},'a');
 await write(path.join(dir,'evidence-manifest.json'),{original:pinned.fingerprint,savedRecovery:saved.fingerprint});
 await write(journal,{kind:'read-only-reconciliation-start',at:clock(),target:pinned.targets,approvalBinding:saved.plan.approvalBinding});
 const assertPinned=async()=>{if(!same(await audit(),original))fail('historical evidence changed during read-only reconciliation');};
 const owner=page.context();let unexpectedWrite=false;
 const guard=route=>{const request=route.request();if(['GET','HEAD'].includes(request.method()))return route.fallback();if(new URL(request.url()).origin===ORIGIN)unexpectedWrite=true;return route.abort();};
 await owner.route('**/*',guard);
 try{
  const observed=clone(await identityReader(page));
  if(String(observed?.companyId)!==String(saved.plan.companyId)||!same(Object.keys(observed?.identity??{}).sort(),['accountKey','accountName','sessionKey'])||Object.values(observed.identity).some(value=>typeof value!=='string'||!value.trim()||value!==value.trim())||observed.identity.accountName!==saved.plan.identity.accountName||observed.identity.accountKey!==saved.plan.identity.accountKey)fail('current company or stable account differs from the approved product');
  const identity=async current=>{requireScheduleSession(current);if(current!==page||!same(await identityReader(current),observed))fail('current read-only account or session changed');return clone(observed.identity);};
  const readPlan=clone(saved.plan);readPlan.identity=clone(observed.identity);readPlan.approvalBinding=createProductOnlyApprovalBinding(readPlan);
  await write(path.join(dir,'read-only-binding.json'),{mode:'read-only',originalApprovalBinding:saved.plan.approvalBinding,readBinding:readPlan.approvalBinding,companyId:String(observed.companyId),accountName:observed.identity.accountName,originalIdentityDigest:digest(saved.plan.identity),identityDigest:digest(observed.identity)});
  const deny=async()=>fail('read-only reconciliation cannot authorize, save or upload');
  const verifyImage=verifyUploadedImage??(value=>verifyApprovedProductOnlyCdnImage({...value,companyId:readPlan.companyId,fetchImpl}));
  const adapters=createProductOnlyAdapters({plan:readPlan,identity,authorizeWrite:deny,record:deny,seedBasicReceipt:pinned.checkpoint.basic,controls,timeoutMs,loadImage:deny,verifyUploadedImage:verifyImage});
  const content=await adapters.reconcileSavedStages(page,clone(pinned.checkpoint));
  await record('saved-product-read-verified',{proof:content});
  const uploadSources=readPlan.display.sourceMode==='reference-subset'?readPlan.source.images:readPlan.display.images.map(item=>readPlan.source.images.find(source=>source.id===item.sourceImageId));
  const images=[];
  for(const [index,source]of uploadSources.entries()){
   const receipt=pinned.checkpoint.media.uploads[index],proof=await verifyImage({receipt:clone(receipt),source:clone(source)});
   if(proof?.sha256!==source.sha256||proof.tenantId!==String(readPlan.companyId)||proof.src!==receipt.src)fail('saved image bytes differ from the approved source');
   images.push({sourceImageId:source.id,src:proof.src,tenantId:proof.tenantId,sha256:proof.sha256});
  }
  await record('saved-images-read-verified',{images});await assertPinned();await identity(page);
  const season=await reconcileSavedSeason(page,{prepared:clone(saved.prepared),assertIdentity:async({target})=>{if(!same(target,{productId:String(pinned.targets.productId)}))fail('season read target differs');return identity(page);}});
  if(season?.kind!=='season-read-only-reconciliation-v1'||season.forwardedWrites!==0||!same(season.target,{productId:String(pinned.targets.productId)})||season.bindingDigest!==saved.prepared.binding.digest||season.planDigest!==saved.prepared.planDigest||season.formDigest!==saved.prepared.formDigest||season.originalIdentityDigest!==saved.prepared.identityDigest||season.identityDigest!==digest(observed.identity)||!same(season.baselineSeasonIds,saved.prepared.baselineSeasonIds)||season.listMembership?.length!==1||season.listMembership[0]!==season.seasonId)fail('independent season reconciliation proof differs from the authorized preparation');
  await record('saved-season-read-verified',{proof:season});await assertPinned();await identity(page);
  if(unexpectedWrite)fail('an unexpected ERP write was blocked during read-only reconciliation');
  const result={status:'reconciled-read-only',targets:clone(pinned.targets),approvalBinding:clone(saved.plan.approvalBinding),finalCheck:{status:'verified',result:{kind:'product-only-read-only-reconciliation-v1',target:clone(pinned.targets),media:content.media,basicSchedule:content.basicSchedule,images,season,forwardedWrites:0,identityDigest:digest(observed.identity)}},evidenceDir:dir};
  await record('read-only-reconciliation-verified',{result});await write(path.join(dir,'result.json'),result);return result;
 }catch(error){await record('read-only-reconciliation-failed',{message:diagnostic(error)});throw error;}
 finally{await owner.unroute('**/*',guard);}
}
