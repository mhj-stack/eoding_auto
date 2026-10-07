import { canonical } from './core.mjs';
import { readScheduleList } from './schedule-read.mjs';
import { readScheduleDetail } from './schedule-detail-read.mjs';

const ID = /^[1-9]\d{0,9}$/;
const EMPTY_ARRAY_FINGERPRINT = '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
const MEALS = ['breakfast', 'lunch', 'dinner'];
const fail = message => { throw new Error(message); };

function exact(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail(`Invalid ${label}`);
  return value;
}
function id(value, label) {
  if (typeof value !== 'string' || !ID.test(value)) fail(`Invalid ${label}`);
  return value;
}
function text(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return value;
  if (typeof value !== 'string' || value.length > 20_000) fail(`Invalid ${label}`);
  return value;
}
function duration(value, label) {
  if (!value || !Number.isSafeInteger(value.nights) || value.nights < 0 || value.nights > 365 || !Number.isSafeInteger(value.days) || value.days < 1 || value.days > 366 || value.nights >= value.days) fail(`Invalid ${label} duration`);
  return { nights: value.nights, days: value.days };
}
function requestedTarget(value) {
  exact(value, ['productId', 'masterCode', 'scheduleId'], 'itinerary reconciliation target');
  const productId = id(value.productId, 'product ID');
  const masterCode = text(value.masterCode, 'master code');
  if (!masterCode.trim() || masterCode !== masterCode.trim()) fail('Invalid master code');
  return { productId, masterCode, scheduleId: id(value.scheduleId, 'schedule ID') };
}
function requestedInput(value) {
  exact(value, [], 'itinerary reconciliation input');
}
function expectedProduct(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Invalid normalized product');
  const trip = duration(value, 'product');
  if (!Array.isArray(value.itinerary) || value.itinerary.length !== trip.days) fail('Product itinerary is not exact');
  const days = new Map();
  for (const item of value.itinerary) {
    exact(item, ['day', 'title', 'description', 'meals'], 'normalized itinerary day');
    if (!Number.isSafeInteger(item.day) || item.day < 1 || item.day > trip.days || days.has(item.day)) fail('Product itinerary is not exact');
    text(item.title, 'approved itinerary title');
    text(item.description, 'approved itinerary description');
    exact(item.meals, MEALS, 'approved itinerary meals');
    for (const kind of MEALS) text(item.meals[kind], `approved ${kind} meal`);
    days.set(item.day, item);
  }
  return { ...trip, itineraryByDay: days };
}
function expectedMeals(day) {
  return Object.fromEntries(MEALS.map(kind => {
    const source = day.meals[kind];
    // Exact native options independently observed in company22 meal catalog.
    const nativeType = new Map([['불포함',16],['호텔식',2],['한식',5],['현지식',3]]).get(source);
    return [kind, nativeType === undefined ? { type: 17, text: source } : { type: nativeType, text: '' }];
  }));
}
function same(left, right) { return canonical(left) === canonical(right); }
function sameMeals(left, right) { return same(left, right); }
function receiptsFrom(context, target, product) {
  if (!context || typeof context.assertIdentity !== 'function') fail('Missing reconciliation identity assertion');
  const execution = context.session?.execution;
  const stages = execution?.stages;
  if (!stages || typeof stages !== 'object' || Array.isArray(stages)) fail('Missing persisted itinerary execution');
  const basic = stages.basic?.result;
  const shell = stages['schedule-shell']?.result;
  const receipts = stages.itinerary?.result;
  if (!basic || basic.productId !== target.productId || basic.masterCode !== target.masterCode) fail('Persisted basic identity does not match itinerary target');
  if (!shell || shell.productId !== target.productId || shell.scheduleId !== target.scheduleId) fail('Persisted schedule shell identity does not match itinerary target');
  const fields = shell.fields;
  exact(fields, ['title', 'nights', 'days'], 'persisted schedule shell fields');
  text(fields.title, 'persisted schedule shell title');
  if (fields.nights !== product.nights || fields.days !== product.days) fail('Persisted schedule shell duration does not match product');
  if (!Array.isArray(receipts) || receipts.length !== product.days) fail('Persisted itinerary receipts are not exact');
  const byDay = new Map();
  for (const receipt of receipts) {
    exact(receipt, ['status', 'productId', 'scheduleId', 'day', 'detailId', 'guardedPosts'], 'persisted itinerary receipt');
    if (receipt.status !== 'plain-day-persisted' || receipt.productId !== target.productId || receipt.scheduleId !== target.scheduleId || !Number.isSafeInteger(receipt.day) || !product.itineraryByDay.has(receipt.day) || byDay.has(receipt.day) || id(receipt.detailId, 'persisted custom detail ID') !== receipt.detailId || receipt.guardedPosts !== 1) fail('Persisted itinerary receipts are not exact');
    byDay.set(receipt.day, receipt);
  }
  if (byDay.size !== product.days) fail('Persisted itinerary receipts are not exact');
  const journals = execution.itineraryDays;
  if (!journals || typeof journals !== 'object' || Array.isArray(journals) || Object.keys(journals).length !== product.days) fail('Persisted itinerary day journals are not exact');
  for (const [day, receipt] of byDay) {
    const journal = journals[String(day)];
    if (!journal || !same(journal.result, receipt)) fail('Persisted itinerary day journals do not match receipts');
  }
  return { title: fields.title, receipts, byDay };
}
function assertRowShape(row, label) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) fail(`Invalid ${label}`);
  for (const key of ['etc1', 'etc2', 'etc3', 'etc4', 'etc5', 'etc6', 'dayTitle']) text(row[key], `${label} ${key}`);
  text(row.description, `${label} description`, { nullable: true });
}
function verifyDetail(detail, target, product, persisted) {
  if (!detail || detail.productId !== target.productId || detail.scheduleId !== target.scheduleId || detail.schedule?.productId !== target.productId || detail.schedule?.id !== target.scheduleId || detail.schedule.title !== persisted.title || detail.schedule.nights !== product.nights || detail.schedule.days !== product.days) fail('Persisted schedule detail does not match itinerary target');
  if (detail.contentsFingerprint !== EMPTY_ARRAY_FINGERPRINT || detail.imagesFingerprint !== EMPTY_ARRAY_FINGERPRINT) fail('Persisted itinerary auxiliary arrays are not empty');
  if (!Array.isArray(detail.tree) || detail.tree.length !== product.days * 2) fail('Persisted itinerary tree rows are not exact');
  const rowsByDay = new Map();
  for (const row of detail.tree) {
    assertRowShape(row, 'persisted itinerary row');
    if (!product.itineraryByDay.has(row.day)) fail('Persisted itinerary tree has an unexpected day');
    const rows = rowsByDay.get(row.day) ?? [];
    rows.push(row);
    rowsByDay.set(row.day, rows);
  }
  if (rowsByDay.size !== product.days) fail('Persisted itinerary tree rows are not exact');
  for (const [day, expected] of product.itineraryByDay) {
    const rows = rowsByDay.get(day);
    if (!rows || rows.length !== 2) fail('Persisted itinerary day rows are not exact');
    const receipt = persisted.byDay.get(day);
    const custom = rows.filter(row => row.typeId === 7 && row.step === 1);
    const sentinel = rows.filter(row => row.typeId === 2 && row.step === 999);
    if (custom.length !== 1 || sentinel.length !== 1) fail('Persisted itinerary day rows are not exact');
    const meals = expectedMeals(expected);
    const customRow = custom[0];
    if (customRow.id !== receipt.detailId || customRow.etc1 !== expected.title || customRow.etc2 !== '' || customRow.etc3 !== '' || customRow.etc4 !== '' || customRow.etc5 !== '' || customRow.etc6 !== '' || customRow.description !== expected.description || customRow.dayTitle !== expected.title || !sameMeals(customRow.meals, meals)) fail('Persisted custom itinerary detail does not match approval');
    const sentinelRow = sentinel[0];
    if (sentinelRow.etc1 !== '' || sentinelRow.etc2 !== '' || sentinelRow.etc3 !== '' || sentinelRow.etc4 !== '' || sentinelRow.etc5 !== '' || sentinelRow.etc6 !== '' || sentinelRow.description !== null || sentinelRow.dayTitle !== expected.title || !sameMeals(sentinelRow.meals, meals)) fail('Persisted itinerary hotel sentinel does not match approval');
  }
}

