// FIT (자유여행) ERP execution through the user's logged-in dedicated browser page.
// Every stage is find-or-create followed by an independent readback, so a re-run after an
// interruption continues from the journal instead of creating a second product, option or sale.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { FIT_CATEGORIES, FIT_MASTER_STATUS, FIT_SALE_STATUS, cityName, planImageIds, referencePayload, cancelRefundHtml, placeFields, saleDates } from './fit-plan.mjs';

export const FIT_ORIGIN = 'https://basecamp.team';
const ADD_PATH = '/fit/master/add/?currency=1&product_type=1&extra_amount_flag=0&use_stock_flag=Y';
const fail = message => { throw new Error(message); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const ID = /^[1-9][0-9]{0,12}$/;

async function onErp(page) {
  const url = new URL(page.url());
  if (url.origin !== FIT_ORIGIN) await page.goto(FIT_ORIGIN + '/fit/master/', { waitUntil: 'domcontentloaded', timeout: 30000 });
}

/** Same-origin GET returning JSON (datatable lists need the datatable header). */
async function getJson(page, url, datatable = false) {
  return page.evaluate(async ({ url, datatable }) => {
    const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: datatable ? { datatable: 'true', 'X-Requested-With': 'XMLHttpRequest' } : {} });
    if (response.status !== 200) throw new Error(`ERP 조회 실패 ${response.status}: ${url}`);
    return response.json();
  }, { url, datatable });
}
async function getHtml(page, url) {
  return page.evaluate(async url => {
    const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
    if (response.status !== 200) throw new Error(`ERP 조회 실패 ${response.status}: ${url}`);
    return response.text();
  }, url);
}
async function post(page, url, { json, fields }) {
  return page.evaluate(async ({ url, json, fields }) => {
    const token = document.cookie.split('; ').find(item => item.startsWith('csrftoken='))?.slice(10) ?? '';
    const headers = { 'X-CSRFToken': token, 'X-Requested-With': 'XMLHttpRequest' };
    let body;
    if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
    else { body = new FormData(); for (const [key, value] of Object.entries(fields)) body.append(key, value); }
    const response = await fetch(url, { method: 'POST', credentials: 'same-origin', redirect: 'error', headers, body });
    return { status: response.status, text: await response.text() };
  }, { url, json, fields });
}

// ---------- read-only resolution (review time) ----------

async function autocomplete(page, endpoint, query) {
  const body = await getJson(page, `${endpoint}?q=${encodeURIComponent(query)}&term=${encodeURIComponent(query)}`);
  return Array.isArray(body?.results) ? body.results : fail('ERP 자동완성 응답 형식이 예상과 다릅니다.');
}
const plain = value => String(value).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
function exactOne(rows, label, what) {
  const found = rows.filter(row => plain(row.text) === label && !/line-through|퇴사자/.test(row.text));
  if (found.length !== 1) fail(`${what} "${label}"를 ERP에서 정확히 하나로 찾지 못했습니다. product_import_lookup으로 정확한 표시명을 확인하세요.`);
  return found[0];
}

export async function resolveRegion(page, cityLabel) {
  const city = exactOne(await autocomplete(page, '/destination/autocomplete/region/city_in_country/', cityName(cityLabel)), cityLabel, '도시');
  const countryId = String(city.parent_id ?? '');
  if (!ID.test(String(city.id)) || !ID.test(countryId)) fail(`도시 ${cityLabel}의 국가를 확인할 수 없습니다.`);
  const country = (await getJson(page, `/destination/autocomplete/region/country_in_continent/?id=${countryId}`)).results?.find(row => String(row.id) === countryId);
  if (!country || !ID.test(String(country.parent_id ?? ''))) fail(`도시 ${cityLabel}의 대륙을 확인할 수 없습니다.`);
  return { cityId: String(city.id), cityText: plain(city.text), countryId, countryText: plain(country.text), continentId: String(country.parent_id) };
}

