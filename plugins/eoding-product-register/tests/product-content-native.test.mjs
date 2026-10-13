import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {createHash} from 'node:crypto';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jY1kAAAAASUVORK5CYII=','base64');
const image={id:'90',src:'https://media.eoding.com/media/travelagent/7/imagecontent/90.png'};
const sha256=createHash('sha256').update(png).digest('hex');
import {applyProductContent} from '../src/product-content-adapter.mjs';
import {verifyApprovedProductOnlyCdnImage} from '../src/product-only-launcher.mjs';
const origin='https://content-fixture.invalid';
const target={origin,productId:'42',masterCode:'TEST42',pageUrl:origin+'/tour/master_product/42/change/',controls:{displaySave:'#save-display',detailSave:'#save-detail',referenceSave:'#save-reference'},endpoints:{display:origin+'/tour/master_product/homepage/42/',detail:origin+'/tour/master_product_detail/42/change/',reference:origin+'/tour/master_product_reference/42/change/',upload:origin+'/contents/image/create_modal/?managed_flag=false'}};
const tenant={companyId:'7',imageUrlPrefix:'https://media.eoding.com/media/travelagent/7/imagecontent/'};
const baselineDetail=Object.fromEntries(Array.from({length:8},(_,i)=>[String(i+1),{type:String(i+1),etc:i<4?'[]':'',etc2:'',etc5:i===7?'0':'',untouched:'KEEP'}]));
const baselineReference=[{type:'15',etc2:'[]',image_group:[],image_append_yn:'N',untouched:'KEEP'}];
function html(saved={}, {jsonUpload=false,headerCsrf=false}={}){const displayCsrf=headerCsrf===false||headerCsrf==='display-body-only'?'<input name="csrfmiddlewaretoken" value="synthetic-token">':'';return `<!doctype html><meta charset="utf-8"><div id="base"><form id="homepage_post">${displayCsrf}<input name="short_description"><input name="image_sort" value='{"images":[]}'><input name="title" value="KEEP"><button type="button" id="save-display">Save display</button></form><button type="button" id="image_popup">Choose images</button><div id="image_homepage_area"></div></div>
<form id="detail_post">${['include','exclude','information','main-point'].map(id=>`<table id="${id}"><tbody></tbody><tfoot><tr><td><textarea></textarea></td></tr></tfoot></table><button type="button" class="row-add" data-target="${id}">Add</button>`).join('')}<input id="id_real_shopping_count" value="0"><button type="button" id="save-detail">Save detail</button></form>
<form id="reference_form"><div id="reference_body"><div class="cont_box reference_element"><select><option value="1">body</option><option value="3">title</option><option value="4">image</option></select></div></div><button type="button" id="add_reference_element">Add</button><button type="button" id="save-reference">Save ref</button></form>
<script>
const detailBaseline=${JSON.stringify(baselineDetail)},referenceBaseline=${JSON.stringify(baselineReference)};
for(const b of document.querySelectorAll('.row-add'))b.onclick=()=>{const n=document.createElement('tr');n.innerHTML=['include','exclude'].includes(b.dataset.target)?'<td><input></td><td><input></td>':'<td><input></td>';document.querySelector('#'+b.dataset.target+' tbody').append(n)};
const csrfMode=${JSON.stringify(headerCsrf)};let displayClicks=0,detailClicks=0,referenceClicks=0,uploadClicks=0;const csrfHeaders=kind=>(csrfMode==='missing'||(csrfMode==='display-body-only'&&kind==='display'))?{}:{'X-CSRFToken':(csrfMode==='form-specific'?{display:'D',detail:'E',reference:'R',upload:'U'}[kind]:((csrfMode==='drift'&&displayClicks>2)||(csrfMode==='detail-drift'&&detailClicks>2)||(csrfMode==='reference-drift'&&referenceClicks>2)||(csrfMode==='upload-drift'&&uploadClicks>1)||(csrfMode==='refreshed-form'&&({display:displayClicks,detail:detailClicks,reference:referenceClicks,upload:uploadClicks}[kind]>1))?'B':'A')).repeat(64)};
const post=(url,body,kind)=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...csrfHeaders(kind)},body:JSON.stringify(body)}).catch(()=>{});
document.querySelector('#save-display').onclick=()=>{displayClicks++;const fd=new FormData(homepage_post);fd.set('image_sort',JSON.stringify({images:[...image_homepage_area.querySelectorAll('.image_list')].map(x=>x.dataset.id)}));fd.append('badge_list','[]');fetch('${target.endpoints.display}',{method:'POST',headers:csrfHeaders('display'),body:fd}).catch(()=>{})};
document.querySelector('#save-detail').onclick=()=>{detailClicks++;const d=structuredClone(detailBaseline);for(const [i,id] of [[1,'include'],[2,'exclude']]){d[i].etc=JSON.stringify([...document.querySelectorAll('#'+id+' tbody tr')].map(tr=>({value:'Direct',label:tr.querySelectorAll('input')[0].value,remark:tr.querySelectorAll('input')[1].value})));d[i].etc2=document.querySelector('#'+id+' textarea').value}for(const [i,id] of [[3,'information'],[4,'main-point']])d[i].etc=JSON.stringify([...document.querySelectorAll('#'+id+' tbody input')].map(x=>({content:x.value})));d[8].etc5=id_real_shopping_count.value;post('${target.endpoints.detail}',d,'detail')};
add_reference_element.onclick=()=>{const type=document.querySelector('.reference_element select').value;const c=document.createElement('div');c.className='control';c.dataset.type=type;c.innerHTML=type==='1'?'<textarea></textarea>':type==='3'?'<input type="text">':'<button type="button" class="add_image_popup">Upload</button>';reference_body.append(c);if(type==='4')c.querySelector('button').onclick=()=>uploadModal(c)};
document.querySelector('#save-reference').onclick=()=>{referenceClicks++;const r=structuredClone(referenceBaseline);r[0].etc2=JSON.stringify([...reference_body.querySelectorAll('.control')].map(c=>({type:Number(c.dataset.type),contents:c.dataset.type==='4'?1:c.dataset.type==='3'?c.querySelector('input').value:[{detail:c.querySelector('textarea').value,font_color:'0',bold_flag:'0'}]})));if(reference_body.querySelector('.tr_image_list')){r[0].image_append_yn='Y';r[0].image_group=[{group_id:1,image_list:[...reference_body.querySelectorAll('.tr_image_list')].map(x=>({image_id:x.dataset.id,image_url:''}))}]}post('${target.endpoints.reference}',r,'reference')};
const jsonUpload=${JSON.stringify(jsonUpload)};function uploadModal(c){document.querySelector('#content-modal')?.remove();document.body.insertAdjacentHTML('beforeend','<div id="content-modal"><input id="id_alt"><div class="image_upload_container" data-type="pc"><input type="file"></div><button id="save-image">Upload</button></div>');const m=document.querySelector('#content-modal');m.querySelector('#save-image').onclick=async()=>{const fd=new FormData();fd.append('alt',m.querySelector('#id_alt').value);fd.append('pc-image',m.querySelector('input[type=file]').files[0]);if(!csrfMode)fd.append('csrfmiddlewaretoken','synthetic-token');const file=m.querySelector('input[type=file]').files[0],body=jsonUpload?JSON.stringify({alt:m.querySelector('#id_alt').value,'pc-image':{name:file.name,mimeType:file.type,size:file.size,sha256:'${sha256}'}}):fd;uploadClicks++;const res=await fetch('${target.endpoints.upload}',{method:'POST',headers:jsonUpload?{'Content-Type':'application/json',...csrfHeaders('upload')}:csrfHeaders('upload'),body});const im=await res.json();c.insertAdjacentHTML('beforeend','<div class="tr_image_list" data-id="'+im.id+'"><img src="'+im.src+'"></div>');m.hidden=true}}
let drawHandlers=[];const emit=()=>{const hs=drawHandlers;drawHandlers=[];queueMicrotask(()=>hs.forEach(h=>h()))};
const api={settings:()=>[{_bInitComplete:true}],page:{info:()=>({recordsDisplay:1}),len:()=>({draw:()=>emit()})}};window.jQuery=()=>({DataTable:()=>api,one:(event,cb)=>drawHandlers.push(cb)});window.jQuery.fn={dataTable:{isDataTable:()=>true}};
image_popup.onclick=()=>{document.querySelector('#content-modal')?.remove();document.body.insertAdjacentHTML('beforeend','<div id="content-modal"><input id="id_title"><button class="search">Search</button><div id="modal_table"><table><tbody><tr><td><button class="select-row" data-id="90" data-src="${image.src}">Select</button></td></tr></tbody></table></div><div id="selected_image_area"></div><button id="import-image-btn">Import</button></div>');const m=document.querySelector('#content-modal');m.querySelector('.search').onclick=emit;m.querySelector('.select-row').onclick=()=>m.querySelector('#selected_image_area').innerHTML='<img class="import-image" data-id="90" src="${image.src}">';m.querySelector('#import-image-btn').onclick=()=>{image_homepage_area.innerHTML='<div class="image_list" data-id="90"><img src="${image.src}"></div>';m.hidden=true}};
const persisted=${JSON.stringify(saved)};
if(persisted.display){for(const [key,value] of Object.entries(persisted.display)){const f=homepage_post.querySelector('[name="'+key+'"]');if(f)f.value=value;}const ids=JSON.parse(persisted.display.image_sort).images;image_homepage_area.innerHTML=ids.map(id=>'<div class="image_list" data-id="'+id+'"><img src="${image.src}"></div>').join('');}
if(persisted.detail){Object.assign(detailBaseline,persisted.detail);for(const [id,key] of [[1,'include'],[2,'exclude'],[3,'information'],[4,'main-point']]){for(const row of JSON.parse(persisted.detail[id].etc)){document.querySelector('button.row-add[data-target="'+key+'"]').click();const inputs=document.querySelector('#'+key+' tbody tr:last-child').querySelectorAll('input');inputs[0].value=id<3?row.label:row.content;if(id<3)inputs[1].value=row.remark;}document.querySelector('#'+key+' textarea').value=persisted.detail[id].etc2;}id_real_shopping_count.value=persisted.detail[8].etc5;}
if(persisted.reference){referenceBaseline.splice(0,referenceBaseline.length,...persisted.reference);for(const el of JSON.parse(persisted.reference[0].etc2)){document.querySelector('.reference_element select').value=String(el.type);add_reference_element.click();const c=reference_body.lastElementChild;if(el.type===4)for(const im of persisted.reference[0].image_group.find(g=>g.group_id===el.contents).image_list)c.insertAdjacentHTML('beforeend','<div class="tr_image_list" data-id="'+im.image_id+'"><img src="https://media.eoding.com/media/travelagent/7/imagecontent/'+im.image_id+'.png"></div>');else c.querySelector(el.type===3?'input':'textarea').value=el.type===3?el.contents:el.contents[0].detail;}}
</script>`}
async function fixture(t,{dropPersistence=false,lostUpload=false,jsonUpload=false,headerCsrf=false,seed={}}={}){const browser=await chromium.launch({headless:true,args:['--host-resolver-rules=MAP * ~NOTFOUND']});t.after(()=>browser.close());const ctx=await browser.newContext({serviceWorkers:'block'});const writes=[],saved=structuredClone(seed);let gets=0;await ctx.route('**/*',async r=>{const req=r.request();if(req.method()==='GET'&&req.url()===target.pageUrl){gets++;return r.fulfill({contentType:'text/html',body:html(dropPersistence?{}:saved,{jsonUpload,headerCsrf})})}if(req.url()===image.src)return r.fulfill({contentType:'image/png',body:png});if(req.method()==='POST'){writes.push({url:req.url(),body:req.postData()});const kind=Object.entries(target.endpoints).find(([,url])=>url===req.url())?.[0];if(kind==='upload'&&lostUpload)return r.abort();if(['detail','reference'].includes(kind))saved[kind]=JSON.parse(req.postData());if(kind==='display'){const fd=await new Response(req.postDataBuffer(),{headers:{'content-type':req.headers()['content-type']}}).formData();saved.display=Object.fromEntries([...fd].filter(([key])=>key!=='csrfmiddlewaretoken'));}return r.fulfill({status:200,contentType:'application/json',body:kind==='upload'?JSON.stringify(image):'{}'})}return r.abort()});const page=await ctx.newPage();await page.goto(target.pageUrl);return {page,writes,getCount:()=>gets};}
function args(){return {target,tenant,timeoutMs:1500,nativePayloads:true,identity:async()=>{},beforeWrite:async()=>({durable:true}),record:async()=>{},display:{fields:{short_description:'승인 소개'},images:[],imageQuery:'image'},detail:{include:[{name:'왕복항공',description:'포함'}],exclude:[],information:['안내'],mainPoints:['관광'],shoppingCount:'0',includeNote:'항공포함'},reference:{elements:[{type:'3',text:'제목'},{type:'1',text:'본문'}],images:[]},verifyPersistedContent:async({target,expected})=>({target,expected,verified:true})}}
test('native waits for page load before clicking an initially visible save control',async t=>{
 const f=await fixture(t);
 await f.page.context().route(origin+'/slow-ready.png',async r=>{await new Promise(resolve=>setTimeout(resolve,700));await r.fulfill({contentType:'image/png',body:png});});
 const delayed=html()+`<img src="/slow-ready.png"><script>const saveButton=document.querySelector('#save-display'),handler=saveButton.onclick;saveButton.onclick=null;window.addEventListener('load',()=>{saveButton.onclick=handler;},{once:true});</script>`;
 await f.page.context().route(target.pageUrl,r=>r.fulfill({contentType:'text/html',body:delayed}),{times:1});
 await f.page.goto(target.pageUrl,{waitUntil:'domcontentloaded'});
 assert.equal(await f.page.evaluate(()=>document.readyState),'interactive');
 const result=await applyProductContent(f.page,args());
 assert.equal(result.status,'content-verified',JSON.stringify(result));
 assert.equal(f.writes.length,3);
});

