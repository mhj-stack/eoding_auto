import { assertDepartureEntries } from './departure-contract.mjs';
import { readDepartureSnapshot, readDepartureMasterHomepage } from './departure-read.mjs';
import { reconcileDepartureCreation, UNKNOWN_SAVE_OUTCOME } from './departure-result.mjs';
import { installDepartureTransportGuard } from './departure-live-transport.mjs';
import { readScheduleDetail } from './schedule-detail-read.mjs';
import { readBasicForm } from './basic-form.mjs';
import { digest } from './core.mjs';

const ORIGIN = 'https://basecamp.team';
const ID = /^[1-9]\d{0,9}$/;
const MAX_LIST_ROWS = 5_000;
const RESPONSE_TIMEOUT_MS = 15_000;
const PRICE_ENTRY_NAMES = new Set([
  'adult_price', 'child_price', 'infant_price',
  'adult_fuel_price', 'child_fuel_price', 'infant_fuel_price'
]);

function fail(message) { throw new Error(message); }
function exact(value, keys, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail(message);
}
function canonicalId(value, message) {
  if (typeof value !== 'string' || !ID.test(value)) fail(message);
  return value;
}
function exactUrl(value, message) {
  if (typeof value !== 'string') fail(message);
  let url;
  try { url = new URL(value); } catch { fail(message); }
  if (url.href !== value || url.origin !== ORIGIN || url.username || url.password) fail(message);
  return url;
}
function frozenGraph(value, seen = new WeakSet()) {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return;
  if (!value || typeof value !== 'object' || seen.has(value) || !Object.isFrozen(value)
    || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)) fail('Approved departure candidate must be deeply immutable');
  seen.add(value);
  for (const item of Object.values(value)) frozenGraph(item, seen);
  seen.delete(value);
}
function sameIdSet(left, right, message) {
  if (left.length !== right.length || new Set(left).size !== left.length || new Set(right).size !== right.length
    || left.some(value => !right.includes(value))) fail(message);
}
function unknown(cause) {
  const error = new Error('reconcile-before-retry', { cause });
  error.code = UNKNOWN_SAVE_OUTCOME;
  return error;
}

/**
 * Read the already-rendered, caller-observed event list. It rejects server-side
 * pagination/filtering: the one initialized DataTable must contain every row.
 * `extractEventId` is the caller's observed row mapping; it is not an approval.
 */
export async function readObservedDepartureList(page, { url, extractEventId } = {}) {
  const listUrl = exactUrl(url, 'Observed departure list URL is required');
  if (!page || typeof page.url !== 'function' || typeof page.evaluate !== 'function' || page.url() !== listUrl.href) {
    fail('Departure list reader requires the exact observed list URL');
  }
  if (typeof extractEventId !== 'function') fail('Observed departure list needs an ID reader');
  const observed = await page.evaluate(maximum => {
    const settings = globalThis.jQuery?.fn?.dataTable?.settings;
    if (!Array.isArray(settings) || settings.length !== 1) return { failure: 'Expected exactly one departure DataTable' };
    const table = settings[0];
    if (!table || table._bInitComplete !== true || !Number.isSafeInteger(table._iRecordsTotal)
      || !Number.isSafeInteger(table._iRecordsDisplay) || !Array.isArray(table.aoData)
      || table._iRecordsTotal < 0 || table._iRecordsDisplay < 0 || table.aoData.length > maximum) {
      return { failure: 'Departure DataTable is not initialized and bounded' };
    }
    const rows = table.aoData.map(item => item?._aData);
    if (rows.some(value => value === undefined) || table._iRecordsTotal !== table._iRecordsDisplay
      || table._iRecordsTotal !== rows.length) return { failure: 'Departure DataTable is filtered or incomplete' };
    return { total: table._iRecordsTotal, filtered: table._iRecordsDisplay, rows };
  }, MAX_LIST_ROWS).catch(() => { fail('Departure list read failed'); });
  if (!observed || observed.failure) fail(observed?.failure ?? 'Departure list read failed');
  const rows = observed.rows.map((data, index) => {
    let eventId;
    try { eventId = extractEventId(structuredClone(data)); } catch { fail(`Departure list row ${index + 1} has no canonical event ID`); }
    return { eventId: canonicalId(eventId, `Departure list row ${index + 1} has no canonical event ID`), data };
  });
  if (new Set(rows.map(row => row.eventId)).size !== rows.length) fail('Departure list event IDs must be unique');
  return { url: listUrl.href, total: observed.total, filtered: observed.filtered, rows };
}

