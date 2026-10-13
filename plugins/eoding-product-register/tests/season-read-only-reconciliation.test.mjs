import assert from 'node:assert/strict';
import test from 'node:test';
import {chromium} from 'playwright';
import {createSeasonAdapter} from '../src/product-season-adapter.mjs';
import {installProductOnlyFixture,origin,pageUrl} from './fixtures/product-only-page.mjs';

const esc=value=>String(value).replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');
function blankRows(){
 return ['depart','arrive'].map(direction=>`<table><tbody id="${direction}_rows">${[1,2].map(index=>{
  const prefix=`${direction}-${index}-`;
  return `<tr style="display:none;"><td>${['id','depart_date','flight_no','depart_time','arrive_time','moving_time','code_share'].map(name=>`<input name="${prefix+name}" type="${name==='id'?'hidden':'text'}" value="">`).join('')}${['airline','depart_cd','arrive_cd'].map(name=>`<select name="${prefix+name}" data-init-id=""></select>`).join('')}<select name="${prefix}next_day"><option value="" selected>--</option><option value="1">+1</option></select></td></tr>`;
 }).join('')}</tbody></table>`).join('');
}
async function fixture(t,{persistBySave=false}={}){
 const browser=await chromium.launch({headless:true,args:['--host-resolver-rules=MAP * ~NOTFOUND']});t.after(()=>browser.close());
 const owner=await browser.newContext({serviceWorkers:'block'}),f=await installProductOnlyFixture(owner),page=await owner.newPage();await page.goto(pageUrl);
 const adapter=createSeasonAdapter({responseTimeoutMs:2500}),target={productId:f.productId};
 const plan={fields:{title:'Fixture saved season',adult_base_price:'123400','depart-0-flight_no':'FX101','depart-0-depart_time':'11:20'},selects:{departport:'1','depart-0-airline':'2'},selectedDates:['2027-01-10']};
 const assertIdentity=async()=>({identityDigest:'fixture-original-session'}),prepared=await adapter.prepare(page,{target,plan,assertIdentity});
 const durablePrepared=structuredClone(prepared);let receipt;
 if(persistBySave)receipt=await adapter.save(page,prepared,{assertIdentity,beforeWrite:async({binding})=>({status:'approved',bindingDigest:binding.digest,approvalId:'fixture-approval'}),record:async({binding})=>({durable:true,bindingDigest:binding.digest,evidenceId:'fixture-evidence'})});
 else f.state.seasons.push({...Object.fromEntries(prepared.form),id:'50000'});
 const seasonId=f.state.seasons[0].id,values=Object.fromEntries(durablePrepared.form);
 const fieldHtml=Object.entries(values).filter(([name])=>!['id','product_id',...Object.keys(plan.selects)].includes(name)).map(([name,value])=>`<input name="${name}" value="${esc(name==='depart-0-depart_time'?value+':00':value)}">`).join('');
 let html=`<form id="season_frm"><input name="id" type="hidden" value="${seasonId}"><div><input name="id" value="${seasonId}"></div>${fieldHtml}<select name="departport"><option value="">Choose</option><option value="1" selected>Fixture departure</option></select><select name="depart-0-airline" data-init-id="2"></select>${blankRows()}</form>`;
 await owner.route(origin+`/tour/master_product_season/${seasonId}/change/`,route=>route.fulfill({contentType:'text/html',body:html}));
 return {...f,owner,page,adapter,target,plan,assertIdentity,prepared:durablePrepared,receipt,seasonId,changeHtml:change=>{html=change(html);}};
}

test('native receipt verification accepts only hidden wholly blank extra flight rows and reads static selected options',async t=>{
 const f=await fixture(t,{persistBySave:true});
 const proof=await f.adapter.verifyReceipt(f.page,f.receipt,{target:f.target,plan:f.plan,assertIdentity:f.assertIdentity});
 assert.equal(proof.saved.selects.departport,'1');assert.equal(proof.saved.selects['depart-0-airline'],'2');assert.equal(proof.saved.fields['depart-0-depart_time'],'11:20');
 assert.deepEqual(f.writes.map(write=>write.kind),['season']);
});

