import {createHash} from 'node:crypto';
import {applyNativeProductContent} from './product-content-native.mjs';
import {isDeepStrictEqual as same} from 'node:util';

const MAX_UPLOAD_BYTES=2_000_000;
const ID=/^[1-9]\d{0,11}$/;
const HASH=/^[a-f0-9]{64}$/;
const DISPLAY_FIELDS=new Set(['short_description','product_description','badge1','badge2','badge3']);
const fail=message=>{throw new Error(message)};
const clone=value=>structuredClone(value);

function exactObject(value,keys,label){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==[...keys].sort().join(','))fail(`Invalid ${label}`);
  return value;
}
function validateTarget(target){
  exactObject(target,['origin','productId','masterCode','pageUrl','endpoints','controls'],'content target');
  if(typeof target.origin!=='string'||new URL(target.origin).origin!==target.origin||!ID.test(target.productId)||typeof target.masterCode!=='string'||!target.masterCode||typeof target.pageUrl!=='string'||new URL(target.pageUrl).origin!==target.origin||new URL(target.pageUrl).hash)fail('Invalid content target');
  exactObject(target.endpoints,['display','detail','reference','upload'],'content endpoints');
  for(const url of Object.values(target.endpoints))if(typeof url!=='string'||new URL(url).origin!==target.origin)fail('Content endpoint origin mismatch');
  exactObject(target.controls,['displaySave','detailSave','referenceSave'],'content controls');
  for(const selector of Object.values(target.controls))if(typeof selector!=='string'||!selector)fail('Invalid content control selector');
  return target;
}
function validateTenant(tenant){
  exactObject(tenant,['companyId','imageUrlPrefix'],'tenant evidence');
  if(typeof tenant.companyId!=='string'||!ID.test(tenant.companyId)||typeof tenant.imageUrlPrefix!=='string')fail('Invalid tenant evidence');
  const expected=`https://media.eoding.com/media/travelagent/${tenant.companyId}/imagecontent/`;
  if(tenant.imageUrlPrefix!==expected)fail('Invalid tenant image prefix');
  return tenant;
}
function hash(bytes){return createHash('sha256').update(bytes).digest('hex')}
function validateUpload(image){
  exactObject(image,['kind','name','mimeType','bytes','sha256','alt'],'upload source');
  if(image.kind!=='upload'||typeof image.name!=='string'||!image.name||/[\\/\0\r\n]/.test(image.name)||typeof image.mimeType!=='string'||!image.mimeType||typeof image.alt!=='string'||!image.alt||!HASH.test(image.sha256)||!Buffer.isBuffer(image.bytes)||!image.bytes.length||image.bytes.length>MAX_UPLOAD_BYTES)fail('Invalid upload source');
  if(hash(image.bytes)!==image.sha256)fail('Approved upload hash mismatch');
  return image;
}
function validatePlan(args){
  const {display,detail,reference,tenant}=args;
  validateTenant(tenant);
  if(!display||typeof display!=='object'||Array.isArray(display)||!display.fields||typeof display.fields!=='object'||Array.isArray(display.fields)||!Array.isArray(display.images)||typeof display.imageQuery!=='string'||!display.imageQuery.trim())fail('Invalid display plan');
  for(const [name,value] of Object.entries(display.fields))if(!DISPLAY_FIELDS.has(name)||typeof value!=='string')fail('Invalid display field');
  if(display.images.length&&args.nativePayloads!==true)fail('Display image selection is unsupported by this adapter; use the dedicated display-image writer before content writes');
  if(!detail||typeof detail!=='object'||Array.isArray(detail)||!['include','exclude','information','mainPoints'].every(key=>Array.isArray(detail[key]))||typeof detail.shoppingCount!=='string'||!/^\d+$/.test(detail.shoppingCount)||!['includeNote','excludeNote'].every(key=>detail[key]===undefined||typeof detail[key]==='string'))fail('Invalid detail plan');
  for(const key of ['include','exclude'])for(const row of detail[key])if(!row||typeof row.name!=='string'||typeof row.description!=='string')fail('Invalid detail row');
  for(const key of ['information','mainPoints'])if(!detail[key].every(value=>typeof value==='string'))fail('Invalid detail text');
  if(!reference||typeof reference!=='object'||Array.isArray(reference)||!Array.isArray(reference.elements)||!Array.isArray(reference.images))fail('Invalid reference plan');
  for(const element of reference.elements)if(!element||!['1','3'].includes(String(element.type))||typeof element.text!=='string')fail('Invalid reference element');
  if(reference.images.some(image=>image?.kind==='existing'))fail('Existing image selection is unsupported by this adapter; use a dedicated image writer before content writes');
  const seenUploads=new Set();
  for(const image of reference.images){
    validateUpload(image);if(seenUploads.has(image.sha256))fail('Duplicate new upload requires an existing receipt');seenUploads.add(image.sha256)
  }
}
async function assertPage(page,target,identity){
  if(!page||typeof page.context!=='function'||typeof page.url!=='function'||page.url()!==target.pageUrl)fail('Content page changed');
  await identity(page,clone(target));
  if(page.url()!==target.pageUrl)fail('Content page changed');
}
async function one(page,selector,label){
  const locator=page.locator(selector);if(await locator.count()!==1)fail(`Missing or ambiguous ${label}`);return locator;
}
async function formFields(page,selector){
  return page.locator(selector).evaluate(form=>[...new FormData(form).entries()].map(([name,value])=>{
    if(typeof value!=='string')throw new Error('Unexpected file form field');return [name,value];
  }));
}
function parseMultipart(contentType,raw){
  const match=typeof contentType==='string'&&/^multipart\/form-data;\s*boundary=(?:"([^"\r\n]+)"|([^\s;\r\n]+))\s*$/i.exec(contentType);
  if(!match||!Buffer.isBuffer(raw)||!raw.length||raw.length>MAX_UPLOAD_BYTES+128*1024)fail('Malformed native multipart');
  const boundary=Buffer.from(`--${match[1]??match[2]}`),sections=[];let cursor=0;
  while(cursor<raw.length){
    const start=raw.indexOf(boundary,cursor);if(start<0)break;const after=start+boundary.length;
    if(raw.subarray(after,after+4).equals(Buffer.from('--\r\n')))break;
    if(!raw.subarray(after,after+2).equals(Buffer.from('\r\n')))fail('Malformed native multipart');
    const next=raw.indexOf(Buffer.concat([Buffer.from('\r\n'),boundary]),after+2);if(next<0)fail('Malformed native multipart');
    const part=raw.subarray(after+2,next),split=part.indexOf(Buffer.from('\r\n\r\n'));if(split<1)fail('Malformed native multipart');
    const headers=part.subarray(0,split).toString('latin1'),body=part.subarray(split+4);if(!body.length&&headers.includes('filename='))fail('Malformed native file');
    const line=headers.split('\r\n');if(line.length<1||line.some(h=>!/^[^:\r\n]+:\s*[^\r\n]*$/.test(h)))fail('Malformed native multipart');
    const disposition=line.find(h=>/^content-disposition:/i.test(h));const field=/\bname="([^"\r\n]+)"/.exec(disposition??'');if(!field)fail('Malformed native multipart');
    const filename=/\bfilename="([^"\r\n]*)"/.exec(disposition);const contentTypeLine=line.find(h=>/^content-type:/i.test(h));
    sections.push({name:field[1],value:filename?undefined:body.toString('utf8'),file:filename?{name:filename[1],mimeType:contentTypeLine?.replace(/^content-type:\s*/i,'')??'',bytes:body}:undefined});cursor=next+2;
  }
  if(!sections.length)fail('Malformed native multipart');return sections;
}
function matchPacket(packet,expected){
  const fields=packet.filter(part=>!part.file).map(part=>[part.name,part.value]);
  if(!same(fields,expected.fields??[]))fail('Native form payload differs from approved form');
  const files=packet.filter(part=>part.file);
  if(!expected.file){if(files.length)fail('Unexpected native file field');return}
  if(files.length!==1||files[0].name!==expected.file.field||files[0].file.name!==expected.file.name||files[0].file.mimeType!==expected.file.mimeType||!same(files[0].file.bytes,expected.file.bytes))fail('Native upload payload differs from approval');
}
function assertCsrf(packet,expected){
  const approved=expected.fields.filter(([name])=>name==='csrfmiddlewaretoken');
  if(!approved.length)return;
  if(approved.length!==1||!approved[0][1])fail('Approved form has no exact CSRF token');
  const csrf=packet.filter(part=>!part.file&&part.name==='csrfmiddlewaretoken');
  if(csrf.length!==1||csrf[0].value!==approved[0][1])fail('Native form payload has no exact CSRF token');
}
function evidenceFields(fields){return fields.filter(([name])=>name!=='csrfmiddlewaretoken')}
async function blockPostWrites(page){
  await page.context().route('**/*',route=>['GET','HEAD'].includes(route.request().method())?route.fallback():route.abort());
}
async function guardedPost(page,{key,url,expected,click,target,identity,beforeWrite,record,timeoutMs=15000}){
  let armed=true,used=false,forwarded=0,guardError=null,response=null;
  const guard=async route=>{
    const request=route.request();if(['GET','HEAD'].includes(request.method()))return route.fallback();
    if(!armed||used||request.method()!=='POST'||request.url()!==url)return route.abort();
    used=true;
    try{
      const packet=parseMultipart(request.headers()['content-type'],request.postDataBuffer());assertCsrf(packet,expected);matchPacket(packet,expected);
      await assertPage(page,target,identity);
      const permit=await beforeWrite({key,target:clone(target),url,form:clone(evidenceFields(expected.fields)),file:expected.file?{name:expected.file.name,sha256:hash(expected.file.bytes)}:undefined});
      if(!permit||permit.durable!==true)fail('Durable beforeWrite callback refused');
      await assertPage(page,target,identity);await record({phase:'attempt',key,target:clone(target),url});forwarded++;await route.fallback();
    }catch(error){guardError=String(error.message);await route.abort().catch(()=>{})}
  };
  await page.context().route('**/*',guard);
  try{
    await assertPage(page,target,identity);
    const wait=page.waitForResponse(candidate=>candidate.request().method()==='POST'&&candidate.url()===url,{timeout:timeoutMs}).then(value=>{response=value},()=>{});
    try{await click();}catch{}await wait;armed=false;
    if(forwarded!==1||guardError||!response||!response.ok())return {status:'needs-reconciliation',key,url,forwarded,guardError,responseStatus:response?.status()??null};
    return {status:'saved',key,url,response};
  }finally{armed=false;await page.context().unroute('**/*',guard)}
}
async function addDetailRows(page,id,rows){
  if(await page.locator(`#${id} tbody input`).count())fail(`Existing ${id} content cannot be overwritten`);
  for(const row of rows){await (await one(page,`button.row-add[data-target="${id}"]`,`add ${id}`)).click();const inputs=page.locator(`#${id} tbody tr`).last().locator('input');if(await inputs.count()!==2)fail(`Unsupported ${id} row layout`);await inputs.nth(0).fill(row.name);await inputs.nth(1).fill(row.description)}
}
async function addTextRows(page,id,values){
  if(await page.locator(`#${id} tbody input`).count())fail(`Existing ${id} content cannot be overwritten`);
  for(const value of values){await (await one(page,`button.row-add[data-target="${id}"]`,`add ${id}`)).click();const input=page.locator(`#${id} tbody input`).last();await input.fill(value)}
}
async function addReferenceElement(page,type,text){
  const before=await page.locator('#reference_body .control[data-type]').count();const select=page.locator('#reference_body .cont_box.reference_element select').last();await select.selectOption(String(type));await (await one(page,'#add_reference_element','reference add control')).click();await page.waitForFunction(count=>document.querySelectorAll('#reference_body .control[data-type]').length===count+1,before);const control=page.locator('#reference_body .control[data-type]').last();if(text!==undefined)await control.locator(String(type)==='1'?'textarea':'input[type=text]').first().fill(text);return control;
}
function assertReceipt(receipt,source,tenant){
  if(!receipt||!ID.test(String(receipt.id))||typeof receipt.src!=='string'||!receipt.src.startsWith(tenant.imageUrlPrefix)||new URL(receipt.src).search||new URL(receipt.src).hash)fail('Upload response has wrong tenant identity');
  if(source&&hash(source.bytes)!==source.sha256)fail('Approved upload hash mismatch');return {id:String(receipt.id),src:receipt.src};
}
async function uploadReferenceImage(page,source,args,uploads){
  const control=await addReferenceElement(page,'4');await (await one(control,'.add_reference_image','new reference image control')).click();const modal=page.locator('#content-modal').filter({visible:true});await modal.waitFor({state:'visible'});if(await modal.count()!==1)fail('Missing or ambiguous upload modal');await modal.locator('#id_alt').fill(source.alt);await modal.locator('.image_upload_container[data-type="pc"] input[type=file]').setInputFiles({name:source.name,mimeType:source.mimeType,buffer:source.bytes});
  const outcome=await guardedPost(page,{key:`upload:${source.sha256}`,url:args.target.endpoints.upload,expected:{fields:[['alt',source.alt]],file:{field:'pc-image',name:source.name,mimeType:source.mimeType,bytes:source.bytes}},click:()=>modal.locator('#save-image').click(),...args});
  if(outcome.status!=='saved')return outcome;
  let raw;try{raw=await outcome.response.json()}catch{return {status:'needs-reconciliation',key:outcome.key,url:outcome.url,forwarded:1,guardError:'Upload response was not JSON',responseStatus:outcome.response.status()}}
  const receipt=assertReceipt(raw,source,args.tenant);const evidence=await args.verifyUploadedImage({receipt:clone(receipt),source:{name:source.name,sha256:source.sha256,alt:source.alt},target:clone(args.target)});
  if(!evidence||evidence.sha256!==source.sha256||evidence.tenantId!==args.tenant.companyId||evidence.src!==receipt.src)fail('Uploaded image evidence mismatch');
  const linked=page.locator(`#reference_body .tr_image_list[data-id="${receipt.id}"] img`);if(await linked.count()!==1||await linked.getAttribute('src')!==receipt.src)fail('Uploaded image was not linked to reference content');uploads.push(receipt);return {status:'saved',key:outcome.key};
}

