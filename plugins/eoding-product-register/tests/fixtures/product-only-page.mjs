import { createHash } from 'node:crypto';
import { basicFixture } from './basic-page.mjs';
import { chainPage, serverDetail, scheduleRow } from './product-chain-page.mjs';

/** Isolated basecamp.team fixture for product-only coordinator tests. */
export const origin = 'https://basecamp.team';
export const productId = '812345';
export const scheduleId = '7001';
export const pageUrl = `${origin}/tour/master_product/${productId}/change/`;
export const addUrl = `${origin}/tour/master_product/add/`;
export const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jY1kAAAAASUVORK5CYII=', 'base64');
export const pngHash = createHash('sha256').update(png).digest('hex');
export const tenant = Object.freeze({ companyId: '7', imageUrlPrefix: 'https://media.eoding.com/media/travelagent/7/imagecontent/' });
export const image = Object.freeze({ id: '90', src: `${tenant.imageUrlPrefix}90.png` });
export const contentControls = Object.freeze({ displaySave: '#save-display', detailSave: '#save-detail', referenceSave: '#save-reference' });

const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const productShape = source => ({
  title: source?.title ?? 'Fixture product',
  nights: Number(source?.nights ?? 1),
  days: Number(source?.days ?? 2),
  itinerary: Array.isArray(source?.itinerary) && source.itinerary.length ? source.itinerary : [{ day: 1 }, { day: 2 }]
});
const detailBaseline = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [String(index + 1), { type: String(index + 1), etc: index < 4 ? '[]' : '', etc2: '', etc5: index === 7 ? '0' : '', untouched: 'KEEP' }]));
const referenceBaseline = [{ type: '15', etc2: '[]', image_group: [], image_append_yn: 'N', untouched: 'KEEP' }];
const nativeFlightOptions = { departport: ['1','Fixture departure'], 'depart-0-airline': ['2','Fixture Air'], 'depart-0-depart_cd': ['3','ICN'], 'depart-0-arrive_cd': ['4','TPE'], 'arrive-0-airline': ['2','Fixture Air'], 'arrive-0-depart_cd': ['4','TPE'], 'arrive-0-arrive_cd': ['3','ICN'] };
const flights = ['outbound-0-airline', 'outbound-0-depart_cd', 'outbound-0-arrive_cd', 'return-0-airline', 'return-0-depart_cd', 'return-0-arrive_cd', ...Object.keys(nativeFlightOptions)];

