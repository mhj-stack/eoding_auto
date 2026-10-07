import { installStageTransport } from './stage-transport.mjs';

const ORIGIN = 'https://basecamp.team';
const ID = /^[1-9]\d{0,9}$/;
const fail = message => { throw new Error(message); };
const clone = value => structuredClone(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function exact(value, keys, label) {
  if (!plain(value) || Object.keys(value).length !== keys.length || keys.some(key => !own(value, key))) fail(`Invalid ${label}`);
  return value;
}
function canonicalId(value, label) {
  if (typeof value !== 'string' || !ID.test(value)) fail(`Invalid ${label}`);
  return value;
}
function responseId(value, label) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && ID.test(String(value))) return String(value);
  if (typeof value === 'string' && ID.test(value)) return value;
  fail(`Invalid ${label}`);
}
function dayNumber(value, label = 'day') {
  if (!Number.isSafeInteger(value) || value < 1 || value > 366) fail(`Invalid ${label}`);
  return value;
}
function exactText(value, label) {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 20_000) fail(`Invalid ${label}`);
  return value;
}
function stableJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') { if (!Number.isFinite(value)) fail('Invalid response data'); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!plain(value)) fail('Invalid response data');
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}
function same(left, right) { return stableJson(left) === stableJson(right); }
function targetOf(value) {
  exact(value, ['productId', 'scheduleId', 'day'], 'hotel target');
  return { productId: canonicalId(value.productId, 'hotel product ID'), scheduleId: canonicalId(value.scheduleId, 'hotel schedule ID'), day: dayNumber(value.day, 'hotel day') };
}
function hotelOf(value) {
  exact(value, ['id', 'code', 'name', 'confirm'], 'hotel assignment');
  if (typeof value.confirm !== 'boolean') fail('Invalid hotel confirm');
  return { id: canonicalId(value.id, 'hotel catalog ID'), code: exactText(value.code, 'hotel code'), name: exactText(value.name, 'hotel name'), confirm: value.confirm };
}
function assignmentOf(value) {
  exact(value, ['target', 'hotel'], 'hotel assignment input');
  return { target: targetOf(value.target), hotel: hotelOf(value.hotel) };
}
function exactLocation(page, target) {
  if (!page || typeof page.url !== 'function') fail('Invalid browser page');
  let url;
  try { url = new URL(page.url()); } catch { fail('Wrong product detail URL'); }
  if (url.origin !== ORIGIN || url.username || url.password || url.pathname !== `/tour/master_product/${target.productId}/change/` || url.search || (url.hash && url.hash !== '#schedule')) fail('Wrong product detail URL');
}
async function one(locator, label, visible = false) {
  if (!locator || typeof locator.count !== 'function') fail('Invalid browser locator');
  if (visible) await locator.first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => fail(`Missing/hidden ${label}`));
  if (await locator.count() !== 1) fail(`Missing/ambiguous ${label}`);
  if (visible && !await locator.isVisible()) fail(`Missing/hidden ${label}`);
  return locator;
}
async function selectedDayNode(page, target) {
  const node = await one(page.locator(`#schedule-tree ul > li[day="${target.day}"]`), 'target day node', true);
  const nodeId = await node.getAttribute('id');
  if (!nodeId) fail('Target day node has no ID');
  const escapedId = nodeId.replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\"');
  const hotelAnchor = await one(page.locator(`[id="hotel_${escapedId}_anchor"]`), 'selected hotel node', true);
  if (!/(^|\s)jstree-clicked(\s|$)/.test(await hotelAnchor.getAttribute('class') ?? '')) fail('Selected hotel day mismatch');
  return nodeId;
}
async function selectedSchedule(page, target) {
  const row = await one(page.locator('#schedule_list_table tr.selected[data-schedule-id]'), 'selected schedule', true);
  if (await row.getAttribute('data-schedule-id') !== target.scheduleId) fail('Selected schedule mismatch');
}
function normalizeRow(value, label) {
  if (!plain(value)) fail(`Invalid ${label}`);
  const id = responseId(value.id, `${label} ID`);
  const originId = value.originId === undefined ? undefined : responseId(value.originId, `${label} origin ID`);
  const code = exactText(value.code, `${label} code`);
  const name = exactText(value.name, `${label} name`);
  if (typeof value.confirm !== 'boolean') fail(`Invalid ${label} confirm`);
  return originId === undefined ? { id, code, name, confirm: value.confirm } : { id, originId, code, name, confirm: value.confirm };
}
function sameRows(left, right) { return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((row, index) => same(row, right[index])); }
function assertRows(rows, label, { atMostOneConfirmed = true } = {}) {
  if (!Array.isArray(rows)) fail(`Invalid ${label}`);
  const ids = new Set(); let confirmed = 0;
  for (const row of rows) {
    const normalized = normalizeRow(row, label);
    if (ids.has(normalized.id)) fail(`Duplicate ${label} hotel ID`);
    ids.add(normalized.id); if (normalized.confirm) confirmed += 1;
  }
  if (atMostOneConfirmed && confirmed > 1) fail(`Multiple confirmed ${label} hotels`);
  return rows;
}
async function readUiRows(page) {
  const raw = await page.locator('#hotel_list_area tr[data-id]').evaluateAll(rows => rows.map(row => {
    const cells = row.querySelectorAll('td'); const box = row.querySelector('.confirm_cb');
    return { id: row.getAttribute('data-id'), originId: row.hasAttribute('data-origin-id') ? row.getAttribute('data-origin-id') : undefined, code: cells[0]?.textContent?.trim(), name: cells[1]?.textContent?.trim(), confirm: box?.checked };
  }));
  const rows = raw.map((row, index) => normalizeRow(row, `hotel UI row ${index + 1}`));
  return assertRows(rows, 'hotel UI');
}
async function readServer(page, target) {
  exactLocation(page, target);
  const endpoint = `${ORIGIN}/tour/master_product_schedule/${target.scheduleId}/detail/`;
  let result;
  try {
    result = await page.evaluate(async endpoint => {
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 15_000);
      try {
        const response = await fetch(endpoint, { method: 'GET', credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: controller.signal });
        if (response.status !== 200 || response.redirected || response.url !== endpoint || !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '')) return { failure: 'Hotel schedule detail was not an exact JSON response' };
        return { payload: await response.json() };
      } catch { return { failure: 'Hotel schedule detail GET failed' }; } finally { clearTimeout(timer); }
    }, endpoint);
  } catch { fail('Hotel schedule detail GET failed'); }
  if (!plain(result) || result.failure) fail(result?.failure ?? 'Malformed hotel schedule detail');
  const payload = result.payload;
  if (!plain(payload) || !plain(payload.schedule) || !Array.isArray(payload.schedule_tree) || !Array.isArray(payload.contents) || !Array.isArray(payload.images)) fail('Malformed hotel schedule detail');
  if (responseId(payload.schedule.id, 'schedule ID') !== target.scheduleId || responseId(payload.schedule.product, 'schedule product ID') !== target.productId) fail('Hotel schedule detail identity mismatch');
  if (!Number.isSafeInteger(payload.schedule.day) || payload.schedule.day < target.day) fail('Hotel source day mismatch');
  const detailCandidates = payload.schedule_tree.filter(row => plain(row) && row.day === target.day && row.type_id === 2 && Number.isSafeInteger(row.id));
  if (detailCandidates.length !== 1) fail('Missing/ambiguous hotel source day');
  const hotelDetailId = responseId(detailCandidates[0].id, 'hotel detail ID');
  const hotelRows = [];
  for (const item of payload.contents) {
    if (!plain(item)) fail('Invalid schedule contents row');
    if (responseId(item.detail_id, 'content detail ID') !== hotelDetailId) continue;
    if (item.confirm !== 0 && item.confirm !== 1 && item.confirm !== false && item.confirm !== true) fail('Invalid hotel source confirm');
    hotelRows.push(normalizeRow({ id: item.contents_id, originId: item.origin_id, code: item.code, name: item.name_ko, confirm: item.confirm === 1 || item.confirm === true }, 'hotel source row'));
  }
  assertRows(hotelRows, 'hotel source');
  exactLocation(page, target);
  return { raw: clone(payload), hotelDetailId, hotelRows };
}
async function openAndImportExactCatalog(page, target, hotel, beforeRows) {
  await selectedSchedule(page, target); await selectedDayNode(page, target);
  await (await one(page.locator('#import_schedule_detail_hotel'), 'hotel import button', true)).click();
  const modal = await one(page.locator('#content-modal'), 'hotel catalog modal', true);
  const catalogRows = modal.locator('#modal_table table tbody tr[id]');
  const candidates = [];
  for (let index = 0; index < await catalogRows.count(); index += 1) {
    const row = catalogRows.nth(index); const raw = await row.locator('#data_value').inputValue(); let parsed;
    try { parsed = JSON.parse(raw ?? ''); } catch { fail('Invalid hotel catalog row data'); }
    if (!plain(parsed)) fail('Invalid hotel catalog row data');
    const catalog = { id: responseId(parsed.id, 'hotel catalog row ID'), code: exactText(parsed.code, 'hotel catalog row code'), name: exactText(parsed.name_ko, 'hotel catalog row name') };
    if (await row.getAttribute('id') !== catalog.id) fail('Hotel catalog row ID mismatch');
    if (catalog.id === hotel.id && catalog.code === hotel.code && catalog.name === hotel.name) candidates.push(row);
  }
  if (candidates.length !== 1) fail('Hotel catalog exact match is missing or ambiguous');
  const select = await one(candidates[0].locator('#add_btn'), 'exact hotel catalog select', true);
  await select.click();
  const selectedRows = modal.locator('#selected_list_tbody tr[id]');
  if (await selectedRows.count() !== 1) fail('Hotel catalog selected rows mismatch');
  const selected = selectedRows.first(); let selectedParsed;
  try { selectedParsed = await selected.evaluate(row => globalThis.jQuery?.(row).data('value')); } catch { fail('Hotel catalog selected row data mismatch'); }
  if (!plain(selectedParsed) || responseId(selectedParsed.id, 'selected hotel catalog ID') !== hotel.id || selectedParsed.code !== hotel.code || selectedParsed.name_ko !== hotel.name) fail('Hotel catalog selected row mismatch');
  const dialog = page.waitForEvent('dialog', { timeout: 15_000 }).then(value => value.type() === 'confirm' ? value.accept() : value.dismiss());
  await (await one(modal.locator('#import-image-btn'), 'hotel catalog confirm button', true)).click(); await dialog;
  await modal.waitFor({ state: 'detached', timeout: 15_000 }).catch(() => fail('Hotel catalog did not close after confirm'));
  let after = await readUiRows(page);
  const imported = after.find(row => row.id === hotel.id);
  if (!imported || imported.originId !== undefined || imported.code !== hotel.code || imported.name !== hotel.name || imported.confirm !== false || beforeRows.some(row => row.id === hotel.id)) fail('Imported hotel row mismatch');
  const importedBox = await one(page.locator(`#hotel_list_area tr[data-id="${hotel.id}"] .confirm_cb`), 'imported hotel confirm checkbox', true);
  if (hotel.confirm) await importedBox.check();
  else await importedBox.uncheck();
  after = await readUiRows(page);
  const expected = beforeRows.map(row => ({ ...row, confirm: hotel.confirm ? false : row.confirm })).concat([{ id: hotel.id, code: hotel.code, name: hotel.name, confirm: hotel.confirm }]);
  if (!sameRows(after, expected)) fail('Hotel imported UI state mismatch');
  const confirmed = after.filter(row => row.confirm);
  if (confirmed.length > 1 || (hotel.confirm && (confirmed.length !== 1 || confirmed[0].id !== hotel.id))) fail('Hotel confirmation must be singular');
  return expected;
}
function preparedOf(value) {
  exact(value, ['target', 'hotel', 'before', 'expectedHotelRows'], 'prepared hotel assignment');
  const target = targetOf(value.target); const hotel = hotelOf(value.hotel);
  if (!plain(value.before) || !plain(value.before.raw) || !Array.isArray(value.before.hotelRows) || typeof value.before.hotelDetailId !== 'string') fail('Invalid prepared hotel source');
  assertRows(value.before.hotelRows, 'prepared hotel source'); assertRows(value.expectedHotelRows, 'prepared hotel rows');
  return clone({ target, hotel, before: value.before, expectedHotelRows: value.expectedHotelRows });
}
function serializerRow(row) {
  const result = { contents_id: Number(row.id), confirm: row.confirm };
  if (row.originId !== undefined) result.origin_id = Number(row.originId);
  return result;
}
function expectedPayload(prepared) {
  const beforeById = new Map(prepared.before.hotelRows.map(row => [row.id, row]));
  const changed = prepared.expectedHotelRows.filter(row => !beforeById.has(row.id) || beforeById.get(row.id).confirm !== row.confirm).map(serializerRow);
  return { day: prepared.target.day, product_id: prepared.target.productId, updated_list: [], deleted_list: [], created_list: [], hotel_dict: { hotel_list: changed, deleted_list: [] } };
}
function exactJsonPost(request, page, prepared) {
  if (request.frame() !== page.mainFrame() || request.method() !== 'POST' || request.url() !== `${ORIGIN}/tour/master_product_schedule/${prepared.target.scheduleId}/change/`) fail('Unexpected hotel save request');
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(request.headers()['content-type'] ?? '')) fail('Unexpected hotel save request');
  const bytes = request.postDataBuffer(); if (!bytes || bytes.length > 256 * 1024) fail('Unexpected hotel save request');
  let parsed; try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail('Unexpected hotel save request'); }
  const wanted = expectedPayload(prepared);
  exact(parsed, Object.keys(wanted), 'Unexpected hotel save request');
  if (!same(parsed, wanted)) fail('Unexpected hotel save request');
}
async function installGuard(page, prepared) {
  const context = page.context(); const state = { armed: false, sealed: false, consumed: false, count: 0 }; const forwarded = new WeakSet();
  const guard = { arm() { if (state.armed || state.sealed || state.consumed) fail('Hotel transport guard cannot be armed'); exactLocation(page, prepared.target); state.armed = true; }, seal() { state.sealed = true; }, get count() { return state.count; } };
  const handler = async route => {
    const request = route.request(); if (forwarded.has(request)) return route.fallback();
    let url; try { url = new URL(request.url()); } catch { return route.abort('blockedbyclient'); }
    if (request.method() === 'GET' || request.method() === 'HEAD') return route.fallback();
    if (!state.armed || state.sealed || state.consumed || url.origin !== ORIGIN) { guard.seal(); return route.abort('blockedbyclient'); }
    try { exactLocation(page, prepared.target); exactJsonPost(request, page, prepared); } catch { guard.seal(); return route.abort('blockedbyclient'); }
    state.consumed = true; state.count += 1; forwarded.add(request); return route.fallback();
  };
  const stage = await installStageTransport(page, `hotel:${prepared.target.productId}:${prepared.target.scheduleId}:${prepared.target.day}:${prepared.hotel.id}`, async () => {
    await context.route('**/*', handler);
    return async () => { guard.seal(); await context.unroute('**/*', handler); };
  });
  return { guard, stage };
}
function nonHotelContents(raw, detailId) { return raw.contents.filter(item => responseId(item.detail_id, 'readback content detail ID') !== detailId); }
function confirmValue(item) { return item.confirm === 1 || item.confirm === true; }
function verifyReadback(before, after, prepared) {
  if (!same(before.raw.schedule, after.raw.schedule) || !same(before.raw.schedule_tree, after.raw.schedule_tree) || !same(before.raw.images, after.raw.images)) fail('Schedule metadata, tree, meals, or images changed during hotel persistence');
  if (!same(nonHotelContents(before.raw, before.hotelDetailId), nonHotelContents(after.raw, after.hotelDetailId))) fail('Other contents changed during hotel persistence');
  if (after.hotelRows.length !== prepared.expectedHotelRows.length) fail('Saved hotel IDs or confirmations mismatch');
  for (const expected of prepared.expectedHotelRows) {
    const actual = after.hotelRows.find(row => row.id === expected.id);
    if (!actual || actual.code !== expected.code || actual.name !== expected.name || actual.confirm !== expected.confirm) fail('Saved hotel IDs or confirmations mismatch');
    if (expected.id === prepared.hotel.id && actual.originId === undefined) fail('Saved imported hotel has no canonical origin ID');
    if (expected.id !== prepared.hotel.id && !same(actual, expected)) fail('Saved existing hotel metadata mismatch');
  }
  const beforeItems = new Map(before.raw.contents.filter(item => responseId(item.detail_id, 'source content detail ID') === before.hotelDetailId).map(item => [responseId(item.contents_id, 'source hotel ID'), item]));
  const afterItems = new Map(after.raw.contents.filter(item => responseId(item.detail_id, 'readback content detail ID') === after.hotelDetailId).map(item => [responseId(item.contents_id, 'readback hotel ID'), item]));
  for (const row of before.hotelRows) {
    const persisted = afterItems.get(row.id); if (!persisted) fail('Existing hotel was erased during persistence');
    const expectedConfirm = prepared.expectedHotelRows.find(candidate => candidate.id === row.id)?.confirm;
    if (!same({ ...persisted, confirm: confirmValue(persisted) }, { ...beforeItems.get(row.id), confirm: expectedConfirm })) fail('Existing hotel metadata changed during persistence');
  }
}