export async function findPlaces(page, place) {
  const body = await getJson(page, `/contents/place/?name_ko=${encodeURIComponent(place.name)}&datatable-draw=1&datatable-start=0&datatable-length=50`, true);
  if (!Array.isArray(body?.data)) fail('관광지 검색 응답 형식이 예상과 다릅니다.');
  return body.data.filter(row => row.list_name_ko === place.name && row.list_city === cityName(place.cityLabel) && row.list_use_flag === 'Y').map(row => String(row.id));
}

/** Resolves every ERP select the plan needs. Read-only; the result is part of the approved plan. */
export async function resolveFit(page, plan) {
  await onErp(page);
  const region = await resolveRegion(page, plan.master.cityLabel);
  const manager = exactOne(await autocomplete(page, '/company/autocomplete/employee/', cityName(plan.master.managerLabel)), plan.master.managerLabel, '담당자');
  const agent = exactOne(await autocomplete(page, '/accounting/autocomplete/agent/', plan.master.agentLabel), plan.master.agentLabel, '거래처');
  const regions = {}, places = {};
  for (const label of new Set(plan.places.map(p => p.cityLabel))) regions[label] = label === plan.master.cityLabel ? region : await resolveRegion(page, label);
  for (const place of plan.places) {
    const found = await findPlaces(page, place);
    if (found.length > 1) fail(`같은 도시에 같은 이름의 관광지 콘텐츠가 여러 개입니다: ${place.name}. ERP에서 정리 후 다시 검토하세요.`);
    places[place.key] = { contentId: found[0] ?? null };
  }
  return { region, managerId: String(manager.id), agentId: String(agent.id), regions, places };
}

// ---------- write stages ----------

async function uploadImage(page, image, alt) {
  const bytes = await readFile(image.path);
  if (createHash('sha256').update(bytes).digest('hex') !== image.sha256) fail(`수집한 이미지 파일이 변경됐습니다: ${image.id}`);
  return page.evaluate(async ({ b64, name, type, alt }) => {
    let blob = new Blob([Uint8Array.from(atob(b64), ch => ch.charCodeAt(0))], { type });
    if (type === 'image/webp') {
      // Convert to JPEG for the ERP library; decoding inside the ERP page occasionally fails, so
      // fall back to an <img> decode and finally to the original WebP bytes.
      const decode = async () => {
        try { return await createImageBitmap(blob); }
        catch { const img = new Image(), url = URL.createObjectURL(blob); try { img.src = url; await img.decode(); return img; } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); } }
      };
      try {
        const source = await decode(), canvas = document.createElement('canvas');
        canvas.width = source.naturalWidth ?? source.width; canvas.height = source.naturalHeight ?? source.height;
        const context = canvas.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(source, 0, 0);
        const jpeg = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9));
        if (jpeg?.size) { blob = jpeg; name = name.replace(/\.webp$/, '.jpg'); type = 'image/jpeg'; }
      } catch {}
    }
    const token = document.cookie.split('; ').find(item => item.startsWith('csrftoken='))?.slice(10) ?? '';
    const data = new FormData(); data.append('csrfmiddlewaretoken', token); data.append('alt', alt); data.append('pc-image', new File([blob], name, { type }));
    const response = await fetch('/contents/image/create_modal/?managed_flag=false', { method: 'POST', credentials: 'same-origin', redirect: 'error', body: data, headers: { 'X-CSRFToken': token, 'X-Requested-With': 'XMLHttpRequest' } });
    return { status: response.status, text: await response.text() };
  }, { b64: bytes.toString('base64'), name: image.name, type: image.mimeType, alt });
}

async function dismissAlerts(page) {
  await page.evaluate(() => { for (const button of document.querySelectorAll('.modal.open button')) if (button.textContent.trim() === '확인') button.click(); }).catch(() => {});
}

async function openMaster(page, masterId, tab) {
  await page.goto(`${FIT_ORIGIN}/fit/master/${masterId}/change/`, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => Boolean(globalThis.jQuery && globalThis.controller && document.querySelector('#save')), undefined, { timeout: 20000 });
  if (tab) {
    await page.evaluate(id => document.querySelector(`a[href="#${id}"]`).click(), tab);
    const ready = { option: '#add_room', schedule: '#schedule-tree' }[tab];
    if (ready) await page.waitForSelector(ready, { state: 'attached', timeout: 20000 });
    await sleep(800);
  }
}

