import { canonical } from './core.mjs';
// Basic-form adapter only. Approval, state hashing, and reconciliation belong to the caller.
const TIMEOUT = 10_000;
const FIELDS = Object.freeze({ title: '#id_2-title', priority: '#id_2-sort', status: '#id_2-status', masterCode: '#id_2-master_code', masterURL: '#id_2-master_url', cutoffDays: '#id_2-reservation_available_date', cityValue: '#id_2-city', managerValue: '#id_2-manager' });
const DEFAULTS = Object.freeze({ onlineCancellation: '#id_res_cancel_use_flag', immediateBooking: '#id_2-guest_immediate_booking_type', departureConfirmation: '#id_2-departure_confirm_criteria' });
const LABELS = Object.freeze({ currency: '통화기준', includesFlight: '속성', tripType: '국내/해외', vat: '판매금액 설정' });
const fail = message => { throw new Error(message); };
const same = (a, b) => canonical(a) === canonical(b);

async function hydrateExistingDetailSelect2(page) {
  const url = new URL(page.url());
  if (url.origin !== 'https://basecamp.team' || !/^\/tour\/master_product\/[1-9]\d{0,9}\/change\/$/.test(url.pathname) || !await page.title().then(title => title.includes('상품상세'))) return;
  await page.waitForFunction(() => {
    const prefix = document.querySelector('#id_1-title') ? '1' : '2';
    return ['city', 'manager'].every(key => {
      const selects = document.querySelectorAll(`#id_${prefix}-${key}`);
      const labels = document.querySelectorAll(`#select2-id_${prefix}-${key}-container`);
      return selects.length === 1 && labels.length === 1 && selects[0].tagName === 'SELECT' && !selects[0].multiple && !!selects[0].value && !!labels[0].textContent.trim();
    });
  }, undefined, { timeout: TIMEOUT });
}

