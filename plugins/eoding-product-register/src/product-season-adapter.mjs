import { createHash } from 'node:crypto';
import { installStageTransport } from './stage-transport.mjs';

const CREATE_PATH = '/tour/master_product_season/add/';
const LIST_PATH = '/tour/master_product_season/';
const PRODUCT_ID = /^[1-9]\d*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const FIELD = /^[A-Za-z][A-Za-z0-9_-]*$/;
const TIME_WITH_SECONDS = /^(\d{2}:\d{2}):00$/;
const PRICE_FIELD = /^(adult|child|infant)_(base|fuel)_price$/;
const AJAX_SELECT_PATHS = {
  airline: '/common/autocomplete/airline/',
  airport: '/common/autocomplete/airport/'
};
const SELECT2_LOADING_CLASSES = ['select2-results__option--loading', 'loading-results', 'select2-searching'];
const clone = value => structuredClone(value);
const fail = message => { throw new TypeError(message); };
const sha256 = value => createHash('sha256').update(stable(value)).digest('hex');

function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
}

function nonempty(value, name) {
  if (typeof value !== 'string' || !value) fail(`${name} must be a nonempty string`);
  return value;
}

function productTarget(target) {
  if (!target || typeof target !== 'object' || Array.isArray(target) || !PRODUCT_ID.test(target.productId ?? '')) fail('target.productId must be a canonical positive integer string');
  return { productId: target.productId };
}

function normalizePlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan) || Object.hasOwn(plan, 'event') || Object.hasOwn(plan, 'events') || plan.eventCreation === true) fail('season adapter does not permit event creation');
  if (!plan.fields || typeof plan.fields !== 'object' || Array.isArray(plan.fields)) fail('plan.fields must be an object');
  if (!plan.selects || typeof plan.selects !== 'object' || Array.isArray(plan.selects)) fail('plan.selects must be an object');
  if (!Array.isArray(plan.selectedDates) || !plan.selectedDates.length || plan.selectedDates.some(value => !DATE.test(value))) fail('plan.selectedDates must contain ISO dates');
  if (new Set(plan.selectedDates).size !== plan.selectedDates.length) fail('plan.selectedDates must not repeat dates');
  const reserved = new Set(['csrfmiddlewaretoken', 'product_id', 'id', 'selected_dates', 'start_date', 'end_date']);
  const fields = {};
  for (const [name, value] of Object.entries(plan.fields)) {
    if (!FIELD.test(name) || reserved.has(name) || typeof value !== 'string') fail(`invalid season field ${name}`);
    fields[name] = value;
  }
  const selects = {};
  for (const [name, value] of Object.entries(plan.selects)) {
    if (!FIELD.test(name) || reserved.has(name) || typeof value !== 'string' || !value) fail(`invalid season select ${name}`);
    selects[name] = value;
  }
  if (plan.selectLabels !== undefined && (!plan.selectLabels || typeof plan.selectLabels !== 'object' || Array.isArray(plan.selectLabels))) fail('plan.selectLabels must be an object when supplied');
  const selectLabels = {};
  for (const [name, label] of Object.entries(plan.selectLabels ?? {})) {
    if (!Object.hasOwn(selects, name) || !FIELD.test(name) || reserved.has(name) || typeof label !== 'string' || !label) fail(`invalid season select label ${name}`);
    selectLabels[name] = label;
  }
  if (plan.selectQueries !== undefined && (!plan.selectQueries || typeof plan.selectQueries !== 'object' || Array.isArray(plan.selectQueries))) fail('plan.selectQueries must be an object when supplied');
  const selectQueries = {};
  for (const [name, query] of Object.entries(plan.selectQueries ?? {})) {
    if (!Object.hasOwn(selects, name) || !Object.hasOwn(selectLabels, name) || !FIELD.test(name) || reserved.has(name) || typeof query !== 'string' || !query) fail(`invalid season select query ${name}`);
    selectQueries[name] = query;
  }
  return { fields, selects, selectLabels, selectQueries, selectedDates: [...plan.selectedDates] };
}

