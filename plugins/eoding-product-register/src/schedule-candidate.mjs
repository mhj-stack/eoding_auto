import { canonical } from './core.mjs';
import { readBasicForm } from './basic-form.mjs';
import { prepareNewSchedule, readScheduleShell } from './schedule-form.mjs';
import { readScheduleList } from './schedule-read.mjs';
import { verifyScheduleCreation, UNKNOWN_SAVE_OUTCOME } from './schedule-result.mjs';
import { assertExactScheduleCreateRequest, installScheduleTransportGuard } from './schedule-transport.mjs';
import { parseScheduleCreateResponse } from './schedule-create-response.mjs';

const TIMEOUT_MS = 10_000;
const ORIGIN = 'https://schedule-fixture.invalid';
const POST_PATH = '/tour/master_product_schedule/add/';
const ID = /^[1-9]\d{0,9}$/;
const fail = message => { throw new Error(message); };
const clone = value => structuredClone(value);
const same = (left, right) => canonical(left) === canonical(right);

export function assertScheduleCandidateContract(page) {
  const url = new URL(page.url());
  if (url.origin !== ORIGIN || url.username || url.password) fail('Live schedule save blocked: candidate is restricted to the reserved synthetic fixture');
  return url;
}
function exactObject(value, keys, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail(message);
}
function exactText(value, name) {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 20_000) fail('Invalid exact ' + name);
  return value;
}
function id(value, name) { if (typeof value !== 'string' || !ID.test(value)) fail('Invalid ' + name); return value; }
function target(value) {
  exactObject(value, ['productId', 'masterCode', 'title', 'account'], 'Invalid schedule target');
  return { productId: id(value.productId, 'product ID'), masterCode: exactText(value.masterCode, 'master code'), title: exactText(value.title, 'product title'), account: exactText(value.account, 'account') };
}
function scheduleFields(value) {
  exactObject(value, ['title', 'nights', 'days'], 'Invalid schedule fields');
  const title = exactText(value.title, 'schedule title');
  if (!Number.isInteger(value.nights) || value.nights < 0 || value.nights > 365 || !Number.isInteger(value.days) || value.days < 1 || value.days > 366 || value.nights >= value.days) fail('Invalid schedule duration');
  return { title, nights: value.nights, days: value.days };
}
function productSettings(product) {
  if (!product || product.currency !== 'KRW' || !['domestic', 'overseas'].includes(product.tripType) || typeof product.includesFlight !== 'boolean' || !['included', 'excluded'].includes(product.company?.vat)) fail('Invalid source product settings');
  return { currency: product.currency, includesFlight: product.includesFlight ? '항공포함' : '항공미포함', tripType: product.tripType === 'domestic' ? '국내' : '해외', vat: product.company.vat === 'included' ? '부가세 포함' : '부가세 미포함' };
}
function checkedModalFields(value, requested) {
  exactObject(value, ['title', 'nights', 'days'], 'Invalid schedule modal fields');
  if (value.title !== requested.title || value.nights !== String(requested.nights) || value.days !== String(requested.days)) fail('Schedule modal values changed since preparation');
  // Do not parse/repair user controls: canonical strings are required exactly.
  if (!/^(?:0|[1-9]\d*)$/.test(value.nights) || !/^[1-9]\d*$/.test(value.days)) fail('Invalid canonical schedule controls');
  return { title: value.title, nights: value.nights, days: value.days };
}
function normaliseBefore(value, productId, requested) {
  exactObject(value, ['productId', 'schedules'], 'Invalid schedule candidate baseline');
  if (value.productId !== productId || !Array.isArray(value.schedules)) fail('Invalid schedule candidate baseline');
  const ids = new Set(), titles = new Set();
  const schedules = value.schedules.map(row => {
    exactObject(row, ['scheduleId', 'title', 'nights', 'days'], 'Invalid schedule candidate baseline row');
    const checked = scheduleFields({ title: row.title, nights: row.nights, days: row.days });
    const scheduleId = id(row.scheduleId, 'baseline schedule ID');
    if (ids.has(scheduleId) || titles.has(checked.title)) fail('Duplicate schedule candidate baseline row');
    ids.add(scheduleId); titles.add(checked.title); return { scheduleId, ...checked };
  }).sort((left, right) => left.scheduleId.localeCompare(right.scheduleId));
  if (titles.has(requested.title)) fail('Duplicate schedule title');
  return { productId, schedules };
}
function normaliseBasic(basic) { const { url, documentTitle, ...state } = basic ?? {}; return clone(state); }
function checkedSnapshot(value) {
  exactObject(value, ['target', 'basic', 'fields', 'before'], 'Invalid schedule candidate snapshot');
  const checkedTarget = target(value.target); exactObject(value.fields, ['title', 'nights', 'days'], 'Invalid schedule candidate fields');
  if (!/^(?:0|[1-9]\d*)$/.test(value.fields.nights) || !/^[1-9]\d*$/.test(value.fields.days)) fail('Invalid canonical schedule controls');
  const requested = scheduleFields({ title: value.fields.title, nights: Number(value.fields.nights), days: Number(value.fields.days) });
  if (value.fields.nights !== String(requested.nights) || value.fields.days !== String(requested.days)) fail('Invalid canonical schedule controls');
  const fields = checkedModalFields(value.fields, requested);
  const before = normaliseBefore(value.before, checkedTarget.productId, requested);
  if (!value.basic || typeof value.basic !== 'object' || Array.isArray(value.basic)) fail('Invalid schedule candidate basic state');
  return clone({ target: checkedTarget, basic: value.basic, fields, before });
}
function assertBasic(basic, wanted, sourceSettings) {
  const immutableKeys = ['currency', 'includesFlight', 'tripType', 'vat'];
  if (!basic || basic.status !== '2' || basic.masterCode !== wanted.masterCode || basic.title !== wanted.title || !same(basic.settings, sourceSettings) || immutableKeys.some(key => basic.settingsDisabled?.[key] !== true)) fail('Private basic identity or source settings changed');
  return normaliseBasic(basic);
}

