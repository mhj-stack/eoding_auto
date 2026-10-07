import { digest } from './core.mjs';

const DIRECTIONS=['depart','arrive'];
const SLOT_COUNT=3;
const FIELDS=['id','depart_date','flight_no','airline','depart_cd','arrive_cd','depart_time','next_day','arrive_time','moving_time','code_share'];
const REQUIRED=['depart_date','flight_no','airline','depart_cd','arrive_cd','depart_time','next_day','arrive_time','moving_time'];
const OFFSET_TO_VALUE=new Map([[0,''],[1,'1'],[2,'2'],[-1,'3']]);
const VALUE_TO_OFFSET=new Map([...OFFSET_TO_VALUE].map(([offset,value])=>[value,offset]));
const TARGET_RE=/^[1-9]\d{0,9}$/;
const PLAIN_RE=/^\S(?:.*\S)?$/;
const DATE_RE=/^\d{4}-\d{2}-\d{2}$/;
const TIME_RE=/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;
const FLIGHT_RE=/^[A-Z0-9]{2}\d{3,4}$/;
const MINUTES_RE=/^[1-9]\d{0,3}$/;

function fail(message){throw new Error(message);}
function exactTarget(input){
 if(!input||typeof input!=='object'||Array.isArray(input))fail('Invalid flight target');
 const {productId,masterCode,account}=input;
 if(!TARGET_RE.test(productId)||typeof masterCode!=='string'||!PLAIN_RE.test(masterCode)||typeof account!=='string'||!PLAIN_RE.test(account)||Object.keys(input).length!==3)fail('Invalid flight target');
 return {productId,masterCode,account};
}
function exactText(value,label,allowEmpty=false){
 if(typeof value!=='string'||(allowEmpty?value!==''&&!PLAIN_RE.test(value):!PLAIN_RE.test(value)))fail(`Invalid ${label}`);
 return value;
}
function date(value,label){exactText(value,label);if(!DATE_RE.test(value)||Number.isNaN(Date.parse(`${value}T00:00:00Z`))||new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)!==value)fail(`Invalid ${label}`);return value;}
function optionObject(value,field){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==2)fail(`Invalid ${field}`);
 return {id:exactText(value.id,`${field} id`),label:exactText(value.label,`${field} label`)};
}
function segmentObject(value,direction,index){
 if(!value||typeof value!=='object'||Array.isArray(value))fail(`Invalid ${direction} segment ${index}`);
 const expected=['departDate','flightNo','airline','departAirport','arriveAirport','departTime','arriveTime','dayOffset','movingTime','codeShare'];
 if(Object.keys(value).length!==expected.length||expected.some(key=>!(key in value)))fail(`Partial ${direction} segment ${index}`);
 const segment={
  departDate:date(value.departDate,`${direction} depart date`),
  flightNo:exactText(value.flightNo,`${direction} flight number`),
  airline:optionObject(value.airline,'airline'),
  departAirport:optionObject(value.departAirport,'departure airport'),
  arriveAirport:optionObject(value.arriveAirport,'arrival airport'),
  departTime:exactText(value.departTime,`${direction} departure time`),
  arriveTime:exactText(value.arriveTime,`${direction} arrival time`),
  dayOffset:value.dayOffset,
  movingTime:exactText(value.movingTime,`${direction} moving time`),
  codeShare:exactText(value.codeShare,`${direction} code share`,true)
 };
 if(!FLIGHT_RE.test(segment.flightNo)||!TIME_RE.test(segment.departTime)||!TIME_RE.test(segment.arriveTime)||!MINUTES_RE.test(segment.movingTime)||!OFFSET_TO_VALUE.has(segment.dayOffset)||(segment.codeShare!==''&&!FLIGHT_RE.test(segment.codeShare)))fail(`Unsupported ${direction} segment ${index}`);
 return segment;
}
function requestedSegments(input){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==2||!Array.isArray(input.depart)||!Array.isArray(input.arrive))fail('Segments must have depart and arrive arrays');
 const result={};
 for(const direction of DIRECTIONS){
  const entries=input[direction];
  if(entries.length<1||entries.length>SLOT_COUNT)fail(`Unsupported ${direction} segment count`);
  result[direction]=entries.map((entry,index)=>segmentObject(entry,direction,index));
  const duplicates=new Set(result[direction].map(entry=>digest(entry)));
  if(duplicates.size!==result[direction].length)fail(`Duplicate ${direction} segment`);
 }
 return result;
}
function checkUrl(page,target){
 const url=new URL(page.url());
 if(url.origin!=='https://basecamp.team'||url.username||url.password||url.pathname!==`/tour/master_product/${target.productId}/create_product/`||url.searchParams.get('from')!==target.productId||[...url.searchParams].length!==1)fail('Wrong ERP flight target');
}

