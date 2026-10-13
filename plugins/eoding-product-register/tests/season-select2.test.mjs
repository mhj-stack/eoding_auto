import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {chooseAjaxSelect,createSeasonAdapter} from '../src/product-season-adapter.mjs';
import {installProductOnlyFixture,pageUrl} from './fixtures/product-only-page.mjs';

for(const adornment of ['none','clear button','wrong visible label'])test(`season lookup binds one select with ${adornment} when a prior dropdown remains attached`, async t => {
  const browser=await chromium.launch({headless:true});
  t.after(()=>browser.close());
  const page=await browser.newPage();
  await page.route('**/*',route=>route.abort());
  await page.route('https://basecamp.team/common/autocomplete/airport/**',route=>route.fulfill({json:{results:[{id:'5339',text:'ICN - (공항)인천'}]}}));
  await page.route('https://basecamp.team/tour/master_product/1/change/',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:`
    <select id="id_depart-0-depart_cd" data-url="/common/autocomplete/airport/"></select>
    <span id="current-control"><span id="select2-id_depart-0-depart_cd-container">선택해주세요</span></span>
    <span class="select2-container--open"><span class="select2-dropdown"><input class="select2-search__field"><ul id="select2-previous-results" aria-expanded="false"><li class="select2-results__option">Previous closed result</li></ul></span></span>
    <script>
      document.querySelector('#current-control').onclick=()=>{
        const host=document.createElement('span');host.className='select2-container--open';
        host.innerHTML='<span class="select2-dropdown"><input class="select2-search__field"><ul id="select2-id_depart-0-depart_cd-results" aria-expanded="true"></ul></span>';
        document.body.append(host);
        host.querySelector('input').oninput=async event=>{
          const data=await (await fetch('/common/autocomplete/airport/?q='+encodeURIComponent(event.target.value))).json();
          const list=host.querySelector('ul');list.innerHTML='';
          for(const item of data.results){const li=document.createElement('li');li.className='select2-results__option';li.textContent=item.text;list.append(li);
            li.onclick=()=>{document.querySelector('select').add(new Option(item.text,item.id,true,true));const rendered=document.querySelector('#select2-id_depart-0-depart_cd-container');rendered.textContent=${JSON.stringify(adornment)}==='wrong visible label'?'Wrong visible label':item.text;rendered.title=item.text;if(${JSON.stringify(adornment)}!=='none')rendered.insertAdjacentHTML('afterbegin','<span class="select2-selection__clear">×</span>');list.setAttribute('aria-expanded','false');};}
        };
      };
    </script>`}));
  await page.goto('https://basecamp.team/tour/master_product/1/change/');
  const writes=[];page.on('request',req=>{if(!['GET','HEAD'].includes(req.method()))writes.push(req.method());});
  const choice=chooseAjaxSelect(page,page.locator('#id_depart-0-depart_cd'),'depart-0-depart_cd','5339','ICN - (공항)인천','ICN');
  if(adornment==='wrong visible label')await assert.rejects(choice,/native Select2 rendered label differs/);else await choice;
  assert.equal(await page.locator('#id_depart-0-depart_cd').inputValue(),'5339');
  if(adornment==='clear button')assert.equal(await page.locator('#select2-id_depart-0-depart_cd-container').textContent(),'×ICN - (공항)인천','real DOM clear control remains unchanged');
  assert.deepEqual(writes,[]);
});

