import { canonical } from './core.mjs';
import { readScheduleList } from './schedule-read.mjs';
import { readScheduleDetail } from './schedule-detail-read.mjs';

const ID = /^[1-9]\d{0,9}$/;
const EMPTY_ARRAY_FINGERPRINT = '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
const fail = message => { throw new Error(message); };

function exact(value, keys, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail(message);
}
function id(value, label) {
  if (typeof value !== 'string' || !ID.test(value)) fail(`Invalid ${label}`);
  return value;
}
function text(value, label) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 20_000) fail(`Invalid ${label}`);
  return value;
}
function duration(value) {
  if (!Number.isSafeInteger(value.nights) || value.nights < 0 || value.nights > 365 || !Number.isSafeInteger(value.days) || value.days < 1 || value.days > 366 || value.nights >= value.days) fail('Invalid product duration');
  return { nights: value.nights, days: value.days };
}
function requestedTarget(value) {
  exact(value, ['productId', 'masterCode', 'scheduleId'], 'Invalid schedule reconciliation target');
  return { productId: id(value.productId, 'product ID'), masterCode: text(value.masterCode, 'master code'), scheduleId: id(value.scheduleId, 'schedule ID') };
}
function requestedInput(value) {
  exact(value, ['title'], 'schedule shell input must contain only title');
  return { title: text(value.title, 'schedule title') };
}
function requestedProduct(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Invalid source product');
  text(value.title, 'product title');
  return duration(value);
}
function assertBlankMeal(meal) {
  return meal && meal.type === 16 && meal.text === '';
}
function verifySnapshot(list, detail, target, input, product) {
  if (list.productId !== target.productId || !Array.isArray(list.schedules) || list.schedules.length !== 1) fail('Expected one exact persisted schedule');
  const row = list.schedules[0];
  if (row.scheduleId !== target.scheduleId || row.title !== input.title || row.nights !== product.nights || row.days !== product.days) fail('Persisted schedule list does not match requested shell');
  if (detail.productId !== target.productId || detail.scheduleId !== target.scheduleId || detail.schedule.title !== input.title || detail.schedule.nights !== product.nights || detail.schedule.days !== product.days) fail('Persisted schedule detail does not match requested shell');
  if (detail.contentsFingerprint !== EMPTY_ARRAY_FINGERPRINT || detail.imagesFingerprint !== EMPTY_ARRAY_FINGERPRINT) fail('Persisted schedule contents or images are not empty');
  if (!Array.isArray(detail.tree) || detail.tree.length !== product.days) fail('Persisted schedule has unexpected day rows');
  const days = new Set();
  for (const row of detail.tree) {
    if (days.has(row.day) || row.day < 1 || row.day > product.days) fail('Persisted schedule day rows are not exact');
    days.add(row.day);
    if (row.typeId !== 2 || row.step !== 999 || row.etc1 !== '' || row.etc2 !== '' || row.etc3 !== '' || row.etc4 !== '' || row.etc5 !== '' || row.etc6 !== '' || row.dayTitle !== '' || row.description !== null || !assertBlankMeal(row.meals?.breakfast) || !assertBlankMeal(row.meals?.lunch) || !assertBlankMeal(row.meals?.dinner)) fail('Persisted schedule day is not blank');
  }
  if (days.size !== product.days) fail('Persisted schedule day rows are not exact');
}
async function readExact(page, target) {
  const list = await readScheduleList(page, { productId: target.productId });
  const detail = await readScheduleDetail(page, { productId: target.productId, scheduleId: target.scheduleId });
  return { list, detail };
}

/** Read-only recovery proof for an already-consumed schedule-shell approval. */
export async function reconcileShellPersisted(page, sourceProduct, shellInput, context, suppliedTarget) {
  const target = requestedTarget(suppliedTarget);
  const input = requestedInput(shellInput);
  const product = requestedProduct(sourceProduct);
  if (!context || typeof context.assertIdentity !== 'function') fail('Missing reconciliation identity assertion');
  if (!page || typeof page.route !== 'function' || typeof page.unroute !== 'function') fail('Invalid reconciliation page');
  const readOnly = async route => {
    if (!['GET', 'HEAD'].includes(route.request().method())) return route.abort('blockedbyclient');
    return route.fallback();
  };
  await page.route('**/*', readOnly);
  try {
    await context.assertIdentity();
    const first = await readExact(page, target);
    verifySnapshot(first.list, first.detail, target, input, product);
    const second = await readExact(page, target);
    verifySnapshot(second.list, second.detail, target, input, product);
    if (canonical(first) !== canonical(second)) fail('Schedule shell changed during reconciliation');
    await context.assertIdentity();
    return { status: 'schedule-saved', productId: target.productId, scheduleId: target.scheduleId, fields: { title: input.title, nights: product.nights, days: product.days }, verification: 'schedule-persistence-verified' };
  } finally {
    await page.unroute('**/*', readOnly);
  }
}