function nativeMedia(saved = {}) {
  const detail = saved.detail ?? detailBaseline;
  const reference = saved.reference ?? referenceBaseline;
  const display = saved.display ?? {};
  return `<nav id="product-only-tabs"><a href="#base">기본 콘텐츠</a><a href="#detail">상세</a><a href="#productreference">참고</a></nav>
<section id="base"><form id="homepage_post"><input name="short_description" value="${esc(display.short_description ?? '')}"><input name="product_description" value="${esc(display.product_description ?? '')}"><input name="badge1" value="${esc(display.badge1 ?? '')}"><input name="badge2" value="${esc(display.badge2 ?? '')}"><input name="badge3" value="${esc(display.badge3 ?? '')}"><input name="badge_list" value="[]"><input name="image_sort" value="${esc(display.image_sort ?? '{&quot;images&quot;:[]}')}" ><button type="button" id="save-display">Save display</button></form><button type="button" id="image_popup">Choose images</button><div id="image_homepage_area"></div></section>
<section id="detail"><form id="detail_post">${['include', 'exclude', 'information', 'main-point'].map(id => `<table id="${id}"><tbody></tbody><tfoot><tr><td><textarea></textarea></td></tr></tfoot></table><button type="button" class="row-add" data-target="${id}">Add</button>`).join('')}<input id="id_real_shopping_count" value="${esc(detail['8']?.etc5 ?? '0')}"><button type="button" id="save-detail">Save detail</button></form></section>
<section id="productreference"><form id="reference_form"><div id="reference_body"><div class="cont_box reference_element"><select><option value="1">body</option><option value="3">title</option><option value="4">image</option></select></div></div><button type="button" id="add_reference_element">Add</button><button type="button" id="save-reference">Save reference</button></form></section>
<script>
window.__productOnlyTab=location.hash.slice(1)||'base';
for(const link of document.querySelectorAll('#product-only-tabs a'))link.onclick=event=>{event.preventDefault();window.__productOnlyTab=link.hash.slice(1);location.hash=link.hash;};
const detailBaseline=${JSON.stringify(detail)}, referenceBaseline=${JSON.stringify(reference)};
const nativeCsrfHeaders={'X-CSRFToken':'fixture-native-csrf'};const jsonPost=(url, body)=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...nativeCsrfHeaders},body:JSON.stringify(body)}).catch(()=>{});
for(const button of document.querySelectorAll('.row-add'))button.onclick=()=>{const row=document.createElement('tr');row.innerHTML=['include','exclude'].includes(button.dataset.target)?'<td><input></td><td><input></td>':'<td><input></td>';document.querySelector('#'+button.dataset.target+' tbody').append(row)};
saveDisplay=()=>{const fd=new FormData(homepage_post);fd.set('image_sort',JSON.stringify({images:[...image_homepage_area.querySelectorAll('.image_list')].map(node=>node.dataset.id)}));fd.set('badge_list',JSON.stringify(['badge1','badge2','badge3'].map(key=>homepage_post.elements[key].value.trim()).filter(Boolean)));fetch('${origin}/tour/master_product/homepage/${productId}/',{method:'POST',headers:nativeCsrfHeaders,body:fd}).catch(()=>{})};
saveDetail=()=>{const next=structuredClone(detailBaseline);for(const [index,id] of [[1,'include'],[2,'exclude']]){next[index].etc=JSON.stringify([...document.querySelectorAll('#'+id+' tbody tr')].map(row=>({value:'Direct',label:row.querySelectorAll('input')[0].value,remark:row.querySelectorAll('input')[1].value})));next[index].etc2=document.querySelector('#'+id+' textarea').value}for(const [index,id] of [[3,'information'],[4,'main-point']])next[index].etc=JSON.stringify([...document.querySelectorAll('#'+id+' tbody input')].map(input=>({content:input.value})));next[8].etc5=id_real_shopping_count.value;jsonPost('${origin}/tour/master_product_detail/${productId}/change/',next)};
add_reference_element.onclick=()=>{const type=document.querySelector('.reference_element select').value, control=document.createElement('div');control.className='control';control.dataset.type=type;control.innerHTML=type==='1'?'<textarea></textarea>':type==='3'?'<input type="text">':'<button type="button" class="add_image_popup">Upload</button>';reference_body.append(control);if(type==='4')control.querySelector('.add_image_popup').onclick=()=>uploadModal(control)};
saveReference=()=>{const next=structuredClone(referenceBaseline);next[0].etc2=JSON.stringify([...reference_body.querySelectorAll('.control')].map(control=>({type:Number(control.dataset.type),contents:control.dataset.type==='4'?1:control.dataset.type==='3'?control.querySelector('input').value:[{detail:control.querySelector('textarea').value,font_color:'0',bold_flag:'0'}]})));const linked=[...reference_body.querySelectorAll('.tr_image_list')];if(linked.length){next[0].image_append_yn='Y';next[0].image_group=[{group_id:1,image_list:linked.map(node=>({image_id:node.dataset.id,image_url:''}))}]}jsonPost('${origin}/tour/master_product_reference/${productId}/change/',next)};
document.querySelector('#save-display').onclick=saveDisplay;document.querySelector('#save-detail').onclick=saveDetail;document.querySelector('#save-reference').onclick=saveReference;
function uploadModal(control){document.querySelector('#content-modal')?.remove();document.body.insertAdjacentHTML('beforeend','<div id="content-modal"><input id="id_alt"><div class="image_upload_container" data-type="pc"><input type="file"></div><button id="save-image">Upload</button></div>');const modal=document.querySelector('#content-modal');modal.querySelector('#save-image').onclick=async()=>{const file=modal.querySelector('input[type=file]').files[0],fd=new FormData();fd.append('alt',modal.querySelector('#id_alt').value);fd.append('pc-image',file);const response=await fetch('${origin}/contents/image/create_modal/?managed_flag=false',{method:'POST',headers:nativeCsrfHeaders,body:fd});const receipt=await response.json();control.insertAdjacentHTML('beforeend','<div class="tr_image_list" data-id="'+receipt.id+'"><img src="'+receipt.src+'"></div>');modal.hidden=true;};}
let drawHandlers=[];const emit=()=>{const hs=drawHandlers;drawHandlers=[];queueMicrotask(()=>hs.forEach(h=>h()))};
const api={settings:()=>[{_bInitComplete:true}],page:{info:()=>({recordsDisplay:1}),len:()=>({draw:()=>emit()})}};window.jQuery=()=>({DataTable:()=>api,one:(event,cb)=>drawHandlers.push(cb)});window.jQuery.fn={dataTable:{isDataTable:()=>true}};
image_popup.onclick=()=>{document.querySelector('#content-modal')?.remove();document.body.insertAdjacentHTML('beforeend','<div id="content-modal"><input id="id_title"><button class="search">Search</button><div id="modal_table"><table><tbody><tr><td><button class="select-row" data-id="90" data-src="${image.src}">Select</button></td></tr></tbody></table></div><div id="selected_image_area"></div><button id="import-image-btn">Import</button></div>');const modal=document.querySelector('#content-modal');modal.querySelector('.search').onclick=emit;modal.querySelector('.select-row').onclick=()=>modal.querySelector('#selected_image_area').innerHTML='<img class="import-image" data-id="90" src="${image.src}">';modal.querySelector('#import-image-btn').onclick=()=>{image_homepage_area.innerHTML='<div class="image_list" data-id="90"><img src="${image.src}"></div>';modal.hidden=true;};};
for(const [index,id] of [[1,'include'],[2,'exclude'],[3,'information'],[4,'main-point']])for(const row of JSON.parse(detailBaseline[index].etc)){document.querySelector('button.row-add[data-target="'+id+'"]').click();const inputs=document.querySelector('#'+id+' tbody tr:last-child').querySelectorAll('input');inputs[0].value=index<3?row.label:row.content;if(index<3)inputs[1].value=row.remark;}for(const [index,id] of [[1,'include'],[2,'exclude']])document.querySelector('#'+id+' textarea').value=detailBaseline[index].etc2;
for(const element of JSON.parse(referenceBaseline[0].etc2)){document.querySelector('.reference_element select').value=String(element.type);add_reference_element.click();const control=reference_body.lastElementChild;if(element.type===4)control.insertAdjacentHTML('beforeend','<div class="tr_image_list" data-id="90"><img src="${image.src}"></div>');else control.querySelector(element.type===3?'input':'textarea').value=element.type===3?element.contents:element.contents[0].detail;}
if(${JSON.stringify(Boolean(display.image_sort))}){const ids=JSON.parse(${JSON.stringify(display.image_sort ?? '{"images":[]}')}).images;image_homepage_area.innerHTML=ids.map(id=>'<div class="image_list" data-id="'+id+'"><img src="${image.src}"></div>').join('');}
</script>`;
}

