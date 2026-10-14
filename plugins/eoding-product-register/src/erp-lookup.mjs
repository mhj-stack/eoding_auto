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

/**
 * Runs inside the ERP origin with the page's own session. Only same-origin GETs are issued.
 * departport needs any existing master product id because the option list lives on its event form.
 */
export async function erpLookup(page, { kind, query, productId } = {}) {
  const q = checkedQuery(kind, query);
  if (kind === 'departport') {
    if (typeof productId !== 'string' || !/^[1-9][0-9]{0,12}$/.test(productId)) fail('출발지 조회에는 기존 상품 ID(productId)가 필요합니다.');
    const options = await page.evaluate(async id => {
      const url = `/tour/master_product/${id}/create_product/?from=${id}`;
      const response = await fetch(url, { method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
      if (response.status !== 200) throw new Error('출발지 목록을 읽지 못했습니다: ' + response.status);
      const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
      if (doc.querySelector('input[type=password]')) throw new Error('로그인이 필요합니다.');
      const selects = doc.querySelectorAll('select#id_departport');
      if (selects.length !== 1) throw new Error('출발지 선택 목록이 없거나 여러 개입니다.');
      return [...selects[0].options].filter(o => o.value).map(o => ({ value: o.value, label: o.textContent.trim() }));
    }, productId);
    return { kind, results: options.slice(0, MAX_RESULTS) };
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
