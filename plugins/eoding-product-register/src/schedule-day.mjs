import { z } from 'zod';
import { digest } from './core.mjs';
import { readBasicForm } from './basic-form.mjs';
const plain=z.string().min(1).max(20000).refine(s=>s===s.trim()&&!/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s),'Plain text only; no HTML or control characters');
const description=z.string().min(1).max(20000).refine(s=>s===s.trim()&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s)&&!/<[A-Za-z!/?]/.test(s),'Plain text only; no HTML or control characters');
const id=z.string().regex(/^[1-9]\d{0,9}$/);
export const ScheduleDayTarget=z.object({productId:id,masterCode:plain,title:plain,account:plain,scheduleId:id,scheduleCode:plain,scheduleTitle:plain}).strict();
export const ScheduleDayDraft=z.object({day:z.number().int().min(1).max(366),title:plain,description:description,meals:z.object({breakfast:plain,lunch:plain,dinner:plain}).strict()}).strict();
const kinds=['breakfast','lunch','dinner'];
const fail=m=>{throw Error(m);};
async function one(locator,label,visible=false){if(visible)await locator.first().waitFor({state:'visible',timeout:10000});if(await locator.count()!==1)fail('Missing/ambiguous '+label);if(visible&&!await locator.isVisible())fail('Hidden '+label);return locator;}
async function readValue(locator,label){const el=await one(locator,label);return el.evaluate(e=>{if(!((e.tagName==='INPUT'&&e.type==='text')||e.tagName==='TEXTAREA'||e.tagName==='SELECT'&&!e.multiple))throw Error('Unexpected field type');return e.value;});}
async function value(page,selector){return readValue(page.locator(selector),selector);}
async function textInput(page,selector){const input=await one(page.locator(selector),selector,true);const ok=await input.evaluate(e=>(e.tagName==='TEXTAREA'||e.tagName==='INPUT'&&e.type==='text')&&!e.disabled&&!e.readOnly);if(!ok)fail('Unexpected input '+selector);return input;}
async function nativeDayTitle(page,day){
  const inputs=page.locator('#schedule_detail_area .input_day_title');const count=await inputs.count();
  if(count===1)return readValue(inputs,'#schedule_detail_area .input_day_title');
  if(count!==0)fail('Missing/ambiguous native day title');
  const heads=page.locator('#schedule_detail_area .step > .head');if(await heads.count()!==1||!await heads.isVisible())fail('Missing/ambiguous native day title');
  const observed=await heads.evaluate(e=>({text:e.textContent.replace(/\s+/g,' ').trim(),controls:e.querySelectorAll('input,textarea,select,button,[contenteditable="true"],[role="textbox"],[role="combobox"]').length}));
  if(observed.text!==`${day} 일차`||observed.controls!==0)fail('Missing/ambiguous native day title');
  return null;
}
function verifiedUrl(page,target){const u=new URL(page.url());if(u.origin!=='https://basecamp.team'||u.username||u.password||u.pathname!==`/tour/master_product/${target.productId}/change/`)fail('Wrong ERP product URL');}
export async function readScheduleDay(page,inputTarget,day){
  const target=ScheduleDayTarget.parse(inputTarget);if(!Number.isInteger(day)||day<1||day>366)fail('Invalid day');verifiedUrl(page,target);
  const account=(await(await one(page.locator('#eoding-name'),'account',true)).innerText()).trim();if(account!==target.account)fail('Account display changed');
  const basic=await readBasicForm(page);if(basic.status!=='2'||basic.title!==target.title||basic.masterCode!==target.masterCode)fail('Private product identity mismatch');
  let master;try{master=new URL(basic.masterURL);}catch{fail('Invalid master URL');}if(master.username||master.password||master.pathname.replace(/\/$/,'')!==`/master/${target.productId}`)fail('Master ID mismatch');
  const selected=await one(page.locator('#schedule_list_table tr.selected[data-schedule-id]'),'selected schedule',true);if(await selected.getAttribute('data-schedule-id')!==target.scheduleId)fail('Wrong selected schedule');
  const schedule={code:await value(page,'#id_schedule_code'),title:await value(page,'#id_schedule_name'),nights:await value(page,'#id_night'),days:await value(page,'#id_day'),meeting:await value(page,'#id_meeting_location'),meetingRemark:await value(page,'#id_desc')};
  if(schedule.code!==target.scheduleCode||schedule.title!==target.scheduleTitle||day>Number(schedule.days))fail('Schedule identity/duration mismatch');
  const dayNode=await one(page.locator('#schedule [role="treeitem"][aria-selected="true"]'),'selected day',true);if(await dayNode.getAttribute('type')!=='day'||await dayNode.getAttribute('day')!==String(day))fail('Select the exact day node first');
  const title=await nativeDayTitle(page,day);
  const details=[];const rows=page.locator('#schedule_step_area > li.step_li');
  for(let i=0;i<await rows.count();i++){const row=rows.nth(i);const type=await(await one(row.locator('select.schedule_type_select'),'schedule type')).inputValue();const detail={type,newStep:/(^|\s)new_step(\s|$)/.test(await row.getAttribute('class')||'')};if(type==='7'){for(const [key,selector]of Object.entries({title:'.custom_title',short:'.custom_short',description:'textarea.description'}))detail[key]=await readValue(row.locator(selector),selector);}details.push(detail);}
  const meals={};for(const kind of kinds)meals[kind]={type:await value(page,`#meal_area select.select_${kind}_type`),text:await value(page,`#meal_area input.input_${kind}_text`)};
  const hotelIds=await page.locator('#hotel_list_area tr[data-id]').evaluateAll(ns=>ns.map(n=>n.getAttribute('data-id')));
  return {target,day,basic,schedule,title,details,meals,hotelIds};
}
async function choose(page,selector,label){
  const select=await one(page.locator(selector),selector);const choices=await select.evaluate(e=>[...e.options].map(o=>({label:o.textContent.trim(),value:o.value})));
  const matches=choices.filter(o=>o.label===label);if(matches.length!==1)fail('Missing/ambiguous option '+label);
  if(await select.inputValue()!==matches[0].value){const dropdown=await one(select.locator('..').locator('input.select-dropdown.dropdown-trigger'),'visible dropdown',true);await dropdown.click();const escaped=label.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');const item=page.getByRole('listitem').filter({hasText:new RegExp('^\\s*'+escaped+'\\s*$')}).filter({visible:true});await(await one(item,'option '+label,true)).click();}
  if(await select.inputValue()!==matches[0].value)fail('Option not accepted');return matches[0].value;
}
function stable(state){return {target:state.target,day:state.day,basic:state.basic,schedule:state.schedule,hotelIds:state.hotelIds};}
export async function fillBlankScheduleDay(page,target,inputDraft){
  const draft=ScheduleDayDraft.parse(inputDraft);target=ScheduleDayTarget.parse(target);const before=await readScheduleDay(page,target,draft.day);
  if(before.title||before.details.length||before.hotelIds.length||kinds.some(k=>before.meals[k].type!=='16'||before.meals[k].text))fail('Only an empty native day is supported; existing content is protected');
  const mealChoices={};for(const k of kinds){const opts=await page.locator(`#meal_area select.select_${k}_type`).evaluate(e=>[...e.options].map(o=>({label:o.textContent.trim(),value:o.value})));const exact=opts.filter(o=>o.label===draft.meals[k]);if(exact.length>1)fail('Ambiguous meal option');const direct=opts.filter(o=>o.label==='직접입력'&&o.value==='17');if(!exact.length&&direct.length!==1)fail('Custom meal option missing');mealChoices[k]=exact.length?{label:exact[0].label,type:exact[0].value,text:''}:{label:'직접입력',type:'17',text:draft.meals[k]};if(mealChoices[k].type==='17'&&!mealChoices[k].text)fail('Direct meal entry requires actual text');}
  if(before.title!==null)await(await textInput(page,'#schedule_detail_area .input_day_title')).fill(draft.title);
  const add=page.locator('#schedule .add_schedule_detail').filter({visible:true});const count=await add.count();if(count<1||count>2)fail('Missing/ambiguous add detail');await add.first().click();
  const step=await one(page.locator('#schedule_step_area > li.step_li'),'new detail',true);await choose(page,'#schedule_step_area > li.step_li select.schedule_type_select','직접입력');
  await(await textInput(page,'#schedule_step_area > li.step_li .custom_title')).fill(draft.title);
  await(await textInput(page,'#schedule_step_area > li.step_li .custom_short')).fill('');
  await(await textInput(page,'#schedule_step_area > li.step_li textarea.description')).fill(draft.description);
  for(const k of kinds){await choose(page,`#meal_area select.select_${k}_type`,mealChoices[k].label);if(mealChoices[k].type==='17')await(await textInput(page,`#meal_area input.input_${k}_text`)).fill(mealChoices[k].text);}
  const after=await readScheduleDay(page,target,draft.day);if(digest(stable(after))!==digest(stable(before)))fail('Unrequested state changed');
  if(after.title!==(before.title===null?null:draft.title)||after.details.length!==1||after.details[0].type!=='7'||!after.details[0].newStep||after.details[0].title!==draft.title||after.details[0].short!==''||after.details[0].description!==draft.description)fail('Day input mismatch');
  for(const k of kinds)if(after.meals[k].type!==mealChoices[k].type||after.meals[k].text!==mealChoices[k].text)fail('Meal input mismatch');
  return after;
}
/** Only a caller holding a single-use approved review may invoke this write function. */
export async function clickSaveScheduleDayAndVerify(page,expected){
  const current=await readScheduleDay(page,expected.target,expected.day);if(digest(current)!==digest(expected))fail('Day changed since approval');
  if(current.details.length!==1||current.details[0].type!=='7'||!current.details[0].newStep)fail('Not an unsaved blank-day import');
  await(await one(page.locator('#save-master-product'),'save',true)).click();
  await page.locator('#schedule_step_area > li.new_step').waitFor({state:'detached',timeout:15000});
  const saved=await readScheduleDay(page,expected.target,expected.day);const normalize=s=>({...s,details:s.details.map(({newStep,...d})=>d)});
  if(digest(normalize(saved))!==digest(normalize(expected)))fail('Saved day readback mismatch');
  return {status:'schedule-day-saved',productId:expected.target.productId,masterCode:expected.target.masterCode,scheduleId:expected.target.scheduleId,day:expected.day,state:saved,verification:'ERP response rendered in UI; standalone live end-to-end remains unverified'};
}
