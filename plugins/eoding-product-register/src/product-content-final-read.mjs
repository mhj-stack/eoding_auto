import {isDeepStrictEqual as same} from 'node:util';
import {parseDisplayMultipart,readDisplayImageState} from './display-image.mjs';
const fail=m=>{throw Error(m)};
/** Fresh read-only native serialization. Save events are intercepted and NEVER forwarded. */
export async function readNativeProductContent(page,{receipt,identity,timeoutMs=15000}={}){
 const target=receipt?.target;
 if(receipt?.status!=='content-verified'||!receipt.persisted?.payloads||!Array.isArray(receipt.persisted.images)||typeof identity!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>30000)fail('Verified native receipt and identity required');
 let url;try{url=new URL(target.pageUrl);}catch{fail('Invalid native read target');}
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.origin!==target.origin||!(/^[1-9]\d{0,9}$/).test(target.productId)||url.pathname!==`/tour/master_product/${target.productId}/change/`)fail('Invalid native read target');
 for(const [key,path] of Object.entries({display:`/tour/master_product/homepage/${target.productId}/`,detail:`/tour/master_product_detail/${target.productId}/change/`,reference:`/tour/master_product_reference/${target.productId}/change/`}))if(target.endpoints?.[key]!==target.origin+path||typeof target.controls?.[key+'Save']!=='string')fail('Invalid native read endpoint');
 const owner=page.context();let pending=null,unexpected=false,cdp;
 const assertIdentity=async()=>{if(page.url().split('#')[0]!==target.pageUrl)fail('Native read target changed');await identity(page,structuredClone(target));if(page.url().split('#')[0]!==target.pageUrl)fail('Native read target changed');};
 const guard=async route=>{
  const req=route.request();if(['GET','HEAD'].includes(req.method()))return route.fallback();
  const p=pending;
  if(!p||p.used||req.method()!=='POST'||req.url()!==p.url){if(new URL(req.url()).origin===target.origin)unexpected=true;return route.abort();}
  p.used=true;
  try{
   const ct=req.headers()['content-type']??'';let body;
   if(p.key==='display'){
    const tuples=parseDisplayMultipart(ct,req.postDataBuffer());if(new Set(tuples.map(([k])=>k)).size!==tuples.length)fail('Duplicate readback fields');
    body=Object.fromEntries(tuples.filter(([k])=>k!=='csrfmiddlewaretoken'));
   }else{if(!/^application\/json(?:;|$)/i.test(ct))fail('Invalid native JSON readback');body=JSON.parse(req.postData());}
   await route.abort();p.resolve(body);
  }catch(error){await route.abort().catch(()=>{});p.reject(error);}
 };
 await owner.route('**/*',guard);
 try{
  cdp=await owner.newCDPSession(page);await cdp.send('Network.enable');await cdp.send('Network.setCacheDisabled',{cacheDisabled:true});await cdp.send('Network.setBypassServiceWorker',{bypass:true});
  const response=await page.goto(target.pageUrl,{waitUntil:'domcontentloaded',timeout:timeoutMs});
  if(!response||response.status()!==200||response.url()!==target.pageUrl||response.fromServiceWorker())fail('Fresh native GET failed');await assertIdentity();
  const payloads={};
  for(const [key,tab] of [['display','base'],['detail','detail'],['reference','productreference']]){
   const link=page.locator(`a[href="#${tab}"]`);if(await link.count()===1)await link.click();await assertIdentity();let timer;
   const packet=new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(Error('Native final capture timed out')),timeoutMs);pending={key,url:target.endpoints[key],used:false,resolve,reject};});packet.catch(()=>{});
   try{await page.locator(target.controls[key+'Save']).click({timeout:timeoutMs});payloads[key]=await packet;}finally{clearTimeout(timer);pending=null;}
   if(!same(payloads[key],receipt.persisted.payloads[key]))fail('Persisted native '+key+' changed');
  }
  const tab=page.locator('a[href="#base"]');if(await tab.count()===1)await tab.click();
  if(receipt.persisted.images.length)await page.waitForFunction(count=>{const images=[...document.querySelectorAll('#image_homepage_area .image_list img')];return images.length===count&&images.every(x=>x.complete&&x.naturalWidth>0);},receipt.persisted.images.length,{timeout:timeoutMs});
  const imageState=await readDisplayImageState(page),images=imageState.images.map(({id,src})=>({id,src}));if(!same(images,receipt.persisted.images))fail('Persisted native images changed');
  await assertIdentity();if(unexpected)fail('Unexpected native mutation blocked during final read');
  return {status:'native-content-reverified',target:structuredClone(target),persisted:{payloads,images},forwarded:0};
 }finally{pending=null;await owner.unroute('**/*',guard);await cdp?.detach().catch(()=>{});}
}
