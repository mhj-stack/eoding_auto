import { digest } from './core.mjs';
import { fillNewBasic, readBasicForm, clickSaveAndVerify, reconcileBasicPersisted } from './basic-form.mjs';
import { createProductScheduleAdapters } from './product-schedule-execution.mjs';
import { openProductCreationForm } from './product-start.mjs';
import { ERP_URL } from './browser.mjs';
import { createProductDepartureAdapters, departureInputIssue } from './product-departure-execution.mjs';
import { createProductHotelStageAdapters, hotelAssignments, hotelInputIssue } from './product-hotel-stage.mjs';

const STAGES = Object.freeze([['basic', 'basic'], ['shell', 'schedule-shell'], ['days', 'itinerary'], ['hotels', 'hotel'], ['departures', 'departure']]);
const METHODS = Object.freeze({ basic: ['prepare', 'read', 'save', 'reload'], shell: ['prepare', 'read', 'save'], days: ['prepare', 'read', 'save'], hotels: ['prepare', 'read', 'save'], departures: ['prepare', 'read', 'save'] });
const FULL_SCOPE_BLOCKER = Object.freeze({ stage: 'full-product', reason: '전체 상품 범위 실행은 지원하지 않습니다. 명시 범위만 사용할 수 있습니다.' });
const HOTEL_DEPARTURE_BLOCKER = Object.freeze({ stage: 'hotel-departure-preservation', reason: '호텔 저장 뒤 행사 원본 보존 검증이 아직 지원되지 않아 함께 실행할 수 없습니다.' });
const clone = value => structuredClone(value);
const fail = message => { throw new Error(message); };
const text = (value, name) => { if (typeof value !== 'string' || !value.trim() || value.length > 4096) fail(`${name} 확인이 필요합니다.`); return value; };
const equal = (left, right) => digest(left) === digest(right);

function requested(scope, name) { return scope === 'full' || scope.includes(name); }
function assertNotFullScope(scope) { if (scope === 'full') fail(FULL_SCOPE_BLOCKER.reason); }
function exactObject(value, keys) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)); }
function basicInputIssue(value) {
  if (!exactObject(value, ['options']) || !exactObject(value.options, ['cityLabel', 'managerLabel', 'priority', 'cutoffDays'])) return 'basic options의 정확한 cityLabel/managerLabel/priority/cutoffDays 형태가 필요합니다.';
  const { cityLabel, managerLabel, priority, cutoffDays } = value.options;
  if (![priority, cutoffDays].every(number => Number.isInteger(number) && number >= 1 && number <= 999)) return 'basic options priority/cutoffDays는 1..999 정수여야 합니다.';
  if (![cityLabel, managerLabel].every(label => typeof label === 'string' && label.trim() === label && label.length > 0 && label.length <= 4096)) return 'basic options cityLabel/managerLabel은 공백 없는 정확한 표시값이어야 합니다.';
  return null;
}
function scheduleInputIssue(scope, value) {
  if (scope === 'shell' && (!exactObject(value, ['title']) || typeof value.title !== 'string' || !value.title.trim() || value.title !== value.title.trim() || value.title.length > 20_000)) return 'shell은 정확한 일정표 title만 필요합니다.';
  if (scope === 'days' && !exactObject(value, [])) return 'days는 정규화된 일반 텍스트 일정만 사용하므로 빈 옵션 객체여야 합니다.';
  return null;
}
function adapterSupport(adapters) { return Object.freeze(Object.fromEntries(STAGES.filter(([name]) => Object.hasOwn(adapters?.supported ?? {}, name)).map(([name]) => [name, adapters.supported[name] === true && Boolean(adapters[name]) && METHODS[name].every(method => typeof adapters[name][method] === 'function')]))); }
function adapterIssue(scope, input, adapters, product) {
  const blockers = [], supported = adapterSupport(adapters);
  for (const [name] of STAGES) {
    if (!requested(scope, name)) continue;
    if (!supported[name]) blockers.push({ stage: name, reason: name === 'basic' ? '독립 새로고침 readback을 포함한 basic 저수준 어댑터가 준비되지 않았습니다.' : '전체 guarded 어댑터와 대상 라우팅이 준비되지 않아 이 범위는 저장 전 차단됩니다.' });
    if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.hasOwn(input, name)) blockers.push({ stage: name, reason: '해당 범위의 실행 대상·옵션 인터페이스가 제공되지 않았습니다.' });
    if (input?.[name]) {
      const issue = name === 'basic' ? basicInputIssue(input.basic) : name === 'hotels' ? hotelInputIssue(product, input.hotels) : name === 'departures' ? departureInputIssue(product,input.departures) : scheduleInputIssue(name, input[name]);
      if (issue) blockers.push({ stage: name, reason: issue });
    }
  }
  return blockers;
}
function resultFor(stage, result) {
  if (stage === 'departure') {
    if (!Array.isArray(result)||!result.length||result.some(item=>item?.status!=='departure-persistence-verified')) fail('행사·가격 서버 재조회 결과가 없습니다.');
  } else if (stage === 'itinerary') {
    if (!Array.isArray(result) || !result.length) fail('일차 저장 결과가 없습니다.');
    for (const item of result) { text(item?.scheduleId, '일차 일정표 ID'); if (!Number.isInteger(item?.day)) fail('일차 저장 결과의 day가 유효하지 않습니다.'); }
  } else if (stage === 'hotel') {
    if (!Array.isArray(result) || !result.length || result.some(item => item?.status !== 'hotel-assignment-persisted')) fail('호텔 서버 재조회 결과가 없습니다.');
  } else {
    if (!result || typeof result !== 'object' || Array.isArray(result)) fail(`${stage} 저장 결과가 검증 가능한 객체가 아닙니다.`);
    if (stage === 'basic') { text(result.productId, '기본정보 상품 ID'); text(result.masterCode, '기본정보 마스터 코드'); }
    if (stage === 'schedule-shell') text(result.scheduleId, '일정표 ID');
  }
  return clone(result);
}

