// Package day contents (일정 콘텐츠 카드): link company-shared ERP contents (관광지 place, 식당 meal,
// 선택관광 optionaltour) into an existing package schedule as type 3/4/8 steps. The package day writer
// stays a blank-day text writer; this runs after it (or on an already saved product) and only appends
// steps after the day's last step, so earlier rows, meals, hotels and images are never touched.
// Contents are referenced by job key (create when missing, like the content flow), exact
// type+city+name (must already exist) or an existing ERP content ID.
import { CONTENT_TYPES, validateContentPlan } from './content-plan.mjs';
import { findContents, resolveContents, runContents } from './content-execution.mjs';
import { onErp, getJson, post } from './fit-execution.mjs';

const fail = message => { throw new Error(message); };
const ID = /^[1-9][0-9]{0,12}$/;
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

/** ERP schedule step type for each content type that can be a day card (shopping/meeting cannot). */
export const DAY_CARD_TYPES = Object.freeze({ meal: 3, place: 4, optionaltour: 8 });
const HOTEL_STEP = 999;

const text = (value, where, max) => {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value !== value.trim() || value.length > max || /[<>\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) fail(`${where}는 앞뒤 공백·HTML 없는 ${max}자 이하 문자열이어야 합니다.`);
  return value;
};
const id = (value, where) => { const result = String(value ?? ''); if (!ID.test(result)) fail(`${where}는 ERP 숫자 ID여야 합니다.`); return result; };

function reference(value, where, type, keys) {
  if (typeof value === 'string') value = { key: value };
  if (!plainObject(value)) fail(`${where}는 콘텐츠 key 문자열, {contentId} 또는 {name, cityLabel}입니다.`);
  const names = Object.keys(value).sort().join(',');
  if (names === 'key') {
    const item = keys.get(value.key) ?? fail(`${where}.key ${value.key}는 contents에 없는 key입니다.`);
    if (item.type !== type) fail(`${where}의 ${item.name}은(는) ${CONTENT_TYPES[item.type].label}라서 ${CONTENT_TYPES[type].label} 카드에 넣을 수 없습니다.`);
    return { key: value.key };
  }
  if (names === 'contentId') return { contentId: id(value.contentId, `${where}.contentId`) };
  if (names === 'cityLabel,name') return { name: text(value.name, `${where}.name`, 100) || fail(`${where}.name이 필요합니다.`), cityLabel: text(value.cityLabel, `${where}.cityLabel`, 60) || fail(`${where}.cityLabel이 필요합니다.`) };
  fail(`${where}는 key, contentId, name+cityLabel 중 한 형식만 사용합니다.`);
}

/**
 * Validates the day-contents input. `contents` are optional full content definitions (content flow
 * format) created only when no exact active record exists; `days[].cards[]` are appended in order.
 */
export function validateDayContentPlan(input, { imageIds = new Set() } = {}) {
  if (!plainObject(input)) fail('dayContents 입력은 객체여야 합니다.');
  const extra = Object.keys(input).filter(key => !['productId', 'scheduleId', 'contents', 'days'].includes(key));
  if (extra.length) fail(`지원하지 않는 항목: ${extra.join(', ')}`);
  if ((input.productId === undefined) !== (input.scheduleId === undefined)) fail('productId와 scheduleId는 함께 주거나 함께 생략합니다(생략하면 완료된 패키지 작업 결과를 사용).');
  const target = input.productId === undefined ? null : { productId: id(input.productId, 'productId'), scheduleId: id(input.scheduleId, 'scheduleId') };
  const contents = input.contents === undefined ? [] : validateContentPlan(input.contents, { imageIds });
  for (const item of contents) if (!Object.hasOwn(DAY_CARD_TYPES, item.type)) fail(`${CONTENT_TYPES[item.type].label}(${item.name})은 일정 카드로 연결할 수 없습니다. 일정 카드는 관광지·식당·선택관광만 됩니다.`);
  const keys = new Map(contents.map(item => [item.key, item]));
  if (!Array.isArray(input.days) || input.days.length < 1 || input.days.length > 366) fail('days는 1개 이상의 일차 배열이어야 합니다.');
  const seen = new Set(), used = new Set();
  const days = input.days.map((day, index) => {
    const where = `days[${index}]`;
    if (!plainObject(day) || Object.keys(day).sort().join(',') !== 'cards,day') fail(`${where}는 {day, cards}만 받습니다.`);
    if (!Number.isSafeInteger(day.day) || day.day < 1 || day.day > 366 || seen.has(day.day)) fail(`${where}.day는 중복 없는 1~366 일차입니다.`);
    seen.add(day.day);
    if (!Array.isArray(day.cards) || day.cards.length < 1 || day.cards.length > 20) fail(`${where}.cards는 1~20개입니다.`);
    const cards = day.cards.map((card, cardIndex) => {
      const at = `${where}.cards[${cardIndex}]`;
      if (!plainObject(card)) fail(`${at}는 객체여야 합니다.`);
      const unknown = Object.keys(card).filter(key => !['type', 'title', 'description', 'contents'].includes(key));
      if (unknown.length) fail(`${at}에 지원하지 않는 항목이 있습니다: ${unknown.join(', ')}`);
      if (!Object.hasOwn(DAY_CARD_TYPES, card.type)) fail(`${at}.type은 place(관광지)/meal(식당)/optionaltour(선택관광) 중 하나입니다.`);
      if (!Array.isArray(card.contents) || card.contents.length < 1 || card.contents.length > 20) fail(`${at}.contents는 1~20개입니다.`);
      const refs = card.contents.map((ref, refIndex) => reference(ref, `${at}.contents[${refIndex}]`, card.type, keys));
      for (const ref of refs) if (ref.key) used.add(ref.key);
      if (new Set(refs.map(ref => JSON.stringify(ref))).size !== refs.length) fail(`${at}에 같은 콘텐츠가 중복됩니다.`);
      return { type: card.type, title: text(card.title, `${at}.title`, 200), description: text(card.description, `${at}.description`, 3000), refs };
    });
    return { day: day.day, cards };
  }).sort((left, right) => left.day - right.day);
  const unused = contents.filter(item => !used.has(item.key)).map(item => item.key);
  if (unused.length) fail(`일정에 연결하지 않는 contents가 있습니다: ${unused.join(', ')}`);
  return { target, contents, days };
}

