import { buildDeparturePlan } from './departure-plan.mjs';
import { DepartureTarget } from './departure-form.mjs';

const PRICE_KINDS = Object.freeze(['adult', 'child', 'infant']);
const CONTRACT_KEYS = Object.freeze(['version', 'productId', 'sourceScheduleId', 'departureDate', 'returnDate', 'nights', 'days', 'masterCode', 'title', 'account', 'entries', 'priceExpectation', 'eventExpectation', 'transportExpectation', 'canCommit']);
const STATE_FIELDS = Object.freeze(['id_status', 'id_title', 'id_currency_code', 'id_schedule', 'id_product_division_label', 'id_manager', 'id_dept', 'id_dept2', 'start-date', 'end-date']);
const STATE_PRICES = Object.freeze(['id_adult_price', 'id_child_price', 'id_infant_price', 'id_adult_fuel_price', 'id_child_fuel_price', 'id_infant_fuel_price', 'id_min_pax_count', 'id_max_pax_count']);
const DEFAULT_KEYS = Object.freeze(['id_payment_full_flag', 'id_payment_deposit_flag', 'id_payment_deposit_person', 'id_reward_type', 'id_reward_value', 'id_use_custom_price', 'id_default_contract_title', 'id_estimate_term_id', 'id_form-TOTAL_FORMS', 'contracts', 'excludeInfant', 'sameOperator']);
const PRICE_EXPECTATION_KEYS = Object.freeze(['currency_code', 'adult_base_price', 'child_base_price', 'infant_base_price', 'adult_fuel_price', 'child_fuel_price', 'infant_fuel_price', 'min_pax_count', 'max_pax_count', 'payment_full_flag', 'payment_deposit_flag', 'payment_deposit_person', 'payment_deposit_infant', 'estimate_term_id', 'use_custom_price', 'custom_price_estimate', 'reward_type', 'reward_value', 'memberPriceRows']);
const EVENT_EXPECTATION_KEYS = Object.freeze(['id_status', 'id_title', 'id_dept', 'id_dept2', 'id_manager', 'id_min_pax_count', 'id_max_pax_count', 'id_res_count', 'id_currency_code', 'id_adult_total_price', 'id_child_total_price', 'id_infant_total_price', 'id_master_product_code', 'id_tour_season']);

