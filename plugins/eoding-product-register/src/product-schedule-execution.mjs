import { fillBlankScheduleDay, readScheduleDay } from './schedule-day.mjs';
import { savePreparedPlainDay } from './schedule-day-live.mjs';
import { readScheduleDetail } from './schedule-detail-read.mjs';
import { prepareLiveSchedule, readLiveSchedule, saveLiveScheduleAndVerify } from './schedule-live.mjs';
import { requireScheduleSession } from './schedule-session.mjs';

const ORIGIN = 'https://basecamp.team';
const ID = /^[1-9]\d{0,9}$/;
const clone = value => structuredClone(value);
const fail = message => { throw new Error(message); };

function text(value, name) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 20_000) fail(`Invalid ${name}`);
  return value;
}
function id(value, name) { if (typeof value !== 'string' || !ID.test(value)) fail(`Invalid ${name}`); return value; }
function shellInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'title')) fail('schedule shell input must contain only title');
  return { title: text(value.title, 'schedule title') };
}
function dependency(context, name) {
  const value = context?.dependencies?.[name];
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`Missing verified ${name} dependency`);
  return value;
}
function productTarget(product, basic, identity) {
  return {
    productId: id(basic.productId, 'basic product ID'),
    masterCode: text(basic.masterCode, 'basic master code'),
    title: text(product?.title, 'product title'),
    account: text(identity?.accountName, 'ERP account')
  };
}
function assertDetailPage(page, productId) {
  requireScheduleSession(page);
  let url;
  try { url = new URL(page.url()); } catch { fail('Wrong schedule product page'); }
  if (url.origin !== ORIGIN || url.username || url.password || url.search || ![`/tour/master_product/${productId}/change/`].includes(url.pathname) || (url.hash && url.hash !== '#schedule')) fail('Wrong schedule product page');
}
function scheduleRow(page, scheduleId) {
  return page.locator(`#schedule_list_table tr[data-schedule-id="${scheduleId}"]`).filter({ visible: true });
}
function selectedScheduleRow(page, scheduleId) {
  return page.locator(`#schedule_list_table tr.selected[data-schedule-id="${scheduleId}"]`).filter({ visible: true });
}
function dayNode(page, day) {
  return page.locator(`#schedule [role="treeitem"][type="day"][day="${day}"]`).filter({ visible: true });
}
async function reusableScheduleTab(page, target, day) {
  const url = new URL(page.url());
  if (url.hash !== '#schedule') return false;
  const schedule = scheduleRow(page, target.scheduleId);
  const selected = selectedScheduleRow(page, target.scheduleId);
  const node = dayNode(page, day);
  return await schedule.count() === 1 && await selected.count() === 1 && await node.count() === 1;
}
async function selectPlainDay(page, target, day) {
  assertDetailPage(page, target.productId);
  if (!await reusableScheduleTab(page, target, day)) {
    // A hash-only navigation does not initialize the ERP's lazy schedule tab.
    await page.goto(`${ORIGIN}/tour/master_product/${target.productId}/change/#schedule`, { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    assertDetailPage(page, target.productId);
    const schedule = scheduleRow(page, target.scheduleId);
    await schedule.first().waitFor({ state: 'visible', timeout: 10_000 });
    if (await schedule.count() !== 1) fail('Missing or ambiguous created schedule row');
    await schedule.click();
  }
  const selected = selectedScheduleRow(page, target.scheduleId);
  await selected.waitFor({ state: 'visible', timeout: 10_000 });
  const node = dayNode(page, day);
  await node.first().waitFor({ state: 'visible', timeout: 10_000 });
  if (await node.count() !== 1) fail('Missing or ambiguous itinerary day node');
  const anchor=node.locator(':scope > a');
  if (await anchor.count() !== 1) fail('Missing or ambiguous itinerary day anchor');
  await anchor.click();
  await page.locator(`#schedule [role="treeitem"][aria-selected="true"][type="day"][day="${day}"]`).waitFor({ state: 'visible', timeout: 10_000 });
  assertDetailPage(page, target.productId);
}

/** Production adapters composed only from guarded schedule-shell/plain-day modules. */
export function createProductScheduleAdapters() {
  return {
    shell: {
      async prepare(page, product, input, context) {
        const basic = dependency(context, 'basic'); const target = productTarget(product, basic, context.identity); const requested = shellInput(input);
        return prepareLiveSchedule(page, product, target, { title: requested.title, nights: product.nights, days: product.days });
      },
      async read(page, _product, _input, context) { return readLiveSchedule(page, context.prepared); },
      async save(page, prepared, _input, context) {
        const result = await saveLiveScheduleAndVerify(page, prepared, { beforeClick: async () => context.assertIdentity?.() });
        const basic = dependency(context, 'basic');
        if (result.productId !== basic.productId) fail('Schedule result product dependency changed');
        return result;
      }
    },
    days: {
      async prepare(page, product, input, context) {
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 0) fail('plain itinerary input must be an empty object');
        const basic = dependency(context, 'basic'), shell = dependency(context, 'shell');
        const targetBase = productTarget(product, basic, context.identity);
        const scheduleId = id(shell.scheduleId, 'schedule shell ID');
        const current = await readScheduleDetail(page, { productId: targetBase.productId, scheduleId });
        if (current.schedule.title !== shell.fields?.title || current.schedule.days !== product.days || current.schedule.nights !== product.nights) fail('Created schedule detail does not match verified shell');
        const target = { ...targetBase, scheduleId, scheduleCode: current.schedule.code, scheduleTitle: current.schedule.title };
        const draft = context.day;
        if (!draft || !Number.isInteger(draft.day)) fail('Missing normalized itinerary day');
        await selectPlainDay(page, target, draft.day);
        const before = await readScheduleDetail(page, { productId: target.productId, scheduleId });
        const expected = await fillBlankScheduleDay(page, target, clone(draft));
        return { expected, before };
      },
      async read(page, _product, _input, context) {
        const expected = context.prepared?.expected;
        if (!expected) fail('Missing prepared plain itinerary day');
        return { expected: await readScheduleDay(page, expected.target, expected.day), before: await readScheduleDetail(page, { productId: expected.target.productId, scheduleId: expected.target.scheduleId }) };
      },
      async save(page, prepared, _input, context) {
        const result = await savePreparedPlainDay(page, prepared.expected, { before: prepared.before, beforeClick: async () => context.assertIdentity?.() });
        const basic = dependency(context, 'basic'), shell = dependency(context, 'shell');
        if (result.productId !== basic.productId || result.scheduleId !== shell.scheduleId || result.day !== context.day.day) fail('Plain itinerary result dependency changed');
        return result;
      }
    }
  };
}
