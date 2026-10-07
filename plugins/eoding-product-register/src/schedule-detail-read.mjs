const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_TREE_ROWS = 5_000;
const ID = /^[1-9]\d{0,9}$/;
const fail = message => { throw new Error(message); };

function canonicalId(value, label) {
  if (typeof value !== 'string' || !ID.test(value)) fail(`Invalid ${label}`);
  return value;
}
function numericId(value, label) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && ID.test(String(value))) return String(value);
  if (typeof value === 'string' && ID.test(value)) return value;
  fail(`Invalid ${label}`);
}
function positiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) fail(`Invalid ${label}`);
  return value;
}
function text(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || value.length > 20_000) fail(`Invalid ${label}`);
  return value;
}
function exactProductPage(page, productId) {
  if (!page || typeof page.url !== 'function') fail('Invalid page');
  let url;
  try { url = new URL(page.url()); } catch { fail('Wrong product detail URL'); }
  const target = `https://basecamp.team/tour/master_product/${productId}/change/`;
  if (url.username || url.password || (url.href !== target && url.href !== `${target}#schedule`)) fail('Wrong product detail URL');
  return url.origin;
}
function detailEndpoint(origin, scheduleId) {
  return `${origin}/tour/master_product_schedule/${scheduleId}/detail/`;
}
function stableJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('Invalid auxiliary response data');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) fail('Invalid auxiliary response data');
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}
function normalizeTreeRow(row, index, days) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) fail(`Invalid schedule tree row ${index + 1}`);
  const day = positiveInteger(row.day, `schedule tree day at row ${index + 1}`, days);
  const rowId = numericId(row.id, `schedule tree ID at row ${index + 1}`);
  const meal = kind => ({ type: positiveInteger(row[`${kind}_type`], `${kind} type at row ${index + 1}`), text: text(row[`${kind}_text`], `${kind} text at row ${index + 1}`) });
  return {
    id: rowId,
    day,
    step: positiveInteger(row.step, `schedule tree step at row ${index + 1}`),
    typeId: positiveInteger(row.type_id, `schedule tree type at row ${index + 1}`),
    etc1: text(row.etc1, `etc1 at row ${index + 1}`),
    etc2: text(row.etc2, `etc2 at row ${index + 1}`),
    etc3: text(row.etc3, `etc3 at row ${index + 1}`),
    etc4: text(row.etc4, `etc4 at row ${index + 1}`),
    etc5: text(row.etc5, `etc5 at row ${index + 1}`),
    etc6: text(row.etc6, `etc6 at row ${index + 1}`),
    dayTitle: text(row.day_title, `day title at row ${index + 1}`),
    meals: { breakfast: meal('breakfast'), lunch: meal('lunch'), dinner: meal('dinner') },
    description: text(row.description, `description at row ${index + 1}`, { nullable: true })
  };
}
function normalizePayload(payload, productId, scheduleId) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('Malformed schedule detail response');
  const schedule = payload.schedule;
  if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) fail('Malformed schedule detail response');
  const id = numericId(schedule.id, 'schedule ID');
  const product = numericId(schedule.product, 'schedule product ID');
  if (id !== scheduleId || product !== productId) fail('Schedule detail identity mismatch');
  const days = positiveInteger(schedule.day, 'schedule days', 366);
  const nights = Number.isSafeInteger(schedule.night) && schedule.night >= 0 && schedule.night < days && schedule.night <= 365 ? schedule.night : fail('Invalid schedule nights');
  if (typeof schedule.code !== 'string' || !schedule.code || schedule.code.length > 20_000 || typeof schedule.title !== 'string' || !schedule.title || schedule.title.length > 20_000) fail('Invalid schedule metadata');
  const visitRoute = text(schedule.visit_route, 'schedule visit route', { nullable: true });
  const scheduleMeeting = text(schedule.schedule_meeting, 'schedule meeting', { nullable: true });
  const meetingRemark = text(schedule.meeting_remark, 'schedule meeting remark', { nullable: true });
  if (typeof schedule.use_flag !== 'boolean') fail('Invalid schedule use flag');
  if (!Number.isSafeInteger(schedule.sort) || schedule.sort < 0) fail('Invalid schedule sort');
  if (!Array.isArray(payload.schedule_tree) || payload.schedule_tree.length > MAX_TREE_ROWS || !Array.isArray(payload.contents) || !Array.isArray(payload.images)) fail('Malformed schedule detail response');
  const ids = new Set();
  const tree = payload.schedule_tree.map((row, index) => {
    const normalized = normalizeTreeRow(row, index, days);
    if (ids.has(normalized.id)) fail('Duplicate schedule tree ID');
    ids.add(normalized.id);
    return normalized;
  });
  const contentsJson = stableJson(payload.contents);
  const imagesJson = stableJson(payload.images);
  if (contentsJson.length + imagesJson.length > MAX_RESPONSE_BYTES) fail('Schedule detail auxiliary data too large');
  return { productId, scheduleId, schedule: { id, productId: product, title: schedule.title, days, nights, code: schedule.code, visitRoute, scheduleMeeting, meetingRemark, useFlag: schedule.use_flag, sort: schedule.sort }, tree, contentsJson, imagesJson };
}