test('native save and final reread wait for the selected asynchronous tab behind a shared save button',async t=>{
 const {readNativeProductContent}=await import('../src/product-content-final-read.mjs');
 const f=await fixture(t);
 function delayedTabs(){
  const install=()=>{
   const forms={base:document.querySelector('#homepage_post'),detail:document.querySelector('#detail_post'),productreference:document.querySelector('#reference_form')};
   // Real ERP detail rows have no dedicated form ID; only #include is observed.
   forms.detail.removeAttribute('id');
   const buttons={base:document.querySelector('#save-display'),detail:document.querySelector('#save-detail'),productreference:document.querySelector('#save-reference')};
   document.body.insertAdjacentHTML('afterbegin','<nav>'+Object.keys(forms).map(key=>'<a href="#'+key+'">'+key+'</a>').join(' ')+'</nav><button id="shared-native-save" type="button">Save selected tab</button>');
   let active=null;window.earlyNativeSaveClicks=0;
   for(const [key,form] of Object.entries(forms)){
    form.hidden=true;
    document.querySelector('a[href="#'+key+'"]').onclick=event=>{
     event.preventDefault();active=null;for(const value of Object.values(forms))value.hidden=true;
     setTimeout(()=>{form.hidden=false;active=key;},120);
    };
   }
   document.querySelector('#shared-native-save').onclick=()=>{if(active)buttons[active].click();else window.earlyNativeSaveClicks++;};
  };
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install,{once:true});else install();
 }
 await f.page.addInitScript(delayedTabs);await f.page.evaluate(delayedTabs);
 const a=args();a.timeoutMs=2000;a.target={...target,controls:{displaySave:'#shared-native-save',detailSave:'#shared-native-save',referenceSave:'#shared-native-save'}};
 const receipt=await applyProductContent(f.page,a);
 assert.equal(receipt.status,'content-verified',JSON.stringify(receipt));
 assert.deepEqual(f.writes.map(write=>write.url),[target.endpoints.display,target.endpoints.detail,target.endpoints.reference]);
 const reread=await readNativeProductContent(f.page,{receipt,identity:async()=>{},timeoutMs:2000});
 assert.deepEqual(reread.persisted,receipt.persisted);assert.equal(f.writes.length,3);
 assert.equal(await f.page.evaluate(()=>window.earlyNativeSaveClicks),0);
 assert.equal(await f.page.locator('#homepage_post').isVisible(),true);
});

