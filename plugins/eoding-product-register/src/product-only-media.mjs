import {isDeepStrictEqual as same} from 'node:util';
import {applyProductContent} from './product-content-adapter.mjs';
const clone=value=>structuredClone(value);
const fail=message=>{throw Error(message)};
function preflight(plan){
  const blockers=[];
  if(typeof plan?.companyId!=='string'||!(/^[1-9]\d{0,9}$/).test(plan.companyId))blockers.push('Invalid media company ID');
  const sources=plan?.source?.images,order=plan?.display?.images?.map(x=>x.sourceImageId);
  if(!Array.isArray(sources)||!sources.length||sources.length>20||sources.some(x=>typeof x?.id!=='string'||!x.id||typeof x.name!=='string'||!x.name||/[\\/\0\r\n]/.test(x.name)||!['image/png','image/jpeg','image/webp'].includes(x.mimeType)||!(/^[a-f0-9]{64}$/).test(x.sha256??'')||typeof x.alt!=='string'||!x.alt))blockers.push('Invalid or missing source image evidence');
  if(plan?.display?.sourceMode!==undefined&&plan.display.sourceMode!=='reference-subset')blockers.push('Invalid media source mode');
  const subset=plan?.display?.sourceMode==='reference-subset';
  if(!Array.isArray(sources)||!Array.isArray(order)||!order.length||(!subset&&order.length!==sources.length)||new Set(order).size!==order.length||new Set(sources.map(x=>x.id)).size!==sources.length||!order.every(id=>sources.some(x=>x.id===id)))blockers.push('Media source image coverage incomplete');
  const display=plan?.display;
  if(!display?.fields||typeof display.fields!=='object'||Array.isArray(display.fields)||!Object.keys(display.fields).length||Object.entries(display.fields).some(([k,v])=>!['short_description','product_description','badge1','badge2','badge3'].includes(k)||typeof v!=='string')||typeof display.imageQuery!=='string'||!display.imageQuery.trim())blockers.push('Invalid media display plan');
  const detail=plan?.content?.detail,elements=plan?.content?.elements;
  if(!detail||!['include','exclude','information','mainPoints'].every(k=>Array.isArray(detail[k]))||typeof detail.shoppingCount!=='string'||!(/^[0-9]+$/).test(detail.shoppingCount))blockers.push('Missing native detail plan');
  else if(['include','exclude'].some(k=>detail[k].some(r=>!r||typeof r.name!=='string'||typeof r.description!=='string'))||['information','mainPoints'].some(k=>detail[k].some(v=>typeof v!=='string'))||['includeNote','excludeNote'].some(k=>detail[k]!==undefined&&typeof detail[k]!=='string'))blockers.push('Invalid native detail values');
  if(!Array.isArray(elements)||elements.some(e=>!e||!['1','3'].includes(String(e.type))||typeof e.text!=='string'))blockers.push('Missing native reference elements');
  return {canExecute:!blockers.length,blockers};
}
/** The combined coordinator stage; approval and browser lifecycles belong to the caller. */
export function createProductOnlyMediaAdapter({origin='https://basecamp.team',assertIdentity,authorizeWrite,record,loadImage,verifyUploadedImage,controls={displaySave:'#save-master-product',detailSave:'#save-master-product',referenceSave:'#save-master-product'},timeoutMs=15000,reconciledDetail,reconciledUploads}={}){
  if(new URL(origin).origin!==origin||!origin.startsWith('https://')||![assertIdentity,authorizeWrite,record,loadImage,verifyUploadedImage].every(fn=>typeof fn==='function'))fail('Media requires exact HTTPS origin, identity, approval, journal, image loader and image verifier');
  let invoked=false,saved=null,bound=null;
  const check=context=>{
    const binding=context?.approvalBinding,claim=context?.approvalClaim,target=context?.targets;
    if(!binding||!['planDigest','scopeDigest'].every(key=>/^[a-f0-9]{64}$/.test(binding[key]??'')&&claim?.[key]===binding[key])||!same(claim.target,{mode:'NEW'})||target?.mode!=='NEW')fail('Media requires the original NEW product approval claim');
    if(!Number.isSafeInteger(target.productId)||target.productId<=0||typeof target.masterCode!=='string'||!target.masterCode)fail('Media requires the verified basic target');
    const basic=context.verifiedPreviousPhases?.find(x=>x.name==='basic')?.receipt;
    if(basic?.productId!==target.productId||basic?.masterCode!==target.masterCode)fail('Media target differs from verified basic receipt');
    if(bound&&!same(bound,{binding,target}))fail('Media execution binding changed');
    return {binding,target};
  };
  return {
    covers:Object.freeze(['display','content']),
    preflight,
    async save(page,plan,context){
      const checked=preflight(plan);if(!checked.canExecute)fail(checked.blockers.join('; '));
      if(invoked)fail('Media stage cannot be retried; reconcile the previous attempt');
      const current=check(context);if(!same(plan.approvalBinding,current.binding)||!same(plan.target,current.target))fail('Media plan binding changed');
      const sources=plan.source?.images;
      if(!Array.isArray(sources)||!sources.length||sources.length>20||new Set(sources.map(x=>x.id)).size!==sources.length||!sources.every(x=>typeof x.id==='string'&&x.id))fail('Media source image coverage is incomplete');
      const order=plan.display?.images?.map(x=>x.sourceImageId);
      const subset=plan.display.sourceMode==='reference-subset';
      const uploadOrder=subset?sources.map(x=>x.id):order;
      const uploadIndexes=subset?order.map(id=>uploadOrder.indexOf(id)):undefined;
      const images=[];
      for(const id of uploadOrder){const source=sources.find(x=>x.id===id),bytes=await loadImage(clone(source));if(!Buffer.isBuffer(bytes))fail('Media loader must return approved source bytes');images.push({kind:'upload',name:source.name,mimeType:source.mimeType,bytes,sha256:source.sha256,alt:source.alt});}
      const productId=String(current.target.productId),target={origin,productId,masterCode:current.target.masterCode,pageUrl:`${origin}/tour/master_product/${productId}/change/`,controls:clone(controls),endpoints:{display:`${origin}/tour/master_product/homepage/${productId}/`,detail:`${origin}/tour/master_product_detail/${productId}/change/`,reference:`${origin}/tour/master_product_reference/${productId}/change/`,upload:`${origin}/contents/image/create_modal/?managed_flag=false`}};
      bound=clone(current);invoked=true;
      await assertIdentity(page,clone(target));
      saved=await applyProductContent(page,{nativePayloads:true,...(reconciledUploads?{reconciledUploads:clone(reconciledUploads)}:{}),...(reconciledDetail?{reconciledDetail:clone(reconciledDetail)}:{}),target,tenant:{companyId:plan.companyId,imageUrlPrefix:`https://media.eoding.com/media/travelagent/${plan.companyId}/imagecontent/`},display:{fields:clone(plan.display.fields),images:[],imageQuery:plan.display.imageQuery,useReferenceUploads:true,...(subset?{uploadIndexes}:{})},detail:clone(plan.content.detail),reference:{elements:clone(plan.content.elements),images},timeoutMs,identity:assertIdentity,record,verifyUploadedImage,beforeWrite:async event=>{check(context);await assertIdentity(page,clone(target));return authorizeWrite(clone(event),clone(context));}});
      if(saved.status!=='content-verified')fail(`Media ${saved.status}; no automatic retry`);
      return clone(saved);
    },
    async verifyReceipt(page,receipt,context){check(context);if(!saved||saved.status!=='content-verified'||!same(receipt,saved))return false;await assertIdentity(page,clone(saved.target));return page.url().split('#')[0]===saved.target.pageUrl;}
  };
}
