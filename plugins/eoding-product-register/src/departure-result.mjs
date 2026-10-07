import { assertDepartureEntries } from './departure-contract.mjs';
import { assertDeparturePrice } from './departure-read.mjs';
import { createHash } from 'node:crypto';

export const UNKNOWN_SAVE_OUTCOME = 'UNKNOWN_SAVE_OUTCOME';

const ID = /^[1-9]\d{0,9}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_LIST = 5_000;
const MAX_JSON_BYTES = 1_000_000;
const MAX_TEXT = 20_000;
const SENSITIVE = /csrf|token|password/i;
const MONEY_FIELDS = new Set(['id_adult_total_price', 'id_child_total_price', 'id_infant_total_price']);
const RAW_TREE_KEYS = Object.freeze(['id', 'day', 'step', 'type_id', 'etc1', 'etc2', 'etc3', 'etc4', 'etc5', 'etc6', 'day_title', 'breakfast_type', 'breakfast_text', 'lunch_type', 'lunch_text', 'dinner_type', 'dinner_text', 'description']);
const NORMAL_ROW_KEYS = Object.freeze(['id', 'day', 'step', 'typeId', 'etc1', 'etc2', 'etc3', 'etc4', 'etc5', 'etc6', 'dayTitle', 'meals', 'description']);

function unknown() {
  const error = new Error('reconcile-before-retry');
  error.code = UNKNOWN_SAVE_OUTCOME;
  return error;
}
function fail() { throw unknown(); }
function own(value, key) { return Object.prototype.hasOwnProperty.call(value, key); }
function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function exactKeys(value, keys) { return plain(value) && Object.keys(value).length === keys.length && keys.every(key => own(value, key)); }
function id(value) { return typeof value === 'string' && ID.test(value); }
function numericId(value) {
  if (typeof value === 'string' && ID.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && ID.test(String(value))) return String(value);
  fail();
}
function text(value, { empty = true } = {}) { return typeof value === 'string' && value.length <= MAX_TEXT && (empty || value.length > 0); }
function positive(value, maximum = Number.MAX_SAFE_INTEGER) { return Number.isSafeInteger(value) && value >= 1 && value <= maximum; }
function scalar(value) { return value === null || typeof value === 'boolean' || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)); }