/** Private basic plus guarded schedule-shell/plain-day production adapters. */
export function createProductLowLevelAdapters({ identity } = {}) {
  if (typeof identity !== 'function') throw new TypeError('ERP identity 어댑터가 필요합니다.');
  const supported = { basic: true, shell: true, days: true, departures: true };
  Object.defineProperty(supported, 'hotels', { value: true, enumerable: false });
  return {
    identity,
    supported: Object.freeze(supported),
    basic: {
      prepare: async (page, product, input, context) => {
        if (page.url() === ERP_URL) {
          await openProductCreationForm(page, product, { beforeOpen: context.assertIdentity });
          await context.assertIdentity();
        }
        return fillNewBasic(page, product, input.options);
      },
      read: page => readBasicForm(page),
      save: (page, state) => clickSaveAndVerify(page, state),
      reload: async page => { if (!page || typeof page.reload !== 'function') fail('basic 저장 후 독립 새로고침 가능한 페이지가 필요합니다.'); await page.reload({ waitUntil: 'domcontentloaded' }); },
      reconcile: (page, product, input, context, target) => reconcileBasicPersisted(page, product, input, context, target)
    },
    ...createProductScheduleAdapters(),
    ...createProductHotelStageAdapters(),
    ...createProductDepartureAdapters()
  };
}

