import { canonical } from './core.mjs';
import { readBasicForm } from './basic-form.mjs';

const TIMEOUT = 10_000;
const MAX_DAYS = 366;
const MAX_NIGHTS = 365;
const EXPECTED_KEYS = Object.freeze(['productId', 'masterCode', 'title', 'account']);
const SCHEDULE_KEYS = Object.freeze(['title', 'nights', 'days']);
const fail = message => { throw new Error(message); };

function exactKeys(value, keys, description) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Invalid ' + description);
  const actual = Object.keys(value).sort(), allowed = [...keys].sort();
  if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index])) fail('Invalid ' + description + ' keys');
}
function exactText(value, name) {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 20_000) fail('Invalid exact ' + name);
  return value;
}
function exactId(value) {
  if (typeof value !== 'string' || !/^[1-9]\d{0,9}$/.test(value)) fail('Invalid expected product ID');
  return value;
}
function validateExpected(expected) {
  exactKeys(expected, EXPECTED_KEYS, 'expected product');
  return { productId: exactId(expected.productId), masterCode: exactText(expected.masterCode, 'expected master code'), title: exactText(expected.title, 'expected title'), account: exactText(expected.account, 'expected account label') };
}
function validateSchedule(schedule) {
  exactKeys(schedule, SCHEDULE_KEYS, 'schedule options');
  const title = exactText(schedule.title, 'schedule title'), { days, nights } = schedule;
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) fail('Invalid schedule days: expected integer 1..' + MAX_DAYS);
  if (!Number.isInteger(nights) || nights < 0 || nights > MAX_NIGHTS) fail('Invalid schedule nights: expected integer 0..' + MAX_NIGHTS);
  if (days <= nights) fail('Invalid schedule duration: days must be greater than nights');
  return { title, days, nights };
}
function assertVerifiedOrigin(page) {
  const url = new URL(page.url());
  if (url.protocol !== 'https:' || !['basecamp.team', 'schedule-fixture.invalid'].includes(url.hostname) || url.port || url.username || url.password) fail('Not the verified basecamp.team HTTPS origin');
  return url;
}
async function uniqueVisible(locator, description) {
  const visible = locator.filter({ visible: true });
  await visible.first().waitFor({ state: 'visible', timeout: TIMEOUT });
  if (await visible.count() !== 1) fail('Ambiguous ' + description);
  return visible;
}
async function modalInput(modal, selector, description, requireVisible) {
  const control = modal.locator(selector);
  if (await control.count() !== 1) fail('Missing or ambiguous modal input: ' + selector);
  if (requireVisible && !await control.isVisible()) fail('Hidden ' + description);
  const shape = await control.evaluate(el => ({ tagName: el.tagName, type: el.type, disabled: el.disabled, readOnly: el.readOnly }));
  if (shape.tagName !== 'INPUT' || shape.type !== 'text' || shape.disabled || shape.readOnly) fail('Unexpected or non-editable ' + description);
  return control;
}
function masterIdFromUrl(value) {
  try { const url = new URL(value), match = /^\/master\/([1-9]\d{0,9})\/?$/.exec(url.pathname); return match && !url.username && !url.password ? match[1] : null; } catch { return null; }
}
function canonicalBasicState(basic) {
  const { url, documentTitle, ...state } = basic;
  return canonical(state);
}
async function assertExpectedProduct(page, expected, baseline, allowAbsentBasic = false) {
  const currentUrl = assertVerifiedOrigin(page), pathMatch = /^\/tour\/master_product\/([1-9]\d{0,9})\/change\/?$/.exec(currentUrl.pathname);
  if (!pathMatch || pathMatch[1] !== expected.productId) fail('Wrong product detail URL');
  const account = await uniqueVisible(page.locator('#eoding-name'), 'account label');
  if (await account.innerText() !== expected.account) fail('Account label changed since approval');
  const basicTitle = page.locator('#id_1-title, #id_2-title'), basicTitleCount = await basicTitle.count();
  if (basicTitleCount === 0 && allowAbsentBasic) return null;
  if (basicTitleCount !== 1) fail('Missing or ambiguous basic form');
  const basic = await readBasicForm(page);
  if (basic.status !== '2') fail('Product is not private');
  if (basic.masterCode !== expected.masterCode || basic.title !== expected.title) fail('Product identity changed since approval');
  if (masterIdFromUrl(basic.masterURL) !== expected.productId) fail('Master URL does not match expected product ID');
  if (baseline && canonicalBasicState(basic) !== canonicalBasicState(baseline)) fail('Basic state changed since approval');
  return basic;
}
async function assertClosedBlankModal(page, { required }) {
  const modal = page.locator('#add_schedule_modal');
  if (!required && await modal.count() === 0) return null;
  if (required) await modal.first().waitFor({ state: 'attached', timeout: TIMEOUT });
  if (await modal.count() !== 1) fail('Missing or ambiguous add schedule modal');
  if (await modal.isVisible()) fail('Add schedule modal is already open');
  const controls = await Promise.all([
    modalInput(modal, '#id_new_night', 'schedule night input', false), modalInput(modal, '#id_new_day', 'schedule day input', false), modalInput(modal, '#id_new_schedule_name', 'schedule title input', false)
  ]);
  if ((await Promise.all(controls.map(control => control.inputValue()))).some(Boolean)) fail('Add schedule modal is already filled');
  return modal;
}
async function listHasDuplicate(table, title) {
  const schedules = table.locator('tr[data-schedule-id]');
  for (let index = 0; index < await schedules.count(); index++) {
    const row = schedules.nth(index), titleNode = row.locator('.schedule_title'), nightNode = row.locator('.schedule_night'), dayNode = row.locator('.schedule_day');
    if (await titleNode.count() !== 1 || await nightNode.count() !== 1 || await dayNode.count() !== 1) fail('Malformed schedule list row');
    if (await titleNode.innerText() === title) return true;
  }
  return false;
}

