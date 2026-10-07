const TIMEOUT_MS = 10_000;
const MAX_DAYS = 366;
const MAX_NIGHTS = 365;
const ALLOWED_ORIGINS = new Set(['https://basecamp.team', 'https://schedule-fixture.invalid']);

const fail = message => { throw new Error(message); };

function productId(value) {
  if (typeof value !== 'string' || !/^[1-9]\d{0,9}$/.test(value)) fail('Invalid product ID');
  return value;
}
function detailUrl(origin, id) {
  return `${origin}/tour/master_product/${id}/change/`;
}
function assertDetailPage(page, id) {
  if (!page || typeof page.url !== 'function') fail('Invalid page');
  const current = page.url();
  let url;
  try { url = new URL(current); } catch { fail('Wrong product detail URL'); }
  if (!ALLOWED_ORIGINS.has(url.origin) || url.username || url.password) fail('Wrong product detail URL');
  const detail = detailUrl(url.origin, id);
  if (current !== detail && current !== `${detail}#schedule`) fail('Wrong product detail URL');
  return url.origin;
}
function endpoint(origin, id) {
  return `${origin}/tour/master_product_schedule/${id}/update/`;
}
function assertRows(value) {
  if (!Array.isArray(value)) fail('Malformed schedule list');
  const ids = new Set();
  return value.map((row, index) => {
    if (!row || typeof row !== 'object' || !/^[1-9]\d{0,9}$/.test(row.scheduleId ?? '') || row.checkboxId !== row.scheduleId || ids.has(row.scheduleId)) fail('Missing, invalid or duplicate schedule ID');
    ids.add(row.scheduleId);
    if (typeof row.title !== 'string' || !row.title.trim() || row.title !== row.title.trim() || row.title.length > 20_000) fail(`Invalid schedule title at row ${index + 1}`);
    for (const [name, maximum] of [['nights', MAX_NIGHTS], ['days', MAX_DAYS]]) {
      if (!/^(?:0|[1-9]\d*)$/.test(row[name] ?? '')) fail(`Invalid schedule ${name} at row ${index + 1}`);
      row[name] = Number(row[name]);
      if (row[name] > maximum || (name === 'days' && row[name] < 1)) fail(`Invalid schedule ${name} at row ${index + 1}`);
    }
    if (row.nights >= row.days) fail(`Invalid schedule duration at row ${index + 1}`);
    return { scheduleId: row.scheduleId, title: row.title, nights: row.nights, days: row.days };
  });
}

/** Read only the server-rendered schedule fragment for the current product detail page. */
export async function readScheduleList(page, { productId: rawProductId } = {}) {
  const id = productId(rawProductId);
  const origin = assertDetailPage(page, id);
  const target = endpoint(origin, id);
  let response;
  try {
    response = await page.evaluate(async ({ target, timeout }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const result = await fetch(target, { method: 'GET', credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: controller.signal });
        if (result.status !== 200 || result.redirected || result.url !== target) return { failure: 'Schedule list request was not an exact successful response' };
        const text = await result.text();
        const document = new DOMParser().parseFromString(text, 'text/html');
        const title = document.title.trim();
        if (/login|sign[ -]?in|로그인/i.test(title) || document.querySelector('form[action*="login" i], input[type="password"], [name="username"], [name="password"]')) return { failure: 'Login HTML returned for schedule list' };
        const body = document.querySelector('tbody#schedule_list_table');
        if (!body || document.querySelectorAll('tbody#schedule_list_table').length !== 1) return { failure: 'Missing or ambiguous schedule list container' };
        const children = [...body.children];
        const empty = children.length === 1 && children[0].matches('tr.empty:not([data-schedule-id])') ? children[0] : null;
        if (empty && empty.children.length === 1 && empty.firstElementChild.matches('td.empty[colspan="8"]') && empty.querySelectorAll('button.add_schedule[type="button"]').length === 1 && !empty.querySelector('input,select,textarea,table,[data-schedule-id]') && empty.textContent.replace(/\s+/g,'') === '등록된일정표가없습니다.하단의추가버튼을클릭하여일정표를등록해주세요.추가') return { rows: [] };
        if (children.some(child => child.tagName !== 'TR')) return { failure: 'Malformed schedule list row' };
        const rows = children.map(row => {
          const one = selector => {
            const nodes = row.querySelectorAll(`:scope > ${selector}`);
            return nodes.length === 1 ? nodes[0].textContent : null;
          };
          const checkboxes = [...row.querySelectorAll(':scope > td')].flatMap(cell => [
            ...cell.querySelectorAll(':scope > input[name="selected_schedule"][type="checkbox"]'),
            ...cell.querySelectorAll(':scope > label > input[name="selected_schedule"][type="checkbox"]')
          ]);
          return {
            scheduleId: row.getAttribute('data-schedule-id'),
            checkboxId: checkboxes.length === 1 ? checkboxes[0].getAttribute('data-id') : null,
            title: one('td.schedule_title'),
            nights: one('td.schedule_night'),
            days: one('td.schedule_day')
          };
        });
        return { rows };
      } finally {
        clearTimeout(timer);
      }
    }, { target, timeout: TIMEOUT_MS });
  } catch {
    fail('Schedule list GET failed');
  }
  if (!response || response.failure) fail(response?.failure ?? 'Malformed schedule list response');
  const schedules = assertRows(response.rows);
  if (assertDetailPage(page, id) !== origin) fail('Schedule list origin changed during read');
  return { productId: id, schedules };
}
