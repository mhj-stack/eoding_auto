import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const BODY_LIMIT = 4096;
const DEFAULT_TTL_MS = 15 * 60 * 1000;
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

class HttpProblem extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const escapeHtml = value => String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
function requiredText(value, name) {
  if (typeof value !== 'string' || !value || value.length > 4096) throw new TypeError(name + ' is required');
  return value;
}
function cookieValue(header, name) {
  if (typeof header !== 'string') return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name && rest.length === 1) return rest[0];
  }
}
function exactToken(actual, expected) {
  if (typeof actual !== 'string' || actual.length !== expected.length || !/^[a-f0-9]+$/.test(actual)) return false;
  return timingSafeEqual(Buffer.from(actual, 'utf8'), Buffer.from(expected, 'utf8'));
}
function responseHeaders() {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
  };
}
function documentPage(content) {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>일정표 저장 검토</title><style>body{font-family:system-ui,sans-serif;max-width:760px;margin:2rem auto;padding:0 1rem;color:#17212b}section{border:1px solid #cbd5e1;padding:1rem;margin:1rem 0;border-radius:.4rem}dt{font-weight:700}dd{margin:0 0 .75rem}button{padding:.65rem 1rem;font:inherit}input{display:block;width:100%;max-width:32rem;padding:.5rem;margin:.5rem 0 1rem}.warn{color:#8a2d0b}.result{font-weight:700}</style></head><body><h1>일정표 저장 검토</h1>${content}</body></html>`;
}
function scopePage({ product, target, schedule, csrf, state, message }) {
  const values = {
    target: requiredText(target?.title, 'target title'),
    productId: requiredText(target?.productId, 'target product ID'),
    masterCode: requiredText(target?.masterCode, 'target master code'),
    company: requiredText(product?.company?.tenant, 'company tenant'),
    account: requiredText(target?.account, 'target account'),
    title: requiredText(schedule?.title, 'schedule title'),
    nights: Number.isInteger(schedule?.nights) ? schedule.nights : requiredText('', 'schedule nights'),
    days: Number.isInteger(schedule?.days) ? schedule.days : requiredText('', 'schedule days')
  };
  const info = `<section><h2>저장 범위</h2><dl><dt>대상 상품</dt><dd>${escapeHtml(values.target)}</dd><dt>상품 ID</dt><dd>${escapeHtml(values.productId)}</dd><dt>마스터 코드</dt><dd>${escapeHtml(values.masterCode)}</dd><dt>회사</dt><dd>${escapeHtml(values.company)}</dd><dt>계정</dt><dd>${escapeHtml(values.account)}</dd><dt>일정표 제목</dt><dd>${escapeHtml(values.title)}</dd><dt>기간</dt><dd>${values.nights}박 ${values.days}일</dd><dt>공개 상태</dt><dd>비공개 상품의 일정표 기본틀 1건만</dd></dl><p class="warn">제외: 전체 상품 저장, 호텔, 항공, 요금, 일차·식사, 출발일, 발행은 수행하지 않습니다.</p><p>ERP에 직접 로그인한 운영자가 이 페이지에서 직접 클릭해야 합니다. 이 로컬 화면은 동일 OS 권한을 가진 다른 프로세스에 대한 암호학적 인증 수단이 아닙니다.</p></section>`;
  if (state === 'initial') return documentPage(`${info}<section><h2>1. 준비</h2><p>전용 ERP 브라우저에서 로그인과 대상 비공개 상품 기본정보를 직접 확인한 뒤 준비합니다.</p><form method="post" action="/prepare"><input type="hidden" name="csrf" value="${csrf}"><button type="submit">준비하기</button></form></section>`);
  if (state === 'prepared') return documentPage(`${info}<section><h2>2. 회사 확인 및 승인</h2><p>ERP 화면에서 직접 확인한 회사명을 정확히 입력하세요. 승인 후 저장은 한 번만 시도하며, 결과가 불명확하면 재시도하지 않습니다.</p><form method="post" action="/approve"><input type="hidden" name="csrf" value="${csrf}"><label>회사명<input name="company" autocomplete="off" required></label><button type="submit">승인하고 저장 시도</button></form></section>`);
  return documentPage(`${info}<section class="result">${escapeHtml(message)}</section>`);
}
function isFormContentType(value) {
  return typeof value === 'string' && /^application\/x-www-form-urlencoded(?:\s*;\s*charset=utf-8)?$/i.test(value);
}
async function readForm(req, allowed) {
  if (!isFormContentType(req.headers['content-type'])) throw new HttpProblem(400, '잘못된 요청 형식입니다.');
  const length = req.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > BODY_LIMIT)) throw new HttpProblem(413, '요청이 너무 큽니다.');
  let body = '', size = 0;
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    if (size > BODY_LIMIT) throw new HttpProblem(413, '요청이 너무 큽니다.');
    body += chunk;
  }
  const fields = new URLSearchParams(body);
  const result = {};
  for (const [key, value] of fields) {
    if (!allowed.includes(key) || Object.hasOwn(result, key)) throw new HttpProblem(400, '잘못된 요청 필드입니다.');
    result[key] = value;
  }
  if (Object.keys(result).length !== allowed.length || allowed.some(key => typeof result[key] !== 'string' || !result[key] || result[key].length > 4096))
    throw new HttpProblem(400, '필수 요청 필드가 없습니다.');
  return result;
}