/** One parent scope approval, one execution claim, and no automatic retry after any write. */
export class ProductExecutionCoordinator {
  constructor({ store, browser, adapters } = {}) {
    if (!store || typeof store.preflight !== 'function' || typeof store.bindApprovalContext !== 'function' || typeof store.claimApprovedPlan !== 'function' || typeof store.preflightBasicRecovery !== 'function' || typeof store.claimReconciledBasic !== 'function' || typeof store.preflightShellRecovery !== 'function' || typeof store.claimReconciledShell !== 'function' || typeof store.preflightItineraryRecovery !== 'function' || typeof store.claimReconciledItinerary !== 'function' || typeof store.preflightFinalDepartureRecovery !== 'function' || typeof store.claimReconciledFinalDeparture !== 'function') throw new TypeError('ProductSessionStore가 필요합니다.');
    if (!browser || typeof browser.ensurePage !== 'function' || typeof browser.exclusive !== 'function') throw new TypeError('전용 ERP 브라우저와 exclusive 잠금이 필요합니다.');
    if (!adapters || typeof adapters.identity !== 'function') throw new TypeError('계정·세션 확인 identity 어댑터가 필요합니다.');
    this.store = store; this.browser = browser; this.adapters = adapters; this.supportedAdapters = adapterSupport(adapters);
  }
  async preflight(id, input) {
    const base = await this.store.preflight(id), session = await this.store.get(id);
    const journal = requested(base.requestedScope, 'days') && typeof this.store.recordItineraryDay !== 'function' ? [{ stage: 'itinerary', reason: '일차별 내구성 실행 저널 API가 준비되지 않았습니다.' }] : [];
    if (requested(base.requestedScope,'hotels') && typeof this.store.recordHotelAssignment !== 'function') journal.push({stage:'hotel',reason:'호텔별 내구성 저장 결과 API가 준비되지 않았습니다.'});
    if (requested(base.requestedScope,'departures') && ['claimDeparture','recordDeparture'].some(name=>typeof this.store[name]!=='function')) journal.push({stage:'departure',reason:'행사별 내구성 claim·저장 결과 API가 준비되지 않았습니다.'});
    const preservation = base.requestedScope !== 'full' && requested(base.requestedScope, 'hotels') && requested(base.requestedScope, 'departures') ? [HOTEL_DEPARTURE_BLOCKER] : [];
    const blockers = [...base.blockers, ...(base.requestedScope === 'full' ? [FULL_SCOPE_BLOCKER] : []), ...preservation, ...adapterIssue(base.requestedScope, input, this.adapters, session.normalized), ...journal];
    return { ...base, supportedAdapters: { ...this.supportedAdapters }, canExecute: blockers.length === 0, execution: blockers.length ? 'blocked-before-write' : 'approved-plan-ready', blockers };
  }
  async prepareApproval(id, input) {
    const executionInput = clone(input), checked = await this.preflight(id, executionInput);
    assertNotFullScope(checked.requestedScope);
    if (!checked.canExecute) fail('요청 범위, 실행 입력 또는 어댑터가 저장 전 차단되었습니다. ERP 저장을 시도하지 않았습니다.');
    return this.browser.exclusive(async () => { const session = await this.store.get(id), page = await this.browser.ensurePage(); const identity = await this._identity(page, session); return this.store.bindApprovalContext(id, { ...identity, executionInput }); });
  }
  async _identity(page, session) {
    const identity = await this.adapters.identity(page, { tenant: session.normalized.company?.tenant, accountObserved: session.approval?.accountObserved, requestedScope: session.requestedScope });
    if (!identity || typeof identity !== 'object') fail('ERP identity 어댑터 결과가 없습니다.');
    return { accountName: text(identity.accountName, 'ERP 표시 계정명'), accountKey: text(identity.accountKey, 'ERP 계정 키'), sessionKey: text(identity.sessionKey, 'ERP 세션 키') };
  }
  async execute(id, input) {
    const executionInput = clone(input), checked = await this.preflight(id, executionInput);
    assertNotFullScope(checked.requestedScope);
    if (!checked.canExecute) fail('요청 범위, 실행 입력 또는 어댑터가 저장 전 차단되었습니다. ERP 저장을 시도하지 않았습니다.');
    return this.browser.exclusive(async () => {
      let claim;
      try {
        const session = await this.store.get(id);
        if (!session.approvalContext?.executionInput || !equal(session.approvalContext.executionInput, executionInput)) fail('승인된 실행 입력이 현재 실행 입력과 다릅니다. 다시 검토하세요.');
        const page = await this.browser.ensurePage(), identity = await this._identity(page, session);
        claim = await this.store.claimApprovedPlan(id, { scopeDigest: checked.scopeDigest, accountKey: identity.accountKey, sessionKey: identity.sessionKey });
        const current = claim.record, results = {};
        for (const [scope, stage] of STAGES) if (requested(current.requestedScope, scope)) results[scope] = await this._runStage({ page, session: current, token: claim.token, identity, scope, stage, input: executionInput[scope], dependencies: results });
        const completed = await this.store.finishExecution(id, claim.token);
        return { status: 'completed', id, stages: Object.fromEntries(Object.entries(results).map(([scope, value]) => [scope, { result: value }])), execution: completed.execution };
      } catch (error) {
        if (!claim) throw error;
        await this.store.failExecution(id, claim.token, '실행 결과가 불명확합니다. 다시 저장하지 말고 운영자 대사가 필요합니다.');
        throw new Error('결과 확인 필요. 다시 저장하지 마세요: ' + error.message, { cause: error });
      }
    });
  }
  /** Explicit operator-directed read-only proof that an unjournaled basic save already succeeded. */
  async reconcileAndResumeBasic(id, input, target) {
    const executionInput = clone(input), checked = await this.preflight(id, executionInput);
    assertNotFullScope(checked.requestedScope);
    if (!checked.canExecute) fail('원래 승인 범위, 실행 입력 또는 어댑터가 저장 전 차단되었습니다. ERP 저장을 시도하지 않았습니다.');
    await this.store.preflightBasicRecovery(id, { scopeDigest: checked.scopeDigest, inputDigest: digest(executionInput), target });
    if (typeof this.adapters.basic?.reconcile !== 'function') fail('읽기 전용 basic.reconcile 어댑터가 필요합니다.');
    return this.browser.exclusive(async () => {
      let claim;
      try {
        // Re-check the durable state inside the browser lock before any ERP adapter is called.
        const currentRecovery = await this.store.preflightBasicRecovery(id, { scopeDigest: checked.scopeDigest, inputDigest: digest(executionInput), target });
        const session = await this.store.get(id), page = await this.browser.ensurePage(), identity = await this._identity(page, session);
        const boundIdentity = { accountName: currentRecovery.approvalContext.accountName, accountKey: currentRecovery.approvalContext.accountKey, sessionKey: currentRecovery.approvalContext.sessionKey };
        if (!equal(identity, boundIdentity)) fail('현재 ERP 계정 또는 로그인 세션이 원래 승인 컨텍스트와 다릅니다.');
        const context = { product: clone(session.normalized), identity: clone(identity), session: clone(session), dependencies: {}, assertIdentity: async () => {
          const fresh = await this._identity(page, session);
          if (!equal(fresh, boundIdentity)) fail('대사 중 ERP 계정 또는 로그인 세션이 변경되었습니다.');
        } };
        const evidence = resultFor('basic', await this.adapters.basic.reconcile(page, session.normalized, clone(executionInput.basic), context, clone(target)));
        if (evidence.productId !== target?.productId || evidence.masterCode !== target?.masterCode) fail('읽기 전용 기본정보 대사 결과의 상품 ID 또는 마스터 코드가 대상과 다릅니다.');
        await context.assertIdentity();
        claim = await this.store.claimReconciledBasic(id, { scopeDigest: currentRecovery.scopeDigest, inputDigest: currentRecovery.inputDigest, ...identity, target, evidence });
        const current = claim.record, results = { basic: current.execution.stages.basic.result };
        for (const [scope, stage] of STAGES) if (scope !== 'basic' && requested(current.requestedScope, scope)) results[scope] = await this._runStage({ page, session: current, token: claim.token, identity, scope, stage, input: executionInput[scope], dependencies: results });
        const completed = await this.store.finishExecution(id, claim.token);
        return { status: 'completed', id, stages: Object.fromEntries(Object.entries(results).map(([scope, value]) => [scope, { result: value }])), execution: completed.execution };
      } catch (error) {
        if (!claim) throw error;
        await this.store.failExecution(id, claim.token, '기본정보 대사 뒤 남은 단계의 결과가 불명확합니다. 기본정보를 다시 저장하지 말고 운영자 대사가 필요합니다.');
        throw new Error('결과 확인 필요. 기본정보를 다시 저장하지 마세요: ' + error.message, { cause: error });
      }
    });
  }
  /** Explicit read-only proof for a verified basic plus schedule shell before first day persistence. */
  async reconcileAndResumeShell(id, input, target) {
    const executionInput = clone(input), checked = await this.preflight(id, executionInput);
    assertNotFullScope(checked.requestedScope);
    if (!checked.canExecute) fail('원래 승인 범위, 실행 입력 또는 어댑터가 저장 전 차단되었습니다. ERP 저장을 시도하지 않았습니다.');
    await this.store.preflightShellRecovery(id, { scopeDigest: checked.scopeDigest, inputDigest: digest(executionInput), target });
    if (typeof this.adapters.basic?.reconcile !== 'function' || typeof this.adapters.shell?.reconcile !== 'function') fail('읽기 전용 basic.reconcile 및 shell.reconcile 어댑터가 필요합니다.');
    return this.browser.exclusive(async () => {
      let claim;
      try {
        const recovery = await this.store.preflightShellRecovery(id, { scopeDigest: checked.scopeDigest, inputDigest: digest(executionInput), target });
        const session = await this.store.get(id), page = await this.browser.ensurePage(), identity = await this._identity(page, session);
        const boundIdentity = { accountName: recovery.approvalContext.accountName, accountKey: recovery.approvalContext.accountKey, sessionKey: recovery.approvalContext.sessionKey };
        if (!equal(identity, boundIdentity)) fail('현재 ERP 계정 또는 로그인 세션이 원래 승인 컨텍스트와 다릅니다.');
        const context = { product: clone(session.normalized), identity: clone(identity), session: clone(session), dependencies: {}, assertIdentity: async () => {
          const fresh = await this._identity(page, session);
          if (!equal(fresh, boundIdentity)) fail('대사 중 ERP 계정 또는 로그인 세션이 변경되었습니다.');
        } };
        const basicEvidence = resultFor('basic', await this.adapters.basic.reconcile(page, session.normalized, clone(executionInput.basic), context, clone(target)));
        if (basicEvidence.productId !== target?.productId || basicEvidence.masterCode !== target?.masterCode) fail('읽기 전용 기본정보 대사 결과의 상품 ID 또는 마스터 코드가 대상과 다릅니다.');
        await context.assertIdentity();
        const shellEvidence = resultFor('schedule-shell', await this.adapters.shell.reconcile(page, session.normalized, clone(executionInput.shell), context, clone(target)));
        if (!equal(shellEvidence, recovery.execution.stages['schedule-shell'].result)) fail('읽기 전용 일정표 대사 결과가 기존 일정표 저장 기록과 다릅니다.');
        await context.assertIdentity();
        claim = await this.store.claimReconciledShell(id, { scopeDigest: recovery.scopeDigest, inputDigest: recovery.inputDigest, recoveryDigest: recovery.recoveryDigest, ...identity, target, basicEvidence, shellEvidence });
        const current = claim.record, results = { basic: current.execution.stages.basic.result, shell: current.execution.stages['schedule-shell'].result };
        for (const [scope, stage] of STAGES) if (['days', 'departures'].includes(scope) && requested(current.requestedScope, scope)) results[scope] = await this._runStage({ page, session: current, token: claim.token, identity, scope, stage, input: executionInput[scope], dependencies: results });
        const completed = await this.store.finishExecution(id, claim.token);
        return { status: 'completed', id, stages: Object.fromEntries(Object.entries(results).map(([scope, value]) => [scope, { result: value }])), execution: completed.execution };
      } catch (error) {
        if (!claim) throw error;
        await this.store.failExecution(id, claim.token, '일정표 대사 뒤 일차·행사 단계의 결과가 불명확합니다. basic 또는 일정표를 다시 저장하지 말고 운영자 대사가 필요합니다.');
        throw new Error('결과 확인 필요. basic 또는 일정표를 다시 저장하지 마세요: ' + error.message, { cause: error });
      }
    });
  }
  /** Explicit read-only proof for a completed itinerary before the first departure claim. */
  async reconcileAndResumeItinerary(id, input, target) {
    const executionInput = clone(input), checked = await this.preflight(id, executionInput);
    assertNotFullScope(checked.requestedScope);
    if (!checked.canExecute) fail('원래 승인 범위, 실행 입력 또는 어댑터가 저장 전 차단되었습니다. ERP 저장을 시도하지 않았습니다.');
    await this.store.preflightItineraryRecovery(id, { scopeDigest: checked.scopeDigest, inputDigest: digest(executionInput), target });
    if (typeof this.adapters.basic?.reconcile !== 'function' || typeof this.adapters.shell?.reconcile !== 'function' || typeof this.adapters.days?.reconcile !== 'function') fail('읽기 전용 basic.reconcile, shell.reconcile 및 days.reconcile 어댑터가 필요합니다.');
    return this.browser.exclusive(async () => {
      let claim;
      try {
        const recovery = await this.store.preflightItineraryRecovery(id, { scopeDigest: checked.scopeDigest, inputDigest: digest(executionInput), target });
        const session = await this.store.get(id), page = await this.browser.ensurePage(), identity = await this._identity(page, session);
        const boundIdentity = { accountName: recovery.approvalContext.accountName, accountKey: recovery.approvalContext.accountKey, sessionKey: recovery.approvalContext.sessionKey };
        if (!equal(identity, boundIdentity)) fail('현재 ERP 계정 또는 로그인 세션이 원래 승인 컨텍스트와 다릅니다.');
        const context = { product: clone(session.normalized), identity: clone(identity), session: clone(session), dependencies: {}, assertIdentity: async () => {
          const fresh = await this._identity(page, session);
          if (!equal(fresh, boundIdentity)) fail('대사 중 ERP 계정 또는 로그인 세션이 변경되었습니다.');
        } };
        const basicEvidence = resultFor('basic', await this.adapters.basic.reconcile(page, session.normalized, clone(executionInput.basic), context, clone(target)));
        if (!equal(basicEvidence, recovery.execution.stages.basic.result)) fail('읽기 전용 기본정보 대사 결과가 기존 basic 저장 기록과 다릅니다.');
        await context.assertIdentity();
        const shellEvidence = resultFor('schedule-shell', await this.adapters.shell.reconcile(page, session.normalized, clone(executionInput.shell), context, clone(target)));
        if (!equal(shellEvidence, recovery.execution.stages['schedule-shell'].result)) fail('읽기 전용 일정표 대사 결과가 기존 일정표 저장 기록과 다릅니다.');
        await context.assertIdentity();
        const itineraryEvidence = resultFor('itinerary', await this.adapters.days.reconcile(page, session.normalized, {}, context, clone(target)));
        if (!equal(itineraryEvidence, recovery.execution.stages.itinerary.result)) fail('읽기 전용 일차 대사 결과가 기존 일차 저장 기록과 다릅니다.');
        await context.assertIdentity();
        claim = await this.store.claimReconciledItinerary(id, { scopeDigest: recovery.scopeDigest, inputDigest: recovery.inputDigest, recoveryDigest: recovery.recoveryDigest, ...identity, target, basicEvidence, shellEvidence, itineraryEvidence });
        const current = claim.record, results = { basic: current.execution.stages.basic.result, shell: current.execution.stages['schedule-shell'].result, days: current.execution.stages.itinerary.result };
        if (requested(current.requestedScope, 'departures')) results.departures = await this._runStage({ page, session: current, token: claim.token, identity, scope: 'departures', stage: 'departure', input: executionInput.departures, dependencies: results });
        const completed = await this.store.finishExecution(id, claim.token);
        return { status: 'completed', id, stages: Object.fromEntries(Object.entries(results).map(([scope, value]) => [scope, { result: value }])), execution: completed.execution };
      } catch (error) {
        if (!claim) throw error;
        await this.store.failExecution(id, claim.token, '일차 대사 뒤 행사 단계의 결과가 불명확합니다. basic·일정표·일차를 다시 저장하지 말고 운영자 대사가 필요합니다.');
        throw new Error('결과 확인 필요. basic·일정표·일차를 다시 저장하지 마세요: ' + error.message, { cause: error });
      }
    });
  }
  /** Explicit final read-only proof for a single claimed departure; it never prepares, saves, or retries ERP writes. */
  async reconcileCompletedDeparture(id, input, target) {
    const executionInput = clone(input), checked = await this.preflight(id, executionInput);
    assertNotFullScope(checked.requestedScope);
    if (!checked.canExecute) fail('원래 승인 범위, 실행 입력 또는 어댑터가 저장 전 차단되었습니다. ERP 저장을 시도하지 않았습니다.');
    await this.store.preflightFinalDepartureRecovery(id, { scopeDigest: checked.scopeDigest, inputDigest: digest(executionInput), target });
    if (typeof this.adapters.departures?.reconcile !== 'function') fail('읽기 전용 departures.reconcile 어댑터가 필요합니다.');
    return this.browser.exclusive(async () => {
      const recovery = await this.store.preflightFinalDepartureRecovery(id, { scopeDigest: checked.scopeDigest, inputDigest: digest(executionInput), target });
      const session = await this.store.get(id), page = await this.browser.ensurePage(), identity = await this._identity(page, session);
      const boundIdentity = { accountName: recovery.approvalContext.accountName, accountKey: recovery.approvalContext.accountKey, sessionKey: recovery.approvalContext.sessionKey };
      if (!equal(identity, boundIdentity)) fail('현재 ERP 계정 또는 로그인 세션이 원래 승인 컨텍스트와 다릅니다.');
      const context = { product: clone(session.normalized), identity: clone(identity), session: clone(session), dependencies: { basic: clone(recovery.basic), shell: clone(recovery.shell), days: clone(recovery.itinerary) }, assertIdentity: async () => {
        const fresh = await this._identity(page, session);
        if (!equal(fresh, boundIdentity)) fail('대사 중 ERP 계정 또는 로그인 세션이 변경되었습니다.');
      } };
      const evidence = resultFor('departure', [await this.adapters.departures.reconcile(page, session.normalized, clone(executionInput.departures), context, clone(target))])[0];
      if (evidence.productId !== target?.productId || evidence.eventId !== target?.eventId || evidence.sourceScheduleId !== target?.scheduleId) fail('읽기 전용 행사 대사 결과의 상품·일정표·행사 ID가 대상과 다릅니다.');
      await context.assertIdentity();
      const completed = await this.store.claimReconciledFinalDeparture(id, { scopeDigest: recovery.scopeDigest, inputDigest: recovery.inputDigest, executionDigest: recovery.executionDigest, ...identity, target, evidence });
      return { status: 'completed', id, stages: { departures: { result: evidence } }, execution: completed.record.execution };
    });
  }
  async _runStage({ page, session, token, identity, scope, stage, input, dependencies }) {
    const adapter = this.adapters[scope], product = session.normalized;
    if (scope === 'departures') {
      const results=[];
      for (let index=0;index<product.departures.length;index++) {
        const extra={departureIndex:index,claimDeparture:candidate=>this.store.claimDeparture(session.id,token,index,candidate)};
        const outcome=resultFor(stage,[await this._runOne(adapter,page,product,input,undefined,identity,session,stage,dependencies,extra)])[0];
        await this.store.recordDeparture(session.id,token,index,outcome);results.push(outcome);
      }
      if(product.includesFlight===true) await this.store.recordStage(session.id,token,'flight',results);
      await this.store.recordStage(session.id,token,'departure',results);
      await this.store.recordStage(session.id,token,'price',results);
      return results;
    }
    if (scope === 'days') {
      const results = [];
      for (const day of product.itinerary) {
        const outcome = resultFor(stage, [await this._runOne(adapter, page, product, input, day, identity, session, stage, dependencies)])[0];
        await this.store.recordItineraryDay(session.id, token, day.day, outcome);
        results.push(outcome);
      }
      await this.store.recordStage(session.id, token, stage, resultFor(stage, results)); return results;
    }
    if (scope === 'hotels') {
      const assignments = hotelAssignments(product, input), results = [];
      for (let index = 0; index < assignments.length; index += 1) {
        const extra = { hotelAssignmentIndex: index, hotelAssignment: assignments[index] };
        const outcome = resultFor(stage, [await this._runOne(adapter, page, product, input, undefined, identity, session, stage, dependencies, extra)])[0];
        await this.store.recordHotelAssignment(session.id, token, index, outcome);
        results.push(outcome);
      }
      await this.store.recordStage(session.id, token, 'hotel', resultFor(stage, results));
      return results;
    }
    const outcome = await this._runOne(adapter, page, product, input, undefined, identity, session, stage, dependencies);
    await this.store.recordStage(session.id, token, stage, resultFor(stage, outcome)); return outcome;
  }
  async _runOne(adapter, page, product, input, day, identity, session, stage, dependencies, extra = {}) {
    const context = { ...extra, product: clone(product), identity: clone(identity), session: clone(session), dependencies: clone(dependencies), day: day && clone(day), assertIdentity: async () => {
      const current = await this._identity(page, session);
      if (!equal(current, identity)) fail('실행 직전 ERP 계정 또는 로그인 세션이 변경되었습니다.');
    } };
    const prepared = await adapter.prepare(page, product, clone(input), context);
    const readback = await adapter.read(page, product, clone(input), { ...context, prepared: clone(prepared) });
    if (!equal(prepared, readback)) fail(`${stage} 폼이 승인 범위 실행 중 변경되었습니다.`);
    await context.assertIdentity();
    const result = await adapter.save(page, prepared, clone(input), context);
    if (stage === 'basic') {
      await adapter.reload(page, clone(result));
      const persisted = await adapter.read(page, product, clone(input)); const { productId, ...savedState } = result;
      const changed = [...new Set([...Object.keys(savedState), ...Object.keys(persisted)])].filter(key => !Object.hasOwn(savedState, key) || !Object.hasOwn(persisted, key) || !equal(savedState[key], persisted[key]));
      let persistedId; try { persistedId = /^\/master\/(\d+)\/?$/.exec(new URL(persisted.masterURL).pathname)?.[1]; } catch {}
      if (changed.length || persistedId !== productId) fail('기본정보 저장 후 독립 새로고침 readback이 저장 결과와 다릅니다: ' + [...changed, ...(persistedId === productId ? [] : ['productId'])].join(','));
    }
    await context.assertIdentity();
    return result;
  }
}
