import {isDeepStrictEqual as same} from 'node:util';
import {createProductLowLevelAdapters} from './product-execution.mjs';
import {createProductOnlyApprovalBinding} from './product-only-execution.mjs';
import {validateProductImport} from './product-import-scope.mjs';
import {ScheduleDayDraft} from './schedule-day.mjs';
import {readScheduleList} from './schedule-read.mjs';
import {readScheduleDetail,verifyPlainDayPersistence} from './schedule-detail-read.mjs';
import {digest} from './core.mjs';
const copy=x=>structuredClone(x);
const fail=m=>{throw Error(m)};
const id=x=>typeof x==='string'&&/^[1-9]\d{0,9}$/.test(x);
const draft=day=>{const {sourceRowId,...value}=day;return value;};
function preflight(plan){
 const blockers=[],checked=validateProductImport(plan);
 if(!checked.readyForReview)blockers.push('Normalized source product is incomplete');
 const ident=plan?.identity;
 if(!ident||Object.keys(ident).sort().join(',')!=='accountKey,accountName,sessionKey'||Object.values(ident).some(v=>typeof v!=='string'||!v.trim()))blockers.push('Exact approved identity is required');
 const options=plan?.basic?.options;
 if(!options||Object.keys(plan.basic).join(',')!=='options'||Object.keys(options).sort().join(',')!=='cityLabel,cutoffDays,managerLabel,priority'||!['priority','cutoffDays'].every(k=>Number.isInteger(options[k])&&options[k]>=1&&options[k]<=999)||!['cityLabel','managerLabel'].every(k=>typeof options[k]==='string'&&options[k].trim()===options[k]&&options[k]))blockers.push('Exact basic options are required');
 if(!plan?.shell||Object.keys(plan.shell).join(',')!=='title'||typeof plan.shell.title!=='string'||!plan.shell.title.trim()||plan.shell.title!==plan.shell.title.trim())blockers.push('Exact schedule title is required');
 if(!Array.isArray(plan?.itinerary)||!same(plan.itinerary.map(draft),plan.product?.itinerary)||plan.itinerary.some(d=>!ScheduleDayDraft.safeParse(draft(d)).success))blockers.push('Every source day must match the approved normalized itinerary');
 return {canExecute:!blockers.length,blockers};
}
/** Bridge existing low-level basic/shell/day implementations; no approval is created here. */
export function createProductOnlyStageAdapters({identity,authorizeWrite,record,beforeBasicPrepare,seedBasicReceipt}={}){
 if(![identity,authorizeWrite,record].every(fn=>typeof fn==='function'))fail('Identity, external authorization and durable record callbacks required');
 if(beforeBasicPrepare!==undefined&&typeof beforeBasicPrepare!=='function')fail('beforeBasicPrepare must be a function when supplied');
 const low=createProductLowLevelAdapters({identity}),states=new Map();let binding=null;
 // A continuation may prove an already-created basic product independently.  Seed
 // only its dependency state; the basic save path remains unavailable to it.
 if(seedBasicReceipt){
  if(!id(String(seedBasicReceipt.productId))||typeof seedBasicReceipt.masterCode!=='string'||!seedBasicReceipt.masterCode)fail('seedBasicReceipt requires a verified product ID and master code');
  const native={...copy(seedBasicReceipt),productId:String(seedBasicReceipt.productId)},receipt={...copy(seedBasicReceipt),productId:Number(seedBasicReceipt.productId)};
  states.set('basic',{verified:true,page:null,plan:null,context:null,native,receipt});
 }
 const check=(plan,context)=>{
  const original={...copy(plan),target:{mode:'NEW'}},expected=createProductOnlyApprovalBinding(original),claim=context?.approvalClaim;
  if(!same(expected,plan.approvalBinding)||!same(expected,context?.approvalBinding)||!same(plan.target,context?.targets)||claim?.planDigest!==expected.planDigest||claim?.scopeDigest!==expected.scopeDigest||!same(claim?.target,{mode:'NEW'}))fail('Stage approval binding changed');
  if(binding&&!same(binding,expected))fail('Stage binding belongs to another execution');binding=copy(expected);
 };
 const currentIdentity=async(page,plan)=>{const actual=await identity(page);if(!same(actual,plan.identity))fail('Approved account or session identity changed');return actual;};
 const dependency=(context,name)=>{
  const prior=context.verifiedPreviousPhases?.filter(x=>x.name===name),state=states.get(name);
  if(prior?.length!==1||!state?.verified||!same(prior[0].receipt,state.receipt))fail('Missing verified '+name+' dependency');return copy(state.native);
 };
 const stage=phase=>({preflight,
  async save(page,plan,context){
   const result=preflight(plan);if(!result.canExecute)fail(result.blockers.join('; '));check(plan,context);
   const key=phase==='day'?`day:${context.day?.day}`:phase;
   if(states.has(key))fail('Stage already attempted; reconcile without retry');
   const dependencies={};if(phase!=='basic'){dependencies.basic=dependency(context,'basic');if(Number(dependencies.basic.productId)!==context.targets.productId||dependencies.basic.masterCode!==context.targets.masterCode)fail('Derived basic target changed');}
   if(phase==='day'){dependencies.shell=dependency(context,'shell');if(Number(dependencies.shell.scheduleId)!==context.targets.scheduleId)fail('Derived shell target changed');if(!same(context.day,plan.itinerary[context.day?.day-1]))fail('Approved day changed');}
   const native=phase==='day'?low.days:low[phase],input=phase==='day'?{}:plan[phase];
   const ctx={identity:await currentIdentity(page,plan),dependencies,day:phase==='day'?draft(context.day):undefined,assertIdentity:()=>currentIdentity(page,plan)};
   const state={verified:false,page,plan:copy(plan),context:copy(context)};states.set(key,state);
   if(phase==='basic'&&beforeBasicPrepare)await beforeBasicPrepare(page,copy(plan),copy(context));
   if(phase==='shell'){
    const url=new URL(page.url());if(url.origin!=='https://basecamp.team'||url.pathname!==`/tour/master_product/${dependencies.basic.productId}/change/`||url.search||url.username||url.password)fail('Wrong shell transition target');
    const guard=r=>['GET','HEAD'].includes(r.request().method())?r.fallback():r.abort();await page.context().route('**/*',guard);
    try{const tab=page.locator('a[href="#schedule"]');if(await tab.count()!==1)fail('Missing exact schedule tab');await tab.click();await ctx.assertIdentity();}finally{await page.context().unroute('**/*',guard);}
   }
   const prepared=await native.prepare(page,plan.product,copy(input),ctx);
   const reread=await native.read(page,plan.product,copy(input),{...ctx,prepared:copy(prepared)});
   if(!same(prepared,reread))fail('Prepared native form changed');
   const permit=await authorizeWrite({phase:key,target:copy(context.targets),prepared:copy(prepared)},copy(context));
   if(permit?.durable!==true)fail('Durable external authorization refused');
   await record({phase:'attempt',stage:key,target:copy(context.targets),approvalBinding:copy(binding)});
   check(plan,context);await ctx.assertIdentity();
   if(!same(prepared,await native.read(page,plan.product,copy(input),{...ctx,prepared:copy(prepared)})))fail('Native form changed during authorization');
   const receipt=await native.save(page,prepared,copy(input),ctx);
   if(!id(receipt.productId)||(phase==='shell'&&!id(receipt.scheduleId)))fail('Invalid native receipt ID');
   state.prepared=copy(prepared);state.native=copy(receipt);
   state.receipt={...copy(receipt),productId:Number(receipt.productId),...(receipt.scheduleId?{scheduleId:Number(receipt.scheduleId)}:{})};
   return copy(state.receipt);
  },
  async verifyReceipt(page,receipt,context){
   const key=phase==='day'?`day:${context.day?.day}`:phase,state=states.get(key);
   if(!state||state.page!==page||!same(receipt,state.receipt)||!same(context,state.context))return false;
   check(state.plan,context);await currentIdentity(page,state.plan);
   if(phase==='basic'){
    await low.basic.reload(page);const persisted=await low.basic.read(page),{productId,...saved}=state.native;
    let found;try{found=/^\/master\/(\d+)\/?$/.exec(new URL(persisted.masterURL).pathname)?.[1];}catch{}
    if(found!==productId||!same(persisted,saved))fail('Basic independent reload differs from receipt');
   }else if(phase==='shell'){
    const read=await readScheduleList(page,{productId:state.native.productId});
    const before=state.prepared.before.schedules,after=read.schedules,own=after.filter(r=>r.scheduleId===state.native.scheduleId);
    if(after.length!==before.length+1||before.some(r=>!after.some(a=>same(a,r)))||own.length!==1||!same(own[0],{scheduleId:state.native.scheduleId,...state.native.fields}))fail('Shell independent membership changed');
   }else{
    const p=state.prepared.expected,after=await readScheduleDetail(page,{productId:p.target.productId,scheduleId:p.target.scheduleId});
    const proof=verifyPlainDayPersistence(state.prepared.before,after,{day:p.day,title:p.details[0].title,dayTitle:p.title??'',description:p.details[0].description,meals:Object.fromEntries(Object.entries(p.meals).map(([k,v])=>[k,{type:Number(v.type),text:v.text}]))});
    if(proof.detailId!==state.native.detailId)fail('Day independent receipt ID changed');
    state.after=copy(after);
   }
   await currentIdentity(page,state.plan);state.verified=true;return true;
  }
 });
  return {basic:stage('basic'),shell:stage('shell'),day:stage('day'),
   // Read-only recovery: durable receipts alone cannot mark a stage verified.
   // Reconcile every saved day against the approved product before seeding only
   // the dependency state used by final readback. No saved stage can run again.
   async reconcileSavedStages(page,plan,checkpoint){
    const checked=preflight(plan);if(!checked.canExecute)fail(checked.blockers.join('; '));
    if(!same(plan.target,{mode:'NEW'})||!same(createProductOnlyApprovalBinding(plan),plan.approvalBinding))fail('Recovery plan binding changed');
    if(binding||[...states.keys()].some(key=>key!=='basic'))fail('Saved stage reconciliation requires an unused adapter');
    const {basic,shell,days,dayPrepared,shellBefore}=copy(checkpoint??{});
    if(!basic||!same(states.get('basic')?.receipt,basic)||!shell||shell.status!=='schedule-saved'||shell.productId!==basic.productId||!id(String(shell.scheduleId))||!same(shell.fields,{title:plan.shell.title,nights:plan.product.nights,days:plan.product.days})||!Array.isArray(days)||days.length!==plan.itinerary.length||!shellBefore||String(shellBefore.productId)!==String(basic.productId)||!same(shellBefore.schedules,[]))fail('Saved checkpoint target or original empty schedule baseline changed');
    const nativeBasic={...basic,productId:String(basic.productId)},nativeShell={...shell,productId:String(shell.productId),scheduleId:String(shell.scheduleId)};
    const nativeDays=days.map((day,index)=>{
     if(day?.day!==index+1||day.productId!==basic.productId||day.scheduleId!==shell.scheduleId||day.status!=='plain-day-persisted'||day.guardedPosts!==1||!id(day.detailId))fail('Saved day receipt changed');
     return {...day,productId:String(day.productId),scheduleId:String(day.scheduleId)};
    });
    if(!Array.isArray(dayPrepared)||dayPrepared.length!==days.length)fail('Saved day preparation coverage changed');
    const {productId:ignoredProductId,...expectedBasic}=nativeBasic,mealTypes=new Map([['불포함','16'],['호텔식','2'],['한식','5'],['현지식','3']]);
    for(const [index,prepared]of dayPrepared.entries()){
     const approved=plan.itinerary[index],expected=prepared?.expected,before=prepared?.before;
     if(!expected||!before||expected.day!==approved.day)fail('Saved day preparation coverage differs from approval');
     if(![expectedBasic.url,expectedBasic.url+'#schedule'].includes(expected.basic?.url)||!same({...expected.basic,url:expectedBasic.url},expectedBasic)||!same(expected.hotelIds,[]))fail('Saved day private basic or hotel preparation differs from approval');
     if(!same(expected.target,{productId:nativeBasic.productId,masterCode:basic.masterCode,title:plan.product.title,account:plan.identity.accountName,scheduleId:nativeShell.scheduleId,scheduleCode:before.schedule?.code,scheduleTitle:shell.fields.title}))fail('Saved day prepared target differs from approval');
     if(before.productId!==nativeBasic.productId||before.scheduleId!==nativeShell.scheduleId||before.schedule?.title!==shell.fields.title||before.schedule?.days!==plan.product.days||before.schedule?.nights!==plan.product.nights)fail('Saved day prepared schedule differs from approval');
     if(!same(expected.details,[{type:'7',newStep:true,title:approved.title,short:'',description:approved.description}])||expected.title!==null&&expected.title!==approved.title)fail('Saved day prepared content differs from approval');
     if(!same(Object.keys(expected.meals??{}).sort(),['breakfast','dinner','lunch']))fail('Saved native meal preparation changed');
     for(const kind of ['breakfast','lunch','dinner']){
      const meal=expected.meals[kind],source=approved.meals[kind];
      if(!same(Object.keys(meal??{}).sort(),['text','type'])||!id(meal.type)||(meal.type==='17'?meal.text!==source:meal.text!==''||mealTypes.get(source)!==meal.type))fail('Saved native meal differs from approval');
     }
    }
    if(dayPrepared[0].before.tree?.length!==days.length||dayPrepared[0].before.contentsFingerprint!==digest([])||dayPrepared[0].before.imagesFingerprint!==digest([]))fail('Saved initial itinerary baseline is not empty');
    const target={productId:nativeBasic.productId,masterCode:basic.masterCode,scheduleId:nativeShell.scheduleId},owner=page.context();
    const guard=r=>['GET','HEAD'].includes(r.request().method())?r.fallback():r.abort();await owner.route('**/*',guard);
    let cdp;
    try{
     await currentIdentity(page,plan);cdp=await owner.newCDPSession(page);await cdp.send('Network.enable');await cdp.send('Network.setCacheDisabled',{cacheDisabled:true});await cdp.send('Network.setBypassServiceWorker',{bypass:true});
     const url=`https://basecamp.team/tour/master_product/${target.productId}/change/`,response=await page.goto(url,{waitUntil:'domcontentloaded'});
     if(response?.status()!==200||response.url()!==url||response.fromServiceWorker())fail('Saved basic independent GET failed');
     const persisted=await low.basic.read(page),{productId,...expected}=nativeBasic;
     if(!same(persisted,expected))fail('Saved basic differs from approved receipt');
     const list=await readScheduleList(page,{productId:target.productId});
     if(!same(list.schedules,[{scheduleId:target.scheduleId,...shell.fields}]))fail('Saved schedule membership changed');
     const detailBefore=await readScheduleDetail(page,{productId:target.productId,scheduleId:target.scheduleId});
     // Reuse the exact persisted native contract from each historical save.
     // Some ERP layouts have no day-title input: their reviewed title is null,
     // while the custom detail title still contains the approved source title.
     for(const [index,prepared]of dayPrepared.entries()){
      const p=prepared.expected,after=dayPrepared[index+1]?.before??detailBefore;
      const proof=verifyPlainDayPersistence(prepared.before,after,{day:p.day,title:p.details[0].title,dayTitle:p.title??'',description:p.details[0].description,meals:Object.fromEntries(Object.entries(p.meals).map(([kind,meal])=>[kind,{type:Number(meal.type),text:meal.text}]))});
      if(proof.detailId!==nativeDays[index].detailId)fail('Saved day independent receipt ID changed');
     }
     const detail=await readScheduleDetail(page,{productId:target.productId,scheduleId:target.scheduleId});
     if(!same(detail,detailBefore))fail('Saved itinerary changed during reconciliation');
     await currentIdentity(page,plan);
     states.set('shell',{verified:true,native:nativeShell,receipt:shell,prepared:{before:copy(shellBefore)}});
     for(const [index,receipt]of days.entries())states.set(`day:${receipt.day}`,{verified:true,native:nativeDays[index],receipt,after:copy(detail)});
     return {status:'saved-basic-schedule-reconciled',basic:persisted,list,detail};
    }finally{await owner.unroute('**/*',guard);await cdp?.detach().catch(()=>{});}
   },
  async readFinal(page,plan,context){
   check(plan,context);await currentIdentity(page,plan);
   const basic=dependency(context,'basic'),shell=dependency(context,'shell');
   for(const day of plan.itinerary)dependency(context,`day:${day.day}`);
   if(Number(basic.productId)!==context.targets.productId||basic.masterCode!==context.targets.masterCode||Number(shell.scheduleId)!==context.targets.scheduleId)fail('Final derived target changed');
   const owner=page.context(),guard=r=>['GET','HEAD'].includes(r.request().method())?r.fallback():r.abort();await owner.route('**/*',guard);let cdp;
   try{
    cdp=await owner.newCDPSession(page);await cdp.send('Network.enable');await cdp.send('Network.setCacheDisabled',{cacheDisabled:true});await cdp.send('Network.setBypassServiceWorker',{bypass:true});
    const response=await page.goto(`https://basecamp.team/tour/master_product/${basic.productId}/change/`,{waitUntil:'domcontentloaded'});
    if(response?.status()!==200||response.fromServiceWorker()||response.url()!==`https://basecamp.team/tour/master_product/${basic.productId}/change/`)fail('Final basic GET changed');
    const persisted=await low.basic.read(page),{productId,...expected}=basic;
    if(!same(persisted,expected))fail('Final basic values changed');
    const list=await readScheduleList(page,{productId:basic.productId});
    const before=states.get('shell').prepared.before.schedules,expectedList=[...before,{scheduleId:shell.scheduleId,...shell.fields}];
    if(list.schedules.length!==expectedList.length||expectedList.some(r=>!list.schedules.some(v=>same(r,v))))fail('Final schedule membership changed');
    const detail=await readScheduleDetail(page,{productId:basic.productId,scheduleId:shell.scheduleId});
    if(!same(detail,states.get(`day:${plan.itinerary.length}`).after))fail('Final schedule content changed');
    await currentIdentity(page,plan);return {status:'basic-schedule-reverified',basic:persisted,list,detail};
   }finally{await owner.unroute('**/*',guard);await cdp?.detach().catch(()=>{});}
  }
 };
}