function seasonShell(saved, product) {
  const season = saved.seasons[0] ?? {};
  const options = flights.map(name => `<select name="${name}" data-init-id="${esc(season[name] ?? '')}"><option value="">choose</option><option selected value="${nativeFlightOptions[name]?.[0] ?? name+'-fixture'}">${nativeFlightOptions[name]?.[1] ?? 'Fixture '+name}</option></select>`).join('');
  return `<a href="#season" id="season-tab">season</a><section id="season" hidden><button id="add_season" type="button">add</button><form id="season_frm" action="/tour/master_product_season/add/" method="post"><input type="hidden" name="csrfmiddlewaretoken" value="fixture-csrf"><input type="hidden" name="product_id" value="${productId}"><input type="hidden" name="product_id" value="${productId}"><input type="hidden" name="id" value=""><input type="hidden" name="id" value=""><input id="id_title" name="title" value="${esc(season.title ?? '')}">${['depart-0-moving_time','arrive-0-moving_time','currency_code','depart-0-depart_date','depart-0-flight_no','depart-0-depart_time','depart-0-arrive_time','arrive-0-depart_date','arrive-0-flight_no','arrive-0-depart_time','arrive-0-arrive_time','adult_base_price','child_base_price','infant_base_price','adult_fuel_price','child_fuel_price','infant_fuel_price','min_pax_count','max_pax_count','outbound-0-depart_time','return-0-arrive_time','selected_dates','start_date','end_date'].map(name=>`<input name="${name}" value="${esc(season[name] ?? '')}">`).join('')}${options}<input id="start-date"><input id="end-date"><button id="create_schedule_calendar" type="button">calendar</button><div id="multi-calendar"></div></form></section><script>
document.querySelector('#season-tab').onclick=()=>{season.hidden=false;window.__productOnlyTab='season';location.hash='#season';};add_season.onclick=()=>{season.hidden=false;window.__productOnlyTab='season';};create_schedule_calendar.onclick=()=>{const start=document.querySelector('#start-date').value,end=document.querySelector('#end-date').value,dates=start===end?[start]:[start,end];document.querySelector('#multi-calendar').innerHTML=dates.map(value=>{const [year,month,day]=value.split('-');return '<button type="button" class="datepicker-day-button selected" data-year="'+year+'" data-month="'+(Number(month)-1)+'" data-day="'+Number(day)+'">'+value+'</button>';}).join('');};
window.saveSeason=()=>{for(const input of season_frm.querySelectorAll('[name$="_price"]'))input.value=input.value.replaceAll(',','');fetch(season_frm.action,{method:'POST',body:new FormData(season_frm),credentials:'same-origin'}).catch(()=>{});};
</script>`;
}

