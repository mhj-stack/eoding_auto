// Free independent travel (FIT, 자유여행) registration plan: strict validation of the AI-authored
// draft and the exact ERP payloads derived from it. Pure functions only; no ERP or file access.

const fail = message => { throw new Error(message); };

export const FIT_CATEGORIES = Object.freeze({ 관광: '1', 티켓: '2', 체험: '3', 교통: '4', 숙박: '5', 호텔: '6', 'WIFI/SIM': '7' });
export const FIT_MASTER_STATUS = Object.freeze({ 판매대기: '1', 비공개: '4' });
export const FIT_SALE_STATUS = Object.freeze({ 판매대기: '1', 판매중: '2' });
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const KEY = /^[a-z0-9][a-z0-9-]{0,39}$/;

const object = (value, keys, where) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${where}는 객체여야 합니다.`);
  const extra = Object.keys(value).filter(key => !keys.includes(key));
  if (extra.length) fail(`${where}에 지원하지 않는 항목이 있습니다: ${extra.join(', ')}`);
  return value;
};
const text = (value, where, max, { optional = false, multiline = false } = {}) => {
  if (optional && (value === undefined || value === '')) return '';
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > max) fail(`${where}는 앞뒤 공백 없는 1~${max}자 문자열이어야 합니다.`);
  if (!multiline && /[\r\n]/.test(value)) fail(`${where}에는 줄바꿈을 넣지 마세요.`);
  return value;
};
const integer = (value, where, min, max) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${where}는 ${min}~${max} 정수여야 합니다.`);
  return value;
};
const array = (value, where, min, max) => {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail(`${where}는 ${min}~${max}개 배열이어야 합니다.`);
  return value;
};
const unique = (values, where) => { if (new Set(values).size !== values.length) fail(`${where}이(가) 중복됩니다.`); };
const dayIndex = value => { const time = Date.parse(value + 'T00:00:00Z'); return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time / 86400000 : NaN; };
export const cityName = label => label.replace(/\s*\([^()]*\)\s*$/, '').trim() || label;

/** One emphasized or plain sentence used by reference lists/text and the cancellation terms. */
function line(value, where) {
  if (typeof value === 'string') return { text: text(value, where, 500), emphasis: false };
  object(value, ['text', 'emphasis'], where);
  if (value.emphasis !== undefined && typeof value.emphasis !== 'boolean') fail(`${where}.emphasis는 true/false입니다.`);
  return { text: text(value.text, where + '.text', 500), emphasis: value.emphasis === true };
}

function imageRefs(list, where, imageIds, max) {
  array(list, where, 1, max);
  for (const id of list) if (!imageIds.has(id)) fail(`${where}의 ${id}는 이 작업에서 수집한 이미지 ID가 아닙니다.`);
  unique(list, where);
  return [...list];
}