/**
 * Apply approved master-product display/detail/reference content on the caller's existing page.
 * This adapter opens no browser and never supplies or consumes human approval itself.
 */
export async function applyProductContent(page,args={}){
  const {target,tenant,identity,beforeWrite,record,verifyUploadedImage,verifyPersistedContent,timeoutMs=15000}=args;
  validateTarget(target);if(typeof identity!=='function'||typeof beforeWrite!=='function'||typeof record!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>30000)fail('Identity, durable beforeWrite, record callbacks, and timeout are required');validatePlan(args);
  if(args.reference.images.some(image=>image.kind==='upload')&&typeof verifyUploadedImage!=='function')fail('New uploads require an image evidence callback');
  if(args.nativePayloads===true)return applyNativeProductContent(page,{...args,timeoutMs});
  await assertPage(page,target,identity);
  const uploads=[],completed=[];
  const result=async outcome=>{if(outcome.status!=='content-verified')await blockPostWrites(page);await record({phase:'result',...outcome,target:clone(target)});return {...outcome,target:clone(target),completed,uploads:clone(uploads)}};
  const save=async(key,form,saveSelector,url)=>{const fields=await formFields(page,form);const outcome=await guardedPost(page,{key,url,expected:{fields},click:()=>page.locator(saveSelector).click(),target,identity,beforeWrite,record,timeoutMs});if(outcome.status!=='saved')return outcome;completed.push(key);return outcome};

  const displayForm='#homepage_post';await one(page,displayForm,'display form');for(const [name,value] of Object.entries(args.display.fields)){const field=page.locator(`${displayForm} [name="${name}"]`);if(await field.count()!==1)fail(`Missing or ambiguous display field: ${name}`);await field.fill(value)}
  let outcome=await save('display',displayForm,target.controls.displaySave,target.endpoints.display);if(outcome.status!=='saved')return result(outcome);

  const detailForm='#detail_post';await one(page,detailForm,'detail form');await addDetailRows(page,'include',args.detail.include);await addDetailRows(page,'exclude',args.detail.exclude);await addTextRows(page,'information',args.detail.information);await addTextRows(page,'main-point',args.detail.mainPoints);for(const [key,id] of [['includeNote','include_note'],['excludeNote','exclude_note']])if(args.detail[key]!==undefined){const note=await one(page,`#${id}`,id);await note.fill(args.detail[key])}await (await one(page,'#id_real_shopping_count','shopping count')).fill(args.detail.shoppingCount);
  outcome=await save('detail',detailForm,target.controls.detailSave,target.endpoints.detail);if(outcome.status!=='saved')return result(outcome);

  const referenceForm='#reference_form';await one(page,referenceForm,'reference form');if(await page.locator('#reference_body .control[data-type]').count())fail('Existing reference content cannot be overwritten');for(const element of args.reference.elements)await addReferenceElement(page,element.type,element.text);for(const image of args.reference.images){outcome=await uploadReferenceImage(page,image,{target,tenant,identity,beforeWrite,record,verifyUploadedImage,timeoutMs},uploads);if(outcome.status!=='saved')return result(outcome)}
  outcome=await save('reference',referenceForm,target.controls.referenceSave,target.endpoints.reference);if(outcome.status!=='saved')return result(outcome);
  const expected={target:clone(target),display:clone(args.display),detail:clone(args.detail),reference:clone(args.reference),uploads:clone(uploads)};
  if(typeof verifyPersistedContent!=='function')return result({status:'saved-awaiting-verification'});
  try{
    const evidence=await verifyPersistedContent({target:clone(target),expected:clone(expected)});
    exactObject(evidence,['expected','target','verified'],'content persistence verification');
    if(evidence.verified!==true||!same(evidence.target,target)||!same(evidence.expected,expected))return result({status:'saved-awaiting-verification',verificationError:'Persistence verification did not exactly match the approved content'});
  }catch(error){return result({status:'saved-awaiting-verification',verificationError:String(error.message)})}
  return result({status:'content-verified'});
}

export const productContentAdapterScope=Object.freeze({
  browserOwnership:'caller-supplied same page only',
  approvalOwnership:'caller beforeWrite callback only',
  supported:['allowlisted display text','include/exclude/detail text','reference text','new reference uploads with byte/hash/tenant/readback evidence'],
  unsupported:['all display-image selection/upload and existing reference-image selection (use a dedicated image writer)','overwriting existing display/detail/reference content','production endpoint discovery or human approval'],
});