async function inspect(page,target){
 checkUrl(page,target);
 const inspected=await page.evaluate(({directions,fields,slotCount})=>{
  const one=(selector,label)=>{const all=[...document.querySelectorAll(selector)];if(all.length!==1)throw new Error(`Missing/ambiguous ${label}`);return all[0];};
  const describe=(element,label)=>({
   label,
   tag:element.tagName,
   type:element.type,
   name:element.getAttribute('name')||'',
   value:element.value,
   disabled:Boolean(element.disabled),
   readOnly:Boolean(element.readOnly),
   dataUrl:element.getAttribute('data-url'),
   options:element.tagName==='SELECT'?[...element.options].map(option=>({value:option.value,label:option.textContent.trim(),selected:option.selected})):null
  });
  const form=one('#create_product_form','flight form');
  const account=one('#eoding-name','account display').innerText.trim();
  const from=one('#from','from target');
  const masters=[...form.querySelectorAll('#id_master_product_id')].map(element=>describe(element,'master product id'));
  const calendar={startDate:describe(one('#start-date','start date'),'start date').value,endDate:describe(one('#end-date','end date'),'end date').value,selectedDates:describe(one('#id_selected_dates','selected dates'),'selected dates').value,buttons:[...form.querySelectorAll('#multi-calendar button.datepicker-day-button')].filter(e=>!e.disabled).map(e=>({year:e.getAttribute('data-year'),month:e.getAttribute('data-month'),day:e.getAttribute('data-day'),selected:e.classList.contains('selected')}))};
  const groups={};
  for(const direction of directions){
   groups[direction]=[];
   for(let index=0;index<slotCount;index++){
    const group={};
    for(const field of fields){const id=`id_${direction}-${index}-${field}`;group[field]=describe(one(`#${CSS.escape(id)}`,id),id);}
    groups[direction].push(group);
   }
  }
  return {account,from:describe(from,'from target').value,masters,calendar,groups};
 },{directions:DIRECTIONS,fields:FIELDS,slotCount:SLOT_COUNT});
 if(inspected.account!==target.account)fail('Wrong ERP flight account');
 if(inspected.from!==target.productId||inspected.masters.length!==1||inspected.masters[0].tag!=='INPUT'||inspected.masters[0].type!=='hidden'||inspected.masters[0].value!==target.productId)fail('Wrong ERP flight product');
 for(const direction of DIRECTIONS)for(const group of inspected.groups[direction])validateGroupShape(group);
 return inspected;
}
function validateGroupShape(group){
 for(const field of FIELDS){
  const control=group[field];
  if(control.name!==`${control.label.slice(3)}`)fail(`Wrong segment control name ${control.label}`);
  const select=['airline','depart_cd','arrive_cd','next_day'].includes(field);
  if(field==='id'){
   if(control.tag!=='INPUT'||control.type!=='hidden')fail(`Unexpected ${control.label}`);
  }else if(select){
   if(control.tag!=='SELECT'||control.type==='select-multiple'||control.disabled)fail(`Disabled/unexpected required control ${control.label}`);
  }else if(control.tag!=='INPUT'||control.type!=='text'||control.disabled||control.readOnly){
   fail(`Disabled/unexpected required control ${control.label}`);
  }
 }
 const autocompleteUrls={airline:'/common/autocomplete/airline/',depart_cd:'/common/autocomplete/airport/',arrive_cd:'/common/autocomplete/airport/'};
 for(const [field,url] of Object.entries(autocompleteUrls))if(group[field].dataUrl!==url)fail(`Unsupported canonical selector ${group[field].label}`);
 const offset=group.next_day.options;
 if(!offset||offset.length!==4||[...OFFSET_TO_VALUE.entries()].some(([dayOffset,value])=>!offset.some(option=>option.value===value&&option.label===({0:'',1:'+1',2:'+2','-1':'-1'}[dayOffset]||'--'))))fail(`Unsupported day offset options ${group.next_day.label}`);
}
function selectedOption(control){
 if(control.value==='')return null;
 if(!control.options)fail(`Unexpected canonical control ${control.label}`);
 const matches=control.options.filter(option=>option.value===control.value);
 if(matches.length!==1||!matches[0].label||control.options.filter(option=>option.label===matches[0].label).length!==1)fail(`Unsupported canonical option ${control.label}`);
 return {id:matches[0].value,label:matches[0].label};
}
function asSegment(group,direction,index,calendar){
 if(group.id.value!=='')fail('Existing flight segment identity on create form');
 if(direction==='depart'&&index===0&&group.depart_date.value===calendar.startDate&&FIELDS.filter(k=>!['id','depart_date'].includes(k)).every(k=>group[k].value===''))return null;
 const airline=selectedOption(group.airline),departAirport=selectedOption(group.depart_cd),arriveAirport=selectedOption(group.arrive_cd);
 const fields={departDate:group.depart_date.value,flightNo:group.flight_no.value,airline,departAirport,arriveAirport,departTime:group.depart_time.value,arriveTime:group.arrive_time.value,dayOffset:VALUE_TO_OFFSET.get(group.next_day.value),movingTime:group.moving_time.value,codeShare:group.code_share.value};
 const active=Object.values(fields).some(value=>value!==''&&value!==null&&value!==undefined&&value!==0);
 if(!active)return null;
 if(!VALUE_TO_OFFSET.has(group.next_day.value))fail(`Unsupported day offset ${direction}-${index}`);
 return segmentObject(fields,direction,index);
}
function readSegments(groups,calendar){
 const segments={};
 for(const direction of DIRECTIONS){
  const entries=groups[direction].map((group,index)=>asSegment(group,direction,index,calendar));
  const firstBlank=entries.findIndex(entry=>entry===null);
  if(firstBlank!==-1&&entries.slice(firstBlank+1).some(Boolean))fail(`Non-contiguous ${direction} segment controls`);
  segments[direction]=entries.filter(Boolean);
  if(new Set(segments[direction].map(entry=>digest(entry))).size!==segments[direction].length)fail(`Duplicate ${direction} segment controls`);
 }
 return segments;
}
function validateCalendar(calendar){
 const start=date(calendar.startDate,'calendar start'),end=date(calendar.endDate,'calendar end');
 if(start!==end||calendar.buttons?.length!==1)fail('Exactly one event departure date is required');
 const b=calendar.buttons[0];
 if(b.selected!==true||!/^\d{4}$/.test(b.year)||! /^(0|[1-9]\d?)$/.test(b.month)||! /^[1-9]\d?$/.test(b.day))fail('Invalid flight calendar dates');
 const selected=date(`${b.year}-${String(Number(b.month)+1).padStart(2,'0')}-${String(Number(b.day)).padStart(2,'0')}`,'calendar selected date');
 if(selected!==start||(calendar.selectedDates!==''&&calendar.selectedDates!==selected))fail('Invalid flight calendar dates');
 return {startDate:start,endDate:end,selectedDates:[selected]};
}
function assertRequestedDates(calendar,segments){
 if(segments.depart[0].departDate!==calendar.startDate)fail('Outbound departure date does not match the event calendar');
 let previous=calendar.startDate;
 for(const direction of DIRECTIONS)for(const segment of segments[direction]){if(segment.departDate<previous)fail('Flight segment date order mismatch');previous=segment.departDate;}
}