test('read-only reconciliation verifies an uncertain saved season without fabricating a POST receipt or writing again',async t=>{
 const f=await fixture(t),before=structuredClone(f.prepared);
 const proof=await f.adapter.reconcileSavedSeason(f.page,{prepared:f.prepared,assertIdentity:async()=>({identityDigest:'fixture-current-session'})});
 assert.equal(proof.kind,'season-read-only-reconciliation-v1');assert.equal(proof.seasonId,f.seasonId);assert.deepEqual(proof.listMembership,[f.seasonId]);
 assert.equal(proof.forwardedWrites,0);assert.equal(proof.originalIdentityDigest,f.prepared.identityDigest);assert.notEqual(proof.identityDigest,proof.originalIdentityDigest);
 assert.equal(proof.saved.selects.departport,'1');assert.equal(proof.guardedPosts,undefined);assert.deepEqual(f.prepared,before);assert.deepEqual(f.writes,[]);
});

for(const [scenario,change,pattern]of [
 ['partially filled hidden row',html=>html.replace('name="depart-1-flight_no" type="text" value=""','name="depart-1-flight_no" type="text" value="FX999"'),/unused flight row/],
 ['hidden row with an unexpected selected airline',html=>html.replace('name="depart-1-airline" data-init-id=""','name="depart-1-airline" data-init-id="9"'),/unused flight row/],
 ['visible empty row',html=>html.replace('style="display:none;"','style="display:block;"'),/unused flight row/],
 ['changed approved airline',html=>html.replace('name="depart-0-airline" data-init-id="2"','name="depart-0-airline" data-init-id="9"'),/saved select value differs/],
 ['changed static departure port',html=>html.replace('value="1" selected','value="9" selected'),/saved select value differs/],
 ['changed approved price',html=>html.replace('name="adult_base_price" value="123400"','name="adult_base_price" value="123401"'),/saved native season field differs/],
 ['duplicate approved select',html=>html.replace('</form>','<select name="departport"><option value="1" selected>Duplicate</option></select></form>'),/saved approved control is missing or duplicated/]
])test(`read-only reconciliation rejects ${scenario}`,async t=>{
 const f=await fixture(t);f.changeHtml(change);
 await assert.rejects(f.adapter.reconcileSavedSeason(f.page,{prepared:f.prepared,assertIdentity:f.assertIdentity}),pattern);assert.deepEqual(f.writes,[]);
});

for(const count of [0,2])test(`read-only reconciliation refuses ${count} new seasons`,async t=>{
 const f=await fixture(t);if(!count)f.state.seasons=[];else f.state.seasons.push({...f.state.seasons[0],id:'50001'});
 await assert.rejects(f.adapter.reconcileSavedSeason(f.page,{prepared:f.prepared,assertIdentity:f.assertIdentity}),/exactly one new saved season/);assert.deepEqual(f.writes,[]);
});

test('read-only reconciliation rejects changed original preparation before reading ERP',async t=>{
 const f=await fixture(t);f.prepared.form.find(([name])=>name==='title')[1]='Changed';let reads=0;
 f.page.on('request',()=>reads++);
 await assert.rejects(f.adapter.reconcileSavedSeason(f.page,{prepared:f.prepared,assertIdentity:f.assertIdentity}),/reconciliation evidence changed/);assert.equal(reads,0);assert.deepEqual(f.writes,[]);
});

test('read-only reconciliation aborts an incidental ERP write and refuses changing identity',async t=>{
 const f=await fixture(t);let identities=0;
 await assert.rejects(f.adapter.reconcileSavedSeason(f.page,{prepared:f.prepared,assertIdentity:async()=>{
  identities++;if(identities===1)await f.page.evaluate(()=>fetch('/unexpected-read-only-write',{method:'POST',body:'fixture'}).catch(()=>{}));
  return {identityDigest:identities===1?'first':'changed'};
 }}),/changed during read-only reconciliation/);assert.deepEqual(f.writes,[]);assert.deepEqual(f.state.unexpected,[]);
});