for(const scenario of ['delayed render','unrelated query response','duplicate results'])test(`season AJAX selection handles ${scenario} without relaxing exact matching`,async t=>{
 const browser=await chromium.launch({headless:true,args:['--host-resolver-rules=MAP * ~NOTFOUND']});t.after(()=>browser.close());
 const page=await browser.newPage(),writes=[],queries=[];
 await page.route('**/*',route=>{if(!['GET','HEAD'].includes(route.request().method()))writes.push(route.request().method());return route.abort();});
 await page.route('https://basecamp.team/common/autocomplete/airline/**',async route=>{
  const query=new URL(route.request().url()).searchParams.get('q');queries.push(query);
  if(query!=='FX')return route.fulfill({status:503,json:{results:[]}});
  if(scenario==='unrelated query response')await new Promise(resolve=>setTimeout(resolve,100));
  const item={id:'17',text:'FX - Fixture Air'};
  return route.fulfill({json:{results:scenario==='duplicate results'?[item,{...item,id:'18'}]:[item]}});
 });
 await page.route('https://basecamp.team/tour/master_product/1/change/',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:`
  <select id="id_arrive-0-airline" data-url="/common/autocomplete/airline/"></select>
  <span id="control"><span id="select2-id_arrive-0-airline-container">Choose</span></span>
  <script>
   window.selectionClicks=0;
   document.querySelector('#control').onclick=()=>{
    const host=document.createElement('span');host.className='select2-dropdown';host.innerHTML='<input class="select2-search__field"><ul id="select2-id_arrive-0-airline-results" aria-expanded="true"></ul>';document.body.append(host);
    host.querySelector('input').oninput=async event=>{
     if(${JSON.stringify(scenario)}==='unrelated query response')await fetch('/common/autocomplete/airline/?q=unrelated');
     const data=await(await fetch('/common/autocomplete/airline/?q='+encodeURIComponent(event.target.value))).json();
     const render=()=>{for(const item of data.results){const li=document.createElement('li');li.className='select2-results__option';li.textContent=item.text;host.querySelector('ul').append(li);
      li.onclick=()=>{window.selectionClicks++;document.querySelector('select').add(new Option(item.text,item.id,true,true));document.querySelector('#select2-id_arrive-0-airline-container').textContent=item.text;};}};
     if(${JSON.stringify(scenario)}==='delayed render')setTimeout(render,200);else render();
    };
   };
  </script>`}));
 await page.goto('https://basecamp.team/tour/master_product/1/change/');
 const choice=chooseAjaxSelect(page,page.locator('#id_arrive-0-airline'),'arrive-0-airline','17','FX - Fixture Air','FX');
 if(scenario==='duplicate results'){
  await assert.rejects(choice,/native Select2 exact result is missing or ambiguous/);
  assert.equal(await page.locator('#id_arrive-0-airline').inputValue(),'');assert.equal(await page.evaluate(()=>window.selectionClicks),0);
 }else{
  await choice;assert.equal(await page.locator('#id_arrive-0-airline').inputValue(),'17');assert.equal(await page.evaluate(()=>window.selectionClicks),1);
 }
 assert.deepEqual(queries,scenario==='unrelated query response'?['unrelated','FX']:['FX']);assert.deepEqual(writes,[]);
});

test('season preparation waits for the delayed add button and delayed modal without a write',async t=>{
 const browser=await chromium.launch({headless:true,args:['--host-resolver-rules=MAP * ~NOTFOUND']});t.after(()=>browser.close());
 const page=await browser.newPage(),writes=[];
 await page.route('**/*',route=>{if(!['GET','HEAD'].includes(route.request().method()))writes.push(route.request().method());return route.abort();});
 await page.route('https://basecamp.team/tour/master_product_season/?product_id=1&init_flag=False',route=>route.fulfill({contentType:'text/html',body:'<input id="master_product_id" value="1"><table id="season_table"><tbody></tbody></table>'}));
 const form='<form id="season_frm"><input type="hidden" name="product_id" value="1"><input type="hidden" name="id" value=""><input id="id_title" name="title"><input name="selected_dates"><input name="start_date"><input name="end_date"><input id="start-date"><input id="end-date"><button id="create_schedule_calendar" type="button">Create calendar</button><div id="multi-calendar"></div></form>';
 await page.route('https://basecamp.team/tour/master_product/1/change/',route=>route.fulfill({contentType:'text/html',body:`<a href="#season">Season</a><div id="season"></div><script>
  document.querySelector('a').onclick=event=>{event.preventDefault();setTimeout(()=>{
   document.querySelector('#season').innerHTML='<button id="add_season" type="button">Add season</button>';
   document.querySelector('#add_season').onclick=()=>setTimeout(()=>{
    document.body.insertAdjacentHTML('beforeend',${JSON.stringify(form)});
    document.querySelector('#create_schedule_calendar').onclick=()=>{document.querySelector('#multi-calendar').innerHTML='<button type="button" class="datepicker-day-button selected" data-year="2027" data-month="0" data-day="10">10</button>';};
   },100);
  },100);};
 </script>`}));
 await page.goto('https://basecamp.team/tour/master_product/1/change/');
 const prepared=await createSeasonAdapter({responseTimeoutMs:2000}).prepare(page,{target:{productId:'1'},plan:{fields:{title:'Synthetic delayed season'},selects:{},selectedDates:['2027-01-10']},assertIdentity:async()=>({companyId:'7',account:'Fixture Operator'})});
 assert.equal(prepared.state,'prepared');assert.deepEqual(prepared.selectedDates,['2027-01-10']);
 assert.equal(Object.fromEntries(prepared.form).title,'Synthetic delayed season');assert.equal(Object.fromEntries(prepared.form).product_id,'1');
 assert.deepEqual(writes,[]);
});

