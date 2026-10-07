const ORIGIN = 'https://basecamp.team';
const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const ID = /^[1-9]\d{0,9}$/;

function fail(message) { throw new Error(message); }
function canonicalId(value, label) {
  if (typeof value !== 'string' || !ID.test(value)) fail(`Invalid ${label}`);
  return value;
}
function assertOrigin(page, expected = ORIGIN) {
  if (!page || typeof page.url !== 'function' || typeof page.evaluate !== 'function') fail('Invalid page');
  let current;
  try { current = new URL(page.url()); } catch { fail('Wrong departure page origin'); }
  if (current.origin !== expected || current.username || current.password) fail('Wrong departure page origin');
  return current.origin;
}
function assertUnchangedOrigin(page, origin) {
  if (!page || typeof page.url !== 'function') fail('Departure read origin changed during read');
  let current;
  try { current = new URL(page.url()); } catch { fail('Departure read origin changed during read'); }
  if (current.origin !== origin || current.username || current.password) fail('Departure read origin changed during read');
}
async function atOrigin(page, origin, operation) {
  let value;
  try { value = await operation(); } catch { fail('Departure read GET failed'); }
  assertUnchangedOrigin(page, origin);
  return value;
}
function endpoint(origin, path) { return `${origin}${path}`; }

async function getHtml(page, origin, target) {
  const response = await atOrigin(page, origin, () => page.evaluate(async ({ target, timeout, maximum }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const result = await fetch(target, { method: 'GET', credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: controller.signal });
      if (result.status !== 200 || result.redirected || result.url !== target) return { failure: 'Departure read request was not an exact successful response' };
      const headerLength = Number(result.headers.get('content-length'));
      if (Number.isFinite(headerLength) && headerLength > maximum) return { failure: 'Departure read response too large' };
      const html = await result.text();
      if (new TextEncoder().encode(html).byteLength > maximum || html.length === 0) return { failure: 'Departure read response too large' };
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const title = doc.title.trim();
      if (/login|sign[ -]?in|로그인/i.test(title) || doc.querySelector('form#login, form[action*="login" i], input[type="password"], [name="username" i], [name="password" i]')) return { failure: 'Login HTML returned for departure read' };
      return { html };
    } finally { clearTimeout(timer); }
  }, { target, timeout: TIMEOUT_MS, maximum: MAX_RESPONSE_BYTES }));
  if (!response || response.failure || typeof response.html !== 'string') fail(response?.failure ?? 'Malformed departure read response');
  return response.html;
}

