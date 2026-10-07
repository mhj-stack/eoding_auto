import { ALLOWED_ORIGIN, ERP_URL } from './browser.mjs';
import { readBasicForm } from './basic-form.mjs';

const ADD_PATH = '/tour/master_product/add/';
const TIMEOUT = 10_000;
const fail = message => { throw new Error(message); };

function expectedSettings(product) {
  if (!product || product.currency !== 'KRW' || !['domestic', 'overseas'].includes(product.tripType) || typeof product.includesFlight !== 'boolean' || !['included', 'excluded'].includes(product.company?.vat)) fail('지원하지 않는 상품 생성 설정');
  return Object.freeze({
    trip: product.tripType === 'domestic' ? '국내상품' : '해외상품',
    flight: product.includesFlight ? '항공포함' : '항공미포함',
    vat: product.company.vat === 'included' ? '부가세 포함' : '부가세 미포함',
    currency: 'KRW'
  });
}

async function exactlyOne(locator, description) {
  if (await locator.count() !== 1) fail('생성 설정이 모호합니다: ' + description);
  return locator;
}

async function creationState(page, modal) {
  const selected = {};
  for (const [key, labels] of Object.entries({ trip: ['국내상품', '해외상품'], flight: ['항공포함', '항공미포함'], vat: ['부가세 포함', '부가세 미포함'] })) {
    const checked = [];
    for (const label of labels) {
      const radio = await exactlyOne(modal.getByRole('radio', { name: label, exact: true, includeHidden: true }), key + ':' + label);
      if (await radio.isChecked()) checked.push(label);
    }
    if (checked.length !== 1) fail('생성 설정이 모호합니다: ' + key);
    selected[key] = checked[0];
  }
  const currency = modal.locator('input.select-dropdown.dropdown-trigger');
  const currencyCount = await currency.count();
  if (currencyCount > 1) fail('생성 설정이 모호합니다: 통화');
  // The observed production modal can omit this presentation-only control. Its
  // value is then deferred to the exact immutable evidence on the blank add form.
  selected.currency = currencyCount === 1 ? await currency.inputValue() : null;
  const link = await exactlyOne(modal.getByRole('link', { name: '상품생성', exact: true }), '상품생성 연결');
  const href = await link.getAttribute('href');
  if (!href) fail('예상하지 못한 상품생성 연결 대상');
  const target = new URL(href, page.url());
  if (target.origin !== ALLOWED_ORIGIN || target.pathname !== ADD_PATH) fail('예상하지 못한 상품생성 연결 대상');
  return { selected, link, href: target.href };
}

async function assertDeferredKrwCurrency(page, state) {
  if (state.settings?.currency !== 'KRW' || state.settingsDisabled?.currency !== true) fail('신규 화면 설정 불일치: currency');
  const exactHiddenKrw = await page.evaluate(() => {
    const prefix = document.querySelector('#id_1-title') ? '1' : '2';
    const controls = document.querySelectorAll(`#id_${prefix}-currency[name="${prefix}-currency"][type="hidden"]`);
    return controls.length === 1 && controls[0].value === '1';
  });
  if (!exactHiddenKrw) fail('신규 화면 통화 고정값 불일치');
}

async function assertInitialNewForm(page, state, expected, deferredCurrency) {
  const url = new URL(state.url);
  if (url.origin !== ALLOWED_ORIGIN || url.pathname !== ADD_PATH || !state.documentTitle.includes('상품추가')) fail('신규 상품추가 화면이 아닙니다');
  for (const key of ['title', 'masterCode', 'masterURL']) if (state[key] !== '') fail('기존 상품이 채워진 신규 입력 화면입니다: ' + key);
  const basicSettings = {
    currency: expected.currency,
    includesFlight: expected.flight,
    tripType: expected.trip === '국내상품' ? '국내' : '해외',
    vat: expected.vat
  };
  for (const [key, value] of Object.entries(basicSettings)) {
    if (state.settings?.[key] !== value || state.settingsDisabled?.[key] !== true) fail('신규 화면 설정 불일치: ' + key);
  }
  if (deferredCurrency) await assertDeferredKrwCurrency(page, state);
}

/**
 * Opens the verified blank product-add form after the caller has already claimed
 * its single parent approval. beforeOpen is the caller's last pre-click guard.
 */
export async function openProductCreationForm(page, product, { beforeOpen } = {}) {
  if (!page || typeof page.url !== 'function') throw new TypeError('Playwright page가 필요합니다');
  if (typeof beforeOpen !== 'function') throw new TypeError('beforeOpen 사전 검증 콜백이 필요합니다');
  if (page.url() !== ERP_URL) fail('상품관리 목록의 정확한 시작 URL이 아닙니다');
  const expected = expectedSettings(product);
  const modal = page.locator('#modal');
  if (await modal.count() !== 1) fail('상품관리 생성 창을 확인할 수 없습니다');
  if (await modal.isVisible()) fail('이미 열린 생성 창이 있습니다. 내용을 검토한 뒤 직접 닫으세요');

  const open = await exactlyOne(page.getByRole('button', { name: '상품 생성', exact: true }), '상품 생성 버튼');
  await open.click({ timeout: TIMEOUT });
  await modal.waitFor({ state: 'visible', timeout: TIMEOUT });
  for (const label of [expected.trip, expected.flight, expected.vat]) {
    const choice = await exactlyOne(modal.getByText(label, { exact: true }), label);
    await choice.click({ timeout: TIMEOUT });
    const radio = await exactlyOne(modal.getByRole('radio', { name: label, exact: true, includeHidden: true }), label);
    if (!await radio.isChecked()) fail('설정 선택 실패: ' + label);
  }

  const state = await creationState(page, modal);
  for (const [key, value] of Object.entries(expected)) if (key !== 'currency' && state.selected[key] !== value || key === 'currency' && state.selected[key] !== null && state.selected[key] !== value) fail('생성 설정 불일치: ' + key);
  await beforeOpen();
  if (page.url() !== ERP_URL) fail('상품관리 목록의 정확한 시작 URL이 아닙니다');
  const current = await creationState(page, modal);
  for (const [key, value] of Object.entries(expected)) if (key !== 'currency' && current.selected[key] !== value || key === 'currency' && current.selected[key] !== null && current.selected[key] !== value) fail('생성 설정 불일치: ' + key);
  if (current.selected.currency !== state.selected.currency) fail('생성 설정 통화 제어가 변경되었습니다');
  if (current.href !== state.href) fail('상품생성 연결 대상이 변경되었습니다');
  await current.link.click({ timeout: TIMEOUT });
  await page.waitForURL(url => url.origin === ALLOWED_ORIGIN && url.pathname === ADD_PATH, { timeout: TIMEOUT });
  await page.locator(product.includesFlight ? '#id_1-title' : '#id_2-title').waitFor({ state: 'visible', timeout: TIMEOUT });
  const initial = await readBasicForm(page);
  await assertInitialNewForm(page, initial, expected, state.selected.currency === null);
  return { status: 'new-form-opened', url: page.url(), settings: { ...state.selected, currency: expected.currency }, state: initial };
}
