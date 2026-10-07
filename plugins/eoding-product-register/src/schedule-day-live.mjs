import { installStageTransport } from './stage-transport.mjs';
import { canonical, digest } from './core.mjs';
import { ScheduleDayTarget, clickSaveScheduleDayAndVerify, readScheduleDay } from './schedule-day.mjs';
import { readScheduleDetail, verifyPlainDayPersistence } from './schedule-detail-read.mjs';
import { requireScheduleSession } from './schedule-session.mjs';

const ORIGIN = 'https://basecamp.team';
const MAX_BODY_BYTES = 256 * 1024;
const ids = /^[1-9]\d{0,9}$/;
const guards = new WeakMap();
const fail = message => { throw new Error(message); };
const clone = value => structuredClone(value);
const same = (left, right) => canonical(left) === canonical(right);

function exact(value, keys, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail(message);
}
function text(value, label, { empty = false } = {}) {
  if (typeof value !== 'string' || value.length > 20_000 || (!empty && (!value || value !== value.trim()))) fail(`Invalid ${label}`);
  return value;
}
function positive(value, label, maximum = 366) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) fail(`Invalid ${label}`);
  return value;
}
function exactLocation(page, target) {
  let url;
  try { url = new URL(page.url()); } catch { fail('Wrong live schedule-day product URL'); }
  const pathname = `/tour/master_product/${target.productId}/change/`;
  if (url.origin !== ORIGIN || url.username || url.password || url.pathname !== pathname || url.search || (url.hash && url.hash !== '#schedule')) fail('Wrong live schedule-day product URL');
}
function nativeMeals(meals, title) {
  exact(meals, ['breakfast', 'lunch', 'dinner'], 'Invalid prepared day meals');
  const result = {};
  for (const kind of ['breakfast', 'lunch', 'dinner']) {
    exact(meals[kind], ['type', 'text'], `Invalid prepared ${kind} meal`);
    if (typeof meals[kind].type !== 'string' || !/^[1-9]\d*$/.test(meals[kind].type)) fail(`Invalid prepared ${kind} meal type`);
    result[`${kind}_type`] = positive(Number(meals[kind].type), `${kind} meal type`, Number.MAX_SAFE_INTEGER);
    result[`${kind}_text`] = text(meals[kind].text, `${kind} meal text`, { empty: true });
  }
  if(title!==null)result.title = text(title, 'prepared day title');
  return result;
}
function prepared(value) {
  exact(value, ['target', 'day', 'basic', 'schedule', 'title', 'details', 'meals', 'hotelIds'], 'Invalid prepared plain-day snapshot');
  const target = ScheduleDayTarget.parse(value.target);
  const day = positive(value.day, 'prepared day');
  if (!value.basic || typeof value.basic !== 'object' || Array.isArray(value.basic)) fail('Invalid prepared day private state');
  exact(value.schedule, ['code', 'title', 'nights', 'days', 'meeting', 'meetingRemark'], 'Invalid prepared schedule state');
  if (value.schedule.code !== target.scheduleCode || value.schedule.title !== target.scheduleTitle || !/^[1-9]\d*$/.test(value.schedule.days) || day > Number(value.schedule.days)) fail('Prepared schedule identity changed');
  if(value.title!==null)text(value.title, 'prepared day title');
  if (!Array.isArray(value.details) || value.details.length !== 1 || !Array.isArray(value.hotelIds) || value.hotelIds.length !== 0) fail('Only one prepared blank-day custom detail is supported');
  exact(value.details[0], ['type', 'newStep', 'title', 'short', 'description'], 'Invalid prepared custom detail');
  const detail = value.details[0];
  text(detail.title, 'prepared custom title');
  if (detail.type !== '7' || detail.newStep !== true || !detail.title || detail.title !== detail.title.trim() || (value.title!==null && detail.title !== value.title) || detail.short !== '') fail('Prepared custom detail is not a blank-day direct entry');
  text(detail.description, 'prepared custom description', { empty: true });
  const mealList = nativeMeals(value.meals, value.title);
  return clone({ target, day, basic: value.basic, schedule: value.schedule, title: value.title, details: [detail], meals: value.meals, hotelIds: [], mealList });
}
function blankNativeMeals(meals) {
  return same(meals, { breakfast_type: 16, breakfast_text: '', lunch_type: 16, lunch_text: '', dinner_type: 16, dinner_text: '' });
}
function unchangedBlankHotelBaseline(reviewed, before) {
  if (reviewed.title !== null || !blankNativeMeals(reviewed.mealList) || !before || typeof before !== 'object' || Array.isArray(before) || !Array.isArray(before.tree)) return false;
  const rows = before.tree.filter(row => row && typeof row === 'object' && !Array.isArray(row) && row.day === reviewed.day);
  if (rows.length !== 1) return false;
  const row = rows[0];
  return row.typeId === 2 && row.step === 999 && row.etc1 === '' && row.etc2 === '' && row.etc3 === '' && row.etc4 === '' && row.etc5 === '' && row.etc6 === '' && row.description === null && row.dayTitle === '' && same(row.meals, { breakfast: { type: 16, text: '' }, lunch: { type: 16, text: '' }, dinner: { type: 16, text: '' } });
}
function expectedPayload(reviewed, before) {
  const payload = {
    day: reviewed.day,
    product_id: reviewed.target.productId,
    updated_list: [],
    deleted_list: [],
    created_list: [{ type_id: 7, step: 1, etc1: reviewed.details[0].title, etc2: '', description: reviewed.details[0].description, images: [], day: reviewed.day }]
  };
  if (!unchangedBlankHotelBaseline(reviewed, before)) payload.meal_list = reviewed.mealList;
  return payload;
}
function reviewedUiState(reviewed) {
  const { mealList, ...state } = reviewed;
  return state;
}
function exactJsonPost(request, page, reviewed, before) {
  if (request.frame() !== page.mainFrame() || request.method() !== 'POST' || request.url() !== `${ORIGIN}/tour/master_product_schedule/${reviewed.target.scheduleId}/change/`) fail('Unexpected plain-day save request');
  const contentType = request.headers()['content-type'] ?? '';
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(contentType)) fail('Unexpected plain-day save request');
  const body = request.postDataBuffer();
  if (!body || body.length === 0 || body.length > MAX_BODY_BYTES) fail('Unexpected plain-day save request');
  let parsed;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); } catch { fail('Unexpected plain-day save request'); }
  const wanted = expectedPayload(reviewed, before);
  exact(parsed, Object.keys(wanted), 'Unexpected plain-day save request');
  if (!same(parsed, wanted)) fail('Unexpected plain-day save request');
}
async function installResponseRedirectBarrier(page) {
  let session;
  try {
    session = await page.context().newCDPSession(page);
    session.on('Fetch.requestPaused', async event => {
      try {
        const redirect = event.responseStatusCode >= 300 && event.responseStatusCode < 400;
        if (redirect && !['GET', 'HEAD'].includes(event.request.method)) await session.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' });
        else await session.send('Fetch.continueRequest', { requestId: event.requestId });
      } catch { await page.context().close().catch(() => {}); }
    });
    await session.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Response' }] });
    return session;
  } catch {
    await page.context().close().catch(() => {});
    fail('Plain-day redirect barrier installation failed');
  }
}
async function installGuard(page, reviewed, before) {
  const context = page.context();
  if (guards.has(context) && !guards.get(context).verified) fail('Plain-day transport guard already installed for this context');
  const state = { armed: false, sealed: true, permanent: false, consumed: false, forwarded: 0 };
  const forwarded = new WeakSet();
  let stage, verified = false;
  const guard = {
    get verified() { return verified; },
    verify() { stage.verify(); verified = true; },
    arm() {
      requireScheduleSession(page); exactLocation(page, reviewed.target);
      if (state.armed || state.permanent || state.sealed === false || state.consumed) fail('Plain-day transport guard cannot be rearmed');
      state.armed = true; state.sealed = false;
    },
    seal() { state.sealed = true; state.permanent = true; },
    get count() { return state.forwarded; }
  };
  const deny = route => { guard.seal(); return route.abort('blockedbyclient'); };
  const handler = async route => {
    const request = route.request();
    if (forwarded.has(request)) return route.fallback();
    let url;
    try { url = new URL(request.url()); } catch { return route.abort('blockedbyclient'); }
    if (request.method() === 'GET' || request.method() === 'HEAD') return route.fallback();
    // Block unrelated analytics/widgets without consuming or sealing the ERP write.
    if (url.origin !== ORIGIN) return route.abort('blockedbyclient');
    if (state.sealed || state.consumed || !state.armed) return deny(route);
    state.consumed = true;
    try { requireScheduleSession(page); exactLocation(page, reviewed.target); exactJsonPost(request, page, reviewed, before); }
    catch { return deny(route); }
    state.forwarded++;
    forwarded.add(request);
    return route.fallback();
  };
  guards.set(context, guard);
  try {
    stage = await installStageTransport(page, `day:${reviewed.target.productId}:${reviewed.target.scheduleId}:${reviewed.day}`, async () => {
      await context.route('**/*', handler);
      await page.route('**/*', handler);
      const barrier = await installResponseRedirectBarrier(page);
      return async () => { guard.seal(); await page.unroute('**/*', handler); await context.unroute('**/*', handler); await barrier.detach(); };
    });
  } catch {
    guard.seal(); await context.close().catch(() => {});
    fail('Plain-day transport guard installation failed');
  }
  return guard;
}
function unknown(cause) {
  const error = new Error('reconcile-before-retry');
  error.code = 'UNKNOWN_SAVE_OUTCOME';
  error.cause = cause;
  return error;
}