/** Validates the complete FIT draft against the job's collected images; returns a normalized copy. */
export function validateFitPlan(draft, { imageIds = new Set() } = {}) {
  object(draft, ['master', 'images', 'places', 'options', 'sales', 'reference', 'schedule', 'terms'], 'fit');
  const m = object(draft.master, ['category', 'cityLabel', 'managerLabel', 'agentLabel', 'title', 'shortDescription', 'description', 'badges', 'status', 'sort', 'lowestPriceGuarantee', 'sameDayBooking', 'instantConfirm'], 'master');
  if (!Object.hasOwn(FIT_CATEGORIES, m.category)) fail(`master.category는 ${Object.keys(FIT_CATEGORIES).join('/')} 중 하나입니다.`);
  const status = m.status ?? '비공개';
  if (!Object.hasOwn(FIT_MASTER_STATUS, status)) fail('master.status는 비공개 또는 판매대기만 허용합니다(판매 공개는 사람이 결정).');
  const badges = m.badges === undefined ? [] : array(m.badges, 'master.badges', 0, 3).map((badge, index) => {
    text(badge, `master.badges[${index}]`, 8);
    if (badge.includes(',')) fail('뱃지에는 쉼표를 넣을 수 없습니다.');
    return badge;
  });
  for (const key of ['lowestPriceGuarantee', 'sameDayBooking', 'instantConfirm']) if (m[key] !== undefined && typeof m[key] !== 'boolean') fail(`master.${key}는 true/false입니다.`);
  const master = {
    category: m.category, cityLabel: text(m.cityLabel, 'master.cityLabel', 60), managerLabel: text(m.managerLabel, 'master.managerLabel', 60), agentLabel: text(m.agentLabel, 'master.agentLabel', 60),
    title: text(m.title, 'master.title', 100), shortDescription: text(m.shortDescription, 'master.shortDescription', 200), description: text(m.description, 'master.description', 2000, { multiline: true }),
    badges, status, sort: m.sort === undefined ? 1 : integer(m.sort, 'master.sort', 1, 999),
    // Never claim a lowest-price guarantee the source did not make.
    lowestPriceGuarantee: m.lowestPriceGuarantee === true, sameDayBooking: m.sameDayBooking !== false, instantConfirm: m.instantConfirm !== false
  };

  const im = object(draft.images, ['main', 'detail'], 'images');
  const images = { main: imageRefs(im.main, 'images.main', imageIds, 10), detail: im.detail === undefined ? [] : imageRefs(im.detail, 'images.detail', imageIds, 20) };
  if (images.detail.some(id => images.main.includes(id))) fail('대표 이미지와 상세 이미지는 겹치지 않게 나누세요(홈페이지 갤러리에 두 번 보입니다).');

  const places = (draft.places ?? []).map((p, index) => {
    const where = `places[${index}]`;
    object(p, ['key', 'name', 'nameEn', 'cityLabel', 'address', 'description', 'keyword', 'images'], where);
    if (typeof p.key !== 'string' || !KEY.test(p.key)) fail(`${where}.key는 영문 소문자·숫자·하이픈 1~40자입니다.`);
    return {
      key: p.key, name: text(p.name, where + '.name', 100), nameEn: text(p.nameEn, where + '.nameEn', 100, { optional: true }), cityLabel: text(p.cityLabel, where + '.cityLabel', 60),
      address: text(p.address, where + '.address', 200, { optional: true }), description: text(p.description, where + '.description', 3000, { multiline: true }),
      keyword: text(p.keyword, where + '.keyword', 200, { optional: true }), images: p.images === undefined ? [] : imageRefs(p.images, where + '.images', imageIds, 10)
    };
  });
  array(places, 'places', 0, 30);
  unique(places.map(p => p.key), 'places.key'); unique(places.map(p => p.cityLabel + '\u0000' + p.name), '같은 도시의 관광지 이름');
  const placeKeys = new Set(places.map(p => p.key));

  const options = array(draft.options, 'options', 1, 20).map((o, index) => {
    const where = `options[${index}]`;
    object(o, ['name', 'description', 'basePax', 'maxPax', 'priceTypes'], where);
    const priceTypes = array(o.priceTypes, where + '.priceTypes', 1, 10).map((name, i) => text(name, `${where}.priceTypes[${i}]`, 30));
    unique(priceTypes, where + '.priceTypes');
    const basePax = integer(o.basePax, where + '.basePax', 1, 999), maxPax = integer(o.maxPax, where + '.maxPax', 1, 999);
    if (maxPax < basePax) fail(`${where}.maxPax는 basePax 이상이어야 합니다.`);
    return { name: text(o.name, where + '.name', 100), description: text(o.description, where + '.description', 500, { optional: true }), basePax, maxPax, priceTypes };
  });
  unique(options.map(o => o.name), 'options.name');

  const sales = array(draft.sales, 'sales', 1, 60).map((s, index) => {
    const where = `sales[${index}]`;
    object(s, ['option', 'from', 'to', 'prices', 'status', 'stock'], where);
    const option = options.find(o => o.name === s.option) ?? fail(`${where}.option은 options의 이름이어야 합니다.`);
    for (const key of ['from', 'to']) if (typeof s[key] !== 'string' || !DATE.test(s[key]) || Number.isNaN(dayIndex(s[key]))) fail(`${where}.${key}는 YYYY-MM-DD 날짜입니다.`);
    const days = dayIndex(s.to) - dayIndex(s.from) + 1;
    if (days < 1 || days > 400) fail(`${where} 기간은 1~400일이어야 합니다.`);
    const saleStatus = s.status ?? '판매중';
    if (!Object.hasOwn(FIT_SALE_STATUS, saleStatus)) fail(`${where}.status는 판매중 또는 판매대기입니다.`);
    const prices = array(s.prices, where + '.prices', 1, 10).map((p, i) => {
      object(p, ['type', 'original', 'sale'], `${where}.prices[${i}]`);
      if (!option.priceTypes.includes(p.type)) fail(`${where}.prices[${i}].type은 옵션의 가격구분이어야 합니다.`);
      return { type: p.type, original: integer(p.original, `${where}.prices[${i}].original`, 0, 100000000), sale: integer(p.sale, `${where}.prices[${i}].sale`, 0, 100000000) };
    });
    if (!same(prices.map(p => p.type).sort(), [...option.priceTypes].sort())) fail(`${where}.prices는 옵션의 모든 가격구분(${option.priceTypes.join('/')})을 한 번씩 포함해야 합니다.`);
    return { option: option.name, from: s.from, to: s.to, days, prices: option.priceTypes.map(type => prices.find(p => p.type === type)), status: saleStatus, stock: integer(s.stock, where + '.stock', 0, 99999) };
  });
  for (const option of options) {
    const ranges = sales.filter(s => s.option === option.name).map(s => [dayIndex(s.from), dayIndex(s.to)]).sort((a, b) => a[0] - b[0]);
    if (!ranges.length) fail(`옵션 ${option.name}의 판매일이 없습니다.`);
    for (let i = 1; i < ranges.length; i++) if (ranges[i][0] <= ranges[i - 1][1]) fail(`옵션 ${option.name}의 판매기간이 겹칩니다.`);
  }

  const reference = array(draft.reference, 'reference', 1, 20).map((block, index) => {
    const where = `reference[${index}]`;
    object(block, ['title', 'elements'], where);
    const elements = array(block.elements, where + '.elements', 1, 30).map((element, i) => {
      const at = `${where}.elements[${i}]`;
      const kinds = ['text', 'list', 'heading', 'images'].filter(key => Object.hasOwn(element ?? {}, key));
      if (kinds.length !== 1) fail(`${at}는 text/list/heading/images 중 하나만 가집니다.`);
      object(element, kinds, at);
      if (kinds[0] === 'heading') return { heading: text(element.heading, at + '.heading', 100) };
      if (kinds[0] === 'images') return { images: imageRefs(element.images, at + '.images', imageIds, 10) };
      return { [kinds[0]]: array(element[kinds[0]], `${at}.${kinds[0]}`, 1, 30).map((item, n) => line(item, `${at}.${kinds[0]}[${n}]`)) };
    });
    return { title: text(block.title, where + '.title', 100), elements };
  });
  unique(reference.map(block => block.title), 'reference.title');

  const schedule = array(draft.schedule, 'schedule', 1, 30).map((day, index) => {
    const where = `schedule[${index}]`;
    object(day, ['day', 'steps'], where);
    if (day.day !== index + 1) fail(`${where}.day는 1부터 연속된 일차여야 합니다.`);
    const steps = array(day.steps, where + '.steps', 1, 20).map((step, i) => {
      const at = `${where}.steps[${i}]`;
      if (step?.kind === 'place') {
        object(step, ['kind', 'title', 'description', 'places'], at);
        const keys = array(step.places, at + '.places', 1, 10);
        for (const key of keys) if (!placeKeys.has(key)) fail(`${at}.places의 ${key}는 places.key가 아닙니다.`);
        unique(keys, at + '.places');
        return { kind: 'place', title: text(step.title, at + '.title', 200), description: text(step.description, at + '.description', 5000, { optional: true, multiline: true }), places: [...keys] };
      }
      if (step?.kind !== 'custom') fail(`${at}.kind는 custom 또는 place입니다.`);
      object(step, ['kind', 'title', 'short', 'description'], at);
      return { kind: 'custom', title: text(step.title, at + '.title', 200), short: text(step.short, at + '.short', 200, { optional: true }), description: text(step.description, at + '.description', 5000, { optional: true, multiline: true }) };
    });
    return { day: day.day, steps };
  });
  const usedPlaces = new Set(schedule.flatMap(day => day.steps.flatMap(step => step.places ?? [])));
  for (const key of placeKeys) if (!usedPlaces.has(key)) fail(`관광지 ${key}가 일정에 연결되지 않았습니다.`);

  const t = object(draft.terms, ['cancelRefund'], 'terms');
  const terms = { cancelRefund: array(t.cancelRefund, 'terms.cancelRefund', 1, 30).map((item, i) => line(item, `terms.cancelRefund[${i}]`)) };
  return { master, images, places, options, sales, reference, schedule, terms };
}

