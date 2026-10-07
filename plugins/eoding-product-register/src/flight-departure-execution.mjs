import { digest } from './core.mjs';
import { flightDepartureInputIssue, flightDepartureSegments, flightDepartureCoverage } from './flight-departure.mjs';
import { prepareFlightForm, readFlightForm } from './flight-form-read.mjs';
import { readPersistedFlights, verifyPersistedFlights } from './flight-persistence-read.mjs';
import { installDepartureTransportGuard } from './departure-live-transport.mjs';
import { readObservedDepartureList } from './departure-execution.mjs';
import { readBasicForm } from './basic-form.mjs';
import { readDepartureMasterHomepage, readDepartureSnapshot, assertDeparturePrice } from './departure-read.mjs';
import { verifyCopiedScheduleReadback } from './departure-result.mjs';
import { readScheduleDetail } from './schedule-detail-read.mjs';

const ORIGIN = 'https://basecamp.team';
const ID = /^[1-9]\d{0,9}$/;
const RESPONSE_TIMEOUT_MS = 15_000;
const MONEY_ENTRY_NAMES = new Set(['adult_price', 'child_price', 'infant_price', 'adult_fuel_price', 'child_fuel_price', 'infant_fuel_price']);

const fail = message => { throw new Error(message); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const same = (left, right) => digest(left) === digest(right);
const text = (value, label) => {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) fail(`Invalid ${label}`);
  return value;
};
const id = (value, label) => {
  if (typeof value !== 'string' || !ID.test(value)) fail(`Invalid ${label}`);
  return value;
};
const readerTarget = target => ({ productId: target.productId, masterCode: target.masterCode, account: target.account });

function dependencies(context, product) {
  const basic = context?.dependencies?.basic;
  const shell = context?.dependencies?.shell;
  const days = context?.dependencies?.days;
  const identity = context?.identity;
  if (!plain(basic) || !plain(shell) || !Array.isArray(days) || !plain(identity)) fail('Missing verified flight departure dependencies');
  const productId = id(basic.productId, 'basic product ID');
  const masterCode = text(basic.masterCode, 'basic master code');
  if (id(shell.productId, 'shell product ID') !== productId) fail('Flight schedule shell product dependency changed');
  const scheduleId = id(shell.scheduleId, 'saved schedule ID');
  const scheduleTitle = text(shell.fields?.title, 'saved schedule title');
  const account = text(identity.accountName, 'ERP account');
  if (!Number.isSafeInteger(product?.days) || product.days < 1 || product.days > 366 || !Array.isArray(product.itinerary) || product.itinerary.length !== product.days || days.length !== product.days) fail('All verified flight itinerary day dependencies are required');
  const seen = new Set();
  for (const day of days) {
    if (!plain(day) || !Number.isSafeInteger(day.day) || day.day < 1 || day.day > product.days || seen.has(day.day) || id(day.scheduleId, 'verified itinerary schedule ID') !== scheduleId || !id(day.detailId, 'verified itinerary detail ID')) fail('All verified flight itinerary day dependencies are required');
    seen.add(day.day);
  }
  const { productId: _productId, ...basicSnapshot } = basic;
  return { productId, masterCode, scheduleId, scheduleTitle, account, dayResults: structuredClone(days), basicSnapshot };
}

function targetFor(required, product) {
  return { productId: required.productId, masterCode: required.masterCode, title: text(product?.title, 'product title'), account: required.account };
}
function listUrl(masterCode) { return `${ORIGIN}/tour/product/?master__master_code=${encodeURIComponent(masterCode)}&start_date=&end_date=&use_flag=True`; }
function eventId(row) { return id(typeof row?.id === 'number' ? String(row.id) : row?.id, 'listed event ID'); }

