import { createDeparturePersistence } from './departure-persistence-page.mjs';
import { serverDetail } from './product-chain-page.mjs';
import { productId, scheduleId } from './product-only-page.mjs';
const esc = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
const input = (name, value, type = 'text') => `<input id="id_${name}" name="${name}" type="${type}" value="${esc(value)}">`;
const select = (name, options) => `<select id="id_${name}" name="${name}">${options.map(([value, label]) => `<option value="${esc(value)}">${esc(label)}</option>`).join('')}</select>`;
export async function installPluginDepartureFixture(context, state, { corruptFuel = false, duplicate = false } = {}) {
  const backend = createDeparturePersistence(() => serverDetail(state.product, state.schedule, state.days));
  let createPosts = 0;
  function season() { return state.seasons[0]; }
  function form() {
    const value = season(), prices = Object.fromEntries(['adult', 'child', 'infant'].flatMap(kind => [[`${kind}_price`, value[`${kind}_base_price`]], [`${kind}_fuel_price`, value[`${kind}_fuel_price`]]]));
    const fields = { master_product_id: productId, title: state.product.title, currency_code: 'KRW', min_pax_count: value.min_pax_count, max_pax_count: value.max_pax_count, departport: value.departport, ...prices, selected_dates: '' };
    return `<form id="create_product_form">${Object.entries(fields).map(([name, value]) => input(name, value, name === 'selected_dates' ? 'hidden' : 'text')).join('')}${select('manager', [['other-manager', '다른 기본 담당자'], ['manager-1', '가상담당자 (테스트팀)']])}${select('status', [['4', '예약마감'], ['3', '예약가능']])}${select('schedule', [[scheduleId, state.schedule.title]])}${select('season', [['', '직접입력'], [value.id, value.title]])}<input id="start-date"><input id="end-date"><button id="create_schedule_calendar" type="button">달력생성</button><div id="multi-calendar"></div><button id="select-all-weekday" type="button">전체선택</button><button id="create_tour_product" type="button">행사만들기</button></form><script>
      create_schedule_calendar.onclick=()=>{const [year,month,day]=document.getElementById('start-date').value.split('-');document.getElementById('multi-calendar').innerHTML='<button type="button" class="datepicker-day-button" data-year="'+year+'" data-month="'+(Number(month)-1)+'" data-day="'+Number(day)+'">선택일</button>';};
      document.getElementById('select-all-weekday').onclick=()=>document.querySelector('.datepicker-day-button').classList.add('selected');
      create_tour_product.onclick=()=>{id_selected_dates.value=document.getElementById('start-date').value;const dialog=document.createElement('div');dialog.id='bs-modal-message';dialog.className='open';dialog.innerHTML='<button id="confirm-alert" type="button">확인</button>';dialog.querySelector('button').onclick=()=>fetch('/tour/master_product/${productId}/create_product/',{method:'POST',body:new FormData(create_product_form)});document.body.append(dialog);};
    </script>`;
  }
  function flightFields() {
    const value = season(); let html = '';
    const keys = ['id', 'depart_date', 'flight_no', 'airline', 'depart_cd', 'arrive_cd', 'depart_time', 'next_day', 'arrive_time', 'moving_time', 'code_share'];
    for (const [directionIndex, direction] of ['depart', 'arrive'].entries()) {
      html += input(`${direction}-TOTAL_FORMS`, '3', 'hidden');
      for (let index = 0; index < 3; index++) for (const key of keys) {
        const name = `${direction}-${index}-${key}`, content = index ? '' : key === 'id' ? String(80001 + directionIndex) : value[name] ?? '';
        html += ['airline', 'depart_cd', 'arrive_cd', 'next_day'].includes(key) ? select(name, [[content, content]]) : input(name, content, key === 'id' ? 'hidden' : 'text');
      }
    }
    return html;
  }
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== 'https://basecamp.team') return route.fallback();
    if (request.method() === 'GET' && url.pathname === `/tour/master_product/${productId}/create_product/`) return route.fulfill({ contentType: 'text/html', body: form() });
    const proxy = {
      request: () => request,
      fulfill: async args => {
        let body = args.body;
        if (typeof body === 'string' && /\/tour\/product\/\d+\/change\//.test(url.pathname)) {
          for (const kind of ['adult', 'child', 'infant']) body = body.replace(new RegExp(`(id="id_${kind}_total_price"[^>]*value=")[^"]+`), `$1${Number(season()[`${kind}_base_price`]) + Number(season()[`${kind}_fuel_price`])}`);
          body += input('id_unused'.replace('id_', ''), '') + input('season_departport', 'Fixture departure');
        }
        if (typeof body === 'string' && /\/tour\/tour_product_season\/\d+\/change\//.test(url.pathname)) {
          body += input('departport', season().departport) + flightFields();
          if (corruptFuel) body = body.replace(/(id="id_adult_fuel_price"[^>]*value=")[^"]+/, '$1999');
        }
        return route.fulfill({ ...args, ...(typeof body === 'string' ? { body } : {}) });
      }
    };
    if (request.method() === 'POST' && url.pathname === `/tour/master_product/${productId}/create_product/`) { createPosts++; state.writes.push({ kind: 'departure' }); }
    if (duplicate && request.method() === 'GET' && url.pathname === '/tour/product/' && backend.records.size === 0) backend.records.set('60001', { fields: {} });
    if (await backend.route(proxy)) return;
    return route.fallback();
  });
  return { backend, get createPosts() { return createPosts; } };
}
