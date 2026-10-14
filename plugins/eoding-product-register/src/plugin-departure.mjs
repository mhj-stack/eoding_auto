import { isDeepStrictEqual as same } from 'node:util';
import { digest } from './core.mjs';
import { installDepartureTransportGuard } from './departure-live-transport.mjs';
import { readObservedDepartureList } from './departure-execution.mjs';
import { readDepartureSnapshot } from './departure-read.mjs';
import { readPersistedFlights, verifyPersistedFlights } from './flight-persistence-read.mjs';
import { readScheduleDetail } from './schedule-detail-read.mjs';
import { verifyCopiedScheduleReadback } from './departure-result.mjs';
import { flightPreflight } from './plugin-workflow.mjs';

const ORIGIN = 'https://basecamp.team', copy = structuredClone;
const fail = message => { throw new Error(message); };
const canonicalId = value => { if (!/^[1-9]\d{0,9}$/.test(String(value))) fail('Invalid departure target ID'); return String(value); };
const money = value => String(value).replaceAll(',', '');
const priceNames = ['adult', 'child', 'infant'].flatMap(kind => [`${kind}_price`, `${kind}_fuel_price`]);

export function departurePreflight(plan) {
  const blockers = [];
  const option = plan?.departure;
  if (!option || !same(Object.keys(option).sort(), ['create', 'status']) || option.create !== true || !['3', '4'].includes(option.status)) blockers.push('departure는 명시적인 {create:true,status:"3" 또는 "4"}만 지원합니다.');
  if (plan?.seasonMode === 'excluded' || plan?.season?.selectedDates?.length !== 1) blockers.push('행사는 저장된 시즌의 출발일 1개가 필요합니다.');
  if (plan?.product?.currency !== 'KRW') blockers.push('행사 자동 생성은 KRW만 지원합니다.');
  blockers.push(...flightPreflight(plan?.season, plan?.product?.departures?.find(item => item.startDate === plan?.season?.selectedDates?.[0])).map(item => item.message));
  return { canExecute: blockers.length === 0, blockers };
}

export function departureExpected(plan, targets, seasonId) {
  const fields = plan.season.fields;
  const entries = { master_product_id: canonicalId(targets.productId), status: plan.departure.status, title: plan.product.title, schedule: canonicalId(targets.scheduleId), season: canonicalId(seasonId), currency_code: 'KRW', min_pax_count: fields.min_pax_count, max_pax_count: fields.max_pax_count, departport: plan.season.selects.departport };
  for (const kind of ['adult', 'child', 'infant']) { entries[`${kind}_price`] = fields[`${kind}_base_price`]; entries[`${kind}_fuel_price`] = fields[`${kind}_fuel_price`]; }
  return entries;
}

export function assertDepartureForm(entries, expected, selectedDate) {
  for (const [name, value] of Object.entries({ ...expected, selected_dates: selectedDate })) {
    const values = entries.filter(([key]) => key === name).map(([, item]) => priceNames.includes(name) ? money(item) : item);
    // Native ERP repeats master_product_id; every copy must bind the same target.
    if (!values.length || (name !== 'master_product_id' && values.length !== 1) || values.some(item => item !== value)) fail(`행사 폼 값이 승인과 다릅니다: ${name}`);
  }
}

