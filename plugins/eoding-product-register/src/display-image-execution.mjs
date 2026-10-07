import { isDeepStrictEqual as same } from 'node:util';
import { digest } from './core.mjs';
import { parseDisplayMultipart } from './display-image.mjs';
const HEX=/^[a-f0-9]{64}$/;
const canonical=fields=>{
 if(!Array.isArray(fields)||!fields.length)throw Error('Invalid display fields');
 const names=new Set();
 const out=fields.map(pair=>{if(!Array.isArray(pair)||pair.length!==2||pair.some(v=>typeof v!=='string')||!pair[0]||names.has(pair[0])||pair[0]==='csrfmiddlewaretoken')throw Error('Invalid display fields');names.add(pair[0]);return [...pair];});
 return out.sort((a,b)=>a[0].localeCompare(b[0]));
};
/** A single native homepage POST, then GET reconciliation even on a lost response. */
export async function executeDisplayImageRepair({page,prepared,claim,assertIdentity,verifyEvidence,readCurrent,readPersisted,record,onGuardInstalled=async()=>{},timeoutMs=15000}={}){
 if(!page||![assertIdentity,verifyEvidence,readCurrent,readPersisted,record,onGuardInstalled].every(v=>typeof v==='function')||!Number.isSafeInteger(timeoutMs)||timeoutMs<100||timeoutMs>30000)throw Error('Invalid display execution collaborators');
 if(typeof prepared?.target?.productId!=='string'||!/^[1-9]\d{0,9}$/.test(prepared.target.productId))throw Error('Invalid display target');
 const before=canonical(prepared.before),after=canonical(prepared.after),refs=prepared.images?.map(({id,src})=>({id,src}));
 if(!refs?.length||!same(before.map(([k,v])=>[k,k==='image_sort'?JSON.stringify({images:refs.map(x=>x.id)}):v]),after))throw Error('Invalid display-only delta');
 const endpoint=`https://basecamp.team/tour/master_product/homepage/${prepared.target.productId}/`,targetUrl=`https://basecamp.team/tour/master_product/${prepared.target.productId}/change/`;
 const validateClaim=()=>{if(!claim||!HEX.test(claim.approvalDigest??'')||claim.identityDigest!==prepared.identityDigest||claim.preparedDigest!==digest(prepared)||claim.formDigest!==digest(prepared.after)||!same(claim.target,prepared.target)||!Number.isSafeInteger(claim.deadline)||Date.now()>=claim.deadline)throw Error('Display approval claim invalid or expired');};
 const validatePage=()=>{if(page.url().split('#')[0]!==targetUrl)throw Error('Display target page changed');};
 validateClaim();validatePage();await verifyEvidence();await assertIdentity();
 if(!same(canonical(await readCurrent()),after))throw Error('Prepared display state changed');
 let armed=false,used=false,forwarded=0,guardError=null,responseObserved=false,responseStatus=null;
 const guard=async route=>{
  const req=route.request();if(['GET','HEAD'].includes(req.method()))return route.fallback();
  if(!armed||used||req.method()!=='POST'||req.url()!==endpoint)return route.abort();
  used=true;
  try{validateClaim();validatePage();const fields=parseDisplayMultipart(req.headers()['content-type'],req.postDataBuffer());const csrf=fields.filter(([name])=>name==='csrfmiddlewaretoken');if(csrf.length!==1||!csrf[0][1]||!same(canonical(fields.filter(([name])=>name!=='csrfmiddlewaretoken')),after))throw Error('Native display payload differs from approval');await verifyEvidence();await assertIdentity();validateClaim();validatePage();forwarded++;await route.fallback();}catch(error){guardError=String(error.message).slice(0,300);await route.abort().catch(()=>{});}
 };
 await page.context().route('**/*',guard);
 try{
  await onGuardInstalled();validateClaim();await verifyEvidence();await assertIdentity();validatePage();
  if(!same(canonical(await readCurrent()),after))throw Error('Prepared display state changed');
  await record('attempt',{target:prepared.target,approvalDigest:claim.approvalDigest,formDigest:claim.formDigest});
  armed=true;
  const wait=page.waitForResponse(r=>r.url()===endpoint&&r.request().method()==='POST',{timeout:timeoutMs}).then(r=>{responseObserved=true;responseStatus=r.status();}).catch(()=>{});
  try{await page.locator('#save-master-product').click({timeout:timeoutMs});await wait;}catch{await wait;}finally{armed=false;}
  let readback=null,verified=false,readError=null;
  try{await assertIdentity();readback=await readPersisted();validatePage();await assertIdentity();verified=same(canonical(readback.fields),after)&&same(readback.images.map(({id,src})=>({id,src})),refs)&&readback.images.every(x=>x.decoded===true);}catch(error){readError=String(error.message).slice(0,300);}
  const result={status:verified&&forwarded===1&&!guardError?'display-images-verified':'needs-reconciliation',target:prepared.target,images:verified?refs.length:null,forwardedPosts:forwarded,responseObserved,responseStatus,guardError,readError,readback};
  await record('result',result);return result;
 }finally{armed=false;await page.context().route('**/*',route=>['GET','HEAD'].includes(route.request().method())?route.fallback():route.abort());await page.context().unroute('**/*',guard);}
}
