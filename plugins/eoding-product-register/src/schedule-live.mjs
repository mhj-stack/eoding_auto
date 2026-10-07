import { canonical } from './core.mjs';
import { readBasicForm } from './basic-form.mjs';
import { prepareNewSchedule, readScheduleShell } from './schedule-form.mjs';
import { readScheduleList } from './schedule-read.mjs';
import { parseScheduleCreateResponse } from './schedule-create-response.mjs';
import { verifyScheduleCreation, UNKNOWN_SAVE_OUTCOME } from './schedule-result.mjs';
import { requireScheduleSession } from './schedule-session.mjs';
import { installLiveScheduleTransportGuard } from './schedule-live-transport.mjs';

const ORIGIN = 'https://basecamp.team';
const POST_URL = ORIGIN + '/tour/master_product_schedule/add/';
const TIMEOUT_MS = 10_000;
const ID = /^[1-9]\d{0,9}$/;
const runtimes = new WeakMap();
const fail = message => { throw new Error(message); };
const clone = value => structuredClone(value);
const same = (left, right) => canonical(left) === canonical(right);

function exact(value, keys, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail(message);
}
function text(value, name) {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 20_000) fail('Invalid exact ' + name);
  return value;
}
function id(value, name) { if (typeof value !== 'string' || !ID.test(value)) fail('Invalid ' + name); return value; }
function target(value) {
  exact(value, ['productId', 'masterCode', 'title', 'account'], 'Invalid live schedule target');
  return { productId: id(value.productId, 'product ID'), masterCode: text(value.masterCode, 'master code'), title: text(value.title, 'product title'), account: text(value.account, 'account') };
}
function fields(value) {
  exact(value, ['title', 'nights', 'days'], 'Invalid live schedule fields');
  const title = text(value.title, 'schedule title');
  if (!Number.isInteger(value.nights) || value.nights < 0 || value.nights > 365 || !Number.isInteger(value.days) || value.days < 1 || value.days > 366 || value.nights >= value.days) fail('Invalid schedule duration');
  return { title, nights: value.nights, days: value.days };
}
function sourceSettings(product) {
  if (!product || typeof product !== 'object' || product.currency !== 'KRW' || !['domestic', 'overseas'].includes(product.tripType) || typeof product.includesFlight !== 'boolean' || !['included', 'excluded'].includes(product.company?.vat)) fail('Invalid source product settings');
  return { currency: product.currency, includesFlight: product.includesFlight ? '항공포함' : '항공미포함', tripType: product.tripType === 'domestic' ? '국내' : '해외', vat: product.company.vat === 'included' ? '부가세 포함' : '부가세 미포함' };
}
function detail(page, wanted) {
  const url = new URL(page.url());
  const expected = `/tour/master_product/${wanted.productId}/change/`;
  if (url.origin !== ORIGIN || url.username || url.password || url.search || (url.pathname !== expected) || (url.hash && url.hash !== '#schedule')) fail('Wrong live product detail URL');
}
function basicState(basic, wanted, settings) {
  if (!basic || basic.status !== '2' || basic.masterCode !== wanted.masterCode || basic.title !== wanted.title || !same(basic.settings, settings) || ['currency', 'includesFlight', 'tripType', 'vat'].some(key => basic.settingsDisabled?.[key] !== true)) fail('Private basic identity or source settings changed');
  const { url, documentTitle, ...stable } = basic;
  return clone(stable);
}
function modalFields(value, requested) {
  exact(value, ['title', 'nights', 'days'], 'Invalid schedule modal fields');
  if (value.title !== requested.title || value.nights !== String(requested.nights) || value.days !== String(requested.days) || !/^(?:0|[1-9]\d*)$/.test(value.nights) || !/^[1-9]\d*$/.test(value.days)) fail('Schedule modal values changed since preparation');
  return { title: value.title, nights: value.nights, days: value.days };
}
function before(value, wanted, requested) {
  exact(value, ['productId', 'schedules'], 'Invalid live schedule baseline');
  if (value.productId !== wanted.productId || !Array.isArray(value.schedules)) fail('Invalid live schedule baseline');
  const ids = new Set(), titles = new Set();
  const schedules = value.schedules.map(row => {
    exact(row, ['scheduleId', 'title', 'nights', 'days'], 'Invalid live schedule baseline row');
    const scheduleId = id(row.scheduleId, 'baseline schedule ID'); const checked = fields({ title: row.title, nights: row.nights, days: row.days });
    if (ids.has(scheduleId) || titles.has(checked.title)) fail('Duplicate live schedule baseline row');
    ids.add(scheduleId); titles.add(checked.title); return { scheduleId, ...checked };
  }).sort((left, right) => left.scheduleId.localeCompare(right.scheduleId));
  if (titles.has(requested.title)) fail('Duplicate schedule title');
  return { productId: wanted.productId, schedules };
}
function shellRows(value, wanted, requested) {
  if (!Array.isArray(value)) fail('Invalid live schedule shell rows');
  const number = (raw, name) => {
    if (typeof raw !== 'string' || !/^(?:0|[1-9]\d*)$/.test(raw.trim())) fail('Invalid live schedule shell ' + name);
    return Number(raw.trim());
  };
  return before({ productId: wanted.productId, schedules: value.map(row => {
    exact(row, ['id', 'title', 'nights', 'days'], 'Invalid live schedule shell row');
    return { scheduleId: row.id, title: row.title, nights: number(row.nights, 'nights'), days: number(row.days, 'days') };
  }) }, wanted, requested);
}
async function readShellRows(page, wanted, requested) {
  const rows = await page.locator('#schedule_list_table').evaluate(root => {
    const body = root.tagName === 'TBODY' ? root : root.querySelector(':scope > tbody');
    if (!body || body.parentElement !== root && root.tagName !== 'TBODY') return null;
    const children = [...body.children];
    const empty = children.length === 1 && children[0].matches('tr.empty:not([data-schedule-id])') ? children[0] : null;
    if (empty && empty.children.length === 1 && empty.firstElementChild.matches('td.empty[colspan="8"]') && empty.querySelectorAll('button.add_schedule[type="button"]').length === 1 && !empty.querySelector('input,select,textarea,table,[data-schedule-id]') && empty.textContent.replace(/\s+/g,'') === '등록된일정표가없습니다.하단의추가버튼을클릭하여일정표를등록해주세요.추가') return [];
    return children.map(row => {
      const one = selector => {
        const nodes = row.querySelectorAll(`:scope > ${selector}`);
        return nodes.length === 1 ? nodes[0].textContent : null;
      };
      return { id: row.tagName === 'TR' ? row.getAttribute('data-schedule-id') : null, title: one('td.schedule_title'), nights: one('td.schedule_night'), days: one('td.schedule_day') };
    });
  });
  return shellRows(rows, wanted, requested);
}
function snapshot(value) {
  exact(value, ['target', 'basic', 'fields', 'before', 'contextId'], 'Invalid live schedule snapshot');
  const wanted = target(value.target); const requested = fields({ title: value.fields?.title, nights: Number(value.fields?.nights), days: Number(value.fields?.days) });
  if (value.fields.nights !== String(requested.nights) || value.fields.days !== String(requested.days) || typeof value.contextId !== 'string' || !value.contextId) fail('Invalid live schedule snapshot');
  if (!value.basic || typeof value.basic !== 'object' || Array.isArray(value.basic)) fail('Invalid live schedule basic state');
  return clone({ target: wanted, basic: value.basic, fields: modalFields(value.fields, requested), before: before(value.before, wanted, requested), contextId: value.contextId });
}
function session(page, expectedContextId) {
  const owned = requireScheduleSession(page);
  if (expectedContextId && owned.contextId !== expectedContextId) fail('Live schedule session context changed');
  return owned;
}
function runtime(page, contextId) {
  const current = runtimes.get(page);
  if (!current || current.contextId !== contextId) fail('Live schedule preparation belongs to a different session');
  return current;
}
function unknown() { const error = new Error('reconcile-before-retry'); error.code = UNKNOWN_SAVE_OUTCOME; return error; }
function tracker(page, timeout) {
  let expected; let settled = false; let resolve; let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; }); promise.catch(() => {});
  const settle = (fn, value) => { if (!settled) { settled = true; fn(value); } };
  const onRequest = request => {
    if (request.frame() !== page.mainFrame() || request.method() !== 'POST' || request.url() !== POST_URL) return;
    if (expected) return settle(reject, new Error('Duplicate schedule create request'));
    expected = request;
  };
  const onResponse = response => { if (expected && response.request() === expected) settle(resolve, response); };
  const onFailed = request => { if (expected && request === expected) settle(reject, new Error('Schedule create request failed')); };
  page.on('request', onRequest); page.on('response', onResponse); page.on('requestfailed', onFailed);
  const timer = setTimeout(() => settle(reject, new Error('Schedule create response timed out')), timeout);
  return { promise, dispose() { clearTimeout(timer); page.off('request', onRequest); page.off('response', onResponse); page.off('requestfailed', onFailed); } };
}
async function responseJson(response, timeout) {
  let timer;
  const timed = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Schedule create response body timed out')), timeout); });
  try { return await Promise.race([response.json(), timed]); } finally { clearTimeout(timer); }
}