async function parseHtml(page, origin, html, kind) {
  const result = await atOrigin(page, origin, () => page.evaluate(({ html, kind }) => {
  const sensitive = /csrf|token|password/i;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const idMap = () => {
    const fields = {};
    for (const element of doc.querySelectorAll('input[id], select[id], textarea[id]')) {
      if (!element.id || sensitive.test(`${element.id} ${element.name}`)) continue;
      if (Object.hasOwn(fields, element.id)) return { failure: 'Duplicate departure field ID' };
      fields[element.id] = element.value;
    }
    fields.__checkedStates = [...doc.querySelectorAll('input[type="checkbox" i], input[type="radio" i]')]
      .filter(element => !sensitive.test(`${element.id} ${element.name}`))
      .map(element => ({ id: element.id, name: element.name, value: element.value, checked: element.checked }));
    return { fields };
  };
  if (kind === 'product') {
    const prices = [...doc.querySelectorAll('#priceNAir')];
    if (prices.length !== 1) return { failure: 'Missing or ambiguous departure season marker' };
    const seasonId = prices[0].getAttribute('data-season-id');
    if (!/^[1-9]\d{0,9}$/.test(seasonId ?? '')) return { failure: 'Invalid departure season ID' };
    const parsed = idMap();
    return parsed.failure ? parsed : { seasonId, eventFields: parsed.fields };
  }
  if (kind === 'price' || kind === 'master') {
    const fields = [...doc.querySelectorAll('input, select, textarea')]
      .filter(element => !sensitive.test(`${element.id} ${element.name}`))
      .map(element => {
        const field = { id: element.id, name: element.name, value: element.value, type: element.type };
        if (element.type === 'checkbox' || element.type === 'radio') field.checked = element.checked;
        if (element.tagName === 'SELECT' && element.multiple) field.selectedValues = [...element.selectedOptions].map(option => option.value);
        return field;
      });
    if (kind === 'price') return { fields };
    const ids = fields.filter(field => field.id).map(field => field.id);
    if (new Set(ids).size !== ids.length) return { failure: 'Duplicate departure field ID' };
    const badges = fields.filter(field => field.id === 'id_menu_only_badge_color');
    if (badges.length !== 1 || badges[0].value === '') return { failure: 'Master homepage response is missing required badge color' };
    return { fields };
  }
  if (kind === 'copied') {
    const parsed = idMap();
    if (parsed.failure) return parsed;
    for (const id of ['selected_schedule_id', 'schedule_tree_json', 'schedule_contents_json', 'schedule_image_json', 'id_night', 'id_day', 'id_schedule_name']) {
      if (!Object.hasOwn(parsed.fields, id)) return { failure: 'Missing copied departure field' };
    }
    return { copiedFields: parsed.fields };
  }
  if (kind !== 'reservation') return { failure: 'Malformed departure read response' };
  const tables = [...doc.querySelectorAll('#reservation_table')];
  const bodies = [...doc.querySelectorAll('#reservation_list_tbody')];
  const products = [...doc.querySelectorAll('#product_id')];
  if (tables.length !== 1 || bodies.length !== 1 || !tables[0].contains(bodies[0])) return { failure: 'Reservation response has no unique server-rendered reservation table' };
  if (products.length !== 1) return { failure: 'Reservation response has no unique product ID' };
  const body = bodies[0];
  const emptyElements = [...doc.querySelectorAll('#reservation_empty')];
  if (emptyElements.length > 1) return { failure: 'Reservation response has duplicate empty rows' };
  const emptyElement = emptyElements[0] ?? null;
  if (emptyElement && !body.contains(emptyElement)) return { failure: 'Reservation empty state is not in the reservation table' };
  const rows = [...body.querySelectorAll('tr')].filter(row => row !== emptyElement);
  const rowIds = rows.map(row => row.id);
  if (rowIds.some(id => !id) || new Set(rowIds).size !== rowIds.length) return { failure: 'Reservation response has duplicate or missing row IDs' };
  const emptyText = emptyElement?.textContent.trim() ?? null;
  if (emptyElement && emptyText !== '등록된 예약이 없습니다.') return { failure: 'Reservation empty state has unexpected text' };
  if (emptyElement && rows.length) return { failure: 'Reservation empty state contradicts real rows' };
  if (!emptyElement && !rows.length) return { failure: 'Reservation response has neither rows nor an explicit empty state' };
  const countElements = [...doc.querySelectorAll('[id$="_in_list"]')];
  if (new Set(countElements.map(element => element.id)).size !== countElements.length) return { failure: 'Reservation response has duplicate count IDs' };
  const counts = Object.fromEntries(countElements.map(element => [element.id, 'value' in element ? element.value : element.textContent.trim()]));
  return { reservation: { productId: products[0].value, empty: Boolean(emptyElement), emptyText, rows: rows.map(row => ({ id: row.id, cells: [...row.cells].map(cell => cell.textContent.trim()) })), counts } };
  }, { html, kind }));
  if (!result || result.failure) fail(result?.failure ?? 'Malformed departure read response');
  return result;
}

/** Read the server-rendered, non-mutating departure event, price, reservation, and copied-schedule snapshots. */
export async function readDepartureSnapshot(page, { eventId: rawEventId } = {}) {
  const eventId = canonicalId(rawEventId, 'event ID');
  const origin = assertOrigin(page);
  const productHtml = await getHtml(page, origin, endpoint(origin, `/tour/product/${eventId}/change/`));
  const product = await parseHtml(page, origin, productHtml, 'product');
  const priceHtml = await getHtml(page, origin, endpoint(origin, `/tour/tour_product_season/${product.seasonId}/change/`));
  const price = await parseHtml(page, origin, priceHtml, 'price');
  const reservationHtml = await getHtml(page, origin, endpoint(origin, `/tour/reservation_by_product/${eventId}/change/`));
  const reservation = await parseHtml(page, origin, reservationHtml, 'reservation');
  if (reservation.reservation.productId !== eventId) fail('Reservation product ID does not match requested event');
  const copiedHtml = await getHtml(page, origin, endpoint(origin, `/tour/product_schedule/${eventId}/update/`));
  const copied = await parseHtml(page, origin, copiedHtml, 'copied');
  assertUnchangedOrigin(page, origin);
  return { eventId, eventFields: product.eventFields, seasonId: product.seasonId, priceFields: price.fields, reservation: reservation.reservation, copiedFields: copied.copiedFields };
}