/** A bounded canonical JSON representation that rejects undefined, cycles, and exotic objects. */
function stableJson(value, seen = new WeakSet()) {
  if (scalar(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (seen.has(value) || value.length > MAX_LIST) fail();
    seen.add(value);
    const result = `[${value.map(item => stableJson(item, seen)).join(',')}]`;
    seen.delete(value);
    return result;
  }
  if (!plain(value) || seen.has(value)) fail();
  seen.add(value);
  const result = `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key], seen)}`).join(',')}}`;
  seen.delete(value);
  return result;
}
function boundedJson(value) {
  const result = stableJson(value);
  if (result.length > MAX_JSON_BYTES) fail();
  return result;
}
function same(left, right) { return boundedJson(left) === boundedJson(right); }
function parsedJson(value) {
  if (typeof value !== 'string' || value.length > MAX_JSON_BYTES) fail();
  let result;
  try { result = JSON.parse(value); } catch { fail(); }
  boundedJson(result);
  return result;
}
function canonicalMoney(value) {
  if (typeof value !== 'string') fail();
  if (/^(?:0|[1-9]\d*)$/.test(value)) return value;
  if (/^[1-9]\d{0,2}(?:,\d{3})+$/.test(value)) return value.replaceAll(',', '');
  fail();
}
function sha256Hex(value) { return createHash('sha256').update(value).digest('hex'); }

function assertMasterBasic(value, contract, productId) {
  const keys = ['url', 'documentTitle', 'title', 'priority', 'status', 'masterCode', 'masterURL', 'cutoffDays', 'cityValue', 'managerValue', 'cityLabel', 'managerLabel', 'settings', 'settingsDisabled', 'defaults'];
  if (!exactKeys(value, keys) || value.url !== `https://basecamp.team/tour/master_product/${productId}/change/` || !text(value.documentTitle, { empty: false }) || value.title !== contract.title || value.status !== '2' || value.masterCode !== contract.masterCode) fail();
  for (const key of ['priority', 'masterURL', 'cutoffDays', 'cityValue', 'managerValue', 'cityLabel', 'managerLabel']) if (!text(value[key], { empty: false })) fail();
  const settingKeys = ['currency', 'includesFlight', 'tripType', 'vat'];
  if (!exactKeys(value.settings, settingKeys) || !exactKeys(value.settingsDisabled, settingKeys) || Object.values(value.settings).some(item => !text(item, { empty: false })) || Object.values(value.settingsDisabled).some(item => item !== true)) fail();
  const defaultKeys = ['onlineCancellation', 'immediateBooking', 'departureConfirmation'];
  if (!exactKeys(value.defaults, defaultKeys)) fail();
  for (const item of Object.values(value.defaults)) if (!exactKeys(item, ['value', 'type']) || item.value !== '0' || item.type !== 'select-one') fail();
}
function assertHomepage(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_LIST) fail();
  const ids = new Set();
  let badge = 0;
  for (const field of value) {
    if (!plain(field) || !text(field.id, { empty: false }) || !text(field.name) || !text(field.value) || !text(field.type, { empty: false }) || SENSITIVE.test(`${field.id} ${field.name}`)) fail();
    const permitted = new Set(['id', 'name', 'value', 'type', 'checked', 'selectedValues']);
    if (Object.keys(field).some(key => !permitted.has(key)) || ids.has(field.id)) fail();
    ids.add(field.id);
    if (own(field, 'checked') && typeof field.checked !== 'boolean') fail();
    if (own(field, 'selectedValues') && (!Array.isArray(field.selectedValues) || field.selectedValues.length > MAX_LIST || field.selectedValues.some(item => !text(item)))) fail();
    if (field.id === 'id_menu_only_badge_color') {
      if (field.value === '') fail();
      badge += 1;
    }
  }
  if (badge !== 1) fail();
}
function assertMeal(value) {
  if (!exactKeys(value, ['type', 'text']) || !positive(value.type) || !text(value.text)) fail();
}
function normalizedRow(value, index, days, raw = false) {
  const keys = raw ? RAW_TREE_KEYS : NORMAL_ROW_KEYS;
  if (!exactKeys(value, keys)) fail();
  const get = key => value[key];
  const normalized = {
    id: raw ? numericId(get('id')) : get('id'), day: get('day'), step: get('step'), typeId: raw ? get('type_id') : get('typeId'),
    etc1: get('etc1'), etc2: get('etc2'), etc3: get('etc3'), etc4: get('etc4'), etc5: get('etc5'), etc6: get('etc6'),
    dayTitle: raw ? get('day_title') : get('dayTitle'),
    meals: raw ? { breakfast: { type: get('breakfast_type'), text: get('breakfast_text') }, lunch: { type: get('lunch_type'), text: get('lunch_text') }, dinner: { type: get('dinner_type'), text: get('dinner_text') } } : get('meals'),
    description: get('description')
  };
  if (!id(normalized.id) || !positive(normalized.day, days) || !positive(normalized.step) || !positive(normalized.typeId)
    || !text(normalized.etc1) || !text(normalized.etc2) || !text(normalized.etc3) || !text(normalized.etc4) || !text(normalized.etc5) || !text(normalized.etc6)
    || !text(normalized.dayTitle) || !(normalized.description === null || text(normalized.description))) fail();
  if (!exactKeys(normalized.meals, ['breakfast', 'lunch', 'dinner'])) fail();
  for (const meal of Object.values(normalized.meals)) assertMeal(meal);
  return normalized;
}
function assertSourceSchedule(value, productId, sourceScheduleId) {
  if (!exactKeys(value, ['productId', 'scheduleId', 'schedule', 'tree', 'contentsFingerprint', 'imagesFingerprint']) || value.productId !== productId || value.scheduleId !== sourceScheduleId || !HASH.test(value.contentsFingerprint) || !HASH.test(value.imagesFingerprint)) fail();
  const scheduleKeys = ['id', 'productId', 'title', 'days', 'nights', 'code', 'visitRoute', 'scheduleMeeting', 'meetingRemark', 'useFlag', 'sort'];
  if (!exactKeys(value.schedule, scheduleKeys) || value.schedule.id !== sourceScheduleId || value.schedule.productId !== productId || !text(value.schedule.title, { empty: false }) || !text(value.schedule.code, { empty: false }) || !positive(value.schedule.days, 366) || !Number.isSafeInteger(value.schedule.nights) || value.schedule.nights < 0 || value.schedule.nights >= value.schedule.days || ![null, undefined].includes(value.schedule.visitRoute) && !text(value.schedule.visitRoute) || ![null, undefined].includes(value.schedule.scheduleMeeting) && !text(value.schedule.scheduleMeeting) || ![null, undefined].includes(value.schedule.meetingRemark) && !text(value.schedule.meetingRemark) || typeof value.schedule.useFlag !== 'boolean' || !Number.isSafeInteger(value.schedule.sort) || value.schedule.sort < 0) fail();
  if (!Array.isArray(value.tree) || value.tree.length < 1 || value.tree.length > MAX_LIST) fail();
  const ids = new Set(), customDays = new Set();
  const normalized = value.tree.map((row, index) => {
    const item = normalizedRow(row, index, value.schedule.days);
    if (ids.has(item.id)) fail();
    ids.add(item.id);
    if (item.typeId === 7) customDays.add(item.day);
    return item;
  });
  // The observed master tree exposes custom itinerary rows (type 7); every declared day needs one.
  for (let day = 1; day <= value.schedule.days; day += 1) if (!customDays.has(day)) fail();
  return { schedule: value.schedule, tree: normalized };
}
function assertSnapshot(value, productId, sourceScheduleId, contract) {
  if (!exactKeys(value, ['productId', 'events', 'masterBasic', 'masterHomepage', 'sourceSchedule']) || value.productId !== productId || !Array.isArray(value.events) || value.events.length > MAX_LIST) fail();
  assertMasterBasic(value.masterBasic, contract, productId);
  assertHomepage(value.masterHomepage);
  assertSourceSchedule(value.sourceSchedule, productId, sourceScheduleId);
  const events = new Map();
  for (const event of value.events) {
    if (!plain(event) || !id(event.eventId) || events.has(event.eventId)) fail();
    boundedJson(event);
    events.set(event.eventId, event);
  }
  return events;
}
function assertEventShape(event) {
  if (!exactKeys(event, ['eventId', 'eventFields', 'seasonId', 'priceFields', 'reservation', 'copiedFields']) || !id(event.eventId) || !plain(event.eventFields) || !id(event.seasonId) || !Array.isArray(event.priceFields) || event.priceFields.length > MAX_LIST || !plain(event.reservation) || !plain(event.copiedFields) || !Array.isArray(event.eventFields.__checkedStates) || event.eventFields.__checkedStates.length > MAX_LIST) fail();
  for (const [name, value] of Object.entries(event.eventFields)) {
    if (name === '__checkedStates') continue;
    if (!text(name, { empty: false }) || !text(value)) fail();
  }
  for (const state of event.eventFields.__checkedStates) {
    if (!exactKeys(state, ['id', 'name', 'value', 'checked']) || !text(state.id) || !text(state.name) || !text(state.value) || typeof state.checked !== 'boolean' || SENSITIVE.test(`${state.id} ${state.name}`)) fail();
  }
}
function assertExpectedEvent(event, contract) {
  assertEventShape(event);
  for (const [field, expected] of Object.entries(contract.eventExpectation)) {
    if (!own(event.eventFields, field) || !scalar(expected)) fail();
    const actual = event.eventFields[field];
    if (MONEY_FIELDS.has(field)) {
      if (canonicalMoney(actual) !== canonicalMoney(expected)) fail();
    } else if (actual !== expected) fail();
  }
  assertDeparturePrice(event, contract.priceExpectation);
  if (own(contract, 'transportExpectation')) {
    const displayDate = date => date.replaceAll('-', '/');
    // The readback has only displayed transport strings, not selected operator IDs or option labels.
    // Validate the observed departure/return date suffixes, and deliberately make no unobservable ID/label provenance claim.
    if (!text(event.eventFields.id_depart_flight, { empty: false }) || !text(event.eventFields.id_return_flight, { empty: false })
      || !event.eventFields.id_depart_flight.endsWith(displayDate(contract.departureDate))
      || !event.eventFields.id_return_flight.endsWith(displayDate(contract.returnDate))) fail();
  }
}
function assertReservation(reservation, eventId) {
  const expectedCounts = { max_pax_count_in_list: '', res_pax_cnt_in_list: '', res_cancel_pax_cnt_in_list: '', real_res_cnt_in_list: '', adult_cnt_in_list: '0', child_cnt_in_list: '0', infant_cnt_in_list: '0', man_res_cnt_in_list: '0명 (0%)', female_res_cnt_in_list: '0명 (0%)' };
  if (!exactKeys(reservation, ['productId', 'empty', 'emptyText', 'rows', 'counts']) || reservation.productId !== eventId || reservation.empty !== true || reservation.emptyText !== '등록된 예약이 없습니다.' || !Array.isArray(reservation.rows) || reservation.rows.length !== 0 || !exactKeys(reservation.counts, Object.keys(expectedCounts))) fail();
  for (const [name, expected] of Object.entries(expectedCounts)) if (reservation.counts[name] !== expected) fail();
}
function comparableRow(row) { const { id: _id, ...rest } = row; return rest; }
function compareRows(left, right) {
  const sort = values => values.map(comparableRow).sort((a, b) => a.day - b.day || a.step - b.step || a.typeId - b.typeId || stableJson(a).localeCompare(stableJson(b)));
  if (!same(sort(left), sort(right))) fail();
}
function assertCopiedSchedule(event, source) {
  const copied = event.copiedFields;
  const required = ['selected_schedule_id', 'schedule_tree_json', 'schedule_contents_json', 'schedule_image_json', 'id_night', 'id_day', 'id_schedule_name'];
  if (required.some(key => !own(copied, key)) || !id(copied.selected_schedule_id) || copied.selected_schedule_id === source.schedule.id || copied.id_night !== String(source.schedule.nights) || copied.id_day !== String(source.schedule.days) || copied.id_schedule_name !== source.schedule.title) fail();
  const rawTree = parsedJson(copied.schedule_tree_json);
  if (!Array.isArray(rawTree) || rawTree.length !== source.tree.length || rawTree.length > MAX_LIST) fail();
  const ids = new Set();
  const copiedRows = rawTree.map((row, index) => {
    const normalized = normalizedRow(row, index, source.schedule.days, true);
    if (ids.has(normalized.id)) fail();
    ids.add(normalized.id);
    return normalized;
  });
  compareRows(source.tree, copiedRows);
  const contents = stableJson(parsedJson(copied.schedule_contents_json));
  const images = stableJson(parsedJson(copied.schedule_image_json));
  // A new copy ID is never treated as a master-ID assertion.
  if (contents.length > MAX_JSON_BYTES || images.length > MAX_JSON_BYTES) fail();
  return { copiedScheduleId: copied.selected_schedule_id, contents, images };
}

