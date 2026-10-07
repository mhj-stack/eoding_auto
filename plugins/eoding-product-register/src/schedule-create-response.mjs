const ID = /^[1-9]\d{0,9}$/;
const ERROR = 'Invalid schedule create response';

function invalid() {
  return new Error(ERROR);
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys) {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function validTitle(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 20000 && value.trim() === value;
}

function validDuration(nights, days) {
  return Number.isInteger(nights) && Number.isInteger(days)
    && nights >= 0 && nights <= 365
    && days >= 1 && days <= 366
    && nights < days;
}

function checkedRequested(value) {
  if (!record(value) || !exactKeys(value, ['title', 'nights', 'days'])
    || !validTitle(value.title) || !validDuration(value.nights, value.days)) {
    throw invalid();
  }
  return { title: value.title, nights: value.nights, days: value.days };
}

function checkedId(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 1 || value > 9999999999) throw invalid();
    return String(value);
  }
  if (typeof value === 'string' && ID.test(value)) return value;
  throw invalid();
}

export function parseScheduleCreateResponse(body, requested) {
  try {
    const fields = checkedRequested(requested);
    if (!record(body) || !['id', 'title', 'night', 'day'].every(key => Object.hasOwn(body, key))) throw invalid();
    const scheduleId = checkedId(body.id);
    if (body.title !== fields.title || body.night !== fields.nights || body.day !== fields.days) throw invalid();
    return { scheduleId, title: fields.title, nights: fields.nights, days: fields.days };
  } catch {
    throw invalid();
  }
}