async function masterByCode(page, code) {
  const body = await getJson(page, `/fit/master/?code=${encodeURIComponent(code)}&datatable-draw=1&datatable-start=0&datatable-length=5`, true);
  return (body.data ?? []).filter(row => row.code_list === code).map(row => /\/fit\/master\/(\d+)\/change\//.exec(row.title_list_link ?? '')?.[1]).filter(Boolean);
}

async function readMaster(page, masterId) {
  return page.evaluate(async id => {
    const response = await fetch(`/fit/master/${id}/change/`, { credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
    if (response.status !== 200) throw new Error('상품 재조회 실패 ' + response.status);
    const doc = new DOMParser().parseFromString(await response.text(), 'text/html'), value = name => doc.querySelector(`#default [name="${name}"]`)?.value ?? null;
    const preview = [...doc.querySelectorAll('a[href]')].find(a => a.textContent.trim() === '상세보기')?.href ?? null;
    return { code: value('code'), title: value('title'), status: value('status'), city: doc.querySelector('#default [name=city]')?.dataset.initId ?? value('city'), agent: doc.querySelector('#default [name=agent]')?.dataset.initId ?? null,
      main: [...doc.querySelectorAll('#main_image_area .image_list')].map(e => e.dataset.id), detail: [...doc.querySelectorAll('#image_area .image_list')].map(e => e.dataset.id), preview };
  }, masterId);
}

async function createMaster(page, plan, resolved, erpImages, code) {
  await page.goto(FIT_ORIGIN + ADD_PATH, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => Boolean(globalThis.jQuery && document.querySelector('#default [name=agent]')), undefined, { timeout: 20000 });
  return page.evaluate(async args => {
    const $ = globalThis.jQuery, form = document.querySelector('#default');
    const select2 = (name, value, label) => { const el = form.querySelector(`[name=${name}]`); el.disabled = false; if (![...el.options].some(o => o.value === value)) el.append(new Option(label, value, true, true)); $(el).val(value).trigger('change'); $(el).trigger({ type: 'select2:select', params: { data: { id: value, text: label } } }); };
    const set = (name, value) => { const el = form.querySelector(`[name=${name}]`); el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); $(el).trigger('change'); };
    set('category', args.category); select2('country', args.countryId, args.countryText);
    await new Promise(resolve => setTimeout(resolve, 800));
    select2('city', args.cityId, args.cityText); select2('manager', args.managerId, args.managerLabel); select2('agent', args.agentId, args.agentLabel);
    for (let i = 0; i < 50 && !/^\d+$/.test(form.querySelector('[name=agent_rate]')?.value ?? ''); i++) await new Promise(resolve => setTimeout(resolve, 200));
    const rate = form.querySelector('[name=agent_rate]')?.value ?? '';
    if (!/^\d+$/.test(rate)) return { status: 0, text: '거래처 수수료(agent_rate)가 채워지지 않았습니다. ERP에서 거래처 수수료 설정을 확인하세요.' };
    const data = new FormData(form);
    const override = { code: args.code, status: args.status, sort: String(args.sort), category: args.category, country: args.countryId, city: args.cityId, manager: args.managerId, agent: args.agentId, agent_rate: rate, accounting_agent_rate: form.querySelector('[name=accounting_agent_rate]')?.value || rate,
      title: args.title, short_description: args.shortDescription, description: args.description, fee_rate: '0', today_reservation_flag: args.sameDayBooking ? 'True' : 'False', confirm_flag: args.instantConfirm ? 'True' : 'False', lowest_price_flag: args.lowestPriceGuarantee ? 'True' : 'False',
      main_image_sort: JSON.stringify({ images: args.main }), image_sort: JSON.stringify({ images: args.detail }), badge1: args.badges[0] ?? '', badge2: args.badges[1] ?? '', badge3: args.badges[2] ?? '', badge_list: JSON.stringify(args.badges) };
    for (const [key, value] of Object.entries(override)) data.set(key, value);
    const token = document.cookie.split('; ').find(item => item.startsWith('csrftoken='))?.slice(10) ?? '';
    const response = await fetch('/fit/master/add/', { method: 'POST', credentials: 'same-origin', redirect: 'error', body: data, headers: { 'X-CSRFToken': token, 'X-Requested-With': 'XMLHttpRequest' } });
    return { status: response.status, text: await response.text() };
  }, {
    code, category: FIT_CATEGORIES[plan.master.category], status: FIT_MASTER_STATUS[plan.master.status], sort: plan.master.sort, ...resolved.region, managerId: resolved.managerId, managerLabel: plan.master.managerLabel, agentId: resolved.agentId, agentLabel: plan.master.agentLabel,
    title: plan.master.title, shortDescription: plan.master.shortDescription, description: plan.master.description, badges: plan.master.badges, sameDayBooking: plan.master.sameDayBooking, instantConfirm: plan.master.instantConfirm, lowestPriceGuarantee: plan.master.lowestPriceGuarantee,
    main: plan.images.main.map(erpImages), detail: plan.images.detail.map(erpImages)
  });
}

async function readOptions(page, masterId) {
  return page.evaluate(async id => {
    const response = await fetch(`/fit/master/option/list/${id}/`, { credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
    if (response.status !== 200) throw new Error('옵션 재조회 실패 ' + response.status);
    const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
    return [...doc.querySelectorAll('tbody tr[data-id]')].map(tr => ({ id: tr.dataset.id, name: tr.querySelector('.update_link')?.textContent.trim() ?? '' }));
  }, masterId);
}

async function createOption(page, masterId, option) {
  await page.evaluate(() => document.querySelector('#add_room').click());
  await page.waitForSelector('.modal.open #create_master_option', { timeout: 20000 });
  await page.evaluate(async option => {
    const $ = globalThis.jQuery, modal = [...document.querySelectorAll('.modal.open')].find(m => m.querySelector('#create_master_option'));
    const set = (name, value) => { const el = modal.querySelector(`[name="${name}"]`); el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); $(el).trigger('change'); };
    set('name', option.name); set('description', option.description); set('base_pax_count', String(option.basePax)); set('max_pax_count', String(option.maxPax));
    const rows = () => [...modal.querySelectorAll('[name^="option_price_type-"][name$="-name"]')].filter(el => !el.name.includes('__prefix__'));
    for (let i = 0; i < 20 && rows().length < option.priceTypes.length; i++) { modal.querySelector('#add_price_type').click(); await new Promise(resolve => setTimeout(resolve, 250)); }
    if (rows().length !== option.priceTypes.length) throw new Error('옵션 가격구분 행 수를 맞추지 못했습니다.');
    option.priceTypes.forEach((name, i) => { const el = rows()[i]; el.value = name; el.dispatchEvent(new Event('input', { bubbles: true })); const sort = modal.querySelector(`[name="${el.name.replace('-name', '-sort')}"]`); sort.value = String(i + 1); sort.dispatchEvent(new Event('input', { bubbles: true })); });
  }, option);
  const response = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === `/fit/master/${masterId}/option/add/`, { timeout: 30000 });
  await page.evaluate(() => [...document.querySelectorAll('.modal.open #create_master_option')][0].click());
  const status = (await response).status();
  await sleep(1000); await dismissAlerts(page);
  if (status !== 201) fail(`옵션 저장 응답이 ${status}입니다: ${option.name}`);
}

async function readSales(page, masterId, optionId) {
  const body = await getJson(page, `/fit/product/list/${masterId}/?extra_amount=0&master_option=${optionId}&status=&date=&end_date=&datatable-draw=1&datatable-start=0&datatable-length=99999`, true);
  if (!Array.isArray(body?.data)) fail('판매일 재조회 응답 형식이 예상과 다릅니다.');
  const number = value => Number(String(value ?? '').replace(/[^0-9]/g, ''));
  return body.data.map(row => ({ date: row.list_date, status: row.list_status, original: number(row.list_original_price_by_default), sale: number(row.list_price_by_default) }));
}

async function createSale(page, masterId, optionId, sale) {
  await page.evaluate(id => document.querySelector(`.create_product[data-option-id="${id}"]`).click(), optionId);
  await page.waitForSelector('#modal #create_product', { state: 'attached', timeout: 20000 });
  await sleep(800);
  const selected = await page.evaluate(async ({ sale, saleStatus }) => {
    const $ = globalThis.jQuery, modal = document.getElementById('modal');
    const set = (selector, value) => { const el = modal.querySelector(selector); el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('keyup', { bubbles: true })); $(el).trigger('change'); };
    set('#start-date', sale.from); set('#end-date', sale.to);
    modal.querySelector('#create_schedule_calendar').click(); await new Promise(resolve => setTimeout(resolve, 1500));
    // "전체선택" toggles every weekday on or off, so click only while dates are missing.
    const selected = () => modal.querySelectorAll('#product-multi-calendar button.datepicker-day-button.selected:not([disabled])').length;
    for (let i = 0; i < 3 && selected() < sale.days; i++) { modal.querySelector('#select-all-weekday').click(); await new Promise(resolve => setTimeout(resolve, 800)); }
    const count = selected();
    const names = [...modal.querySelectorAll('[name^="form-"][name$="-name"]')];
    for (const price of sale.prices) {
      const el = names.find(input => input.value === price.type);
      if (!el) throw new Error(`판매일 가격구분을 찾지 못했습니다: ${price.type}`);
      const prefix = el.name.replace(/-name$/, '');
      set(`[name="${prefix}-original_price"]`, String(price.original)); set(`[name="${prefix}-price"]`, String(price.sale));
    }
    if (names.length !== sale.prices.length) throw new Error('판매일 가격구분 수가 옵션과 다릅니다.');
    set('[name=status]', saleStatus); set('[name=stock]', String(sale.stock));
    return count;
  }, { sale, saleStatus: FIT_SALE_STATUS[sale.status] });
  if (selected !== sale.days) fail(`판매일 달력 선택 수(${selected})가 기간 일수(${sale.days})와 다릅니다.`);
  const response = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === `/fit/product/create/${optionId}/`, { timeout: 60000 });
  await page.evaluate(() => document.querySelector('#modal #create_product').click());
  const status = (await response).status();
  await sleep(1000); await dismissAlerts(page);
  if (status !== 201) fail(`판매일 저장 응답이 ${status}입니다.`);
}