// ---------- read-only ERP reads ----------

function treeRow(row) {
  if (!plainObject(row) || !ID.test(String(row.id)) || !Number.isSafeInteger(row.day) || !Number.isSafeInteger(row.step) || !Number.isSafeInteger(row.type_id)) fail('일정 상세의 일정 행 형식이 예상과 다릅니다.');
  const value = { id: String(row.id), day: row.day, step: row.step, typeId: row.type_id, description: row.description ?? null, dayTitle: row.day_title ?? null };
  for (const key of ['etc1', 'etc2', 'etc3', 'etc4', 'etc5', 'etc6']) value[key] = row[key] ?? null;
  for (const kind of ['breakfast', 'lunch', 'dinner']) value[kind] = [row[`${kind}_type`] ?? null, row[`${kind}_text`] ?? null];
  return value;
}
function contentRow(row) {
  if (!plainObject(row) || !ID.test(String(row.detail_id)) || !ID.test(String(row.contents_id))) fail('일정 상세의 콘텐츠 행 형식이 예상과 다릅니다.');
  return { detailId: String(row.detail_id), contentId: String(row.contents_id), originId: row.origin_id === undefined || row.origin_id === null ? null : String(row.origin_id), sort: row.detail_sort ?? null, name: row.name_ko ?? null, remark: row.remark ?? null, confirm: row.confirm ?? null };
}

/** Independent JSON readback of one package schedule (GET only). */
export async function readPackageSchedule(page, { productId, scheduleId }) {
  const body = await getJson(page, `/tour/master_product_schedule/${scheduleId}/detail/`);
  if (!plainObject(body) || !plainObject(body.schedule) || !Array.isArray(body.schedule_tree) || !Array.isArray(body.contents) || !Array.isArray(body.images)) fail('일정 상세 응답 형식이 예상과 다릅니다.');
  if (String(body.schedule.id) !== scheduleId || String(body.schedule.product) !== productId) fail(`일정표 ${scheduleId}은(는) 상품 ${productId}의 일정표가 아닙니다.`);
  if (!Number.isSafeInteger(body.schedule.day) || body.schedule.day < 1) fail('일정표 일수를 확인할 수 없습니다.');
  const tree = body.schedule_tree.map(treeRow);
  if (new Set(tree.map(row => row.id)).size !== tree.length) fail('일정 상세에 중복된 일정 행이 있습니다.');
  const { id: scheduleRowId, product, title, day, night, code } = body.schedule;
  return { productId, scheduleId, schedule: { id: String(scheduleRowId), product: String(product), title, days: day, nights: night, code }, tree, contents: body.contents.map(contentRow), images: JSON.stringify(body.images) };
}