/** Opens and fills only an unsaved schedule shell. It never clicks #create_new_schedule. */
export async function prepareNewSchedule(page, expectedProduct, schedule) {
  const expected = validateExpected(expectedProduct), requested = validateSchedule(schedule);
  assertVerifiedOrigin(page);
  const baseline = await assertExpectedProduct(page, expected, null, false);
  await assertClosedBlankModal(page, { required: false });
  const scheduleTab = await uniqueVisible(page.getByRole('link', { name: '일정표관리', exact: true }), 'schedule management link');
  await scheduleTab.click({ timeout: TIMEOUT });
  assertVerifiedOrigin(page);
  await assertExpectedProduct(page, expected, baseline, true);
  const table = await uniqueVisible(page.locator('#schedule_list_table'), 'schedule list');
  await assertClosedBlankModal(page, { required: true });
  if (await listHasDuplicate(table, requested.title)) fail('Duplicate schedule title');
  const addButtons = page.locator('.add_schedule').filter({ visible: true }), addCount = await addButtons.count();
  if (addCount < 1 || addCount > 2) fail('Missing or ambiguous add schedule control');
  await addButtons.first().click({ timeout: TIMEOUT });
  const modal = await uniqueVisible(page.locator('#add_schedule_modal'), 'add schedule modal');
  const night = await modalInput(modal, '#id_new_night', 'schedule night input', true), day = await modalInput(modal, '#id_new_day', 'schedule day input', true), title = await modalInput(modal, '#id_new_schedule_name', 'schedule title input', true);
  if (await night.inputValue() || await day.inputValue() || await title.inputValue()) fail('Add schedule modal is already filled');
  await night.fill(String(requested.nights), { timeout: TIMEOUT }); await day.fill(String(requested.days), { timeout: TIMEOUT }); await title.fill(requested.title, { timeout: TIMEOUT });
  if (await night.inputValue() !== String(requested.nights) || await day.inputValue() !== String(requested.days) || await title.inputValue() !== requested.title) fail('Schedule modal values were not accepted');
  assertVerifiedOrigin(page);
  await assertExpectedProduct(page, expected, baseline, true);
  return { canCommit: false, target: { productId: expected.productId, masterCode: expected.masterCode, title: expected.title, account: expected.account }, fields: { title: requested.title, nights: requested.nights, days: requested.days }, constraint: 'schedule shell only, no day content/prices/departures' };
}

