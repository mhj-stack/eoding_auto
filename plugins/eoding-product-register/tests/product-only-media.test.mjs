import test from 'node:test';
import assert from 'node:assert/strict';
import {createProductOnlyMediaAdapter} from '../src/product-only-media.mjs';
const make=()=>createProductOnlyMediaAdapter({assertIdentity:async()=>{},authorizeWrite:async()=>({durable:true}),record:async()=>{},loadImage:async()=>Buffer.from('x'),verifyUploadedImage:async()=>({})});
const plan=()=>({companyId:'7',source:{images:[{id:'image1',name:'a.png',mimeType:'image/png',sha256:'a'.repeat(64),alt:'상품 이미지'}]},display:{fields:{short_description:'소개'},imageQuery:'a',images:[{sourceImageId:'image1'}]},content:{detail:{include:[],exclude:[],information:[],mainPoints:[],shoppingCount:'0'},elements:[]}});
test('explicit reference-subset permits a smaller gallery without dropping reference sources',()=>{
 const p=plan();p.source.images.push({...p.source.images[0],id:'detail',name:'detail.png',sha256:'b'.repeat(64)});
 p.display.sourceMode='reference-subset';
 assert.equal(make().preflight(p).canExecute,true);
 delete p.display.sourceMode;assert.equal(make().preflight(p).canExecute,false);
});

test('subset media rejects empty duplicate unknown selections and unknown modes',()=>{
 for(const change of [p=>p.display.images=[],p=>p.display.images.push(p.display.images[0]),p=>p.display.images[0].sourceImageId='missing',p=>p.display.sourceMode='guess']){
  const p=plan();p.display.sourceMode='reference-subset';change(p);assert.equal(make().preflight(p).canExecute,false);
 }
});

test('media plan exposes missing image bytes evidence before the basic stage can save',()=>{const adapter=make(),valid=plan();assert.equal(adapter.preflight(valid).canExecute,true);delete valid.source.images[0].sha256;const result=adapter.preflight(valid);assert.equal(result.canExecute,false);assert.match(result.blockers.join(';'),/source image/);});
test('media plan rejects missing content, wrong tenant and missing image coverage',()=>{for(const mutate of [p=>delete p.content.detail,p=>p.companyId='7/other',p=>p.display.images=[],p=>p.display.fields.title='not allowed']){const p=plan();mutate(p);assert.equal(make().preflight(p).canExecute,false);}});
