import test from 'node:test';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {chromium} from 'playwright';
import {claimFreshNativeProductRead,readNativeProductContent} from '../src/product-content-final-read.mjs';

const origin='https://final-snapshot-fixture.invalid',pageUrl=origin+'/tour/master_product/42/change/';
const target={origin,productId:'42',masterCode:'FIX42',pageUrl,controls:{displaySave:'#save-display',detailSave:'#save-detail',referenceSave:'#save-reference'},endpoints:{display:origin+'/tour/master_product/homepage/42/',detail:origin+'/tour/master_product_detail/42/change/',reference:origin+'/tour/master_product_reference/42/change/'}};
const payloads={display:{short_description:'Persisted description',image_sort:'{"images":[]}'},detail:{information:'Persisted detail'},reference:[{type:1,text:'Persisted reference'}]};
const receipt={status:'content-verified',target,persisted:{payloads,images:[]}};
const html=`<!doctype html><meta charset="utf-8"><input id="basic-title" value="Persisted product"><div id="base"><form id="homepage_post"><input name="short_description" value="Persisted description"><input name="image_sort" value='{"images":[]}'><button id="save-display" type="button">display</button></form><div id="image_homepage_area"></div></div><table id="include"><tbody><tr><td>Persisted detail</td></tr></tbody></table><button id="save-detail" type="button">detail</button><form id="reference_form"><button id="save-reference" type="button">reference</button></form><script>
 document.querySelector('#save-display').onclick=()=>fetch(${JSON.stringify(target.endpoints.display)},{method:'POST',body:new FormData(document.querySelector('#homepage_post'))}).catch(()=>{});
 for(const key of ['detail','reference'])document.querySelector('#save-'+key).onclick=()=>fetch(${JSON.stringify(target.endpoints)}[key],{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(${JSON.stringify(payloads)}[key])}).catch(()=>{});
</script>`;

async function fixture(t,{delayMs=0}={}){
 const browser=await chromium.launch({headless:true,args:['--host-resolver-rules=MAP * ~NOTFOUND']});t.after(()=>browser.close());
 const context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage();
 const stats={gets:0,forwardedPosts:0};
 await context.route('**/*',async route=>{
  const request=route.request();
  if(request.method()==='GET'&&request.url()===pageUrl){stats.gets++;if(delayMs)await new Promise(resolve=>setTimeout(resolve,delayMs));return route.fulfill({contentType:'text/html',body:html});}
  if(request.method()==='POST')stats.forwardedPosts++;
  return route.abort();
 });
 return {context,page,stats};
}
const assertBasic=async page=>assert.equal(await page.locator('#basic-title').inputValue(),'Persisted product');

test('a final snapshot requires the exact direct GET response and cannot use service-worker or redirect results',async()=>{
 for(const change of [r=>r.status=()=>503,r=>r.url=()=>pageUrl+'?other=1',r=>r.fromServiceWorker=()=>true,r=>r.request=()=>({method:()=> 'POST'}),r=>r.request=()=>({method:()=> 'GET',url:()=>pageUrl+'?other=1'}),r=>r.request=()=>({method:()=> 'GET',url:()=>pageUrl,redirectedFrom:()=>({})})]){
  const response={status:()=>200,url:()=>pageUrl,fromServiceWorker:()=>false,request:()=>({method:()=> 'GET',url:()=>pageUrl,redirectedFrom:()=>null})};change(response);
  const owner={route:async()=>{},unroute:async()=>{},newCDPSession:async()=>({send:async()=>{},detach:async()=>{}})};
  const page={context:()=>owner,goto:async()=>response};let called=false;
  await assert.rejects(()=>readNativeProductContent(page,{receipt,identity:async()=>{},onFreshProductRead:async()=>{called=true;}}),/Fresh native GET failed/);
  assert.equal(called,false);
 }
});

test('final snapshot uses one fresh GET instead of two and preserves every native readback',{timeout:20000},async t=>{
 const f=await fixture(t,{delayMs:250});
 let baselineMs=0,sharedMs=0;
 for(let i=0;i<3;i++){
  let start=performance.now();
  const baseline=await readNativeProductContent(f.page,{receipt,identity:async()=>{}});
  const response=await f.page.goto(pageUrl,{waitUntil:'domcontentloaded'});assert.equal(response.status(),200);await assertBasic(f.page);
  baselineMs+=performance.now()-start;
  start=performance.now();
  const shared=await readNativeProductContent(f.page,{receipt,identity:async()=>{},onFreshProductRead:async proof=>{
   const assertCurrent=await claimFreshNativeProductRead(f.page,proof,pageUrl);await assertBasic(f.page);await assertCurrent();
  }});
  sharedMs+=performance.now()-start;
  assert.deepEqual(shared,baseline);
 }
 assert.equal(f.stats.gets,9,'three baseline reads use six GETs, three shared reads use three GETs');
 assert.equal(f.stats.forwardedPosts,0,'serialization probes remain blocked');
 assert.ok(baselineMs-sharedMs>400,`expected three fewer delayed GETs; baseline=${baselineMs.toFixed(1)}ms shared=${sharedMs.toFixed(1)}ms`);
 t.diagnostic(JSON.stringify({runs:3,delayPerGetMs:250,baselineGets:6,sharedGets:3,baselineMs:Math.round(baselineMs),sharedMs:Math.round(sharedMs),savedMs:Math.round(baselineMs-sharedMs),liveErp:false}));
});

test('fresh product proof is opaque, single-use, document-bound and expires with its callback',{timeout:10000},async t=>{
 const f=await fixture(t);let expired;
 await assert.rejects(()=>claimFreshNativeProductRead(f.page,{},pageUrl),/Invalid fresh/);
 await readNativeProductContent(f.page,{receipt,identity:async()=>{},onFreshProductRead:async proof=>{
  expired=proof;
  await assert.rejects(()=>claimFreshNativeProductRead(f.page,proof,origin+'/tour/master_product/99/change/'),/Invalid fresh/);
  const assertCurrent=await claimFreshNativeProductRead(f.page,proof,pageUrl);await assertCurrent();
  await assert.rejects(()=>claimFreshNativeProductRead(f.page,proof,pageUrl),/Invalid fresh/);
 }});
 await assert.rejects(()=>claimFreshNativeProductRead(f.page,expired,pageUrl),/Invalid fresh/);
 await assert.rejects(()=>readNativeProductContent(f.page,{receipt,identity:async()=>{},onFreshProductRead:async proof=>{
  await f.page.reload({waitUntil:'domcontentloaded'});
  await claimFreshNativeProductRead(f.page,proof,pageUrl);
 }}),/Fresh native product document changed/);
 assert.equal(f.stats.forwardedPosts,0);
});

test('final shared read still rejects account changes and unexpected writes',{timeout:10000},async t=>{
 const f=await fixture(t);let account='approved';
 await assert.rejects(()=>readNativeProductContent(f.page,{receipt,identity:async()=>assert.equal(account,'approved','Approved account changed'),onFreshProductRead:async proof=>{
  await claimFreshNativeProductRead(f.page,proof,pageUrl);account='other';
 }}),/Approved account changed/);
 account='approved';
 await assert.rejects(()=>readNativeProductContent(f.page,{receipt,identity:async()=>{},onFreshProductRead:async proof=>{
  await claimFreshNativeProductRead(f.page,proof,pageUrl);
  await f.page.evaluate(()=>fetch('/unexpected-write',{method:'POST'}).catch(()=>{}));
 }}),/Unexpected native mutation/);
 assert.equal(f.stats.forwardedPosts,0);
});