/** Read-only proof that every durable approved itinerary day still matches the server. */
export async function reconcileItineraryPersisted(page, sourceProduct, input, context, suppliedTarget) {
  const target = requestedTarget(suppliedTarget);
  requestedInput(input);
  const product = expectedProduct(sourceProduct);
  const persisted = receiptsFrom(context, target, product);
  if (!page || typeof page.route !== 'function' || typeof page.unroute !== 'function') fail('Invalid reconciliation page');
  const readOnly = async route => {
    if (!['GET', 'HEAD'].includes(route.request().method())) return route.abort('blockedbyclient');
    return route.fallback();
  };
  await page.route('**/*', readOnly);
  try {
    await context.assertIdentity();
    const list = await readScheduleList(page, { productId: target.productId });
    const matching = list.schedules?.filter(row => row.title === persisted.title) ?? [];
    if (list.productId !== target.productId || matching.length !== 1 || matching[0].scheduleId !== target.scheduleId || matching[0].nights !== product.nights || matching[0].days !== product.days) fail('Persisted schedule list does not contain one matching shell');
    const first = await readScheduleDetail(page, { productId: target.productId, scheduleId: target.scheduleId });
    verifyDetail(first, target, product, persisted);
    const second = await readScheduleDetail(page, { productId: target.productId, scheduleId: target.scheduleId });
    verifyDetail(second, target, product, persisted);
    if (!same(first, second)) fail('Persisted itinerary changed during reconciliation');
    await context.assertIdentity();
    return structuredClone(persisted.receipts);
  } finally {
    await page.unroute('**/*', readOnly);
  }
}
