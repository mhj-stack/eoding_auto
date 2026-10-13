import { isDeepStrictEqual as same } from 'node:util';
import { ALLOWED_ORIGIN } from './browser.mjs';
import { createProductLowLevelAdapters } from './product-execution.mjs';
import { parseDisplayMultipart } from './display-image.mjs';
import { readScheduleList } from './schedule-read.mjs';

const fail = message => { throw new Error(`Continuation preflight blocked: ${message}`); };
const methods = new Set(['GET', 'HEAD']);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const clone = value => structuredClone(value);
const emptyDisplay = Object.freeze({ video_url:'', video_url_mobile:'', typeable_char:'0/15', badge1:'', badge2:'', badge3:'', short_description:'', product_description:'', image_sort:'{"images":[]}', detail_image_id:'', featured_product:'', page_template:'', summary_description:'', badge_list:'[]' });
const fixtureDisplay = Object.freeze({ short_description:'', product_description:'', badge1:'', badge2:'', badge3:'', badge_list:'[]', image_sort:'{"images":[]}' });

function exact(value, expected) { return value && typeof value === 'object' && !Array.isArray(value) && same(value, expected); }
function productId(value) { const id = String(value); if (!/^[1-9]\d{0,9}$/.test(id)) fail('invalid receipt product ID'); return id; }
function safeJson(text, label) {
  if (typeof text !== 'string' || text.length > 512 * 1024) fail(`invalid ${label} serialization`);
  let value; try { value = JSON.parse(text); } catch { fail(`invalid ${label} serialization`); }
  const visit = item => {
    if (item === null || typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') return;
    if (Array.isArray(item)) return item.forEach(visit);
    if (!item || Object.getPrototypeOf(item) !== Object.prototype || Object.keys(item).some(key => ['__proto__', 'prototype', 'constructor'].includes(key))) fail(`invalid ${label} serialization`);
    Object.values(item).forEach(visit);
  };
  visit(value); return value;
}
function expectedDetail() {
  return {
    '1':{etc:'[]',etc2:''}, '2':{etc:'[]',etc2:''}, '3':{etc:'[]',etc2:''}, '4':{etc:'[]'},
    '5':{etc_flag:0,etc:'',detail:''}, '6':{etc:'',etc2:''}, '7':{etc:'[]',etc2:''}, '8':{etc:'[]',etc2:'',etc5:'0'}, '9':{},
    '10':{etc_flag:1,etc:'',etc2:'',etc3:'',etc_flag2:1,etc4:'',etc_flag3:1,etc5:''}
  };
}
function fixtureDetail() {
  return Object.fromEntries(Array.from({ length: 8 }, (_, i) => [String(i + 1), { type:String(i + 1), etc:i < 4 ? '[]' : '', etc2:'', etc5:i === 7 ? '0' : '', untouched:'KEEP' }]));
}
function detailEmpty(value) { return exact(value, expectedDetail()) || exact(value, fixtureDetail()); }
function referenceEmpty(value) {
  const observed = [{ etc2:'[]', image_group:[], image_append_yn:'N', sort:0, type:'15' }];
  const fixture = [{ type:'15', etc2:'[]', image_group:[], image_append_yn:'N', untouched:'KEEP' }];
  return same(value, observed) || same(value, fixture);
}
function displayEmpty(value) { return exact(value, emptyDisplay) || exact(value, fixtureDisplay); }
function assertEmptyPayload(key, body, reconciledDetail) {
  if (key === 'display') { if (!displayEmpty(body)) fail('display native serialization is not an approved empty default'); return; }
  if (key === 'detail') { if (reconciledDetail ? !same(body,reconciledDetail) : !detailEmpty(body)) fail('detail native serialization is not an approved empty default'); return; }
  if (!referenceEmpty(body)) fail('reference native serialization is not an approved empty default');
}
function parsePacket(key, request) {
  const contentType = request.headers()['content-type'] ?? '';
  if (key === 'display') {
    const tuples = parseDisplayMultipart(contentType, request.postDataBuffer());
    if (new Set(tuples.map(([name]) => name)).size !== tuples.length) fail('duplicate display serialization fields');
    const body = Object.fromEntries(tuples.filter(([name]) => name !== 'csrfmiddlewaretoken'));
    if (Object.keys(body).length !== tuples.filter(([name]) => name !== 'csrfmiddlewaretoken').length) fail('duplicate display serialization fields');
    return body;
  }
  if (!/^application\/json(?:;|$)/i.test(contentType)) fail(`invalid ${key} serialization content type`);
  return safeJson(request.postData(), `${key} native`);
}
async function seasonList(page, id, target, timeoutMs) {
  const url = `${new URL(target).origin}/tour/master_product_season/?product_id=${encodeURIComponent(id)}&init_flag=False`;
  let result;
  try {
    result = await page.evaluate(async ({ url, id, timeoutMs }) => {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
      try { const response = await fetch(url, { method:'GET', credentials:'same-origin', redirect:'error', cache:'no-store', signal:controller.signal }); return { status:response.status, redirected:response.redirected, url:response.url, html:await response.text(), id }; }
      finally { clearTimeout(timer); }
    }, { url, id, timeoutMs });
  } catch { fail('season list exact GET failed'); }
  if (!result || result.status !== 200 || result.redirected || result.url !== url) fail('season list exact GET failed');
  const parsed = await page.evaluate(({ html, id }) => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    if (doc.querySelectorAll('#master_product_id').length !== 1 || doc.querySelector('#master_product_id')?.value !== id) throw new Error('season list is not bound to target product');
    const table = doc.querySelector('#season_table tbody'); if (!table || doc.querySelectorAll('#season_table tbody').length !== 1) throw new Error('season list is malformed');
    const children = [...table.children];
    if (children.length === 1) {
      const row = children[0], cells = [...row.children];
      if (row.tagName === 'TR' && row.className === 'empty' && !row.id && cells.length === 1 && cells[0].tagName === 'TD' && cells[0].getAttribute('colspan') === '8' && cells[0].textContent.trim() === '등록된 시즌정보가 없습니다. 가져오기/추가 버튼을 이용해 시즌 정보를 저장해 주세요.' && !cells[0].querySelector('input,button,a,table,script')) return [];
    }
    const rows = [...table.querySelectorAll(':scope > tr[id]')].map(row => row.id);
    if (rows.length !== table.children.length || rows.some(value => !/^[1-9]\d*$/.test(value)) || new Set(rows).size !== rows.length) throw new Error('season list is malformed');
    return rows;
  }, { html:result.html, id });
  return parsed;
}