function normalizeWrite(name, value) {
  const string = String(value);
  return PRICE_FIELD.test(name) ? string.replaceAll(',', '') : string;
}

function normalizeRead(name, value) {
  const string = String(value);
  return TIME_WITH_SECONDS.test(string) ? string.slice(0, -3) : string;
}

function tuplesEqual(actual, expected) {
  return actual.length === expected.length && actual.every(([name, value], index) => name === expected[index][0] && value === expected[index][1]);
}

function checkedOrigin(page, expectedOrigin) {
  const url = new URL(page.url());
  if (url.origin === 'null' || (expectedOrigin && url.origin !== expectedOrigin)) fail('page origin changed');
  return url.origin;
}

async function identity(assertIdentity, target, phase) {
  if (typeof assertIdentity !== 'function') fail('assertIdentity callback is required');
  const observed = await assertIdentity({ target: clone(target), phase });
  if (!observed || typeof observed !== 'object' || Array.isArray(observed)) fail('assertIdentity must return a non-array identity object');
  return sha256(observed);
}

async function fetchDocument(page, url) {
  const result = await page.evaluate(async targetUrl => {
    const response = await fetch(targetUrl, { cache: 'no-store', credentials: 'same-origin', redirect: 'error' });
    return { ok: response.ok, status: response.status, text: await response.text() };
  }, url);
  if (!result.ok) throw new Error(`season GET failed with ${result.status}`);
  return result.text;
}

async function readList(page, target, origin) {
  const url = `${origin}${LIST_PATH}?product_id=${encodeURIComponent(target.productId)}&init_flag=False`;
  const html = await fetchDocument(page, url);
  return page.evaluate(({ source, productId, url }) => {
    const doc = new DOMParser().parseFromString(source, 'text/html');
    if (doc.querySelector('#master_product_id')?.value !== productId) throw new Error('season list is not bound to target product');
    const seasons = [...doc.querySelectorAll('#season_table tbody tr[id]')].map(row => row.id);
    if (seasons.some(id => !/^[1-9]\d*$/.test(id)) || new Set(seasons).size !== seasons.length) throw new Error('season list has invalid membership');
    return { productId, seasons, url };
  }, { source: html, productId: target.productId, url });
}

async function nativeForm(page) {
  return page.locator('#season_frm').evaluate(form => {
    if (!(form instanceof HTMLFormElement)) throw new Error('native season form is unavailable');
    return [...new FormData(form)].filter(([name]) => name !== 'csrfmiddlewaretoken').map(([name, value]) => [name, String(value)]);
  });
}