/** Safe, deterministic allowlisted snapshot; never serializes the entire form or DOM. */
export async function readBasicForm(page) {
  await hydrateExistingDetailSelect2(page);
  return page.evaluate(({ fields, defaults, labels }) => {
    const flightPrefix=document.querySelectorAll('#id_1-title').length>0;
    if(flightPrefix&&document.querySelectorAll('#id_2-title').length)throw Error('Mixed basic form prefix');
    const prefix=flightPrefix?'1':'2';
    if(flightPrefix){fields=Object.fromEntries(Object.entries(fields).map(([k,v])=>[k,v.replace('id_2-','id_1-')]));defaults=Object.fromEntries(Object.entries(defaults).map(([k,v])=>[k,v.replace('id_2-','id_1-')]));}
    const one = selector => {
      const nodes = document.querySelectorAll(selector);
      if (nodes.length > 1) throw new Error('Ambiguous field: ' + selector);
      const node = nodes[0];
      if (node && (node.type === 'password' || !['INPUT', 'SELECT', 'TEXTAREA'].includes(node.tagName))) throw new Error('Unexpected field type: ' + selector);
      return node ?? null;
    };
    const values = Object.fromEntries(Object.entries(fields).map(([key, selector]) => [key, one(selector)?.value ?? null]));
    const selected = selector => {
      const nodes = document.querySelectorAll(selector);
      if (nodes.length > 1) throw new Error('Ambiguous selection: ' + selector);
      const el = nodes[0];
      return el ? (el.getAttribute('title') || el.textContent || '').trim() : null;
    };
    const settings = {}, settingsDisabled = {};
    for (const [key, text] of Object.entries(labels)) {
      const matches = [...document.querySelectorAll('label')].filter(el => el.textContent.trim() === text);
      if (matches.length > 1) throw new Error('Ambiguous setting: ' + text);
      const label = matches[0];
      const siblingInputs = label?.parentElement ? [...label.parentElement.querySelectorAll(':scope > input')] : [];
      const directDisplays = siblingInputs.filter(input => input.type === 'text');
      // Observed ERP controls identify their exact containing control through label[for].
      let input = null;
      if (label?.htmlFor) {
        const containerId = label.htmlFor + '_container';
        const containers = [...document.querySelectorAll('div.control')].filter(control => control.id === containerId);
        if (containers.length > 1) throw new Error('Ambiguous setting container: ' + text);
        const container = containers[0];
        if (!container) throw new Error('Missing observed setting container: ' + text);
        if (container) {
          if (!container.contains(label)) throw new Error('Setting label is outside observed container: ' + text);
          if (directDisplays.length) throw new Error('Ambiguous setting display input: ' + text);
          const formItems = [...container.querySelectorAll(':scope > .form_item')];
          if (formItems.length > 1) throw new Error('Ambiguous setting display input: ' + text);
          const displayInputs = formItems[0] ? [...formItems[0].querySelectorAll(':scope > input[type="text"]')] : [];
          if (displayInputs.length > 1) throw new Error('Ambiguous setting display input: ' + text);
          input = displayInputs[0] ?? null;
        }
      } else {
        // Legacy fixtures keep a single display input as a direct sibling of the label.
        if (siblingInputs.some(input => input.type === 'password')) throw new Error('Unexpected setting type');
        if (directDisplays.length > 1) throw new Error('Ambiguous setting display input: ' + text);
        input = directDisplays[0] ?? null;
      }
      if (input?.type === 'password') throw new Error('Unexpected setting type');
      settings[key] = input?.value ?? null;
      settingsDisabled[key] = input ? input.disabled : null;
    }
    if(flightPrefix&&settings.includesFlight!=='항공포함')throw Error('Flight basic prefix settings mismatch');
    const observedUnavailableImmediateBooking = () => {
      const isAdd = (prefix === '1' || prefix === '2' && settings.includesFlight === '항공미포함') && location.pathname === '/tour/master_product/add/' && document.title.includes('상품추가');
      const isDetail = (prefix === '1' || prefix === '2' && settings.includesFlight === '항공미포함') && document.title.includes('상품상세');
      if (!isAdd && !isDetail) return null;
      const oneSelect = selector => {
        const nodes = document.querySelectorAll(selector);
        return nodes.length === 1 && nodes[0].tagName === 'SELECT' && !nodes[0].multiple;
      };
      const paymentIds = { receipt: '#id_res_receipt_flag', wait: '#id_wait_payment_flag', part: '#id_part_payment_flag', over: '#id_over_payment_flag' };
      const payments = {};
      for (const [key, selector] of Object.entries(paymentIds)) {
        const nodes = document.querySelectorAll(selector);
        if (nodes.length !== 1 || nodes[0].tagName !== 'INPUT' || nodes[0].type !== 'checkbox' || nodes[0].value !== 'on') return null;
        payments[key] = { checked: nodes[0].checked, disabled: nodes[0].disabled };
      }
      const signature = Object.values(payments).map(payment => payment.checked ? '1' : '0').join('');
      if (!['0000', '1000', '1111'].includes(signature)) return null;
      if (isAdd && !Object.values(payments).every(payment => payment.disabled)) return null;
      if (isDetail && new Set(Object.values(payments).map(payment => payment.disabled)).size !== 1) return null;
      if (!oneSelect('#id_res_cancel_use_flag') || !oneSelect(`#id_${prefix}-departure_confirm_criteria`)) return null;
      return { availability: 'unavailable', payments };
    };
    const unavailableImmediateBooking = observedUnavailableImmediateBooking();
    const defaultValues = Object.fromEntries(Object.entries(defaults).map(([key, selector]) => {
      const input = one(selector);
      if (!input && key === 'immediateBooking' && unavailableImmediateBooking) return [key, unavailableImmediateBooking];
      if (!input) throw new Error('Missing mandatory behavior control: ' + key);
      if (input.tagName !== 'SELECT' || input.multiple) throw new Error('Unexpected behavior control type: ' + key);
      return [key, { value: input.value, type: input.type }];
    }));
    return { url: location.href, documentTitle: document.title, ...values,
      cityLabel: selected(`#select2-id_${prefix}-city-container`), managerLabel: selected(`#select2-id_${prefix}-manager-container`),
      settings, settingsDisabled, defaults: defaultValues };
  }, { fields: FIELDS, defaults: DEFAULTS, labels: LABELS });
}

