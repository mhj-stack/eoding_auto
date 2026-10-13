/** Pure preflight and timing rules. No browser, credentials, or ERP writes. */
export const SETUP_TARGET_MS = 20 * 60 * 1000;
const fail = message => { throw new Error(message); };
const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value ?? '') && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const validTime = value => /^(?:[01]\d|2[0-3]):[0-5]\d(?::00)?$/.test(value ?? '');

export function flightPreflight(season, departure) {
  const questions = [], fields = season?.fields ?? {};
  const add = (field, message) => questions.push({ field: `season.fields.${field}`, message });
  for (const direction of ['depart', 'arrive']) {
    const prefix = `${direction}-0-`, date = fields[prefix + 'depart_date'];
    if (!validDate(date)) add(prefix + 'depart_date', '항공 출발일을 실제 YYYY-MM-DD 날짜로 입력하세요.');
    for (const key of ['depart_time', 'arrive_time']) if (!validTime(fields[prefix + key])) add(prefix + key, '항공 현지 시각을 HH:mm 형식으로 입력하세요.');
    const duration = fields[prefix + 'moving_time'];
    if (!/^[1-9]\d{0,3}$/.test(duration ?? '') || Number(duration) > 2880) add(prefix + 'moving_time', '비행시간(분)이 필요합니다. 원문 또는 시차가 명시된 출발·도착 일시로 확인하세요.');
    const next = season?.selects?.[prefix + 'next_day'] ?? fields[prefix + 'next_day'];
    if (next !== undefined && !['', '1', '2', '3'].includes(next)) add(prefix + 'next_day', 'ERP 도착일 선택값은 당일="", +1="1", +2="2", -1="3"입니다.');
  }
  if (departure) {
    if (!validDate(departure.startDate) || !validDate(departure.endDate) || departure.startDate > departure.endDate) questions.push({ field: 'product.departures', message: '출발일과 귀국일을 확인하세요.' });
    if (fields['depart-0-depart_date'] !== departure.startDate) add('depart-0-depart_date', '출국 항공일이 선택한 출발일과 다릅니다.');
    if (validDate(fields['arrive-0-depart_date']) && validDate(departure.endDate)) {
      const end = new Date(fields['arrive-0-depart_date'] + 'T00:00:00Z');
      const offset = season?.selects?.['arrive-0-next_day'] ?? fields['arrive-0-next_day'] ?? '';
      end.setUTCDate(end.getUTCDate() + ({ '': 0, '1': 1, '2': 2, '3': -1 }[offset] ?? 0));
      if (end.toISOString().slice(0, 10) !== departure.endDate) add('arrive-0-depart_date', '귀국 항공 도착일이 여행 종료일과 다릅니다.');
    }
  }
  return questions;
}

/** Requires explicit timezone offsets: local clock subtraction alone is not a duration. */
export function flightMinutes(departureAt, arrivalAt) {
  const stamp = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::00)?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/;
  for (const value of [departureAt, arrivalAt]) if (typeof value !== 'string' || !stamp.test(value) || !validDate(value.slice(0, 10))) fail('출발·도착 일시에는 실제 날짜와 명시적인 시차가 필요합니다.');
  const minutes = (Date.parse(arrivalAt) - Date.parse(departureAt)) / 60000;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 2880) fail('비행시간은 1~2880분이어야 합니다.');
  return minutes;
}

export function sourceQuality(source) {
  if (source?.kind !== 'url') return { status: 'provided', needsBrowserRead: false };
  const evidence = source.evidence ?? {}, content = [evidence.text, evidence.content, evidence.bodyText, evidence.visibleText].filter(value => typeof value === 'string').join('\n');
  // Advisory only: length does not prove factual completeness. AI must still reconcile every day.
  const hasItinerary = /(?:[1-9]\s*일차|day\s*[1-9]|itinerary)/i.test(content);
  const hasCommercial = /(?:포함|불포함|원\b|KRW|price|included|₩)/i.test(content);
  const needsBrowserRead = content.trim().length < 500 || !hasItinerary || !hasCommercial;
  return { status: needsBrowserRead ? 'possibly-incomplete' : 'content-detected', needsBrowserRead, characters: content.length, hasItinerary, hasCommercial, notice: needsBrowserRead ? '메뉴·초기 화면만 수집됐을 수 있습니다. 같은 URL을 반복 수집하지 말고 열린 상품 화면의 상세·모든 일차를 읽어 source_supplement에 추가하세요.' : '전체 일차·식사·요금의 원문 대조는 여전히 필요합니다.' };
}

export function workflowTiming(job, now = Date.now()) {
  const startedAt = Date.parse(job.startedAt ?? job.createdAt), finishedAt = job.finishedAt ? Date.parse(job.finishedAt) : now;
  const elapsedMs = Math.max(0, finishedAt - startedAt);
  const waits = (job.waits ?? []).map(wait => ({ reason: wait.reason, ms: Math.max(0, Math.min(finishedAt, wait.endedAt ?? finishedAt) - Math.max(startedAt, wait.startedAt)) }));
  const userWaitMs = Math.min(elapsedMs, waits.reduce((sum, wait) => sum + wait.ms, 0));
  return { targetMs: SETUP_TARGET_MS, elapsedMs, userWaitMs, processingAndCoordinationMs: elapsedMs - userWaitMs, remainingMs: Math.max(0, SETUP_TARGET_MS - elapsedMs), targetMet: job.finishedAt ? elapsedMs <= SETUP_TARGET_MS : null, warning: elapsedMs > SETUP_TARGET_MS ? 'over-target' : elapsedMs >= 15 * 60000 ? 'five-minutes-left' : null, waits, basis: 'source-start-to-final-readback; user waits are explicit, AI coordination is included' };
}

export function changeWait(job, reason, now = Date.now()) {
  if (reason !== null && !['login', 'missing-input', 'approval'].includes(reason)) fail('대기 사유는 login, missing-input, approval 또는 null입니다.');
  job.waits ??= [];
  const active = job.waits.at(-1);
  if (active && !active.endedAt) {
    if (active.reason === reason) return;
    active.endedAt = now;
  }
  if (reason) job.waits.push({ reason, startedAt: now });
}
