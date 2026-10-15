// Read-only lookups of exact ERP select labels/values through the logged-in dedicated browser.
// Registration requires labels that match the ERP display text exactly (e.g. `나고야(NGO)`,
// `데모13 (기본부서)`, `7C - 제주항공`); guessing them costs a failed review per mismatch.

const fail = message => { throw new Error(message); };

export const LOOKUP_ENDPOINTS = Object.freeze({
  city: '/destination/autocomplete/region/city_in_country/',
  manager: '/company/autocomplete/employee/',
  airline: '/common/autocomplete/airline/',
  airport: '/common/autocomplete/airport/'
});
export const LOOKUP_KINDS = Object.freeze([...Object.keys(LOOKUP_ENDPOINTS), 'departport']);
const MAX_RESULTS = 20;
const MAX_DEPARTPORT_ATTEMPTS = 3;
const PRODUCT_ID = /^[1-9][0-9]{0,12}$/;

function checkedQuery(kind, query) {
  if (!LOOKUP_KINDS.includes(kind)) fail(`지원하지 않는 조회 종류입니다: ${kind}`);
  if (kind === 'departport') return '';
  if (typeof query !== 'string' || !query.trim() || query.length > 50) fail('검색어는 1~50자로 입력하세요.');
  return query.trim();
}

/** Normalizes one autocomplete row; markup (e.g. retired staff shown struck through) is stripped and flagged. */
export function lookupRow(row) {
  if (!row || typeof row !== 'object' || row.id === undefined || typeof row.text !== 'string') return null;
  const inactive = /line-through|퇴사자/.test(row.text);
  const label = row.text.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  if (!label) return null;
  return { value: String(row.id), label, ...(inactive ? { inactive: true } : {}) };
}

/** The search text the registration engine types for an exact label (basic-form strips a trailing "(...)"). */
export function engineQuery(kind, label) {
  if (kind === 'city' || kind === 'manager') return label.replace(/\s*\([^()]*\)\s*$/, '').trim() || label;
  if (kind === 'airport') return /^([A-Z0-9]{3})\s+-\s+/.exec(label)?.[1] ?? label;
  return undefined;
}