test('unsupported hidden reference picker blocks before any content write',async t=>{
 const f=await fixture(t);let permits=0;
 await f.page.locator('#reference_body .reference_element select').evaluate(el=>el.style.display='none');
 const result=await applyProductContent(f.page,{...args(),beforeWrite:async()=>{permits++;return {durable:true};}});
 assert.equal(f.writes.length,0,'no display/detail/upload POST before reference readiness');
 assert.equal(permits,0);
 assert.deepEqual(result.completed,[]);
 assert.equal(result.forwarded,0);
 assert.match(result.message,/Unsupported native reference picker/);
});

test('native content preserves JSON detail/reference baselines and saves each exactly once',async t=>{const f=await fixture(t),events=[];const result=await applyProductContent(f.page,{...args(),beforeWrite:async e=>{events.push(e);return {durable:true}},record:async e=>{events.push(e)}});assert.equal(result.status,'content-verified',JSON.stringify(result));assert.deepEqual(f.writes.map(w=>w.url),[target.endpoints.display,target.endpoints.detail,target.endpoints.reference]);const detail=JSON.parse(f.writes[1].body),ref=JSON.parse(f.writes[2].body);assert.equal(detail['1'].etc2,'항공포함');assert.equal(detail['8'].untouched,'KEEP');assert.equal(ref[0].untouched,'KEEP');assert.equal(JSON.parse(ref[0].etc2)[1].contents[0].detail,'본문');assert.ok(!JSON.stringify({result,events}).includes('synthetic-token'));assert.ok(!JSON.stringify({result,events}).includes('A'.repeat(64)));});

test('one approved upload supplies reference and display IDs on the same page',async t=>{const f=await fixture(t);const a=args();a.timeoutMs=1000;a.display.useReferenceUploads=true;a.reference.images=[{kind:'upload',name:'approved.png',mimeType:'image/png',bytes:png,sha256,alt:'승인 이미지'}];a.verifyUploadedImage=async({receipt})=>({tenantId:'7',src:receipt.src,sha256});const result=await applyProductContent(f.page,a);assert.equal(result.status,'content-verified',JSON.stringify(result));assert.deepEqual(result.uploads,[image]);assert.deepEqual(result.persisted.images,[image]);assert.equal(result.persisted.payloads.detail['1'].etc2,'항공포함');assert.deepEqual(f.writes.map(w=>w.url),[target.endpoints.detail,target.endpoints.upload,target.endpoints.reference,target.endpoints.display]);const ref=JSON.parse(f.writes[2].body);assert.deepEqual(ref[0].image_group,[{group_id:1,image_list:[{image_id:'90',image_url:''}]}]);assert.match(f.writes[3].body,/\{"images":\["90"\]\}/);assert.equal(await f.page.locator('#image_homepage_area .image_list[data-id="90"]').count(),1);});