function checkedCandidate(candidate) {
  frozenGraph(candidate);
  exact(candidate, ['status', 'canCommit', 'sourceDepartureIndex', 'state', 'summary', 'notice', 'source', 'contract', 'fingerprint'], 'Invalid approved departure candidate');
  if (candidate.status !== 'prepared-only' || candidate.canCommit !== false || candidate.notice !== 'Prepared native contract only. No approval, claim, final creation or POST occurred. Fingerprint is an integrity check, not authorization.') {
    fail('Departure candidate is not a non-authorizing prepared candidate');
  }
  exact(candidate.source, ['index', 'options', 'product', 'target'], 'Invalid approved departure source binding');
  if (!Number.isSafeInteger(candidate.sourceDepartureIndex) || candidate.sourceDepartureIndex < 0 || candidate.sourceDepartureIndex !== candidate.source.index) {
    fail('Departure candidate source index changed');
  }
  const packet = { status: candidate.status, canCommit: candidate.canCommit, sourceDepartureIndex: candidate.sourceDepartureIndex, state: candidate.state, summary: candidate.summary, notice: candidate.notice, source: candidate.source, contract: candidate.contract };
  if (typeof candidate.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(candidate.fingerprint) || candidate.fingerprint !== digest(packet)) fail('Departure candidate fingerprint changed');
  const contract = candidate.contract;
  if (!contract || typeof contract !== 'object' || Array.isArray(contract) || contract.canCommit !== false) fail('Departure contract is not non-authorizing');
  assertDepartureEntries(contract.entries, contract);
  return contract;
}
function requiredBaseline(before, contract) {
  exact(before, ['productId', 'events', 'masterBasic', 'masterHomepage', 'sourceSchedule'], 'Complete before departure snapshots are required');
  if (before.productId !== contract.productId || !Array.isArray(before.events) || before.events.length > MAX_LIST_ROWS) fail('Complete before departure snapshots are required');
  const basic = before.masterBasic;
  exact(basic, ['url', 'documentTitle', 'title', 'priority', 'status', 'masterCode', 'masterURL', 'cutoffDays', 'cityValue', 'managerValue', 'cityLabel', 'managerLabel', 'settings', 'settingsDisabled', 'defaults'], 'Complete before departure snapshots are required');
  if (basic.url !== `${ORIGIN}/tour/master_product/${contract.productId}/change/` || basic.title !== contract.title || basic.status !== '2' || basic.masterCode !== contract.masterCode) fail('Complete before departure snapshots are required');
  for (const key of ['documentTitle', 'priority', 'masterURL', 'cutoffDays', 'cityValue', 'managerValue', 'cityLabel', 'managerLabel']) if (typeof basic[key] !== 'string' || !basic[key]) fail('Complete before departure snapshots are required');
  exact(basic.settings, ['currency', 'includesFlight', 'tripType', 'vat'], 'Complete before departure snapshots are required');
  exact(basic.settingsDisabled, ['currency', 'includesFlight', 'tripType', 'vat'], 'Complete before departure snapshots are required');
  if (Object.values(basic.settings).some(value => typeof value !== 'string' || !value) || Object.values(basic.settingsDisabled).some(value => value !== true)) fail('Complete before departure snapshots are required');
  exact(basic.defaults, ['onlineCancellation', 'immediateBooking', 'departureConfirmation'], 'Complete before departure snapshots are required');
  for (const value of Object.values(basic.defaults)) if (!value || typeof value !== 'object' || Array.isArray(value) || value.value !== '0' || value.type !== 'select-one') fail('Complete before departure snapshots are required');
  if (!Array.isArray(before.masterHomepage) || !before.masterHomepage.length || before.masterHomepage.length > MAX_LIST_ROWS) fail('Complete before departure snapshots are required');
  const homepageIds = new Set(); let badge = 0;
  for (const field of before.masterHomepage) {
    if (!field || typeof field !== 'object' || Array.isArray(field) || typeof field.id !== 'string' || !field.id || typeof field.name !== 'string' || typeof field.value !== 'string' || typeof field.type !== 'string' || !field.type || homepageIds.has(field.id) || /csrf|token|password/i.test(`${field.id} ${field.name}`)) fail('Complete before departure snapshots are required');
    homepageIds.add(field.id); if (field.id === 'id_menu_only_badge_color' && field.value) badge += 1;
  }
  if (badge !== 1) fail('Complete before departure snapshots are required');
  const source = before.sourceSchedule;
  exact(source, ['productId', 'scheduleId', 'schedule', 'tree', 'contentsFingerprint', 'imagesFingerprint'], 'Complete before departure snapshots are required');
  if (source.productId !== contract.productId || source.scheduleId !== contract.sourceScheduleId || !/^[a-f0-9]{64}$/.test(source.contentsFingerprint) || !/^[a-f0-9]{64}$/.test(source.imagesFingerprint)) fail('Complete before departure snapshots are required');
  exact(source.schedule, ['id', 'productId', 'title', 'days', 'nights', 'code', 'visitRoute', 'scheduleMeeting', 'meetingRemark', 'useFlag', 'sort'], 'Complete before departure snapshots are required');
  if (source.schedule.id !== source.scheduleId || source.schedule.productId !== source.productId || !Number.isSafeInteger(source.schedule.days) || source.schedule.days < 1 || source.schedule.days > 366 || !Number.isSafeInteger(source.schedule.nights) || source.schedule.nights !== source.schedule.days - 1 || !Array.isArray(source.tree) || !source.tree.length || source.tree.length > MAX_LIST_ROWS) fail('Complete before departure snapshots are required');
  const sourceRows = new Set(), customDays = new Set();
  for (const row of source.tree) {
    exact(row, ['id', 'day', 'step', 'typeId', 'etc1', 'etc2', 'etc3', 'etc4', 'etc5', 'etc6', 'dayTitle', 'meals', 'description'], 'Complete before departure snapshots are required');
    if (!ID.test(row.id) || sourceRows.has(row.id) || !Number.isSafeInteger(row.day) || row.day < 1 || row.day > source.schedule.days || !Number.isSafeInteger(row.step) || row.step < 1 || !Number.isSafeInteger(row.typeId) || row.typeId < 1 || !row.meals || typeof row.meals !== 'object' || Array.isArray(row.meals) || typeof row.description !== 'string' && row.description !== null) fail('Complete before departure snapshots are required');
    sourceRows.add(row.id); if (row.typeId === 7) customDays.add(row.day);
  }
  for (let day = 1; day <= source.schedule.days; day += 1) if (!customDays.has(day)) fail('Complete before departure snapshots are required');
  const eventIds = new Set();
  for (const event of before.events) {
    exact(event, ['eventId', 'eventFields', 'seasonId', 'priceFields', 'reservation', 'copiedFields'], 'Complete before departure snapshots are required');
    if (!ID.test(event.eventId) || eventIds.has(event.eventId) || !ID.test(event.seasonId) || !event.eventFields || typeof event.eventFields !== 'object' || Array.isArray(event.eventFields) || !Array.isArray(event.eventFields.__checkedStates) || !Array.isArray(event.priceFields) || !event.reservation || typeof event.reservation !== 'object' || Array.isArray(event.reservation) || !event.copiedFields || typeof event.copiedFields !== 'object' || Array.isArray(event.copiedFields)) fail('Complete before departure snapshots are required');
    eventIds.add(event.eventId);
  }
}
function checkedBefore(before, contract, beforeList) {
  requiredBaseline(before, contract);
  const ids = before.events.map(event => canonicalId(event?.eventId, 'Invalid prior departure snapshot ID'));
  if (new Set(ids).size !== ids.length) fail('Complete before departure snapshots are required');
  if (!beforeList || beforeList.url === undefined || !Array.isArray(beforeList.rows)) fail('Complete observed before departure list is required');
  sameIdSet(ids, beforeList.rows.map(row => canonicalId(row?.eventId, 'Invalid observed before list event ID')), 'Before snapshots do not cover the complete observed list');
}
function checkedIdentity(value, expected, candidate, contract) {
  exact(value, ['account', 'sessionId', 'candidate'], 'Dedicated departure identity guard returned an invalid result');
  if (value.account !== expected.account || value.sessionId !== expected.sessionId || value.account !== contract.account || value.candidate !== candidate) {
    fail('Dedicated departure account, session, or candidate identity changed');
  }
}
async function assertIdentity(inspectIdentity, expectedIdentity, candidate, contract) {
  let value;
  try { value = await inspectIdentity(); } catch { fail('Dedicated departure identity guard failed'); }
  checkedIdentity(value, expectedIdentity, candidate, contract);
}
async function nativeEntries(page, contract) {
  const entries = await page.evaluate(() => {
    const forms = document.querySelectorAll('#create_product_form');
    if (forms.length !== 1) throw new Error('Expected one native departure form');
    return [...new FormData(forms[0]).entries()].map(([name, value]) => typeof value === 'string' ? [name, value] : null);
  }).catch(() => { fail('Native departure FormData could not be read'); });
  if (!Array.isArray(entries) || entries.length !== 36 || entries.some(pair => !Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || typeof pair[1] !== 'string')) {
    fail('Native departure FormData must contain exactly 36 text pairs');
  }
  const canonical = entries.map(([name, value]) => {
    if (!PRICE_ENTRY_NAMES.has(name)) return [name, value];
    if (!/^(?:0|[1-9]\d{0,2}(?:,\d{3})*|[1-9]\d*)$/.test(value)) fail('Native age price or fuel value is not canonicalizable');
    return [name, value.replaceAll(',', '')];
  });
  assertDepartureEntries(canonical, contract);
  return entries;
}
async function oneVisible(page, selector, message) {
  const locator = page.locator(selector);
  if (await locator.count() !== 1) fail(message);
  await locator.waitFor({ state: 'visible', timeout: RESPONSE_TIMEOUT_MS }).catch(() => fail(message));
  return locator;
}
async function openConfirm(page) {
  const create = await oneVisible(page, '#create_tour_product', 'Expected one departure create button');
  await create.click({ timeout: RESPONSE_TIMEOUT_MS });
  const confirm = await oneVisible(page, '#bs-modal-message.open #confirm-alert', 'Expected the observed departure confirmation');
  const message = await oneVisible(page, '#bs-modal-message.open #message', 'Expected the observed departure confirmation message');
  if (await message.textContent() !== '행사를 생성 하시겠습니까?') fail('Unexpected departure confirmation message');
  return confirm;
}
function responseObserver(page, createUrl) {
  let bound = null;
  let settled = false;
  let resolve;
  let reject;
  const result = new Promise((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  const timeout = setTimeout(() => { if (!settled) { settled = true; reject(new Error('Exact departure create response did not arrive')); } }, RESPONSE_TIMEOUT_MS);
  const onRequest = request => {
    if (request.method() !== 'POST' || request.url() !== createUrl) return;
    if (bound !== null) { if (!settled) { settled = true; reject(new Error('More than one exact departure create request was observed')); } return; }
    bound = request;
  };
  const onResponse = response => {
    if (response.request() !== bound) return;
    if (settled) return;
    settled = true;
    if (response.status() !== 201) reject(new Error('Exact departure create response was not HTTP 201'));
    else resolve(response);
  };
  page.on('request', onRequest);
  page.on('response', onResponse);
  return {
    wait: () => result,
    close: () => { clearTimeout(timeout); page.off('request', onRequest); page.off('response', onResponse); },
    bound: () => bound
  };
}
async function navigateExact(page, value) {
  const url = exactUrl(value, 'Observed same-origin URL is required');
  await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: RESPONSE_TIMEOUT_MS }).catch(() => fail('Observed same-origin navigation failed'));
  if (page.url() !== url.href) fail('Observed same-origin navigation drifted');
}
async function afterSnapshot(page, contract, list) {
  await navigateExact(page, list.url);
  await page.waitForFunction(()=>{const tables=globalThis.jQuery?.fn?.dataTable?.settings;return Array.isArray(tables)&&tables.length===1&&tables[0]?._bInitComplete===true;},undefined,{timeout:RESPONSE_TIMEOUT_MS}).catch(()=>fail('Departure list did not initialize after save'));
  const afterList = await readObservedDepartureList(page, list);
  const beforeIds = list.before.rows.map(row => row.eventId);
  const afterIds = afterList.rows.map(row => row.eventId);
  const additions = afterIds.filter(id => !beforeIds.includes(id));
  if (afterIds.length !== beforeIds.length + 1 || additions.length !== 1 || beforeIds.some(id => !afterIds.includes(id))) {
    fail('Departure list did not prove exactly one new event with all prior rows retained');
  }
  const eventId = additions[0];
  await navigateExact(page, `${ORIGIN}/tour/master_product/${contract.productId}/change/`);
  const masterBasic = await readBasicForm(page);
  const masterHomepage = await readDepartureMasterHomepage(page, { masterId: contract.productId });
  const sourceSchedule = await readScheduleDetail(page, { productId: contract.productId, scheduleId: contract.sourceScheduleId });
  const events = [];
  for (const currentEventId of afterIds) events.push(await readDepartureSnapshot(page, { eventId: currentEventId }));
  return { eventId, after: { productId: contract.productId, events, masterBasic, masterHomepage, sourceSchedule } };
}

