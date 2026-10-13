import assert from 'node:assert/strict';
import test from 'node:test';
import {chromium} from 'playwright';
import {createSeasonAdapter,UnknownSeasonOutcomeError} from '../src/product-season-adapter.mjs';
import {installProductOnlyFixture,origin,pageUrl} from './fixtures/product-only-page.mjs';

for(const scenario of ['foreign telemetry','same-origin unexpected write'])test(`pending native season save aborts ${scenario} with the correct outcome`,async t=>{
 const browser=await chromium.launch({headless:true,args:['--host-resolver-rules=MAP * ~NOTFOUND']});t.after(()=>browser.close());
 const owner=await browser.newContext({serviceWorkers:'block'}),f=await installProductOnlyFixture(owner),page=await owner.newPage();
 await page.goto(pageUrl);
 const adapter=createSeasonAdapter({responseTimeoutMs:3000}),target={productId:f.productId};
 const plan={fields:{title:'Fixture guarded season'},selects:{},selectedDates:['2027-01-10']};
 const assertIdentity=async()=>({identityDigest:'fixture-identity'});
 const prepared=await adapter.prepare(page,{target,plan,assertIdentity});
 const incidentalUrl=scenario==='foreign telemetry'?'https://telemetry.fixture.test/collect':origin+'/unexpected-season-write';
 let forwardedIncidental=0,interceptedSeason=0;const blocked=[];
 page.on('requestfailed',request=>{if(request.url()===incidentalUrl)blocked.push(request);});
 await owner.route(incidentalUrl,route=>{forwardedIncidental++;return route.fulfill({status:204});});
 // This handler is below the native write guard. Hold the accepted season POST
 // pending while the page emits another request; neither request uses the web.
 await owner.route(origin+'/tour/master_product_season/add/',async route=>{
  interceptedSeason++;
  await page.evaluate(url=>fetch(url,{method:'POST',mode:'no-cors',body:'fixture'}).catch(()=>{}),incidentalUrl);
  return route.fallback();
 });
 const saving=adapter.save(page,prepared,{assertIdentity,
  beforeWrite:async({binding})=>({status:'approved',bindingDigest:binding.digest,approvalId:'fixture-approval'}),
  record:async({binding})=>({durable:true,bindingDigest:binding.digest,evidenceId:'fixture-evidence'})});
 if(scenario==='foreign telemetry'){
  const receipt=await saving;
  assert.equal(receipt.kind,'season-save-receipt-v1');assert.equal(receipt.guardedPosts,1);
  assert.equal((await adapter.verifyReceipt(page,receipt,{target,plan,assertIdentity})).kind,'season-receipt-verification-v1');
 }else{
  await assert.rejects(saving,error=>error instanceof UnknownSeasonOutcomeError&&/guarded native season POST was not accepted/.test(error.cause?.message));
  assert.equal(prepared.state,'needs-reconciliation');
 }
 assert.equal(interceptedSeason,1);assert.equal(forwardedIncidental,0);
 assert.equal(blocked.length,1);assert.equal(blocked[0].method(),'POST');assert.equal(blocked[0].failure().errorText,'net::ERR_FAILED');
 assert.deepEqual(f.writes.map(write=>write.kind),['season']);assert.equal(f.state.seasons.length,1);assert.deepEqual(f.state.unexpected,[]);
});
