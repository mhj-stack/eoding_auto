// Synthetic persistence backend; no real ERP requests are permitted by its caller.
import {eventHTML} from './departure-candidate-page.mjs';
const esc=value=>String(value).replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');
const field=(id,value,name='')=>`<input id="${id}" ${name?`name="${name}"`:''} value="${esc(value)}">`;
const nativeNames=['master_product_id','status','title','dept','dept2','manager','product_division_label','schedule','currency_code','adult_price','child_price','infant_price','adult_fuel_price','child_fuel_price','infant_fuel_price','payment_full_flag','payment_deposit_flag','payment_deposit_person','reward_type','reward_value','use_custom_price','custom_price_estimate','form-TOTAL_FORMS','form-INITIAL_FORMS','form-MIN_NUM_FORMS','form-MAX_NUM_FORMS','min_pax_count','max_pax_count','selected_dates','default_contract_id','estimate_term_id','depart_airline','return_airline','default_contract_title'];
export function departureForm(scheduleId,scheduleTitle){
 return eventHTML.replaceAll('9001',scheduleId).replace('[#SC-FIXTURE] [1박2일] 가상 일정',`[1박2일] ${esc(scheduleTitle)}`)+`<script>
 const form=document.querySelector('#create_product_form');
 for(const [id,value] of Object.entries({'custom_price_estimate':'','form-INITIAL_FORMS':'0','form-MIN_NUM_FORMS':'0','form-MAX_NUM_FORMS':'1000'})){const e=document.createElement('input');e.type='hidden';e.id='id_'+id;e.value=value;form.append(e);}
 for(const name of ${JSON.stringify(nativeNames)})for(const e of document.querySelectorAll('[id="id_'+name+'"]'))e.name=name;
 create_schedule_calendar.addEventListener('click',()=>{id_selected_dates.value=document.getElementById('start-date').value;});
 create_tour_product.onclick=()=>{const m=document.createElement('div');m.id='bs-modal-message';m.className='open';m.innerHTML='<span id="message">행사를 생성 하시겠습니까?</span><button id="confirm-alert">확인</button>';m.querySelector('button').onclick=()=>fetch('/tour/master_product/812345/create_product/',{method:'POST',body:new FormData(form)});document.body.append(m);};
 </script>`;
}
export function createDeparturePersistence(sourceDetail){
 const records=new Map(),requests=[];
 const inputFields=obj=>Object.entries(obj).map(([id,value])=>field(id,value)).join('');
 function eventPage(id){const p=records.get(id).fields;
  const end=new Date(p.selected_dates+'T00:00:00Z');end.setUTCDate(end.getUTCDate()+sourceDetail().schedule.day-1);
  const out=p.selected_dates.replaceAll('-','/'),back=end.toISOString().slice(0,10).replaceAll('-','/');
  const obj={id_status:p.status,id_title:p.title,id_dept:p.dept,id_dept2:p.dept2,id_manager:p.manager,id_min_pax_count:p.min_pax_count,id_max_pax_count:p.max_pax_count,id_res_count:'0',id_currency_code:p.currency_code,id_adult_total_price:p.adult_price,id_child_total_price:p.child_price,id_infant_total_price:p.infant_price,id_master_product_code:'CJU-SYNTHETIC',id_tour_season:`${out} ~ ${back} (${sourceDetail().schedule.night}박${sourceDetail().schedule.day}일)`,id_depart_flight:'전용차량 '+out,id_return_flight:'전용차량 '+back};
  return '<div id="eoding-name">Fixture Operator</div><section id="priceNAir" data-season-id="'+(8800+Number(id)-60000)+'"></section>'+inputFields(obj);
 }
 function pricePage(id){const p=records.get(id).fields;
  const obj={currency_code:p.currency_code,adult_base_price:p.adult_price,child_base_price:p.child_price,infant_base_price:p.infant_price,adult_fuel_price:p.adult_fuel_price,child_fuel_price:p.child_fuel_price,infant_fuel_price:p.infant_fuel_price,min_pax_count:p.min_pax_count,max_pax_count:p.max_pax_count,payment_full_flag:p.payment_full_flag,payment_deposit_flag:p.payment_deposit_flag,payment_deposit_person:p.payment_deposit_person,estimate_term_id:p.estimate_term_id,use_custom_price:p.use_custom_price,custom_price_estimate:p.custom_price_estimate,reward_type:p.reward_type,reward_value:Number(p.reward_value).toFixed(2),'member_prices-TOTAL_FORMS':'0'};
  return Object.entries(obj).map(([name,value])=>field('id_'+name,value,name)).join('')+'<input id="id_payment_deposit_infant" name="payment_deposit_infant" type="checkbox" value="on">';
 }
 function reservationPage(id){return field('product_id',id)+'<table id="reservation_table"><tbody id="reservation_list_tbody"><tr id="reservation_empty"><td>등록된 예약이 없습니다.</td></tr></tbody></table>'+['max_pax_count_in_list','res_pax_cnt_in_list','res_cancel_pax_cnt_in_list','real_res_cnt_in_list','adult_cnt_in_list','child_cnt_in_list','infant_cnt_in_list','man_res_cnt_in_list','female_res_cnt_in_list'].map(name=>`<span id="${name}">${name.startsWith('man_')||name.startsWith('female_')?'0명 (0%)':/^(adult|child|infant)/.test(name)?'0':''}</span>`).join('');}
 function copiedPage(id){const s=sourceDetail();return field('selected_schedule_id',String(8200+Number(id)-60000))+field('id_night',s.schedule.night)+field('id_day',s.schedule.day)+field('id_schedule_name',s.schedule.title)+`<textarea id="schedule_tree_json">${esc(JSON.stringify(s.schedule_tree.map((row,index)=>({...row,id:990000+Number(id)+index}))))}</textarea><textarea id="schedule_contents_json">${esc(JSON.stringify(s.contents))}</textarea><textarea id="schedule_image_json">${esc(JSON.stringify(s.images))}</textarea>`;}
 async function route(requestRoute){
  const req=requestRoute.request(),u=new URL(req.url());requests.push({method:req.method(),path:u.pathname});
  const html=body=>requestRoute.fulfill({contentType:'text/html; charset=utf-8',body});
  if(req.method()==='POST'&&u.pathname==='/tour/master_product/812345/create_product/'){
   const body=req.postData();const pairs=[...body.matchAll(/name="([^"]+)"\r\n\r\n([\s\S]*?)\r\n--/g)].map(([,k,v])=>[k,v]);
   const id=String(60001+records.size);records.set(id,{fields:Object.fromEntries(pairs),pairs});await requestRoute.fulfill({status:201,json:{accepted:true}});return true;
  }
  if(req.method()!=='GET')return false;
  if(u.pathname==='/tour/product/'){
   // Emulate real async DataTables hydration, including after the write.
   const rows=[...records.keys()].map(id=>({_aData:{id:Number(id)}}));
   await html(`<div id="eoding-name">Fixture Operator</div><script>window.jQuery={fn:{dataTable:{settings:[{_bInitComplete:false,_iRecordsTotal:0,_iRecordsDisplay:0,aoData:[]}]}}};setTimeout(()=>{Object.assign(jQuery.fn.dataTable.settings[0],{_bInitComplete:true,_iRecordsTotal:${rows.length},_iRecordsDisplay:${rows.length},aoData:${JSON.stringify(rows)}})},150);</script>`);return true;
  }
  let m=/^\/tour\/product\/(\d+)\/change\/$/.exec(u.pathname);if(m&&records.has(m[1])){await html(eventPage(m[1]));return true;}
  m=/^\/tour\/tour_product_season\/(\d+)\/change\/$/.exec(u.pathname);if(m){const id=String(60000+Number(m[1])-8800);if(records.has(id)){await html(pricePage(id));return true;}}
  m=/^\/tour\/reservation_by_product\/(\d+)\/change\/$/.exec(u.pathname);if(m&&records.has(m[1])){await html(reservationPage(m[1]));return true;}
  m=/^\/tour\/product_schedule\/(\d+)\/update\/$/.exec(u.pathname);if(m&&records.has(m[1])){await html(copiedPage(m[1]));return true;}
  return false;
 }
 return {route,records,requests};
}