function pageHtml(state, dayTitleInput = true) {
  let html = chainPage(state.product, state.schedule, state.days);
  if (!dayTitleInput) html = html
    .replace('<div id="schedule_detail_area"><input class="input_day_title"></div>', '<div id="schedule_detail_area"><div class="step"><div class="head">1 일차</div></div></div>')
    .replace("document.querySelector('.input_day_title').value='';", "document.querySelector('#schedule_detail_area .head').textContent=n+' 일차';")
    .replace("const title=document.querySelector('.input_day_title').value,meal_list={title};", "const meal_list={};");
  html = html.replace('<button id="save-master-product" onclick="saveDay()">일차 저장</button>', '<button id="save-master-product" type="button">저장</button>');
  return html + nativeMedia(state.content) + (state.omitSeasonDuration ? seasonShell(state, state.product).replace('name="depart-0-moving_time"', 'name="fixture-missing-minutes"') : seasonShell(state, state.product)) + `<script>
const inheritedSaveDay=window.saveDay;window.saveDay=()=>inheritedSaveDay();
const masterSave=document.querySelector('#save-master-product');masterSave.onclick=()=>{if(window.__productOnlyTab==='season')return window.saveSeason();if(window.__productOnlyTab==='schedule')return window.saveDay();return ({base:window.saveDisplay,detail:window.saveDetail,productreference:window.saveReference})[window.__productOnlyTab]();};
document.querySelector('#id_schedule_tab').onclick=()=>{window.__productOnlyTab='schedule';location.hash='#schedule';return false;};
</script>`;
}

function seasonList(state) { return `<!doctype html><input id="master_product_id" value="${productId}"><table id="season_table"><tbody>${state.seasons.map(season => `<tr id="${season.id}"><td>${esc(season.title)}</td></tr>`).join('')}</tbody></table>`; }
function savedSeason(state, id) {
  const season = state.seasons.find(item => item.id === id);
  if (!season) return null;
  return `<form id="season_frm"><input type="hidden" name="csrfmiddlewaretoken" value="fixture-csrf"><input type="hidden" name="product_id" value=""><input type="hidden" name="id" value="${id}"><fieldset><input type="hidden" name="id" value="outbound-flight-${id}"></fieldset>${Object.entries(season).filter(([name]) => !['id','product_id'].includes(name) && !flights.includes(name)).map(([name,value])=>`<input name="${name}" value="${esc(value)}">`).join('')}${flights.map(name=>`<select name="${name}" data-init-id="${esc(season[name] ?? '')}"></select>`).join('')}</form>`;
}

/**
 * Install every product-only endpoint on an existing BrowserContext. No request can reach a network.
 * `writes` records only forwarded synthetic persistence; basic creation is deliberately labelled UI-only.
 */