/** Prepare one unsaved, production-origin schedule shell in a dedicated browser session. */
export async function prepareLiveSchedule(page, inputProduct, inputTarget, inputSchedule) {
  const product = clone(inputProduct), wanted = target(clone(inputTarget)), requested = fields(clone(inputSchedule)), settings = sourceSettings(product);
  if (product.title !== wanted.title || product.nights !== requested.nights || product.days !== requested.days) fail('Source product and schedule target mismatch');
  const owned = session(page); detail(page, wanted);
  if (runtimes.has(page)) fail('Live schedule guard already installed; use a fresh dedicated session');
  const guard = await installLiveScheduleTransportGuard(page, { productId: wanted.productId, title: requested.title, nights: requested.nights, days: requested.days });
  const current = { contextId: owned.contextId, guard }; runtimes.set(page, current);
  try {
    const initial = basicState(await readBasicForm(page), wanted, settings);
    await prepareNewSchedule(page, wanted, requested);
    session(page, owned.contextId); detail(page, wanted);
    const shell = await readScheduleShell(page, wanted);
    const basic = basicState(shell.basic, wanted, settings);
    const initialRows = await readShellRows(page, wanted, requested);
    const list = before(await readScheduleList(page, { productId: wanted.productId }), wanted, requested);
    // A list GET can yield to page scripts; no stale basic/modal values may enter review.
    const finalShell = await readScheduleShell(page, wanted);
    const finalBasic = basicState(finalShell.basic, wanted, settings);
    const finalFields = modalFields(finalShell.fields, requested);
    const finalRows = await readShellRows(page, wanted, requested);
    const state = { target: wanted, basic: finalBasic, fields: finalFields, before: list, contextId: owned.contextId };
    if (!same(initial, basic) || !same(basic, finalBasic) || !same(modalFields(shell.fields, requested), finalFields) || !same(initialRows, list) || !same(list, finalRows)) fail('Basic or schedule shell changed during live schedule preparation');
    session(page, owned.contextId); detail(page, wanted);
    return clone(state);
  } catch (error) { guard.seal(); runtimes.delete(page); throw error; }
}

