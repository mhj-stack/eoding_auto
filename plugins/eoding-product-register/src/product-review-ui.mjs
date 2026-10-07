import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const BODY_LIMIT = 4096;
const DEFAULT_TTL_MS = 15 * 60 * 1000;
const token = () => randomBytes(32).toString('hex');
const escapeHtml = value => String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
const exact = (actual, expected) => typeof actual === 'string' && actual.length === expected.length && /^[a-f0-9]+$/.test(actual) && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
const cookie = (header, name) => typeof header === 'string' ? header.split(';').map(part => part.trim().split('=')).find(([key, value]) => key === name && value)?.[1] : undefined;
const headers = () => ({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', Pragma: 'no-cache', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" });
const scopeText = (scope, product = {}) => scope === 'full' ? '전체 상품 범위(미지원 단계 포함)' : scope.map(value => ({ basic: '기본정보', shell: '일정표 셸', days: '모든 일반 일차·식사', departures: `${product.includesFlight === true ? '항공포함' : '항공미포함'} KRW 행사·선택요금(예약마감)`  })[value]).join(' + ');
const scopeValue = scope => scope === 'full' ? 'full' : scope.join(',');
const scopeInput = value => value === 'full' ? 'full' : value.split(',').filter(Boolean);

function commercial(session) {
  const product = session.normalized || {}, itinerary = Array.isArray(product.itinerary) ? product.itinerary : [], departures = Array.isArray(product.departures) ? product.departures : [];
  const itineraryRows = itinerary.length ? itinerary.map(day => `<tr><td>${escapeHtml(day.day)}</td><td>${escapeHtml(day.title)}</td><td>${escapeHtml(day.description)}</td><td>${['breakfast', 'lunch', 'dinner'].map(kind => escapeHtml(day.meals?.[kind] ?? '미입력')).join(' / ')}</td></tr>`).join('') : '<tr><td colspan="4">일정 없음</td></tr>';
  const priceRows = departures.length ? departures.map((departure, index) => {
    const selected = departure.prices?.[departure.selectedPrice];
    const prices = selected ? ['adult', 'child', 'infant'].filter(kind => selected[kind]).map(kind => `${kind}: ${selected[kind].currency} ${selected[kind].amount}`).join(', ') : '선택 요금 없음';
    return `<tr><td>${index + 1}</td><td>${escapeHtml(departure.startDate)} ~ ${escapeHtml(departure.endDate)}</td><td>${escapeHtml(prices)}</td></tr>`;
  }).join('') : '<tr><td colspan="3">출발일/요금 없음</td></tr>';
  const flightRows = departures.flatMap((departure, departureIndex) => (Array.isArray(departure.flights) ? departure.flights : []).map((flight, flightIndex) => `<tr><td>${departureIndex + 1}</td><td>${escapeHtml(departure.startDate)} ~ ${escapeHtml(departure.endDate)}</td><td>${flightIndex + 1}</td><td>${escapeHtml(flight.number ?? '미입력')}</td><td>${escapeHtml(flight.from ?? '미입력')} → ${escapeHtml(flight.to ?? '미입력')}</td><td>${escapeHtml(flight.departureLocal ?? '미입력')}</td><td>${escapeHtml(flight.arrivalLocal ?? '미입력')}</td><td>${escapeHtml(flight.status ?? '미입력')}</td></tr>`)).join('');
  const sourceFlights = product.includesFlight === true ? `<h3>출발일별 원본 항공편</h3><table><tr><th>출발일 #</th><th>기간</th><th>편 #</th><th>편명</th><th>구간</th><th>출발 현지시각</th><th>도착 현지시각</th><th>상태</th></tr>${flightRows || '<tr><td colspan="8">원본 항공편 없음</td></tr>'}</table>` : '';
  return `<section><h2>등록 내용</h2><dl><dt>상품명</dt><dd>${escapeHtml(product.title ?? '미입력')}</dd><dt>목적지</dt><dd>${escapeHtml(Array.isArray(product.destinations) ? product.destinations.join(' · ') : '미입력')}</dd><dt>기간</dt><dd>${escapeHtml(product.nights ?? '미입력')}박 ${escapeHtml(product.days ?? '미입력')}일</dd><dt>통화</dt><dd>${escapeHtml(product.currency ?? '미입력')}</dd></dl><h3>일정</h3><table><tr><th>일차</th><th>제목</th><th>내용</th><th>식사</th></tr>${itineraryRows}</table><h3>출발일·선택 요금</h3><table><tr><th>#</th><th>기간</th><th>가격</th></tr>${priceRows}</table>${sourceFlights}</section>`;
}
function invalidInputs(intake) {
  const values = intake.invalidInputs || [];
  return values.length ? `<section class="warn"><h2>정규화 입력 오류</h2>${values.map(item => `<p><strong>${escapeHtml(item.title)}</strong></p><ul>${item.fields.map(field => `<li>${escapeHtml(field)}</li>`).join('')}${item.messages.map(message => `<li>${escapeHtml(message)}</li>`).join('')}</ul>`).join('')}</section>` : '';
}
function page(session, csrf, message = '', executes = false) {
  const intake = session.intake, questions = intake.questions.length ? `<ul>${intake.questions.map(question => `<li><strong>${escapeHtml(question.title)}</strong>: ${escapeHtml(question.prompt)}</li>`).join('')}</ul>` : '<p>추가 질문 없음</p>';
  const stageRows = session.stages.map(stage => `<tr><td>${escapeHtml(stage.name)}</td><td>${stage.requested ? '포함' : '미포함'}</td><td>${escapeHtml(stage.status)}</td><td>${escapeHtml(stage.reason)}</td></tr>`).join('');
  const tenant = session.normalized?.company?.tenant, approval = session.approval?.status === 'approved' ? `<p>승인 범위가 기록되었습니다. 버전 ${session.approval.version}, 계정 ${escapeHtml(session.approval.accountObserved)}. 실행은 별도 범위 실행기가 단 한 번만 claim할 수 있습니다.</p>` : typeof tenant === 'string' && tenant ? `<form method="post" action="/approve"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="version" value="${session.version}"><input type="hidden" name="scope_hash" value="${session.scopeDigest}"><input type="hidden" name="scope" value="${escapeHtml(scopeValue(session.requestedScope))}"><label>ERP에서 직접 확인한 회사명<input name="company" autocomplete="off" required></label><label>ERP에서 직접 확인한 계정명<input name="account" autocomplete="off" required></label><button type="submit">${executes ? '승인 후 등록' : '표시된 단일 범위 승인 기록'}</button></form>` : '<p>회사명이 정규화되지 않아 범위 승인을 기록할 수 없습니다.</p>';
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>상품 범위 등록 검토</title><style>body{font-family:system-ui,sans-serif;max-width:980px;margin:2rem auto;padding:0 1rem;color:#17212b}section{border:1px solid #cbd5e1;padding:1rem;margin:1rem 0;border-radius:.4rem}table{border-collapse:collapse;width:100%}td,th{border:1px solid #cbd5e1;padding:.45rem;text-align:left;vertical-align:top}input{display:block;width:min(30rem,100%);padding:.45rem;margin:.3rem 0 .8rem}.warn{color:#8a2d0b}button{padding:.6rem 1rem;font:inherit}dt{font-weight:700}dd{margin:.15rem 0 .7rem}</style><body><h1>상품 범위 등록 검토</h1><section><h2>근거 및 변경 불가 범위</h2><p>출처: ${escapeHtml(session.source.label)}</p><p>근거 SHA-256: <code>${escapeHtml(session.source.digest)}</code></p><p>세션 버전: ${session.version}; 승인 범위: <strong>${escapeHtml(scopeText(session.requestedScope, session.normalized || {}))}</strong></p><p>이 화면에서 검토한 버전·범위 해시는 승인 POST에서 원자적으로 비교됩니다. 정규화 변경은 승인을 무효화합니다.</p><p><strong>전체 상품 등록/공개/발행은 지원하지 않습니다.</strong></p></section>${commercial(session)}${session.approvalContext?.executionInput ? `<section><h2>승인에 포함된 실행 대상·설정</h2><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${escapeHtml(JSON.stringify(session.approvalContext.executionInput, null, 2))}</pre></section>` : ''}${invalidInputs(intake)}<section><h2>확인할 항목</h2>${questions}</section><section><h2>요청 범위와 어댑터 상태</h2><table><tr><th>단계</th><th>범위</th><th>상태</th><th>사유</th></tr>${stageRows}</table></section><section><h2>회사·계정 직접 확인과 단일 범위 승인</h2><p>${executes ? '승인 버튼을 누르면 표시된 범위만 한 번 등록하고 서버 재조회 결과를 기록합니다. 기본정보 범위에는 신규 입력화면 열기가 포함되며 빈 레코드가 생길 수 있습니다. 전체 상품 등록이 아닙니다.' : '이 화면은 검토·승인 기록 전용이며 ERP 저장을 시작하지 않습니다.'}</p>${approval}${message ? `<p class="warn">${escapeHtml(message)}</p>` : ''}</section></body></html>`;
}
async function form(req) {
  if (!/^application\/x-www-form-urlencoded(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) throw new Error('잘못된 요청 형식입니다.');
  let body = ''; for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > BODY_LIMIT) throw new Error('요청이 너무 큽니다.'); }
  const fields = {}; for (const [key, value] of new URLSearchParams(body)) { if (Object.hasOwn(fields, key)) throw new Error('중복 요청 필드가 있습니다.'); fields[key] = value; }
  const required = ['csrf', 'version', 'scope_hash', 'scope', 'company', 'account'];
  if (Object.keys(fields).length !== required.length || required.some(key => !fields[key]) || Object.values(fields).some(value => value.length > 4096)) throw new Error('필수 요청 필드가 없습니다.');
  if (!/^\d+$/.test(fields.version)) throw new Error('잘못된 검토 버전입니다.');
  return fields;
}

/** Loopback-only approval page; execution is possible only with an explicit coordinator callback. */
export async function startProductReviewUI({ store, sessionId, ttlMs = DEFAULT_TTL_MS, onApproved, renderPage = page } = {}) {
  if (!store || typeof store.get !== 'function' || typeof store.approve !== 'function' || typeof store.cancelUnclaimed !== 'function') throw new TypeError('상품 세션 저장소가 필요합니다.');
  if (onApproved !== undefined && typeof onApproved !== 'function') throw new TypeError('실행 연결자가 유효하지 않습니다.');
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > DEFAULT_TTL_MS) throw new TypeError('검토 TTL이 유효하지 않습니다.');
  if(typeof renderPage !== 'function')throw new TypeError('Invalid review renderer');
  const initial = await store.get(sessionId); let expectedHost, origin, closed = false, closePromise, cancelPromise;
  const startedAt = Date.now(), sessions = new Map(), pendingApprovals = new Set();
  const newSession = () => { const id = token(), csrf = token(); sessions.set(id, { id, csrf }); return sessions.get(id); };
  const cancel = () => {
    if (!cancelPromise) cancelPromise = (async () => {
      await Promise.allSettled([...pendingApprovals]);
      await store.cancelUnclaimed(initial.id).catch(error => { if (!/실행|찾을 수 없습니다/.test(error.message)) throw error; });
    })();
    return cancelPromise;
  };
  const expired = () => Date.now() - startedAt >= ttlMs;
  const expiryTimer = setTimeout(() => { void cancel().catch(() => {}); }, ttlMs);
  expiryTimer.unref();
  const server = http.createServer(async (req, res) => {
    const send = (status, body, session) => { const output = headers(); if (session) output['Set-Cookie'] = `product_review=${session.id}; HttpOnly; SameSite=Strict; Path=/`; res.writeHead(status, output); res.end(body); };
    try {
      if (req.headers.host !== expectedHost) return send(421, '허용되지 않은 호스트입니다.');
      const session = sessions.get(cookie(req.headers.cookie, 'product_review')) || newSession();
      if (closed) return send(410, '검토가 종료되었습니다.', session);
      if (expired()) { await cancel(); return send(410, '검토 시간이 만료되었습니다. 새 검토를 시작하세요.', session); }
      if (req.method === 'GET' && req.url === '/') return send(200, renderPage(await store.get(initial.id), session.csrf, '', Boolean(onApproved)), session);
      if (req.method !== 'POST' || req.url !== '/approve' || req.headers.origin !== origin) return send(403, '검토 페이지에서 다시 시도하세요.', session);
      const values = await form(req); if (!exact(values.csrf, session.csrf)) return send(403, '검토 페이지에서 다시 시도하세요.', session);
      if (closed || expired()) return send(410, '검토가 종료되었습니다.', session);
      const pending = store.approve(initial.id, { tenantObserved: values.company, accountObserved: values.account, expectedVersion: Number(values.version), expectedScopeDigest: values.scope_hash, scope: scopeInput(values.scope), deadline: startedAt + ttlMs });
      pendingApprovals.add(pending);
      let updated;
      try { updated = await pending; } finally { pendingApprovals.delete(pending); }
      if (onApproved && !closed && !expired()) {
        const execution = Promise.resolve().then(() => { if (closed || expired()) throw new Error('검토가 종료되었습니다.'); return onApproved(); });
        pendingApprovals.add(execution);
        try { await execution; } finally { pendingApprovals.delete(execution); }
        updated = await store.get(initial.id);
        return send(200, renderPage(updated, session.csrf, '등록 처리 결과: ' + JSON.stringify(updated.execution), true), session);
      }
      return send(200, renderPage(updated, session.csrf, '승인 범위가 기록되었습니다. 이 페이지는 ERP 저장을 시작하지 않습니다.'), session);
    } catch (error) {
      const session = sessions.get(cookie(req.headers.cookie, 'product_review')) || newSession();
      let current; try { current = await store.get(initial.id); } catch { current = initial; }
      return send(400, renderPage(current, session.csrf, error.message || '요청을 처리할 수 없습니다.', Boolean(onApproved)), session);
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => { server.off('error', reject); resolve(); }); });
  const address = server.address(); if (!address || typeof address === 'string') { server.close(); throw new Error('로컬 검토 포트를 열 수 없습니다.'); }
  expectedHost = `127.0.0.1:${address.port}`; origin = `http://${expectedHost}`;
  return { url: `${origin}/`, close: async () => { if (closePromise) return closePromise; closed = true; clearTimeout(expiryTimer); sessions.clear(); server.closeAllConnections?.(); closePromise = Promise.all([new Promise(resolve => server.close(resolve)), cancel()]).then(() => undefined); return closePromise; } };
}
