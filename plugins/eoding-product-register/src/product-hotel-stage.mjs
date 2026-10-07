import { createProductHotelAdapters } from './product-hotel-execution.mjs';

const ORIGIN = 'https://basecamp.team';
const ID = /^[1-9]\d{0,9}$/;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const clone = value => structuredClone(value);
const fail = message => { throw new Error(message); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

function exact(value, keys) { return plain(value) && Object.keys(value).length === keys.length && keys.every(key => own(value, key)); }
function canonicalId(value, label) { if (typeof value !== 'string' || !ID.test(value)) fail(`Invalid ${label}`); return value; }
function exactText(value, label) { if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 20_000) fail(`Invalid ${label}`); return value; }
function day(value) { if (!Number.isSafeInteger(value) || value < 1 || value > 366) fail('Invalid hotel day'); return value; }

/** Validates immutable hotel mapping input against normalized hotel names and statuses. */
export function hotelAssignments(product, input) {
  if (!exact(input, ['assignments']) || !Array.isArray(input.assignments)) fail('Hotel input must contain only assignments');
  const source = product?.hotels;
  if (!Array.isArray(source) || source.length === 0) fail('Normalized hotel source assignments are required');
  if (!Number.isSafeInteger(product?.days) || product.days < 1 || product.days > 366) fail('Normalized product days are required');
  if (input.assignments.length === 0) fail('Every normalized hotel requires an assignment');
  const referenced = new Set(), dayCatalog = new Set(), confirmedDays = new Set();
  const assignments = input.assignments.map((item, index) => {
    if (!exact(item, ['day', 'hotelIndex', 'catalog', 'confirm'])) fail(`Invalid hotel assignment ${index + 1}`);
    const assignmentDay = day(item.day);
    if (assignmentDay > product.days) fail('Hotel assignment day exceeds normalized product days');
    if (!Number.isSafeInteger(item.hotelIndex) || item.hotelIndex < 0 || item.hotelIndex >= source.length) fail('Hotel assignment hotelIndex is invalid');
    if (!exact(item.catalog, ['id', 'code', 'name'])) fail('Hotel catalog must contain only id, code, and name');
    const catalog = { id: canonicalId(item.catalog.id, 'hotel catalog ID'), code: exactText(item.catalog.code, 'hotel catalog code'), name: exactText(item.catalog.name, 'hotel catalog name') };
    if (typeof item.confirm !== 'boolean') fail('Hotel assignment confirm must be boolean');
    const normalized = source[item.hotelIndex];
    if (!plain(normalized) || exactText(normalized.name, 'normalized hotel name') !== catalog.name) fail('Hotel catalog name must match its normalized hotel source');
    if (!['planned', 'confirmed', 'unknown'].includes(normalized.status) || item.confirm !== (normalized.status === 'confirmed')) fail('Hotel assignment confirm must match normalized hotel status');
    const duplicate = `${assignmentDay}:${catalog.id}`;
    if (dayCatalog.has(duplicate)) fail('Duplicate hotel catalog ID for the same day');
    dayCatalog.add(duplicate);
    if (item.confirm) { if (confirmedDays.has(assignmentDay)) fail('Only one confirmed hotel is allowed per day'); confirmedDays.add(assignmentDay); }
    referenced.add(item.hotelIndex);
    return { day: assignmentDay, hotelIndex: item.hotelIndex, catalog, confirm: item.confirm };
  });
  if (referenced.size !== source.length) fail('Every normalized hotel must be referenced by an assignment');
  return clone(assignments);
}

export function hotelInputIssue(product, input) { try { hotelAssignments(product, input); return null; } catch (error) { return error.message; } }

