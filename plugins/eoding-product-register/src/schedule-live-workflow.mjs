import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { buildPlan, digest } from './core.mjs';
import { EodingWorkflow } from './workflow.mjs';
import { ReviewStore } from './review-store.mjs';
import { requireScheduleSession } from './schedule-session.mjs';
import { prepareLiveSchedule, readLiveSchedule, saveLiveScheduleAndVerify } from './schedule-live.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const clone = value => structuredClone(value);
const JOURNAL_FAILURE = 'live schedule outcome requires operator reconciliation';

/** Dedicated-session, human-approved production schedule-shell workflow. */
export class LiveScheduleWorkflow extends EodingWorkflow {
  constructor(browser, { store, forms = { prepareLiveSchedule, readLiveSchedule, saveLiveScheduleAndVerify } } = {}) {
    super(browser, { store: store || new ReviewStore(browser.dataDir), forms });
  }

  async prepareLiveSchedule(inputProduct, inputTarget, inputSchedule) {
    const { product, target, schedule } = clone({ product: inputProduct, target: inputTarget, schedule: inputSchedule });
    const plan = buildPlan(product);
    if (!plan.readyForReview) throw new Error('상품 검증 필요: ' + JSON.stringify(plan.errors));
    if (target.title !== product.title || schedule.nights !== product.nights || schedule.days !== product.days) throw new Error('원본과 일정표 대상/박/일 수 불일치');
    const options = { expectedAccountName: target.account };
    return this.browser.exclusive(async () => {
      const page = await this.browser.ensurePage(); const session = requireScheduleSession(page);
      const identity = await this.identity(page, options, product.company.tenant);
      const fingerprint = 'save-schedule:' + digest({ accountKey: identity.accountKey, productId: target.productId, title: schedule.title });
      if ((await this.store.findByFingerprint(fingerprint, identity.accountKey)).some(record => record.status !== 'aborted')) throw new Error('같은 일정표 작업 기록이 있습니다. 결과부터 대사하세요');
      const state = await this.forms.prepareLiveSchedule(page, product, target, schedule);
      const after = await this.identity(page, options, product.company.tenant); const current = requireScheduleSession(page);
      if (after.accountKey !== identity.accountKey || after.sessionKey !== identity.sessionKey || current.contextId !== session.contextId || state.contextId !== session.contextId) throw new Error('입력 중 계정/세션/브라우저 컨텍스트 변경');
      // Reuse the inherited modal-only region; the public action remains live-only.
      const screenshot = await this.screenshot(page, { action: 'save-schedule-candidate', state, identity });
      return this.presentReview(await this.store.create({
        action: 'save-live-schedule', fingerprint, accountKey: identity.accountKey, sessionKey: identity.sessionKey, formHash: digest(state), screenshot,
        product, options, target, schedule, state,
        summary: { action: '운영자 승인 후 일정표 셸 1회 저장', account: target.account, tenantDeclaredByUser: product.company.tenant, product: target.title, schedule, visibility: '비공개', scope: 'schedule shell only; no days, meals, hotels, departures, prices or publishing', duplicateCheck: 'local fingerprint only; reconcile ERP before another attempt' }
      }));
    });
  }

  async execute(id) {
    return this.browser.exclusive(async () => {
      const review = await this.store.get(id);
      if (review.status !== 'approved') throw new Error('사용자가 로컬 터미널에서 먼저 검토·승인해야 합니다. AI는 승인할 수 없습니다');
      if (review.payload.action !== 'save-live-schedule') throw new Error('지원하지 않는 승인 동작');
      if (!['interactive-cli-tenant-readback', 'local-review-ui-tenant-readback'].includes(review.operatorAttestation?.method) || review.operatorAttestation?.tenantObserved !== review.payload.product.company.tenant) throw new Error('운영자의 실제 ERP 회사 확인이 필요합니다');
      const page = await this.browser.ensurePage(); const session = requireScheduleSession(page);
      if (review.payload.state?.contextId !== session.contextId) throw new Error('승인 이후 전용 브라우저 컨텍스트가 변경되었습니다. 재검토가 필요합니다');
      const identity = await this.identity(page, review.payload.options, review.payload.product.company.tenant);
      if (identity.sessionKey !== review.payload.sessionKey || identity.accountKey !== review.payload.accountKey) throw new Error('승인 이후 로그인 계정 또는 세션이 변경되었습니다. 재검토가 필요합니다');
      const state = await this.forms.readLiveSchedule(page, review.payload.state);
      if (digest(state) !== review.payload.formHash) throw new Error('승인 화면이 변경되었습니다. 재검토가 필요합니다');
      if (hash(await readFile(review.payload.screenshot.path)) !== review.payload.screenshot.sha256) throw new Error('검토 화면 파일이 변경되었습니다');
      await this.store.claim(id, { hash: review.hash, accountKey: identity.accountKey, formHash: digest(state) });
      let result;
      try {
        result = await this.forms.saveLiveScheduleAndVerify(page, review.payload.state, { /** Pure identity check; the save form invokes it twice. */ beforeClick: async () => {
          const currentSession = requireScheduleSession(page); const current = await this.identity(page, review.payload.options, review.payload.product.company.tenant);
          if (currentSession.contextId !== session.contextId || current.accountKey !== identity.accountKey || current.sessionKey !== identity.sessionKey) throw new Error('실행 직전 계정/세션/브라우저 컨텍스트 변경');
        } });
        const finalSession = requireScheduleSession(page); const finalIdentity = await this.identity(page, review.payload.options, review.payload.product.company.tenant);
        if (finalSession.contextId !== session.contextId || finalIdentity.accountKey !== identity.accountKey) throw new Error('실행 중 로그인 계정 또는 브라우저 컨텍스트가 변경되었습니다');
        const warnings = [];
        if (finalIdentity.sessionKey !== identity.sessionKey) warnings.push('검증된 실행 후 세션이 갱신되었습니다. 후속 작업은 새 세션으로 재검토하세요');
        try { result = { ...result, proof: await this.screenshot(page, { result: { status: 'schedule-saved' } }) }; } catch { warnings.push('결과 캡처 실패: 운영자가 결과 화면을 직접 확인하세요'); }
        result = { ...result, warnings };
        await this.store.finish(id, result);
        return result;
      } catch {
        try { await this.store.fail(id, JOURNAL_FAILURE, result); } catch {}
        throw new Error('결과 확인 필요. 다시 클릭하지 마세요: 운영자 대사가 필요합니다');
      }
    });
  }
}