/** Read the sanitized server-rendered homepage fields for one master product. */
export async function readDepartureMasterHomepage(page, { masterId: rawMasterId } = {}) {
  const masterId = canonicalId(rawMasterId, 'master ID');
  const origin = assertOrigin(page);
  const html = await getHtml(page, origin, endpoint(origin, `/tour/master_product/homepage/${masterId}/`));
  const parsed = await parseHtml(page, origin, html, 'master');
  assertUnchangedOrigin(page, origin);
  return parsed.fields;
}

const PRICE_EXPECTATION_FIELDS = Object.freeze([
  'adult_base_price', 'child_base_price', 'infant_base_price',
  'adult_fuel_price', 'child_fuel_price', 'infant_fuel_price',
  'currency_code', 'min_pax_count', 'max_pax_count',
  'payment_full_flag', 'payment_deposit_flag', 'payment_deposit_person', 'payment_deposit_infant',
  'estimate_term_id', 'use_custom_price', 'custom_price_estimate', 'reward_type', 'reward_value', 'memberPriceRows'
]);
const CANONICAL_REWARD = /^(?:0|[1-9]\d*)\.\d{2}$/;
function sameValues(actual, expected) {
  return Array.isArray(actual) && Array.isArray(expected) && actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}
function uniquePriceField(fields, id) {
  const matches = fields.filter(field => field && field.id === id);
  if (matches.length !== 1) fail(`Price field ${id} is ${matches.length === 0 ? 'missing' : 'ambiguous'}`);
  return matches[0];
}

/** Assert the exact scalar, checked, multiple-select, and zero-member-row price contract. */
export function assertDeparturePrice(snapshot, priceExpectation) {
  if (!snapshot || !Array.isArray(snapshot.priceFields) || !priceExpectation || typeof priceExpectation !== 'object' || Array.isArray(priceExpectation)) fail('Price snapshot and expectation are required');
  const expectedKeys = Object.keys(priceExpectation).sort();
  if (expectedKeys.join(',') !== [...PRICE_EXPECTATION_FIELDS].sort().join(',')) fail('Invalid departure price expectation');
  if (priceExpectation.memberPriceRows !== 0) fail('Expected member price rows must be exactly zero');
  for (const name of PRICE_EXPECTATION_FIELDS) {
    if (name === 'memberPriceRows') continue;
    const expected = priceExpectation[name];
    const field = uniquePriceField(snapshot.priceFields, `id_${name}`);
    let actual;
    if (field.type === 'checkbox' || field.type === 'radio') {
      if (typeof expected !== 'boolean' || typeof field.checked !== 'boolean') fail(`Price ${name} has invalid checked state`);
      actual = field.checked;
    } else if (field.type === 'select-multiple') {
      if (!Array.isArray(expected) || !expected.every(value => typeof value === 'string') || !Array.isArray(field.selectedValues)) fail(`Price ${name} has invalid multiple selection`);
      actual = field.selectedValues;
    } else {
      if (typeof expected !== 'string' || typeof field.value !== 'string') fail(`Price ${name} has invalid value`);
      actual = field.value;
    }
    if (name === 'reward_value' && (!CANONICAL_REWARD.test(expected) || !CANONICAL_REWARD.test(field.value))) fail('Price reward_value must be a canonical decimal');
    if (Array.isArray(expected) ? !sameValues(actual, expected) : actual !== expected) fail(`Price ${name} mismatch`);
  }
  const formCount = uniquePriceField(snapshot.priceFields, 'id_member_prices-TOTAL_FORMS');
  if (formCount.value !== '0' || snapshot.priceFields.some(field => typeof field?.name === 'string' && /^member_prices-\d+-/.test(field.name))) fail('Member price rows must be exactly zero');
  return true;
}