const fail = message => { throw new Error(message); };
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const exactKeys = (value, keys, label) => {
  if (!plain(value) || Object.keys(value).length !== keys.length || keys.some(key => !own(value, key))) fail(`Invalid ${label} shape`);
};
const id = value => typeof value === 'string' && /^[1-9]\d{0,9}$/.test(value) && Number.isSafeInteger(Number(value));
const amount = value => Number.isSafeInteger(value) && value >= 0;
const decimal = value => typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value) && Number.isSafeInteger(Number(value));
const text = value => typeof value === 'string' && value.length > 0 && value === value.trim() && !/[<>\u0000-\u001f]/.test(value);
const date = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
};
const canonicalAmount = value => {
  if (!amount(value)) fail('Invalid integer amount');
  return String(value);
};
const displayAmount = value => canonicalAmount(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const displayDate = value => value.replace(/-/g, '/');
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const pairKey = pair => JSON.stringify(pair);
const multiset = values => {
  const counts = new Map();
  for (const value of values) counts.set(pairKey(value), (counts.get(pairKey(value)) ?? 0) + 1);
  return counts;
};
const sameMultiset = (left, right) => {
  const a = multiset(left), b = multiset(right);
  return a.size === b.size && [...a].every(([key, count]) => b.get(key) === count);
};

function validCalendarDate(entry) {
  if (!plain(entry) || Object.keys(entry).length !== 4 || !['year', 'month', 'day', 'selected'].every(key => own(entry, key))) fail('Invalid calendar shape');
  if (typeof entry.year !== 'string' || !/^\d{4}$/.test(entry.year) || !decimal(entry.month) || !decimal(entry.day) || entry.selected !== true) fail('Malformed calendar');
  const month = Number(entry.month) + 1, day = Number(entry.day);
  const value = `${entry.year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  if (month < 1 || month > 12 || day < 1 || day > 31 || !date(value)) fail('Invalid calendar date');
  return value;
}

function selectedOperator(value, expectedLabel, label) {
  if (!Array.isArray(value) || value.length !== 1 || !plain(value[0]) || Object.keys(value[0]).length !== 2 || !own(value[0], 'value') || !own(value[0], 'label')) fail(`Invalid ${label} operator`);
  if (!id(value[0].value) || value[0].label !== expectedLabel || !text(value[0].label)) fail(`Prepared ${label} operator mismatch`);
  return value[0];
}

function validatePreparedState(preparedState, target, item, options) {
  if (!plain(preparedState)) fail('Invalid prepared state');
  const expectedStateKeys = ['fields', 'prices', 'operators', 'defaults', 'calendar', 'selected'];
  const actualKeys = Object.keys(preparedState);
  if (!actualKeys.every(key => expectedStateKeys.includes(key) || key === 'target') || !expectedStateKeys.every(key => own(preparedState, key))) fail('Invalid prepared state shape');
  if (own(preparedState, 'target')) {
    const parsed = DepartureTarget.safeParse(preparedState.target);
    if (!parsed.success || !same(parsed.data, target)) fail('Prepared target mismatch');
  }
  exactKeys(preparedState.fields, STATE_FIELDS, 'prepared fields');
  exactKeys(preparedState.prices, STATE_PRICES, 'prepared prices');
  exactKeys(preparedState.defaults, DEFAULT_KEYS, 'prepared defaults');
  if (!plain(preparedState.operators) || Object.keys(preparedState.operators).length !== 2 || !own(preparedState.operators, 'id_depart_airline') || !own(preparedState.operators, 'id_return_airline')) fail('Invalid prepared operators shape');

  const fields = preparedState.fields, prices = preparedState.prices, defaults = preparedState.defaults;
  if (fields.id_status !== '4' || fields.id_title !== target.title || fields.id_currency_code !== 'KRW' || fields.id_schedule !== options.savedScheduleId || fields.id_product_division_label !== options.divisionId || fields['start-date'] !== item.departureDate || fields['end-date'] !== item.departureDate) fail('Prepared field mismatch');
  for (const key of ['id_manager', 'id_dept', 'id_dept2']) if (!id(fields[key])) fail(`Missing inherited ${key}`);
  for (const key of STATE_PRICES) if (!amount(prices[key])) fail(`Invalid prepared ${key}`);
  for (const kind of PRICE_KINDS) {
    const expectedFuel = item.fuelIncluded ? 0 : item.fuelSurcharges[kind]?.amount;
    if (prices[`id_${kind}_price`] !== item.prices[kind].amount || prices[`id_${kind}_fuel_price`] !== expectedFuel) fail('Prepared price mismatch');
  }
  if (prices.id_min_pax_count !== item.minPax || prices.id_max_pax_count !== item.maxPax || prices.id_min_pax_count > prices.id_max_pax_count || prices.id_max_pax_count < 1) fail('Prepared passenger mismatch');
  const outbound = selectedOperator(preparedState.operators.id_depart_airline, item.operators.outbound.label, 'outbound');
  const inbound = selectedOperator(preparedState.operators.id_return_airline, item.operators.return.label, 'return');
  if (defaults.id_payment_full_flag !== 'False' || defaults.id_payment_deposit_flag !== 'False' || defaults.id_payment_deposit_person !== '0' || defaults.id_reward_type !== '0' || defaults.id_reward_value !== '0' || defaults.id_use_custom_price !== '0' || defaults.id_default_contract_title !== '' || defaults.id_estimate_term_id !== '' || defaults['id_form-TOTAL_FORMS'] !== '0' || !Array.isArray(defaults.contracts) || defaults.contracts.length !== 2 || defaults.contracts.some(Boolean) || defaults.excludeInfant !== false || defaults.sameOperator !== false) fail('Unexpected departure defaults');
  if (!Array.isArray(preparedState.calendar) || preparedState.calendar.length !== 1 || !Array.isArray(preparedState.selected) || preparedState.selected.length !== 1 || preparedState.selected[0] !== item.departureDate || validCalendarDate(preparedState.calendar[0]) !== item.departureDate) fail('Prepared calendar mismatch');
  return { fields, prices, outbound, inbound };
}

function expectedEntries(contract) {
  const price = contract.priceExpectation, event = contract.eventExpectation;
  return [
    ['master_product_id', contract.productId], ['status', event.id_status], ['title', contract.title], ['dept', event.id_dept], ['dept2', event.id_dept2], ['manager', event.id_manager], ['product_division_label', contract.entries?.find?.(([name]) => name === 'product_division_label')?.[1]], ['schedule', contract.sourceScheduleId], ['currency_code', price.currency_code],
    ['adult_price', price.adult_base_price], ['child_price', price.child_base_price], ['infant_price', price.infant_base_price], ['adult_fuel_price', price.adult_fuel_price], ['child_fuel_price', price.child_fuel_price], ['infant_fuel_price', price.infant_fuel_price],
    ['payment_full_flag', price.payment_full_flag], ['payment_deposit_flag', price.payment_deposit_flag], ['payment_deposit_person', price.payment_deposit_person], ['reward_type', price.reward_type], ['reward_value', '0'], ['use_custom_price', price.use_custom_price], ['custom_price_estimate', price.custom_price_estimate], ['form-TOTAL_FORMS', '0'], ['form-INITIAL_FORMS', '0'], ['form-MIN_NUM_FORMS', '0'], ['form-MAX_NUM_FORMS', '1000'], ['min_pax_count', price.min_pax_count], ['max_pax_count', price.max_pax_count], ['selected_dates', contract.departureDate], ['master_product_id', contract.productId], ['default_contract_id', ''], ['estimate_term_id', price.estimate_term_id], ['depart_airline', contract.entries?.find?.(([name]) => name === 'depart_airline')?.[1]], ['return_airline', contract.entries?.find?.(([name]) => name === 'return_airline')?.[1]], ['default_contract_id', ''], ['default_contract_title', '']
  ];
}

function validateContract(contract) {
  exactKeys(contract, CONTRACT_KEYS, 'departure contract');
  if (contract.version !== 1 || contract.canCommit !== false || !id(contract.productId) || !id(contract.sourceScheduleId) || !date(contract.departureDate) || !date(contract.returnDate) || !Number.isSafeInteger(contract.nights) || contract.nights < 0 || !Number.isSafeInteger(contract.days) || contract.days < 1 || contract.nights !== contract.days - 1 || !text(contract.masterCode) || !text(contract.title) || !text(contract.account)) fail('Invalid departure contract');
  const duration = (Date.parse(contract.returnDate) - Date.parse(contract.departureDate)) / 86400000 + 1;
  if (duration !== contract.days) fail('Invalid contract dates');
  exactKeys(contract.priceExpectation, PRICE_EXPECTATION_KEYS, 'price expectation');
  exactKeys(contract.eventExpectation, EVENT_EXPECTATION_KEYS, 'event expectation');
  exactKeys(contract.transportExpectation, ['outbound', 'inbound'], 'transport expectation');
  const price = contract.priceExpectation, event = contract.eventExpectation;
  if (price.currency_code !== 'KRW' || !PRICE_KINDS.every(kind => decimal(price[`${kind}_base_price`]) && price[`${kind}_fuel_price`] === '0') || !decimal(price.min_pax_count) || !decimal(price.max_pax_count) || Number(price.min_pax_count) > Number(price.max_pax_count) || price.payment_full_flag !== 'False' || price.payment_deposit_flag !== 'False' || price.payment_deposit_person !== '0' || price.payment_deposit_infant !== false || price.estimate_term_id !== '' || price.use_custom_price !== '0' || price.custom_price_estimate !== '' || price.reward_type !== '0' || price.reward_value !== '0.00' || price.memberPriceRows !== 0) fail('Invalid price expectation');
  if (event.id_status !== '4' || event.id_title !== contract.title || !id(event.id_dept) || !id(event.id_dept2) || !id(event.id_manager) || event.id_min_pax_count !== price.min_pax_count || event.id_max_pax_count !== price.max_pax_count || event.id_res_count !== '0' || event.id_currency_code !== price.currency_code || !PRICE_KINDS.every(kind => event[`id_${kind}_total_price`] === displayAmount(Number(price[`${kind}_base_price`]))) || event.id_master_product_code !== contract.masterCode || event.id_tour_season !== `${displayDate(contract.departureDate)} ~ ${displayDate(contract.returnDate)} (${contract.nights}박${contract.days}일)`) fail('Invalid event expectation');
  for (const key of ['outbound', 'inbound']) {
    exactKeys(contract.transportExpectation[key], ['id', 'label'], `${key} transport expectation`);
    if (!id(contract.transportExpectation[key].id) || !text(contract.transportExpectation[key].label)) fail('Invalid transport expectation');
  }
  if (!Array.isArray(contract.entries) || contract.entries.length !== 36 || contract.entries.some(pair => !Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || typeof pair[1] !== 'string')) fail('Invalid contract entries');
  const nativeValue = name => {
    const pairs = contract.entries.filter(([entryName]) => entryName === name);
    return pairs.length === 1 ? pairs[0][1] : null;
  };
  if (!id(nativeValue('product_division_label')) || !id(nativeValue('depart_airline')) || !id(nativeValue('return_airline'))) fail('Invalid contract entries');
  const expected = expectedEntries(contract);
  if (!sameMultiset(contract.entries, expected)) fail('Contract entry multiset mismatch');
  return expected;
}

/** Builds a pure, non-authorizing native multipart contract from a verified prepared departure state. */
export function buildDepartureContract({ product, options, target: inputTarget, index, preparedState }) {
  const target = DepartureTarget.parse(inputTarget);
  if (!Number.isSafeInteger(index) || index < 0) fail('Invalid source departure index');
  if (!id(options?.savedScheduleId) || !id(options?.divisionId)) fail('Canonical ERP IDs required');
  const plan = buildDeparturePlan(product, options);
  if (!plan.readyForReview || plan.canCommit !== false) fail('Departure plan needs input');
  const item = plan.departures.filter(value => value.sourceDepartureIndex === index);
  if (item.length !== 1) fail('Missing source departure');
  const source = item[0];
  if (product?.includesFlight !== false || product?.currency !== 'KRW' || target.title !== product.title || target.account !== options.expectedAccountName || !date(source.departureDate) || !date(source.sourceReturnDate) || product.nights !== product.days - 1 || (Date.parse(source.sourceReturnDate) - Date.parse(source.departureDate)) / 86400000 + 1 !== product.days) fail('Incompatible departure source');
  const prepared = validatePreparedState(preparedState, target, source, options);
  if (PRICE_KINDS.some(kind => prepared.prices[`id_${kind}_fuel_price`] !== 0)) fail('Nonzero fuel totals are not proven for event readback');
  const priceExpectation = {
    currency_code: 'KRW', adult_base_price: canonicalAmount(prepared.prices.id_adult_price), child_base_price: canonicalAmount(prepared.prices.id_child_price), infant_base_price: canonicalAmount(prepared.prices.id_infant_price), adult_fuel_price: canonicalAmount(prepared.prices.id_adult_fuel_price), child_fuel_price: canonicalAmount(prepared.prices.id_child_fuel_price), infant_fuel_price: canonicalAmount(prepared.prices.id_infant_fuel_price), min_pax_count: canonicalAmount(prepared.prices.id_min_pax_count), max_pax_count: canonicalAmount(prepared.prices.id_max_pax_count), payment_full_flag: 'False', payment_deposit_flag: 'False', payment_deposit_person: '0', payment_deposit_infant: false, estimate_term_id: '', use_custom_price: '0', custom_price_estimate: '', reward_type: '0', reward_value: '0.00', memberPriceRows: 0
  };
  const eventExpectation = {
    id_status: '4', id_title: target.title, id_dept: prepared.fields.id_dept, id_dept2: prepared.fields.id_dept2, id_manager: prepared.fields.id_manager, id_min_pax_count: priceExpectation.min_pax_count, id_max_pax_count: priceExpectation.max_pax_count, id_res_count: '0', id_currency_code: 'KRW', id_adult_total_price: displayAmount(prepared.prices.id_adult_price), id_child_total_price: displayAmount(prepared.prices.id_child_price), id_infant_total_price: displayAmount(prepared.prices.id_infant_price), id_master_product_code: target.masterCode, id_tour_season: `${displayDate(source.departureDate)} ~ ${displayDate(source.sourceReturnDate)} (${product.nights}박${product.days}일)`
  };
  const transportExpectation = { outbound: { id: prepared.outbound.value, label: prepared.outbound.label }, inbound: { id: prepared.inbound.value, label: prepared.inbound.label } };
  const contract = { version: 1, productId: target.productId, sourceScheduleId: options.savedScheduleId, departureDate: source.departureDate, returnDate: source.sourceReturnDate, nights: product.nights, days: product.days, masterCode: target.masterCode, title: target.title, account: target.account, entries: [], priceExpectation, eventExpectation, transportExpectation, canCommit: false };
  contract.entries = [
    ['master_product_id', target.productId], ['status', '4'], ['title', target.title], ['dept', prepared.fields.id_dept], ['dept2', prepared.fields.id_dept2], ['manager', prepared.fields.id_manager], ['product_division_label', options.divisionId], ['schedule', options.savedScheduleId], ['currency_code', 'KRW'],
    ['adult_price', priceExpectation.adult_base_price], ['child_price', priceExpectation.child_base_price], ['infant_price', priceExpectation.infant_base_price], ['adult_fuel_price', priceExpectation.adult_fuel_price], ['child_fuel_price', priceExpectation.child_fuel_price], ['infant_fuel_price', priceExpectation.infant_fuel_price],
    ['payment_full_flag', 'False'], ['payment_deposit_flag', 'False'], ['payment_deposit_person', '0'], ['reward_type', '0'], ['reward_value', '0'], ['use_custom_price', '0'], ['custom_price_estimate', ''], ['form-TOTAL_FORMS', '0'], ['form-INITIAL_FORMS', '0'], ['form-MIN_NUM_FORMS', '0'], ['form-MAX_NUM_FORMS', '1000'], ['min_pax_count', priceExpectation.min_pax_count], ['max_pax_count', priceExpectation.max_pax_count], ['selected_dates', source.departureDate], ['master_product_id', target.productId], ['default_contract_id', ''], ['estimate_term_id', ''], ['depart_airline', prepared.outbound.value], ['return_airline', prepared.inbound.value], ['default_contract_id', ''], ['default_contract_title', '']
  ];
  validateContract(contract);
  return contract;
}

/** Validates a native multipart body as the exact multiset specified by a valid non-authorizing contract. */
export function assertDepartureEntries(actual, contract) {
  const expected = validateContract(contract);
  if (!Array.isArray(actual) || actual.some(pair => !Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || typeof pair[1] !== 'string') || !sameMultiset(actual, expected)) fail('Departure entry multiset mismatch');
}