test('native upload passes the approved MIME to the production CDN verifier',async t=>{
 const f=await fixture(t),a=args();let cdnReads=0;
 a.display.useReferenceUploads=true;a.reference.images=[{kind:'upload',name:'approved.png',mimeType:'image/png',bytes:png,sha256,alt:'Approved fixture'}];
 a.verifyUploadedImage=value=>verifyApprovedProductOnlyCdnImage({...value,companyId:tenant.companyId,fetchImpl:async(url,options)=>{
  cdnReads++;assert.equal(String(url),image.src);assert.equal(options.headers.Accept,'image/png');assert.equal(options.credentials,'omit');
  return {ok:true,url:String(url),redirected:false,headers:new Headers({'content-type':'image/png'}),body:new Response(png).body};
 }});
 const result=await applyProductContent(f.page,a);
 assert.equal(result.status,'content-verified',JSON.stringify(result));assert.equal(cdnReads,1);assert.deepEqual(result.uploads,[image]);
 assert.deepEqual(f.writes.map(w=>w.url),[target.endpoints.detail,target.endpoints.upload,target.endpoints.reference,target.endpoints.display]);
});

for(const entry of ['native','media-adapter'])test(`${entry} explicit upload subset keeps detail-only images out of display after independent reload`,async t=>{
 const f=await fixture(t),a=args(),second={id:'91',src:image.src.replace('90.png','91.png')};let uploads=0;
 f.page.setDefaultTimeout(2000);
 const bytes2=Buffer.concat([png,Buffer.from([0])]),hash2=createHash('sha256').update(bytes2).digest('hex');
 await f.page.context().route(second.src,r=>r.fulfill({contentType:'image/png',body:bytes2}));
 await f.page.context().route(target.endpoints.upload,r=>{f.writes.push({url:r.request().url(),body:r.request().postData()});return r.fulfill({json:uploads++===0?image:second});});
 a.display.useReferenceUploads=true;a.display.uploadIndexes=[0];
 a.reference.images=[{kind:'upload',name:'cover.png',mimeType:'image/png',bytes:png,sha256,alt:'표지'},
  {kind:'upload',name:'detail.png',mimeType:'image/png',bytes:bytes2,sha256:hash2,alt:'긴 상세'}];
 a.verifyUploadedImage=async({receipt,source})=>({tenantId:'7',src:receipt.src,sha256:source.sha256});
 let result;
 if(entry==='native')result=await applyProductContent(f.page,a);
 else {
  const {createProductOnlyMediaAdapter}=await import('../src/product-only-media.mjs');
  const p={target:{mode:'NEW',productId:42,masterCode:'TEST42'},companyId:'7',source:{images:a.reference.images.map(({kind,bytes,...s},i)=>({...s,id:'source-'+i}))},display:{fields:a.display.fields,imageQuery:'cover',sourceMode:'reference-subset',images:[{sourceImageId:'source-0'}]},content:{detail:a.detail,elements:a.reference.elements},approvalBinding:{planDigest:'a'.repeat(64),scopeDigest:'b'.repeat(64)}};
  const c={targets:p.target,approvalBinding:p.approvalBinding,approvalClaim:{...p.approvalBinding,target:{mode:'NEW'}},verifiedPreviousPhases:[{name:'basic',receipt:{productId:42,masterCode:'TEST42'}}]};
  const adapter=createProductOnlyMediaAdapter({origin,assertIdentity:async()=>{},authorizeWrite:async()=>({durable:true}),record:async()=>{},loadImage:async s=>s.id==='source-0'?png:bytes2,verifyUploadedImage:a.verifyUploadedImage,controls:target.controls,timeoutMs:1500});
  result=await adapter.save(f.page,p,c);assert.equal(await adapter.verifyReceipt(f.page,result,c),true);
 }
 assert.equal(result.status,'content-verified',JSON.stringify(result));
 assert.equal(uploads,2);assert.deepEqual(result.persisted.images,[image]);
 assert.deepEqual(result.persisted.payloads.reference[0].image_group[0].image_list.map(x=>x.image_id),['90','91']);
 assert.deepEqual(JSON.parse(result.persisted.payloads.display.image_sort).images,['90']);
 assert.ok(f.getCount()>=2);
});

test('native success requires a fresh page GET, not an approving callback alone',async t=>{const f=await fixture(t,{dropPersistence:true});const result=await applyProductContent(f.page,args());assert.notEqual(result.status,'content-verified');assert.equal(f.writes.length,3);assert.ok(f.getCount()>=2);await f.page.evaluate(url=>fetch(url,{method:'POST',body:'late'}).catch(()=>{}),target.endpoints.display);assert.equal(f.writes.length,3);});

test('native existing display images use the dedicated picker without another upload',async t=>{const f=await fixture(t);const a=args();a.timeoutMs=1000;a.display.images=[image];const result=await applyProductContent(f.page,a);assert.equal(result.status,'content-verified',JSON.stringify(result));assert.equal(f.writes.length,3);assert.ok(f.getCount()>=2);});
test('a lost native upload stops before reference/display saves and blocks another invocation',async t=>{const f=await fixture(t,{lostUpload:true});const a=args();a.timeoutMs=300;a.display.useReferenceUploads=true;a.reference.images=[{kind:'upload',name:'approved.png',mimeType:'image/png',bytes:png,sha256,alt:'승인 이미지'}];a.verifyUploadedImage=async()=>{throw Error('not reached')};const result=await applyProductContent(f.page,a);assert.equal(result.status,'needs-reconciliation');assert.deepEqual(f.writes.map(x=>x.url),[target.endpoints.detail,target.endpoints.upload]);await f.page.evaluate(url=>fetch(url,{method:'POST',body:'late'}).catch(()=>{}),target.endpoints.upload);assert.equal(f.writes.length,2);const next=await applyProductContent(f.page,a);assert.equal(next.status,'needs-reconciliation');assert.equal(f.writes.length,2);});