async function nav(page, url, label) {
  if (!page || typeof page.goto !== 'function' || typeof page.url !== 'function') fail('Invalid browser page');
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: RESPONSE_TIMEOUT_MS }).catch(() => fail(`${label} navigation failed`));
  if (page.url() !== url) fail(`${label} navigation drifted`);
}
async function waitList(page) {
  await page.waitForFunction(() => {
    const settings = globalThis.jQuery?.fn?.dataTable?.settings;
    return Array.isArray(settings) && settings.length === 1 && settings[0]?._bInitComplete === true;
  }, undefined, { timeout: RESPONSE_TIMEOUT_MS }).catch(() => fail('Observed flight departure list did not initialize'));
}
async function choose(page, controlId, value) {
  const control = page.locator(`#${controlId}`);
  if (await control.count() !== 1) fail(`Missing/ambiguous flight base control ${controlId}`);
  const valid = await control.evaluate((element, selected) => element.tagName === 'SELECT' && !element.disabled && !element.multiple && [...element.options].filter(option => option.value === selected).length === 1, value);
  if (!valid) fail(`Unsupported flight base selection ${controlId}`);
  // ERP's styled dropdown hides the native SELECT. Shape, enabled state and exact option were checked above.
  await control.selectOption(value, { force: true });
  if (await control.inputValue() !== value) fail(`Flight base selection did not stick ${controlId}`);
}
async function selectOptions(page, controlId) {
  const control = page.locator(`#${controlId}`);
  if (await control.count() !== 1) fail(`Missing/ambiguous flight base control ${controlId}`);
  const options = await control.evaluate(element => {
    if (element.tagName !== 'SELECT' || element.disabled || element.multiple) throw new Error('shape');
    return [...element.options].map(option => ({ id: option.value, label: option.textContent.trim(), selected: option.selected }));
  }).catch(() => fail(`Unsupported flight base selection ${controlId}`));
  if (!Array.isArray(options)) fail(`Unsupported flight base selection ${controlId}`);
  return options;
}
function optionRecord(value, label) {
  if (!ID.test(value?.id ?? '') || typeof value.label !== 'string' || !value.label || value.label !== value.label.trim()) fail(`Unsupported flight base option ${label}`);
  return { id: value.id, label: value.label };
}
async function resolveBaseSelections(page, input, target) {
  const divisionOptions = await selectOptions(page, 'id_product_division_label');
  let division;
  if (input.divisionId === 'new-product-default') {
    const defaults = divisionOptions.filter(option => option.id && option.label.endsWith(' \uAE30\uBCF8\uAC12'));
    if (defaults.length !== 1 || !defaults[0].selected) fail('Missing, ambiguous, or changed new-product default division');
    division = optionRecord(defaults[0], 'new-product default division');
  } else {
    const matches = divisionOptions.filter(option => option.id === input.divisionId);
    if (matches.length !== 1) fail('Unsupported flight base selection id_product_division_label');
    division = optionRecord(matches[0], 'division');
  }
  await choose(page, 'id_product_division_label', division.id);
  let departPort = null;
  if (input.departPort) {
    const options = await selectOptions(page, 'id_departport');
    const matches = options.filter(option => option.id === input.departPort.id && option.label === input.departPort.label);
    if (matches.length !== 1) fail('Missing, ambiguous, or changed flight departPort option');
    departPort = optionRecord(matches[0], 'departPort');
    await choose(page, 'id_departport', departPort.id);
  }
  return { division: { ...division, masterProductId: target.productId }, departPort };
}
async function verifyBaseSelections(page, input, target, expected) {
  if (!plain(expected?.division) || expected.division.masterProductId !== target.productId) fail('Prepared flight base binding changed');
  const actual = await resolveBaseSelections(page, input, target);
  if (!same(actual, expected)) fail('Prepared flight base selection changed');
  return actual;
}
async function fill(page, controlId, value) {
  const control = page.locator(`#${controlId}`);
  if (await control.count() !== 1) fail(`Missing/ambiguous flight base control ${controlId}`);
  const valid = await control.evaluate(element => element.tagName === 'INPUT' && element.type === 'text' && !element.disabled && !element.readOnly);
  if (!valid) fail(`Unsupported flight base field ${controlId}`);
  await control.fill(String(value));
  const observed = await control.inputValue();
  if ((MONEY_ENTRY_NAMES.has(controlId.replace(/^id_/, '')) ? canonicalMoney(observed) : observed) !== String(value)) fail(`Flight base field did not stick ${controlId}`);
}
function price(product, index) {
  const value = product.departures[index]?.prices?.[product.departures[index]?.selectedPrice ?? 0];
  if (!value?.fuelIncluded) fail('Flight departure requires fuel included');
  return value;
}
async function prepareBase(page, product, input, target, index, scheduleId) {
  const departure = product.departures[index];
  const selected = price(product, index);
  const setting = input.departureSettings.find(value => value.index === index);
  await choose(page, 'id_schedule', scheduleId);
  const base = await resolveBaseSelections(page, input, target);
  await choose(page, 'id_status', '4');
  await fill(page, 'id_title', target.title);
  for (const kind of ['adult', 'child', 'infant']) {
    await fill(page, `id_${kind}_price`, selected[kind].amount);
    await fill(page, `id_${kind}_fuel_price`, 0);
  }
  await fill(page, 'id_min_pax_count', setting.minPax);
  await fill(page, 'id_max_pax_count', setting.maxPax);
  const calendar = page.locator('#create_schedule_calendar');
  if (await calendar.count() === 1) {
    await fill(page, 'start-date', departure.startDate);
    await fill(page, 'end-date', departure.startDate);
    await calendar.click();
  }
  const state = await readFlightForm(page, readerTarget(target));
  if (state.calendar.startDate !== departure.startDate || state.calendar.endDate !== departure.startDate) fail('Flight calendar did not bind exactly one departure date');
  return { state, base };
}
async function nativeEntries(page) {
  const entries = await page.evaluate(() => {
    const forms = document.querySelectorAll('#create_product_form');
    if (forms.length !== 1) throw new Error('form');
    return [...new FormData(forms[0]).entries()].map(([name, value]) => typeof value === 'string' ? [name, value] : null);
  }).catch(() => fail('Native flight FormData could not be read'));
  if (!Array.isArray(entries) || entries.some(pair => !Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || typeof pair[1] !== 'string')) fail('Native flight FormData is invalid');
  return entries;
}
function assertNativeEntries(actual, expected, label) {
  if (!same(actual, expected)) fail(`Prepared native FormData changed${label ? ` ${label}` : ''}`);
  return actual;
}
function postEntries(entries) {
  return entries.map(([name, value]) => [name, MONEY_ENTRY_NAMES.has(name) ? value.replaceAll(',', '') : value]);
}
function withSelectedDate(entries, selectedDate) {
  let count = 0;
  const result = entries.map(([name, value]) => {
    if (name !== 'selected_dates') return [name, value];
    count += 1;
    if (value !== '') fail('Prepared selected_dates was not blank before create confirmation');
    return [name, selectedDate];
  });
  if (count !== 1) fail('Prepared selected_dates is missing or ambiguous');
  return result;
}
function requiredEntries(entries, target, scheduleId, product, index, input, base, { selectedDate = '' } = {}) {
  const selected = price(product, index);
  const setting = input.departureSettings.find(value => value.index === index);
  const matches = name => entries.filter(([key]) => key === name);
  if (!plain(base?.division) || base.division.masterProductId !== target.productId) fail('Prepared flight base binding changed');
  const expected = { master_product_id: target.productId, status: '4', title: target.title, schedule: scheduleId, product_division_label: base.division.id, currency_code: 'KRW', selected_dates: selectedDate, adult_price: String(selected.adult.amount), child_price: String(selected.child.amount), infant_price: String(selected.infant.amount), adult_fuel_price: '0', child_fuel_price: '0', infant_fuel_price: '0', min_pax_count: String(setting.minPax), max_pax_count: String(setting.maxPax) };
  if (base.departPort) expected.departport = base.departPort.id;
  for (const [name, value] of Object.entries(expected)) {
    const actual = matches(name);
    if (actual.length !== 1) fail(`Successful flight FormData mismatch ${name}`);
    const observed = MONEY_ENTRY_NAMES.has(name) ? actual[0][1].replaceAll(',', '') : actual[0][1];
    if (observed !== value) fail(`Successful flight FormData mismatch ${name}`);
  }
  for (const direction of ['depart', 'arrive']) if (!entries.some(([name]) => new RegExp(`^${direction}-0-flight_no$`).test(name))) fail('Successful flight FormData omitted active directions');
  return expected;
}
async function confirm(page) {
  const button = page.locator('#create_tour_product');
  if (await button.count() !== 1) fail('Expected one flight create button');
  await button.click({ timeout: RESPONSE_TIMEOUT_MS });
  const modal = page.locator('#bs-modal-message.open #confirm-alert');
  if (await modal.count() !== 1) fail('Expected flight confirmation');
  return modal;
}
function observe(page, url) {
  let request = null;
  let settled = false;
  let resolve;
  let reject;
  const done = new Promise((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  // The save path awaits later; attach a rejection handler now to avoid an unhandled-rejection gap.
  done.catch(() => {});
  const timer = setTimeout(() => {
    if (!settled) { settled = true; reject(new Error('Exact flight create response did not arrive')); }
  }, RESPONSE_TIMEOUT_MS);
  const onRequest = candidate => {
    if (candidate.method() !== 'POST' || candidate.url() !== url) return;
    if (request !== null && !settled) { settled = true; reject(new Error('More than one exact flight create request was observed')); return; }
    request = candidate;
  };
  const onResponse = response => {
    if (response.request() !== request || settled) return;
    settled = true;
    if (response.status() !== 201) reject(new Error('Flight create response was not HTTP 201'));
    else resolve(response);
  };
  page.on('request', onRequest);
  page.on('response', onResponse);
  return { wait: () => done, close: () => { clearTimeout(timer); page.off('request', onRequest); page.off('response', onResponse); }, bound: () => request };
}

export function expectedMeals(day) {
  const native=new Map([['불포함',16],['호텔식',2],['한식',5],['현지식',3]]);
  return Object.fromEntries(['breakfast','lunch','dinner'].map(kind=>[kind,native.has(day.meals[kind])?{type:native.get(day.meals[kind]),text:''}:{type:17,text:day.meals[kind]}]));
}
function assertVerifiedBaseline(masterBasic, sourceSchedule, required, product) {
  if (masterBasic.url !== `${ORIGIN}/tour/master_product/${required.productId}/change/` || masterBasic.status !== '2' || masterBasic.title !== product.title || masterBasic.masterCode !== required.masterCode || !same(masterBasic, required.basicSnapshot)) fail('Verified flight basic dependency changed before departure');
  if (sourceSchedule.productId !== required.productId || sourceSchedule.scheduleId !== required.scheduleId || sourceSchedule.schedule.title !== required.scheduleTitle || sourceSchedule.schedule.days !== product.days || sourceSchedule.schedule.nights !== product.nights) fail('Saved flight source schedule does not match verified shell title or duration');
  if (sourceSchedule.contentsFingerprint !== digest([]) || sourceSchedule.imagesFingerprint !== digest([])) fail('Approved flight itinerary auxiliary content changed');
  for (const day of product.itinerary) {
    const rows = sourceSchedule.tree.filter(row => row.day === day.day);
    const custom = rows.filter(row => row.typeId === 7);
    const saved = required.dayResults.find(item => item.day === day.day);
    if (custom.length !== 1 || custom[0].id !== saved?.detailId || custom[0].step !== 1 || custom[0].etc1 !== day.title || custom[0].description !== day.description || ['etc2', 'etc3', 'etc4', 'etc5', 'etc6'].some(key => custom[0][key] !== '')) fail('Approved flight itinerary detail changed before departure');
    if (rows.some(row => row.dayTitle !== day.title || !same(row.meals, expectedMeals(day)) || ![2, 7].includes(row.typeId))) fail('Approved flight itinerary presentation changed before departure');
    const hotels = rows.filter(row => row.typeId === 2);
    if (hotels.length > 1 || hotels.some(row => row.step !== 999 || row.etc1 !== '' || row.etc2 !== '' || row.description !== null)) fail('Approved flight itinerary hotel sentinel changed before departure');
  }
}
async function baseline(page, target, required, beforeList, product) {
  await nav(page, `${ORIGIN}/tour/master_product/${target.productId}/change/`, 'Flight master');
  // readBasicForm owns prefix-aware Select2 hydration; do not wait on a second, hardcoded prefix.
  const masterBasic = await readBasicForm(page);
  const masterHomepage = await readDepartureMasterHomepage(page, { masterId: target.productId });
  const sourceSchedule = await readScheduleDetail(page, { productId: target.productId, scheduleId: required.scheduleId });
  assertVerifiedBaseline(masterBasic, sourceSchedule, required, product);
  const events = [];
  for (const row of beforeList.rows) events.push(await readDepartureSnapshot(page, { eventId: row.eventId }));
  return { productId: target.productId, masterBasic, masterHomepage, sourceSchedule, events };
}
async function afterSave(page, target, required, list, beforeList, product, base) {
  await nav(page, list.url, 'Flight departure list');
  await waitList(page);
  const afterList = await readObservedDepartureList(page, list);
  const beforeIds = beforeList.rows.map(row => row.eventId);
  const afterIds = afterList.rows.map(row => row.eventId);
  const added = afterIds.filter(value => !beforeIds.includes(value));
  if (afterIds.length !== beforeIds.length + 1 || added.length !== 1 || beforeIds.some(value => !afterIds.includes(value))) fail('Flight departure list did not prove exactly one new event with all prior rows retained');
  const after = await baseline(page, target, required, afterList, product);
  if (base?.departPort) after.departPortCatalog = await readDepartPortCatalog(page, target.productId);
  return { eventId: added[0], after };
}
function canonicalMoney(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,2}(?:,\d{3})*|[1-9]\d*)$/.test(value)) fail('Invalid created event total price');
  return value.replaceAll(',', '');
}
function expectedEvent(target, product, index, expectedPrice, base) {
  const departure = product.departures[index];
  const displayDate = value => value.replaceAll('-', '/');
  const expected = {
    id_status: '4', id_title: target.title, id_currency_code: 'KRW', id_master_product_code: target.masterCode,
    id_min_pax_count: expectedPrice.min_pax_count, id_max_pax_count: expectedPrice.max_pax_count, id_res_count: '0',
    id_adult_total_price: expectedPrice.adult_base_price, id_child_total_price: expectedPrice.child_base_price, id_infant_total_price: expectedPrice.infant_base_price,
    id_tour_season: `${displayDate(departure.startDate)} ~ ${displayDate(departure.endDate)} (${product.nights}박${product.days}일)`
  };
  return expected;
}
function assertCreatedDepartPort(created, base, catalog) {
  if (!base?.departPort) return;
  const legacy = created.eventFields.id_departport;
  if (legacy !== undefined) {
    if (legacy !== base.departPort.id) fail('Created flight event field mismatch id_departport');
    return;
  }
  // The live event can expose only a label; resolve it against a fresh unique catalog mapping.
  if (created.eventFields.id_season_departport !== base.departPort.label) fail('Created flight event field mismatch id_season_departport');
  const ports = created.priceFields.filter(field => field?.id === 'id_departport');
  if (ports.length) { if (ports.length !== 1 || ports[0].value !== base.departPort.id) fail('Created flight departure port ID/label proof is missing or ambiguous'); return; }
  const byLabel = Array.isArray(catalog) ? catalog.filter(p => p.label === base.departPort.label) : [];
  const byId = Array.isArray(catalog) ? catalog.filter(p => p.id === base.departPort.id) : [];
  if (byLabel.length !== 1 || byId.length !== 1 || byLabel[0].id !== base.departPort.id || byId[0].label !== base.departPort.label) fail('Created flight departure port catalog proof is missing or ambiguous');
}
function assertCreatedEvent(created, expected) {
  if (!plain(created?.eventFields)) fail('Created flight event fields are missing');
  for (const [field, value] of Object.entries(expected)) {
    const actual = created.eventFields[field];
    if (typeof actual !== 'string') fail(`Created flight event field missing ${field}`);
    if (field.endsWith('_total_price')) {
      if (canonicalMoney(actual) !== canonicalMoney(value)) fail(`Created flight event field mismatch ${field}`);
    } else if (actual !== value) fail(`Created flight event field mismatch ${field}`);
  }
}
function verifyResult(before, after, eventId, expectedPrice, target, product, index, base) {
  if (!same(before.masterBasic, after.masterBasic) || !same(before.masterHomepage, after.masterHomepage) || !same(before.sourceSchedule, after.sourceSchedule)) fail('Flight create changed the master or source schedule');
  for (const prior of before.events) {
    const current = after.events.find(event => event.eventId === prior.eventId);
    if (!current || !same(prior, current)) fail('Flight create changed or removed a prior event');
  }
  const created = after.events.find(event => event.eventId === eventId);
  if (!created) fail('Flight created event readback missing');
  assertCreatedEvent(created, expectedEvent(target, product, index, expectedPrice, base));
  assertCreatedDepartPort(created, base, after.departPortCatalog);
  assertDeparturePrice(created, expectedPrice);
  return { created, ...verifyCopiedScheduleReadback(created, before.sourceSchedule) };
}
function candidateFor({ product, input, index, target, scheduleId, segments, coverage, form, base, entries }) {
  const source = { index, product: structuredClone(product), options: { ...structuredClone(input), savedScheduleId: scheduleId, expectedAccountName: target.account }, target: structuredClone(target) };
  const contract = { version: 1, productId: target.productId, sourceScheduleId: scheduleId, departureDate: product.departures[index].startDate, returnDate: product.departures[index].endDate, nights: product.nights, days: product.days, masterCode: target.masterCode, title: target.title, account: target.account, canCommit: false };
  const packet = { status: 'prepared-only', canCommit: false, sourceDepartureIndex: index, state: { form: form.state, segments: structuredClone(segments), coverage: structuredClone(coverage), base: structuredClone(base), nativeEntries: structuredClone(entries) }, summary: { title: target.title, departureDate: contract.departureDate }, notice: 'Prepared native contract only. No approval, claim, final creation or POST occurred. Fingerprint is an integrity check, not authorization.', source, contract };
  return { ...packet, fingerprint: digest(packet) };
}
function checkPrepared(prepared, product, input, context) {
  if (!plain(prepared) || !plain(prepared.candidate) || !plain(prepared.before) || !plain(prepared.beforeList)) fail('Missing prepared flight departure');
  const candidate = prepared.candidate;
  const { fingerprint, ...packet } = candidate;
  if (candidate.status !== 'prepared-only' || candidate.canCommit !== false || typeof fingerprint !== 'string' || fingerprint !== digest(packet) || !Array.isArray(candidate.state?.nativeEntries)) fail('Prepared flight candidate changed');
  if (!same(candidate.source.product, product) || !same(candidate.source.options, { ...input, savedScheduleId: candidate.contract.sourceScheduleId, expectedAccountName: context?.identity?.accountName }) || candidate.source.index !== candidate.sourceDepartureIndex) fail('Prepared flight source changed');
  return candidate;
}
function expectedPersisted(segments) {
  return Object.fromEntries(['depart', 'arrive'].map(direction => [direction, segments[direction].map(segment => ({ depart_date: segment.departDate, flight_no: segment.flightNo, airline: segment.airline.id, depart_cd: segment.departAirport.id, arrive_cd: segment.arriveAirport.id, depart_time: segment.departTime, arrive_time: segment.arriveTime, next_day: ({ 0: '', 1: '1', 2: '2', '-1': '3' })[segment.dayOffset], moving_time: segment.movingTime, code_share: segment.codeShare }))]));
}