async function observedProductIds(page) {
  return page.evaluate(async limit => {
    const current = new URL(globalThis.location.href);
    if (current.origin !== 'https://basecamp.team' || current.username || current.password) throw new Error('출발지 조회는 로그인된 어딩 ERP에서만 가능합니다.');
    if (document.querySelector('input[type=password]')) throw new Error('로그인이 필요합니다. 현재 ERP 세션을 확인하세요.');
    // Only the currently displayed product list is evidence. Do not change its page size,
    // draw another page, or navigate away from a possibly edited product form.
    if (current.pathname !== '/tour/master_product/') return [];
    const ids = [], add = value => {
      const id = String(value ?? '');
      if (/^[1-9][0-9]{0,12}$/.test(id) && !ids.includes(id) && ids.length < limit) ids.push(id);
    };
    const tableNode = document.querySelector('#DataTables_Table_0');
    // Identity can be read at DOMContentLoaded while the list controller is still
    // initializing. Wait briefly for the current table only; never request more rows.
    if (tableNode) {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        if (globalThis.jQuery?.fn?.dataTable?.isDataTable(tableNode) && globalThis.jQuery(tableNode).DataTable().settings()[0]?._bInitComplete === true) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    if (tableNode && globalThis.jQuery?.fn?.dataTable?.isDataTable(tableNode)) {
      const table = globalThis.jQuery(tableNode).DataTable();
      if (table.settings()[0]?._bInitComplete === true) {
        for (const row of table.rows({ page: 'current' }).data().toArray()) add(row?.id);
      }
    }
    for (const link of document.querySelectorAll('a[href]')) {
      try {
        const url = new URL(link.href, current);
        if (url.origin !== current.origin || url.username || url.password) continue;
        add(/^\/tour\/master_product\/([1-9][0-9]{0,12})\/(?:change|create_product)\/$/.exec(url.pathname)?.[1]);
      } catch {}
    }
    return ids;
  }, MAX_DEPARTPORT_ATTEMPTS);
}

async function departurePortsFromProduct(page, productId) {
  return page.evaluate(async id => {
    const current = new URL(globalThis.location.href);
    if (current.origin !== 'https://basecamp.team' || current.username || current.password) throw new Error('출발지 조회는 로그인된 어딩 ERP에서만 가능합니다.');
    if (document.querySelector('input[type=password]')) throw new Error('로그인이 필요합니다. 현재 ERP 세션을 확인하세요.');
    const url = `/tour/master_product/${id}/create_product/?from=${id}`;
    let response;
    try { response = await fetch(url, { method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error' }); }
    catch { return { error: 'GET 실패(네트워크 또는 로그인 리디렉션)' }; }
    if ([401, 403].includes(response.status)) throw new Error(`출발지 조회의 로그인 또는 접근 권한을 확인하세요: HTTP ${response.status}`);
    if (response.status !== 200) return { error: `HTTP ${response.status}` };
    const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
    if (doc.querySelector('input[type=password]')) throw new Error('로그인이 필요합니다. 현재 ERP 세션을 확인하세요.');
    const selects = doc.querySelectorAll('select#id_departport');
    if (selects.length > 1) throw new Error('출발지 선택 목록이 여러 개여서 정확한 값을 확인할 수 없습니다.');
    if (selects.length !== 1) return { error: '출발지 선택 목록 없음' };
    const options = [...selects[0].options].filter(o => o.value).map(o => ({ value: o.value, label: o.textContent.trim() }));
    if (!options.length) return { error: '출발지 선택 목록 비어 있음' };
    if (options.some(o => !o.label) || new Set(options.map(o => o.value)).size !== options.length) throw new Error('출발지 선택값 또는 표시명이 모호합니다.');
    return { options };
  }, productId);
}

/** Runs inside the ERP origin with the page's own session. Only same-origin GETs are issued. */
export async function erpLookup(page, { kind, query, productId } = {}) {
  const q = checkedQuery(kind, query);
  if (kind === 'departport') {
    if (productId !== undefined && (typeof productId !== 'string' || !PRODUCT_ID.test(productId))) fail('기존 상품 ID(productId) 형식이 올바르지 않습니다.');
    const attempted = [], candidates = productId ? [productId] : [];
    let discovered = false;
    for (let index = 0; index < MAX_DEPARTPORT_ATTEMPTS; index++) {
      if (index >= candidates.length && !discovered) {
        discovered = true;
        for (const id of await observedProductIds(page)) if (!candidates.includes(id)) candidates.push(id);
      }
      const id = candidates[index];
      if (!id) break;
      const found = await departurePortsFromProduct(page, id);
      if (found.options) return { kind, productId: id, results: found.options.slice(0, MAX_RESULTS) };
      attempted.push(`${id}: ${found.error}`);
    }
    fail(`출발지 목록을 읽지 못했습니다. ${attempted.length ? `조회 결과: ${attempted.join('; ')}.` : '현재 상품관리 목록에 관측된 상품 ID가 없습니다.'} 로그인된 상품관리 목록의 실제 상품과 ERP 응답을 확인하세요.`);
  }
  const endpoint = LOOKUP_ENDPOINTS[kind];
  const body = await page.evaluate(async ({ endpoint, q }) => {
    const url = `${endpoint}?q=${encodeURIComponent(q)}&term=${encodeURIComponent(q)}`;
    const response = await fetch(url, { method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
    if (response.status !== 200) throw new Error('ERP 조회 실패: ' + response.status);
    const type = response.headers.get('content-type') ?? '';
    if (!type.includes('json')) throw new Error('ERP 조회 응답이 JSON이 아닙니다. 로그인 상태를 확인하세요.');
    return response.json();
  }, { endpoint, q });
  const rows = Array.isArray(body?.results) ? body.results.map(lookupRow).filter(Boolean) : fail('ERP 조회 응답 형식이 예상과 다릅니다.');
  return {
    kind, query: q,
    results: rows.slice(0, MAX_RESULTS).map(row => ({ ...row, ...(engineQuery(kind, row.label) ? { engineQuery: engineQuery(kind, row.label) } : {}) })),
    more: rows.length > MAX_RESULTS || body?.pagination?.more === true
  };
}
