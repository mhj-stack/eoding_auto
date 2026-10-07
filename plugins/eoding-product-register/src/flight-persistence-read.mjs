import {digest} from './core.mjs';
const ORIGIN='https://basecamp.team',ID=/^[1-9]\d{0,9}$/;
const FIELDS=['id','depart_date','flight_no','airline','depart_cd','arrive_cd','depart_time','arrive_time','next_day','moving_time','code_share'];
const fail=message=>{throw Error(message);};
const canonicalId=(v,name)=>typeof v==='string'&&ID.test(v)?v:fail(`Invalid ${name}`);
function location(page){const u=new URL(page.url());if(u.origin!==ORIGIN||u.username||u.password)fail('Wrong flight read origin');return u.href;}
async function get(page,url){const r=await page.evaluate(async url=>{const c=new AbortController(),timer=setTimeout(()=>c.abort(),15000);try{const r=await fetch(url,{method:'GET',credentials:'same-origin',cache:'no-store',redirect:'error',signal:c.signal});return {status:r.status,url:r.url,type:r.headers.get('content-type'),body:await r.text()};}catch{return {error:true};}finally{clearTimeout(timer);}},url);if(r.error||r.status!==200||r.url!==url||!/^text\/html\b/i.test(r.type??''))fail('Flight read response rejected');if(!r.body||Buffer.byteLength(r.body)>2000000)fail('Flight read response size rejected');return r.body;}
/** GET-only canonical segment readback from observed event/season HTML. */
export async function readPersistedFlights(page,{eventId}={}){
 canonicalId(eventId,'event ID');const start=location(page);
 const eventHtml=await get(page,`${ORIGIN}/tour/product/${eventId}/change/`);
 const seasonId=await page.evaluate(html=>{const d=new DOMParser().parseFromString(html,'text/html'),es=d.querySelectorAll('#priceNAir');return es.length===1?es[0].getAttribute('data-season-id'):null;},eventHtml);canonicalId(seasonId,'season ID');
 const html=await get(page,`${ORIGIN}/tour/tour_product_season/${seasonId}/change/`);
 const packet=await page.evaluate(({html,fields})=>{
  const d=new DOMParser().parseFromString(html,'text/html'),error=message=>({error:message}),result={depart:[],arrive:[]};
  const all=[...d.querySelectorAll('input,select,textarea')].filter(e=>/^(?:id_)?(?:depart|arrive)-/.test(e.id)||/^(?:depart|arrive)-/.test(e.name));
  const management=all.filter(e=>/^(depart|arrive)-(TOTAL_FORMS|INITIAL_FORMS|MIN_NUM_FORMS|MAX_NUM_FORMS)$/.test(e.name));
  for(const e of management){if(e.id!==`id_${e.name}`||e.tagName!=='INPUT'||e.type!=='hidden'||e.disabled||! /^[0-3]$/.test(e.value)||management.filter(x=>x.name===e.name).length!==1)return error('Invalid flight management control');}
  const segments=all.filter(e=>!management.includes(e));
  if(segments.length!==66)return error('Unexpected flight segment controls');
  for(const direction of ['depart','arrive']){
   let gap=false;
   for(let i=0;i<3;i++){
    const row={};
    for(const field of fields){const name=`${direction}-${i}-${field}`,es=all.filter(e=>e.id===`id_${name}`&&e.name===name);if(es.length!==1||es[0].disabled)return error('Missing duplicate or disabled flight control');const e=es[0];
     if(['airline','depart_cd','arrive_cd'].includes(field)){if(e.tagName!=='SELECT')return error('Invalid flight ID control');const init=e.getAttribute('data-init-id')??'',v=e.value;if(init&&v&&init!==v)return error('Conflicting flight identity');row[field]=v||init;}else{if(e.tagName!==(field==='next_day'?'SELECT':'INPUT')||(field==='id'&&e.type!=='hidden'))return error('Invalid flight field');row[field]=e.value;}
    }
    if(Object.values(row).every(v=>v==='')){gap=true;continue;}
    if(gap)return error('Flight segment gap');result[direction].push(row);
   }
  }
  return result;
 },{html,fields:FIELDS});
 if(packet.error)fail(packet.error);if(location(page)!==start)fail('Flight read page changed');
 const seen=new Set();
 for(const direction of ['depart','arrive']){if(!packet[direction].length)fail('Missing persisted flight direction');for(const row of packet[direction]){canonicalId(row.id,'segment ID');if(seen.has(row.id))fail('Duplicate segment ID');seen.add(row.id);validate(row);}}
 return {eventId,seasonId,...packet};
}
function time(value){if(typeof value!=='string'||!/^([01]\d|2[0-3]):[0-5]\d(?::00)?$/.test(value))fail('Invalid flight time');return value.slice(0,5);}
function validate(row){
 for(const field of ['airline','depart_cd','arrive_cd'])canonicalId(row[field],field);
 if(typeof row.depart_date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(row.depart_date)||!Number.isFinite(Date.parse(row.depart_date))||new Date(row.depart_date).toISOString().slice(0,10)!==row.depart_date)fail('Invalid flight date');
 if(typeof row.flight_no!=='string'||! /^[A-Z0-9]{2}\d{3,4}$/.test(row.flight_no))fail('Invalid flight number');
 time(row.depart_time);time(row.arrive_time);
 if(!['','1','2','3'].includes(row.next_day)||typeof row.moving_time!=='string'||! /^(0|[1-9]\d{0,4})$/.test(row.moving_time)||typeof row.code_share!=='string'||row.code_share.length>40)fail('Invalid flight ancillary field');
}
export function verifyPersistedFlights(actual,expected){
 canonicalId(actual?.eventId,'event ID');canonicalId(actual?.seasonId,'season ID');
 if(!expected||Object.keys(expected).sort().join(',')!=='arrive,depart')fail('Invalid expected flight directions');
 for(const direction of ['depart','arrive']){
  if(!Array.isArray(expected[direction])||expected[direction].length<1||expected[direction].length>3||actual[direction]?.length!==expected[direction].length)fail('Flight count mismatch');
  for(let i=0;i<expected[direction].length;i++){
   const want=expected[direction][i],got=actual[direction][i];
   if(!want||Object.keys(want).sort().join(',')!==FIELDS.filter(f=>f!=='id').sort().join(','))fail('Invalid expected flight fields');validate(want);validate(got);canonicalId(got.id,'segment ID');
   const normalize=r=>Object.fromEntries(FIELDS.filter(f=>f!=='id').map(f=>[f,['depart_time','arrive_time'].includes(f)?time(r[f]):r[f]]));
   if(digest(normalize(want))!==digest(normalize(got)))fail(`Flight segment mismatch ${direction}:${i}`);
  }
 }
 return {status:'flight-persistence-verified',eventId:actual.eventId,seasonId:actual.seasonId,depart:structuredClone(actual.depart),arrive:structuredClone(actual.arrive)};
}
