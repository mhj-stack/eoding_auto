import assert from 'node:assert/strict';
import test from 'node:test';
import {chromium} from 'playwright';
import {createProductOnlySeasonAdapter} from '../src/product-only-season.mjs';
import {installProductOnlyFixture,origin,pageUrl,productId,scheduleId} from './fixtures/product-only-page.mjs';

async function fixture(t,{identityChanges=false}={}){
 const browser=await chromium.launch({headless:true,args:['--host-resolver-rules=MAP * ~NOTFOUND']});t.after(()=>browser.close());
 const owner=await browser.newContext({serviceWorkers:'block'}),f=await installProductOnlyFixture(owner),page=await owner.newPage();
 await page.goto(pageUrl+'#schedule');
 // Model the post-day-save UI: the product URL is unchanged, but the season
 // entry point is absent until a fresh product GET rebuilds the page.
 await page.locator('a[href="#season"]').evaluate(node=>node.remove());
 const binding={planDigest:'a'.repeat(64),scopeDigest:'b'.repeat(64)},target={mode:'NEW',productId:Number(productId),masterCode:'FIXTURE',scheduleId:Number(scheduleId)};
 const context={approvalBinding:binding,approvalClaim:{...binding,target:{mode:'NEW'}},targets:target,verifiedPreviousPhases:[
  {name:'basic',verification:true,receipt:{productId:Number(productId),masterCode:'FIXTURE'}},
  {name:'shell',verification:true,receipt:{scheduleId:Number(scheduleId)}}]};
 const plan={approvalBinding:binding,target,season:{fields:{title:'Fixture season'},selects:{},selectedDates:['2027-01-10']}};
 let identities=0,authorizations=0;const navigations=[];
 page.on('request',request=>{if(request.isNavigationRequest()&&request.frame()===page.mainFrame())navigations.push({method:request.method(),url:request.url()});});
 const adapter=createProductOnlySeasonAdapter({timeoutMs:2500,assertIdentity:async()=>{identities++;return identityChanges&&identities>1?'changed-fixture-account':'fixture-account';},
  authorizeWrite:async event=>{authorizations++;return {durable:true,status:'approved',bindingDigest:event.bindingDigest,approvalId:'fixture-approval'};},
  record:async event=>({durable:true,bindingDigest:event.bindingDigest,evidenceId:'fixture-evidence'})});
 return {...f,page,owner,adapter,plan,context,navigations,authorizations:()=>authorizations};
}

test('season stage reopens the exact product after a day save before preparing or writing',async t=>{
 const f=await fixture(t);assert.equal(await f.page.locator('a[href="#season"]').count(),0);
 const receipt=await f.adapter.save(f.page,f.plan,f.context);
 assert.equal(receipt.kind,'season-save-receipt-v1');assert.equal(receipt.target.productId,productId);
 assert.deepEqual(f.navigations,[{method:'GET',url:pageUrl}]);assert.equal(f.authorizations(),1);assert.deepEqual(f.writes.map(write=>write.kind),['season']);
 assert.equal((await f.adapter.verifyReceipt(f.page,receipt,f.context)).kind,'season-receipt-verification-v1');
});

for(const suffix of ['?wrong=1','../999/change/'])test(`season transition rejects an unexpected starting product URL ${suffix}`,async t=>{
 const f=await fixture(t);await f.page.evaluate(url=>history.replaceState(null,'',url),suffix.startsWith('?')?pageUrl+suffix:origin+'/tour/master_product/999/change/');
 await assert.rejects(f.adapter.save(f.page,f.plan,f.context),/Wrong season transition target/);
 assert.deepEqual(f.navigations,[]);assert.deepEqual(f.writes,[]);assert.equal(f.authorizations(),0);
});

test('season transition rejects a non-200 product response before authorization',async t=>{
 const f=await fixture(t);await f.owner.route(pageUrl,route=>route.fulfill({status:403,contentType:'text/html',body:'Forbidden fixture'}));
 await assert.rejects(f.adapter.save(f.page,f.plan,f.context),/Season product GET did not return the exact target/);
 assert.deepEqual(f.writes,[]);assert.equal(f.authorizations(),0);
});

test('season transition rejects redirect-chain metadata even at the exact product URL',async t=>{
 const f=await fixture(t),goto=f.page.goto.bind(f.page);
 // Keep the isolated real product GET, and model a prior redirect on its
 // response. No redirect may escape the fixture into a network request.
 f.page.goto=async(...args)=>{
  const response=await goto(...args),request=response.request();
  return {status:()=>response.status(),url:()=>response.url(),fromServiceWorker:()=>response.fromServiceWorker(),request:()=>({method:()=>request.method(),redirectedFrom:()=>({url:()=>origin+'/fixture-redirect'})})};
 };
 await assert.rejects(f.adapter.save(f.page,f.plan,f.context),/Season product GET did not return the exact target/);
 assert.equal(f.page.url(),pageUrl);assert.deepEqual(f.writes,[]);assert.equal(f.authorizations(),0);
});

test('season transition rejects an identity change after the exact product GET',async t=>{
 const f=await fixture(t,{identityChanges:true});
 await assert.rejects(f.adapter.save(f.page,f.plan,f.context),/identity changed during product transition/);
 assert.deepEqual(f.navigations,[{method:'GET',url:pageUrl}]);assert.deepEqual(f.writes,[]);assert.equal(f.authorizations(),0);
});

test('season transition aborts foreign page-load telemetry without preventing the approved season save',async t=>{
 const f=await fixture(t),telemetryUrls=['https://telemetry.fixture.test/events','https://statistics.fixture.test/collect'];
 let forwardedTelemetry=0;
 for(const url of telemetryUrls)await f.owner.route(url,route=>{forwardedTelemetry++;return route.fulfill({status:204});});
 const blocked=telemetryUrls.map(url=>f.page.waitForEvent('requestfailed',{predicate:request=>request.url()===url,timeout:5000}));
 await f.owner.addInitScript(urls=>{for(const url of urls)fetch(url,{method:'POST',mode:'no-cors',body:'fixture telemetry'}).catch(()=>{});},telemetryUrls);
 const receipt=await f.adapter.save(f.page,f.plan,f.context);
 const requests=await Promise.all(blocked);
 assert.deepEqual(requests.map(request=>request.method()),['POST','POST']);
 for(const request of requests)assert.equal(request.failure().errorText,'net::ERR_FAILED');
 assert.equal(forwardedTelemetry,0);assert.deepEqual(f.state.unexpected,[]);
 assert.equal(receipt.kind,'season-save-receipt-v1');assert.equal(f.authorizations(),1);assert.deepEqual(f.writes.map(write=>write.kind),['season']);
 assert.equal((await f.adapter.verifyReceipt(f.page,receipt,f.context)).kind,'season-receipt-verification-v1');
});

test('season transition blocks same-origin page-load writes and stops before season authorization',async t=>{
 const f=await fixture(t);await f.owner.addInitScript(()=>{fetch('/unexpected-transition-write',{method:'POST',body:'fixture'}).catch(()=>{});});
 await assert.rejects(f.adapter.save(f.page,f.plan,f.context),/Unexpected write blocked during season product transition/);
 assert.deepEqual(f.writes,[]);assert.deepEqual(f.state.unexpected,[]);assert.equal(f.authorizations(),0);
});
