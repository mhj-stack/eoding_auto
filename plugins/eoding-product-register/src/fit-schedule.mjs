const origin = 'https://basecamp.team';

function exactTarget(page, masterId) {
  const url = new URL(page.url());
  if (!/^[1-9][0-9]{0,12}$/.test(String(masterId)) || url.origin !== origin || url.username || url.password || url.search || url.pathname !== `/fit/master/${masterId}/change/`) throw Error('자유여행 일정의 상품 주소가 바뀌었습니다.');
}

async function ready(page, predicate, arg, timeout) {
  const handle = await page.waitForFunction(predicate, arg, { timeout, polling: 50 });
  await handle.dispose();
}

/** Native editor only: one action, then an observed condition; never retry a delayed click. */
export async function writeFitScheduleDay(page, masterId, day, placeIds, { assertIdentity = async () => {}, timeout = 20000 } = {}) {
  if (!Number.isInteger(day?.day) || day.day < 1 || day.day > 366 || !Array.isArray(day.steps) || !day.steps.length || day.steps.length > 40 || !Number.isInteger(timeout) || timeout < 100 || timeout > 30000) throw Error('유효한 일차와 일정 단계가 필요합니다.');
  const checked = structuredClone({ day, placeIds });
  const check = async () => { exactTarget(page, masterId); await assertIdentity(); exactTarget(page, masterId); };
  await check();
  await ready(page, () => Boolean(globalThis.jQuery && globalThis.controller?.schedule_controller && document.querySelector('#schedule-tree') && document.querySelector('#save')), undefined, timeout);
  let count = await page.locator('#schedule-tree .jstree-anchor').evaluateAll(nodes => nodes.filter(node => /^\d+일차$/.test(node.textContent.trim())).length);
  while (count < checked.day.day) {
    await check();
    await page.evaluate(() => { const button = document.querySelector('#add_schedule_day'); if (!button || button.disabled) throw Error('일차 추가 버튼이 없습니다.'); button.click(); });
    await ready(page, previous => {
      for (const button of document.querySelectorAll('.modal.open button')) if (button.textContent.trim() === '확인') button.click();
      return [...document.querySelectorAll('#schedule-tree .jstree-anchor')].filter(node => /^\d+일차$/.test(node.textContent.trim())).length === previous + 1 && !globalThis.jQuery.active;
    }, count, timeout);
    count++;
  }
  await check();
  await page.evaluate(dayNumber => {
    const found = [...document.querySelectorAll('#schedule-tree .jstree-anchor')].filter(node => node.textContent.trim() === `${dayNumber}일차`);
    if (found.length !== 1) throw Error(`${dayNumber}일차가 없거나 중복됩니다.`);
    found[0].click();
  }, checked.day.day);
  await ready(page, dayNumber => {
    for (const button of document.querySelectorAll('.modal.open button')) if (button.textContent.trim() === '확인') button.click();
    const found = [...document.querySelectorAll('#schedule-tree .jstree-anchor')].filter(node => node.textContent.trim() === `${dayNumber}일차`);
    const node = found[0];
    return found.length === 1 && (node.classList.contains('jstree-clicked') || node.closest('li')?.getAttribute('aria-selected') === 'true') && !globalThis.jQuery.active && Boolean(document.querySelector('#schedule_step_area'));
  }, checked.day.day, timeout);
  let rows = await page.locator('#schedule_step_area > li').count();
  while (rows !== checked.day.steps.length) {
    await check();
    const adding = rows < checked.day.steps.length;
    await page.evaluate(add => {
      const button = add ? document.querySelector('#schedule .sche_detail .add_schedule_detail') : [...document.querySelectorAll('#schedule_step_area > li')].at(-1)?.querySelector('.delete_schedule_detail');
      if (!button || button.disabled) throw Error('일정 단계 추가/삭제 버튼이 없습니다.'); button.click();
    }, adding);
    const next = rows + (adding ? 1 : -1);
    await ready(page, expected => {
      for (const button of document.querySelectorAll('.modal.open button')) if (button.textContent.trim() === '확인') button.click();
      return document.querySelectorAll('#schedule_step_area > li').length === expected && !globalThis.jQuery.active;
    }, next, timeout);
    rows = next;
  }
  for (const [index, step] of checked.day.steps.entries()) {
    await check();
    const type = step.kind === 'place' ? '4' : '7';
    await page.evaluate(({ index, type }) => {
      const row = document.querySelectorAll('#schedule_step_area > li')[index], select = row?.querySelector('select.schedule_type_select') ?? row?.querySelector('select');
      if (!select) throw Error('일정 유형 선택칸이 없습니다.');
      if (select.value !== type) globalThis.jQuery(select).val(type).trigger('change');
    }, { index, type });
    await ready(page, ({ index, type }) => {
      const row = document.querySelectorAll('#schedule_step_area > li')[index], select = row?.querySelector('select.schedule_type_select') ?? row?.querySelector('select');
      return select?.value === type && !globalThis.jQuery.active && Boolean(row.querySelector('.custom_title')) && (type === '7' ? Boolean(row.querySelector('.custom_short') && row.querySelector('.description')) : Boolean(row.querySelector('.tmpl > .contents_memo .description') ?? row.querySelector('.description')));
    }, { index, type }, timeout);
    await page.evaluate(({ index, step, placeIds }) => {
      const row = document.querySelectorAll('#schedule_step_area > li')[index], $ = globalThis.jQuery;
      const set = (selector, value) => { const field = row.querySelector(selector); if (!field) throw Error(`일정 입력칸이 없습니다: ${selector}`); field.value = value; field.dispatchEvent(new Event('input', { bubbles: true })); $(field).trigger('change'); };
      set('.custom_title', step.title);
      if (step.kind === 'custom') { set('.custom_short', step.short); set('.description', step.description); return; }
      const memo = row.querySelector('.tmpl > .contents_memo .description') ?? row.querySelector('.description');
      memo.value = step.description; memo.dispatchEvent(new Event('input', { bubbles: true }));
      row.querySelectorAll('.imported_contents').forEach(element => element.remove());
      const controller = globalThis.controller.schedule_controller;
      controller.open_contents_popup_id = row.id;
      controller.import_contents(step.places.map(key => placeIds[key]));
    }, { index, step, placeIds: checked.placeIds });
  }
  await ready(page, () => !globalThis.jQuery.active, undefined, timeout);
  await check();
  const response = page.waitForResponse(result => result.request().method() === 'POST' && result.url() === `${origin}/fit/schedule/${masterId}/change/`, { timeout: 30000 });
  response.catch(() => {});
  await page.evaluate(() => document.querySelector('#save').click());
  const saved = await response;
  await saved.finished();
  if (saved.status() !== 200) throw Error(`${checked.day.day}일차 일정 저장 응답이 ${saved.status()}입니다.`);
  await ready(page, () => !globalThis.jQuery.active, undefined, timeout);
  await page.evaluate(() => { for (const button of document.querySelectorAll('.modal.open button')) if (button.textContent.trim() === '확인') button.click(); });
  await check();
}