function same(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

/** Image IDs the plan uploads to the ERP library, in first-use order. */
export function planImageIds(plan) {
  return [...new Set([...plan.images.main, ...plan.images.detail, ...plan.places.flatMap(p => p.images), ...plan.reference.flatMap(b => b.elements.flatMap(e => e.images ?? []))])];
}

const row = ({ text: detail, emphasis }) => ({ detail, font_color: emphasis ? '1' : '0', bold_flag: emphasis ? '1' : '0' });
/** Native FIT reference payload (type 15 direct-input blocks); erpImage maps job image IDs to ERP IDs. */
export function referencePayload(reference, erpImage) {
  return reference.map((block, sort) => {
    let group = 0;
    const imageGroup = [];
    const elements = block.elements.map(element => {
      if (element.heading) return { type: 3, contents: element.heading };
      if (element.images) {
        group += 1;
        imageGroup.push({ group_id: group, image_list: element.images.map(id => ({ image_id: erpImage(id), image_url: '' })) });
        return { type: 4, contents: group };
      }
      return element.text ? { type: 1, contents: element.text.map(row) } : { type: 2, contents: element.list.map(row) };
    });
    return { etc: block.title, etc2: JSON.stringify(elements), image_group: imageGroup, sort, type: '15' };
  });
}

const escapeHtml = value => value.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
/** Emphasized cancellation/refund HTML for the FIT terms tab; every sentence is escaped. */
export function cancelRefundHtml(items) {
  return '<h3>취소 및 환불 규정</h3><ul>' + items.map(item => '<li>' + (item.emphasis ? `<b><span style="color:#e03e2d">${escapeHtml(item.text)}</span></b>` : escapeHtml(item.text)) + '</li>').join('') + '</ul>';
}

/** Multipart fields of the native place (관광지) content form. */
export function placeFields(place, region, erpImageIds) {
  return {
    spotpoi_id: '', geo_lat: '', geo_lng: '', image_sort: JSON.stringify({ old: [], new: erpImageIds.map((name, value) => ({ name, value })) }),
    name_ko: place.name, name: place.nameEn, spotpoi_name_ko: '', address: place.address, location: '',
    continent: region.continentId, country: region.countryId, city: region.cityId, use_flag: 'True', not_use_reason: '', homepage: '', description: place.description, keyword: place.keyword
  };
}

/** Every calendar date of a sale range, as the ERP list shows it (YYYY.MM.DD). */
export function saleDates(sale) {
  const start = dayIndex(sale.from);
  return Array.from({ length: sale.days }, (_, i) => new Date((start + i) * 86400000).toISOString().slice(0, 10).replaceAll('-', '.'));
}

/** Korean review summary shown before the user (or their explicit delegation) authorizes writes. */
export function fitSummary(plan, resolved) {
  const won = value => value.toLocaleString('ko-KR');
  return {
    상품: `${plan.master.title} (${plan.master.category}, ${plan.master.cityLabel}, ${plan.master.status})`,
    담당자: plan.master.managerLabel, 거래처: plan.master.agentLabel,
    뱃지: plan.master.badges, 최저가보장: plan.master.lowestPriceGuarantee,
    이미지: `대표 ${plan.images.main.length}장 / 상세 ${plan.images.detail.length}장 / 업로드 총 ${planImageIds(plan).length}장`,
    관광지콘텐츠: plan.places.map(p => `${p.name} (${p.cityLabel}) ${resolved.places?.[p.key]?.contentId ? '기존 재사용 ' + resolved.places[p.key].contentId : '신규 생성'}`),
    옵션: plan.options.map(o => `${o.name} [${o.priceTypes.join('/')}] ${o.basePax}~${o.maxPax}명`),
    판매일: plan.sales.map(s => `${s.option} ${s.from}~${s.to} (${s.days}일, ${s.status}, 재고 ${s.stock}) ` + s.prices.map(p => `${p.type} ${won(p.original)}→${won(p.sale)}`).join(', ')),
    참조정보: plan.reference.map(b => b.title),
    일정: plan.schedule.map(d => `${d.day}일차 ` + d.steps.map(s => s.title).join(' → ')),
    취소규정: plan.terms.cancelRefund.length + '줄'
  };
}