function dependency(context, name) {
  const value = context?.dependencies?.[name];
  if (!plain(value)) fail(`Missing verified ${name} dependency`);
  return value;
}
function requiredTarget(context, product, assignment) {
  const basic = dependency(context, 'basic'), shell = dependency(context, 'shell'), days = context?.dependencies?.days;
  const productId = canonicalId(basic.productId, 'basic product ID');
  if (canonicalId(shell.productId, 'shell product ID') !== productId) fail('Saved schedule product dependency changed');
  const scheduleId = canonicalId(shell.scheduleId, 'saved schedule ID');
  if (!Array.isArray(days) || days.length !== product.days || new Set(days.map(item => item?.day)).size !== product.days || days.some(item => !plain(item) || day(item.day) > product.days || canonicalId(item.scheduleId, 'itinerary schedule ID') !== scheduleId)) fail('All verified itinerary day dependencies are required');
  return { productId, scheduleId, day: assignment.day };
}
function assertProductLocation(page, productId) {
  let url; try { url = new URL(page.url()); } catch { fail('Wrong hotel product page'); }
  if (url.origin !== ORIGIN || url.username || url.password || url.pathname !== `/tour/master_product/${productId}/change/` || url.search) fail('Wrong hotel product page');
}
async function one(locator, label) {
  if (!locator || typeof locator.count !== 'function') fail('Invalid browser locator');
  if (await locator.count() !== 1) fail(`Missing/ambiguous ${label}`);
  await locator.first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => fail(`Missing/hidden ${label}`));
  return locator.first();
}
async function selectHotelDay(page, target, context) {
  if (!page || typeof page.goto !== 'function' || typeof page.locator !== 'function' || typeof page.url !== 'function') fail('Invalid browser page');
  if (typeof context?.assertIdentity !== 'function') fail('Hotel identity guard is required');
  await context.assertIdentity();
  const url = `${ORIGIN}/tour/master_product/${target.productId}/change/#schedule`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => fail('Hotel schedule navigation failed'));
  assertProductLocation(page, target.productId);
  await (await one(page.locator('#id_schedule_tab'), 'schedule tab')).click();
  const title = await one(page.locator(`#schedule_list_table tr[data-schedule-id="${target.scheduleId}"] td.schedule_title`), 'target schedule title');
  await title.click();
  const dayNode = await one(page.locator(`#schedule-tree ul > li[day="${target.day}"]`), 'target hotel day node');
  const dayNodeId = await dayNode.getAttribute('id');
  if (!dayNodeId) fail('Target hotel day node has no ID');
  const escaped = dayNodeId.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const anchor = await one(page.locator(`[id="hotel_${escaped}_anchor"]`), 'target hotel day anchor');
  await anchor.click();
  if (!/(^|\s)jstree-clicked(\s|$)/.test(await anchor.getAttribute('class') ?? '')) fail('Target hotel day was not selected');
  assertProductLocation(page, target.productId);
  await context.assertIdentity();
}

/** Parent adapter: selects the claimed product/schedule/day before calling guarded hotel lowlevel. */
export function createProductHotelStageAdapters({ lowlevel = createProductHotelAdapters() } = {}) {
  const hotels = lowlevel?.hotels;
  if (!hotels || ['prepare', 'read', 'save'].some(method => typeof hotels[method] !== 'function')) throw new TypeError('Guarded hotel lowlevel adapters are required');
  return { hotels: {
    async prepare(page, product, input, context) {
      const assignments = hotelAssignments(product, input), assignment = context?.hotelAssignment;
      if (!assignment || assignments[context.hotelAssignmentIndex]?.day !== assignment.day || assignments[context.hotelAssignmentIndex]?.hotelIndex !== assignment.hotelIndex) fail('Missing ordered hotel assignment context');
      const target = requiredTarget(context, product, assignment);
      await selectHotelDay(page, target, context);
      return hotels.prepare(page, { target, hotel: { ...assignment.catalog, confirm: assignment.confirm } });
    },
    async read(page, _product, _input, context) { return hotels.read(page, context?.prepared); },
    async save(page, prepared, _input, context) {
      await context.assertIdentity();
      const result = await hotels.save(page, prepared);
      const assignment = context.hotelAssignment;
      if (!result || result.status !== 'hotel-assignment-persisted' || result.productId !== prepared.target.productId || result.scheduleId !== prepared.target.scheduleId || result.day !== assignment.day) fail('Hotel save result does not match claimed assignment');
      return result;
    }
  } };
}