/** Fixture-only end-to-end candidate preparation: no write occurs here. */
export async function prepareScheduleCandidate(page, product, inputTarget, inputSchedule) {
  const wanted = target(inputTarget), requested = scheduleFields(inputSchedule), settings = productSettings(product);
  if (wanted.title !== product.title || requested.nights !== product.nights || requested.days !== product.days) fail('Source product and schedule target mismatch');
  assertScheduleCandidateContract(page);
  const beforeBasic = assertBasic(await readBasicForm(page), wanted, settings);
  await prepareNewSchedule(page, wanted, requested);
  assertScheduleCandidateContract(page);
  const shell = await readScheduleShell(page, wanted);
  const afterBasic = assertBasic(shell.basic, wanted, settings);
  if (!same(beforeBasic, afterBasic)) fail('Basic state changed during schedule preparation');
  const rawBefore = await readScheduleList(page, { productId: wanted.productId });
  const fields = checkedModalFields(shell.fields, requested);
  const before = normaliseBefore(rawBefore, wanted.productId, requested);
  // Fresh basic read after the tab transition is mandatory; an unloaded basic form fails closed.
  return clone({ target: wanted, basic: afterBasic, fields, before });
}

/** Freshly reads every reviewed surface. The original fixture origin is rechecked at both boundaries. */
export async function readScheduleCandidate(page, expected) {
  const snapshot = checkedSnapshot(expected); const wanted = target(snapshot.target);
  assertScheduleCandidateContract(page);
  const firstShell = await readScheduleShell(page, wanted);
  const firstBasic = assertBasic(firstShell.basic, wanted, snapshot.basic.settings);
  const rawBefore = await readScheduleList(page, { productId: wanted.productId });
  // The GET can yield control to page scripts; take a second complete allowlisted read.
  const shell = await readScheduleShell(page, wanted);
  const basic = assertBasic(shell.basic, wanted, snapshot.basic.settings);
  assertScheduleCandidateContract(page);
  const requested = { title: snapshot.fields.title, nights: Number(snapshot.fields.nights), days: Number(snapshot.fields.days) };
  const current = { target: wanted, basic, fields: checkedModalFields(shell.fields, requested), before: normaliseBefore(rawBefore, wanted.productId, requested) };
  if (!same(firstBasic, basic) || !same(current, snapshot)) fail('Schedule candidate changed since approval');
  return clone(current);
}

