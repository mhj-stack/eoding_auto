import { createHash, randomBytes } from 'node:crypto';
import { mkdir, lstat, open, rename, unlink } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { buildIntake } from './intake.mjs';
import { buildPlan, canonical, digest } from './core.mjs';
import { hotelAssignments } from './product-hotel-stage.mjs';
import { flightDepartureInputIssue, flightDepartureCoverage } from './flight-departure.mjs';

const ID = /^[a-f0-9]{64}$/;
const SOURCE_KINDS = new Set(['url', 'excel']);
const TTL = 15 * 60 * 1000;
const SCOPE_NAMES = Object.freeze(['basic', 'shell', 'days', 'hotels', 'departures']);
const FULL_SCOPE_BLOCKER = Object.freeze({ stage: 'full-product', reason: '전체 상품 범위 실행은 지원하지 않습니다. 명시 범위만 사용할 수 있습니다.' });
const HOTEL_DEPARTURE_BLOCKER = Object.freeze({ stage: 'hotel-departure-preservation', reason: '호텔 저장 뒤 행사 원본 보존 검증이 아직 지원되지 않아 함께 실행할 수 없습니다.' });
const clone = value => JSON.parse(JSON.stringify(value));
const fail = message => { throw new Error(message); };
const sourceDigest = source => createHash('sha256').update(canonical(source.evidence)).digest('hex');
const inputDigest = input => digest(input);
const equal = (left, right) => digest(left) === digest(right);
const scopeDigest = record => digest({ id: record.id, version: record.version, source: { kind: record.source.kind, label: record.source.label, digest: record.source.digest }, normalized: record.normalized, requestedScope: record.requestedScope, executionInput: record.approvalContext?.executionInput ?? null, identity: record.approvalContext ? { accountName: record.approvalContext.accountName, accountKey: record.approvalContext.accountKey, sessionKey: record.approvalContext.sessionKey } : null, stages: record.stages.map(({ name, requested, supported, reason }) => ({ name, requested, supported, reason })) });

function scope(input) {
  if (input === undefined || input === 'full') return 'full';
  if (!Array.isArray(input) || !input.length || input.some(value => !SCOPE_NAMES.includes(value)) || new Set(input).size !== input.length)
    fail('실행 범위는 full 또는 basic/shell/days/departures의 중복 없는 배열이어야 합니다.');
  if (['hotels', 'departures'].some(required => input.includes(required)) && ['basic','shell','days'].some(name=>!input.includes(name))) fail('호텔·행사 범위에는 새 기본정보·일정표·모든 일차가 함께 필요합니다.');
  return SCOPE_NAMES.filter(value => input.includes(value));
}
function includesScope(requestedScope, name) { return requestedScope === 'full' || requestedScope.includes(name); }
function plainDays(normalized) {
  return Array.isArray(normalized?.itinerary) && normalized.itinerary.length > 0 && normalized.itinerary.every(day =>
    Number.isInteger(day?.day) && typeof day.title === 'string' && day.title.trim() && typeof day.description === 'string' && day.description.trim() &&
    day.meals && ['breakfast', 'lunch', 'dinner'].every(kind => typeof day.meals[kind] === 'string' && day.meals[kind].trim()));
}
function stages(normalized, requestedScope) {
  const plan = buildPlan(normalized), ready = Boolean(plan.readyForReview), full = requestedScope === 'full';
  const departureScope = !full && requestedScope.includes('departures');
  const hotelScope = !full && requestedScope.includes('hotels');
  const requested = {
    basic: includesScope(requestedScope, 'basic'), 'schedule-shell': includesScope(requestedScope, 'shell'), itinerary: includesScope(requestedScope, 'days'),
    hotel: (full || hotelScope) && Array.isArray(normalized?.hotels) && normalized.hotels.length > 0,
    flight: (full || departureScope) && normalized?.includesFlight === true,
    departure: (full || departureScope) && Array.isArray(normalized?.departures) && normalized.departures.length > 0,
    price: (full || departureScope) && Array.isArray(normalized?.departures) && normalized.departures.some(departure => Array.isArray(departure?.prices) && departure.prices.length > 0)
  };
  const support = { basic: Boolean(plan.adapter?.canCommitBasicWithLocalApproval), 'schedule-shell': true, itinerary: plainDays(normalized), hotel: hotelScope && Array.isArray(normalized?.hotels) && normalized.hotels.length > 0, flight: departureScope && normalized?.includesFlight === true && normalized?.currency === 'KRW', departure: departureScope && typeof normalized?.includesFlight === 'boolean' && normalized?.currency === 'KRW', price: departureScope && typeof normalized?.includesFlight === 'boolean' && normalized?.currency === 'KRW' };
  const reason = {
    basic: '비공개 기본정보 1건만 지원합니다.', 'schedule-shell': '일정표 기본틀 1건만 지원하며, 실운영 저장 어댑터/대상은 별도 제공되어야 합니다.',
    itinerary: '모든 일차가 빈 기본 일정표의 일반 텍스트·식사인 경우에만 지원합니다.', hotel: hotelScope ? '정규화된 호텔마다 일차·카탈로그·확정 상태를 명시 매핑해야 합니다.' : '호텔 저장은 명시 hotels 범위에서만 지원합니다.',
    flight: '명시 departures 범위에서 행사에 포함된 모든 항공 구간의 서버 재조회가 필요합니다.', departure: departureScope ? '명시 선택한 KRW 예약마감 행사만 실험적으로 지원합니다.' : '전체 범위의 행사 연결은 차단됩니다.', price: departureScope ? '행사와 함께 저장한 성인·소아·유아 요금의 서버 재조회가 필요합니다.' : '전체 범위 요금 연결은 차단됩니다.'
  };
  return Object.keys(requested).map(name => ({ name, requested: requested[name], supported: support[name], status: !ready ? 'blocked-normalization' : !requested[name] ? 'not-requested' : support[name] ? 'supported' : 'unsupported', reason: reason[name] }));
}
function integrity(record) { return digest({ id: record.id, version: record.version, source: record.source, normalized: record.normalized, requestedScope: record.requestedScope, approval: record.approval, approvalContext: record.approvalContext, execution: record.execution, stages: record.stages }); }
function approvalFresh(record, now) { return record.approval?.status === 'approved' && Number.isSafeInteger(record.approval.expiresAt) && now < record.approval.expiresAt; }
function recoveryTarget(target) {
  if (!target || typeof target !== 'object' || Array.isArray(target) || Object.keys(target).length !== 2 || !['productId', 'masterCode'].every(key => Object.hasOwn(target, key)) || !/^[1-9]\d{0,9}$/.test(target.productId) || typeof target.masterCode !== 'string' || !target.masterCode || target.masterCode.trim() !== target.masterCode || target.masterCode.length > 4096) fail('복구 대상의 정확한 상품 ID와 마스터 코드가 필요합니다.');
  return clone(target);
}
function emptyJournal(value) { return value === undefined || (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0); }
function shellRecoveryTarget(target) {
  if (!target || typeof target !== 'object' || Array.isArray(target) || Object.keys(target).length !== 3 || !['productId', 'masterCode', 'scheduleId'].every(key => Object.hasOwn(target, key)) || typeof target.scheduleId !== 'string' || !/^[1-9]\d{0,9}$/.test(target.scheduleId)) fail('복구 대상의 정확한 상품 ID·마스터 코드·일정표 ID가 필요합니다.');
  recoveryTarget({ productId: target.productId, masterCode: target.masterCode });
  return clone(target);
}
function finalDepartureRecoveryTarget(target) {
  if (!target || typeof target !== 'object' || Array.isArray(target) || Object.keys(target).length !== 4 || !['productId', 'masterCode', 'scheduleId', 'eventId'].every(key => Object.hasOwn(target, key)) || typeof target.eventId !== 'string' || !/^[1-9]\d{0,9}$/.test(target.eventId)) fail('복구 대상의 정확한 상품 ID·마스터 코드·일정표 ID·행사 ID가 필요합니다.');
  shellRecoveryTarget({ productId: target.productId, masterCode: target.masterCode, scheduleId: target.scheduleId });
  return clone(target);
}
function removeTokens(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) { for (const item of value) removeTokens(item); return value; }
  delete value.token;
  for (const item of Object.values(value)) removeTokens(item);
  return value;
}
function historyWithoutTokens(value) { return removeTokens(clone(value)); }