async function chooseCanonical(page,id,desired){
 const select=page.locator(`#${id}`);
 if(await select.count()!==1)fail(`Missing/ambiguous canonical select ${id}`);
 const picker=page.locator(`[aria-labelledby="select2-${id}-container"]`);
 if(await picker.count()!==1)fail(`Missing/ambiguous canonical picker ${id}`);
 await picker.waitFor({state:'visible',timeout:10000});
 await picker.click();
 const results=page.locator(`#select2-${id}-results[aria-expanded="true"][aria-hidden="false"]`);
 if(await results.count()!==1)fail(`Missing/ambiguous canonical results ${id}`);
 const dropdown=results.locator('xpath=ancestor::*[contains(concat(" ",normalize-space(@class)," ")," select2-container ")][1]');
 if(await dropdown.count()!==1)fail(`Missing canonical dropdown ${id}`);
 const search=dropdown.locator('input.select2-search__field');
 if(await search.count()!==1)fail(`Missing canonical search ${id}`);
 const query=/^(\S+)\s+-\s+/.exec(desired.label)?.[1]??desired.label;
 await search.fill(query);
 const choice=dropdown.getByRole('treeitem',{name:desired.label,exact:true});
 try{await choice.waitFor({state:'visible',timeout:1000});}catch{fail(`Canonical picker did not select ${id}`);}
 if(await choice.count()!==1)fail(`Canonical picker did not select ${id}`);
 await choice.click();
 const selected=await select.evaluate(element=>[...element.selectedOptions].map(option=>({id:option.value,label:option.textContent.trim()})));
 if(selected.length!==1||selected[0].id!==desired.id||selected[0].label!==desired.label)fail(`Canonical picker did not select ${id}`);
}

