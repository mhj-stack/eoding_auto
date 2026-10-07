import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { digest } from './core.mjs';

const HEX = /^[a-f0-9]{64}$/;
const NUMERIC_ID = /^[1-9]\d{0,9}$/;
const SCOPE = Object.freeze(['display-images']);
const fail = message => { throw new Error(message); };
const clone = value => structuredClone(value);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const exactScope = value => Array.isArray(value) && value.length === 1 && value[0] === SCOPE[0];
const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 4096;

function frozen(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}

function nativeTuples(value) {
  if (!Array.isArray(value) || !value.length) fail('Invalid display-image review boundary');
  const names = new Set();
  for (const tuple of value) {
    if (!Array.isArray(tuple) || tuple.length !== 2 || typeof tuple[0] !== 'string' || typeof tuple[1] !== 'string'
      || !tuple[0] || /[\r\n\0]/.test(tuple[0]) || tuple[0].toLowerCase().includes('csrf') || names.has(tuple[0])) fail('Invalid display-image review boundary');
    names.add(tuple[0]);
  }
  return value;
}

function imageSort(value, imageIds) {
  let parsed;
  try { parsed = JSON.parse(value); } catch { fail('Invalid display-image review boundary'); }
  if (!isPlainObject(parsed) || Object.keys(parsed).length !== 1 || !Object.hasOwn(parsed, 'images') || !Array.isArray(parsed.images)
    || !parsed.images.length || parsed.images.some(id => typeof id !== 'string' || !NUMERIC_ID.test(id))
    || parsed.images.length !== imageIds.length || parsed.images.some((id, index) => id !== imageIds[index])) fail('Invalid display-image review boundary');
}

function validatePlan(plan) {
  if (!isPlainObject(plan) || !isPlainObject(plan.target) || Object.keys(plan.target).length !== 2
    || !Object.hasOwn(plan.target, 'productId') || !Object.hasOwn(plan.target, 'masterCode')
    || typeof plan.target.productId !== 'string' || !NUMERIC_ID.test(plan.target.productId) || !nonempty(plan.target.masterCode)
    || typeof plan.companyId !== 'string' || !NUMERIC_ID.test(plan.companyId) || !nonempty(plan.accountName) || !exactScope(plan.scope)
    || plan.eventCreation !== false || !HEX.test(plan.codeDigest ?? '')) fail('Invalid display-image review boundary');
}

function validatePrepared(prepared, plan) {
  if (!isPlainObject(prepared) || !HEX.test(prepared.identityDigest ?? '') || !isPlainObject(prepared.target)
    || prepared.target.productId !== plan.target.productId || prepared.target.masterCode !== plan.target.masterCode
    || prepared.companyId !== plan.companyId || prepared.accountName !== plan.accountName || !Array.isArray(prepared.images)
    || prepared.images.length < 1 || prepared.images.length > 20) fail('Invalid display-image review boundary');
  const before = nativeTuples(prepared.before), after = nativeTuples(prepared.after);
  const beforeMap = new Map(before), afterMap = new Map(after);
  if (beforeMap.size !== afterMap.size || !beforeMap.has('image_sort') || !afterMap.has('image_sort')
    || [...beforeMap].some(([name, value]) => name !== 'image_sort' && afterMap.get(name) !== value)) fail('Invalid display-image review boundary');
  const ids = prepared.images.map(image => {
    if (!isPlainObject(image) || !nonempty(image.path) || !HEX.test(image.sha256 ?? '') || typeof image.id !== 'string' || !NUMERIC_ID.test(image.id ?? '')
      || !nonempty(image.src) || !nonempty(image.alt)) fail('Invalid display-image review boundary');
    let url; try { url = new URL(image.src); } catch { fail('Invalid display-image review boundary'); }
    if (url.protocol !== 'https:' || url.hostname !== 'media.eoding.com' || url.port || url.username || url.password || url.search || url.hash || !url.pathname.startsWith(`/media/travelagent/${plan.companyId}/imagecontent/`) || url.pathname.slice(`/media/travelagent/${plan.companyId}/imagecontent/`.length).includes('/')) fail('Invalid display-image review boundary');
    return image.id;
  });
  if (new Set(ids).size !== ids.length) fail('Invalid display-image review boundary');
  imageSort(afterMap.get('image_sort'), ids);
}

/** Local-only durable approval journal for one existing product's display-image ordering. */
export class DisplayImageReviewStore {
  constructor({ root, plan, prepared } = {}) {
    if (!nonempty(root)) fail('Invalid display-image review boundary');
    validatePlan(plan);
    validatePrepared(prepared, plan);
    this.root = root;
    this.plan = frozen(clone(plan));
    this.prepared = frozen(clone(prepared));
    this.bindingDigest = digest({ plan: this.plan, prepared: this.prepared });
    this.state = {
      id: `display-images-${this.plan.target.productId}`,
      version: 1,
      scopeDigest: this.bindingDigest,
      requestedScope: SCOPE,
      approval: { status: 'pending' },
      execution: null
    };
    this.approvalRecord = null;
  }

  _current() {
    validatePlan(this.plan);
    validatePrepared(this.prepared, this.plan);
    if (digest({ plan: this.plan, prepared: this.prepared }) !== this.bindingDigest
      || this.state.id !== `display-images-${this.plan.target.productId}` || this.state.version !== 1
      || this.state.scopeDigest !== this.bindingDigest || !exactScope(this.state.requestedScope)) fail('Reviewed display-image plan changed');
  }