export function verifyDepartureReadback(plan, targets, snapshot, flights, schedule, managerId) {
  const date = plan.season.selectedDates[0], selected = plan.product.departures.find(item => item.startDate === date);
  const fields = plan.season.fields, expected = {
    id_status: plan.departure.status, id_title: plan.product.title, id_currency_code: 'KRW', id_master_product_code: targets.masterCode,
    id_min_pax_count: fields.min_pax_count, id_max_pax_count: fields.max_pax_count, id_res_count: '0',
    id_tour_season: `${selected.startDate.replaceAll('-', '/')} ~ ${selected.endDate.replaceAll('-', '/')} (${plan.product.nights}박${plan.product.days}일)`
  };
  if (managerId !== undefined) expected.id_manager = managerId;
  for (const kind of ['adult', 'child', 'infant']) expected[`id_${kind}_total_price`] = String(Number(fields[`${kind}_base_price`]) + Number(fields[`${kind}_fuel_price`]));
  for (const [key, value] of Object.entries(expected)) if ((key.endsWith('_total_price') ? money(snapshot.eventFields[key]) : snapshot.eventFields[key]) !== value) fail(`저장된 행사 값이 다릅니다: ${key}`);
  for (const name of ['currency_code', 'min_pax_count', 'max_pax_count', ...['adult', 'child', 'infant'].flatMap(kind => [`${kind}_base_price`, `${kind}_fuel_price`])]) {
    const found = snapshot.priceFields.filter(item => item.id === `id_${name}`);
    if (found.length !== 1 || money(found[0].value) !== fields[name]) fail(`저장된 행사 요금이 다릅니다: ${name}`);
  }
  const port = snapshot.priceFields.filter(item => item.id === 'id_departport');
  if (port.length === 1 ? port[0].value !== plan.season.selects.departport : snapshot.eventFields.id_season_departport !== plan.season.selectLabels.departport) fail('저장된 행사 출발지가 다릅니다.');
  if (snapshot.seasonId !== flights.seasonId || snapshot.eventId !== flights.eventId) fail('행사와 항공 조회 대상이 다릅니다.');
  const segmentKeys = ['depart_date', 'flight_no', 'airline', 'depart_cd', 'arrive_cd', 'depart_time', 'next_day', 'arrive_time', 'moving_time', 'code_share'];
  const expectedFlights = Object.fromEntries(['depart', 'arrive'].map(direction => [direction, [Object.fromEntries(segmentKeys.map(key => [key, plan.season.selects[`${direction}-0-${key}`] ?? fields[`${direction}-0-${key}`] ?? (['next_day', 'code_share'].includes(key) ? '' : undefined)]))]]));
  const flightProof = verifyPersistedFlights(flights, expectedFlights);
  const copied = verifyCopiedScheduleReadback(snapshot, schedule);
  return { status: 'departure-verified', eventId: snapshot.eventId, eventUrl: `${ORIGIN}/tour/product/${snapshot.eventId}/change/`, ...copied, flights: flightProof };
}

