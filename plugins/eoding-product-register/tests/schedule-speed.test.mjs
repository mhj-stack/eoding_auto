import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readScheduleDay as atomic } from '../src/schedule-day.mjs';
import { readScheduleDay as sequential } from './fixtures/schedule-day-sequential.mjs';
import { writeFitScheduleDay } from '../src/fit-schedule.mjs';
import { writeScheduleDay as legacyFit } from './fixtures/fit-schedule-sequential.mjs';
import { chainPage, DETAIL, PRODUCT_ID, SCHEDULE_ID } from './fixtures/product-chain-page.mjs';
import { fitSchedulePage } from './fixtures/fit-schedule-page.mjs';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const product = { title: 'Fixture schedule', nights: 1, days: 2, itinerary: [{ day: 1 }, { day: 2 }] };
const schedule = { title: 'Fixture itinerary', night: 1, day: 2 };
const target = { productId: PRODUCT_ID, masterCode: 'CJU-SYNTHETIC', title: product.title, account: 'Fixture Operator', scheduleId: SCHEDULE_ID, scheduleCode: 'CHAIN-SCHEDULE', scheduleTitle: schedule.title };

async function packagePage(t) {
  const browser = await chromium.launch({ headless: true });t.after(()=>browser.close());
  const page = await browser.newPage();
  await page.route('**/*',route=>route.request().url()===DETAIL?route.fulfill({body:chainPage(product,schedule,{}),contentType:'text/html'}):route.abort());
  await page.goto(DETAIL);await page.locator('#schedule_list_table tr').click();await page.locator('[role=treeitem][day="1"] > a').click();
  await page.evaluate(()=>{addStep();document.querySelector('.custom_title').value='Title';document.querySelector('.custom_short').value='Short';document.querySelector('.description').value='Description';document.querySelector('.select_breakfast_type').value='17';document.querySelector('.input_breakfast_text').value='Meal';});
  return page;
}

function measured(page, delay=2) {
  let calls=0;
  const sync=new Set(['url','locator','first','nth','filter','getByRole']);
  const wrap=target=>new Proxy(target,{get(owner,key){const value=Reflect.get(owner,key);if(typeof value!=='function')return value;return(...args)=>{
    if(sync.has(key)){const found=value.apply(owner,args);return found&&typeof found==='object'?wrap(found):found;}
    calls++;return pause(delay).then(()=>value.apply(owner,args));
  };}});
  return {page:wrap(page),calls:()=>calls};
}

test('atomic package day snapshot preserves every field and reduces browser round trips',async t=>{
  const page=await packagePage(t),before=measured(page),after=measured(page);
  let at=performance.now();const old=await sequential(before.page,target,1),oldMs=Math.round(performance.now()-at);
  at=performance.now();const next=await atomic(after.page,target,1),newMs=Math.round(performance.now()-at);
  assert.deepEqual(next,old);assert.ok(after.calls()<before.calls()/3);
  assert.doesNotMatch(JSON.stringify(next),/secret-not-to-be-read|token-not-to-be-read/);
  t.diagnostic(JSON.stringify({benchmark:'package-day-snapshot',browserCallDelayMs:2,beforeCalls:before.calls(),afterCalls:after.calls(),beforeMs:oldMs,afterMs:newMs,liveErp:false}));
});

test('atomic day snapshot rejects changed identity, ambiguous fields and unsafe meal controls',async t=>{
  const page=await packagePage(t);
  for(const [change,message] of [
    [()=>{document.querySelector('#eoding-name').textContent='Different';},/Account display changed/],
    [()=>{document.querySelector('#eoding-name').textContent='Fixture Operator';document.querySelector('#id_schedule_name').value='Different';},/Schedule identity/],
    [()=>{document.querySelector('#id_schedule_name').value='Fixture itinerary';document.querySelector('.input_lunch_text').type='password';},/Unexpected field type/],
    [()=>{document.querySelector('.input_lunch_text').type='text';document.querySelector('#eoding-name').after(document.querySelector('#eoding-name').cloneNode(true));},/Missing\/ambiguous account/]
  ]){await page.evaluate(change);await assert.rejects(atomic(page,target,1),message);}
});