/** Guarded exact-catalog hotel assignment for an already saved product schedule day. */
export function createProductHotelAdapters() {
  return { hotels: {
    async prepare(page, input) {
      const assignment = assignmentOf(input); exactLocation(page, assignment.target);
      const before = await readServer(page, assignment.target); await selectedSchedule(page, assignment.target); await selectedDayNode(page, assignment.target);
      const uiBefore = await readUiRows(page);
      if (!sameRows(uiBefore, before.hotelRows)) fail('Hotel UI/source mismatch before import');
      if (before.hotelRows.some(row => row.id === assignment.hotel.id)) fail('Hotel is already assigned');
      const expectedHotelRows = await openAndImportExactCatalog(page, assignment.target, assignment.hotel, uiBefore);
      const unchanged = await readServer(page, assignment.target);
      if (!same(before.raw, unchanged.raw) || before.hotelDetailId !== unchanged.hotelDetailId || !sameRows(before.hotelRows, unchanged.hotelRows)) fail('Hotel source changed during preparation');
      return clone({ target: assignment.target, hotel: assignment.hotel, before, expectedHotelRows });
    },
    async read(page, input) {
      const prepared = preparedOf(input); exactLocation(page, prepared.target); await selectedSchedule(page, prepared.target); await selectedDayNode(page, prepared.target);
      if (!sameRows(await readUiRows(page), prepared.expectedHotelRows)) fail('Prepared hotel UI changed');
      const current = await readServer(page, prepared.target);
      if (!same(prepared.before.raw, current.raw) || prepared.before.hotelDetailId !== current.hotelDetailId || !sameRows(prepared.before.hotelRows, current.hotelRows)) fail('Hotel source changed before save');
      return prepared;
    },
    async save(page, input) {
      const prepared = await this.read(page, input);
      const { guard, stage } = await installGuard(page, prepared); let attempted = false;
      try {
        const responseWait = page.waitForResponse(response => response.request().method() === 'POST' && response.url() === `${ORIGIN}/tour/master_product_schedule/${prepared.target.scheduleId}/change/`, { timeout: 15_000 });
        guard.arm(); attempted = true;
        await (await one(page.locator('#save_schedule_detail'), 'hotel save button', true)).click();
        const response = await responseWait;
        if (response.status() < 200 || response.status() >= 300) fail('Hotel save response was not successful');
        const after = await readServer(page, prepared.target); verifyReadback(prepared.before, after, prepared); stage.verify();
        const confirmed = after.hotelRows.filter(row => row.confirm);
        return { status: 'hotel-assignment-persisted', productId: prepared.target.productId, scheduleId: prepared.target.scheduleId, day: prepared.target.day, hotelIds: after.hotelRows.map(row => row.id), confirmedHotelId: confirmed.length === 1 ? confirmed[0].id : null, guardedPosts: guard.count };
      } catch (cause) {
        if (attempted) { const error = new Error('reconcile-before-retry'); error.code = 'UNKNOWN_SAVE_OUTCOME'; error.cause = cause; throw error; }
        throw cause;
      } finally { guard.seal(); }
    }
  } };
}