function assertNew(state) {
  const url = new URL(state.url);
  if (url.protocol !== 'https:' || url.hostname !== 'basecamp.team' || url.port || !/^\/tour\/master_product\/add\/?$/.test(url.pathname)) fail('Not the verified new-product add URL');
  if (!state.documentTitle.includes('상품추가')) fail('Not the 상품추가 page');
  for (const key of ['title', 'masterCode', 'masterURL']) if (state[key] !== '') fail('Not a blank unsaved form: ' + key);
  assertControls(state);
  if (!['1', '2'].includes(state.status)) fail('Unexpected public/sales status');
}
function assertControls(state) {
  for (const key of ['title', 'priority', 'status', 'masterCode', 'masterURL', 'cutoffDays', 'cityLabel', 'managerLabel']) if (state[key] === null || state[key] === undefined) fail('Missing control: ' + key);
  for (const [key, value] of Object.entries(state.settings)) if (!value || state.settingsDisabled[key] !== true) fail('Missing or editable immutable setting: ' + key);
  for (const key of ['onlineCancellation', 'departureConfirmation']) {
    const value = state.defaults?.[key];
    if (!value) fail('Missing mandatory behavior control: ' + key);
    if (value.type !== 'select-one' || value.value !== '0') fail('Unexpected public/online/sales behavior: ' + key);
  }
  const immediateBooking = state.defaults?.immediateBooking;
  if (!immediateBooking) fail('Missing mandatory behavior control: immediateBooking');
  if (immediateBooking.availability === 'unavailable') return;
  if (immediateBooking.type !== 'select-one' || immediateBooking.value !== '0') fail('Unexpected public/online/sales behavior: immediateBooking');
}
function validateInputs(product, options) {
  if (!product || typeof product.title !== 'string' || !product.title.trim() || product.title !== product.title.trim() || product.title.length > 20000) fail('Invalid product title');
  if (product.currency !== 'KRW' || !['domestic', 'overseas'].includes(product.tripType) || typeof product.includesFlight !== 'boolean' || !['included', 'excluded'].includes(product.company?.vat)) fail('Invalid or unsupported product settings');
  for (const key of ['priority', 'cutoffDays']) if (!Number.isInteger(options?.[key]) || options[key] < 1 || options[key] > 999) fail('Invalid ' + key + ': expected integer 1..999');
  for (const key of ['cityLabel', 'managerLabel']) if (typeof options?.[key] !== 'string' || !options[key].trim() || options[key] !== options[key].trim()) fail('Invalid exact ' + key);
  return { currency: product.currency, includesFlight: product.includesFlight ? '항공포함' : '항공미포함', tripType: product.tripType === 'domestic' ? '국내' : '해외', vat: product.company.vat === 'included' ? '부가세 포함' : '부가세 미포함' };
}
async function uniqueVisible(locator, description) {
  const visible = locator.filter({ visible: true });
  await visible.first().waitFor({ state: 'visible', timeout: TIMEOUT });
  if (await visible.count() !== 1) fail('Ambiguous ' + description);
  return visible;
}
async function chooseSelect2(page, key, label, prefix='2') {
  const control = await uniqueVisible(page.locator(`[aria-labelledby='select2-id_${prefix}-${key}-container']`), key + ' control');
  await control.click({ timeout: TIMEOUT });
  const search = await uniqueVisible(page.locator('input.select2-search__field:not([tabindex="-1"])'), key + ' search');
  // ERP search indexes names, while the rendered option also includes code/department.
  const query=label.replace(/\s*\([^()]*\)\s*$/, '').trim() || label;
  await search.fill(query, { timeout: TIMEOUT });
  const option = await uniqueVisible(page.getByRole('treeitem', { name: label, exact: true }), key + ' option');
  await option.click({ timeout: TIMEOUT });
  const selected = await readBasicForm(page);
  if (selected[key + 'Label'] !== label) fail('Selection did not stick: ' + key);
}