/** Shared strict copy verification; no write authorization or transport assertion. */
export function verifyCopiedScheduleReadback(event, source) {
  try {
    const checked=assertSourceSchedule(source, source?.productId, source?.scheduleId);
    const copied=assertCopiedSchedule(event,checked);
    if(sha256Hex(copied.contents)!==source.contentsFingerprint||sha256Hex(copied.images)!==source.imagesFingerprint) fail();
    return {copiedScheduleId:copied.copiedScheduleId};
  } catch { throw unknown(); }
}

/**
 * Pure readback reconciliation. It proves only a bounded, matching server snapshot;
 * it never authorizes a create, sends requests, or attributes a POST to a caller.
 */
export function reconcileDepartureCreation(input) {
  try {
    if (!exactKeys(input, ['contract', 'requestedEventId', 'before', 'after'])) fail();
    const { contract, requestedEventId, before, after } = input;
    if (!plain(contract) || contract.canCommit !== false || !id(requestedEventId)) fail();
    boundedJson(input);
    assertDepartureEntries(contract.entries, contract);
    if (contract.productId === undefined || contract.sourceScheduleId === undefined || !id(contract.productId) || !id(contract.sourceScheduleId)) fail();
    const previous = assertSnapshot(before, contract.productId, contract.sourceScheduleId, contract);
    const readback = assertSnapshot(after, contract.productId, contract.sourceScheduleId, contract);
    if (!same(before.masterBasic, after.masterBasic) || !same(before.masterHomepage, after.masterHomepage) || !same(before.sourceSchedule, after.sourceSchedule) || previous.has(requestedEventId) || readback.size !== previous.size + 1) fail();
    for (const [eventId, prior] of previous) if (!readback.has(eventId) || !same(prior, readback.get(eventId))) fail();
    for (const eventId of readback.keys()) if (!previous.has(eventId) && eventId !== requestedEventId) fail();
    const created = readback.get(requestedEventId);
    if (!created) fail();
    assertExpectedEvent(created, contract);
    assertReservation(created.reservation, requestedEventId);
    const source = assertSourceSchedule(after.sourceSchedule, contract.productId, contract.sourceScheduleId);
    const copied = assertCopiedSchedule(created, source);
    // Canonical SHA-256s bind the copied auxiliary JSON to the unchanged source readback.
    if (sha256Hex(copied.contents) !== after.sourceSchedule.contentsFingerprint || sha256Hex(copied.images) !== after.sourceSchedule.imagesFingerprint) fail();
    return { status: 'departure-persistence-verified', productId: contract.productId, eventId: requestedEventId, url: `https://basecamp.team/tour/product/${requestedEventId}/change/`, sourceScheduleId: contract.sourceScheduleId, copiedScheduleId: copied.copiedScheduleId, canCommit: false, scope: 'readback-only; not approval or POST attribution' };
  } catch {
    throw unknown();
  }
}
