import { startProductReviewUI } from './product-review-ui.mjs';

export const PRODUCT_ONLY_REVIEW_SCOPE = Object.freeze(['basic', 'display', 'content', 'shell', 'days', 'season']);

const clone = value => structuredClone(value);
const fail = message => { throw new Error(message); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, name) => {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) fail(`${name} must be a nonempty trimmed string`);
  return value;
};
const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
const money = value => Number.isFinite(Number(value)) ? new Intl.NumberFormat('ko-KR').format(Number(value)) : '미입력';
const valueText = value => typeof value === 'string' && value.trim() ? value : '미입력';
const scopeFor = plan => PRODUCT_ONLY_REVIEW_SCOPE.filter(phase => phase !== 'season' || plan.seasonMode !== 'excluded');
const exactScope = (scope, plan) => {
  const expected = scopeFor(plan);
  return Array.isArray(scope) && scope.length === expected.length && scope.every((value, index) => value === expected[index]);
};

function scopeRows(plan) {
  const options = plan.basic.options;
  return [
    ['기본정보', 'basic', `도시 ${options.cityLabel}; 담당 ${options.managerLabel}; 우선순위 ${options.priority}; 예약마감 ${options.cutoffDays}일; 비공개`],
    ['표시·상세·참조', 'display, content', `표시 필드 ${Object.keys(plan.display.fields).join(', ') || '없음'}; 이미지 ${plan.source.images.length}장`],
    ['일정', 'shell, days', `${plan.shell.title}; ${plan.itinerary.length}일 전체 일정과 식사`],
    ...(plan.seasonMode === 'excluded' ? [] : [['시즌·항공', 'season', `${plan.season.selectedDates.join(', ')}; 선택 운임과 시즌 입력만`]])
  ];
}

function priceRows(product) {
  const departures = Array.isArray(product.departures) ? product.departures : [];
  if (!departures.length) return '<tr><td colspan="4">출발 선택이 없습니다.</td></tr>';
  return departures.map((departure, index) => {
    const selected = departure.prices?.[departure.selectedPrice];
    const values = ['adult', 'child', 'infant'].map(kind => selected?.[kind]
      ? `${kind}: ${escapeHtml(selected[kind].currency)} ${money(selected[kind].amount)}`
      : `${kind}: 미입력`).join('<br>');
    return `<tr><td>${index + 1}</td><td>${escapeHtml(departure.startDate)} ~ ${escapeHtml(departure.endDate)}</td><td>${values}</td><td>${escapeHtml(departure.bookingStatus ?? '미입력')}</td></tr>`;
  }).join('');
}

function itineraryRows(days) {
  if (!Array.isArray(days) || !days.length) return '<tr><td colspan="4">일정이 없습니다.</td></tr>';
  return days.map(day => `<tr><td>${escapeHtml(day.day)}</td><td>${escapeHtml(day.title)}</td><td>${escapeHtml(day.description)}</td><td>${escapeHtml(['breakfast', 'lunch', 'dinner'].map(kind => day.meals?.[kind] ?? '미입력').join(' / '))}</td></tr>`).join('');
}

function seasonPriceRows(season) {
  const fields = season.fields ?? {};
  return ['adult', 'child', 'infant'].map(kind => {
    const base = fields[`${kind}_base_price`], fuel = fields[`${kind}_fuel_price`];
    const total = Number(base) + Number(fuel);
    return `<tr><td>${escapeHtml(kind)}</td><td>${money(base)}</td><td>${money(fuel)}</td><td>${money(total)}</td></tr>`;
  }).join('');
}

function flightRows(season) {
  const fields = season.fields ?? {}, labels = season.selectLabels ?? {};
  const leg = (name, prefix) => `<tr><td>${name}</td><td>${escapeHtml(valueText(fields[`${prefix}-0-flight_no`]))}</td><td>${escapeHtml(valueText(labels[`${prefix}-0-airline`]))}</td><td>${escapeHtml(valueText(labels[`${prefix}-0-depart_cd`]))}</td><td>${escapeHtml(valueText(labels[`${prefix}-0-arrive_cd`]))}</td><td>${escapeHtml(valueText(fields[`${prefix}-0-depart_date`]))} ${escapeHtml(valueText(fields[`${prefix}-0-depart_time`]))}</td><td>${escapeHtml(valueText(fields[`${prefix}-0-arrive_time`]))}</td></tr>`;
  return `${leg('출국', 'depart')}${leg('귀국', 'arrive')}`;
}

