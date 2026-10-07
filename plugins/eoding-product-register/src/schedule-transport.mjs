import { armScheduleRedirectBarrier } from './schedule-redirect-barrier.mjs';

const ORIGIN = 'https://schedule-fixture.invalid';
const POST_PATH = '/tour/master_product_schedule/add/';

const contextGuards = new WeakMap();

function fail(message) { throw new Error(message); }

function exactObject(value, keys, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail(message);
}

function exactText(value, name) {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 20_000) fail(`Invalid ${name}`);
  return value;
}

function canonicalInteger(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) fail(`Invalid ${name}`);
  return value;
}

function approval(value) {
  exactObject(value, ['title', 'nights', 'days', 'productId'], 'Invalid schedule transport approval');
  const title = exactText(value.title, 'schedule title');
  const nights = canonicalInteger(value.nights, 'schedule nights', 0, 365);
  const days = canonicalInteger(value.days, 'schedule days', 1, 366);
  const productId = typeof value.productId === 'string' && /^[1-9]\d{0,9}$/.test(value.productId)
    ? value.productId : fail('Invalid schedule product ID');
  if (nights >= days) fail('Invalid schedule duration');
  return { title, nights, days, productId };
}

function assertFixturePage(page) {
  const url = new URL(page.url());
  if (url.origin !== ORIGIN || url.username || url.password) fail('Schedule transport requires the reserved synthetic fixture');
}

function multipartFields(request) {
  const type = request.headers()['content-type'] ?? '';
  const match = /^multipart\/form-data;\s*boundary=(.+)$/i.exec(type);
  if (!match) fail('Unexpected schedule create request');
  const body = request.postDataBuffer()?.toString('utf8');
  if (!body) fail('Unexpected schedule create request');
  const boundary = `--${match[1].replace(/^"|"$/g, '')}`;
  const fields = Object.create(null);
  for (const piece of body.split(boundary).slice(1, -1)) {
    const part = piece.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
    const split = part.indexOf('\r\n\r\n');
    if (split < 0) fail('Unexpected schedule create request');
    const name = /(?:^|\r\n)content-disposition:\s*form-data;\s*name="([^"]+)"\s*$/im.exec(part.slice(0, split))?.[1];
    const value = part.slice(split + 4).replace(/\r\n$/, '');
    if (!name || Object.hasOwn(fields, name)) fail('Unexpected schedule create request');
    fields[name] = value;
  }
  return fields;
}

/** Throws without returning multipart data when this request differs from approval. */
export function assertExactScheduleCreateRequest(request, page, inputApproval) {
  const expected = approval(inputApproval);
  if (request.frame() !== page.mainFrame() || request.method() !== 'POST' || request.url() !== ORIGIN + POST_PATH) fail('Unexpected schedule create request');
  const fields = multipartFields(request);
  exactObject(fields, ['title', 'day', 'night', 'product'], 'Unexpected schedule create request');
  if (fields.title !== expected.title || fields.day !== String(expected.days)
    || fields.night !== String(expected.nights) || fields.product !== expected.productId) fail('Unexpected schedule create request');
}

/**
 * Fixture-only, one-way route gate. It is installed on both the page and its
 * context because page routes take precedence while context routes cover
 * sibling pages and frames. GET/HEAD reads fall through. Every other request
 * is denied except one exact approved main-frame multipart POST.
 *
 * The gate controls requests routed by Playwright before the synthetic server
 * handler. Browser-internal HTTP redirect replays after route.fallback() may
 * bypass Playwright page/context routes on this platform; this does not claim
 * server-side exactly-once semantics and redirecting POST responses remain an
 * UNKNOWN_SAVE_OUTCOME requiring reconciliation.
 *
 * A guarded context is intentionally single-use. seal() permanently removes
 * its unused allowance but keeps both deny routes installed; a future task
 * must use a fresh isolated context.
 */
export async function installScheduleTransportGuard(page, inputApproval) {
  const expected = approval(inputApproval);
  assertFixturePage(page);
  const context = page.context();
  if (contextGuards.has(context)) fail('Schedule transport guard already installed for this context');

  const forwarded = new WeakSet();
  // The allowance starts sealed; it opens only after routes and response barrier arm.
  const state = { consumed: false, sealed: true, armed: false, permanentlySealed: false };
  const guard = {
    arm() {
      if (state.permanentlySealed || state.armed) fail('Schedule transport guard cannot be rearmed');
      state.armed = true;
      state.sealed = false;
    },
    seal() { state.sealed = true; state.permanentlySealed = true; },
    getState() { return { consumed: state.consumed, sealed: state.sealed, armed: state.armed }; }
  };
  const handler = async route => {
    const request = route.request();
    if (forwarded.has(request)) return route.fallback();
    const url = new URL(request.url());
    // The create endpoint is never a read: reject its wrong origin/query/method too.
    if (url.pathname === POST_PATH && (request.method() !== 'POST' || request.url() !== ORIGIN + POST_PATH)) {
      guard.seal();
      return route.abort('blockedbyclient');
    }
    if (request.method() === 'GET' || request.method() === 'HEAD') return route.fallback();
    if (state.sealed || state.consumed) { guard.seal(); return route.abort('blockedbyclient'); }
    try {
      assertExactScheduleCreateRequest(request, page, expected);
    } catch {
      // An unsafe mismatch poisons the one-way attempt rather than leaving a retry allowance.
      guard.seal();
      return route.abort('blockedbyclient');
    }
    // Consume before awaiting fallback: no competing route can get another pass.
    state.consumed = true;
    forwarded.add(request);
    return route.fallback();
  };

  contextGuards.set(context, guard);
  try {
    await context.route('**/*', handler);
    await page.route('**/*', handler);
    await armScheduleRedirectBarrier(page);
  } catch {
    // Setup failures leave every installed deny route sealed; barrier also closes its context.
    state.sealed = true;
    throw new Error('Schedule transport guard installation failed');
  }
  return guard;
}