/** Read the authoritative JSON detail snapshot for the current authenticated product page. */
export async function readScheduleDetail(page, { productId: rawProductId, scheduleId: rawScheduleId } = {}) {
  const productId = canonicalId(rawProductId, 'product ID');
  const scheduleId = canonicalId(rawScheduleId, 'schedule ID');
  const origin = exactProductPage(page, productId);
  const target = detailEndpoint(origin, scheduleId);
  let response;
  try {
    response = await page.evaluate(async ({ target, timeout, maximum }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const result = await fetch(target, { method: 'GET', credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: controller.signal });
        if (result.status !== 200 || result.redirected || result.url !== target) return { failure: 'Schedule detail request was not an exact successful response' };
        if (!/^application\/json(?:;|$)/i.test(result.headers.get('content-type') || '')) return { failure: 'Schedule detail response was not JSON' };
        const contentLength = Number(result.headers.get('content-length'));
        if (Number.isFinite(contentLength) && contentLength > maximum) return { failure: 'Schedule detail response too large' };
        const body = await result.text();
        if (new TextEncoder().encode(body).byteLength > maximum) return { failure: 'Schedule detail response too large' };
        try { return { payload: JSON.parse(body) }; } catch { return { failure: 'Malformed schedule detail JSON' }; }
      } finally { clearTimeout(timer); }
    }, { target, timeout: TIMEOUT_MS, maximum: MAX_RESPONSE_BYTES });
  } catch { fail('Schedule detail GET failed'); }
  if (!response || response.failure) fail(response?.failure ?? 'Malformed schedule detail response');
  const normalized = normalizePayload(response.payload, productId, scheduleId);
  if (exactProductPage(page, productId) !== origin) fail('Schedule detail origin changed during read');
  const digest = async value => {
    const bytes = new TextEncoder().encode(value);
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  };
  return {
    productId, scheduleId, schedule: normalized.schedule, tree: normalized.tree,
    contentsFingerprint: await digest(normalized.contentsJson), imagesFingerprint: await digest(normalized.imagesJson)
  };
}

const MEAL_KINDS = ['breakfast', 'lunch', 'dinner'];
function ownKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) fail(`Invalid ${label}`);
}
function same(left, right) { return stableJson(left) === stableJson(right); }

/** Make the explicit server type/text meal contract from a resolved draft. */
export function expectedMeals(meals) {
  ownKeys(meals, MEAL_KINDS, 'meals');
  const result = {};
  for (const kind of MEAL_KINDS) {
    const meal = meals[kind];
    ownKeys(meal, ['type', 'text'], 'explicit type/text meal');
    result[kind] = { type: positiveInteger(meal.type, `${kind} meal type`), text: text(meal.text, `${kind} meal text`) };
  }
  return result;
}
function assertReadRow(row, index) {
  ownKeys(row, ['id', 'day', 'step', 'typeId', 'etc1', 'etc2', 'etc3', 'etc4', 'etc5', 'etc6', 'dayTitle', 'meals', 'description'], `readback row ${index + 1}`);
  numericId(row.id, `readback row ID ${index + 1}`);
  positiveInteger(row.day, `readback day ${index + 1}`, 366);
  positiveInteger(row.step, `readback step ${index + 1}`);
  positiveInteger(row.typeId, `readback type ${index + 1}`);
  text(row.etc1, `readback etc1 ${index + 1}`); text(row.etc2, `readback etc2 ${index + 1}`); text(row.etc3, `readback etc3 ${index + 1}`); text(row.etc4, `readback etc4 ${index + 1}`); text(row.etc5, `readback etc5 ${index + 1}`); text(row.etc6, `readback etc6 ${index + 1}`);
  text(row.dayTitle, `readback day title ${index + 1}`); text(row.description, `readback description ${index + 1}`, { nullable: true });
  expectedMeals(row.meals);
}
function assertSnapshot(snapshot, label) {
  ownKeys(snapshot, ['productId', 'scheduleId', 'schedule', 'tree', 'contentsFingerprint', 'imagesFingerprint'], `${label} snapshot`);
  canonicalId(snapshot.productId, `${label} product ID`); canonicalId(snapshot.scheduleId, `${label} schedule ID`);
  ownKeys(snapshot.schedule, ['id', 'productId', 'title', 'days', 'nights', 'code', 'visitRoute', 'scheduleMeeting', 'meetingRemark', 'useFlag', 'sort'], `${label} schedule`);
  if (snapshot.schedule.id !== snapshot.scheduleId || snapshot.schedule.productId !== snapshot.productId) fail(`${label} schedule identity mismatch`);
  text(snapshot.schedule.title, `${label} title`); text(snapshot.schedule.code, `${label} code`); text(snapshot.schedule.visitRoute, `${label} visit route`, { nullable: true }); text(snapshot.schedule.scheduleMeeting, `${label} schedule meeting`, { nullable: true }); text(snapshot.schedule.meetingRemark, `${label} meeting remark`, { nullable: true });
  if (typeof snapshot.schedule.useFlag !== 'boolean') fail(`Invalid ${label} use flag`);
  if (!Number.isSafeInteger(snapshot.schedule.sort) || snapshot.schedule.sort < 0) fail(`Invalid ${label} sort`);
  positiveInteger(snapshot.schedule.days, `${label} days`, 366);
  if (!Number.isSafeInteger(snapshot.schedule.nights) || snapshot.schedule.nights < 0 || snapshot.schedule.nights >= snapshot.schedule.days) fail(`Invalid ${label} nights`);
  if (!Array.isArray(snapshot.tree) || snapshot.tree.length > MAX_TREE_ROWS || !/^[a-f0-9]{64}$/.test(snapshot.contentsFingerprint) || !/^[a-f0-9]{64}$/.test(snapshot.imagesFingerprint)) fail(`Invalid ${label} snapshot`);
  const ids = new Set();
  snapshot.tree.forEach((row, index) => { assertReadRow(row, index); if (ids.has(row.id)) fail(`Duplicate ${label} tree ID`); ids.add(row.id); });
}
function blankHotelSentinel(row, day) {
  return row.day === day && row.typeId === 2 && row.step === 999 && row.etc1 === '' && row.etc2 === '' && row.description === null;
}
function sameExceptDayPresentation(before, after) {
  return before.id === after.id && before.day === after.day && before.step === after.step && before.typeId === after.typeId && before.etc1 === after.etc1 && before.etc2 === after.etc2 && before.etc3 === after.etc3 && before.etc4 === after.etc4 && before.etc5 === after.etc5 && before.etc6 === after.etc6 && before.description === after.description;
}
function serverScheduleNormalizations(before, after) {
  if (same(before, after)) return [];
  if (before.visitRoute !== null || after.visitRoute !== '') fail('Schedule changed during persistence');
  if (!same(before, { ...after, visitRoute: null })) fail('Schedule changed during persistence');
  return [{ field: 'schedule.visitRoute', before: null, after: '' }];
}