export function assertScheduleSaveContract(page) {
  const url = new URL(page.url());
  if (url.origin !== 'https://schedule-fixture.invalid' || url.username || url.password) fail('Live schedule save blocked: only the reserved synthetic fixture contract is implemented');
}

// Synthetic contract only: these result selectors are NOT live-confirmed.
async function readScheduleRows(page) {
  const table = await uniqueVisible(page.locator('#schedule_list_table'), 'schedule list');
  const rows = table.locator('tbody tr'), result = [], ids = new Set();
  for (let i = 0; i < await rows.count(); i++) {
    const row = rows.nth(i), id = await row.getAttribute('data-schedule-id');
    if (!/^[1-9]\d{0,9}$/.test(id ?? '') || ids.has(id)) fail('Missing, invalid or duplicate schedule ID');
    ids.add(id);
    const item = { id };
    for (const [key, selector] of Object.entries({ title: '.schedule_title', nights: '.schedule_night', days: '.schedule_day' })) {
      if (await row.locator(selector).count() !== 1) fail('Malformed schedule list row');
      item[key] = await row.locator(selector).innerText();
    }
    result.push(item);
  }
  return result.sort((a, b) => a.id.localeCompare(b.id));
}
export async function readScheduleShell(page, target) {
  const basic = await assertExpectedProduct(page, validateExpected(target), null, false);
  const modal = await uniqueVisible(page.locator('#add_schedule_modal'), 'add schedule modal');
  const fields = {};
  for (const [key, selector] of Object.entries({ title: '#id_new_schedule_name', nights: '#id_new_night', days: '#id_new_day' })) {
    fields[key] = await (await modalInput(modal, selector, key, true)).inputValue();
  }
  return { target, basic, fields, rows: await readScheduleRows(page) };
}

/** Caller consumes human approval first. Fixture contract, not an ERP API. */
export async function clickSaveScheduleAndVerify(page, expected) {
  assertScheduleSaveContract(page);
  if (canonical(await readScheduleShell(page, expected.target)) !== canonical(expected)) fail('Schedule form changed since approval');
  const save = await uniqueVisible(page.locator('#add_schedule_modal #create_new_schedule'), 'schedule create button');
  try {
    assertScheduleSaveContract(page);
    await save.click({ timeout: TIMEOUT });
    const selected = await uniqueVisible(page.locator('#schedule_list_table tr.selected[data-schedule-id]'), 'created schedule');
    const scheduleId = await selected.getAttribute('data-schedule-id');
    if (!/^[1-9]\d{0,9}$/.test(scheduleId ?? '')) fail('Missing or invalid assigned schedule ID');
    if (expected.rows.some(row => row.id === scheduleId)) fail('Assigned schedule ID already existed');
    await page.reload({ waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    assertScheduleSaveContract(page);
    await assertExpectedProduct(page, expected.target, expected.basic, false);
    const persisted = await uniqueVisible(page.locator('#schedule_list_table tr.selected[data-schedule-id]'), 'persisted schedule');
    if (await persisted.getAttribute('data-schedule-id') !== scheduleId) fail('Persisted schedule ID mismatch');
    const rows = await readScheduleRows(page);
    if (canonical(rows.filter(row => row.id !== scheduleId)) !== canonical(expected.rows)) fail('Preexisting schedule list changed during save');
    const actual = rows.find(row => row.id === scheduleId);
    if (!actual || actual.title !== expected.fields.title || actual.nights !== expected.fields.nights || actual.days !== expected.fields.days) fail('Persisted schedule values mismatch');
    const fields = { title: actual.title, nights: Number(actual.nights), days: Number(actual.days) };
    assertScheduleSaveContract(page);
    return { status: 'schedule-saved', productId: expected.target.productId, scheduleId, fields };
  } catch (cause) {
    throw Object.assign(new Error('Unknown schedule save outcome; reconcile before retry: ' + cause.message, { cause }), { code: 'UNKNOWN_SAVE_OUTCOME' });
  }
}