/**
 * Commit one previously prepared blank-day direct entry through the native UI only.
 * The caller owns approval/claim/journaling; any post-click failure is reconciliation-only.
 */
export async function savePreparedPlainDay(page, inputExpected, { before: inputBefore, beforeClick } = {}) {
  // Clone every mutable review value before the first await; caller mutation cannot widen the sole write.
  const reviewed = prepared(clone(inputExpected));
  const reviewedUi = reviewedUiState(reviewed);
  const baseline = clone(inputBefore);
  if (beforeClick !== undefined && typeof beforeClick !== 'function') fail('Invalid plain-day beforeClick callback');
  const owned = requireScheduleSession(page); exactLocation(page, reviewed.target);
  const guard = await installGuard(page, reviewed, baseline);
  let attempted = false;
  try {
    const uiBefore = await readScheduleDay(page, reviewed.target, reviewed.day);
    const serverBefore = await readScheduleDetail(page, { productId: reviewed.target.productId, scheduleId: reviewed.target.scheduleId });
    if (!same(uiBefore, reviewedUi) || !same(serverBefore, baseline)) fail('Prepared plain-day state or server baseline changed before save');
    if (beforeClick) await beforeClick();
    // The callback is allowed to assert identity only. Re-read both reviewed surfaces afterwards.
    if (requireScheduleSession(page).contextId !== owned.contextId) fail('Plain-day session context changed before save');
    exactLocation(page, reviewed.target);
    const finalUi = await readScheduleDay(page, reviewed.target, reviewed.day);
    const finalServer = await readScheduleDetail(page, { productId: reviewed.target.productId, scheduleId: reviewed.target.scheduleId });
    if (!same(finalUi, reviewedUi) || !same(finalServer, baseline)) fail('Plain-day identity or baseline changed before save');
    // A detail GET can yield to page scripts. Re-read the reviewed UI and identity callback immediately before arming.
    const postReadUi = await readScheduleDay(page, reviewed.target, reviewed.day);
    if (!same(postReadUi, reviewedUi)) fail('Plain-day UI changed during final server baseline read');
    if (beforeClick) await beforeClick();
    const immediateUi = await readScheduleDay(page, reviewed.target, reviewed.day);
    if (!same(immediateUi, reviewedUi)) fail('Plain-day identity callback changed the prepared UI');
    guard.arm();
    attempted = true;
    await clickSaveScheduleDayAndVerify(page, reviewedUi);
    if (requireScheduleSession(page).contextId !== owned.contextId) fail('Plain-day session context changed during save');
    exactLocation(page, reviewed.target);
    const after = await readScheduleDetail(page, { productId: reviewed.target.productId, scheduleId: reviewed.target.scheduleId });
    const verification = verifyPlainDayPersistence(baseline, after, { day: reviewed.day, title: reviewed.details[0].title, dayTitle: reviewed.title===null ? '' : reviewed.title, description: reviewed.details[0].description, meals: { breakfast: { type: reviewed.mealList.breakfast_type, text: reviewed.mealList.breakfast_text }, lunch: { type: reviewed.mealList.lunch_type, text: reviewed.mealList.lunch_text }, dinner: { type: reviewed.mealList.dinner_type, text: reviewed.mealList.dinner_text } } });
    guard.verify();
    return { status: verification.status, productId: reviewed.target.productId, scheduleId: reviewed.target.scheduleId, day: reviewed.day, detailId: verification.detailId, guardedPosts: guard.count };
  } catch (cause) {
    if (attempted) throw unknown(cause);
    throw cause;
  } finally { guard.seal(); }
}