/** Reads an existing ERP content by ID from its native change form; it must be active. */
export async function readContentById(page, type, contentId) {
  const html = await page.evaluate(async url => {
    const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
    if (response.status !== 200) throw new Error(`콘텐츠 조회 실패 ${response.status}: ${url}`);
    const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
    const field = name => doc.querySelectorAll(`[name="${name}"]`);
    return { names: [...field('name_ko')].map(e => e.value), use: [...field('use_flag')].map(e => e.value) };
  }, `/contents/${CONTENT_TYPES[type].path}/${contentId}/change/`);
  if (html.names.length !== 1 || !html.names[0]?.trim()) fail(`${CONTENT_TYPES[type].label} 콘텐츠 ${contentId}를 찾지 못했습니다.`);
  if (html.use.length !== 1 || html.use[0] !== 'True') fail(`${CONTENT_TYPES[type].label} 콘텐츠 ${contentId}(${html.names[0]})는 사용 중지 상태입니다.`);
  return { contentId, name: html.names[0] };
}

/** Cards already on a day, in step order, with their linked content IDs. */
export function dayCards(snapshot, day) {
  return snapshot.tree.filter(row => row.day === day && Object.values(DAY_CARD_TYPES).includes(row.typeId)).sort((a, b) => a.step - b.step)
    .map(row => ({ detailId: row.id, step: row.step, typeId: row.typeId, title: row.etc1 ?? '', description: row.description ?? '', contentIds: snapshot.contents.filter(c => c.detailId === row.id).sort((a, b) => a.sort - b.sort).map(c => c.contentId) }));
}
const cardMatches = (existing, card, contentIds) => existing.typeId === DAY_CARD_TYPES[card.type] && existing.title === card.title && existing.description === card.description && same(existing.contentIds, contentIds);

/** Planned cards of `day` that are already saved on it, in order; null when none, fail when partial. */
export function savedCards(snapshot, day, contentIds) {
  const existing = dayCards(snapshot, day.day), found = [];
  for (const [index, card] of day.cards.entries()) {
    const match = existing.find(row => !found.includes(row) && cardMatches(row, card, contentIds[index]));
    if (match) found.push(match);
  }
  if (!found.length) return null;
  if (found.length !== day.cards.length) fail(`${day.day}일차에 계획한 콘텐츠 카드 일부만 저장돼 있습니다. ERP에서 확인하세요.`);
  return found;
}

/** Read-only review: target schedule, every referenced content (reuse/create) and per-day state. */
export async function resolveDayContents(page, plan) {
  await onErp(page);
  const snapshot = await readPackageSchedule(page, plan.target);
  for (const day of plan.days) if (day.day > snapshot.schedule.days) fail(`${day.day}일차는 ${snapshot.schedule.days}일 일정표에 없습니다.`);
  const { regions, existing } = plan.contents.length ? await resolveContents(page, plan.contents) : { regions: {}, existing: {} };
  const named = {}, byId = {};
  for (const day of plan.days) for (const card of day.cards) for (const ref of card.refs) {
    if (ref.name) {
      const key = `${card.type}\u0000${ref.cityLabel}\u0000${ref.name}`;
      if (named[key]) continue;
      const found = await findContents(page, { type: card.type, name: ref.name, cityLabel: ref.cityLabel });
      if (found.length !== 1) fail(found.length ? `같은 도시에 같은 이름의 ${CONTENT_TYPES[card.type].label} 콘텐츠가 여러 개입니다: ${ref.name}` : `${CONTENT_TYPES[card.type].label} 콘텐츠 "${ref.name}"(${ref.cityLabel})이 ERP에 없습니다. 새로 만들려면 contents에 정의하고 key로 연결하세요.`);
      named[key] = found[0];
    } else if (ref.contentId) {
      const key = `${card.type}\u0000${ref.contentId}`;
      if (!byId[key]) byId[key] = (await readContentById(page, card.type, ref.contentId)).name;
    }
  }
  const resolved = { schedule: snapshot.schedule, regions, existing, named, byId };
  const days = plan.days.map(day => {
    const ids = contentIdsFor(plan, resolved, day);
    const saved = ids.every(list => list.every(Boolean)) ? savedCards(snapshot, day, ids) : null;
    return { day: day.day, alreadySaved: Boolean(saved) };
  });
  return { ...resolved, days };
}

/** Content IDs per card of a day; null for a keyed content that will be created. */
function contentIdsFor(plan, resolved, day, created = {}) {
  return day.cards.map(card => card.refs.map(ref => ref.key ? (created[ref.key] ?? resolved.existing[ref.key]) : ref.name ? resolved.named[`${card.type}\u0000${ref.cityLabel}\u0000${ref.name}`] : ref.contentId));
}