test('native rejects JSON upload metadata before any upload bytes can be accepted',async t=>{const f=await fixture(t,{jsonUpload:true});const a=args();a.display.useReferenceUploads=true;a.reference.images=[{kind:'upload',name:'approved.png',mimeType:'image/png',bytes:png,sha256,alt:'승인 이미지'}];a.verifyUploadedImage=async()=>{throw Error('not reached')};const result=await applyProductContent(f.page,a);assert.equal(result.status,'needs-reconciliation');assert.match(result.message,/Native upload must be multipart/);assert.deepEqual(f.writes.map(x=>x.url),[target.endpoints.detail]);});

async function nativeMobileUploadFields(page,fields){
 await page.evaluate(({url,fields})=>{
  const fetch=window.fetch.bind(window);
  window.fetch=(input,init)=>{
   if(String(input)===url&&init?.body instanceof FormData){
    for(const field of fields)init.body.append(field.name,field.file?new File([field.value],field.file,{type:'image/png'}):field.value);
   }
   return fetch(input,init);
  };
 },{url:target.endpoints.upload,fields});
}
function nativeUploadArgs(){
 const a=args();a.display.useReferenceUploads=true;
 a.reference.images=[{kind:'upload',name:'approved.png',mimeType:'image/png',bytes:png,sha256,alt:'승인 이미지'}];
 a.verifyUploadedImage=async({receipt})=>({tenantId:'7',src:receipt.src,sha256});return a;
}
test('native upload accepts the exact absent mobile-image sentinel without changing approved PC bytes',async t=>{
 const f=await fixture(t);await nativeMobileUploadFields(f.page,[{name:'mobile-image',value:'null'}]);
 const authorizations=[],a=nativeUploadArgs();a.beforeWrite=async event=>{authorizations.push(event);return {durable:true};};
 const result=await applyProductContent(f.page,a);
 assert.equal(result.status,'content-verified',JSON.stringify(result));
 const approved=authorizations.find(event=>event.url===target.endpoints.upload).payload;
 assert.deepEqual(approved,{alt:'승인 이미지','pc-image':{name:'approved.png',mimeType:'image/png',size:png.length,sha256}});
 assert.match(f.writes.find(write=>write.url===target.endpoints.upload).body,/name="mobile-image"\r\n\r\nnull\r\n/);
 assert.deepEqual(result.uploads,[image]);
 assert.deepEqual(f.writes.map(write=>write.url),[target.endpoints.detail,target.endpoints.upload,target.endpoints.reference,target.endpoints.display]);
});
for(const [label,fields,error] of [
 ['nonempty text',[{name:'mobile-image',value:'unexpected'}],/differs from approved delta/],
 ['empty text',[{name:'mobile-image',value:''}],/differs from approved delta/],
 ['a file even when its contents say null',[{name:'mobile-image',value:'null',file:'mobile.png'}],/differs from approved delta/],
 ['duplicate absent sentinels',[{name:'mobile-image',value:'null'},{name:'mobile-image',value:'null'}],/Duplicate upload field/],
 ['an additional unapproved field',[{name:'mobile-image',value:'null'},{name:'other-image',value:'null'}],/differs from approved delta/]
])test(`native upload rejects ${label} before forwarding image bytes`,async t=>{
 const f=await fixture(t);await nativeMobileUploadFields(f.page,fields);
 const result=await applyProductContent(f.page,nativeUploadArgs());
 assert.equal(result.status,'needs-reconciliation');assert.match(result.message,error);
 assert.deepEqual(f.writes.map(write=>write.url),[target.endpoints.detail]);
 assert.deepEqual(result.uploads,[]);
});

test('native rejects a fragment target URL before any writes',async t=>{const f=await fixture(t),a=args();a.target={...target,pageUrl:target.pageUrl+'#draft'};await assert.rejects(applyProductContent(f.page,a),/Invalid content target/);assert.equal(f.writes.length,0);});

test('native enables cache and service-worker bypass before authorizing writes',async t=>{const f=await fixture(t),commands=[],context=f.page.context(),open=context.newCDPSession.bind(context);context.newCDPSession=async page=>{const session=await open(page),send=session.send.bind(session);session.send=async(method,params)=>{commands.push([method,params]);return send(method,params)};return session};const a=args();a.beforeWrite=async()=>{assert.deepEqual(commands.filter(([method])=>method.startsWith('Network.set')),[['Network.setCacheDisabled',{cacheDisabled:true}],['Network.setBypassServiceWorker',{bypass:true}]]);return {durable:true}};const result=await applyProductContent(f.page,a);assert.equal(result.status,'content-verified',JSON.stringify(result));});

test('coordinator media adapter binds receipt IDs and source hashes without another approval',async t=>{const {createProductOnlyMediaAdapter}=await import('../src/product-only-media.mjs');const f=await fixture(t);let authorizations=0;const a=args(),plan={target:{mode:'NEW',productId:42,masterCode:'TEST42'},companyId:'7',source:{images:[{id:'s1',name:'approved.png',mimeType:'image/png',sha256,alt:'승인 이미지'}]},display:{fields:a.display.fields,imageQuery:'approved',images:[{sourceImageId:'s1'}]},content:{detail:a.detail,elements:a.reference.elements},approvalBinding:{planDigest:'a'.repeat(64),scopeDigest:'b'.repeat(64)}};const context={targets:plan.target,approvalBinding:plan.approvalBinding,approvalClaim:{...plan.approvalBinding,target:{mode:'NEW'}},verifiedPreviousPhases:[{name:'basic',receipt:{productId:42,masterCode:'TEST42'}}]};const adapter=createProductOnlyMediaAdapter({origin,assertIdentity:async()=>{},authorizeWrite:async(e,c)=>{authorizations++;assert.deepEqual(c.approvalBinding,plan.approvalBinding);return {durable:true}},record:async()=>{},loadImage:async()=>png,verifyUploadedImage:async({receipt})=>({tenantId:'7',src:receipt.src,sha256}),controls:target.controls,timeoutMs:1500});const receipt=await adapter.save(f.page,plan,context);assert.equal(receipt.status,'content-verified',JSON.stringify(receipt));assert.equal(await adapter.verifyReceipt(f.page,receipt,context),true);assert.equal(authorizations,4);assert.equal(f.writes.length,4);assert.deepEqual(adapter.covers,['display','content']);assert.ok(f.getCount()>=2);});