/** Durable local session journal. It owns the parent scope approval and execution claim; it never opens ERP. */
export class ProductSessionStore {
  constructor(dataDir, { clock = () => Date.now() } = {}) {
    if (typeof dataDir !== 'string' || !dataDir.trim() || typeof clock !== 'function') fail('전용 비공개 데이터 폴더와 시계가 필요합니다.');
    this.directory = path.resolve(dataDir, 'product-sessions'); this.clock = clock;
  }
  _now() { const now = this.clock(); if (!Number.isSafeInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - TTL) fail('유효한 시계가 필요합니다.'); return now; }
  async _init() { await mkdir(this.directory, { recursive: true, mode: 0o700 }); const info = await lstat(this.directory); if (!info.isDirectory() || info.isSymbolicLink()) fail('상품 세션 폴더가 안전하지 않습니다.'); }
  _file(id) { if (typeof id !== 'string' || !ID.test(id)) fail('잘못된 상품 세션 ID입니다.'); return path.join(this.directory, `${id}.json`); }
  async _locked(id, action) {
    this._file(id); await this._init(); const filename = path.join(this.directory, `${id}.lock`), deadline = performance.now() + 10_000; let handle;
    while (!handle) {
      try { handle = await open(filename, 'wx', 0o600); }
      catch (error) {
        const contended = error.code === 'EEXIST' || (process.platform === 'win32' && ['EACCES', 'EPERM'].includes(error.code));
        if (!contended) throw error;
        if (performance.now() >= deadline) fail('상품 세션이 잠겨 있습니다. 잠금 상태를 운영자가 확인하세요.');
        await delay(10);
      }
    }
    try { return await action(); } finally { await handle.close(); await unlink(filename).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  async _read(id) {
    await this._init(); let text, handle;
    try { handle = await open(this._file(id), 'r'); text = await handle.readFile('utf8'); }
    catch (error) { if (error.code === 'ENOENT') fail('상품 세션을 찾을 수 없습니다.'); throw error; }
    finally { await handle?.close(); }
    let record; try { record = JSON.parse(text); } catch { fail('상품 세션 파일을 읽을 수 없습니다.'); }
    if (!record || record.id !== id || !Number.isInteger(record.version) || record.version < 1 || !record.source?.digest || !record.requestedScope || integrity(record) !== record.integrity) fail('상품 세션 무결성 확인에 실패했습니다.');
    return record;
  }
  async _write(record) {
    await this._init(); const data = { ...record, integrity: integrity(record) }, destination = this._file(data.id), temporary = `${destination}.${randomBytes(12).toString('hex')}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(data)); await handle.sync(); } finally { await handle.close(); }
    try { await rename(temporary, destination); } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    return this._view(data);
  }
  _view(record) {
    const value = clone({ ...record, scopeDigest: scopeDigest(record), intake: buildIntake(record.normalized) });
    if (value.execution) removeTokens(value.execution);
    return value;
  }
  async create({ source, normalized = {}, scope: requestedScope } = {}) {
    if (!source || typeof source !== 'object' || !SOURCE_KINDS.has(source.kind) || typeof source.label !== 'string' || !source.label || !Object.hasOwn(source, 'evidence')) fail('URL 또는 xlsx/xlsm 근거와 표시 이름이 필요합니다.');
    source = clone(source); normalized = clone(normalized); requestedScope = scope(requestedScope);
    const evidenceDigest = sourceDigest(source), id = digest({ source: { kind: source.kind, label: source.label, digest: evidenceDigest }, requestedScope });
    return this._locked(id, async () => {
      try { return this._view(await this._read(id)); } catch (error) { if (error.message !== '상품 세션을 찾을 수 없습니다.') throw error; }
      const record = { id, version: 1, createdAt: new Date(this._now()).toISOString(), source: { kind: source.kind, label: source.label, digest: evidenceDigest, evidence: source.evidence }, normalized, requestedScope, approval: null, approvalContext: null, execution: null, stages: stages(normalized, requestedScope) };
      return this._write(record);
    });
  }
  async get(id) { return this._view(await this._read(id)); }
  async normalize(id, normalized) {
    normalized = clone(normalized);
    return this._locked(id, async () => {
      const record = await this._read(id);
      if (record.execution) fail('승인 범위가 실행 중이거나 실행 결과 대사 전입니다. 정규화를 변경할 수 없습니다.');
      record.version += 1; record.updatedAt = new Date(this._now()).toISOString(); record.normalized = normalized; record.approval = null; record.approvalContext = null; record.stages = stages(normalized, record.requestedScope);
      return this._write(record);
    });
  }
  async bindApprovalContext(id, { accountKey, sessionKey, accountName, executionInput = null } = {}) {
    executionInput = clone(executionInput);
    if (![accountKey, sessionKey, accountName].every(value => typeof value === 'string' && value.trim() && value.length <= 4096)) fail('승인 전 ERP 계정·세션·표시 이름 확인이 필요합니다.');
    return this._locked(id, async () => {
      const record = await this._read(id); if (record.execution || approvalFresh(record, this._now())) fail('현재 범위는 이미 승인 또는 실행 상태입니다.');
      record.approvalContext = { version: record.version, accountKey, sessionKey, accountName: accountName.trim(), executionInput, executionInputDigest: inputDigest(executionInput), observedAt: this._now() };
      record.approvalContext.scopeDigest = scopeDigest(record);
      return this._write(record);
    });
  }
  async approve(id, { tenantObserved, accountObserved, expectedVersion, expectedScopeDigest, scope: selectedScope, deadline } = {}) {
    return this._locked(id, async () => {
      const record = await this._read(id), now = this._now(), tenant = record.normalized?.company?.tenant;
      if (record.execution) fail('실행이 이미 시작되었거나 결과 대사 전입니다.');
      if (deadline !== undefined && (!Number.isSafeInteger(deadline) || now >= deadline)) fail('검토 시간이 만료되었습니다. 다시 검토하세요.');
      if (typeof tenant !== 'string' || !tenant || tenantObserved !== tenant) fail('ERP에서 직접 확인한 회사명이 정규화 범위와 일치해야 합니다.');
      if (typeof accountObserved !== 'string' || !accountObserved.trim() || accountObserved.length > 4096) fail('ERP에서 직접 확인한 계정명을 입력하세요.');
      if (expectedVersion !== record.version || typeof expectedScopeDigest !== 'string' || expectedScopeDigest !== scopeDigest(record) || canonical(scope(selectedScope)) !== canonical(record.requestedScope)) fail('검토 화면의 버전 또는 범위가 변경되었습니다. 다시 검토하세요.');
      if (approvalFresh(record, now)) fail('현재 범위는 이미 승인되었습니다.');
      if (record.approvalContext && (record.approvalContext.version !== record.version || record.approvalContext.scopeDigest !== scopeDigest(record) || record.approvalContext.accountName !== accountObserved.trim())) fail('승인 전 확인한 ERP 계정 또는 범위가 변경되었습니다. 다시 준비하세요.');
      record.approval = { status: 'approved', version: record.version, scope: record.requestedScope, scopeDigest: scopeDigest(record), approvedAt: now, expiresAt: Math.min(now + TTL, deadline ?? now + TTL), tenantObserved, accountObserved: accountObserved.trim(), method: 'local-product-scope-review-ui' };
      return this._write(record);
    });
  }
  async cancelUnclaimed(id) {
    return this._locked(id, async () => {
      const record = await this._read(id); if (record.execution) fail('실행이 시작된 승인 기록은 취소할 수 없습니다.');
      if (!record.approval || record.approval.status !== 'approved') return this._view(record);
      record.approval = { ...record.approval, status: 'cancelled', cancelledAt: this._now() }; return this._write(record);
    });
  }
  async preflight(id) {
    const record = await this._read(id), intake = buildIntake(record.normalized), blockers = [];
    if (record.requestedScope === 'full') blockers.push(FULL_SCOPE_BLOCKER);
    if (record.requestedScope !== 'full' && record.requestedScope.includes('hotels') && record.requestedScope.includes('departures')) blockers.push(HOTEL_DEPARTURE_BLOCKER);
    if (!intake.readyForReview) blockers.push(...intake.questions.map(question => ({ stage: 'normalization', reason: question.title })), ...intake.invalidInputs.map(item => ({ stage: 'normalization', reason: item.title })));
    for (const stage of record.stages) if (stage.requested && !stage.supported) blockers.push({ stage: stage.name, reason: stage.reason });
    return clone({ id: record.id, version: record.version, requestedScope: record.requestedScope, scopeDigest: scopeDigest(record), canExecute: blockers.length === 0, execution: blockers.length ? 'blocked-before-write' : 'approved-plan-ready', blockers, stages: record.stages, notice: blockers.length ? '요청한 전체 범위에 저장 전 차단 항목이 있습니다. ERP 저장을 시도하지 않았습니다.' : '명시적으로 선택한 범위만 부모 승인 후 실행할 수 있습니다. 전체 상품 등록은 지원하지 않습니다.' });
  }
  async claimApprovedPlan(id, { scopeDigest: expectedScopeDigest, accountKey, sessionKey } = {}) {
    if (![accountKey, sessionKey].every(value => typeof value === 'string' && value.trim() && value.length <= 4096)) fail('실행 직전 ERP 계정·세션 확인이 필요합니다.');
    return this._locked(id, async () => {
      const record = await this._read(id), now = this._now();
      if (record.requestedScope === 'full') fail(FULL_SCOPE_BLOCKER.reason);
      if (record.requestedScope.includes('hotels') && record.requestedScope.includes('departures')) fail(HOTEL_DEPARTURE_BLOCKER.reason);
      if (record.execution) fail('이 승인 범위는 이미 실행되었거나 결과 대사 전입니다.');
      if (!buildIntake(record.normalized).readyForReview || record.stages.some(stage => stage.requested && !stage.supported)) fail('입력 검증 또는 미지원 단계로 실행이 차단되었습니다.');
      if (!approvalFresh(record, now) || record.approval.version !== record.version || record.approval.scopeDigest !== scopeDigest(record) || expectedScopeDigest !== scopeDigest(record)) fail('승인이 없거나 만료·변경되었습니다. 다시 검토하세요.');
      const context = record.approvalContext;
      if (!context || context.version !== record.version || context.scopeDigest !== scopeDigest(record) || context.accountKey !== accountKey || context.sessionKey !== sessionKey) fail('승인 이후 ERP 계정 또는 로그인 세션이 변경되었습니다. 다시 검토하세요.');
      if (record.normalized.includesFlight === true && record.requestedScope.includes('departures') && flightDepartureInputIssue(record.normalized, context.executionInput?.departures)) fail('항공 행사 승인 입력 검증에 실패했습니다.');
      const token = randomBytes(24).toString('hex');
      record.approval = { ...record.approval, consumedAt: now };
      record.execution = { status: 'executing', token, scopeDigest: expectedScopeDigest, claimedAt: now, stages: {} }; await this._write(record);
      return { token, record: this._view(record) };
    });
  }
  _basicRecoveryPlan(record, { scopeDigest: expectedScopeDigest, inputDigest: expectedInputDigest, target } = {}) {
    target = recoveryTarget(target);
    const currentScopeDigest = scopeDigest(record), execution = record.execution, context = record.approvalContext;
    const boundInputDigest = context ? (context.executionInputDigest ?? inputDigest(context.executionInput)) : null;
    if (typeof expectedScopeDigest !== 'string' || expectedScopeDigest !== currentScopeDigest || typeof expectedInputDigest !== 'string' || !context || (context.executionInputDigest !== undefined && context.executionInputDigest !== inputDigest(context.executionInput)) || expectedInputDigest !== boundInputDigest) fail('원래 승인 범위 또는 실행 입력 digest가 변경되었습니다.');
    if (record.requestedScope === 'full' || (record.requestedScope.includes('hotels') && record.requestedScope.includes('departures')) || !buildIntake(record.normalized).readyForReview || record.stages.some(stage => stage.requested && !stage.supported)) fail('원래 승인 범위가 복구 전에 지원·검증되어야 합니다.');
    if (!record.approval || record.approval.status !== 'approved' || record.approval.version !== record.version || record.approval.scopeDigest !== currentScopeDigest || !Number.isSafeInteger(record.approval.consumedAt ?? execution?.claimedAt)) fail('원래 소비된 승인 기록이 없습니다.');
    if (context.version !== record.version || context.scopeDigest !== currentScopeDigest || ![context.accountName, context.accountKey, context.sessionKey].every(value => typeof value === 'string' && value)) fail('원래 승인 ERP 계정·세션 컨텍스트가 없습니다.');
    if (execution?.status !== 'needs-reconciliation' || execution.scopeDigest !== currentScopeDigest || execution.recovery || !emptyJournal(execution.stages) || !emptyJournal(execution.itineraryDays) || !emptyJournal(execution.hotelAssignments) || !emptyJournal(execution.departures) || Object.hasOwn(execution, 'partialResult')) fail('빈 기본정보 복구 대상이 아니거나 이미 복구·대사된 실행입니다.');
    return { target, context: { ...clone(context), executionInputDigest: boundInputDigest }, execution: clone(execution), scopeDigest: currentScopeDigest };
  }
  async preflightBasicRecovery(id, expected = {}) {
    const record = await this._read(id), plan = this._basicRecoveryPlan(record, expected);
    return clone({ id: record.id, version: record.version, requestedScope: record.requestedScope, scopeDigest: plan.scopeDigest, inputDigest: plan.context.executionInputDigest, target: plan.target, approvalContext: plan.context, execution: this._view(record).execution });
  }
  async claimReconciledBasic(id, { scopeDigest: expectedScopeDigest, inputDigest: expectedInputDigest, accountName, accountKey, sessionKey, target, evidence } = {}) {
    evidence = evidence === undefined ? undefined : clone(evidence);
    return this._locked(id, async () => {
      const record = await this._read(id), plan = this._basicRecoveryPlan(record, { scopeDigest: expectedScopeDigest, inputDigest: expectedInputDigest, target });
      if (![accountName, accountKey, sessionKey].every(value => typeof value === 'string' && value) || accountName !== plan.context.accountName || accountKey !== plan.context.accountKey || sessionKey !== plan.context.sessionKey) fail('현재 ERP 계정 또는 로그인 세션이 원래 승인 컨텍스트와 다릅니다.');
      if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence) || evidence.productId !== plan.target.productId || evidence.masterCode !== plan.target.masterCode) fail('읽기 전용 기본정보 대사 결과가 복구 대상과 다릅니다.');
      const now = this._now(), token = randomBytes(24).toString('hex'), basic = { status: 'completed', completedAt: now, result: evidence };
      record.execution = { status: 'executing', token, scopeDigest: plan.scopeDigest, claimedAt: now, stages: { basic }, recovery: { status: 'basic-read-only-reconciled', recoveredAt: now, target: plan.target, evidence, previous: historyWithoutTokens(plan.execution) } };
      const basicStage = record.stages.find(stage => stage.name === 'basic');
      basicStage.status = 'completed'; basicStage.result = evidence;
      await this._write(record);
      return { token, record: this._view(record) };
    });
  }
  _shellRecoveryPlan(record, { scopeDigest: expectedScopeDigest, inputDigest: expectedInputDigest, target } = {}) {
    target = shellRecoveryTarget(target);
    const currentScopeDigest = scopeDigest(record), execution = record.execution, context = record.approvalContext;
    const boundInputDigest = context ? (context.executionInputDigest ?? inputDigest(context.executionInput)) : null;
    if (typeof expectedScopeDigest !== 'string' || expectedScopeDigest !== currentScopeDigest || typeof expectedInputDigest !== 'string' || !context || (context.executionInputDigest !== undefined && context.executionInputDigest !== inputDigest(context.executionInput)) || expectedInputDigest !== boundInputDigest) fail('원래 승인 범위 또는 실행 입력 digest가 변경되었습니다.');
    if (record.requestedScope === 'full' || record.requestedScope.includes('hotels') || !buildIntake(record.normalized).readyForReview || record.stages.some(stage => stage.requested && !stage.supported)) fail('일정표 복구 전 원래 승인 범위가 지원·검증되어야 합니다.');
    if (!record.approval || record.approval.status !== 'approved' || record.approval.version !== record.version || record.approval.scopeDigest !== currentScopeDigest || !Number.isSafeInteger(record.approval.consumedAt ?? execution?.claimedAt)) fail('원래 소비된 승인 기록이 없습니다.');
    if (context.version !== record.version || context.scopeDigest !== currentScopeDigest || ![context.accountName, context.accountKey, context.sessionKey].every(value => typeof value === 'string' && value)) fail('원래 승인 ERP 계정·세션 컨텍스트가 없습니다.');
    const keys = Object.keys(execution?.stages ?? {}).sort(), basic = execution?.stages?.basic, shell = execution?.stages?.['schedule-shell'];
    const recovery = execution?.shellRecovery;
    let recoveryDigest = null, validPriorRecovery = recovery === undefined;
    if (recovery !== undefined) {
      try {
        validPriorRecovery = Boolean(recovery && typeof recovery === 'object' && !Array.isArray(recovery) && recovery.status === 'shell-read-only-reconciled' && Number.isSafeInteger(recovery.recoveredAt) && equal(shellRecoveryTarget(recovery.target), target) && equal(recovery.basicEvidence, basic?.result) && equal(recovery.evidence, shell?.result) && recovery.previous && typeof recovery.previous === 'object' && !Array.isArray(recovery.previous) && equal(recovery.previous, historyWithoutTokens(recovery.previous)));
      } catch { validPriorRecovery = false; }
      if (validPriorRecovery) recoveryDigest = digest(recovery);
    }
    if (execution?.status !== 'needs-reconciliation' || execution.scopeDigest !== currentScopeDigest || !validPriorRecovery || (execution.recovery && execution.recovery.status !== 'basic-read-only-reconciled') || keys.join(',') !== 'basic,schedule-shell' || basic?.status !== 'completed' || shell?.status !== 'completed' || basic.result?.productId !== target.productId || basic.result?.masterCode !== target.masterCode || shell.result?.productId !== target.productId || shell.result?.scheduleId !== target.scheduleId || !emptyJournal(execution.itineraryDays) || !emptyJournal(execution.hotelAssignments) || !emptyJournal(execution.departures) || Object.hasOwn(execution, 'partialResult')) fail('완료된 basic·일정표만 가진 빈 일차 복구 대상이 아니거나 이미 복구·대사된 실행입니다.');
    const basicStage = record.stages.find(stage => stage.name === 'basic'), shellStage = record.stages.find(stage => stage.name === 'schedule-shell');
    if (basicStage?.status !== 'completed' || shellStage?.status !== 'completed' || !equal(basicStage.result, basic.result) || !equal(shellStage.result, shell.result)) fail('기존 basic·일정표 완료 기록이 실행 저널과 다릅니다.');
    return { target, context: { ...clone(context), executionInputDigest: boundInputDigest }, execution: clone(execution), scopeDigest: currentScopeDigest, recoveryDigest, basic: clone(basic.result), shell: clone(shell.result) };
  }
  async preflightShellRecovery(id, expected = {}) {
    const record = await this._read(id), plan = this._shellRecoveryPlan(record, expected);
    return clone({ id: record.id, version: record.version, requestedScope: record.requestedScope, scopeDigest: plan.scopeDigest, inputDigest: plan.context.executionInputDigest, recoveryDigest: plan.recoveryDigest, target: plan.target, approvalContext: plan.context, execution: this._view(record).execution });
  }
  async claimReconciledShell(id, { scopeDigest: expectedScopeDigest, inputDigest: expectedInputDigest, recoveryDigest: expectedRecoveryDigest, accountName, accountKey, sessionKey, target, basicEvidence, shellEvidence } = {}) {
    basicEvidence = basicEvidence === undefined ? undefined : clone(basicEvidence); shellEvidence = shellEvidence === undefined ? undefined : clone(shellEvidence);
    return this._locked(id, async () => {
      const record = await this._read(id), plan = this._shellRecoveryPlan(record, { scopeDigest: expectedScopeDigest, inputDigest: expectedInputDigest, target });
      if (plan.recoveryDigest !== null && (typeof expectedRecoveryDigest !== 'string' || expectedRecoveryDigest !== plan.recoveryDigest)) fail('이전 일정표 복구 generation digest가 없거나 변경되었습니다. 새 대사 후 다시 시도하세요.');
      if (![accountName, accountKey, sessionKey].every(value => typeof value === 'string' && value) || accountName !== plan.context.accountName || accountKey !== plan.context.accountKey || sessionKey !== plan.context.sessionKey) fail('현재 ERP 계정 또는 로그인 세션이 원래 승인 컨텍스트와 다릅니다.');
      if (!basicEvidence || typeof basicEvidence !== 'object' || !equal(basicEvidence, plan.basic) || !shellEvidence || !equal(shellEvidence, plan.shell)) fail('읽기 전용 basic 또는 일정표 대사 결과가 기존 저장 기록과 다릅니다.');
      const now = this._now(), token = randomBytes(24).toString('hex'), previous = historyWithoutTokens(plan.execution);
      record.execution = { status: 'executing', token, scopeDigest: plan.scopeDigest, claimedAt: now, stages: clone(plan.execution.stages), ...(plan.execution.recovery ? { recovery: clone(plan.execution.recovery) } : {}), shellRecovery: { status: 'shell-read-only-reconciled', recoveredAt: now, target: plan.target, basicEvidence, evidence: shellEvidence, previous } };
      await this._write(record);
      return { token, record: this._view(record) };
    });
  }
  _itineraryRecoveryPlan(record, { scopeDigest: expectedScopeDigest, inputDigest: expectedInputDigest, target } = {}) {
    target = shellRecoveryTarget(target);
    const currentScopeDigest = scopeDigest(record), execution = record.execution, context = record.approvalContext;
    const boundInputDigest = context ? (context.executionInputDigest ?? inputDigest(context.executionInput)) : null;
    if (typeof expectedScopeDigest !== 'string' || expectedScopeDigest !== currentScopeDigest || typeof expectedInputDigest !== 'string' || !context || (context.executionInputDigest !== undefined && context.executionInputDigest !== inputDigest(context.executionInput)) || expectedInputDigest !== boundInputDigest) fail('원래 승인 범위 또는 실행 입력 digest가 변경되었습니다.');
    if (record.requestedScope === 'full' || !record.requestedScope.includes('departures') || record.requestedScope.includes('hotels') || !buildIntake(record.normalized).readyForReview || record.stages.some(stage => stage.requested && !stage.supported)) fail('행사 복구 전 원래 승인 범위가 지원·검증되어야 합니다.');
    if (!record.approval || record.approval.status !== 'approved' || record.approval.version !== record.version || record.approval.scopeDigest !== currentScopeDigest || !Number.isSafeInteger(record.approval.consumedAt ?? execution?.claimedAt)) fail('원래 소비된 승인 기록이 없습니다.');
    if (context.version !== record.version || context.scopeDigest !== currentScopeDigest || ![context.accountName, context.accountKey, context.sessionKey].every(value => typeof value === 'string' && value)) fail('원래 승인 ERP 계정·세션 컨텍스트가 없습니다.');
    const keys = Object.keys(execution?.stages ?? {}).sort(), basic = execution?.stages?.basic, shell = execution?.stages?.['schedule-shell'], itinerary = execution?.stages?.itinerary;
    const dayJournal = execution?.itineraryDays ?? {}, ordered = record.normalized.itinerary.map(day => day.day);
    const receiptsMatch = Array.isArray(itinerary?.result) && itinerary.result.length === ordered.length && Object.keys(dayJournal).length === ordered.length && ordered.every((day, index) => dayJournal[day]?.status === 'completed' && equal(dayJournal[day].result, itinerary.result[index]));
    const recovery = execution?.itineraryRecovery;
    let recoveryDigest = null, validPriorRecovery = recovery === undefined;
    if (recovery !== undefined) {
      try {
        validPriorRecovery = Boolean(recovery && typeof recovery === 'object' && !Array.isArray(recovery) && recovery.status === 'itinerary-read-only-reconciled' && Number.isSafeInteger(recovery.recoveredAt) && equal(shellRecoveryTarget(recovery.target), target) && equal(recovery.basicEvidence, basic?.result) && equal(recovery.shellEvidence, shell?.result) && equal(recovery.evidence, itinerary?.result) && recovery.previous && typeof recovery.previous === 'object' && !Array.isArray(recovery.previous) && equal(recovery.previous, historyWithoutTokens(recovery.previous)));
      } catch { validPriorRecovery = false; }
      if (validPriorRecovery) recoveryDigest = digest(recovery);
    }
    if (execution?.status !== 'needs-reconciliation' || execution.scopeDigest !== currentScopeDigest || !validPriorRecovery || keys.join(',') !== 'basic,itinerary,schedule-shell' || basic?.status !== 'completed' || shell?.status !== 'completed' || itinerary?.status !== 'completed' || basic.result?.productId !== target.productId || basic.result?.masterCode !== target.masterCode || shell.result?.productId !== target.productId || shell.result?.scheduleId !== target.scheduleId || !receiptsMatch || !emptyJournal(execution.hotelAssignments) || !emptyJournal(execution.departures) || Object.hasOwn(execution, 'partialResult')) fail('완료된 basic·일정표·모든 일차만 가진 빈 행사 복구 대상이 아니거나 이미 복구·대사된 실행입니다.');
    const basicStage = record.stages.find(stage => stage.name === 'basic'), shellStage = record.stages.find(stage => stage.name === 'schedule-shell'), itineraryStage = record.stages.find(stage => stage.name === 'itinerary');
    if (basicStage?.status !== 'completed' || shellStage?.status !== 'completed' || itineraryStage?.status !== 'completed' || !equal(basicStage.result, basic.result) || !equal(shellStage.result, shell.result) || !equal(itineraryStage.result, itinerary.result)) fail('기존 basic·일정표·일차 완료 기록이 실행 저널과 다릅니다.');
    return { target, context: { ...clone(context), executionInputDigest: boundInputDigest }, execution: clone(execution), scopeDigest: currentScopeDigest, recoveryDigest, basic: clone(basic.result), shell: clone(shell.result), itinerary: clone(itinerary.result) };
  }
  async preflightItineraryRecovery(id, expected = {}) {
    const record = await this._read(id), plan = this._itineraryRecoveryPlan(record, expected);
    return clone({ id: record.id, version: record.version, requestedScope: record.requestedScope, scopeDigest: plan.scopeDigest, inputDigest: plan.context.executionInputDigest, recoveryDigest: plan.recoveryDigest, target: plan.target, approvalContext: plan.context, execution: this._view(record).execution });
  }
  async claimReconciledItinerary(id, { scopeDigest: expectedScopeDigest, inputDigest: expectedInputDigest, recoveryDigest: expectedRecoveryDigest, accountName, accountKey, sessionKey, target, basicEvidence, shellEvidence, itineraryEvidence } = {}) {
    basicEvidence = basicEvidence === undefined ? undefined : clone(basicEvidence); shellEvidence = shellEvidence === undefined ? undefined : clone(shellEvidence); itineraryEvidence = itineraryEvidence === undefined ? undefined : clone(itineraryEvidence);
    return this._locked(id, async () => {
      const record = await this._read(id), plan = this._itineraryRecoveryPlan(record, { scopeDigest: expectedScopeDigest, inputDigest: expectedInputDigest, target });
      if (plan.recoveryDigest !== null && (typeof expectedRecoveryDigest !== 'string' || expectedRecoveryDigest !== plan.recoveryDigest)) fail('이전 일차 복구 generation digest가 없거나 변경되었습니다. 새 대사 후 다시 시도하세요.');
      if (![accountName, accountKey, sessionKey].every(value => typeof value === 'string' && value) || accountName !== plan.context.accountName || accountKey !== plan.context.accountKey || sessionKey !== plan.context.sessionKey) fail('현재 ERP 계정 또는 로그인 세션이 원래 승인 컨텍스트와 다릅니다.');
      if (!basicEvidence || !equal(basicEvidence, plan.basic) || !shellEvidence || !equal(shellEvidence, plan.shell) || !Array.isArray(itineraryEvidence) || !equal(itineraryEvidence, plan.itinerary)) fail('읽기 전용 basic·일정표 또는 일차 대사 결과가 기존 저장 기록과 다릅니다.');
      const now = this._now(), token = randomBytes(24).toString('hex'), previous = historyWithoutTokens(plan.execution);
      record.execution = { status: 'executing', token, scopeDigest: plan.scopeDigest, claimedAt: now, stages: clone(plan.execution.stages), itineraryDays: clone(plan.execution.itineraryDays), ...(plan.execution.recovery ? { recovery: clone(plan.execution.recovery) } : {}), ...(plan.execution.shellRecovery ? { shellRecovery: clone(plan.execution.shellRecovery) } : {}), itineraryRecovery: { status: 'itinerary-read-only-reconciled', recoveredAt: now, target: plan.target, basicEvidence, shellEvidence, evidence: itineraryEvidence, previous } };
      await this._write(record);
      return { token, record: this._view(record) };
    });
  }
  _finalDepartureRecoveryPlan(record, { scopeDigest: expectedScopeDigest, inputDigest: expectedInputDigest, target } = {}) {
    target = finalDepartureRecoveryTarget(target);
    const currentScopeDigest = scopeDigest(record), execution = record.execution, context = record.approvalContext;
    const boundInputDigest = context ? (context.executionInputDigest ?? inputDigest(context.executionInput)) : null;
    if (typeof expectedScopeDigest !== 'string' || expectedScopeDigest !== currentScopeDigest || typeof expectedInputDigest !== 'string' || !context || (context.executionInputDigest !== undefined && context.executionInputDigest !== inputDigest(context.executionInput)) || expectedInputDigest !== boundInputDigest) fail('원래 승인 범위 또는 실행 입력 digest가 변경되었습니다.');
    if (record.requestedScope === 'full' || !record.requestedScope.includes('departures') || record.requestedScope.includes('hotels') || !buildIntake(record.normalized).readyForReview || record.stages.some(stage => stage.requested && !stage.supported)) fail('최종 행사 복구 전 원래 승인 범위가 지원·검증되어야 합니다.');
    if (!record.approval || record.approval.status !== 'approved' || record.approval.version !== record.version || record.approval.scopeDigest !== currentScopeDigest || !Number.isSafeInteger(record.approval.consumedAt ?? execution?.claimedAt)) fail('원래 소비된 승인 기록이 없습니다.');
    if (context.version !== record.version || context.scopeDigest !== currentScopeDigest || ![context.accountName, context.accountKey, context.sessionKey].every(value => typeof value === 'string' && value)) fail('원래 승인 ERP 계정·세션 컨텍스트가 없습니다.');
    const basic = execution?.stages?.basic, shell = execution?.stages?.['schedule-shell'], itinerary = execution?.stages?.itinerary;
    const ordered = record.normalized.itinerary.map(day => day.day), dayJournal = execution?.itineraryDays ?? {};
    const receiptsMatch = Array.isArray(itinerary?.result) && itinerary.result.length === ordered.length && Object.keys(dayJournal).length === ordered.length && ordered.every((day, index) => dayJournal[day]?.status === 'completed' && equal(dayJournal[day].result, itinerary.result[index]));
    const departures = execution?.departures ?? {}, claim = departures['0'], stageKeys = Object.keys(execution?.stages ?? {}).sort();
    if (execution?.status !== 'needs-reconciliation' || execution.scopeDigest !== currentScopeDigest || record.normalized.departures.length !== 1 || stageKeys.join(',') !== 'basic,itinerary,schedule-shell' || basic?.status !== 'completed' || shell?.status !== 'completed' || itinerary?.status !== 'completed' || basic.result?.productId !== target.productId || basic.result?.masterCode !== target.masterCode || shell.result?.productId !== target.productId || shell.result?.scheduleId !== target.scheduleId || !receiptsMatch || !emptyJournal(execution.hotelAssignments) || Object.keys(departures).length !== 1 || !claim || claim.status !== 'claimed' || !/^[1-9]\d{0,9}$/.test(claim.claimId) || !Number.isSafeInteger(claim.claimedAt) || typeof claim.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(claim.fingerprint) || claim.productId !== target.productId || claim.scheduleId !== target.scheduleId || Object.hasOwn(claim, 'result') || Object.hasOwn(execution, 'partialResult')) fail('완료된 basic·일정표·모든 일차와 index 0의 단일 행사 claim을 가진 최종 대사 대상이 아닙니다.');
    const basicStage = record.stages.find(stage => stage.name === 'basic'), shellStage = record.stages.find(stage => stage.name === 'schedule-shell'), itineraryStage = record.stages.find(stage => stage.name === 'itinerary');
    if (basicStage?.status !== 'completed' || shellStage?.status !== 'completed' || itineraryStage?.status !== 'completed' || !equal(basicStage.result, basic.result) || !equal(shellStage.result, shell.result) || !equal(itineraryStage.result, itinerary.result)) fail('기존 basic·일정표·일차 완료 기록이 실행 저널과 다릅니다.');
    return { target, context: { ...clone(context), executionInputDigest: boundInputDigest }, execution: clone(execution), executionDigest: digest(execution), scopeDigest: currentScopeDigest, basic: clone(basic.result), shell: clone(shell.result), itinerary: clone(itinerary.result) };
  }
  async preflightFinalDepartureRecovery(id, expected = {}) {
    const record = await this._read(id), plan = this._finalDepartureRecoveryPlan(record, expected);
    return clone({ id: record.id, version: record.version, requestedScope: record.requestedScope, scopeDigest: plan.scopeDigest, inputDigest: plan.context.executionInputDigest, executionDigest: plan.executionDigest, target: plan.target, approvalContext: plan.context, basic: plan.basic, shell: plan.shell, itinerary: plan.itinerary, execution: this._view(record).execution });
  }
  async claimReconciledFinalDeparture(id, { scopeDigest: expectedScopeDigest, inputDigest: expectedInputDigest, executionDigest: expectedExecutionDigest, accountName, accountKey, sessionKey, target, evidence } = {}) {
    evidence = evidence === undefined ? undefined : clone(evidence);
    return this._locked(id, async () => {
      const record = await this._read(id), plan = this._finalDepartureRecoveryPlan(record, { scopeDigest: expectedScopeDigest, inputDigest: expectedInputDigest, target });
      if (typeof expectedExecutionDigest !== 'string' || expectedExecutionDigest !== plan.executionDigest) fail('원래 실행 저널 digest가 변경되었습니다. 새 대사 후 다시 시도하세요.');
      if (![accountName, accountKey, sessionKey].every(value => typeof value === 'string' && value) || accountName !== plan.context.accountName || accountKey !== plan.context.accountKey || sessionKey !== plan.context.sessionKey) fail('현재 ERP 계정 또는 로그인 세션이 원래 승인 컨텍스트와 다릅니다.');
      const validProof = evidence?.status === 'departure-persistence-verified' && evidence.productId === plan.target.productId && evidence.eventId === plan.target.eventId && evidence.sourceScheduleId === plan.target.scheduleId && typeof evidence.copiedScheduleId === 'string' && /^[1-9]\d{0,9}$/.test(evidence.copiedScheduleId) && evidence.copiedScheduleId !== plan.target.scheduleId && evidence.url === `https://basecamp.team/tour/product/${plan.target.eventId}/change/` && evidence.canCommit === false;
      if (!validProof) fail('읽기 전용 행사 대사 결과가 원래 상품·일정표·행사 대상과 다릅니다.');
      if (record.normalized.includesFlight === true) {
        const expectedCoverage = flightDepartureCoverage(record.normalized, context.executionInput?.departures, 0), proof = evidence.flightVerification;
        if (proof?.status !== 'flight-persistence-verified' || !equal(proof.coverage, expectedCoverage)) fail('항공 전체 구간의 서버 재조회 근거가 승인 원문과 다릅니다.');
      }
      const now = this._now(), previous = historyWithoutTokens(plan.execution), departures = clone(plan.execution.departures), results = [evidence];
      departures['0'] = { ...departures['0'], status: 'completed', completedAt: now, result: evidence };
      const stages = clone(plan.execution.stages);
      if (record.normalized.includesFlight === true) stages.flight = { status: 'completed', completedAt: now, result: results };
      stages.departure = { status: 'completed', completedAt: now, result: results };
      stages.price = { status: 'completed', completedAt: now, result: results };
      record.execution = { ...historyWithoutTokens(plan.execution), status: 'completed', scopeDigest: plan.scopeDigest, stages, departures, completedAt: now, finalDepartureRecovery: { status: 'final-departure-read-only-reconciled', recoveredAt: now, target: plan.target, evidence, executionDigest: plan.executionDigest, previous } };
      for (const name of record.normalized.includesFlight === true ? ['flight', 'departure', 'price'] : ['departure', 'price']) {
        const stage = record.stages.find(item => item.name === name); stage.status = 'completed'; stage.result = results;
      }
      await this._write(record);
      return { record: this._view(record) };
    });
  }
  async recordItineraryDay(id, token, day, result) {
    if (!Number.isInteger(day) || day < 1 || typeof token !== 'string' || !token || !result || result.day !== day || typeof result.scheduleId !== 'string' || !/^[1-9]\d{0,9}$/.test(result.scheduleId)) fail('일차 저장 결과가 유효하지 않습니다.');
    result = clone(result);
    return this._locked(id, async () => {
      const record = await this._read(id), execution = record.execution;
      if (execution?.status !== 'executing' || execution.token !== token || execution.stages.itinerary) fail('일차 기록 가능한 실행 상태가 아닙니다.');
      const stage = record.stages.find(item => item.name === 'itinerary');
      if (!stage?.requested || !stage.supported) fail('승인 범위 밖의 일차입니다.');
      const ordered = record.normalized.itinerary.map(item => item.day), saved = execution.itineraryDays ?? {};
      if (new Set(ordered).size !== ordered.length || ordered[Object.keys(saved).length] !== day || Object.hasOwn(saved, day)) fail('일차 순서가 다르거나 이미 기록되었습니다.');
      const parentId = execution.stages['schedule-shell']?.result?.scheduleId ?? Object.values(saved)[0]?.result.scheduleId;
      if (parentId && parentId !== result.scheduleId) fail('승인 실행의 일정표 ID가 다릅니다.');
      saved[day] = {status: 'completed', completedAt: this._now(), result};
      execution.itineraryDays = saved;
      return this._write(record);
    });
  }
  async claimDeparture(id, token, index, inputCandidate) {
    const candidate=clone(inputCandidate);
    if (!Number.isSafeInteger(index)||index<0||typeof token!=='string'||!token) fail('잘못된 행사 claim입니다.');
    return this._locked(id,async()=>{
      const record=await this._read(id), execution=record.execution;
      if (execution?.status!=='executing'||execution.token!==token||execution.stages.departure) fail('행사 claim 가능한 실행 상태가 아닙니다.');
      if (!record.stages.some(s=>s.name==='departure'&&s.requested&&s.supported)) fail('승인 범위 밖의 행사입니다.');
      const saved=execution.departures??{}, basic=execution.stages.basic?.result, shell=execution.stages['schedule-shell']?.result;
      if (!basic||!shell||!execution.stages.itinerary||index>=record.normalized.departures.length||Object.keys(saved).length!==index||Object.values(saved).some(x=>x.status!=='completed')) fail('행사 순서 또는 선행 저장 결과가 다릅니다.');
      const context=record.approvalContext;
      const target={productId:basic.productId,masterCode:basic.masterCode,title:record.normalized.title,account:context.accountName};
      const options={...context.executionInput.departures,savedScheduleId:shell.scheduleId,expectedAccountName:context.accountName};
      const source={index,product:record.normalized,options,target};
      const {fingerprint,...packet}=candidate;
      if (candidate.status!=='prepared-only'||candidate.canCommit!==false||candidate.sourceDepartureIndex!==index||digest(source)!==digest(candidate.source)||fingerprint!==digest(packet)||candidate.contract?.productId!==basic.productId||candidate.contract?.sourceScheduleId!==shell.scheduleId||candidate.contract?.departureDate!==record.normalized.departures[index].startDate||candidate.contract?.account!==context.accountName) fail('행사 후보가 부모 승인·저장 결과와 다릅니다.');
      const claimId=String(index+1);
      saved[index]={status:'claimed',claimId,claimedAt:this._now(),fingerprint,productId:basic.productId,scheduleId:shell.scheduleId};
      execution.departures=saved;await this._write(record);
      return {status:'claimed',claimId};
    });
  }
  async recordDeparture(id,token,index,inputResult) {
    const result=clone(inputResult);
    if (!Number.isSafeInteger(index)||index<0||typeof token!=='string'||!token) fail('잘못된 행사 기록입니다.');
    return this._locked(id,async()=>{
      const record=await this._read(id),execution=record.execution,saved=execution?.departures?.[index];
      if (execution?.status!=='executing'||execution.token!==token||saved?.status!=='claimed') fail('claim된 행사만 기록할 수 있습니다.');
      if (result?.status!=='departure-persistence-verified'||result.productId!==saved.productId||result.sourceScheduleId!==saved.scheduleId||typeof result.eventId!=='string'||! /^[1-9]\d{0,9}$/.test(result.eventId)||typeof result.copiedScheduleId!=='string'||! /^[1-9]\d{0,9}$/.test(result.copiedScheduleId)||result.copiedScheduleId===saved.scheduleId||result.url!==`https://basecamp.team/tour/product/${result.eventId}/change/`||Object.values(execution.departures).some(item=>item.result?.eventId===result.eventId)) fail('행사 서버 재조회 결과가 승인 대상과 다릅니다.');
      if (record.normalized.includesFlight === true) {
        const proof=result.flightVerification;
        const expected=flightDepartureCoverage(record.normalized,record.approvalContext.executionInput.departures,index);
        if (proof?.status!=='flight-persistence-verified'||digest(proof.coverage)!==digest(expected)) fail('항공 전체 구간의 서버 재조회 근거가 승인 원문과 다릅니다.');
      }
      saved.status='completed';saved.completedAt=this._now();saved.result=result;
      return this._write(record);
    });
  }
  async recordHotelAssignment(id, token, index, inputResult) {
    const result = clone(inputResult);
    if (!Number.isSafeInteger(index) || index < 0 || typeof token !== 'string' || !token) fail('잘못된 호텔 기록입니다.');
    return this._locked(id, async () => {
      const record = await this._read(id), execution = record.execution;
      if (execution?.status !== 'executing' || execution.token !== token || execution.stages.hotel) fail('호텔 기록 가능한 실행 상태가 아닙니다.');
      const stage = record.stages.find(item => item.name === 'hotel');
      if (!stage?.requested || !stage.supported) fail('승인 범위 밖의 호텔입니다.');
      const assignments = hotelAssignments(record.normalized, record.approvalContext?.executionInput?.hotels);
      const saved = execution.hotelAssignments ?? {}, assignment = assignments[index];
      const basic = execution.stages.basic?.result, shell = execution.stages['schedule-shell']?.result;
      if (!assignment || !basic || !shell || !execution.stages.itinerary || Object.keys(saved).length !== index || Object.hasOwn(saved, index)) fail('호텔 순서 또는 선행 저장 결과가 다릅니다.');
      if (result?.status !== 'hotel-assignment-persisted' || result.productId !== basic.productId || result.scheduleId !== shell.scheduleId || result.day !== assignment.day || !Array.isArray(result.hotelIds) || result.hotelIds.some(hotelId => typeof hotelId !== 'string' || !/^[1-9]\d{0,9}$/.test(hotelId)) || !result.hotelIds.includes(assignment.catalog.id) || !Number.isSafeInteger(result.guardedPosts) || result.guardedPosts !== 1 || (assignment.confirm && result.confirmedHotelId !== assignment.catalog.id) || (!assignment.confirm && result.confirmedHotelId !== null && (!/^[1-9]\d{0,9}$/.test(result.confirmedHotelId) || !result.hotelIds.includes(result.confirmedHotelId)))) fail('호텔 저장 결과가 승인된 상품·일정표·일차·카탈로그와 다릅니다.');
      saved[index] = { status: 'completed', completedAt: this._now(), productId: basic.productId, scheduleId: shell.scheduleId, day: assignment.day, hotelId: assignment.catalog.id, result };
      execution.hotelAssignments = saved;
      return this._write(record);
    });
  }
  async recordStage(id, token, stage, result) {
    if (!['basic', 'schedule-shell', 'itinerary', 'hotel', 'flight', 'departure', 'price'].includes(stage) || typeof token !== 'string' || !token) fail('잘못된 실행 단계입니다.');
    result = clone(result);
    return this._locked(id, async () => {
      const record = await this._read(id); if (record.execution?.status !== 'executing' || record.execution.token !== token || record.execution.stages[stage]) fail('실행 단계가 이미 기록되었거나 유효하지 않습니다.');
      const item = record.stages.find(value => value.name === stage);
      if (!item?.requested || !item.supported) fail('승인 범위 밖의 실행 단계입니다.');
      if (stage === 'itinerary') {
        const days = record.normalized.itinerary, saved = record.execution.itineraryDays ?? {};
        if (!Array.isArray(result) || result.length !== days.length || Object.keys(saved).length !== days.length || days.some((day, index) => !saved[day.day] || digest(saved[day.day].result) !== digest(result[index]))) fail('모든 일차의 저장 기록과 완료 결과가 일치해야 합니다.');
      }
      if (stage === 'hotel') {
        const assignments = hotelAssignments(record.normalized, record.approvalContext?.executionInput?.hotels), saved = record.execution.hotelAssignments ?? {};
        if (!Array.isArray(result) || result.length !== assignments.length || Object.keys(saved).length !== assignments.length || result.some((value, index) => saved[index]?.status !== 'completed' || digest(saved[index].result) !== digest(value))) fail('모든 호텔의 저장 기록과 완료 결과가 일치해야 합니다.');
      }
      if (['flight','departure','price'].includes(stage)) {
        const saved=record.execution.departures??{}, count=record.normalized.departures.length;
        if (!Array.isArray(result)||result.length!==count||Object.keys(saved).length!==count||result.some((value,index)=>saved[index]?.status!=='completed'||digest(saved[index].result)!==digest(value))) fail('모든 행사·가격의 저장 기록과 완료 결과가 일치해야 합니다.');
        if (stage==='price'&&!record.execution.stages.departure) fail('행사 완료 기록이 먼저 필요합니다.');
      }
      record.execution.stages[stage] = { status: 'completed', completedAt: this._now(), result };
      item.status = 'completed'; item.result = result;
      return this._write(record);
    });
  }
  async finishExecution(id, token) {
    return this._locked(id, async () => {
      const record = await this._read(id); if (record.execution?.status !== 'executing' || record.execution.token !== token) fail('실행 완료 상태가 유효하지 않습니다.');
      if (record.stages.some(stage => stage.requested && (!stage.supported || record.execution.stages[stage.name]?.status !== 'completed'))) fail('요청한 모든 단계가 완료되지 않았습니다.');
      record.execution.status = 'completed'; record.execution.completedAt = this._now(); return this._write(record);
    });
  }
  async failExecution(id, token, message, partialResult) {
    if (typeof message !== 'string' || !message.trim() || message.length > 4096) fail('실행 오류 메시지가 필요합니다.');
    if (partialResult !== undefined) partialResult = clone(partialResult);
    return this._locked(id, async () => {
      const record = await this._read(id); if (record.execution?.status !== 'executing' || record.execution.token !== token) return this._view(record);
      record.execution.status = 'needs-reconciliation'; record.execution.failedAt = this._now(); record.execution.message = message; if (partialResult !== undefined) record.execution.partialResult = partialResult;
      return this._write(record);
    });
  }
}
