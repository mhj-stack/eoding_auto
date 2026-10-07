import { prepareReferencePicker } from './reference-picker.mjs';
import {isDeepStrictEqual as same} from 'node:util';
import {createHash} from 'node:crypto';
import {parseDisplayMultipart,readDisplayImageState,prepareExistingDisplayImages,validateDisplayImages} from './display-image.mjs';
const copy=x=>structuredClone(x);
const fail=message=>{throw Error(message)};
const strip=body=>Array.isArray(body)?body: Object.fromEntries(Object.entries(body).filter(([k])=>k!=='csrfmiddlewaretoken'));
function csrfValue(value){
  if(typeof value!=='string'||!value.trim())fail('Malformed native CSRF');
  return value;
}
function parseNativeJson(text){
  try{return JSON.parse(text);}catch{fail('Malformed native JSON payload');}
}
function csrfHeader(req){
  const headers=Object.entries(req.headers()).filter(([name])=>name.toLowerCase()==='x-csrftoken');
  if(headers.length>1)fail('Duplicate native CSRF header');
  return headers.length?csrfValue(headers[0][1]):undefined;
}
function csrfChannels(req,body){
  const header=csrfHeader(req);
  if(header===undefined&&body===undefined)fail('Missing native CSRF');
  return {...(header===undefined?{}:{header}),...(body===undefined?{}:{body})};
}
function csrfBody(fields){
  const tokens=fields.filter(([name])=>name==='csrfmiddlewaretoken');
  if(tokens.length>1)fail('Duplicate native CSRF');
  if(!tokens.length)return undefined;
  return csrfValue(tokens[0][1]);
}
function sameCsrfChannels(captured,forwarded){return same(captured,forwarded);}
function expectedDetail(before,detail){
  const out=copy(before);
  for(const key of ['1','2','3','4'])if(before[key]?.etc!=='[]')fail('Existing native detail rows require reconciliation');
  for(const [id,key] of [['1','include'],['2','exclude']]){out[id].etc=JSON.stringify(detail[key].map(row=>({value:'Direct',label:row.name,remark:row.description})));if(detail[key+'Note']!==undefined){if(before[id].etc2!=='')fail('Existing native detail note');out[id].etc2=detail[key+'Note'];}}
  out['3'].etc=JSON.stringify(detail.information.map(content=>({content})));out['4'].etc=JSON.stringify(detail.mainPoints.map(content=>({content})));if(!out['8'])fail('Missing native shopping baseline');out['8'].etc5=detail.shoppingCount;return out;
}
function expectedReference(before,reference,images=[]){
  if(!Array.isArray(before)||before.length!==1||before[0]?.type!=='15'||before[0].etc2!=='[]'||!Array.isArray(before[0].image_group)||before[0].image_group.length)fail('Existing native reference content requires reconciliation');
  const out=copy(before),elements=reference.elements.map(e=>({type:Number(e.type),contents:String(e.type)==='3'?e.text:[{detail:e.text,font_color:'0',bold_flag:'0'}]}));
  if(images.length){elements.push({type:4,contents:1});out[0].image_group=[{group_id:1,image_list:images.map(x=>({image_id:x.id,image_url:''}))}];out[0].image_append_yn='Y';}
  out[0].etc2=JSON.stringify(elements);return out;
}
async function payload(req,upload=false){
  const ct=req.headers()['content-type']??'';
  if(/^application\/json(?:;|$)/i.test(ct)){
    if(upload)fail('Native upload must be multipart');
    const body=parseNativeJson(req.postData()),bodyCsrf=body&&typeof body==='object'&&!Array.isArray(body)&&Object.hasOwn(body,'csrfmiddlewaretoken')?csrfValue(body.csrfmiddlewaretoken):undefined;
    return {body:strip(body),csrf:csrfChannels(req,bodyCsrf)};
  }
  if(upload){
    const data=await new Response(req.postDataBuffer(),{headers:{'content-type':ct}}).formData(),body={},fields=[];
    for(const [key,value] of data){
      if(key==='csrfmiddlewaretoken'){fields.push([key,value]);continue;}
      if(Object.hasOwn(body,key))fail('Duplicate upload field');
      body[key]=typeof value==='string'?value:{name:value.name,mimeType:value.type,size:value.size,sha256:createHash('sha256').update(Buffer.from(await value.arrayBuffer())).digest('hex')};
    }
    return {body,csrf:csrfChannels(req,csrfBody(fields))};
  }
  const fields=parseDisplayMultipart(ct,req.postDataBuffer()),seen=new Set();for(const [name] of fields){if(name==='csrfmiddlewaretoken')continue;if(seen.has(name))fail('Duplicate native field');seen.add(name);}
  return {body:Object.fromEntries(fields.filter(([name])=>name!=='csrfmiddlewaretoken')),csrf:csrfChannels(req,csrfBody(fields))};
}
/** Native ERP JSON payloads, rather than synthetic FormData(detail/reference). */
export async function applyNativeProductContent(page,args){
  const {target,tenant,identity,beforeWrite,record,timeoutMs,verifyPersistedContent}=args;
  const useUploads=args.display.useReferenceUploads===true;
  const selectedIndexes=args.display.uploadIndexes;
  if(selectedIndexes!==undefined&&(!useUploads||!Array.isArray(selectedIndexes)||!selectedIndexes.length||new Set(selectedIndexes).size!==selectedIndexes.length||selectedIndexes.some(i=>!Number.isInteger(i)||i<0||i>=args.reference.images.length)))fail('Invalid display upload selection');
  const displayUploads=uploads=>selectedIndexes===undefined?uploads:selectedIndexes.map(i=>uploads[i]);
  if(useUploads&&(!args.reference.images.length||args.display.images.length))fail('Display upload sources must be exclusive and nonempty');
  if(args.reference.images.length>20)fail('At most 20 native images supported');
  const approvedImages=args.display.images.length?validateDisplayImages(args.display.images,tenant.companyId):[];
  const completed=[],uploads=[];let pending=null,failed=false,forwarded=0,cdp;
  const assertIdentity=async()=>{if(page.url().split('#')[0]!==target.pageUrl.split('#')[0])fail('Native content target changed');await identity(page,copy(target));if(page.url().split('#')[0]!==target.pageUrl.split('#')[0])fail('Native content target changed');};
  const guard=async route=>{
    const req=route.request();if(['GET','HEAD'].includes(req.method()))return route.fallback();
    const p=pending;
    if(!p||p.used||req.method()!=='POST'||req.url()!==p.url){if(new URL(req.url()).origin===target.origin)failed=true;return route.abort();}
    p.used=true;
    try{const data=await payload(req,p.url===target.endpoints.upload);await assertIdentity();if(p.expected&&!same(data.body,p.expected))fail('Native content payload differs from approved delta');
      if(!p.forward){await route.abort();p.resolve(data);return;}
      if(!sameCsrfChannels(p.csrf,data.csrf))fail('Native content CSRF changed');
      const permit=await beforeWrite({key:p.key,target:copy(target),url:p.url,payload:copy(data.body)});if(permit?.durable!==true)fail('Durable beforeWrite callback refused');await assertIdentity();await record({phase:'attempt',key:p.key,target:copy(target),url:p.url});forwarded++;await route.fallback();p.resolve(data);
    }catch(e){failed=true;await route.abort().catch(()=>{});p.reject(e);}
  };
  await page.context().route('**/*',guard);
  const tab=async key=>{await page.waitForLoadState('load',{timeout:timeoutMs});const link=page.locator(`a[href="#${key}"]`);if(await link.count()===1)await link.click();await assertIdentity();};
  const capture=async(key,url,selector,{expected,forward=false,csrf=null}={})=>{
    if(failed)fail('Native content blocked after an earlier failure');await assertIdentity();let timer;
    const packet=new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(Error('Native payload capture timed out')),timeoutMs);pending={key,url,expected,forward,csrf,used:false,resolve,reject};});packet.catch(()=>{});
    const response=forward?page.waitForResponse(r=>r.request().method()==='POST'&&r.url()===url,{timeout:timeoutMs}).catch(()=>null):null;
    try{await page.locator(selector).click({timeout:timeoutMs});const data=await packet;if(failed)fail('Unexpected ERP mutation blocked');if(response){const r=await response;if(!r?.ok())fail('Native save outcome unknown');completed.push(key);data.response=r;}return data;}
    finally{clearTimeout(timer);pending=null;}
  };
  try{
    cdp=await page.context().newCDPSession(page);await cdp.send('Network.enable');await cdp.send('Network.setCacheDisabled',{cacheDisabled:true});await cdp.send('Network.setBypassServiceWorker',{bypass:true});
    // Capture untouched baselines without sending any request to ERP.
    await tab('base');const base=await capture('display-baseline',target.endpoints.display,target.controls.displaySave);
    const imageBaseline=(approvedImages.length||useUploads)?await readDisplayImageState(page):null;if(imageBaseline?.images.length)fail('Native display image baseline is not empty');
    await tab('detail');const detailBase=await capture('detail-baseline',target.endpoints.detail,target.controls.detailSave);const detailExpected=expectedDetail(detailBase.body,args.detail);
    await tab('productreference');const referenceBase=await capture('reference-baseline',target.endpoints.reference,target.controls.referenceSave);let referenceExpected=expectedReference(referenceBase.body,args.reference);
    let referencePicker;
    if(args.reference.elements.length||args.reference.images.length){
      const add=page.locator('#add_reference_element');
      if(await add.count()!==1||!await add.isVisible()||!await add.isEnabled())fail('Unsupported native reference picker; no content writes forwarded');
      const types=[...new Set([...args.reference.elements.map(e=>String(e.type)),...(args.reference.images.length?['4']:[])])];
      referencePicker=await prepareReferencePicker(page,types,timeoutMs);
    }
    await tab('base');for(const [name,value] of Object.entries(args.display.fields)){const f=page.locator(`#homepage_post [name="${name}"]`);if(await f.count()!==1)fail('Missing native display field');await f.fill(value);}
    const displayExpected={...base.body,...args.display.fields};if('product_description' in args.display.fields)displayExpected.product_description=args.display.fields.product_description.replace(/\r?\n/g,'\r\n');
    if('badge_list' in displayExpected)displayExpected.badge_list=JSON.stringify(['badge1','badge2','badge3'].map(k=>displayExpected[k]?.trim()??'').filter(Boolean));
    if(approvedImages.length){await prepareExistingDisplayImages(page,{images:approvedImages,companyId:tenant.companyId,query:args.display.imageQuery});displayExpected.image_sort=JSON.stringify({images:approvedImages.map(x=>x.id)});}
    if(!useUploads)await capture('display',target.endpoints.display,target.controls.displaySave,{expected:displayExpected,forward:true,csrf:base.csrf});
    await tab('detail');for(const id of ['include','exclude','information','main-point']){const rows=args.detail[id==='main-point'?'mainPoints':id];if(await page.locator(`#${id} tbody input`).count())fail('Native detail is not empty');for(const value of rows){await page.locator(`button.row-add[data-target="${id}"]`).click();const inputs=page.locator(`#${id} tbody tr`).last().locator('input');if(id==='include'||id==='exclude'){if(await inputs.count()!==2)fail('Unexpected native detail row');await inputs.nth(0).fill(value.name);await inputs.nth(1).fill(value.description);}else await inputs.fill(value);}}
    for(const key of ['include','exclude'])if(args.detail[key+'Note']!==undefined)await page.locator(`#${key} textarea`).fill(args.detail[key+'Note']);await page.locator('#id_real_shopping_count').fill(args.detail.shoppingCount);
    await capture('detail',target.endpoints.detail,target.controls.detailSave,{expected:detailExpected,forward:true,csrf:detailBase.csrf});
    await tab('productreference');if(await page.locator('#reference_body .control[data-type]').count())fail('Native reference is not empty');for(const element of args.reference.elements){await referencePicker.choose(String(element.type));await page.locator('#add_reference_element').click();await page.locator('#reference_body .control[data-type]').last().locator(String(element.type)==='1'?'textarea':'input[type=text]').first().fill(element.text);}
    if(args.reference.images.length){
      await referencePicker.choose('4');await page.locator('#add_reference_element').click();const control=page.locator('#reference_body .control[data-type="4"]').last();
      for(const source of args.reference.images){
        await control.locator('.add_image_popup').click();const modal=page.locator('#content-modal').filter({visible:true});await modal.waitFor({state:'visible'});await modal.locator('#id_alt').fill(source.alt);await modal.locator('.image_upload_container[data-type="pc"] input[type=file]').setInputFiles({name:source.name,mimeType:source.mimeType,buffer:source.bytes});
        const expected={alt:source.alt,'pc-image':{name:source.name,mimeType:source.mimeType,size:source.bytes.length,sha256:source.sha256}};
        const outcome=await capture(`upload:${source.sha256}`,target.endpoints.upload,'#content-modal #save-image',{expected,forward:true,csrf:base.csrf});
        const raw=await outcome.response.json();const receipt=validateDisplayImages([{id:String(raw.id),src:raw.src}],tenant.companyId)[0];
        await record({phase:'upload-receipt',receipt,source:{name:source.name,sha256:source.sha256},target:copy(target)});
        const proof=await args.verifyUploadedImage({receipt:copy(receipt),source:{name:source.name,sha256:source.sha256,alt:source.alt},target:copy(target)});
        if(proof?.sha256!==source.sha256||proof.tenantId!==tenant.companyId||proof.src!==receipt.src)fail('Native uploaded image evidence mismatch');
        const picture=control.locator(`.tr_image_list[data-id="${receipt.id}"] img`);await picture.waitFor({state:'visible',timeout:timeoutMs});if(await picture.count()!==1||await picture.getAttribute('src')!==receipt.src)fail('Native upload attached to wrong control');await modal.waitFor({state:'hidden',timeout:timeoutMs});uploads.push(receipt);
      }
      referenceExpected=expectedReference(referenceBase.body,args.reference,uploads);
    }
    await capture('reference',target.endpoints.reference,target.controls.referenceSave,{expected:referenceExpected,forward:true,csrf:referenceBase.csrf});
    if(useUploads){await tab('base');for(const [name,value] of Object.entries(args.display.fields))await page.locator(`#homepage_post [name="${name}"]`).fill(value);await prepareExistingDisplayImages(page,{images:displayUploads(uploads),companyId:tenant.companyId,query:args.display.imageQuery});displayExpected.image_sort=JSON.stringify({images:displayUploads(uploads).map(x=>x.id)});await capture('display',target.endpoints.display,target.controls.displaySave,{expected:displayExpected,forward:true,csrf:base.csrf});}
    const expected={target:copy(target),display:copy(args.display),detail:copy(args.detail),reference:copy(args.reference),uploads,payloads:{display:displayExpected,detail:detailExpected,reference:referenceExpected}};
    // Reload from the server, then capture native serialization with every POST aborted.
    // This verifies persisted values independently of the filled-in draft and callback.
    pending=null;
    const rootResponse=await page.goto(target.pageUrl,{waitUntil:'domcontentloaded',timeout:timeoutMs});
    if(!rootResponse||rootResponse.status()!==200||rootResponse.url()!==target.pageUrl||rootResponse.fromServiceWorker())fail('Independent master GET failed');
    await assertIdentity();
    const readbacks={};
    for(const [key,tabName] of [['display','base'],['detail','detail'],['reference','productreference']]){await tab(tabName);await page.locator(target.controls[key+'Save']).waitFor({state:'visible',timeout:timeoutMs});const read=await capture(key+'-readback',target.endpoints[key],target.controls[key+'Save']);readbacks[key]=read.body;const approved=expected.payloads[key];let matched=same(read.body,approved);if(key==='display'&&Object.hasOwn(approved,'typeable_char')){const count=['badge1','badge2','badge3'].reduce((n,k)=>n+(approved[k]??'').length,0);matched ||= same(read.body,{...approved,typeable_char:`${count}/15`});}if(!matched)fail('Independent native '+key+' readback mismatch');}
    const displayRefs=useUploads?displayUploads(uploads):approvedImages;
    if(displayRefs.length){await tab('base');await page.waitForFunction(count=>{const pictures=[...document.querySelectorAll('#image_homepage_area .image_list img')];return pictures.length===count&&pictures.every(x=>x.complete&&x.naturalWidth>0);},displayRefs.length,{timeout:timeoutMs});const state=await readDisplayImageState(page);if(!same(state.images.map(({id,src})=>({id,src})),displayRefs))fail('Independent display image identity/order mismatch');}
    const evidence=typeof verifyPersistedContent==='function'?await verifyPersistedContent({target:copy(target),expected:copy(expected)}):{target:copy(target),expected:copy(expected),verified:true};
    await assertIdentity();const verified=evidence?.verified===true&&same(evidence.target,target)&&same(evidence.expected,expected)&&!failed;
    const result={status:verified?'content-verified':'saved-awaiting-verification',target:copy(target),completed,uploads,forwarded,...(verified?{persisted:{payloads:copy(readbacks),images:copy(displayRefs)}}:{})};failed=!verified;await record({phase:'result',...result});return result;
  }catch(error){failed=true;const result={status:'needs-reconciliation',target:copy(target),completed,uploads,forwarded,message:String(error.message)};await record({phase:'result',...result});return result;}
  finally{pending=null;if(failed)await page.context().route('**/*',r=>['GET','HEAD'].includes(r.request().method())?r.fallback():r.abort());await page.context().unroute('**/*',guard);await cdp?.detach().catch(()=>{});}
}