function itemRows(items) {
  if (!Array.isArray(items) || !items.length) return '<li>없음</li>';
  return items.map(item => `<li><strong>${escapeHtml(item?.name ?? item)}</strong>${item?.description ? `<br>${escapeHtml(item.description)}` : ''}</li>`).join('');
}

function actualContent(plan) {
  const detail = plan.content.detail ?? {}, fields = plan.display.fields ?? {};
  const elements = Array.isArray(plan.content.elements) ? plan.content.elements : [];
  return `<details><summary>승인된 설명·포함/불포함·취소 규정 보기</summary>
    <h3>상품 설명</h3><p>${escapeHtml(valueText(fields.product_description))}</p>
    <h3>포함</h3><ul>${itemRows(detail.include)}</ul>
    <h3>불포함</h3><ul>${itemRows(detail.exclude)}</ul>
    <h3>안내·취소 규정 원문</h3>${elements.length ? elements.map(element => `<section><p>${escapeHtml(valueText(element.text))}</p></section>`).join('') : `<p>${escapeHtml(valueText(detail.cancellation))}</p>`}
  </details>`;
}

/** Renderer supplied to the existing hardened loopback review server. It never creates approval itself. */
export function renderProductOnlyReview(session, csrf, message = '', executes = false) {
  if (!plain(session?.approvalContext?.executionInput)) fail('Review session has no bound product-only plan');
  const plan = session.approvalContext.executionInput;
  const seasonExcluded = plan.seasonMode === 'excluded';
  if (!plain(plan.product) || !plain(plan.basic?.options) || !Array.isArray(plan.itinerary) || !Array.isArray(plan.source?.images) || (seasonExcluded ? Object.hasOwn(plan, 'season') : !plain(plan.season))) fail('Review plan is incomplete');
  if (!exactScope(session.requestedScope, plan)) fail('Review session scope is not the frozen product-only scope');
  const product = plan.product, identity = plan.identity ?? {}, approval = session.approval;
  const tenant = text(String(product.company?.tenant ?? ''), 'product company tenant');
  const account = text(identity.accountName, 'approved account');
  const form = approval?.status === 'approved'
    ? '<p><strong>승인과 실행 claim이 기록되었습니다.</strong> 같은 계획과 데이터로 다시 시작할 수 없습니다.</p>'
    : approval?.status === 'cancelled'
      ? '<p class="warn"><strong>이 검토는 취소되었거나 만료되었습니다.</strong> 새 승인이나 실행을 시작할 수 없습니다.</p>'
      : `<form method="post" action="/approve"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="version" value="${escapeHtml(session.version)}"><input type="hidden" name="scope_hash" value="${escapeHtml(session.scopeDigest)}"><input type="hidden" name="scope" value="${session.requestedScope.join(',')}"><label>ERP에서 직접 확인한 회사/테넌트<input name="company" autocomplete="off" required></label><label>ERP에서 직접 확인한 계정명<input name="account" autocomplete="off" required></label><button type="submit">사람이 확인한 범위로 1회 등록 시작</button></form>`;
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>상품 등록 최종 검토</title><style>body{font:15px/1.55 system-ui,sans-serif;max-width:1080px;margin:24px auto;padding:0 20px;color:#17212b}section,details{border:1px solid #cbd5e1;border-radius:10px;padding:16px;margin:14px 0}table{border-collapse:collapse;width:100%}td,th{border:1px solid #cbd5e1;padding:8px;text-align:left;vertical-align:top}input{display:block;width:min(32rem,100%);padding:8px;margin:5px 0 12px}button{background:#155e75;color:white;border:0;border-radius:7px;padding:12px 16px;font:600 15px system-ui}.warn{color:#8a2d0b}.scope{font-size:.92rem;color:#334155}code{overflow-wrap:anywhere}</style><body>
    <h1>상품 등록 최종 검토</h1>
    <section><h2>승인에 묶인 대상</h2><p><strong>${escapeHtml(product.title)}</strong> · ${escapeHtml((product.destinations ?? []).join(' · '))}<br>${escapeHtml(product.nights)}박 ${escapeHtml(product.days)}일 · ${escapeHtml(product.currency)} · VAT: <strong>${escapeHtml(valueText(product.company?.vat))}</strong></p><p>ERP 회사/테넌트: <strong>${escapeHtml(tenant)}</strong><br>승인 계정: <strong>${escapeHtml(account)}</strong><br>계획 SHA-256: <code>${escapeHtml(session.planDigest)}</code><br>범위 SHA-256: <code>${escapeHtml(session.scopeDigest)}</code></p><p><strong>상태는 비공개입니다.</strong> 판매 시작·공개·발행은 이 실행 범위에 없습니다.</p></section>
    <section><h2>실행 범위와 기본 운영 옵션</h2><table><tr><th>영역</th><th>범위</th><th>승인 값</th></tr>${scopeRows(plan).map(item => `<tr><td>${escapeHtml(item[0])}</td><td>${escapeHtml(item[1])}</td><td>${escapeHtml(item[2])}</td></tr>`).join('')}</table></section>
    <section><h2>공급사 상품·선택 가격</h2><table><tr><th>#</th><th>기간</th><th>선택 가격</th><th>예약 상태</th></tr>${priceRows(product)}</table></section>
    ${seasonExcluded ? '<section><h2>시즌 제외</h2><p>시즌을 저장하지 않으며 최종 독립 조회로 시즌 0건을 확인합니다.</p></section>' : `<section><h2>시즌 금액·인원·항공</h2><p>시즌명: <strong>${escapeHtml(valueText(plan.season.fields?.title))}</strong> · 출발지: <strong>${escapeHtml(valueText(plan.season.selectLabels?.departport))}</strong> · 선택일: <strong>${escapeHtml(plan.season.selectedDates.join(', '))}</strong><br>최소/최대 인원: <strong>${escapeHtml(valueText(plan.season.fields?.min_pax_count))} / ${escapeHtml(valueText(plan.season.fields?.max_pax_count))}</strong></p><h3>기본가 + 유류할증</h3><table><tr><th>구분</th><th>기본가</th><th>유류할증</th><th>합계</th></tr>${seasonPriceRows(plan.season)}</table><h3>현지 시각 항공편</h3><table><tr><th>구간</th><th>편명</th><th>항공사</th><th>출발 공항</th><th>도착 공항</th><th>출발 현지일시</th><th>도착 현지시각</th></tr>${flightRows(plan.season)}</table></section>`}
    <section><h2>${plan.itinerary.length}일 전체 일정과 식사</h2><table><tr><th>일차</th><th>제목</th><th>내용</th><th>식사</th></tr>${itineraryRows(plan.itinerary)}</table></section>
    <details open><summary>이미지·콘텐츠·호텔 후보 (${plan.source.images.length}장)</summary><p>모든 이미지는 승인된 로컬 경로, SHA-256, MIME과 일치해야 하고 업로드 뒤 공개 CDN에서 테넌트와 SHA-256을 다시 검증합니다.</p><p>호텔 후보: ${escapeHtml((product.hotels ?? []).map(hotel => hotel?.name ?? hotel).join(' / ') || '없음')}</p><p><strong>호텔 배정은 이 실행에서 비활성화되어 있습니다.</strong></p>${actualContent(plan)}</details>
    <section class="warn"><h2>제외·안전 작업</h2><p><strong>행사 생성·행사 연결·호텔 배정은 제외됩니다.</strong> 판매 채널, 공개, 발행, 취소/환불 설정도 실행하지 않습니다. 저장 결과가 불명확하면 자동 재시도하지 않고 조정(reconciliation) 상태로 종료합니다.</p><p>사람 승인 경고: 아래 버튼은 localhost 검토 페이지에서 사람이 직접 눌러야 합니다. CLI 자동승인이나 자동 재시작은 없고, 계획·계정·옵션·이미지 바이트가 바뀌면 차단됩니다.</p></section>
    <section><h2>회사·계정 직접 확인과 1회 승인</h2><p>${executes ? `승인 뒤 하나의 브라우저/페이지에서 기본정보, 표시·상세, 일정 전체${seasonExcluded ? '를' : ', 시즌을'} 저장하고 최종 독립 GET으로 다시 확인합니다.` : '이 화면은 검토 전용입니다.'}</p>${form}${message ? `<p class="warn">${escapeHtml(message)}</p>` : ''}</section>
  </body></html>`;
}

/** Small state bridge for startProductReviewUI. Durable callbacks own journal writes. */
export class ProductOnlyReviewStore {
  constructor({ plan, sourceLabel, sourceDigest, onApprove, onCancel, onClaim, onReconcile, beforeClaim = async () => {}, clock = () => Date.now() } = {}) {
    if (!plain(plan) || !plain(plan.approvalBinding) || typeof onApprove !== 'function' || typeof onCancel !== 'function' || typeof onClaim !== 'function' || typeof onReconcile !== 'function' || typeof beforeClaim !== 'function') fail('Bound plan and durable review callbacks are required');
    this.plan = clone(plan);
    this.clock = clock;
    this.onApprove = onApprove;
    this.onCancel = onCancel;
    this.onClaim = onClaim;
    this.onReconcile = onReconcile;
    this.beforeClaim = beforeClaim;
    this.state = {
      id: plan.approvalBinding.planDigest,
      version: 1,
      source: { label: text(sourceLabel, 'source label'), digest: text(sourceDigest, 'source digest') },
      normalized: clone(plan.product),
      requestedScope: scopeFor(plan),
      scopeDigest: plan.approvalBinding.scopeDigest,
      planDigest: plan.approvalBinding.planDigest,
      approvalContext: { executionInput: clone(plan) },
      intake: { questions: [], invalidInputs: [] },
      approval: null,
      execution: null
    };
  }

  async get(id) {
    if (id !== this.state.id) fail('Unknown product-only review session');
    return clone(this.state);
  }

  async approve(id, { tenantObserved, accountObserved, expectedVersion, expectedScopeDigest, scope, deadline } = {}) {
    if (id !== this.state.id || this.state.approval || this.state.execution) fail('Review approval is already used or unavailable');
    const now = this.clock(), expectedTenant = String(this.plan.product.company?.tenant ?? ''), expectedAccount = this.plan.identity?.accountName;
    if (!Number.isSafeInteger(deadline) || now >= deadline) fail('Review approval has expired');
    if (expectedVersion !== this.state.version || expectedScopeDigest !== this.state.scopeDigest || !exactScope(scope, this.plan)) fail('Reviewed plan version or scope changed');
    if (tenantObserved !== expectedTenant || accountObserved !== expectedAccount) fail('Directly observed company/tenant or account differs from the approved identity');
    const approval = { status: 'approved', version: this.state.version, scopeDigest: this.state.scopeDigest, planDigest: this.state.planDigest, tenantObserved, accountObserved, approvedAt: now, expiresAt: deadline, method: 'localhost-human-form' };
    await this.onApprove(clone(approval));
    this.state.approval = approval;
    return this.get(id);
  }

  async claim(request) {
    const approval = this.state.approval;
    if (!approval || approval.status !== 'approved' || this.clock() >= approval.expiresAt || this.state.execution || request?.planDigest !== this.state.planDigest || request?.scopeDigest !== this.state.scopeDigest || JSON.stringify(request?.target) !== JSON.stringify({ mode: 'NEW' })) fail('Approval is absent, expired, changed, or already consumed');
    await this.beforeClaim(clone(request));
    if (this.state.approval !== approval || approval.status !== 'approved' || this.clock() >= approval.expiresAt || this.state.execution) fail('Approval is expired, changed, or already consumed');
    const claim = { id: `product-only:${this.state.planDigest}`, target: { mode: 'NEW' }, planDigest: this.state.planDigest, scopeDigest: this.state.scopeDigest, claimedAt: this.clock() };
    await this.onClaim(clone(claim));
    this.state.approval = { ...approval, status: 'consumed', consumedAt: claim.claimedAt };
    this.state.execution = { status: 'executing', claim: clone(claim) };
    return clone(claim);
  }

  async completed(result) {
    if (this.state.execution?.status !== 'executing') fail('Cannot finish an unclaimed product-only review');
    this.state.execution = { status: 'completed', result: clone(result), completedAt: this.clock() };
    return this.get(this.state.id);
  }

  async reconcile(error) {
    if (this.state.execution?.status !== 'executing') return this.get(this.state.id);
    const result = { status: 'needs-reconciliation', message: String(error?.message ?? error ?? 'Unknown save outcome') };
    await this.onReconcile(clone(result));
    this.state.execution = { ...result, failedAt: this.clock() };
    return this.get(this.state.id);
  }

  async cancelUnclaimed(id) {
    if (id !== this.state.id || this.state.execution) return this.get(this.state.id);
    if (this.state.approval?.status === 'cancelled') return this.get(this.state.id);
    const cancelled = { ...(this.state.approval ?? {}), status: 'cancelled', cancelledAt: this.clock() };
    await this.onCancel(clone(cancelled));
    this.state.approval = cancelled;
    return this.get(this.state.id);
  }
}

export async function startProductOnlyReviewUI({ store, ttlMs, onApproved } = {}) {
  if (!(store instanceof ProductOnlyReviewStore)) fail('ProductOnlyReviewStore is required');
  return startProductReviewUI({ store, sessionId: store.state.id, ttlMs, onApproved, renderPage: renderProductOnlyReview });
}