/** Verify the narrow blank-day persistence contract against two server readback snapshots. */
export function verifyPlainDayPersistence(before, after, { day, title, dayTitle = title, description, meals } = {}) {
  assertSnapshot(before, 'before'); assertSnapshot(after, 'after');
  if (before.productId !== after.productId || before.scheduleId !== after.scheduleId) fail('Schedule changed during persistence');
  const serverNormalizations = serverScheduleNormalizations(before.schedule, after.schedule);
  if (!Number.isSafeInteger(day) || day < 1 || day > before.schedule.days || day > after.schedule.days) fail('Invalid persistence day');
  text(title, 'persistence title'); if(dayTitle!==''&&dayTitle!==title)fail('Invalid persistence day title'); text(description, 'persistence description');
  const expected = expectedMeals(meals);
  if (before.contentsFingerprint !== after.contentsFingerprint || before.imagesFingerprint !== after.imagesFingerprint) fail('Contents or images changed during persistence');
  const beforeTarget = before.tree.filter(row => row.day === day);
  if (beforeTarget.length !== 1 || !blankHotelSentinel(beforeTarget[0], day) || beforeTarget[0].dayTitle !== '' || !same(beforeTarget[0].meals, expectedMeals({ breakfast: { type: 16, text: '' }, lunch: { type: 16, text: '' }, dinner: { type: 16, text: '' } }))) fail('Only a blank native day without hotel or flight content is supported');
  const beforeIds = new Map(before.tree.map(row => [row.id, row]));
  if (!after.tree.some(row => row.id === beforeTarget[0].id)) fail('Hotel sentinel was erased');
  if (after.tree.length !== before.tree.length + 1) fail('Unexpected extra or missing schedule rows');
  for (const row of before.tree) {
    const persisted = after.tree.find(candidate => candidate.id === row.id);
    if (!persisted) fail(row.id === beforeTarget[0].id ? 'Hotel sentinel was erased' : 'Prior schedule row was erased');
    if (row.day !== day && !same(row, persisted)) fail('Other day changed during persistence');
    if (row.day === day && !sameExceptDayPresentation(row, persisted)) fail('Hotel sentinel changed during persistence');
  }
  const additions = after.tree.filter(row => !beforeIds.has(row.id));
  if (additions.length !== 1 || additions[0].day !== day || additions[0].step !== 1 || additions[0].typeId !== 7) fail('Expected exactly one newly assigned custom detail');
  const custom = additions[0];
  const sentinel = after.tree.find(row => row.id === beforeTarget[0].id);
  if (custom.etc1 !== title || custom.etc2 !== '' || custom.description !== description || custom.dayTitle !== dayTitle || !same(custom.meals, expected)) fail('Persisted custom detail mismatch');
  if (sentinel.dayTitle !== dayTitle || !same(sentinel.meals, expected)) fail('Persisted hotel sentinel presentation mismatch');
  const result = { status: 'plain-day-persisted', day, detailId: custom.id };
  if (serverNormalizations.length) result.serverNormalizations = serverNormalizations;
  return result;
}