/** Fill only a blank add form. Never submits or alters defaults/immutable settings. */
export async function fillNewBasic(page, product, options) {
  const settings = validateInputs(product, options);
  const before = await readBasicForm(page);
  assertNew(before);
  if (!same(before.settings, settings)) fail('Immutable settings do not match product');
  const prefix=await page.locator('#id_1-title').count()===1?'1':'2';
  const fields=Object.fromEntries(Object.entries(FIELDS).map(([k,v])=>[k,v.replace('id_2-',`id_${prefix}-`)]));
  // Materialize's status dropdown must be operated through its visible UI.
  const statusUI = await uniqueVisible(page.locator(fields.status).locator('..').locator('input.select-dropdown.dropdown-trigger'), 'status control');
  await statusUI.click({ timeout: TIMEOUT });
  const privateOption = await uniqueVisible(page.getByRole('listitem').filter({ hasText: /^\s*비공개\s*$/ }), 'private status option');
  await privateOption.click({ timeout: TIMEOUT });
  if (await page.locator(fields.status).inputValue() !== '2') fail('Private status was not accepted');
  await page.locator(fields.priority).fill(String(options.priority), { timeout: TIMEOUT });
  await page.locator(fields.title).fill(product.title, { timeout: TIMEOUT });
  await page.locator(fields.cutoffDays).fill(String(options.cutoffDays), { timeout: TIMEOUT });
  await chooseSelect2(page, 'city', options.cityLabel, prefix);
  await chooseSelect2(page, 'manager', options.managerLabel, prefix);
  const after = await readBasicForm(page);
  assertControls(after);
  if (after.url !== before.url || after.documentTitle !== before.documentTitle || after.masterCode !== '' || after.masterURL !== '') fail('Unexpected navigation or saved record while filling');
  if (after.title !== product.title || after.status !== '2' || after.priority !== String(options.priority) || after.cutoffDays !== String(options.cutoffDays) || after.cityLabel !== options.cityLabel || after.managerLabel !== options.managerLabel) fail('Filled values were not accepted');
  for (const key of ['settings', 'settingsDisabled', 'defaults']) if (!same(after[key], before[key])) fail('Unrequested fields changed: ' + key);
  return after;
}

/** Read-only reconciliation; never saves, never changes approval state. */
export async function reconcileBasicPersisted(page, product, input, context, target) {
  const settings = validateInputs(product, input?.options);
  if (!target || Object.keys(target).sort().join(',') !== 'masterCode,productId' || typeof target.productId !== 'string' || !/^[1-9]\d{0,9}$/.test(target.productId) || typeof target.masterCode !== 'string' || !target.masterCode.trim() || typeof context?.assertIdentity !== 'function') fail('Invalid basic recovery target/context');
  if (new URL(page.url()).origin !== 'https://basecamp.team') fail('Wrong basic recovery origin');
  const url = `https://basecamp.team/tour/master_product/${target.productId}/change/`;
  const guard = route => ['GET', 'HEAD'].includes(route.request().method()) ? route.fallback() : route.abort();
  const owner = page.context();
  await owner.route('**/*', guard);
  try {
    const read = async () => {
      if (page.url() !== url) fail('Basic recovery URL mismatch');
      await page.waitForFunction(() => {
        const p = document.querySelector('#id_1-title') ? '1' : '2';
        return ['city','manager'].every(k => document.querySelector(`#id_${p}-${k}`)?.value && document.querySelector(`#select2-id_${p}-${k}-container`)?.textContent?.trim());
      }, {}, { timeout: TIMEOUT });
      await context.assertIdentity();
      const state = await readBasicForm(page);
      assertControls(state);
      const expected = { title: product.title, status: '2', priority: String(input.options.priority), cutoffDays: String(input.options.cutoffDays), cityLabel: input.options.cityLabel, managerLabel: input.options.managerLabel, masterCode: target.masterCode, settings };
      for (const [key, value] of Object.entries(expected)) if (!same(state[key], value)) fail('Basic recovery mismatch: ' + key);
      const master = new URL(state.masterURL);
      if (master.protocol !== 'https:' || master.username || master.password || master.search || master.hash || master.pathname.replace(/\/$/, '') !== `/master/${target.productId}` || !state.documentTitle.includes('상품상세')) fail('Basic recovery assigned identity mismatch');
      return state;
    };
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const first = await read();
    await page.reload({ waitUntil: 'domcontentloaded' });
    const second = await read();
    if (!same(first, second)) fail('Basic recovery independent readback mismatch');
    return { ...second, productId: target.productId };
  } finally { await owner.unroute('**/*', guard); }
}

