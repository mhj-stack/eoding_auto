import {isDeepStrictEqual as same} from 'node:util';
import {digest} from './core.mjs';
import {createProductOnlyApprovalBinding} from './product-only-execution.mjs';
import {createProductOnlyStageAdapters} from './product-only-stages.mjs';
import {createProductOnlyMediaAdapter} from './product-only-media.mjs';
import {createProductOnlySeasonAdapter} from './product-only-season.mjs';
import {readback as readSeasons} from './product-season-adapter.mjs';
import {readNativeProductContent} from './product-content-final-read.mjs';
import {installStageTransport} from './stage-transport.mjs';
import {createPluginDepartureAdapter} from './plugin-departure.mjs';
const clone=x=>structuredClone(x),fail=m=>{throw Error(m)};
/** Internal composition only: caller owns human approval, durable journal, and browser lifecycle. */
export function createProductOnlyAdapters({plan,identity,authorizeWrite,record,loadImage,verifyUploadedImage,controls,timeoutMs=15000,beforeBasicPrepare,seedBasicReceipt,seedSeasonReceipt,reconciledDetail,reconciledUploads}={}){
 const approved=clone(plan);
 if(!same(approved?.target,{mode:'NEW'})||!same(approved.approvalBinding,createProductOnlyApprovalBinding(approved)))fail('Composition requires an exact bound NEW plan');
 const assertIdentity=async page=>{const observed=await identity(page);if(!same(observed,approved.identity))fail('Approved identity changed');return digest(observed);};
 const stages=createProductOnlyStageAdapters({identity,authorizeWrite,record,beforeBasicPrepare,seedBasicReceipt});
 const media=createProductOnlyMediaAdapter({assertIdentity,authorizeWrite,record,loadImage,verifyUploadedImage,controls,timeoutMs,reconciledDetail,reconciledUploads});
 const seasonExcluded=approved.seasonMode==='excluded';
 if(seasonExcluded&&Object.hasOwn(approved,'season'))fail('Excluded season mode requires plan.season to be absent');
 const season=seasonExcluded?null:createProductOnlySeasonAdapter({assertIdentity,authorizeWrite,record,timeoutMs,...(seedSeasonReceipt?{seedReceipt:{receipt:clone(seedSeasonReceipt),plan:clone(approved.season)}}:{})});
 const departure=approved.departure?.create?createPluginDepartureAdapter({assertIdentity,authorizeWrite,record,timeoutMs}):null;
 let finalEvidence=null,finalPage=null;
 const bindingCheck=(p,c)=>{
  if(!same({...clone(p),target:{mode:'NEW'}},approved)||!same(c?.approvalBinding,approved.approvalBinding)||c?.approvalClaim?.planDigest!==approved.approvalBinding.planDigest||c?.approvalClaim?.scopeDigest!==approved.approvalBinding.scopeDigest||!same(c?.approvalClaim?.target,{mode:'NEW'})||!same(p.target,c.targets))fail('Composed execution plan or claim changed');
 };
 const wrap=adapter=>({...adapter,
  preflight:p=>{const checked=adapter.preflight(p);if(!same(p,approved))return {canExecute:false,blockers:[...checked.blockers,'Composition plan differs from approved snapshot']};return checked;},
  save:async(page,p,c)=>{bindingCheck(p,c);await assertIdentity(page);return adapter.save(page,p,c);}
 });
 const receipt=(c,name)=>{const matches=c.verifiedPreviousPhases?.filter(x=>x.name===name);if(matches?.length!==1||!matches[0].verification)fail('Missing verified '+name+' phase');return clone(matches[0].receipt);};
 return {basic:wrap(stages.basic),media:wrap(media),shell:wrap(stages.shell),day:wrap(stages.day),...(season?{season:wrap(season)}:{}),...(departure?{departure:wrap(departure)}:{}),
 async reconcileSavedStages(page,checkpoint){
  await assertIdentity(page);
  if(checkpoint?.media?.target?.productId!==String(checkpoint?.basic?.productId)||checkpoint.media.target.masterCode!==checkpoint.basic.masterCode)fail('Saved media checkpoint target changed');
  const content=await readNativeProductContent(page,{receipt:checkpoint.media,identity:assertIdentity,timeoutMs});
  const basicSchedule=await stages.reconcileSavedStages(page,approved,checkpoint);
  await assertIdentity(page);return {status:'saved-stages-reconciled',media:content,basicSchedule};
 },finalCheck:{
  async get(page,p,c){
   bindingCheck(p,c);await assertIdentity(page);
   const mediaReceipt=receipt(c,'media'),seasonReceipt=seasonExcluded?null:receipt(c,'season');
   if(mediaReceipt.target?.productId!==String(c.targets.productId)||mediaReceipt.target?.masterCode!==c.targets.masterCode||(!seasonExcluded&&seasonReceipt.target?.productId!==String(c.targets.productId)))fail('Final receipt targets changed');
   let finalTransport;
   if(seasonExcluded||departure) finalTransport=await installStageTransport(page,`product-only-final-read:${p.approvalBinding.planDigest}`,async()=>{
    const owner=page.context(),guard=r=>['GET','HEAD'].includes(r.request().method())?r.fallback():r.abort();
    await owner.route('**/*',guard);
    return async()=>owner.unroute('**/*',guard);
   });
   // Reuse only this fresh post-save document; the opaque proof expires before
   // native serialization continues and never replaces an earlier stage read.
   let basicSchedule;
   const content=await readNativeProductContent(page,{receipt:mediaReceipt,identity:assertIdentity,timeoutMs,onFreshProductRead:async freshProductRead=>{basicSchedule=await stages.readFinal(page,p,c,{freshProductRead});}});
   finalTransport?.verify();
   let seasonProof;
   if(seasonExcluded){
    const target={productId:String(c.targets.productId)},owner=page.context(),guard=r=>['GET','HEAD'].includes(r.request().method())?r.fallback():r.abort();
    await owner.route('**/*',guard);
    try{
     const read=await readSeasons(page,{target,assertIdentity:async({target:observed})=>{if(!same(observed,target))fail('Final season target changed');return {identityDigest:await assertIdentity(page)};}});
     if(read.seasons.length!==0)fail('Excluded season mode requires zero seasons in final readback');
     seasonProof={...read,mode:'excluded',count:read.seasons.length};
    }finally{await owner.unroute('**/*',guard);}
   }else seasonProof=await season.readFinal(page,seasonReceipt,c);
   const departureProof=departure?await departure.readFinal(page,receipt(c,'departure'),c):null;
   await assertIdentity(page);finalEvidence={status:'product-only-reverified',target:clone(c.targets),approvalBinding:clone(c.approvalBinding),media:content,basicSchedule,season:seasonProof,...(departureProof?{departure:departureProof}:{})};finalPage=page;return clone(finalEvidence);
  },
  async verify(page,result,c){bindingCheck(c.plan,c);await assertIdentity(page);return page===finalPage&&finalEvidence!==null&&same(result,finalEvidence);}
 }};
}