for(const scenario of ['exact widget','duplicate options','unsupported widget'])test(`season static selection operates only the ${scenario}`,async t=>{
 const browser=await chromium.launch({headless:true,args:['--host-resolver-rules=MAP * ~NOTFOUND']});t.after(()=>browser.close());
 const context=await browser.newContext(),product=JSON.parse(await readFile(new URL('../examples/product.json',import.meta.url),'utf8'));
 const fixture=await installProductOnlyFixture(context,{product}),page=await context.newPage();await page.goto(pageUrl);
 await page.evaluate(scenario=>{
  const select=document.querySelector('#season_frm select[name="departport"]');select.style.display='none';
  if(scenario==='unsupported widget')return;
  const wrapper=document.createElement('div');wrapper.className='select-wrapper';select.before(wrapper);wrapper.append(select);
  const trigger=document.createElement('input');trigger.type='text';trigger.readOnly=true;trigger.className='select-dropdown dropdown-trigger';trigger.dataset.target='season-static-options';
  const menu=document.createElement('ul');menu.id=trigger.dataset.target;menu.hidden=true;
  for(const nativeOption of select.options){
   const item=document.createElement('li'),span=document.createElement('span');span.textContent=nativeOption.textContent;item.append(span);menu.append(item);
   item.onclick=()=>{select.value=nativeOption.value;select.dispatchEvent(new Event('change',{bubbles:true}));trigger.value=nativeOption.textContent;menu.hidden=true;};
  }
  if(scenario==='duplicate options')menu.lastElementChild.after(menu.lastElementChild.cloneNode(true));
  trigger.onclick=()=>{menu.hidden=false;};wrapper.append(trigger,menu);
  // An unrelated menu may contain the same label. It must never be selected.
  const unrelated=document.createElement('ul');unrelated.id='unrelated-options';unrelated.innerHTML='<li><span>Fixture departure</span></li>';unrelated.onclick=()=>{window.wrongSeasonOptionClicked=true;};document.body.append(unrelated);
 },scenario);
 const adapter=createSeasonAdapter({responseTimeoutMs:1500}),options={target:{productId:fixture.productId},plan:{fields:{title:'Synthetic season'},selects:{departport:'1'},selectLabels:{departport:'Fixture departure'},selectedDates:['2027-01-10']},assertIdentity:async()=>({companyId:'7',account:'Fixture Operator'})};
 if(scenario==='exact widget'){
  const prepared=await adapter.prepare(page,options);assert.equal(prepared.state,'prepared');assert.equal(Object.fromEntries(prepared.form).departport,'1');
  assert.equal(await page.locator('#season_frm select[name="departport"]').inputValue(),'1');assert.equal(await page.locator('input[data-target="season-static-options"]').inputValue(),'Fixture departure');
 }else await assert.rejects(adapter.prepare(page,options),scenario==='duplicate options'?/dropdown option is missing or ambiguous/:/unsupported hidden season select/);
 assert.equal(await page.evaluate(()=>Boolean(window.wrongSeasonOptionClicked)),false);assert.deepEqual(fixture.writes,[]);
});