async function readSchedule(page, masterId) {
  return page.evaluate(async id => {
    const response = await fetch(`/fit/schedule/${id}/change/`, { credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
    if (response.status !== 200) throw new Error('일정 재조회 실패 ' + response.status);
    const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
    const tree = JSON.parse(doc.getElementById('schedule_tree_json')?.value || '[]'), contents = JSON.parse(doc.getElementById('schedule_contents_json')?.value || '[]');
    return tree.map(step => ({ day: step.day, step: step.step, type: String(step.type_id), title: step.etc1, contents: contents.filter(c => c.detail_id === step.id).sort((a, b) => a.detail_sort - b.detail_sort).map(c => String(c.contents_id)) }));
  }, masterId);
}

async function writeScheduleDay(page, masterId, day, placeIds) {
  await page.evaluate(async ({ dayNumber }) => {
    const anchors = () => [...document.querySelectorAll('#schedule-tree .jstree-anchor')].filter(a => /^\d+일차$/.test(a.textContent.trim()));
    for (let i = 0; i < 10 && anchors().length < dayNumber; i++) { document.querySelector('#add_schedule_day').click(); await new Promise(resolve => setTimeout(resolve, 1500)); for (const b of document.querySelectorAll('.modal.open button')) if (b.textContent.trim() === '확인') b.click(); }
    const anchor = anchors()[dayNumber - 1];
    if (!anchor) throw new Error(`${dayNumber}일차를 만들지 못했습니다.`);
    anchor.click(); await new Promise(resolve => setTimeout(resolve, 1500));
  }, { dayNumber: day.day });
  await page.evaluate(async ({ steps, placeIds }) => {
    const $ = globalThis.jQuery, controller = globalThis.controller.schedule_controller, wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const items = () => [...document.querySelectorAll('#schedule_step_area > li')];
    const confirm = () => { for (const b of document.querySelectorAll('.modal.open button')) if (b.textContent.trim() === '확인') b.click(); };
    for (let i = 0; i < 40 && items().length < steps.length; i++) { document.querySelector('#schedule .sche_detail .add_schedule_detail').click(); await wait(800); confirm(); }
    for (let i = 0; i < 40 && items().length > steps.length; i++) { items().at(-1).querySelector('.delete_schedule_detail').click(); await wait(800); confirm(); await wait(400); }
    if (items().length !== steps.length) throw new Error('일정 단계 수를 맞추지 못했습니다.');
    for (const [index, step] of steps.entries()) {
      let li = items()[index];
      const type = step.kind === 'place' ? '4' : '7', select = li.querySelector('select.schedule_type_select') ?? li.querySelector('select');
      if (select.value !== type) { $(select).val(type).trigger('change'); await wait(1200); li = items()[index]; }
      const set = (selector, value) => { const el = li.querySelector(selector); if (!el) throw new Error(`일정 입력칸이 없습니다: ${selector}`); el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); $(el).trigger('change'); };
      set('.custom_title', step.title);
      if (step.kind === 'custom') { set('.custom_short', step.short); set('.description', step.description); continue; }
      const memo = li.querySelector('.tmpl > .contents_memo .description') ?? li.querySelector('.description');
      memo.value = step.description; memo.dispatchEvent(new Event('input', { bubbles: true }));
      li.querySelectorAll('.imported_contents').forEach(el => el.remove());
      controller.open_contents_popup_id = li.id;
      controller.import_contents(step.places.map(key => placeIds[key]));
    }
  }, { steps: day.steps, placeIds });
  const response = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === `/fit/schedule/${masterId}/change/`, { timeout: 30000 });
  await page.evaluate(() => document.querySelector('#save').click());
  const status = (await response).status();
  await sleep(1000); await dismissAlerts(page);
  if (status !== 200) fail(`${day.day}일차 일정 저장 응답이 ${status}입니다.`);
}