/**
 * Internal low-level orchestration for one already-approved immutable departure.
 * A durable one-use claim callback is the only authorization capability accepted;
 * `canCommit` flags, hashes, and response IDs are never authorization or identity.
 */
export async function executeGuardedDeparture(page, input) {
  exact(input, ['candidate', 'identity', 'inspectIdentity', 'claim', 'before', 'beforeList', 'list'], 'Invalid guarded departure execution input');
  const candidate = input.candidate;
  const contract = checkedCandidate(candidate);
  let before;
  let beforeList;
  try {
    before = structuredClone(input.before);
    beforeList = structuredClone(input.beforeList);
  } catch { fail('Complete before departure snapshots must be cloneable'); }
  const list = { url: input.list?.url, extractEventId: input.list?.extractEventId };
  exact(input.identity, ['account', 'sessionId'], 'Dedicated departure expected identity is required');
  if (input.identity.account !== contract.account || typeof input.identity.sessionId !== 'string' || !input.identity.sessionId) fail('Dedicated departure expected identity is invalid');
  if (typeof input.inspectIdentity !== 'function' || typeof input.claim !== 'function') fail('Dedicated departure identity guard and durable claim callback are required');
  exact(list, ['url', 'extractEventId'], 'Observed departure list URL and reader are required');
  exactUrl(list.url, 'Observed departure list URL is required');
  if (typeof list.extractEventId !== 'function') fail('Observed departure list needs an ID reader');
  checkedBefore(before, contract, beforeList);
  if (beforeList.url !== list.url) fail('Before list URL does not match the observed list URL');

  const createPage = `${ORIGIN}/tour/master_product/${contract.productId}/create_product/?from=${contract.productId}`;
  if (!page || typeof page.url !== 'function' || page.url() !== createPage) fail('Guarded departure execution requires the exact create page URL');
  const nativeFormEntries = await nativeEntries(page, contract);
  await assertIdentity(input.inspectIdentity, input.identity, candidate, contract);
  const guard = await installDepartureTransportGuard(page, { productId: contract.productId, entries: nativeFormEntries });
  let claimed = false;
  let observer;
  try {
    const confirm = await openConfirm(page);
    // The required account/session/candidate equality check is immediately before claim.
    await assertIdentity(input.inspectIdentity, input.identity, candidate, contract);
    let claim;
    try { claim = await input.claim({ candidate, contract }); } catch (cause) { throw new Error('Durable departure claim failed', { cause }); }
    exact(claim, ['status', 'claimId'], 'Durable departure claim callback returned an invalid result');
    if (claim.status !== 'claimed') fail('Durable departure claim was not acquired');
    canonicalId(claim.claimId, 'Durable departure claim ID is invalid');
    claimed = true;
    // The same identity check is immediately before the one-shot transport arm.
    await assertIdentity(input.inspectIdentity, input.identity, candidate, contract);
    observer = responseObserver(page, `${ORIGIN}/tour/master_product/${contract.productId}/create_product/`);
    guard.arm();
    await confirm.click({ timeout: RESPONSE_TIMEOUT_MS });
    await observer.wait();
    if (!observer.bound() || guard.count !== 1) fail('Departure transport did not forward exactly one observed request');
    const result = await afterSnapshot(page, contract, { ...list, before: beforeList });
    const verified=reconcileDepartureCreation({ contract, requestedEventId: result.eventId, before, after: result.after });
    guard.verify();
    return verified;
  } catch (cause) {
    if (claimed) throw unknown(cause);
    throw cause;
  } finally {
    observer?.close();
    guard.seal();
  }
}