function unknown() { const error = new Error('reconcile-before-retry'); error.code = UNKNOWN_SAVE_OUTCOME; return error; }
function armCreateTracker(page, requested, productId, timeout) {
  let expectedRequest; let timer; let settled = false; let resolve; let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  // Mark handled immediately so rejected capture paths cannot become unhandled while click fails.
  promise.catch(() => {});
  const settle = (fn, value) => { if (!settled) { settled = true; fn(value); } };
  const onRequest = request => {
    if (request.frame() !== page.mainFrame() || request.method() !== 'POST' || request.url() !== ORIGIN + POST_PATH) return;
    if (expectedRequest) return settle(reject, new Error('Duplicate schedule create request'));
    try { assertExactScheduleCreateRequest(request, page, { title: requested.title, nights: requested.nights, days: requested.days, productId }); expectedRequest = request; } catch (error) { settle(reject, error); }
  };
  const onResponse = response => { if (expectedRequest && response.request() === expectedRequest) settle(resolve, response); };
  const onFailed = request => { if (expectedRequest && request === expectedRequest) settle(reject, new Error('Schedule create request failed')); };
  page.on('request', onRequest); page.on('response', onResponse); page.on('requestfailed', onFailed);
  timer = setTimeout(() => settle(reject, new Error('Schedule create response timed out')), timeout);
  return { promise, dispose() { clearTimeout(timer); page.off('request', onRequest); page.off('response', onResponse); page.off('requestfailed', onFailed); } };
}
async function withTimeout(operation, timeout, message) {
  let timer; const timerPromise = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeout); });
  try { return await Promise.race([operation, timerPromise]); } finally { clearTimeout(timer); }
}

/** One fixture-only UI click, exact response capture, then independent GET reconciliation. */
export async function clickSaveScheduleCandidateAndVerify(page, expected, { beforeClick, timeout = TIMEOUT_MS } = {}) {
  const snapshot = checkedSnapshot(expected); const wanted = target(snapshot.target); const requested = { title: snapshot.fields.title, nights: Number(snapshot.fields.nights), days: Number(snapshot.fields.days) };
  let guard;
  try {
    await readScheduleCandidate(page, snapshot);
    const button = page.locator('#add_schedule_modal #create_new_schedule').filter({ visible: true });
    if (await button.count() !== 1) fail('Missing or ambiguous schedule create button');
    guard = await installScheduleTransportGuard(page, { title: requested.title, nights: requested.nights, days: requested.days, productId: wanted.productId });
    if (beforeClick) await beforeClick();
    assertScheduleCandidateContract(page);
    const tracker = armCreateTracker(page, requested, wanted.productId, timeout);
    let response;
    try { guard.arm(); await button.click({ timeout: TIMEOUT_MS }); response = await tracker.promise; } finally { tracker.dispose(); }
    if (response.status() !== 200 || response.url() !== ORIGIN + POST_PATH || response.request().frame() !== page.mainFrame()) fail('Schedule create response was not exact successful response');
    const body = await withTimeout(response.json(), timeout, 'Schedule create response body timed out');
    const { scheduleId } = parseScheduleCreateResponse(body, requested);
    assertScheduleCandidateContract(page);
    const result = await verifyScheduleCreation(page, { productId: wanted.productId, assignedScheduleId: scheduleId, requested, before: clone(snapshot.before) });
    const basic = assertBasic(await readBasicForm(page), wanted, snapshot.basic.settings);
    if (!same(basic, snapshot.basic)) fail('Basic state changed after schedule save');
    assertScheduleCandidateContract(page);
    return { status: 'schedule-saved', productId: wanted.productId, scheduleId, fields: requested, verification: result.status };
  } catch (cause) { throw unknown(cause); } finally { guard?.seal(); }
}