/** Read all reviewed surfaces afresh without exposing the runtime guard in the snapshot. */
export async function readLiveSchedule(page, expected) {
  const reviewed = snapshot(clone(expected)); const wanted = reviewed.target; const requested = fields({ title: reviewed.fields.title, nights: Number(reviewed.fields.nights), days: Number(reviewed.fields.days) });
  runtime(page, reviewed.contextId); session(page, reviewed.contextId); detail(page, wanted);
  const first = await readScheduleShell(page, wanted); const firstBasic = basicState(first.basic, wanted, reviewed.basic.settings);
  const firstRows = await readShellRows(page, wanted, requested);
  const list = before(await readScheduleList(page, { productId: wanted.productId }), wanted, requested);
  const shell = await readScheduleShell(page, wanted); const basic = basicState(shell.basic, wanted, reviewed.basic.settings);
  const finalRows = await readShellRows(page, wanted, requested);
  session(page, reviewed.contextId); detail(page, wanted);
  const current = { target: wanted, basic, fields: modalFields(shell.fields, requested), before: list, contextId: reviewed.contextId };
  if (!same(firstBasic, basic) || !same(firstRows, list) || !same(list, finalRows) || !same(finalRows, reviewed.before) || !same(current, reviewed)) fail('Live schedule changed since approval');
  return clone(current);
}

/** Exactly one guarded UI click followed by exact response parsing and independent server reconciliation. */
export async function saveLiveScheduleAndVerify(page, expected, { beforeClick, timeout = TIMEOUT_MS } = {}) {
  const reviewed = snapshot(clone(expected)); const wanted = reviewed.target; const requested = fields({ title: reviewed.fields.title, nights: Number(reviewed.fields.nights), days: Number(reviewed.fields.days) });
  let activeTracker;
  try {
    const current = await readLiveSchedule(page, reviewed);
    const button = page.locator('#add_schedule_modal #create_new_schedule').filter({ visible: true });
    if (await button.count() !== 1) fail('Missing or ambiguous schedule create button');
    if (beforeClick) await beforeClick();
    await readLiveSchedule(page, current);
    if (beforeClick) await beforeClick();
    const live = runtime(page, reviewed.contextId); session(page, reviewed.contextId); detail(page, wanted);
    activeTracker = tracker(page, timeout);
    let response;
    try { live.guard.arm(); await button.click({ timeout }); response = await activeTracker.promise; } finally { activeTracker.dispose(); activeTracker = undefined; }
    if (response.status() !== 200 || response.url() !== POST_URL || response.request().frame() !== page.mainFrame()) fail('Schedule create response was not exact successful response');
    const { scheduleId } = parseScheduleCreateResponse(await responseJson(response, timeout), requested);
    session(page, reviewed.contextId); detail(page, wanted);
    const verification = await verifyScheduleCreation(page, { productId: wanted.productId, assignedScheduleId: scheduleId, requested, before: clone(reviewed.before) });
    const basic = basicState(await readBasicForm(page), wanted, reviewed.basic.settings);
    if (!same(basic, reviewed.basic)) fail('Basic state changed after live schedule save');
    session(page, reviewed.contextId); detail(page, wanted);
    runtime(page, reviewed.contextId).guard.verify();
    return { status: 'schedule-saved', productId: wanted.productId, scheduleId, fields: requested, verification: verification.status };
  } catch { throw unknown(); } finally { activeTracker?.dispose(); const live = runtimes.get(page); live?.guard.seal(); }
}