test('native header-only CSRF matches observed ERP and verifies persisted content',async t=>{const f=await fixture(t,{headerCsrf:true});const result=await applyProductContent(f.page,args());assert.equal(result.status,'content-verified',JSON.stringify(result));assert.equal(f.writes.length,3);assert.ok(!JSON.stringify(result).includes('A'.repeat(64)));});
test('native legacy body-only display CSRF remains supported while JSON uses headers',async t=>{const f=await fixture(t,{headerCsrf:'display-body-only'});const result=await applyProductContent(f.page,args());assert.equal(result.status,'content-verified',JSON.stringify(result));assert.equal(f.writes.length,3);});
test('native missing both CSRF channels blocks all writes',async t=>{const f=await fixture(t,{headerCsrf:'missing'});const result=await applyProductContent(f.page,args());assert.equal(result.status,'needs-reconciliation');assert.match(result.message,/CSRF/);assert.equal(f.writes.length,0);});
test('native header CSRF drift after preparation blocks all writes',async t=>{const f=await fixture(t,{headerCsrf:'drift'});const result=await applyProductContent(f.page,args());assert.equal(result.status,'needs-reconciliation');assert.match(result.message,/Native content CSRF changed/);assert.equal(f.writes.length,0);});
test('native detail header CSRF drift after same-form preparation blocks JSON save',async t=>{const f=await fixture(t,{headerCsrf:'detail-drift'});const result=await applyProductContent(f.page,args());assert.equal(result.status,'needs-reconciliation');assert.match(result.message,/Native content CSRF changed/);assert.deepEqual(f.writes.map(w=>w.url),[target.endpoints.display]);});
test('native reference header CSRF drift after same-form preparation blocks reference save',async t=>{const f=await fixture(t,{headerCsrf:'reference-drift'});const result=await applyProductContent(f.page,args());assert.equal(result.status,'needs-reconciliation');assert.match(result.message,/Native content CSRF changed/);assert.deepEqual(f.writes.map(w=>w.url),[target.endpoints.display,target.endpoints.detail]);});
test('native upload header CSRF drift after same-modal preparation blocks upload forwarding',async t=>{const f=await fixture(t,{headerCsrf:'upload-drift'}),a=args();a.display.useReferenceUploads=true;a.reference.images=[{kind:'upload',name:'approved.png',mimeType:'image/png',bytes:png,sha256,alt:'승인 이미지'}];a.verifyUploadedImage=async()=>{throw Error('not reached')};const result=await applyProductContent(f.page,a);assert.equal(result.status,'needs-reconciliation');assert.match(result.message,/Native content CSRF changed/);assert.deepEqual(f.writes.map(w=>w.url),[target.endpoints.detail]);});

test('native upload binds its own masked CSRF rather than another form token',async t=>{
 const f=await fixture(t,{headerCsrf:'form-specific'}),events=[],a=nativeUploadArgs();a.record=async event=>events.push(event);
 const result=await applyProductContent(f.page,a);
 assert.equal(result.status,'content-verified',JSON.stringify(result));
 assert.deepEqual(f.writes.map(write=>write.url),[target.endpoints.detail,target.endpoints.upload,target.endpoints.reference,target.endpoints.display]);
 assert.equal(result.forwarded,4);
 for(const token of ['D','E','R','U'])assert.ok(!JSON.stringify({result,events}).includes(token.repeat(64)));
});
test('native refreshed form masks are rebound only before the final same-form preparation',async t=>{
 const f=await fixture(t,{headerCsrf:'refreshed-form'}),events=[];
 const result=await applyProductContent(f.page,{...args(),record:async event=>events.push(event)});
 assert.equal(result.status,'content-verified',JSON.stringify(result));assert.equal(f.writes.length,3);
 assert.ok(!JSON.stringify({result,events}).includes('B'.repeat(64)));
});
for(const mode of ['body-only','header-and-body'])test(`native ${mode} upload CSRF can differ from header-only display and detail forms`,async t=>{
 const f=await fixture(t,{headerCsrf:true});
 await f.page.evaluate(({url,mode})=>{
  const fetch=window.fetch.bind(window);window.fetch=(input,init)=>{
   if(String(input)===url){if(mode==='body-only'){const headers=new Headers(init.headers);headers.delete('X-CSRFToken');init.headers=headers;}init.body.append('csrfmiddlewaretoken','independent-upload-body-token');}
   return fetch(input,init);
  };
 },{url:target.endpoints.upload,mode});
 const result=await applyProductContent(f.page,nativeUploadArgs());
 assert.equal(result.status,'content-verified',JSON.stringify(result));assert.equal(f.writes.length,4);
 assert.ok(!JSON.stringify(result).includes('independent-upload-body-token'));
});
for(const change of ['CSRF channel','approved PC bytes'])test(`native upload still rejects changed ${change} after the current-modal probe`,async t=>{
 const f=await fixture(t,{headerCsrf:true});
 await f.page.evaluate(({url,change})=>{
  const fetch=window.fetch.bind(window);let calls=0;window.fetch=(input,init)=>{
   if(String(input)===url&&++calls===2){
    if(change==='CSRF channel'){const headers=new Headers(init.headers);headers.delete('X-CSRFToken');init.headers=headers;init.body.append('csrfmiddlewaretoken','changed-channel-token');}
    else init.body.set('pc-image',new File(['changed-bytes'],'approved.png',{type:'image/png'}));
   }
   return fetch(input,init);
  };
 },{url:target.endpoints.upload,change});
 const result=await applyProductContent(f.page,nativeUploadArgs());
 assert.equal(result.status,'needs-reconciliation');
 assert.match(result.message,change==='CSRF channel'?/Native content CSRF changed/:/differs from approved delta/);
 assert.deepEqual(f.writes.map(write=>write.url),[target.endpoints.detail]);assert.deepEqual(result.uploads,[]);
});
test('native header-only upload matches the header-only display baseline',async t=>{const f=await fixture(t,{headerCsrf:true}),a=args();a.display.useReferenceUploads=true;a.reference.images=[{kind:'upload',name:'approved.png',mimeType:'image/png',bytes:png,sha256,alt:'승인 이미지'}];a.verifyUploadedImage=async({receipt})=>({tenantId:'7',src:receipt.src,sha256});const result=await applyProductContent(f.page,a);assert.equal(result.status,'content-verified',JSON.stringify(result));assert.deepEqual(f.writes.map(w=>w.url),[target.endpoints.detail,target.endpoints.upload,target.endpoints.reference,target.endpoints.display]);assert.ok(!JSON.stringify(result).includes('A'.repeat(64)));});
test('native empty legacy body CSRF is rejected even with a valid header',async t=>{const f=await fixture(t);await f.page.locator('#homepage_post [name="csrfmiddlewaretoken"]').fill('');const result=await applyProductContent(f.page,args());assert.equal(result.status,'needs-reconciliation');assert.match(result.message,/CSRF/);assert.equal(f.writes.length,0);});
test('native duplicate legacy body CSRF is rejected even with a valid header',async t=>{const f=await fixture(t);await f.page.locator('#homepage_post').evaluate(form=>form.insertAdjacentHTML('beforeend','<input name="csrfmiddlewaretoken" value="duplicate">'));const result=await applyProductContent(f.page,args());assert.equal(result.status,'needs-reconciliation');assert.match(result.message,/Duplicate native CSRF/);assert.equal(f.writes.length,0);});
test('native malformed legacy body CSRF field is rejected even with a valid header',async t=>{const f=await fixture(t);await f.page.locator('#homepage_post').evaluate(form=>form.insertAdjacentHTML('beforeend','<input type="file" name="csrfmiddlewaretoken">'));await f.page.locator('#homepage_post input[type="file"][name="csrfmiddlewaretoken"]').setInputFiles({name:'csrf.txt',mimeType:'text/plain',buffer:Buffer.from('invalid')});const result=await applyProductContent(f.page,args());assert.equal(result.status,'needs-reconciliation');assert.match(result.message,/Malformed display multipart/);assert.equal(f.writes.length,0);});