async function installReadOnlyDepartureGuard(page) {
  if (!page || typeof page.route !== 'function' || typeof page.unroute !== 'function') fail('Invalid browser page');
  let blocked = 0;
  const handler = async route => {
    if (['GET', 'HEAD'].includes(route.request().method())) return route.fallback();
    // Abort all mutations; blocked third-party analytics are not ERP writes.
    if (new URL(route.request().url()).origin === ORIGIN) blocked += 1;
    return route.abort('blockedbyclient');
  };
  await page.route('**/*', handler);
  return { verify() { if (blocked) fail('Final flight reconciliation attempted a non-read transport'); }, async close() { await page.unroute('**/*', handler); } };
}
function expectedPriceForReconcile(product, input, index) {
  const selected = price(product, index), setting = input.departureSettings.find(value => value.index === index);
  if (!setting) fail('Prepared flight departure setting is missing');
  return { currency_code: 'KRW', adult_base_price: String(selected.adult.amount), child_base_price: String(selected.child.amount), infant_base_price: String(selected.infant.amount), adult_fuel_price: '0', child_fuel_price: '0', infant_fuel_price: '0', min_pax_count: String(setting.minPax), max_pax_count: String(setting.maxPax), payment_full_flag: 'False', payment_deposit_flag: 'False', payment_deposit_person: '0', payment_deposit_infant: false, estimate_term_id: '', use_custom_price: '0', custom_price_estimate: '', reward_type: '0', reward_value: '0.00', memberPriceRows: 0 };
}
function reconcileTarget(target, required) {
  if (!plain(target) || Object.keys(target).some(key => !['productId', 'masterCode', 'scheduleId', 'eventId'].includes(key))) fail('Invalid final flight reconciliation target');
  if (id(target.productId, 'target product ID') !== required.productId || text(target.masterCode, 'target master code') !== required.masterCode || id(target.scheduleId, 'target schedule ID') !== required.scheduleId) fail('Final flight reconciliation target does not match saved dependencies');
  return { productId: target.productId, masterCode: target.masterCode, scheduleId: target.scheduleId, eventId: id(target.eventId, 'target event ID') };
}
function reconcilePrepared(context, product, input, required, target) {
  const prepared = context?.preparedBefore;
  if (!plain(prepared) || !plain(prepared.candidate) || !plain(prepared.before) || !plain(prepared.beforeList)) fail('Missing saved prepared flight departure artifact');
  const candidate = checkPrepared(prepared, product, input, context), index = candidate.sourceDepartureIndex, sourceTarget = targetFor(required, product);
  if (!same(candidate.source.target, sourceTarget) || !same(candidate.source.product, product) || !same(candidate.source.options, { ...input, savedScheduleId: required.scheduleId, expectedAccountName: required.account })) fail('Saved prepared flight source does not match reconciliation arguments');
  if (candidate.contract?.productId !== target.productId || candidate.contract?.masterCode !== target.masterCode || candidate.contract?.sourceScheduleId !== target.scheduleId || candidate.contract?.departureDate !== product.departures[index]?.startDate || candidate.contract?.returnDate !== product.departures[index]?.endDate || candidate.contract?.account !== required.account) fail('Saved prepared flight contract does not match reconciliation target');
  if (prepared.before.productId !== required.productId || !plain(prepared.before.masterBasic) || !plain(prepared.before.sourceSchedule) || !Array.isArray(prepared.before.events) || prepared.beforeList.url !== listUrl(required.masterCode) || !Array.isArray(prepared.beforeList.rows)) fail('Saved prepared flight baseline is incomplete');
  const beforeIds = prepared.beforeList.rows.map(row => id(row?.eventId, 'prepared listed event ID'));
  if (new Set(beforeIds).size !== beforeIds.length || beforeIds.includes(target.eventId)) fail('Saved prepared flight baseline cannot prove the target event is new');
  const claim = context?.claimedDeparture ?? context?.session?.execution?.departures?.[index];
  if (!plain(claim) || claim.status !== 'claimed' || typeof claim.fingerprint !== 'string') fail('Missing claimed departure journal fingerprint; final proof cannot complete');
  if (claim.productId !== required.productId || claim.scheduleId !== required.scheduleId) fail('Claimed departure journal does not match saved dependencies');
  if (claim.fingerprint !== candidate.fingerprint) fail('Saved prepared artifact differs from claimed departure journal fingerprint; final proof cannot complete because the save-prepared candidate was not separately persisted');
  return { prepared, candidate, index, sourceTarget };
}
async function readDepartPortCatalog(page, productId) {
  const url = `${ORIGIN}/tour/master_product/${id(productId, 'catalog product ID')}/create_product/?from=${productId}`;
  const result = await page.evaluate(async url => {
    const response = await fetch(url, { method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (response.status !== 200 || response.url !== url) throw Error('Departure port catalog GET failed');
    const text = await response.text(); if (text.length > 1000000) throw Error('Departure port catalog too large');
    const doc = new DOMParser().parseFromString(text, 'text/html'), selects = doc.querySelectorAll('select#id_departport');
    if (selects.length !== 1 || doc.querySelector('input[type=password]')) throw Error('Departure port catalog identity missing');
    return [...selects[0].options].map(o=>({id:o.value,label:o.textContent.trim()}));
  }, url);
  if (new URL(page.url()).origin !== ORIGIN) fail('Departure catalog origin drift');
  return result;
}
async function readFinalFlightProof(page, target, required, prepared, product, candidate) {
  const url = listUrl(required.masterCode);
  await nav(page, url, 'Final flight departure list'); await waitList(page);
  const afterList = await readObservedDepartureList(page, { url, extractEventId: eventId });
  const beforeIds = prepared.beforeList.rows.map(row => row.eventId), afterIds = afterList.rows.map(row => row.eventId), added = afterIds.filter(value => !beforeIds.includes(value));
  if (afterIds.length !== beforeIds.length + 1 || added.length !== 1 || added[0] !== target.eventId || beforeIds.some(value => !afterIds.includes(value))) fail('Final flight departure list did not prove exactly the claimed target event');
  const after = await baseline(page, target, required, afterList, product);
  after.departPortCatalog = await readDepartPortCatalog(page, target.productId);
  await nav(page, `${ORIGIN}/tour/product/${target.eventId}/change/`, 'Final flight event');
  return { afterList, after, persisted: verifyPersistedFlights(await readPersistedFlights(page, { eventId: target.eventId }), expectedPersisted(candidate.state.segments)) };
}

/** Isolated flight-included prepare/read/save adapter. Synthetic routed tests are not ERP evidence. */
export function createFlightDepartureAdapters() {
  return {
    departures: {
      async prepare(page, product, input, context) {
        const issue = flightDepartureInputIssue(product, input);
        if (issue) fail(issue);
        const index = context?.departureIndex;
        if (!Number.isSafeInteger(index) || index < 0 || index >= product.departures.length) fail('Invalid flight departure source index');
        const required = dependencies(context, product);
        const target = targetFor(required, product);
        const url = listUrl(target.masterCode);
        await nav(page, url, 'Flight departure list');
        await waitList(page);
        const beforeList = await readObservedDepartureList(page, { url, extractEventId: eventId });
        const before = await baseline(page, target, required, beforeList, product);
        await nav(page, `${ORIGIN}/tour/master_product/${target.productId}/create_product/?from=${target.productId}`, 'Flight create');
        await page.waitForLoadState('load');
        await page.waitForFunction(() => {
          const button = document.querySelector('#create_schedule_calendar');
          return button && (typeof button.onclick === 'function' || globalThis.jQuery?._data?.(button, 'events')?.click?.length > 0);
        }, undefined, { timeout: RESPONSE_TIMEOUT_MS });
        const preparedBase = await prepareBase(page, product, input, target, index, required.scheduleId);
        const segments = flightDepartureSegments(product, input, index);
        const coverage = flightDepartureCoverage(product, input, index);
        const form = await prepareFlightForm(page, readerTarget(target), segments);
        const entries = await nativeEntries(page);
        requiredEntries(entries, target, required.scheduleId, product, index, input, preparedBase.base);
        const candidate = candidateFor({ product, input, index, target, scheduleId: required.scheduleId, segments, coverage, form, base: preparedBase.base, entries });
        return structuredClone({ candidate, before, beforeList });
      },
      async read(page, product, input, context) {
        const issue = flightDepartureInputIssue(product, input);
        if (issue) fail(issue);
        const candidate = checkPrepared(context?.prepared, product, input, context);
        await verifyBaseSelections(page, input, candidate.source.target, candidate.state.base);
        const current = await readFlightForm(page, readerTarget(candidate.source.target));
        if (!same(current.segments, candidate.state.segments) || !same(current.calendar, candidate.state.form.calendar)) fail('Prepared flight fields changed');
        assertNativeEntries(await nativeEntries(page), candidate.state.nativeEntries, 'during read');
        return structuredClone(context.prepared);
      },
      async reconcile(page, product, input, context, target) {
        const issue = flightDepartureInputIssue(product, input);
        if (issue) fail(issue);
        const required = dependencies(context, product), checkedTarget = reconcileTarget(target, required);
        if (typeof context?.assertIdentity !== 'function') fail('Flight identity guard is required for final reconciliation');
        const saved = reconcilePrepared(context, product, input, required, checkedTarget);
        const guard = await installReadOnlyDepartureGuard(page);
        try {
          await context.assertIdentity();
          const first = await readFinalFlightProof(page, checkedTarget, required, saved.prepared, product, saved.candidate);
          const second = await readFinalFlightProof(page, checkedTarget, required, saved.prepared, product, saved.candidate);
          if (!same(first, second)) fail('Final flight reconciliation readback changed during reconciliation');
          const checked = verifyResult(saved.prepared.before, first.after, checkedTarget.eventId, expectedPriceForReconcile(product, input, saved.index), saved.sourceTarget, product, saved.index, saved.candidate.state.base);
          await context.assertIdentity(); guard.verify();
          return { status: 'departure-persistence-verified', productId: checkedTarget.productId, eventId: checkedTarget.eventId, url: `${ORIGIN}/tour/product/${checkedTarget.eventId}/change/`, sourceScheduleId: checkedTarget.scheduleId, copiedScheduleId: checked.copiedScheduleId, canCommit: false, flightVerification: { ...first.persisted, coverage: structuredClone(saved.candidate.state.coverage) } };
        } finally { await guard.close(); }
      },
      async save(page, prepared, input, context) {
        const issue = flightDepartureInputIssue(context?.product, input);
        if (issue) fail(issue);
        const candidate = checkPrepared(prepared, context.product, input, context);
        if (typeof context?.assertIdentity !== 'function' || typeof context?.claimDeparture !== 'function') fail('Flight identity guard and durable claim callback are required');
        await context.assertIdentity();
        await verifyBaseSelections(page, input, candidate.source.target, candidate.state.base);
        const actual = await readFlightForm(page, readerTarget(candidate.source.target));
        if (!same(actual.segments, candidate.state.segments) || !same(actual.calendar, candidate.state.form.calendar)) fail('Prepared flight fields changed');
        const entries = assertNativeEntries(await nativeEntries(page), candidate.state.nativeEntries, 'before confirmation');
        const expected = requiredEntries(entries, candidate.source.target, candidate.contract.sourceScheduleId, context.product, candidate.sourceDepartureIndex, input, candidate.state.base, { selectedDate: '' });
        const confirmedEntries = withSelectedDate(entries, candidate.contract.departureDate);
        const guard = await installDepartureTransportGuard(page, { productId: candidate.contract.productId, entries: postEntries(confirmedEntries) });
        let claimed = false;
        let observer;
        try {
          const yes = await confirm(page);
          const afterConfirmEntries = assertNativeEntries(await nativeEntries(page), confirmedEntries, 'after create confirmation');
          requiredEntries(afterConfirmEntries, candidate.source.target, candidate.contract.sourceScheduleId, context.product, candidate.sourceDepartureIndex, input, candidate.state.base, { selectedDate: candidate.contract.departureDate });
          await context.assertIdentity();
          await verifyBaseSelections(page, input, candidate.source.target, candidate.state.base);
          const beforeClaim = await readFlightForm(page, readerTarget(candidate.source.target));
          if (!same(beforeClaim.segments, candidate.state.segments) || !same(beforeClaim.calendar, candidate.state.form.calendar)) fail('Prepared flight fields changed before claim');
          assertNativeEntries(await nativeEntries(page), confirmedEntries, 'before claim');
          const claim = await context.claimDeparture(candidate);
          if (claim?.status !== 'claimed' || !ID.test(claim?.claimId ?? '')) fail('Durable flight departure claim failed');
          claimed = true;
          await context.assertIdentity();
          await verifyBaseSelections(page, input, candidate.source.target, candidate.state.base);
          const final = await readFlightForm(page, readerTarget(candidate.source.target));
          if (!same(final.segments, candidate.state.segments) || !same(final.calendar, candidate.state.form.calendar)) fail('Prepared flight fields changed after claim');
          assertNativeEntries(await nativeEntries(page), confirmedEntries, 'after claim');
          await verifyBaseSelections(page, input, candidate.source.target, candidate.state.base);
          observer = observe(page, `${ORIGIN}/tour/master_product/${candidate.contract.productId}/create_product/`);
          guard.arm();
          await yes.click({ timeout: RESPONSE_TIMEOUT_MS });
          await observer.wait();
          if (!observer.bound() || guard.count !== 1) fail('Flight transport did not forward exactly one request');
          const required = dependencies(context, context.product);
          const result = await afterSave(page, candidate.source.target, required, { url: prepared.beforeList.url, extractEventId: eventId }, prepared.beforeList, context.product, candidate.state.base);
          const priceExpectation = { currency_code: 'KRW', adult_base_price: expected.adult_price, child_base_price: expected.child_price, infant_base_price: expected.infant_price, adult_fuel_price: '0', child_fuel_price: '0', infant_fuel_price: '0', min_pax_count: expected.min_pax_count, max_pax_count: expected.max_pax_count, payment_full_flag: 'False', payment_deposit_flag: 'False', payment_deposit_person: '0', payment_deposit_infant: false, estimate_term_id: '', use_custom_price: '0', custom_price_estimate: '', reward_type: '0', reward_value: '0.00', memberPriceRows: 0 };
          const checked = verifyResult(prepared.before, result.after, result.eventId, priceExpectation, candidate.source.target, context.product, candidate.sourceDepartureIndex, candidate.state.base);
          await nav(page, `${ORIGIN}/tour/product/${result.eventId}/change/`, 'Created flight event');
          const persisted = verifyPersistedFlights(await readPersistedFlights(page, { eventId: result.eventId }), expectedPersisted(candidate.state.segments));
          guard.verify();
          return { status: 'departure-persistence-verified', productId: candidate.contract.productId, eventId: result.eventId, url: `${ORIGIN}/tour/product/${result.eventId}/change/`, sourceScheduleId: candidate.contract.sourceScheduleId, copiedScheduleId: checked.copiedScheduleId, canCommit: false, flightVerification: { ...persisted, coverage: structuredClone(candidate.state.coverage) } };
        } catch (error) {
          if (claimed) {
            const unknown = new Error('reconcile-before-retry', { cause: error });
            unknown.code = 'UNKNOWN_SAVE_OUTCOME';
            throw unknown;
          }
          throw error;
        } finally {
          observer?.close();
          guard.seal();
        }
      }
    }
  };
}