const VERIFIED_KEYS = ['title', 'status', 'priority', 'cutoffDays', 'cityLabel', 'managerLabel', 'cityValue', 'managerValue', 'settings', 'settingsDisabled', 'defaults'];
function assertExpected(state, expected, afterSave = false) {
  assertControls(state);
  for (const key of VERIFIED_KEYS) {
    let wanted = expected[key];
    if (afterSave && key === 'defaults' && expected.defaults?.immediateBooking?.availability === 'unavailable' && state.defaults?.immediateBooking?.availability === 'unavailable') {
      wanted = structuredClone(wanted);
      const payments = wanted.immediateBooking.payments;
      if (payments && ['receipt','wait','part','over'].every(name => payments[name]?.disabled === true && payments[name]?.checked === false && state.defaults.immediateBooking.payments?.[name]?.disabled === false)) {
        for (const value of Object.values(payments)) value.disabled = false;
      }
    }
    if (!same(state[key], wanted)) fail('Verification mismatch: ' + key);
  }
}

/** Caller must consume approval and compare its hash BEFORE invoking this method.
 * Any error after the sole save click has code UNKNOWN_SAVE_OUTCOME; never retry it.
 * expected is the exact readBasicForm/fillNewBasic return value reviewed by the user.
 */
export async function clickSaveAndVerify(page, expected) {
  if (!expected || expected.status !== '2' || !expected.title?.trim() || expected.masterCode !== '' || expected.masterURL !== '') fail('Invalid expected unsaved private form');
  assertNew({ ...expected, title: '' });
  assertControls(expected);
  for (const key of ['priority', 'cutoffDays']) if (!/^[1-9]\d{0,2}$/.test(expected[key])) fail('Invalid expected ' + key);
  if (!expected.cityLabel?.trim() || !expected.managerLabel?.trim()) fail('Missing expected selection');
  const current = await readBasicForm(page);
  if (!same(current, expected)) fail('Form changed since approval');
  assertExpected(current, expected);
  const save = await uniqueVisible(page.getByRole('button', { name: '저장', exact: true }), 'save button');
  try {
    // Single invocation only, including when click/response/navigation times out.
    await save.click({ timeout: TIMEOUT });
    const message = await uniqueVisible(page.getByText('상품 생성이 완료되었습니다', { exact: true }), 'success message');
    // Prefer a dialog. Generic notifications must have the observed 알림 heading
    // and confirmation in a bounded ancestor, never the surrounding page/form.
    const dialogs = page.getByRole('dialog').filter({ has: message }).filter({ visible: true });
    if (await dialogs.count() > 1) fail('Ambiguous success popup');
    let popup;
    if (await dialogs.count() === 1) popup = dialogs;
    else {
      let candidate = message;
      for (let depth = 0; depth < 6; depth++) {
        candidate = candidate.locator('..');
        if (await candidate.evaluate(el => ['BODY', 'HTML'].includes(el.tagName)) || await candidate.locator('input, select, textarea').count() || await candidate.getByRole('button', { name: '저장', exact: true }).count()) break;
        if (await candidate.getByText('알림', { exact: true }).count() === 1 && await candidate.getByRole('link', { name: '확인', exact: true }).count()) { popup = candidate; break; }
      }
    }
    if (!popup || await popup.evaluate(el => ['BODY', 'HTML'].includes(el.tagName)) || await popup.locator('input, select, textarea').count() || await popup.getByRole('button', { name: '저장', exact: true }).count()) fail('Success message is not in a distinct popup');
    const confirm = await uniqueVisible(popup.getByRole('link', { name: '확인', exact: true }), 'success confirmation');
    await confirm.click({ timeout: TIMEOUT });
    await page.waitForFunction(selector => document.title.includes('상품상세') && !!document.querySelector(selector)?.value, expected.settings.includesFlight === '항공포함' ? '#id_1-master_url' : '#id_2-master_url', { timeout: TIMEOUT });
    const result = await readBasicForm(page);
    if (new URL(result.url).origin !== new URL(expected.url).origin) fail('Unexpected post-save origin');
    assertExpected(result, expected, true);
    if (!result.masterCode?.trim()) fail('Missing assigned master code');
    const master = new URL(result.masterURL);
    const match = /^\/master\/(\d+)\/?$/.exec(master.pathname);
    if (master.protocol !== 'https:' || master.username || master.password || !match) fail('Unexpected assigned master URL');
    return { ...result, productId: match[1] };
  } catch (cause) {
    const error = new Error('Unknown save outcome; reconcile ERP before any retry: ' + cause.message, { cause });
    error.code = 'UNKNOWN_SAVE_OUTCOME';
    throw error;
  }
}
