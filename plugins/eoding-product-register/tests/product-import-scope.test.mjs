import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {validateProduct} from '../src/core.mjs';
import {validateProductImport} from '../src/product-import-scope.mjs';
import {createProductOnlyStageAdapters} from '../src/product-only-stages.mjs';

const example=JSON.parse(await readFile(new URL('../examples/product.json',import.meta.url),'utf8'));
function draft(){
 const product=structuredClone(example);
 product.nights=0;product.days=1;product.itinerary=product.itinerary.slice(0,1);
 product.departures=[];product.cancellation=null;
 product.evidence=product.evidence.filter(e=>!['departures','cancellation'].some(key=>e.field===key||e.field.startsWith(key+'.')));
 return {target:{mode:'NEW'},seasonMode:'excluded',product,
  identity:{accountName:'Fixture',accountKey:'fixture-account',sessionKey:'fixture-session'},
  basic:{options:{cityLabel:'제주(CJU)',managerLabel:'가상담당자 (테스트팀)',priority:7,cutoffDays:3}},
  shell:{title:'당일 일정'},itinerary:product.itinerary.map(d=>({...d,sourceRowId:'row-1'}))};
}
const adapters=createProductOnlyStageAdapters({identity:async()=>{},authorizeWrite:async()=>{},record:async()=>{}});

test('explicit no-season master accepts a one-day source without invented departures prices or cancellation',()=>{
 const plan=draft(),before=structuredClone(plan);
 for(const stage of ['basic','shell','day'])assert.equal(adapters[stage].preflight(plan).canExecute,true,stage);
 assert.deepEqual(plan,before);
 assert.equal(validateProduct(plan.product).readyForReview,false,'legacy full product remains strict');
});

test('omitting season mode does not silently relax source requirements',()=>{
 const plan=draft();delete plan.seasonMode;
 assert.equal(adapters.basic.preflight(plan).canExecute,false);
});

test('included and unknown scopes never acquire excluded-source exemptions',()=>{
 for(const mode of ['included','EXCLUDED',null,false,'']){
  const plan=draft();plan.seasonMode=mode;
  assert.equal(validateProductImport(plan).readyForReview,false,String(mode));
 }
 assert.deepEqual(validateProductImport({product:example}),validateProduct(example));
 assert.deepEqual(validateProductImport({product:example,seasonMode:'included'}),validateProduct(example));
});

test('no-season rejects nested write instructions even when empty or false',()=>{
 for(const field of ['season','event','events','eventCreation','hotel','hotels','hotelAssignments']){
  const plan=draft();plan[field]=false;
  const result=validateProductImport(plan);
  assert.equal(result.readyForReview,false,field);
  assert.ok(result.errors.some(e=>e.field===field),field);
 }
});

test('excluded scope preserves required operational values source provenance and unresolved questions',()=>{
 const changes=[p=>p.product.company.manager=null,p=>p.product.company.vat='unknown',
  p=>p.product.unresolved.push('사용자 확인 필요'),p=>p.product.itinerary=[],
  p=>p.product.evidence=p.product.evidence.filter(e=>e.field!=='title'),
  p=>p.product.evidence[0].sourceId='missing-source',p=>p.product.includesFlight=null];
 for(const change of changes){const plan=draft();change(plan);assert.equal(validateProductImport(plan).readyForReview,false);}
});

test('schema failures stay failures rather than getting filtered as optional facts',()=>{
 for(const change of [p=>delete p.product.departures,p=>p.product.departures=null,
  p=>p.product.cancellation=42,p=>p.product.departures=[{startDate:'invented'}]]){
  const plan=draft();change(plan);
  assert.equal(validateProductImport(plan).valid,false);
  assert.equal(adapters.basic.preflight(plan).canExecute,false);
 }
});

test('present commercial facts still require evidence and valid prices',()=>{
 const plan=draft();plan.product.departures=structuredClone(example.departures);
 assert.equal(validateProductImport(plan).readyForReview,false,'present departures require evidence');
 plan.product.evidence.push(...example.evidence.filter(e=>e.field==='departures'||e.field.startsWith('departures.')));
 plan.product.departures[0].selectedPrice=null;
 assert.equal(validateProductImport(plan).readyForReview,false,'missing price selection remains blocked');
 plan.product.departures[0].selectedPrice=0;plan.product.departures[0].prices[0].adult.amount=-1;
 assert.equal(validateProductImport(plan).valid,false,'negative prices remain schema failures');
 const policy=draft();policy.product.cancellation='출처를 확인하지 않은 문구';
 assert.equal(validateProductImport(policy).readyForReview,false,'present policy requires evidence');
});

test('omitted source requirements are explicit and validation is not write authorization',()=>{
 const result=validateProductImport(draft());
 assert.deepEqual(result.omittedSourceRequirements,['departures','cancellation']);
 assert.deepEqual(result.importScope,{season:'excluded',events:'prohibited',policySettings:'preserved'});
 assert.equal(Object.hasOwn(result,'approvalClaim'),false);
 assert.equal(Object.hasOwn(result,'canCommit'),false);
});