test('native whitespace-only body CSRF is rejected even with a valid header',async t=>{
 const f=await fixture(t);await f.page.locator('[name="csrfmiddlewaretoken"]').fill('   ');
 const result=await applyProductContent(f.page,args());
 assert.equal(result.status,'needs-reconciliation');assert.match(result.message,/CSRF/);assert.equal(f.writes.length,0);
});
test('native malformed JSON never exposes token text in errors or callbacks',async t=>{
 const f=await fixture(t),secret='CSRF_SECRET_SENTINEL',events=[];
 await f.page.evaluate(({url,secret})=>{document.querySelector('#save-detail').onclick=()=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-CSRFToken':secret},body:secret}).catch(()=>{});},{url:target.endpoints.detail,secret});
 const result=await applyProductContent(f.page,{...args(),record:async e=>events.push(e),beforeWrite:async e=>{events.push(e);return {durable:true};}});
 assert.equal(result.status,'needs-reconciliation');assert.equal(f.writes.length,0);
 assert.ok(!JSON.stringify({result,events}).includes(secret),'malformed JSON error leaked token text');
});

test('final native reread checks persisted payloads without forwarding another POST',async t=>{const {readNativeProductContent}=await import('../src/product-content-final-read.mjs');const f=await fixture(t),a=args();const receipt=await applyProductContent(f.page,a);const before=f.writes.length;const read=await readNativeProductContent(f.page,{receipt,identity:async()=>{},timeoutMs:1500});assert.deepEqual(read.persisted,receipt.persisted);assert.equal(f.writes.length,before);assert.ok(!JSON.stringify(read).includes('synthetic-token'));const changed=structuredClone(receipt.persisted.payloads);changed.detail['1'].etc2='changed-after-save';await f.page.context().route(target.pageUrl,r=>r.fulfill({contentType:'text/html',body:html(changed)}));await assert.rejects(()=>readNativeProductContent(f.page,{receipt,identity:async()=>{},timeoutMs:1500}),/persisted.*changed/i);assert.equal(f.writes.length,before);});

function materializeReferenceFixture() {
  function install() {
    const select = document.querySelector('#reference_body .reference_element select');
    if (!select || select.parentElement.classList.contains('select-wrapper')) return;
    const wrapper = document.createElement('div'); wrapper.className = 'select-wrapper';
    select.before(wrapper); wrapper.append(select); select.style.display = 'none';
    const input = document.createElement('input'); input.className = 'select-dropdown dropdown-trigger'; input.readOnly = true; input.dataset.target = 'reference-options-fixture';
    const menu = document.createElement('ul'); menu.id = input.dataset.target; menu.hidden = true;
    for (const option of select.options) {
      const li = document.createElement('li'), span = document.createElement('span'); span.textContent = option.textContent;
      li.append(span); menu.append(li);
      li.onclick = () => { select.value = option.value; select.dispatchEvent(new Event('change', { bubbles: true })); menu.hidden = true; };
    }
    input.onclick = () => { menu.hidden = false; };
    input.onkeydown = event => { if (event.key === 'Escape') menu.hidden = true; };
    wrapper.append(input); document.body.append(menu);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else install();
}
test('Materialize reference picker uses visible options and persists text without forced native selection', async t => {
  const f = await fixture(t);
  await f.page.addInitScript(materializeReferenceFixture);
  await f.page.evaluate(materializeReferenceFixture);
  const result = await applyProductContent(f.page, { ...args(), beforeWrite: async () => ({ durable: true }) });
  assert.equal(result.status, 'content-verified', JSON.stringify(result));
  assert.equal(f.writes.length, 3);
});
test('ambiguous Materialize reference options stop before any content writes', async t => {
  const f = await fixture(t);
  await f.page.evaluate(materializeReferenceFixture);
  await f.page.locator('#reference-options-fixture li').first().evaluate(li => li.after(li.cloneNode(true)));
  const result = await applyProductContent(f.page, { ...args(), beforeWrite: async () => ({ durable: true }) });
  assert.equal(f.writes.length, 0);
  assert.match(result.message, /Unsupported native reference picker/);
});

test('Materialize menu that ignores Escape closes through its exact widget before saving', async t => {
  const f = await fixture(t);
  function stubbornPicker() {
    const input=document.querySelector('#reference_body input.select-dropdown');
    if (!input) return;
    const menu=document.getElementById(input.dataset.target);
    input.onkeydown=()=>{};
    window.M={Dropdown:{getInstance:element=>element===input?{el:input,dropdownEl:menu,close:()=>{menu.hidden=true;}}:null}};
  }
  await f.page.addInitScript(materializeReferenceFixture);
  await f.page.addInitScript(() => document.addEventListener('DOMContentLoaded', () => {
    const input=document.querySelector('#reference_body input.select-dropdown');
    if(!input)return;
    const menu=document.getElementById(input.dataset.target); input.onkeydown=()=>{};
    window.M={Dropdown:{getInstance:element=>element===input?{el:input,dropdownEl:menu,close:()=>{menu.hidden=true;}}:null}};
  }));
  await f.page.evaluate(materializeReferenceFixture); await f.page.evaluate(stubbornPicker);
  const result=await applyProductContent(f.page,{...args(),beforeWrite:async()=>({durable:true})});
  assert.equal(result.status,'content-verified',JSON.stringify(result));
  assert.equal(f.writes.length,3);
});

test('reference picker rebinds a rebuilt menu and ignores text color and bold controls',async t=>{
 const {prepareReferencePicker}=await import('../src/reference-picker.mjs');
 const f=await fixture(t);await f.page.evaluate(materializeReferenceFixture);
 const picker=await prepareReferencePicker(f.page,['1','3','4'],1000);
 await f.page.evaluate(()=>{
  const input=document.querySelector('#reference_body input.select-dropdown'),menu=document.getElementById(input.dataset.target);
  menu.id='reference-options-rebuilt';input.dataset.target=menu.id;
  document.querySelector('#reference_body').insertAdjacentHTML('afterbegin','<div class="cont_box reference_element"><select name="font_color"><option value="0">Black</option><option value="1">Red</option><option value="2">Blue</option><option value="3">Yellow</option></select><select name="bold_flag"><option value="0">N</option><option value="1">Y</option></select></div>');
 });
 for(const type of ['3','1','4'])await picker.choose(type);
 assert.equal(await f.page.locator('select:has(option[value="4"])').inputValue(),'4');
 assert.equal(await f.page.locator('[name="font_color"]').inputValue(),'0');
 assert.equal(f.writes.length,0);
});

test('native reference text waits for delayed rows and leaves readonly color controls untouched', async t => {
 const {prepareNativeReferenceText}=await import('../src/product-content-native.mjs');
 const {prepareReferencePicker}=await import('../src/reference-picker.mjs');
 const f=await fixture(t);
 await f.page.evaluate(()=>{
  const add=document.querySelector('#add_reference_element');
  add.onclick=()=>{
   const type=document.querySelector('.reference_element select').value;
   setTimeout(()=>{
    const row=document.createElement('div');row.className='control';row.dataset.type=type;
    row.innerHTML='<input type="text" readonly value="Black">'+(type==='1'?'<textarea></textarea>':'<input type="text">');
    document.querySelector('#reference_body').append(row);
   },100);
  };
 });
 const picker=await prepareReferencePicker(f.page,['1','3'],1500);
 await prepareNativeReferenceText(f.page,[{type:'1',text:'First body'},{type:'3',text:'Next heading'},{type:'1',text:'Last body'}],picker,1500);
 assert.deepEqual(await f.page.locator('#reference_body .control').evaluateAll(rows=>rows.map(row=>({type:row.dataset.type,text:row.querySelector('textarea,input:not([readonly])').value,color:row.querySelector('[readonly]').value}))),[
  {type:'1',text:'First body',color:'Black'},
  {type:'3',text:'Next heading',color:'Black'},
  {type:'1',text:'Last body',color:'Black'}
 ]);
 assert.equal(f.writes.length,0);
});

test('native reference text rejects two editable heading fields without guessing', async t => {
 const {prepareNativeReferenceText}=await import('../src/product-content-native.mjs');
 const {prepareReferencePicker}=await import('../src/reference-picker.mjs');
 const f=await fixture(t);
 await f.page.evaluate(()=>{
  const add=document.querySelector('#add_reference_element'),original=add.onclick;
  add.onclick=()=>{original();document.querySelector('#reference_body .control:last-child').insertAdjacentHTML('beforeend','<input type="text">');};
 });
 const picker=await prepareReferencePicker(f.page,['3'],1500);
 await assert.rejects(prepareNativeReferenceText(f.page,[{type:'3',text:'Approved heading'}],picker,1500),/Ambiguous native reference text field/);
 assert.deepEqual(await f.page.locator('#reference_body .control input').evaluateAll(inputs=>inputs.map(input=>input.value)),['','']);
 assert.equal(f.writes.length,0);
});
function approvedDetail(){
 const d=structuredClone(baselineDetail),a=args().detail;
 for(const [id,key] of [['1','include'],['2','exclude']]){d[id].etc=JSON.stringify(a[key].map(row=>({value:'Direct',label:row.name,remark:row.description})));if(a[key+'Note']!==undefined)d[id].etc2=a[key+'Note'];}
 d['3'].etc=JSON.stringify(a.information.map(content=>({content})));d['4'].etc=JSON.stringify(a.mainPoints.map(content=>({content})));d['8'].etc5=a.shoppingCount;return d;
}
test('reconciled detail is independently matched and never saved twice',async t=>{
 const detail=approvedDetail(),f=await fixture(t,{seed:{detail}}),events=[];
 const result=await applyProductContent(f.page,{...args(),reconciledDetail:detail,record:async e=>events.push(e)});
 assert.equal(result.status,'content-verified',JSON.stringify(result));
 assert.deepEqual(f.writes.map(w=>w.url),[target.endpoints.display,target.endpoints.reference]);
 assert.equal(events.filter(e=>e.phase==='detail-reconciled').length,1);
 assert.deepEqual(result.persisted.payloads.detail,detail);
});
test('recovery rejects changed persisted detail before any write',async t=>{
 const expected=approvedDetail(),actual=structuredClone(expected);actual['1'].etc2='Someone else edited it';
 const f=await fixture(t,{seed:{detail:actual}});
 const result=await applyProductContent(f.page,{...args(),reconciledDetail:expected});
 assert.equal(result.status,'needs-reconciliation');assert.match(result.message,/Reconciled detail changed/);assert.equal(f.writes.length,0);
});
test('recovery rejects a reconciled payload inconsistent with the approved plan',async t=>{
 const detail=approvedDetail();detail['1'].etc='[]';
 const f=await fixture(t,{seed:{detail}});
 const result=await applyProductContent(f.page,{...args(),reconciledDetail:detail});
 assert.equal(result.status,'needs-reconciliation');assert.match(result.message,/differs from the approved content/);assert.equal(f.writes.length,0);
});