export async function installProductOnlyFixture(context, { product, dropMediaPersistence = false, dayTitleInput = true } = {}) {
  if (!context || typeof context.route !== 'function') throw new TypeError('A BrowserContext is required');
  const state = { product: productShape(product), addServed: false, basicRecorded: false, schedule: null, days: {}, seasons: [], content: {}, unexpected: [], writes: [] };
  const writes = state.writes;
  const detailUrl = new URL(pageUrl);
  const scheduleDetailPath = `/tour/master_product_schedule/${scheduleId}/detail/`;
  const scheduleChangePath = `/tour/master_product_schedule/${scheduleId}/change/`;
  const readMultipart = async request => [...await new Response(request.postDataBuffer(), { headers: { 'content-type': request.headers()['content-type'] } }).formData()];
  await context.route('**/*', async route => {
    const request = route.request(); let url;
    try { url = new URL(request.url()); } catch { state.unexpected.push({ method: request.method(), url: request.url() }); return route.abort(); }
    if (request.method() === 'GET' && url.href === image.src) return route.fulfill({contentType:'image/png',body:png});
    if (url.origin !== origin) return route.abort();
    if(request.method()==='GET'&&url.pathname===`/tour/master_product_schedule/${productId}/update/`)return route.fulfill({contentType:'text/html',body:`<table><tbody id="schedule_list_table">${state.schedule?scheduleRow(state.schedule):''}</tbody></table>`});
    if (request.method() === 'GET' && url.href === addUrl) { state.addServed = true; return route.fulfill({ contentType: 'text/html', body: basicFixture.replace("/tour/master_product/detail/812345/", `/tour/master_product/${productId}/change/`) + '<script>window.navigate=true</script>' }); }
    if (request.method() === 'GET' && url.pathname === detailUrl.pathname) { if (!state.basicRecorded && state.addServed) { state.basicRecorded = true; writes.push({ kind: 'basic-simulated-ui', url: addUrl }); } return route.fulfill({ contentType: 'text/html', body: pageHtml(state, dayTitleInput) }); }
    if (request.method() === 'GET' && url.pathname === scheduleDetailPath) return route.fulfill({ contentType: 'application/json', body: JSON.stringify(serverDetail(state.product, state.schedule ?? { title: 'Fixture schedule' }, state.days)) });
    if (request.method() === 'GET' && url.pathname === '/tour/master_product_season/' && url.search === `?product_id=${productId}&init_flag=False`) return route.fulfill({ contentType: 'text/html', body: seasonList(state) });
    const seasonDetail = /^\/tour\/master_product_season\/([1-9]\d*)\/change\/$/.exec(url.pathname);
    if (request.method() === 'GET' && seasonDetail) { const body = savedSeason(state, seasonDetail[1]); return body ? route.fulfill({ contentType: 'text/html', body }) : route.fulfill({ status: 404, body: 'missing' }); }
    if (request.method() === 'GET' && url.href === image.src) return route.fulfill({ contentType: 'image/png', body: png });
    if (request.method() === 'POST' && url.pathname === '/tour/master_product_schedule/add/') { const values = Object.fromEntries(await readMultipart(request)); state.schedule = { id: scheduleId, title: values.title, night: Number(values.night), day: Number(values.day) }; writes.push({ kind: 'schedule-shell', url: url.href, body: values }); return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ id: scheduleId, title: values.title, night: Number(values.night), day: Number(values.day) }) }); }
    if (request.method() === 'POST' && url.pathname === scheduleChangePath) { const body = JSON.parse(request.postData() ?? '{}'); state.days[body.day] = body; writes.push({ kind: 'schedule-day', url: url.href, body }); return route.fulfill({ contentType: 'application/json', body: '{}' }); }
    if (request.method() === 'POST' && url.pathname === `/tour/master_product/homepage/${productId}/`) { const values = Object.fromEntries((await readMultipart(request)).filter(([name]) => name !== 'csrfmiddlewaretoken')); if (!dropMediaPersistence) state.content.display = values; writes.push({ kind: 'display', url: url.href, body: values }); return route.fulfill({ contentType: 'application/json', body: '{}' }); }
    if (request.method() === 'POST' && url.pathname === `/tour/master_product_detail/${productId}/change/`) { const body = JSON.parse(request.postData() ?? '{}'); if (!dropMediaPersistence) state.content.detail = body; writes.push({ kind: 'detail', url: url.href, body }); return route.fulfill({ contentType: 'application/json', body: '{}' }); }
    if (request.method() === 'POST' && url.pathname === `/tour/master_product_reference/${productId}/change/`) { const body = JSON.parse(request.postData() ?? '{}'); if (!dropMediaPersistence) state.content.reference = body; writes.push({ kind: 'reference', url: url.href, body }); return route.fulfill({ contentType: 'application/json', body: '{}' }); }
    if (request.method() === 'POST' && url.pathname === '/contents/image/create_modal/' && url.search === '?managed_flag=false') { const form = await readMultipart(request), file = form.find(([name]) => name === 'pc-image')?.[1]; if (!(file instanceof File)) return route.abort(); writes.push({ kind: 'upload', url: url.href, body: { alt: form.find(([name]) => name === 'alt')?.[1] ?? '', name: file.name, mimeType: file.type, size: file.size, sha256: createHash('sha256').update(Buffer.from(await file.arrayBuffer())).digest('hex') } }); return route.fulfill({ contentType: 'application/json', body: JSON.stringify(image) }); }
    if (request.method() === 'POST' && url.pathname === '/tour/master_product_season/add/') { const values = Object.fromEntries((await readMultipart(request)).map(([name,value]) => [name, String(value)])); const id = String(50000 + state.seasons.length); state.seasons.push({ ...values, id, product_id: productId, 'outbound-0-depart_time': `${values['outbound-0-depart_time']}:00`, 'return-0-arrive_time': `${values['return-0-arrive_time']}:00` }); writes.push({ kind: 'season', url: url.href, body: values }); return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ season_id: id }) }); }
    state.unexpected.push({ method: request.method(), url: url.href }); return route.abort();
  });
  return { origin, pageUrl, productId, scheduleId, addUrl, png, pngHash, tenant, image, controls: contentControls, writes, state };
}
