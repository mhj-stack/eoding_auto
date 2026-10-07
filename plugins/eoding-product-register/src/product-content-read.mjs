import {isDeepStrictEqual as same} from 'node:util';
import {performance} from 'node:perf_hooks';

const ORIGIN='https://basecamp.team';
const ID=/^[1-9]\d{0,9}$/;
const MAX_BYTES=2_000_000;
const METHODS=new Set(['GET','HEAD']);

/** Read-only persisted event content. No navigation, form submission or write retry. */
export async function verifyEventContent(page,{target,eventId,plan,images,assertIdentity,timeoutMs=15000}) {
  if(!ID.test(target?.productId??'')||typeof target.productId!=='string'||typeof target.masterCode!=='string'||!target.masterCode||typeof eventId!=='string'||!ID.test(eventId))throw Error('Invalid content target');
  if(!plan||!['include','exclude','information','mainPoints','elements'].every(k=>Array.isArray(plan[k]))||typeof plan.shoppingCount!=='string'||!Array.isArray(images)||typeof assertIdentity!=='function')throw Error('Invalid content verification input');
  if(!Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>30000)throw Error('Invalid verification timeout');
  const expectedImages=images.map(({id,src})=>({id:String(id),src}));
  if(expectedImages.some(i=>!ID.test(i.id)||typeof i.src!=='string'||!i.src.startsWith('https://media.eoding.com/'))||new Set(expectedImages.map(i=>i.id)).size!==images.length||new Set(expectedImages.map(i=>i.src)).size!==images.length)throw Error('Invalid or duplicate image receipt');
  const startUrl=page.url();
  if(new URL(startUrl).origin!==ORIGIN)throw Error('Wrong content read origin');
  const guard=r=>METHODS.has(r.request().method())?r.fallback():r.abort();
  const owner=page.context(),started=performance.now();
  await owner.route('**/*',guard);
  try {
    await assertIdentity();
    if(page.url()!==startUrl)throw Error('Content read origin or page changed');
    const snapshot=await page.evaluate(async({origin,eventId,timeoutMs,maximum})=>{
      const begin=performance.now();
      const one=(doc,selector)=>{const ns=doc.querySelectorAll(selector);if(ns.length!==1)throw Error(`Missing or ambiguous content control: ${selector}`);return ns[0]};
      const read=async(path)=>{
        const url=origin+path,controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
        try {
          const response=await fetch(url,{method:'GET',credentials:'same-origin',redirect:'error',cache:'no-store',signal:controller.signal});
          if(response.status!==200||response.redirected||response.url!==url)throw Error('Content read was not an exact successful GET');
          if(Number(response.headers.get('content-length'))>maximum)throw Error('Content response exceeds limit');
          const html=await response.text();
          if(!html||new TextEncoder().encode(html).length>maximum)throw Error('Content response exceeds limit');
          const doc=new DOMParser().parseFromString(html,'text/html');
          if(doc.querySelector('input[type=password],form#login,form[action*="login"]')||/login|로그인/i.test(doc.title))throw Error('Login page returned for content read');
          return doc;
        } finally {clearTimeout(timer)}
      };
      const [root,detail,reference]=await Promise.all([
        read(`/tour/product/${eventId}/change/`),
        read(`/tour/product_detail/${eventId}/change/`),
        read(`/tour/product_reference/${eventId}/change/`),
      ]);
      const identity={eventId:one(root,'#tour_product_id').value,masterCode:one(root,'#id_master_product_code').value,detailId:JSON.parse(one(detail,'#product-id').textContent)};
      for(const selector of ['#detail','#reference'])if(one(root,selector).getAttribute('data-tour-product-id')!==eventId)throw Error('Content tab target mismatch');
      const rows=id=>[...one(detail,`#${id}`).querySelectorAll('tbody tr')].map(row=>{
        const inputs=[...row.querySelectorAll('input')];
        if(inputs.length!==2)throw Error('Unsupported include/exclude row structure');
        return{value:'Direct',label:inputs[0].value,remark:inputs[1].value};
      });
      const values=id=>[...one(detail,`#${id}`).querySelectorAll('tbody input')].map(n=>n.value);
      const info={include:rows('include'),exclude:rows('exclude'),information:values('information'),mainPoints:values('main-point'),shoppingCount:one(detail,'#id_real_shopping_count').value};
      const form=one(reference,'#reference_form'),body=one(reference,'#reference_body');
      if(!form.contains(body))throw Error('Reference body is outside its form');
      const elements=[...body.querySelectorAll('.control[data-type]')].filter(n=>n.dataset.type!=='4').map(n=>{
        if(!['1','3'].includes(n.dataset.type))throw Error('Unsupported reference element');
        return{type:n.dataset.type,text:one(n,n.dataset.type==='1'?'textarea':'input[type=text]').value};
      });
      const images=[...body.querySelectorAll('.tr_image_list')].map(n=>({id:n.dataset.id,src:one(n,'img').getAttribute('src')}));
      return{identity,detail:info,elements,images,readMs:performance.now()-begin};
    },{origin:ORIGIN,eventId,timeoutMs,maximum:MAX_BYTES});
    if(page.url()!==startUrl)throw Error('Content read origin or page changed');
    if(snapshot.identity.eventId!==eventId||snapshot.identity.detailId!==eventId||snapshot.identity.masterCode!==target.masterCode)throw Error('Content identity mismatch');
    const direct=rows=>rows.map(r=>({value:'Direct',label:r.name,remark:r.description??''}));
    const expectedDetail={include:direct(plan.include),exclude:direct(plan.exclude),information:plan.information,mainPoints:plan.mainPoints,shoppingCount:plan.shoppingCount};
    if(!same(snapshot.detail,expectedDetail))throw Error('Copied reference/include/exclude content mismatch');
    if(!same(snapshot.elements,plan.elements.map(e=>({type:String(e.type),text:e.text}))))throw Error('Copied reference text content mismatch');
    if(!same(snapshot.images,expectedImages))throw Error('Copied image receipt mismatch');
    const imageMs=await page.evaluate(async({images,timeoutMs})=>{
      const start=performance.now();
      await Promise.all(images.map(({src})=>new Promise((resolve,reject)=>{
        const image=new Image(),timer=setTimeout(()=>finish(Error('Image decoding timed out')),timeoutMs);
        function finish(error){clearTimeout(timer);image.onload=null;image.onerror=null;image.src='';error?reject(error):resolve()}
        image.onload=()=>finish(image.naturalWidth>0&&image.naturalHeight>0?null:Error('Image has no dimensions'));
        image.onerror=()=>finish(Error('Image failed to load'));image.src=src;
      })));
      return performance.now()-start;
    },{images:expectedImages,timeoutMs});
    await assertIdentity();
    if(page.url()!==startUrl)throw Error('Content read origin or page changed');
    return{status:'event-content-verified',target,eventId,detail:snapshot.detail,elements:snapshot.elements,images:expectedImages,checkedAt:new Date().toISOString(),metrics:{documentGets:3,navigations:0,readMs:snapshot.readMs,imageMs,elapsedMs:performance.now()-started}};
  } finally {await owner.unroute('**/*',guard)}
}
