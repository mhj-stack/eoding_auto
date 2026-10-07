import { z } from 'zod';
import { assertScheduleSaveContract, prepareNewSchedule, readScheduleShell, clickSaveScheduleAndVerify } from './schedule-form.mjs';
import { assertScheduleCandidateContract, prepareScheduleCandidate, readScheduleCandidate, clickSaveScheduleCandidateAndVerify } from './schedule-candidate.mjs';
import { mkdir, readFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { buildPlan, digest } from './core.mjs';
import { ReviewStore } from './review-store.mjs';
import { readBasicForm, fillNewBasic, clickSaveAndVerify } from './basic-form.mjs';
import { ALLOWED_ORIGIN } from './browser.mjs';
import { ScheduleDayTarget, ScheduleDayDraft, readScheduleDay, fillBlankScheduleDay, clickSaveScheduleDayAndVerify } from './schedule-day.mjs';

export const ImportOptions = z.object({
  expectedAccountName:z.string().trim().min(1).max(200),
  cityLabel:z.string().trim().min(1).max(200),
  managerLabel:z.string().trim().min(1).max(200),
  priority:z.number().int().min(1).max(999),
  cutoffDays:z.number().int().min(1).max(999)
}).strict();
const hashBytes=bytes=>createHash('sha256').update(bytes).digest('hex');

/** Approval is provided by interactive CLI, never an MCP tool parameter.
 * The store is a workflow guard, not protection from a same-OS adversary.
 */
export class EodingWorkflow {
  constructor(browser,{store,forms={prepareNewSchedule,readScheduleShell,clickSaveScheduleAndVerify,prepareScheduleCandidate,readScheduleCandidate,clickSaveScheduleCandidateAndVerify,readBasicForm,fillNewBasic,clickSaveAndVerify,readScheduleDay,fillBlankScheduleDay,clickSaveScheduleDayAndVerify}}={}) {this.browser=browser;this.store=store||new ReviewStore(browser.dataDir);this.forms=forms;}
  validate(product,options) {
    const plan=buildPlan(product); const mapped=ImportOptions.parse(options);
    if(!plan.readyForReview) throw new Error('상품 검증이 필요합니다: '+JSON.stringify(plan.errors));
    if(product.currency!=='KRW') throw new Error('현재 신규 생성은 KRW만 지원합니다');
    return {plan,options:mapped};
  }
  async identity(page,options,declaredTenant) {
    await this.browser.assertERP(page);
    const label=(await page.locator('#eoding-name').innerText()).trim();
    if(label!==options.expectedAccountName) throw new Error('로그인 표시 이름이 승인 대상과 다릅니다');
    const cookies=(await page.context().cookies(ALLOWED_ORIGIN)).filter(c=>c.httpOnly).map(c=>({name:c.name,value:c.value,domain:c.domain,path:c.path})).sort((a,b)=>(a.name+a.domain+a.path).localeCompare(b.name+b.domain+b.path));
    if(!cookies.length) throw new Error('로그인 세션을 묶을 HttpOnly 쿠키가 없습니다. 자동 저장 차단');
    // No cookie values are returned or written to disk. Rotation invalidates approval.
    return {accountName:label,accountKey:digest({origin:ALLOWED_ORIGIN,label,declaredTenant}),sessionKey:digest(cookies)};
  }
  async screenshot(page,seed) {
    const dir=path.join(this.browser.dataDir,'review-images');await mkdir(dir,{recursive:true,mode:0o700});await chmod(dir,0o700);
    const target=path.join(dir,digest(seed)+'-'+randomUUID()+'.png');
    const region=(seed.action==='save-schedule'||seed.action==='save-schedule-candidate')?page.locator('#add_schedule_modal'):(seed.result?.status==='schedule-saved'||seed.result?.status==='schedule-persistence-verified')?page.locator('#schedule_list_table'):seed.action==='open-new-form'?page.locator('#modal'):(seed.action==='save-schedule-day'||seed.result?.status==='schedule-day-saved')?page.locator('#schedule'):page.locator('form').filter({has:page.locator('#id_2-title')});
    if(await region.count()!==1)throw new Error('검토할 폼 영역이 모호합니다. 전체 화면을 캡처하지 않습니다');
    await region.screenshot({path:target});await chmod(target,0o600);
    return {path:target,sha256:hashBytes(await readFile(target))};
  }
  async creationState(page) {
    await this.browser.assertERP(page);
    if(new URL(page.url()).pathname!=='/tour/master_product/') throw new Error('상품관리 목록 화면이 아닙니다');
    const modal=page.locator('#modal');await modal.waitFor({state:'visible'});
    const selected={};
    for(const [key,labels] of Object.entries({trip:['국내상품','해외상품'],flight:['항공포함','항공미포함'],vat:['부가세 포함','부가세 미포함']})) {
      const checked=[];
      for(const label of labels) if(await modal.getByRole('radio',{name:label,exact:true,includeHidden:true}).isChecked())checked.push(label);
      if(checked.length!==1) throw new Error('생성 설정이 모호합니다: '+key);
      selected[key]=checked[0];
    }
    selected.currency=await modal.locator('input.select-dropdown.dropdown-trigger').inputValue();
    const link=modal.getByRole('link',{name:'상품생성',exact:true});
    const href=await link.getAttribute('href');const target=new URL(href,page.url());
    if(target.origin!==ALLOWED_ORIGIN || target.pathname!=='/tour/master_product/add/') throw new Error('예상하지 못한 상품생성 연결 대상');
    return {url:page.url(),selected,href:target.href};
  }
  async requestStart(product,options) {
    const valid=this.validate(product,options);options=valid.options;
    return this.browser.exclusive(async()=>{
      const page=await this.browser.ensurePage();const identity=await this.identity(page,options,product.company.tenant);
      if(new URL(page.url()).pathname!=='/tour/master_product/') throw new Error('먼저 상품관리 목록을 여세요. 기존 입력을 덮어쓰지 않습니다');
      const fingerprint='open-new-form:'+valid.plan.fingerprint;
      if((await this.store.findByFingerprint(fingerprint,identity.accountKey)).some(r=>r.status!=='aborted'))throw new Error('동일 신규 화면 작업 기록이 있습니다. 자동 재생성하지 않습니다. 기존 작업을 검토하세요');
      if(await page.locator('#modal').isVisible())throw new Error('이미 열린 생성 창이 있습니다. 내용을 검토한 뒤 직접 닫으세요');
      await page.getByRole('button',{name:'상품 생성',exact:true}).click();
      const modal=page.locator('#modal');await modal.waitFor({state:'visible'});
      const labels=[product.tripType==='domestic'?'국내상품':'해외상품',product.includesFlight?'항공포함':'항공미포함',product.company.vat==='included'?'부가세 포함':'부가세 미포함'];
      for(const label of labels){await modal.getByText(label,{exact:true}).click();if(!await modal.getByRole('radio',{name:label,exact:true,includeHidden:true}).isChecked())throw new Error('설정 선택 실패: '+label);}
      const state=await this.creationState(page);
      if(state.selected.currency!=='KRW')throw new Error('통화 설정 불일치');
      const screenshot=await this.screenshot(page,{action:'open-new-form',state,identity});
      return this.presentReview(await this.store.create({action:'open-new-form',fingerprint,accountKey:identity.accountKey,sessionKey:identity.sessionKey,formHash:digest(state),summary:{action:'신규 입력화면 열기',account:identity.accountName,tenantDeclaredByUser:product.company.tenant,title:product.title,settings:state.selected,warning:'최종 상품생성 클릭은 빈 레코드를 생성할 수 있습니다. 아직 저장하지 않았습니다. 테넌트는 운영자가 직접 확인해야 합니다.'},screenshot,product,options,state}));
    });
  }
  async prepareBasic(product,options) {
    const valid=this.validate(product,options);options=valid.options;
    return this.browser.exclusive(async()=>{
      const page=await this.browser.ensurePage();const identity=await this.identity(page,options,product.company.tenant);
      const fingerprint='save-basic:'+valid.plan.fingerprint;
      if((await this.store.findByFingerprint(fingerprint,identity.accountKey)).some(r=>r.status!=='aborted'))throw new Error('동일 기본정보 등록 기록이 있습니다. 자동 재등록하지 않습니다. 작업 상태를 먼저 확인하세요');
      const state=await this.forms.fillNewBasic(page,product,options);
      // A source or new session must never silently replace the approved identity.
      const after=await this.identity(page,options,product.company.tenant);if(after.accountKey!==identity.accountKey || after.sessionKey!==identity.sessionKey)throw new Error('입력 중 로그인 세션이 바뀌었습니다');
      const screenshot=await this.screenshot(page,{action:'save-basic',state,identity});
      return this.presentReview(await this.store.create({action:'save-basic',fingerprint,accountKey:identity.accountKey,sessionKey:identity.sessionKey,formHash:digest(state),summary:{action:'비공개 상품 기본정보 1회 저장',account:identity.accountName,tenantDeclaredByUser:product.company.tenant,title:product.title,city:options.cityLabel,manager:options.managerLabel,priority:options.priority,cutoffDays:options.cutoffDays,visibility:'비공개',scope:'기본정보만. 일정표/행사/항공편/호텔/가격/판매채널 등록은 포함하지 않음',duplicateCheck:'로컬 작업 중복만 검사. 기존 ERP 전체 중복은 운영자가 확인해야 함'},screenshot,product,options,state}));
    });
  }
  async prepareSchedule(product,target,schedule) {
    const plan=buildPlan(product);if(!plan.readyForReview)throw Error('상품 검증 필요: '+JSON.stringify(plan.errors));
    if(target.title!==product.title||schedule.nights!==product.nights||schedule.days!==product.days)throw Error('원본과 일정표 대상/박/일 수 불일치');
    const options={expectedAccountName:target.account};
    return this.browser.exclusive(async()=>{
      const page=await this.browser.ensurePage();const identity=await this.identity(page,options,product.company.tenant);
      assertScheduleSaveContract(page);
      const fingerprint='save-schedule:'+digest({accountKey:identity.accountKey,productId:target.productId,title:schedule.title});
      if((await this.store.findByFingerprint(fingerprint,identity.accountKey)).some(r=>r.status!=='aborted'))throw Error('같은 일정표 작업 기록이 있습니다. 결과부터 대사하세요');
      await this.forms.prepareNewSchedule(page,target,schedule);
      const state=await this.forms.readScheduleShell(page,target);
      const after=await this.identity(page,options,product.company.tenant);if(after.accountKey!==identity.accountKey||after.sessionKey!==identity.sessionKey)throw Error('입력 중 계정/세션 변경');
      const screenshot=await this.screenshot(page,{action:'save-schedule',state,identity});
      return this.presentReview(await this.store.create({action:'save-schedule',fingerprint,accountKey:identity.accountKey,sessionKey:identity.sessionKey,formHash:digest(state),screenshot,product,options,target,schedule,state,summary:{action:'일정표 셸 1회 저장',account:target.account,tenantDeclaredByUser:product.company.tenant,product:target.title,schedule,contract:'synthetic fixture only; live save blocked',scope:'shell only; no days, meals, hotels, departures, prices or publishing'}}));
    });
  }
  async prepareScheduleCandidate(product,target,schedule) {
    ({product,target,schedule}=structuredClone({product,target,schedule}));
    const plan=buildPlan(product);if(!plan.readyForReview)throw Error('상품 검증 필요: '+JSON.stringify(plan.errors));
    if(target.title!==product.title||schedule.nights!==product.nights||schedule.days!==product.days)throw Error('원본과 일정표 대상/박/일 수 불일치');
    const options={expectedAccountName:target.account};
    return this.browser.exclusive(async()=>{
      const page=await this.browser.ensurePage();const identity=await this.identity(page,options,product.company.tenant);
      assertScheduleCandidateContract(page);
      const fingerprint='save-schedule:'+digest({accountKey:identity.accountKey,productId:target.productId,title:schedule.title});
      if((await this.store.findByFingerprint(fingerprint,identity.accountKey)).some(r=>r.status!=='aborted'))throw Error('같은 일정표 작업 기록이 있습니다. 결과부터 대사하세요');
      const state=await this.forms.prepareScheduleCandidate(page,product,target,schedule);
      const after=await this.identity(page,options,product.company.tenant);if(after.accountKey!==identity.accountKey||after.sessionKey!==identity.sessionKey)throw Error('입력 중 계정/세션 변경');
      assertScheduleCandidateContract(page);
      const screenshot=await this.screenshot(page,{action:'save-schedule-candidate',state,identity});
      return this.presentReview(await this.store.create({action:'save-schedule-candidate',fingerprint,accountKey:identity.accountKey,sessionKey:identity.sessionKey,formHash:digest(state),screenshot,product,options,target,schedule,state,summary:{action:'일정표 셸 후보 1회 저장',account:target.account,tenantDeclaredByUser:product.company.tenant,product:target.title,schedule,contract:'reserved synthetic fixture only; live save blocked',scope:'shell only; no days, meals, hotels, departures, prices or publishing'}}));
    });
  }
  async prepareScheduleDay(product,inputTarget,day) {
    const plan=buildPlan(product);if(!plan.readyForReview)throw Error('상품 검증 필요: '+JSON.stringify(plan.errors));
    const target=ScheduleDayTarget.parse(inputTarget);if(target.title!==product.title)throw Error('원본 상품과 대상 상품명이 다릅니다');
    const source=product.itinerary.find(d=>d.day===day);if(!source)throw Error('원본 일차가 없습니다');
    const draft=ScheduleDayDraft.parse({day,title:source.title,description:source.description,meals:source.meals});
    const options={expectedAccountName:target.account};
    return this.browser.exclusive(async()=>{
      const page=await this.browser.ensurePage();const identity=await this.identity(page,options,product.company.tenant);
      const fingerprint='schedule-day:'+digest({accountKey:identity.accountKey,productId:target.productId,scheduleId:target.scheduleId,day});
      if((await this.store.findByFingerprint(fingerprint,identity.accountKey)).some(r=>r.status!=='aborted'))throw Error('같은 일정표 일차의 작업 기록이 있습니다. 결과부터 대사하세요');
      const baseline=await this.forms.readScheduleDay(page,target,day);
      if(Number(baseline.schedule.days)!==product.days||Number(baseline.schedule.nights)!==product.nights)throw Error('원본과 일정표 박/일 수 불일치');
      const expectedSettings={currency:product.currency,includesFlight:product.includesFlight?'항공포함':'항공미포함',tripType:product.tripType==='domestic'?'국내':'해외',vat:product.company.vat==='included'?'부가세 포함':'부가세 미포함'};
      if(digest(baseline.basic.settings)!==digest(expectedSettings))throw Error('원본과 상품 기본 설정 불일치');
      const state=await this.forms.fillBlankScheduleDay(page,target,draft);
      const after=await this.identity(page,options,product.company.tenant);if(after.accountKey!==identity.accountKey||after.sessionKey!==identity.sessionKey)throw Error('입력 중 계정/세션 변경');
      const screenshot=await this.screenshot(page,{action:'save-schedule-day',state,identity});
      return this.presentReview(await this.store.create({action:'save-schedule-day',fingerprint,accountKey:identity.accountKey,sessionKey:identity.sessionKey,formHash:digest(state),screenshot,product,options,target,draft,state,summary:{action:'빈 일차의 텍스트·식사 1회 저장',account:target.account,tenantDeclaredByUser:product.company.tenant,product:target.title,schedule:target.scheduleTitle,day,title:draft.title,description:draft.description,meals:draft.meals,scope:'선택한 빈 일차만. 호텔·이미지·교통·행사·가격·공개는 변경하지 않음'}}));
    });
  }
  presentReview(r) {return {id:r.id,hash:r.hash,status:r.status,createdAt:r.createdAt,expiresAt:r.expiresAt,summary:r.payload.summary,screenshot:r.payload.screenshot,partialResult:r.partialResult?{productId:r.partialResult.productId,scheduleId:r.partialResult.scheduleId,day:r.partialResult.day,masterCode:r.partialResult.masterCode,status:r.partialResult.status,notice:'대사 전까지 성공 확정으로 취급하지 마세요'}:undefined,result:r.result?{productId:r.result.productId,scheduleId:r.result.scheduleId,fields:r.result.fields,day:r.result.day,masterCode:r.result.masterCode,status:r.result.status,proof:r.result.proof,warnings:r.result.warnings}:undefined};}
  async getReview(id) {return this.presentReview(await this.store.get(id));}
  async execute(id) {
    return this.browser.exclusive(async()=>{
      const review=await this.store.get(id);
      if(review.status!=='approved')throw new Error('사용자가 로컬 터미널에서 먼저 검토·승인해야 합니다. AI는 승인할 수 없습니다');
      if(review.operatorAttestation?.method!=='interactive-cli-tenant-readback' || review.operatorAttestation?.tenantObserved!==review.payload.product.company.tenant)throw new Error('운영자의 실제 ERP 회사 확인이 필요합니다');
      if(!['open-new-form','save-basic','save-schedule-day','save-schedule','save-schedule-candidate'].includes(review.payload.action))throw new Error('지원하지 않는 승인 동작');
      const page=await this.browser.ensurePage();const identity=await this.identity(page,review.payload.options,review.payload.product.company.tenant);
      if(identity.sessionKey!==review.payload.sessionKey)throw new Error("승인 이후 로그인 세션이 변경되었습니다. 재검토가 필요합니다");
      if(review.payload.action==='save-schedule')assertScheduleSaveContract(page);
      if(review.payload.action==='save-schedule-candidate')assertScheduleCandidateContract(page);
      const state=review.payload.action==='save-schedule-candidate'?await this.forms.readScheduleCandidate(page,review.payload.state):review.payload.action==='save-schedule'?await this.forms.readScheduleShell(page,review.payload.target):review.payload.action==='save-schedule-day'?await this.forms.readScheduleDay(page,review.payload.target,review.payload.draft.day):review.payload.action==='save-basic'?await this.forms.readBasicForm(page):await this.creationState(page);
      if(hashBytes(await readFile(review.payload.screenshot.path))!==review.payload.screenshot.sha256)throw new Error('검토 화면 파일이 변경되었습니다');
      await this.store.claim(id,{hash:review.hash,accountKey:identity.accountKey,formHash:digest(state)});
      // From claim onward every failure is indeterminate; never auto retry a click.
      let result;
      try {
        if(review.payload.action==='open-new-form'){
          await page.locator('#modal').getByRole('link',{name:'상품생성',exact:true}).click();
          await page.waitForURL(url=>url.origin===ALLOWED_ORIGIN && url.pathname==='/tour/master_product/add/',{timeout:15000});
          await page.locator('#id_2-title').waitFor({state:'visible'});
          const initial=await this.forms.readBasicForm(page);
          result={status:'new-form-opened',url:page.url(),state:initial,notice:'신규 입력 화면입니다. 상품 기본정보 저장은 별도 검토·승인 필요'};
        } else if(review.payload.action==='save-schedule-candidate'){
          result=await this.forms.clickSaveScheduleCandidateAndVerify(page,review.payload.state,{beforeClick:async()=>{
            assertScheduleCandidateContract(page);
            const current=await this.identity(page,review.payload.options,review.payload.product.company.tenant);
            if(current.accountKey!==identity.accountKey||current.sessionKey!==identity.sessionKey)throw new Error('실행 직전 계정/세션 변경');
          }});
        } else if(review.payload.action==='save-schedule'){
          result=await this.forms.clickSaveScheduleAndVerify(page,review.payload.state);
        } else if(review.payload.action==='save-schedule-day'){
          result=await this.forms.clickSaveScheduleDayAndVerify(page,review.payload.state);
        } else {
          result=await this.forms.clickSaveAndVerify(page,review.payload.state);
        }
        const afterIdentity=await this.identity(page,review.payload.options,review.payload.product.company.tenant);
        if(afterIdentity.accountKey!==identity.accountKey)throw new Error('실행 중 로그인 계정이 변경되었습니다');
        const warnings=[];if(afterIdentity.sessionKey!==identity.sessionKey)warnings.push('검증된 실행 후 세션이 갱신되었습니다. 후속 작업은 새 세션으로 검토하세요');
        try{result={...result,proof:await this.screenshot(page,{reviewId:id,result})};}catch(error){warnings.push('결과 캡처 실패: '+error.message);}
        result={...result,warnings};
        await this.store.finish(id,result);return result;
      }catch(error){await this.store.fail(id,String(error.message),result);throw new Error('결과 확인 필요. 다시 클릭하지 마세요: '+error.message);}
    });
  }
}