/** Reads exactly the observed create-product flight segment surface; never writes or requests GDS. */
export async function readFlightForm(page,inputTarget){
 const target=exactTarget(inputTarget);
 const observed=await inspect(page,target);
 const calendar=validateCalendar(observed.calendar);
 const segments=readSegments(observed.groups,calendar);
 return {target,masterCodeVerification:'unavailable-on-observed-create-form',calendar,segments,contractHash:digest({surface:'create_product.flight.v1',slots:SLOT_COUNT,fields:FIELDS,dayOffsets:[-1,0,1,2]})};
}

/** Field-only preparation. Uses DOM value/input/change without focus or blur, so GDS lookup is not triggered. Never saves. */
export async function prepareFlightForm(page,inputTarget,inputSegments){
 const target=exactTarget(inputTarget);
 const segments=requestedSegments(inputSegments);
 const before=await readFlightForm(page,target);
 if(DIRECTIONS.some(direction=>before.segments[direction].length))fail('Flight form already contains segment data');
 assertRequestedDates(before.calendar,segments);
 const denyWrite=route=>route.request().method()==='GET'?route.fallback():route.abort();
 await page.route('**/*',denyWrite);
 try{
  const assignments=[];
  for(const direction of DIRECTIONS){
   const name=direction==='depart'?'layover_yn':'r_layover_yn', desired=segments[direction].length>1?'1':'0';
   const radios=page.locator(`input[type=radio][name="${name}"]`);
   if(await radios.count()!==2)fail('Missing layover controls');
   const selected=page.locator(`input[type=radio][name="${name}"][value="${desired}"]`);
   if(await selected.count()!==1)fail('Missing layover option');
   await selected.check();
  }
  for(const direction of DIRECTIONS)for(const [index,segment] of segments[direction].entries()){
   for(const [field,desired] of [['airline',segment.airline],['depart_cd',segment.departAirport],['arrive_cd',segment.arriveAirport]])await chooseCanonical(page,`id_${direction}-${index}-${field}`,desired);
   const values={depart_date:segment.departDate,flight_no:segment.flightNo,depart_time:segment.departTime,next_day:OFFSET_TO_VALUE.get(segment.dayOffset),arrive_time:segment.arriveTime,moving_time:segment.movingTime,code_share:segment.codeShare};
   for(const [field,value] of Object.entries(values))assignments.push({id:`id_${direction}-${index}-${field}`,value});
  }
  await page.evaluate(items=>{
   for(const item of items){
    const elements=[...document.querySelectorAll(`#${CSS.escape(item.id)}`)];
    if(elements.length!==1)throw new Error(`Missing/ambiguous ${item.id}`);
    const element=elements[0];
    if(element.disabled||element.readOnly)throw new Error(`Disabled required control ${item.id}`);
    if(element.tagName==='SELECT'){
     const matching=[...element.options].filter(option=>option.value===item.value&&option.textContent.trim()===({"":"--",1:'+1',2:'+2',3:'-1'}[item.value]));
     if(matching.length!==1)throw new Error(`Unproven day offset option ${item.id}`);
     element.value=item.value;
    }else{
     if(element.tagName!=='INPUT'||element.type!=='text')throw new Error(`Unexpected editable control ${item.id}`);
     element.value=item.value;
    }
    element.dispatchEvent(new Event('input',{bubbles:true}));
    element.dispatchEvent(new Event('change',{bubbles:true}));
   }
  },assignments);
  const state=await readFlightForm(page,target);
  if(digest(state.segments)!==digest(segments))fail('Prepared flight segment readback mismatch');
  return {status:'prepared-only',canCommit:false,target,masterCodeVerification:state.masterCodeVerification,contractHash:state.contractHash,resultHash:digest({target,calendar:state.calendar,segments:state.segments}),state,notice:'Flight fields were set without focus/blur under a temporary non-GET route barrier. No GDS lookup, save, confirmation, or credential entry was performed.'};
 }finally{await page.unroute('**/*',denyWrite);}
}