/**
 * Starts a loopback-only human review page for one schedule-shell write. It does
 * not authenticate ERP, invoke a browser, expose a command surface, or provide
 * cryptographic authorization against another same-OS process. A logged-in human
 * must directly click Prepare and Approve in this page.
 */
export async function startScheduleReviewUI({ product, target, schedule, browser, flow, ttlMs = DEFAULT_TTL_MS } = {}) {
  if (!flow || typeof flow.prepareLiveSchedule !== 'function' || typeof flow.execute !== 'function' || !flow.store || typeof flow.store.approve !== 'function' || typeof flow.store.cancelUnclaimed !== 'function')
    throw new TypeError('A live schedule flow with review store is required.');
  if (!browser || typeof browser !== 'object') throw new TypeError('A distinct ERP browser context is required.');
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > DEFAULT_TTL_MS) throw new TypeError('ttlMs must be a positive duration no longer than 15 minutes.');
  product = structuredClone(product); target = structuredClone(target); schedule = structuredClone(schedule);
  // Validate all displayed values before listening, rather than accepting arbitrary shapes at request time.
  scopePage({ product, target, schedule, csrf: '0', state: 'initial' });
  let closed = false, state = 'initial', review, resultMessage, closePromise, cancellationPromise;
  const startedAt = Date.now();
  const sessions = new Map();
  const isFresh = () => !closed && Date.now() - startedAt < ttlMs;
  const isTerminal = () => state === 'completed' || state === 'outcome-unknown';
  const expired = () => { if (!isFresh() && !isTerminal() && state !== 'approving') { if (!closed) state = 'expired'; return true; } return false; };
  const cancelCurrentReview = () => {
    if (!review) return Promise.resolve();
    if (!cancellationPromise) {
      cancellationPromise = flow.store.cancelUnclaimed(review.id).catch(error => {
        if (error?.code !== 'REVIEW_INVALID_STATE') throw error;
      });
    }
    return cancellationPromise;
  };
  let origin, expectedHost;

  function newSession() {
    const id = randomBytes(24).toString('hex');
    const csrf = randomBytes(32).toString('hex');
    const session = { id, csrf };
    sessions.set(id, session);
    return session;
  }
  function sessionFor(req) {
    const id = cookieValue(req.headers.cookie, 'schedule_review');
    return typeof id === 'string' ? sessions.get(id) : undefined;
  }
  function send(res, status, body, session) {
    const headers = responseHeaders();
    if (session) headers['Set-Cookie'] = `schedule_review=${session.id}; HttpOnly; SameSite=Strict; Path=/`;
    res.writeHead(status, headers); res.end(body);
  }
  function show(res, session, pageState = state, message = resultMessage) {
    send(res, 200, scopePage({ product, target, schedule, csrf: session.csrf, state: pageState, message }), session);
  }
  function assertHost(req) {
    if (req.headers.host !== expectedHost) throw new HttpProblem(421, '허용되지 않은 호스트입니다.');
  }
  function assertMutationOrigin(req, session) {
    if (!session || req.headers.origin !== origin) throw new HttpProblem(403, '검토 페이지에서 다시 시도하세요.');
  }
  function assertFresh() {
    if (expired()) throw new HttpProblem(410, '검토 시간이 만료되었습니다. 새 검토를 시작하세요.');
  }
  function assertCsrf(value, session) {
    if (!exactToken(value, session.csrf)) throw new HttpProblem(403, '검토 페이지에서 다시 시도하세요.');
  }
  async function handle(req, res) {
    try {
      assertHost(req);
      if (req.method === 'GET' && req.url === '/') {
        const session = sessionFor(req) || newSession();
        if (state === 'preparing') return show(res, session, state, '준비 진행 중입니다. 재시도하지 마세요. 결과 확인을 기다려 주세요.');
        if (state === 'prepare-failed') return show(res, session, state, '준비할 수 없습니다. 새 검토를 시작하세요.');
        if (state === 'approving') return show(res, session, state, '저장 진행 중입니다. 재시도하지 마세요. 결과 확인을 기다려 주세요.');
        if (expired()) return show(res, session, 'expired', '검토 시간이 만료되었습니다. 새 검토를 시작하세요.');
        return show(res, session);
      }
      if (req.method !== 'POST' || !['/prepare', '/approve'].includes(req.url)) throw new HttpProblem(404, '찾을 수 없는 페이지입니다.');
      const session = sessionFor(req);
      assertMutationOrigin(req, session);
      assertFresh();
      const fields = await readForm(req, req.url === '/prepare' ? ['csrf'] : ['csrf', 'company']);
      assertFresh();
      assertCsrf(fields.csrf, session);
      if (req.url === '/prepare') {
        if (state !== 'initial') throw new HttpProblem(409, '준비는 한 번만 가능합니다.');
        state = 'preparing';
        try { review = await flow.prepareLiveSchedule(product, target, schedule); }
        catch { state = 'prepare-failed'; return show(res, session, state, '준비할 수 없습니다. 새 검토를 시작하세요.'); }
        if (!review || typeof review.id !== 'string' || typeof review.hash !== 'string' || !review.id || !review.hash) { state = 'prepare-failed'; return show(res, session, state, '준비할 수 없습니다. 새 검토를 시작하세요.'); }
        if (closed || expired()) {
          await cancelCurrentReview();
          if (closed) return;
          return show(res, session, 'expired', '검토 시간이 만료되었습니다. 새 검토를 시작하세요.');
        }
        state = 'prepared'; return show(res, session);
      }
      if (state !== 'prepared') throw new HttpProblem(409, '승인은 한 번만 가능합니다.');
      if (fields.company !== product.company.tenant) throw new HttpProblem(400, 'ERP에서 확인한 회사명이 일치하지 않습니다.');
      state = 'approving';
      try {
        await flow.store.approve(review.id, review.hash, { tenantObserved: fields.company, method: 'local-review-ui-tenant-readback' });
        if (closed) return;
        const result = await flow.execute(review.id);
        state = 'completed';
        const scheduleId = typeof result?.scheduleId === 'string' && SAFE_ID.test(result.scheduleId) ? ` (일정표 ID: ${result.scheduleId})` : '';
        resultMessage = `저장 결과가 확인되었습니다${scheduleId}.`;
        return show(res, session);
      } catch {
        if (closed) return;
        state = 'outcome-unknown';
        resultMessage = '결과 확인 필요. 다시 승인하거나 저장하지 마세요. 운영자 대사가 필요합니다.';
        return show(res, session);
      }
    } catch (error) {
      const status = error instanceof HttpProblem ? error.status : 400;
      const session = sessionFor(req) || newSession();
      return send(res, status, documentPage(`<section class="warn">${escapeHtml(error instanceof HttpProblem ? error.message : '요청을 처리할 수 없습니다.')}</section>`), session);
    }
  }
  const server = http.createServer((req, res) => { void handle(req, res); });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') { server.close(); throw new Error('Loopback listener did not provide a TCP port.'); }
  expectedHost = `127.0.0.1:${address.port}`;
  origin = `http://${expectedHost}`;
  return {
    url: `${origin}/`,
    close: async () => {
      if (closePromise) return closePromise;
      closed = true; state = 'closed'; sessions.clear();
      // Do not leave a keep-alive loopback socket holding the listener open.
      server.closeAllConnections?.();
      const listenerClosed = new Promise(resolve => server.close(() => resolve()));
      // The store lock serializes this after an in-flight approval. It must not
      // rewrite a claimed/executing review; that error is the safe terminal case.
      const cancellation = cancelCurrentReview();
      closePromise = Promise.all([listenerClosed, cancellation]).then(() => undefined);
      return closePromise;
    }
  };
}