async function setInput(page, name, value) {
  if (!FIELD.test(name)) fail(`invalid season field ${name}`);
  const control = page.locator(`#season_frm [name="${name}"]`);
  if (await control.count() !== 1) throw new Error(`native season field is missing or ambiguous: ${name}`);
  await control.evaluate((element, next) => {
    if (element.disabled) throw new Error('native season field is disabled');
    element.value = next;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

function selectEndpoint(name, rawUrl, pageOrigin) {
  if (typeof rawUrl !== 'string' || !rawUrl) throw new Error(`empty AJAX season select has no data-url: ${name}`);
  let endpoint;
  try { endpoint = new URL(rawUrl, pageOrigin); } catch { throw new Error(`AJAX season select has an untrusted read endpoint: ${name}`); }
  const expectedPath = name.endsWith('-airline') ? AJAX_SELECT_PATHS.airline
    : name.endsWith('-depart_cd') || name.endsWith('-arrive_cd') ? AJAX_SELECT_PATHS.airport : null;
  if (!expectedPath || endpoint.origin !== pageOrigin || endpoint.pathname !== expectedPath || endpoint.search || endpoint.hash || endpoint.username || endpoint.password) throw new Error(`AJAX season select has an untrusted read endpoint: ${name}`);
  return endpoint;
}

async function assertSelectChoice(control, name, value, label) {
  const selected = await control.evaluate(element => {
    const option = element.selectedOptions.item(0);
    return { value: element.value, label: option?.textContent ?? '' };
  });
  if (selected.value !== value) throw new Error(`native season select did not accept ${name}`);
  if (label !== undefined && selected.label !== label) throw new Error(`native season select label differs: ${name}`);
}

async function chooseAjaxSelect(page, control, name, value, label, query) {
  if (label === undefined) throw new Error(`empty AJAX season select requires plan.selectLabels: ${name}`);
  if (query === undefined) throw new Error(`empty AJAX season select requires plan.selectQueries: ${name}`);
  const { id, dataUrl } = await control.evaluate(element => ({ id: element.id, dataUrl: element.getAttribute('data-url') }));
  if (!id) throw new Error(`empty AJAX season select has no native id: ${name}`);
  const endpoint = selectEndpoint(name, dataUrl, checkedOrigin(page));
  const rendered = page.locator(`#select2-${id}-container`);
  if (await rendered.count() !== 1) throw new Error(`native Select2 rendered control is missing or ambiguous: ${name}`);
  await rendered.locator('xpath=..').click();
  const search = page.locator('.select2-container--open .select2-search__field');
  if (await search.count() !== 1) throw new Error(`native Select2 search control is missing or ambiguous: ${name}`);
  const matchingRead = candidate => {
    try {
      const url = new URL(candidate.url());
      return candidate.method() === 'GET' && url.origin === endpoint.origin && url.pathname === endpoint.pathname;
    } catch { return false; }
  };
  const request = page.waitForRequest(matchingRead, { timeout: 3_000 });
  const response = page.waitForResponse(candidate => matchingRead(candidate.request()), { timeout: 3_000 });
  await search.fill(query);
  const [observed, completed] = await Promise.all([request, response]);
  const observedUrl = new URL(observed.url());
  if (observedUrl.origin !== endpoint.origin || observedUrl.pathname !== endpoint.pathname) throw new Error(`native Select2 used an unexpected read endpoint: ${name}`);
  if (![...observedUrl.searchParams.values()].includes(query)) throw new Error(`native Select2 did not use the approved query: ${name}`);
  if (!completed.ok()) throw new Error(`native Select2 read response was not accepted: ${name}`);
  const settled = await page.waitForFunction(({ expected, loadingClasses }) => {
    const open = [...document.querySelectorAll('.select2-container--open')];
    if (open.length !== 1) return null;
    const results = [...open[0].querySelectorAll('.select2-results__option')];
    if (results.some(item => loadingClasses.some(className => item.classList.contains(className)))) return null;
    return results.map((item, index) => item.textContent === expected ? index : -1).filter(index => index >= 0);
  }, { expected: label, loadingClasses: SELECT2_LOADING_CLASSES }, { timeout: 3_000 });
  const exact = await settled.jsonValue();
  if (exact.length !== 1) throw new Error(`native Select2 exact result is missing or ambiguous: ${name}`);
  const results = page.locator('.select2-container--open .select2-results__option');
  await results.nth(exact[0]).click();
  await assertSelectChoice(control, name, value, label);
  if (await rendered.textContent() !== label) throw new Error(`native Select2 rendered label differs: ${name}`);
}

async function setSelect(page, name, value, label, query) {
  if (!FIELD.test(name)) fail(`invalid season select ${name}`);
  const control = page.locator(`#season_frm select[name="${name}"]`);
  if (await control.count() !== 1) throw new Error(`native season select is missing or ambiguous: ${name}`);
  const options = await control.locator('option').evaluateAll(items => items.map(item => item.value));
  if (!options.includes(value) && await control.getAttribute('data-url') !== null) return chooseAjaxSelect(page, control, name, value, label, query);
  await control.selectOption(value);
  await assertSelectChoice(control, name, value, label);
}

async function chooseDates(page, selectedDates) {
  for (const [id, value] of [['start-date', selectedDates[0]], ['end-date', selectedDates.at(-1)]]) {
    const control = page.locator(`#${id}`);
    if (await control.count() !== 1) throw new Error(`native calendar control is missing: ${id}`);
    await control.evaluate((element, next) => {
      element.value = next;
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
  }
  const create = page.locator('#create_schedule_calendar');
  if (await create.count() !== 1) throw new Error('native calendar create control is missing or ambiguous');
  await create.click();
  const chosen = await page.locator('#multi-calendar button.datepicker-day-button.selected').evaluateAll(buttons => buttons.map(button => [
    button.getAttribute('data-year'),
    String(Number(button.getAttribute('data-month')) + 1).padStart(2, '0'),
    button.getAttribute('data-day').padStart(2, '0')
  ].join('-')));
  if (stable(chosen) !== stable(selectedDates)) throw new Error('native calendar selection differs from approved selectedDates');
  await setInput(page, 'selected_dates', chosen.join(','));
  await setInput(page, 'start_date', chosen[0]);
  await setInput(page, 'end_date', chosen.at(-1));
  return chosen;
}

async function savedForm(page, html, seasonId) {
  return page.evaluate(({ source, expectedSeasonId }) => {
    const doc = new DOMParser().parseFromString(source, 'text/html');
    const form = doc.querySelector('#season_frm');
    if (!(form instanceof HTMLFormElement)) throw new Error('saved native season form is unavailable');
    const tuples = [...new FormData(form)].filter(([name]) => name !== 'csrfmiddlewaretoken').map(([name, value]) => [name, String(value)]);
    const selects = {};
    for (const select of form.querySelectorAll('select[name][data-init-id]')) {
      const initId = select.getAttribute('data-init-id');
      if (initId === null || !initId) throw new Error(`saved native select lacks data-init-id: ${select.name}`);
      if (Object.hasOwn(selects, select.name)) throw new Error(`saved native select is duplicated: ${select.name}`);
      selects[select.name] = initId;
    }
    // `id` is reused by nested flight controls. The direct form-level id alone is season identity.
    const topIds = [...form.querySelectorAll(':scope > input[name="id"]')].map(input => input.value);
    if (topIds.length !== 1 || topIds[0] !== expectedSeasonId) throw new Error('saved season form top id does not have the receipt season id');
    const selected = tuples.filter(([name]) => name === 'selected_dates').map(([, value]) => value);
    if (selected.length !== 1 || !selected[0]) throw new Error('saved season form has no selected_dates');
    const fields = Object.fromEntries(tuples.filter(([name]) => name !== 'product_id' && name !== 'id' && !Object.hasOwn(selects, name)));
    return { tuples, fields, selects, selectedDates: selected[0].split(',') };
  }, { source: html, expectedSeasonId: seasonId });
}

function preparedShape(prepared) {
  if (!prepared || typeof prepared !== 'object' || Array.isArray(prepared) || prepared.kind !== 'season-prepared-v1') fail('prepared season object is invalid');
  const target = productTarget(prepared.target);
  if (typeof prepared.origin !== 'string' || typeof prepared.identityDigest !== 'string' || typeof prepared.planDigest !== 'string' || typeof prepared.formDigest !== 'string' || !Array.isArray(prepared.form) || !prepared.binding || typeof prepared.binding.digest !== 'string') fail('prepared season object is incomplete');
  const plan = normalizePlan(prepared.plan);
  if (sha256(plan) !== prepared.planDigest || prepared.binding.planDigest !== prepared.planDigest) fail('prepared season plan integrity differs from its binding');
  const binding = clone(prepared.binding), bindingDigest = binding.digest;
  delete binding.digest;
  if (sha256(binding) !== bindingDigest) fail('prepared season binding integrity differs');
  return target;
}

function approvalEvidence(value, binding) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.status !== 'approved' || value.bindingDigest !== binding.digest || typeof value.approvalId !== 'string' || !value.approvalId) fail('beforeWrite must return an approved external binding attestation');
  return { status: value.status, bindingDigest: value.bindingDigest, approvalId: value.approvalId };
}

async function durableRecord(record, binding, approval) {
  if (typeof record !== 'function') fail('record callback is required for durable evidence');
  const receipt = await record({ kind: 'season-write-authorized', binding: clone(binding), approval: clone(approval) });
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) || receipt.durable !== true || receipt.bindingDigest !== binding.digest || typeof receipt.evidenceId !== 'string' || !receipt.evidenceId) fail('record must return durable evidence for the exact binding');
  return { durable: true, bindingDigest: receipt.bindingDigest, evidenceId: receipt.evidenceId };
}

async function installGuard(page, writeUrl, expected) {
  let posts = 0;
  let blocked = null;
  const context = page.context();
  const handler = async route => {
    const request = route.request();
    if (request.method() === 'GET' || request.method() === 'HEAD') return route.fallback();
    if (request.method() !== 'POST' || request.url() !== writeUrl || posts !== 0) {
      blocked = 'unexpected browser write';
      return route.abort();
    }
    try {
      const parsed = [...await new Response(request.postDataBuffer(), { headers: { 'content-type': request.headers()['content-type'] } }).formData()]
        .filter(([name]) => name !== 'csrfmiddlewaretoken').map(([name, value]) => [name, String(value)]);
      const normalized = parsed.map(([name, value]) => [name, normalizeWrite(name, value)]);
      if (!tuplesEqual(normalized, expected)) throw new Error('native season POST tuples differ from prepared form');
      posts += 1;
      return route.fallback();
    } catch (error) {
      blocked = String(error.message ?? error);
      return route.abort();
    }
  };
  let stage;
  const readOnly = route => {
    const method = route.request().method();
    return method === 'GET' || method === 'HEAD' ? route.fallback() : route.abort();
  };
  const guard = {
    get posts() { return posts; },
    get blocked() { return blocked; },
    seal() { blocked ??= 'season transport sealed'; },
    verify() { stage.verify(); },
    async close({ keepReadOnly = false } = {}) {
      await context.unroute('**/*', handler);
      if (keepReadOnly) await context.route('**/*', readOnly);
    }
  };
  try {
    stage = await installStageTransport(page, `season:${expected.find(([name]) => name === 'product_id')?.[1] ?? ''}:${sha256(expected)}`, async () => {
      await context.route('**/*', handler);
      return async () => { await guard.close(); };
    });
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }
  return guard;
}

export class UnknownSeasonOutcomeError extends Error {
  constructor(cause) {
    super('season save outcome is unknown; use readback and reconcile before any retry');
    this.name = 'UnknownSeasonOutcomeError';
    this.code = 'UNKNOWN_SEASON_OUTCOME';
    this.cause = cause;
  }
}

function methods({ origin: configuredOrigin, responseTimeoutMs = 25_000 } = {}) {
  if (configuredOrigin !== undefined && (typeof configuredOrigin !== 'string' || new URL(configuredOrigin).origin !== configuredOrigin)) fail('origin must be an origin URL when supplied');
  if (!Number.isSafeInteger(responseTimeoutMs) || responseTimeoutMs <= 0) fail('responseTimeoutMs must be a positive safe integer');
  const stagedReceipts = new Map();

  async function prepare(page, { target: rawTarget, plan: rawPlan, assertIdentity } = {}) {
    const target = productTarget(rawTarget), plan = normalizePlan(rawPlan);
    const origin = checkedOrigin(page, configuredOrigin);
    const identityDigest = await identity(assertIdentity, target, 'season-prepare');
    const before = await readList(page, target, origin);
    if (before.seasons.length) throw new Error('target product already has a season; duplicate creation is blocked');
    const seasonTab = page.locator('a[href="#season"]');
    if (await seasonTab.count() !== 1) throw new Error('native season tab is missing or ambiguous');
    await seasonTab.click();
    const add = page.locator('#add_season');
    if (await add.count() !== 1) throw new Error('native add season control is missing or ambiguous');
    await add.click();
    if (await page.locator('#season_frm #id_title').count() !== 1) throw new Error('native season form did not open');
    for (const [name, value] of Object.entries(plan.fields)) await setInput(page, name, value);
    for (const [name, value] of Object.entries(plan.selects)) await setSelect(page, name, value, plan.selectLabels[name], plan.selectQueries[name]);
    const selectedDates = await chooseDates(page, plan.selectedDates);
    const form = (await nativeForm(page)).map(([name, value]) => [name, normalizeWrite(name, value)]);
    const productValues = form.filter(([name]) => name === 'product_id').map(([, value]) => value);
    const idValues = form.filter(([name]) => name === 'id').map(([, value]) => value);
    if (!productValues.length || productValues.some(value => value !== target.productId) || !idValues.length || idValues.some(Boolean)) throw new Error('native season form target boundary changed');
    const binding = {
      version: 1,
      phase: 'season',
      target,
      origin,
      identityDigest,
      planDigest: sha256(plan),
      formDigest: sha256(form),
      baselineSeasonIds: before.seasons
    };
    binding.digest = sha256(binding);
    return {
      kind: 'season-prepared-v1', target, origin, plan, selectedDates, form,
      identityDigest, planDigest: binding.planDigest, formDigest: binding.formDigest,
      baselineSeasonIds: before.seasons, binding, state: 'prepared'
    };
  }

  async function save(page, prepared, { assertIdentity, beforeWrite, record } = {}) {
    const target = preparedShape(prepared);
    if (prepared.state !== 'prepared') throw new Error('season save was already attempted; reconciliation is required');
    const origin = checkedOrigin(page, prepared.origin);
    const initialIdentity = await identity(assertIdentity, target, 'season-save-prewrite');
    if (initialIdentity !== prepared.identityDigest) throw new Error('season identity changed before write');
    const initialForm = (await nativeForm(page)).map(([name, value]) => [name, normalizeWrite(name, value)]);
    if (!tuplesEqual(initialForm, prepared.form)) throw new Error('native season form changed after preparation');
    const initialList = await readList(page, target, origin);
    if (stable(initialList.seasons) !== stable(prepared.baselineSeasonIds)) throw new Error('season membership changed after preparation');
    if (typeof beforeWrite !== 'function') fail('beforeWrite callback is required; adapter does not create approvals');
    const approval = approvalEvidence(await beforeWrite({ binding: clone(prepared.binding), target: clone(target), prepared: clone(prepared) }), prepared.binding);
    const evidence = await durableRecord(record, prepared.binding, approval);
    const finalIdentity = await identity(assertIdentity, target, 'season-save-write');
    const finalForm = (await nativeForm(page)).map(([name, value]) => [name, normalizeWrite(name, value)]);
    const finalList = await readList(page, target, origin);
    if (checkedOrigin(page, prepared.origin) !== origin || finalIdentity !== prepared.identityDigest || !tuplesEqual(finalForm, prepared.form) || stable(finalList.seasons) !== stable(prepared.baselineSeasonIds)) throw new Error('season page, identity, form, or membership changed during authorization');
    const writeUrl = `${origin}${CREATE_PATH}`;
    const guard = await installGuard(page, writeUrl, prepared.form);
    let cause;
    try {
      const responsePromise = page.waitForResponse(response => response.request().method() === 'POST' && response.url() === writeUrl, { timeout: responseTimeoutMs });
      prepared.state = 'write-attempted';
      const saveControl = page.locator('#save-master-product');
      if (await saveControl.count() !== 1) throw new Error('native season save control is missing or ambiguous');
      await saveControl.click();
      const response = await responsePromise;
      if (response.status() < 200 || response.status() >= 300 || guard.posts !== 1 || guard.blocked) throw new Error('guarded native season POST was not accepted');
      const payload = await response.json();
      const seasonId = String(payload?.season_id ?? '');
      if (!PRODUCT_ID.test(seasonId)) throw new Error('native season response has no canonical season_id');
      prepared.state = 'receipt-issued';
      const receipt = { kind: 'season-save-receipt-v1', seasonId, target, origin, bindingDigest: prepared.binding.digest, planDigest: prepared.planDigest, formDigest: prepared.formDigest, form: clone(prepared.form), baselineSeasonIds: clone(prepared.baselineSeasonIds), guardedPosts: guard.posts, evidence };
      stagedReceipts.set(receipt.bindingDigest, guard);
      return receipt;
    } catch (error) {
      cause = error;
      prepared.state = 'needs-reconciliation';
      throw new UnknownSeasonOutcomeError(error);
    } finally {
      if (prepared.state === 'needs-reconciliation') await guard.close({ keepReadOnly: true });
      else if (prepared.state === 'receipt-issued') guard.seal();
    }
  }

  async function readback(page, { target: rawTarget, assertIdentity } = {}) {
    const target = productTarget(rawTarget), origin = checkedOrigin(page, configuredOrigin);
    const identityDigest = await identity(assertIdentity, target, 'season-readback');
    const list = await readList(page, target, origin);
    return { kind: 'season-readback-v1', target, origin, identityDigest, seasons: list.seasons, listUrl: list.url };
  }

  async function verifyReceipt(page, receipt, { target: rawTarget, plan: rawPlan, assertIdentity } = {}) {
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) || receipt.kind !== 'season-save-receipt-v1' || !PRODUCT_ID.test(receipt.seasonId ?? '')) fail('season receipt is invalid');
    const target = productTarget(rawTarget), plan = normalizePlan(rawPlan);
    if (stable(target) !== stable(receipt.target) || sha256(plan) !== receipt.planDigest) throw new Error('season receipt target or approved plan differs');
    if (!Array.isArray(receipt.form) || receipt.form.some(tuple => !Array.isArray(tuple) || tuple.length !== 2 || tuple.some(value => typeof value !== 'string')) || sha256(receipt.form) !== receipt.formDigest) throw new Error('season receipt native form is invalid or differs from its binding');
    if (!Array.isArray(receipt.baselineSeasonIds) || receipt.baselineSeasonIds.some(id => !PRODUCT_ID.test(id)) || new Set(receipt.baselineSeasonIds).size !== receipt.baselineSeasonIds.length || receipt.baselineSeasonIds.includes(receipt.seasonId)) fail('season receipt baseline membership is invalid');
    const origin = checkedOrigin(page, receipt.origin);
    const identityDigest = await identity(assertIdentity, target, 'season-verify-receipt');
    const list = await readList(page, target, origin);
    const baseline = new Set(receipt.baselineSeasonIds);
    const created = list.seasons.filter(id => !baseline.has(id));
    if (list.seasons.length !== receipt.baselineSeasonIds.length + 1 || receipt.baselineSeasonIds.some(id => !list.seasons.includes(id)) || created.length !== 1 || created[0] !== receipt.seasonId) throw new Error('season list membership is not exactly the baseline plus the receipt ID');
    const html = await fetchDocument(page, `${origin}${LIST_PATH}${receipt.seasonId}/change/`);
    const saved = await savedForm(page, html, receipt.seasonId);
    for (const [name] of Object.entries(plan.fields)) {
      const expected = receipt.form.find(([field]) => field === name)?.[1];
      if (expected === undefined || !Object.hasOwn(saved.fields, name) || normalizeRead(name, saved.fields[name]) !== normalizeRead(name, expected)) throw new Error(`saved native season field differs: ${name}`);
    }
    if (stable(saved.selectedDates) !== stable(plan.selectedDates)) throw new Error('saved selected_dates differ from actual approved calendar dates');
    for (const [name, value] of Object.entries(plan.selects)) if (saved.selects[name] !== value) throw new Error(`saved select data-init-id differs: ${name}`);
    const verification = { kind: 'season-receipt-verification-v1', seasonId: receipt.seasonId, target, identityDigest, saved: { productId: target.productId, seasonId: receipt.seasonId, fields: Object.fromEntries(Object.entries(saved.fields).map(([name, value]) => [name, normalizeRead(name, value)])), selects: saved.selects, selectedDates: saved.selectedDates }, listMembership: clone(list.seasons) };
    const stage = stagedReceipts.get(receipt.bindingDigest);
    if (stage) { stage.verify(); stagedReceipts.delete(receipt.bindingDigest); }
    return verification;
  }

  return { prepare, save, readback, verifyReceipt };
}

export function createSeasonAdapter(options) { return methods(options); }
const standalone = methods();
export const prepare = standalone.prepare;
export const save = standalone.save;
export const readback = standalone.readback;
export const verifyReceipt = standalone.verifyReceipt;
