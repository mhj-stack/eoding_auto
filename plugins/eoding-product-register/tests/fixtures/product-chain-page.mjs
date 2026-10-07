import { basicFixture } from './basic-page.mjs';
import { listFixture } from './product-list-page.mjs';
export { listFixture };
export const ORIGIN='https://basecamp.team';
export const PRODUCT_ID='812345', SCHEDULE_ID='7001';
export const ADD=ORIGIN+'/tour/master_product/add/';
export const DETAIL=ORIGIN+`/tour/master_product/${PRODUCT_ID}/change/`;
export const account='<div id="eoding-name">Fixture Operator</div>';
export function initialBasic(){return basicFixture.replace("/tour/master_product/detail/812345/",`/tour/master_product/${PRODUCT_ID}/change/`)+account+'<script>window.navigate=true</script>';}
export function basicDetail(product){return initialBasic().replace('<title>어딩 상품추가</title>','<title>어딩 상품상세</title>')+`<script>
for(const [id,v] of Object.entries(${JSON.stringify({'id_2-title':product.title,'id_2-sort':'7','id_2-master_code':'CJU-SYNTHETIC','id_2-master_url':`https://tenant.eoding-demo.com/master/${PRODUCT_ID}`,'id_2-reservation_available_date':'3','id_2-status':'2'})}))document.getElementById(id).value=v;
for(const [kind,val,label] of [['city','city-1','제주(CJU)'],['manager','manager-1','가상담당자 (테스트팀)']]){const s=document.querySelector('#id_2-'+kind);if(s)s.value=val;const display=document.querySelector('#select2-id_2-'+kind+'-container');if(display){display.textContent=label;display.title=label;}}
</script>`;}
export const scheduleRow=s=>`<tr data-schedule-id="${SCHEDULE_ID}" onclick="this.classList.add('selected')"><td><input name="selected_schedule" type="checkbox" data-id="${SCHEDULE_ID}"></td><td class="schedule_title">${s.title}</td><td class="schedule_night">${s.night}</td><td class="schedule_day">${s.day}</td></tr>`;
export function chainPage(product,schedule,days){
 const rows=schedule?scheduleRow(schedule):'';
 return basicDetail(product)+`<a href="#schedule" id="id_schedule_tab" onclick="location.hash='schedule';return false">일정표관리</a>
 <style>#schedule_list_table{display:block;min-height:2px;min-width:500px}</style><section id="schedule"><table><tbody id="schedule_list_table">${rows}</tbody></table><button class="add_schedule" onclick="add_schedule_modal.hidden=false">추가</button>
 <input id="id_schedule_code" value="CHAIN-SCHEDULE"><input id="id_schedule_name" value="${schedule?.title??''}"><input id="id_night" value="${product.nights}"><input id="id_day" value="${product.days}"><select id="id_meeting_location"><option value=""></option></select><input id="id_desc">
 <ul>${product.itinerary.map(d=>`<li style="height:80px" role="treeitem" type="day" day="${d.day}" aria-selected="false"><a href="#" onclick="selectDay(${d.day},this.parentElement);return false">${d.day}일차</a><ul><li>호텔</li><li>식사</li></ul></li>`).join('')}</ul>
 <div id="schedule_detail_area"><input class="input_day_title"></div><button class="add_schedule_detail" onclick="addStep()">세부 추가</button><ul id="schedule_step_area"></ul>
 <div id="meal_area">${['breakfast','lunch','dinner'].map(k=>`<div><select class="select_${k}_type"><option value="16">불포함</option><option value="17">직접입력</option></select><input readonly class="select-dropdown dropdown-trigger" onclick="this.nextElementSibling.hidden=false"><ul hidden><li onclick="chooseMeal(this,'${k}',16)">불포함</li><li onclick="chooseMeal(this,'${k}',17)">직접입력</li></ul></div><input class="input_${k}_text">`).join('')}</div>
 <table><tbody id="hotel_list_area"></tbody></table><button id="save-master-product" onclick="saveDay()">일차 저장</button></section>
 <div id="add_schedule_modal" hidden><input id="id_new_night"><input id="id_new_day"><input id="id_new_schedule_name"><button id="create_new_schedule" onclick="saveShell()">생성</button></div>
 <script>
 const savedDays=${JSON.stringify(days)};let selectedDay;
 function chooseMeal(li,k,v){document.querySelector('.select_'+k+'_type').value=String(v);li.parentElement.hidden=true;}
 function selectDay(n,node){selectedDay=n;document.querySelectorAll('[role=treeitem]').forEach(e=>e.setAttribute('aria-selected','false'));node.setAttribute('aria-selected','true');document.querySelector('.input_day_title').value='';schedule_step_area.innerHTML='';for(const k of ['breakfast','lunch','dinner']){document.querySelector('.select_'+k+'_type').value='16';document.querySelector('.input_'+k+'_text').value='';}}
 function addStep(){schedule_step_area.innerHTML='<li class="step_li new_step"><span>일정 내용</span><select class="schedule_type_select"><option value="7">직접입력</option></select><input class="custom_title"><input class="custom_short"><textarea class="description"></textarea></li>';}
 async function saveShell(){const f=new FormData();f.set('title',id_new_schedule_name.value);f.set('day',id_new_day.value);f.set('night',id_new_night.value);f.set('product','${PRODUCT_ID}');const r=await fetch('/tour/master_product_schedule/add/',{method:'POST',body:f});if(!r.ok)return;const s=await r.json();schedule_list_table.innerHTML='<tr data-schedule-id="'+s.id+'"><td class="schedule_title">'+s.title+'</td><td class="schedule_night">'+s.night+'</td><td class="schedule_day">'+s.day+'</td></tr>';schedule_list_table.querySelector('tr').onclick=function(){this.classList.add('selected')};id_schedule_name.value=s.title;add_schedule_modal.hidden=true;}
 async function saveDay(){const title=document.querySelector('.input_day_title').value,meal_list={title};for(const k of ['breakfast','lunch','dinner']){meal_list[k+'_type']=Number(document.querySelector('.select_'+k+'_type').value);meal_list[k+'_text']=document.querySelector('.input_'+k+'_text').value;}const payload={day:selectedDay,product_id:'${PRODUCT_ID}',updated_list:[],deleted_list:[],created_list:[{type_id:7,step:1,etc1:document.querySelector('.custom_title').value,etc2:'',description:document.querySelector('.description').value,images:[],day:selectedDay}],meal_list};const r=await fetch('/tour/master_product_schedule/${SCHEDULE_ID}/change/',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});if(r.ok)document.querySelector('.step_li').classList.remove('new_step');}
 </script>`;
}
export function serverDetail(product,schedule,saved){
 const tree=[];
 for(const draft of product.itinerary){const p=saved[draft.day],meals={};for(const k of ['breakfast','lunch','dinner']){meals[k+'_type']=p?.meal_list[k+'_type']??16;meals[k+'_text']=p?.meal_list[k+'_text']??'';}const common={day:draft.day,day_title:p?.meal_list.title??'',etc3:'',etc4:'',etc5:'',etc6:'',...meals};tree.push({id:800000+draft.day*10,step:999,type_id:2,etc1:'',etc2:'',description:null,...common});if(p)tree.push({id:800001+draft.day*10,step:1,type_id:7,etc1:p.created_list[0].etc1,etc2:'',description:p.created_list[0].description,...common});}
 return {schedule:{id:Number(SCHEDULE_ID),product:Number(PRODUCT_ID),title:schedule.title,day:product.days,night:product.nights,code:'CHAIN-SCHEDULE',visit_route:null,schedule_meeting:null,meeting_remark:'',use_flag:true,sort:0},schedule_tree:tree,contents:[],images:[]};
}