  async _ensureRoot() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
  }

  async get() {
    this._current();
    return clone({ ...this.state, plan: this.plan, prepared: this.prepared });
  }

  async approve(id, input) {
    this._current();
    const state = this.state;
    if (id !== state.id || state.approval.status !== 'pending' || !isPlainObject(input)
      || input.tenantObserved !== this.plan.companyId || input.accountObserved !== this.plan.accountName
      || input.expectedVersion !== state.version || input.expectedScopeDigest !== state.scopeDigest || !exactScope(input.scope)
      || !Number.isSafeInteger(input.deadline) || Date.now() >= input.deadline) fail('Human approval identity, scope, version, digest or deadline changed');
    const record = frozen({
      id,
      scopeDigest: state.scopeDigest,
      planDigest: digest(this.plan),
      preparedDigest: digest(this.prepared),
      codeDigest: this.plan.codeDigest,
      identityDigest: this.prepared.identityDigest,
      formDigest: digest(this.prepared.after),
      target: clone(this.plan.target),
      input: clone(input)
    });
    await this._ensureRoot();
    await writeFile(path.join(this.root, 'approval.json'), JSON.stringify(record, null, 2), { flag: 'wx', mode: 0o600 });
    this.approvalRecord = record;
    state.approval = { status: 'approved', deadline: input.deadline };
    return this.get();
  }

  async claim() {
    this._current();
    const state = this.state;
    if (state.approval.status === 'consumed') fail('Already claimed');
    if (state.approval.status !== 'approved' || !Number.isSafeInteger(state.approval.deadline) || Date.now() >= state.approval.deadline) fail('Human approval required or expired');
    let persisted;
    try { persisted = JSON.parse(await readFile(path.join(this.root, 'approval.json'), 'utf8')); }
    catch { fail('Approval receipt is unavailable'); }
    if (!this.approvalRecord || digest(persisted) !== digest(this.approvalRecord)) fail('Approval receipt or reviewed plan changed');
    const claim = frozen({
      approvalDigest: digest(persisted),
      identityDigest: this.prepared.identityDigest,
      preparedDigest: digest(this.prepared),
      formDigest: digest(this.prepared.after),
      target: clone(this.plan.target),
      scopeDigest: state.scopeDigest,
      deadline: state.approval.deadline
    });
    await writeFile(path.join(this.root, 'claim.json'), JSON.stringify(claim, null, 2), { flag: 'wx', mode: 0o600 });
    state.approval = { status: 'consumed', deadline: state.approval.deadline };
    state.execution = { status: 'executing' };
    return clone(claim);
  }

  async cancelUnclaimed() {
    if (this.state.approval.status !== 'consumed') this.state.approval = { status: 'cancelled' };
    return this.get();
  }
}

/** Renders the loopback-only human approval page; it never posts to ERP. */
export function renderDisplayImageReview(session, csrf, message = '') {
  const plan = session.plan, prepared = session.prepared;
  const approval = session.approval?.status === 'pending'
    ? `<form method="post" action="/approve"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="version" value="${esc(session.version)}"><input type="hidden" name="scope_hash" value="${esc(session.scopeDigest)}"><input type="hidden" name="scope" value="display-images"><label>회사 ID<input name="company" value="${esc(plan.companyId)}" readonly required></label><label>계정명<input name="account" value="${esc(plan.accountName)}" readonly required></label><button type="submit">기본전시 이미지 연결·저장</button></form>`
    : `<p>승인 상태: ${esc(session.approval?.status ?? 'unknown')}</p>`;
  const execution = session.execution ? `<p>실행 상태: ${esc(session.execution.status ?? 'unknown')}</p>` : '<p>실행 상태: 아직 저장하지 않았습니다.</p>';
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>기본전시 이미지 연결 검토</title><style>body{font:16px/1.7 system-ui,sans-serif;max-width:800px;margin:24px auto;padding:0 20px;color:#172b4d}section{border:1px solid #dce3ed;border-radius:10px;padding:18px;margin:14px 0}dl{display:grid;grid-template-columns:max-content 1fr;gap:6px 14px}dt{font-weight:700}dd{margin:0}input{display:block;padding:8px;width:min(26rem,100%)}button{margin-top:12px;font:inherit;background:#1769e0;color:#fff;border:0;border-radius:8px;padding:14px 20px}</style><h1>기본전시 이미지 ${prepared.images.length}장만 연결</h1><section><h2>대상</h2><dl><dt>상품 번호</dt><dd>${esc(plan.target.productId)}</dd><dt>마스터 코드</dt><dd>${esc(plan.target.masterCode)}</dd><dt>회사 ID</dt><dd>${esc(plan.companyId)}</dd><dt>계정명</dt><dd>${esc(plan.accountName)}</dd></dl><p>기존 행사는 변경하지 않습니다. 새 상품·행사 생성도 하지 않습니다.</p></section><section><h2>연결할 이미지</h2><ol>${prepared.images.map((image, index) => `<li>${esc(image.alt)} <code>${esc(image.id)}</code></li>`).join('')}</ol><p>기존 이미지 파일을 재사용하며, 표시된 순서로 연결합니다.</p></section><section><h2>연결 내용 확인 및 저장 승인</h2><p>승인하면 표시된 상품의 기본전시 이미지 연결만 저장하고 다시 조회합니다. 상품 설명·일정·시즌·기존 행사는 변경하지 않습니다.</p>${approval}${execution}${message ? `<p>${esc(message)}</p>` : ''}</section></html>`;
}