/**
 * Runs the approved FIT plan. `journal.rows` are earlier events of this job; `journal.append`
 * durably records each event before the next write. `assertIdentity` re-reads the logged-in
 * company/account before every write stage.
 */
export async function runFit({ page, plan, resolved, images, journal, assertIdentity, companyId, progress = () => {} }) {
  const done = phase => journal.rows.filter(row => row.phase === phase);
  const stage = async (name, fn) => { progress(name); await assertIdentity(); await onErp(page); return fn(); };
  const byId = new Map(images.map(image => [image.id, image]));

  // 1. Images → ERP library (re-runs reuse earlier receipts for the same bytes).
  const erp = new Map(done('image').map(row => [row.sha256, row.erpId]));
  await stage('images', async () => {
    for (const id of planImageIds(plan)) {
      const image = byId.get(id) ?? fail(`이미지 ${id}가 작업에 없습니다.`);
      if (erp.has(image.sha256)) continue;
      const result = await uploadImage(page, image, image.alt);
      if (result.status !== 201) fail(`이미지 업로드 응답이 ${result.status}입니다: ${id}`);
      const body = JSON.parse(result.text), erpId = String(body.id ?? '');
      if (!ID.test(erpId) || !String(body.src ?? '').startsWith(`https://media.eoding.com/media/travelagent/${companyId}/`)) fail('이미지 업로드 영수증이 이 회사의 이미지가 아닙니다.');
      await journal.append({ phase: 'image', imageId: id, sha256: image.sha256, erpId, src: body.src }); erp.set(image.sha256, erpId);
    }
  });
  const erpImage = id => erp.get(byId.get(id).sha256);

  // 2. Place contents: reuse an exact active same-city match, create otherwise.
  const placeIds = {};
  await stage('places', async () => {
    for (const place of plan.places) {
      const earlier = done('place').find(row => row.key === place.key)?.contentId;
      const found = await findPlaces(page, place);
      if (found.length > 1) fail(`같은 이름의 관광지 콘텐츠가 여러 개입니다: ${place.name}`);
      if (found.length === 1) { placeIds[place.key] = { id: Number(found[0]), name_ko: place.name }; if (earlier !== found[0]) await journal.append({ phase: 'place', key: place.key, contentId: found[0], created: false }); continue; }
      if (earlier) fail(`이전에 만든 관광지 콘텐츠 ${earlier}(${place.name})를 찾을 수 없습니다. ERP에서 확인하세요.`);
      await journal.append({ phase: 'place-attempt', key: place.key });
      const result = await post(page, '/contents/place/add/', { fields: placeFields(place, resolved.regions[place.cityLabel], place.images.map(erpImage)) });
      const contentId = String(JSON.parse(result.status === 201 ? result.text : '{}').id ?? '');
      if (result.status !== 201 || !ID.test(contentId)) fail(`관광지 콘텐츠 저장 응답이 ${result.status}입니다: ${place.name}`);
      const readback = await findPlaces(page, place);
      if (readback.length !== 1 || readback[0] !== contentId) fail(`관광지 콘텐츠 재조회가 맞지 않습니다: ${place.name}`);
      await journal.append({ phase: 'place', key: place.key, contentId, created: true });
      placeIds[place.key] = { id: Number(contentId), name_ko: place.name };
    }
  });

  // 3. Master product (private). A code is reserved and journaled before the single create POST.
  let masterId = done('master').at(-1)?.masterId;
  await stage('master', async () => {
    if (!masterId) {
      for (const attempt of done('master-attempt')) {
        const ids = await masterByCode(page, attempt.code);
        if (ids.length > 1) fail(`상품코드 ${attempt.code}로 여러 상품이 있습니다. ERP에서 확인하세요.`);
        if (ids.length === 1) { masterId = ids[0]; await journal.append({ phase: 'master', masterId, code: attempt.code, reconciled: true }); break; }
      }
    }
    if (!masterId) {
      const code = String((await getJson(page, `/fit/master/master_code/?city=${resolved.region.cityId}&category=${FIT_CATEGORIES[plan.master.category]}`)).code ?? '');
      if (!/^[A-Z0-9]{4,20}$/.test(code)) fail('ERP 상품코드를 발급받지 못했습니다.');
      await journal.append({ phase: 'master-attempt', code });
      const result = await createMaster(page, plan, resolved, erpImage, code);
      if (result.status !== 201) fail(`상품 저장 응답이 ${result.status}입니다. ${result.status === 0 ? result.text : ''}`.trim());
      masterId = /\/fit\/master\/(\d+)\/change\//.exec(JSON.parse(result.text).success_url ?? '')?.[1] ?? fail('상품 저장 응답에 상품 ID가 없습니다.');
      await journal.append({ phase: 'master', masterId, code });
    }
    const saved = await readMaster(page, masterId);
    if (saved.title !== plan.master.title || saved.status !== FIT_MASTER_STATUS[plan.master.status] || saved.city !== resolved.region.cityId || saved.agent !== resolved.agentId) fail('저장된 상품의 제목·상태·도시·거래처가 승인 계획과 다릅니다.');
    if (JSON.stringify(saved.main) !== JSON.stringify(plan.images.main.map(erpImage)) || JSON.stringify(saved.detail) !== JSON.stringify(plan.images.detail.map(erpImage))) fail('저장된 대표/상세 이미지가 승인 계획과 다릅니다.');
  });

  // 4. Options (find by exact name, create the missing ones through the native modal).
  let options = [];
  await stage('options', async () => {
    options = await readOptions(page, masterId);
    const missing = plan.options.filter(option => !options.some(row => row.name === option.name));
    if (missing.length) {
      for (const option of missing) { await openMaster(page, masterId, 'option'); await journal.append({ phase: 'option-attempt', name: option.name }); await createOption(page, masterId, option); }
      options = await readOptions(page, masterId);
    }
    for (const option of plan.options) {
      const rows = options.filter(row => row.name === option.name);
      if (rows.length !== 1) fail(`옵션 ${option.name}이(가) ${rows.length}개 조회됩니다.`);
      if (!done('option').some(row => row.optionId === rows[0].id)) await journal.append({ phase: 'option', name: option.name, optionId: rows[0].id });
    }
  });
  const optionId = name => options.find(row => row.name === name).id;

  // 5. Sale dates and prices per option range; partial ranges require reconciliation.
  await stage('sales', async () => {
    for (const sale of plan.sales) {
      const id = optionId(sale.option), dates = saleDates(sale);
      const existing = (await readSales(page, masterId, id)).filter(row => dates.includes(row.date));
      if (existing.length && existing.length !== dates.length) fail(`${sale.option} ${sale.from}~${sale.to} 판매일이 일부만 있습니다. ERP에서 확인하세요.`);
      if (!existing.length) {
        await openMaster(page, masterId, 'option');
        await journal.append({ phase: 'sale-attempt', option: sale.option, from: sale.from, to: sale.to });
        await createSale(page, masterId, id, sale);
      }
      const rows = (await readSales(page, masterId, id)).filter(row => dates.includes(row.date)), base = sale.prices[0];
      if (rows.length !== dates.length || rows.some(row => row.original !== base.original || row.sale !== base.sale)) fail(`${sale.option} 판매일 재조회가 승인 가격과 다릅니다.`);
      await journal.append({ phase: 'sale', option: sale.option, from: sale.from, to: sale.to, days: rows.length });
    }
  });

  // 6. Reference (참조정보): full replacement, then readback of titles and images.
  await stage('reference', async () => {
    const payload = referencePayload(plan.reference, erpImage);
    const result = await post(page, `/fit/master/reference/${masterId}/`, { json: payload });
    if (result.status !== 201) fail(`참조정보 저장 응답이 ${result.status}입니다.`);
    const html = await getHtml(page, `/fit/master/reference/${masterId}/`);
    for (const block of plan.reference) if (!html.includes(`value="${block.title.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`)) fail(`참조정보 재조회에서 "${block.title}"을 찾지 못했습니다.`);
    await journal.append({ phase: 'reference', blocks: payload.length });
  });

  // 7. Schedule: native editor per day (custom text or linked place contents), then readback.
  await stage('schedule', async () => {
    await openMaster(page, masterId, 'schedule');
    for (const day of plan.schedule) { await writeScheduleDay(page, masterId, day, placeIds); if (day !== plan.schedule.at(-1)) await openMaster(page, masterId, 'schedule'); }
    const saved = await readSchedule(page, masterId);
    const expected = plan.schedule.flatMap(day => day.steps.map((step, i) => ({ day: day.day, step: i + 1, type: step.kind === 'place' ? '4' : '7', title: step.title, contents: (step.places ?? []).map(key => String(placeIds[key].id)) })));
    if (JSON.stringify(saved.map(({ day, step, type, title, contents }) => ({ day, step, type, title, contents }))) !== JSON.stringify(expected)) fail('일정 재조회가 승인 계획과 다릅니다.');
    await journal.append({ phase: 'schedule', steps: saved.length });
  });

  // 8. Terms: common FIT terms plus emphasized cancellation/refund rules.
  await stage('terms', async () => {
    const html = cancelRefundHtml(plan.terms.cancelRefund);
    const result = await post(page, `/fit/master/term_and_refund/${masterId}/`, { json: { cancelReturnTermContent: html, termFlag: '0' } });
    if (result.status !== 201) fail(`약관 저장 응답이 ${result.status}입니다.`);
    const saved = await getHtml(page, `/fit/master/term_and_refund/${masterId}/`);
    if (!saved.includes(plan.terms.cancelRefund[0].text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'))) fail('약관 재조회에서 취소규정을 찾지 못했습니다.');
    await journal.append({ phase: 'terms' });
  });

  progress('final');
  const saved = await readMaster(page, masterId);
  const result = { masterId, code: saved.code, erpUrl: `${FIT_ORIGIN}/fit/master/${masterId}/change/`, previewUrl: saved.preview, options: options.map(o => ({ name: o.name, id: o.id })), places: Object.fromEntries(Object.entries(placeIds).map(([key, value]) => [key, String(value.id)])) };
  await journal.append({ phase: 'final', ...result });
  return result;
}