/** Read-only, native-save preflight for continuing an otherwise-empty existing product. */
export async function verifyContinuationPreflight({ page, plan, receipt, identity, timeoutMs = 15000, reconciledDetail } = {}) {
  if (!page || typeof page.context !== 'function' || !plan?.identity || !receipt || typeof identity !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) fail('valid page, plan, receipt, identity, and timeout are required');
  const id = productId(receipt.productId), target = `${ALLOWED_ORIGIN}/tour/master_product/${id}/change/`, origin = new URL(target).origin;
  const endpoints = Object.freeze({ display:`${origin}/tour/master_product/homepage/${id}/`, detail:`${origin}/tour/master_product_detail/${id}/change/`, reference:`${origin}/tour/master_product_reference/${id}/change/` });
  const context = page.context(); let blockedThirdParty = 0, forwardedWrites = 0, unexpected = false, pending = null;
  const guard = async route => {
    const request = route.request(), method = request.method();
    if (methods.has(method)) return route.fallback();
    let requestOrigin = ''; try { requestOrigin = new URL(request.url()).origin; } catch { return route.abort(); }
    if (requestOrigin !== origin) { blockedThirdParty++; return route.abort(); }
    const expected = pending && !pending.used && method === 'POST' && request.url() === endpoints[pending.key];
    if (!expected) { unexpected = true; return route.abort(); }
    pending.used = true;
    try { const body = parsePacket(pending.key, request); assertEmptyPayload(pending.key, body, reconciledDetail); await route.abort(); pending.resolve(); }
    catch (error) { await route.abort().catch(() => {}); pending.reject(error); }
  };
  await context.route('**/*', guard);
  try {
    let response; try { response = await page.goto(target, { waitUntil:'domcontentloaded', timeout:timeoutMs }); } catch { fail('exact existing product GET failed'); }
    if (!response || response.status() !== 200 || response.url() !== target || page.url() !== target || response.fromServiceWorker()) fail('exact existing product GET failed');
    const before = await identity(page); if (!same(before, plan.identity)) fail('preflight identity differs from the original approved identity');
    const expected = clone(receipt); delete expected.productId;
    const basic = await createProductLowLevelAdapters({ identity }).basic.read(page);
    if (!same(basic, expected)) fail('existing basic readback differs from the original verified receipt');
    const scheduleResult = await readScheduleList(page, { productId:id });
    if (scheduleResult.schedules.length) fail('existing product already has schedules');
    const seasons = await seasonList(page, id, target, timeoutMs); if (seasons.length) fail('existing product already has seasons');
    for (const [key, tab] of [['display','base'], ['detail','detail'], ['reference','productreference']]) {
      const link = page.locator(`a[href="#${tab}"]`); if (await link.count() !== 1) fail(`native ${key} tab is unavailable`);
      await link.click({ timeout:timeoutMs });
      // Live tabs replace their form asynchronously. A visible shared Save
      // button alone does not prove that it now belongs to the selected tab.
      const form = page.locator({ display:'#homepage_post', detail:'#include', reference:'#reference_form' }[key]);
      await form.waitFor({ state:'visible', timeout:timeoutMs });
      if (await form.count() !== 1) fail(`native ${key} form is ambiguous`);
      const control = page.locator('#save-master-product'); if (await control.count() !== 1) fail('native save control is unavailable');
      let timer;
      const packet = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('native save capture timed out')), timeoutMs); pending = { key, used:false, resolve, reject }; });
      packet.catch(() => {});
      try { await control.click({ timeout:timeoutMs }); await packet; } finally { clearTimeout(timer); pending = null; }
      if (unexpected) fail('unexpected same-origin browser mutation was blocked');
    }
    let finalResponse; try { finalResponse = await page.goto(target, { waitUntil:'domcontentloaded', timeout:timeoutMs }); } catch { fail('exact existing product final GET failed'); }
    if (!finalResponse || finalResponse.status() !== 200 || finalResponse.url() !== target || page.url() !== target || finalResponse.fromServiceWorker()) fail('exact existing product final GET failed');
    const after = await identity(page); if (!same(after, plan.identity) || !same(after, before)) fail('preflight identity changed');
    if (unexpected) fail('unexpected same-origin browser mutation was blocked');
    if (forwardedWrites !== 0) fail('preflight forwarded a write');
    return Object.freeze({ target, schedules:0, seasons:0, forwardedWrites, expectedProbes:3, blockedThirdParty });
  } finally { pending?.reject(new Error('preflight ended')); await context.unroute('**/*', guard); }
}
