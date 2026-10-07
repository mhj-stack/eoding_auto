import { readScheduleList } from './schedule-read.mjs';

const UNKNOWN_SAVE_OUTCOME = 'UNKNOWN_SAVE_OUTCOME';
const ID = /^[1-9]\d{0,9}$/;

function unknownSaveOutcome() {
  const error = new Error('reconcile-before-retry');
  error.code = UNKNOWN_SAVE_OUTCOME;
  return error;
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys) {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function canonicalId(value) {
  return typeof value === 'string' && ID.test(value);
}

function canonicalTitle(value) {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function canonicalDuration(nights, days) {
  return Number.isInteger(nights) && Number.isInteger(days)
    && nights >= 0 && nights <= 365
    && days >= 1 && days <= 366
    && nights < days;
}

function checkedRequested(value) {
  if (!record(value) || !exactKeys(value, ['title', 'nights', 'days'])
    || !canonicalTitle(value.title) || !canonicalDuration(value.nights, value.days)) {
    throw unknownSaveOutcome();
  }
  return { title: value.title, nights: value.nights, days: value.days };
}

function checkedSnapshot(value, expectedProductId) {
  if (!record(value) || !exactKeys(value, ['productId', 'schedules'])
    || value.productId !== expectedProductId || !Array.isArray(value.schedules)) {
    throw unknownSaveOutcome();
  }
  const rows = new Map();
  for (const valueRow of value.schedules) {
    if (!record(valueRow) || !exactKeys(valueRow, ['scheduleId', 'title', 'nights', 'days'])
      || !canonicalId(valueRow.scheduleId) || !canonicalTitle(valueRow.title)
      || !canonicalDuration(valueRow.nights, valueRow.days) || rows.has(valueRow.scheduleId)) {
      throw unknownSaveOutcome();
    }
    rows.set(valueRow.scheduleId, {
      scheduleId: valueRow.scheduleId,
      title: valueRow.title,
      nights: valueRow.nights,
      days: valueRow.days
    });
  }
  return rows;
}

function equalRow(left, right) {
  return left.scheduleId === right.scheduleId
    && left.title === right.title
    && left.nights === right.nights
    && left.days === right.days;
}

/**
 * Reconciles a prior read with one readback. A verified result proves only
 * matching server readback, not authorization or which caller saved it.
 */
export function reconcileScheduleCreation(input) {
  try {
    if (!record(input) || !exactKeys(input, ['productId', 'assignedScheduleId', 'requested', 'before', 'after'])) throw unknownSaveOutcome();
    const { productId, assignedScheduleId, requested, before, after } = input;
    if (!canonicalId(productId) || !canonicalId(assignedScheduleId)) throw unknownSaveOutcome();
    const fields = checkedRequested(requested);
    const previous = checkedSnapshot(before, productId);
    const readback = checkedSnapshot(after, productId);

    if (previous.has(assignedScheduleId)
      || [...previous.values()].some(row => row.title === fields.title)
      || readback.size !== previous.size + 1) {
      throw unknownSaveOutcome();
    }
    for (const [scheduleId, row] of previous) {
      if (!equalRow(row, readback.get(scheduleId))) throw unknownSaveOutcome();
    }
    const persisted = readback.get(assignedScheduleId);
    if (!persisted || !equalRow(persisted, { scheduleId: assignedScheduleId, ...fields })) {
      throw unknownSaveOutcome();
    }
    for (const scheduleId of readback.keys()) {
      if (!previous.has(scheduleId) && scheduleId !== assignedScheduleId) throw unknownSaveOutcome();
    }
    return {
      status: 'schedule-persistence-verified',
      productId,
      scheduleId: assignedScheduleId,
      fields
    };
  } catch {
    throw unknownSaveOutcome();
  }
}

/** Read one server schedule list and reconcile it; this function never writes. */
export async function verifyScheduleCreation(page, input) {
  try {
    if (!record(input) || !exactKeys(input, ['productId', 'assignedScheduleId', 'requested', 'before'])) throw unknownSaveOutcome();
    const { productId, assignedScheduleId, requested, before } = structuredClone(input);
    if (!canonicalId(productId) || !canonicalId(assignedScheduleId)) throw unknownSaveOutcome();
    const fields = checkedRequested(requested);
    const previous = checkedSnapshot(before, productId);
    if (previous.has(assignedScheduleId) || [...previous.values()].some(row => row.title === fields.title)) throw unknownSaveOutcome();
    const after = await readScheduleList(page, { productId });
    return reconcileScheduleCreation({ productId, assignedScheduleId, requested: fields, before, after });
  } catch {
    throw unknownSaveOutcome();
  }
}

export { UNKNOWN_SAVE_OUTCOME };
