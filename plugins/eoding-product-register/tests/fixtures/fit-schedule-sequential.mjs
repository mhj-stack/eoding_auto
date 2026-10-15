// Previous native editor, used only by the equivalent before/after fixture benchmark.
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const fail=message=>{throw Error(message)};
const dismissAlerts=async page=>page.evaluate(()=>{for(const b of document.querySelectorAll('.modal.open button'))if(b.textContent.trim()==='확인')b.click()});
export async function writeScheduleDay(page, masterId, day, placeIds) {
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