/** Creates one event by selecting the already verified master season. Never creates a second season. */
export function createPluginDepartureAdapter({ assertIdentity, authorizeWrite, record, timeoutMs = 15000 } = {}) {
  let attempted = false, transportVerified = false, saved, binding, baselineSchedule, guard, approvedPlan;
  const listUrl = targets => `${ORIGIN}/tour/product/?master__master_code=${encodeURIComponent(targets.masterCode)}&start_date=&end_date=&use_flag=True`;
  async function list(page, targets) {
    const url = listUrl(targets);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    try {
      await page.waitForFunction(() => { const settings = globalThis.jQuery?.fn?.dataTable?.settings; return Array.isArray(settings) && settings.length === 1 && settings[0]?._bInitComplete === true; }, undefined, { timeout: timeoutMs });
    } catch (error) {
      const state = await page.evaluate(() => { const settings = globalThis.jQuery?.fn?.dataTable?.settings; return { url: location.pathname, jquery: Boolean(globalThis.jQuery), tables: Array.isArray(settings) ? settings.length : null, initComplete: Array.isArray(settings) ? settings.map(item => item?._bInitComplete === true) : null }; }).catch(() => null);
      fail(`행사 목록 표가 로드되지 않았습니다(${timeoutMs}ms): ${JSON.stringify(state)}`);
    }
    await assertIdentity(page);
    return readObservedDepartureList(page, { url, extractEventId: row => canonicalId(row.id) });
  }
  async function entries(page) {
    const result = await page.locator('#create_product_form').evaluate(form => [...new FormData(form).entries()]);
    if (!Array.isArray(result) || result.some(pair => pair.length !== 2 || pair.some(value => typeof value !== 'string'))) fail('행사 폼에 지원하지 않는 값이 있습니다.');
    return result;
  }
  async function sourceSchedule(page, targets) {
    const url = `${ORIGIN}/tour/master_product/${canonicalId(targets.productId)}/change/`;
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    if (response?.status() !== 200 || response.url() !== url || page.url() !== url || response.request().redirectedFrom()) fail('원본 일정 조회 대상이 변경됐습니다.');
    await assertIdentity(page);
    return readScheduleDetail(page, { productId: String(targets.productId), scheduleId: String(targets.scheduleId) });
  }
  async function choose(page, name, value) {
    const control = page.locator(`#id_${name}`);
    const exact = await control.evaluate((element, value) => element.tagName === 'SELECT' && !element.disabled && [...element.options].filter(option => option.value === value && !option.disabled).length === 1, value);
    if (!exact) fail(`행사 선택값을 확인할 수 없습니다: ${name}`);
    await control.selectOption(value, { force: true });
    if (await control.inputValue() !== value) fail(`행사 선택값이 유지되지 않았습니다: ${name}`);
  }
  // The event form inherits the master manager, and its manager control is a Select2 AJAX widget in
  // the live ERP: only the inherited/selected employee is present as a native option. Accept the
  // inherited value, a native option, or an exact Select2 search result, in that order.
  async function chooseManager(page, managerId, managerLabel) {
    const control = page.locator('#id_manager');
    if (await control.count() !== 1) fail('행사 담당자 선택 칸을 찾을 수 없습니다.');
    const state = () => control.evaluate((element, value) => ({ tag: element.tagName, disabled: element.disabled, current: element.value, native: [...element.options].filter(option => option.value === value && !option.disabled).length, ajax: Boolean(element.getAttribute('data-url')), id: element.id }), managerId);
    try { await page.waitForFunction(() => document.querySelector('#id_manager')?.value !== '', undefined, { timeout: 3000 }); } catch {}
    let observed = await state();
    if (observed.tag !== 'SELECT' || observed.disabled) fail('행사 담당자 선택 칸 형식이 예상과 다릅니다.');
    if (observed.current === managerId) return;
    if (observed.native === 1) { await control.selectOption(managerId, { force: true }); }
    else if (observed.ajax) {
      if (typeof managerLabel !== 'string' || !managerLabel.trim()) fail('검증된 기본상품 담당자 이름이 없습니다.');
      const rendered = page.locator(`[aria-labelledby="select2-${observed.id}-container"]`);
      if (await rendered.count() !== 1) fail('행사 담당자 검색 칸을 찾을 수 없습니다.');
      await rendered.click();
      const results = page.locator(`#select2-${observed.id}-results[aria-expanded="true"]`);
      const dropdown = page.locator('.select2-dropdown').filter({ has: results });
      const search = dropdown.locator('input.select2-search__field');
      if (await search.count() !== 1) fail('행사 담당자 검색 입력칸을 찾을 수 없습니다.');
      await search.fill(managerLabel.replace(/\s*\([^()]*\)\s*$/, '').trim() || managerLabel);
      const option = dropdown.getByRole('treeitem', { name: managerLabel, exact: true });
      await option.first().waitFor({ state: 'visible', timeout: timeoutMs });
      if (await option.count() !== 1) fail('행사 담당자 검색 결과가 없거나 여러 개입니다.');
      await option.click();
    } else fail('행사 선택값을 확인할 수 없습니다: manager');
    observed = await state();
    if (observed.current !== managerId) fail('행사 선택값이 유지되지 않았습니다: manager');
  }
  const assertContext = (plan, context) => {
    if (!same(plan.target, context.targets) || !same(plan.approvalBinding, context.approvalBinding) || context.approvalClaim?.planDigest !== plan.approvalBinding.planDigest || context.approvalClaim?.scopeDigest !== plan.approvalBinding.scopeDigest || !same(context.approvalClaim.target, { mode: 'NEW' })) fail('행사 승인 범위 또는 대상이 변경됐습니다.');
    for (const name of ['basic', 'media', 'shell', ...plan.itinerary.map(day => `day:${day.day}`), 'season']) if (context.verifiedPreviousPhases.filter(item => item.name === name && item.verification).length !== 1) fail(`행사 생성 전 저장 확인이 필요합니다: ${name}`);
    const season = context.verifiedPreviousPhases.find(item => item.name === 'season').receipt;
    if (season.kind !== 'season-save-receipt-v1' || season.target.productId !== String(context.targets.productId)) fail('검증된 시즌 대상이 다릅니다.');
    return season;
  };
  async function verify(page, receipt, plan, context) {
    const season = assertContext(plan, context);
    if (!same(receipt, saved) || !same(binding, { plan: plan.approvalBinding, target: context.targets, seasonId: season.seasonId })) fail('행사 영수증이 현재 실행과 다릅니다.');
    const current = await list(page, context.targets);
    if (current.rows.length !== 1 || current.rows[0].eventId !== saved.eventId) fail('행사 목록이 생성한 1건과 다릅니다.');
    const schedule = await sourceSchedule(page, context.targets);
    if (!same(schedule, baselineSchedule)) fail('행사 생성 중 원본 일정이 변경됐습니다.');
    const snapshot = await readDepartureSnapshot(page, { eventId: saved.eventId });
    const flights = await readPersistedFlights(page, { eventId: saved.eventId });
    const proof = verifyDepartureReadback(plan, context.targets, snapshot, flights, schedule, context.verifiedPreviousPhases.find(item => item.name === 'basic').receipt.managerValue);
    await assertIdentity(page);
    if (!transportVerified) { guard.verify(); transportVerified = true; }
    return proof;
  }
  return {
    preflight: departurePreflight,
    async save(page, plan, context) {
      const check = departurePreflight(plan); if (!check.canExecute) fail(check.blockers.join('; '));
      if (attempted) fail('행사 생성은 재시도할 수 없습니다. 기존 작업을 재조회하세요.');
      attempted = true;
      approvedPlan = copy(plan);
      const season = assertContext(plan, context), targets = context.targets;
      binding = { plan: copy(plan.approvalBinding), target: copy(targets), seasonId: season.seasonId };
      const owner = page.context(), readonly = route => ['GET', 'HEAD'].includes(route.request().method()) ? route.fallback() : route.abort();
      await owner.route('**/*', readonly);
      let prepared, expected;
      try {
        await assertIdentity(page);
        if ((await list(page, targets)).rows.length !== 0) fail('이미 연결된 행사가 있어 중복 생성을 차단했습니다.');
        baselineSchedule = await sourceSchedule(page, targets);
        const url = `${ORIGIN}/tour/master_product/${targets.productId}/create_product/?from=${targets.productId}`;
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        if (response?.status() !== 200 || response.url() !== url || page.url() !== url) fail('정확한 행사 생성 화면을 열지 못했습니다.');
        // The ERP binds its season handler only after its controller initializes; selecting at
        // domcontentloaded left prices/pax/port empty on the live tenant (FSZ0001, HKG0000).
        await page.waitForLoadState('load', { timeout: timeoutMs }).catch(() => {});
        await page.waitForFunction(() => typeof globalThis.controller === 'object' && Boolean(document.getElementById('id_season')?.M_FormSelect), undefined, { timeout: 5000 }).catch(() => {});
        await choose(page, 'schedule', String(targets.scheduleId));
        await choose(page, 'season', season.seasonId);
        const seasonBound = () => page.waitForFunction(() => (document.getElementById('id_adult_price')?.value ?? '') !== '', undefined, { timeout: 5000 }).then(() => true, () => false);
        if (!await seasonBound()) {
          await page.evaluate(() => globalThis.jQuery?.('#id_season').trigger('change'));
          await seasonBound();
        }
        expected = departureExpected(plan, targets, season.seasonId);
        const basicReceipt = context.verifiedPreviousPhases.find(item => item.name === 'basic').receipt;
        const managerId = basicReceipt.managerValue;
        if (typeof managerId !== 'string' || !managerId.trim()) fail('검증된 기본상품 담당자 값이 없습니다.');
        await chooseManager(page, managerId, basicReceipt.managerLabel); expected.manager = managerId;
        // Wait for the ERP's season-selection handler to finish before verifying every bound value.
        try {
          await page.waitForFunction(want => Object.entries(want).every(([name, value]) => {
            if (['master_product_id', 'title', 'status'].includes(name)) return true;
            const controls = document.querySelectorAll(`#create_product_form [name="${name}"]`);
            return controls.length === 1 && controls[0].value.replaceAll(',', '') === value;
          }), expected, { timeout: timeoutMs });
        } catch (error) {
          // Record exactly which bound values never matched so a live failure is diagnosable.
          const mismatches = await page.evaluate(want => Object.entries(want).filter(([name]) => !['master_product_id', 'title', 'status'].includes(name)).map(([name, value]) => {
            const controls = [...document.querySelectorAll(`#create_product_form [name="${name}"]`)];
            return { name, expected: value, count: controls.length, actual: controls.map(control => control.value) };
          }).filter(item => item.count !== 1 || item.actual[0].replaceAll(',', '') !== item.expected), expected).catch(() => null);
          fail(`행사 폼 값이 ${timeoutMs}ms 안에 승인값과 맞춰지지 않았습니다: ${JSON.stringify(mismatches)}`);
        }
        await choose(page, 'status', plan.departure.status);
        await page.locator('#id_title').fill(plan.product.title);
        const date = plan.season.selectedDates[0];
        for (const id of ['start-date', 'end-date']) await page.locator(`#${id}`).evaluate((element, date) => { element.value = date; element.dispatchEvent(new Event('change', { bubbles: true })); }, date);
        await page.locator('#create_schedule_calendar').click();
        const button = page.locator('#multi-calendar button.datepicker-day-button').filter({ hasNot: page.locator('.disabled') });
        const visible = await button.evaluateAll(elements => elements.filter(element => !element.disabled).map(element => ({ date: `${element.dataset.year}-${String(Number(element.dataset.month) + 1).padStart(2, '0')}-${String(element.dataset.day).padStart(2, '0')}`, selected: element.classList.contains('selected') })));
        const matching = visible.filter(item => item.date === date);
        if (matching.length !== 1) fail('행사 달력에 선택한 출발일이 없습니다.');
        if (!matching[0].selected) await page.locator('#select-all-weekday').click();
        const dates = await page.locator('#multi-calendar button.datepicker-day-button.selected').evaluateAll(elements => elements.map(element => `${element.dataset.year}-${String(Number(element.dataset.month) + 1).padStart(2, '0')}-${String(element.dataset.day).padStart(2, '0')}`));
        if (!same(dates, [date])) fail('행사 달력은 승인한 날짜 1개만 선택해야 합니다.');
        // The live ERP copies the season's flights into the event form but leaves the return
        // leg's date blank. Fill only blank flight dates with the approved season value.
        for (const name of ['depart-0-depart_date', 'arrive-0-depart_date']) {
          const approved = plan.season.fields[name];
          const control = page.locator(`#id_${name}`);
          if (typeof approved !== 'string' || await control.count() !== 1) continue;
          const current = await control.inputValue();
          if (current === '') await control.evaluate((element, value) => { element.value = value; element.dispatchEvent(new Event('change', { bubbles: true })); }, approved);
          else if (current !== approved) fail(`행사 항공 날짜가 승인과 다릅니다: ${name}`);
          if (await control.inputValue() !== approved) fail(`행사 항공 날짜를 입력하지 못했습니다: ${name}`);
        }
        prepared = await entries(page); assertDepartureForm(prepared, expected, '');
        await assertIdentity(page);
      } finally { await owner.unroute('**/*', readonly); }
      const postEntries = prepared.map(([key, value]) => [key, key === 'selected_dates' ? plan.season.selectedDates[0] : priceNames.includes(key) ? money(value) : value]);
      const envelope = { phase: 'departure', target: copy(targets), approvalBinding: copy(plan.approvalBinding), bindingDigest: digest({ binding, postEntries }), prepared: { entries: postEntries, schedule: baselineSchedule } };
      const authorization = await authorizeWrite(copy(envelope), copy(context));
      if (!authorization?.durable || authorization.status !== 'approved' || authorization.bindingDigest !== envelope.bindingDigest) fail('행사 생성에 대한 현재 승인을 확인할 수 없습니다.');
      if (!same(await entries(page), prepared)) fail('승인 중 행사 입력값이 바뀌었습니다.');
      await assertIdentity(page);
      guard = await installDepartureTransportGuard(page, { productId: String(targets.productId), entries: postEntries, bookingStatus: plan.departure.status });
      try {
        await page.locator('#create_tour_product').click();
        assertDepartureForm(await entries(page), expected, plan.season.selectedDates[0]);
        await record({ ...copy(envelope), kind: 'departure-before-post' }, copy(context));
        await assertIdentity(page);
        const response = page.waitForResponse(response => response.request().method() === 'POST' && response.url() === `${ORIGIN}/tour/master_product/${targets.productId}/create_product/`, { timeout: timeoutMs });
        response.catch(() => {});
        guard.arm();
        await page.locator('#bs-modal-message.open #confirm-alert').click();
        const received = await response;
        if (received.status() !== 201 || await received.finished() || guard.count !== 1) fail('행사 저장 응답을 확정할 수 없습니다. 자동 재시도하지 마세요.');
      } finally { guard.seal(); }
      const after = await list(page, targets);
      if (after.rows.length !== 1) fail('생성된 행사 1건을 확인할 수 없습니다.');
      saved = { kind: 'plugin-departure-receipt-v1', target: copy(targets), masterSeasonId: season.seasonId, eventId: after.rows[0].eventId, guardedPosts: guard.count };
      return copy(saved);
    },
    async verifyReceipt(page, receipt, context) { return verify(page, receipt, approvedPlan, context); },
    async readFinal(page, receipt, context) { return verify(page, receipt, approvedPlan, context); }
  };
}