function refLabel(plan, resolved, card, ref) {
  if (ref.key) { const item = plan.contents.find(entry => entry.key === ref.key); return `${item.name}(${resolved.existing[ref.key] ? '기존 ' + resolved.existing[ref.key] : '신규 생성'})`; }
  if (ref.name) return `${ref.name}(기존 ${resolved.named[`${card.type}\u0000${ref.cityLabel}\u0000${ref.name}`]})`;
  return `${resolved.byId[`${card.type}\u0000${ref.contentId}`]}(번호 ${ref.contentId})`;
}

export function dayContentSummary(plan, resolved) {
  return plan.days.map(day => `${day.day}일차${resolved.days.find(row => row.day === day.day)?.alreadySaved ? ' (이미 저장됨)' : ''}: ` + day.cards.map(card => `${CONTENT_TYPES[card.type].label} 카드${card.title ? ' "' + card.title + '"' : ''} — ${card.refs.map(ref => refLabel(plan, resolved, card, ref)).join(', ')}`).join(' / '));
}

// ---------- write + verification ----------

/** Exact native save payload that appends `cards` after `lastStep` on one day. */
export function appendPayload(target, day, cards, contentIds, lastStep) {
  return {
    day, product_id: target.productId, updated_list: [], deleted_list: [],
    created_list: cards.map((card, index) => ({ type_id: DAY_CARD_TYPES[card.type], step: lastStep + index + 1, etc1: card.title, description: card.description, contents: contentIds[index].map((contentId, sort) => ({ contents_id: Number(contentId), remark: '', is_new: true, sort })), day }))
  };
}
export function lastStep(snapshot, day) { return Math.max(0, ...snapshot.tree.filter(row => row.day === day && row.step !== HOTEL_STEP).map(row => row.step)); }

/** Proves the save appended exactly the planned cards to `day` and changed nothing else. */
export function verifyAppend(before, after, { day, cards, contentIds, lastStep: base }) {
  if (!same(before.schedule, after.schedule) || before.images !== after.images) fail(`${day}일차 저장 뒤 일정표 정보 또는 이미지가 바뀌었습니다.`);
  const afterRows = new Map(after.tree.map(row => [row.id, row]));
  for (const row of before.tree) if (!same(row, afterRows.get(row.id))) fail(`${day}일차 저장 뒤 기존 일정 행(${row.day}일차 ${row.step}단계)이 바뀌었습니다.`);
  const beforeIds = new Set(before.tree.map(row => row.id));
  const added = after.tree.filter(row => !beforeIds.has(row.id)).sort((a, b) => a.step - b.step);
  if (added.length !== cards.length) fail(`${day}일차에 추가된 일정 행 수(${added.length})가 계획(${cards.length})과 다릅니다.`);
  added.forEach((row, index) => {
    const card = cards[index];
    if (row.day !== day || row.step !== base + index + 1 || row.typeId !== DAY_CARD_TYPES[card.type] || (row.etc1 ?? '') !== card.title || (row.description ?? '') !== card.description) fail(`${day}일차 ${index + 1}번째 콘텐츠 카드 재조회가 계획과 다릅니다.`);
  });
  const key = row => JSON.stringify(row);
  const beforeContents = new Set(before.contents.map(key)), afterContents = new Set(after.contents.map(key));
  for (const row of before.contents) if (!afterContents.has(key(row))) fail(`${day}일차 저장 뒤 기존 콘텐츠 연결이 바뀌었습니다.`);
  const addedIds = new Set(added.map(row => row.id));
  const extra = after.contents.filter(row => !beforeContents.has(key(row)));
  if (extra.some(row => !addedIds.has(row.detailId))) fail(`${day}일차 저장 뒤 다른 일정 행에 콘텐츠가 추가됐습니다.`);
  added.forEach((row, index) => {
    const linked = extra.filter(content => content.detailId === row.id).sort((a, b) => a.sort - b.sort).map(content => content.contentId);
    if (!same(linked, contentIds[index])) fail(`${day}일차 ${index + 1}번째 카드의 연결 콘텐츠(${linked.join(',') || '없음'})가 계획(${contentIds[index].join(',')})과 다릅니다.`);
  });
  return added.map((row, index) => ({ type: cards[index].type, detailId: row.id, contentIds: contentIds[index] }));
}

/**
 * Runs a reviewed day-contents plan: missing keyed contents (shared engine), then one guarded append
 * per day with an independent readback, then a final readback of every saved card.
 * Journal phases: content*, image (content engine), day-attempt, day-rejected, day.
 */