test('atomic snapshot preserves title-less native days, foreign detail types and existing hotel IDs',async t=>{
  const page=await packagePage(t);
  await page.evaluate(()=>{
    document.querySelector('.input_day_title').remove();
    document.querySelector('#schedule_detail_area').innerHTML='<div class="step"><div class="head">1 일차</div></div>';
    document.querySelector('#hotel_list_area').innerHTML='<tr data-id="91"></tr><tr data-id="92"></tr>';
    document.querySelector('.step_li').innerHTML='<select class="schedule_type_select"><option value="4">place</option></select>';
  });
  const state=await atomic(page,target,1);
  assert.deepEqual(state,await sequential(page,target,1));assert.equal(state.title,null);assert.deepEqual(state.hotelIds,['91','92']);
});

test('atomic snapshot retains native visibility semantics for display-contents controls',async t=>{
  const page=await packagePage(t);
  await page.evaluate(()=>{const account=document.querySelector('#eoding-name');account.innerHTML='<span>Fixture Operator</span>';account.style.display='contents';});
  assert.deepEqual(await atomic(page,target,1),await sequential(page,target,1));
});

async function fitPage(t,options={}) {
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
  const page=await browser.newPage(),posts=[];
  await page.route('**/*',async route=>{
    const request=route.request();
    if(request.url()==='https://basecamp.team/fit/master/812345/change/')return route.fulfill({body:fitSchedulePage(options),contentType:'text/html'});
    if(request.url()==='https://basecamp.team/fit/schedule/812345/change/'&&request.method()==='POST'){posts.push(request.postDataJSON());await pause(15);return route.fulfill({body:'{}',contentType:'application/json'});}
    return route.abort();
  });
  await page.goto('https://basecamp.team/fit/master/812345/change/');return{page,posts};
}
const day={day:1,steps:Array.from({length:6},(_,index)=>index%2?{kind:'place',title:`Place ${index}`,description:'Memo',places:['temple']}:{kind:'custom',title:`Custom ${index}`,short:'Short',description:'Description'})};
const places={temple:{id:91,name_ko:'Temple'}};

test('condition-driven FIT editor creates the same payload without fixed per-step sleeps', {timeout:60000},async t=>{
  const old=await fitPage(t),next=await fitPage(t);
  let at=performance.now();await legacyFit(old.page,'812345',day,places);const beforeMs=Math.round(performance.now()-at);
  at=performance.now();await writeFitScheduleDay(next.page,'812345',day,places);const afterMs=Math.round(performance.now()-at);
  assert.deepEqual(next.posts,old.posts);assert.equal(next.posts.length,1);assert.equal(next.posts[0].length,6);
  t.diagnostic(JSON.stringify({benchmark:'six-step-FIT-schedule',beforeMs,afterMs,savePostsBefore:old.posts.length,savePostsAfter:next.posts.length,liveErp:false}));
});

test('slow native type hydration is awaited and excess steps are deleted before saving',async t=>{
  const f=await fitPage(t,{typeDelay:1400,initialSteps:4});
  await writeFitScheduleDay(f.page,'812345',{day:1,steps:[day.steps[1]]},places);
  assert.equal(f.posts.length,1);assert.equal(f.posts[0].length,1);assert.equal(f.posts[0][0].type,'4');assert.deepEqual(f.posts[0][0].contents,['91']);
});

test('an ignored add click times out without retries or saving',async t=>{
  const f=await fitPage(t,{ignoreAdd:true});let clicks=0;
  await f.page.exposeFunction('countAdd',()=>{clicks++;});await f.page.evaluate(()=>document.querySelector('.add_schedule_detail').addEventListener('click',()=>countAdd()));
  await assert.rejects(writeFitScheduleDay(f.page,'812345',{day:1,steps:[day.steps[0]]},places,{timeout:250}),/Timeout/);
  assert.equal(clicks,1);assert.equal(f.posts.length,0);
});

test('changed target or account prevents a FIT schedule save',async t=>{
  const f=await fitPage(t);
  await assert.rejects(writeFitScheduleDay(f.page,'812345',{day:1,steps:[day.steps[0]]},places,{assertIdentity:async()=>{throw Error('account changed');}}),/account changed/);
  await assert.rejects(writeFitScheduleDay(f.page,'999999',{day:1,steps:[day.steps[0]]},places),/상품 주소/);
  assert.equal(f.posts.length,0);
});