export async function runDayContents({ page, plan, resolved, images, journal, assertIdentity, companyId, progress = () => {} }) {
  const target = plan.target;
  const created = {};
  if (plan.contents.length) {
    progress('contents');
    for (const row of await runContents({ page, items: plan.contents, resolved: { regions: resolved.regions }, images, journal, assertIdentity, companyId, progress: name => progress(`contents:${name}`) })) created[row.key] = row.contentId;
  }
  // Name references must still point at the reviewed record.
  for (const [key, contentId] of Object.entries(resolved.named)) {
    const [type, cityLabel, name] = key.split('\u0000');
    const found = await findContents(page, { type, cityLabel, name });
    if (found.length !== 1 || found[0] !== contentId) fail(`${name} 콘텐츠 번호가 검토 때(${contentId})와 다릅니다. 다시 검토하세요.`);
  }
  const done = new Map(journal.rows.filter(row => row.phase === 'day').map(row => [row.day, row]));
  const results = [];
  for (const day of plan.days) {
    progress(`day:${day.day}`);
    await assertIdentity(); await onErp(page);
    const contentIds = contentIdsFor(plan, resolved, day, created);
    if (contentIds.some(list => list.some(value => !ID.test(String(value ?? ''))))) fail(`${day.day}일차 콘텐츠 번호를 확정하지 못했습니다.`);
    const before = await readPackageSchedule(page, target);
    const saved = savedCards(before, day, contentIds);
    if (saved) {
      const cards = saved.map((row, index) => ({ type: day.cards[index].type, detailId: row.detailId, contentIds: row.contentIds }));
      const earlier = done.get(day.day);
      if (earlier && !same(earlier.cards.map(card => card.detailId), cards.map(card => card.detailId))) fail(`${day.day}일차 저장된 카드 번호가 장부와 다릅니다. ERP에서 확인하세요.`);
      if (!earlier) await journal.append({ phase: 'day', day: day.day, cards, reconciled: true });
      results.push({ day: day.day, cards, created: false });
      continue;
    }
    if (done.has(day.day)) fail(`${day.day}일차에 저장했던 콘텐츠 카드가 재조회되지 않습니다. ERP에서 확인하세요.`);
    const attempts = journal.rows.filter(row => row.day === day.day && ['day-attempt', 'day-rejected'].includes(row.phase));
    if (attempts.at(-1)?.phase === 'day-attempt') fail(`${day.day}일차 저장 시도의 응답을 받지 못했고 재조회에도 없습니다. 결과가 불명확하므로 자동 재시도하지 않습니다. ERP에서 확인하세요.`);
    const base = lastStep(before, day.day), payload = appendPayload(target, day.day, day.cards, contentIds, base);
    await assertIdentity();
    await journal.append({ phase: 'day-attempt', day: day.day, lastStep: base });
    const response = await post(page, `/tour/master_product_schedule/${target.scheduleId}/change/`, { json: payload });
    if (response.status < 200 || response.status >= 300) {
      let message = ''; try { message = String(JSON.parse(response.text).message ?? ''); } catch {}
      const after = await readPackageSchedule(page, target);
      if (!same(after, before)) fail(`${day.day}일차 저장이 거절(${response.status})됐지만 일정이 바뀌었습니다. ERP에서 확인하세요.`);
      await journal.append({ phase: 'day-rejected', day: day.day, status: response.status });
      fail(`${day.day}일차 콘텐츠 카드 저장 응답이 ${response.status}입니다. ${message}`.trim());
    }
    const after = await readPackageSchedule(page, target);
    const cards = verifyAppend(before, after, { day: day.day, cards: day.cards, contentIds, lastStep: base });
    await assertIdentity();
    await journal.append({ phase: 'day', day: day.day, cards });
    results.push({ day: day.day, cards, created: true });
  }
  progress('final');
  const final = await readPackageSchedule(page, target);
  for (const day of results) {
    const current = dayCards(final, day.day);
    for (const card of day.cards) {
      const row = current.find(entry => entry.detailId === card.detailId);
      if (!row || row.typeId !== DAY_CARD_TYPES[card.type] || !same(row.contentIds, card.contentIds)) fail(`${day.day}일차 콘텐츠 카드 최종 재조회가 저장 결과와 다릅니다.`);
    }
  }
  await assertIdentity();
  return { productId: target.productId, scheduleId: target.scheduleId, productUrl: `https://basecamp.team/tour/master_product/${target.productId}/change/`, days: results, contents: Object.entries(created).map(([key, contentId]) => ({ key, contentId, created: journal.rows.some(row => row.phase === 'content' && row.key === key && row.created) })) };
}
