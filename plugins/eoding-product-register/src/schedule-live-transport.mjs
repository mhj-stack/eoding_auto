import { installStageTransport } from './stage-transport.mjs';
import { requireScheduleSession } from './schedule-session.mjs';

const ORIGIN = 'https://basecamp.team';
const CREATE_PATH = '/tour/master_product_schedule/add/';
const guards = new WeakMap();
const MAX_BODY_BYTES = 256 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true });

function fail(message) { throw new Error(message); }

function exactObject(value, keys, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail(message);
}

function canonicalInteger(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) fail(`Invalid schedule ${name}`);
  return value;
}

function approval(value) {
  exactObject(value, ['productId', 'title', 'nights', 'days'], 'Invalid live schedule transport approval');
  if (typeof value.productId !== 'string' || !/^[1-9]\d{0,9}$/.test(value.productId)) fail('Invalid schedule product ID');
  if (typeof value.title !== 'string' || !value.title || value.title !== value.title.trim() || value.title.length > 20_000) fail('Invalid schedule title');
  const nights = canonicalInteger(value.nights, 'nights', 0, 365);
  const days = canonicalInteger(value.days, 'days', 1, 366);
  if (nights >= days) fail('Invalid schedule duration');
  return { productId: value.productId, title: value.title, nights, days };
}

function assertScheduleLocation(page, expected) {
  const url = new URL(page.url());
  const detail = `/tour/master_product/${expected.productId}/change/`;
  if (url.origin !== ORIGIN || url.username || url.password || url.pathname !== detail || url.search || (url.hash && url.hash !== '#schedule')) {
    fail('Live schedule transport requires the exact product detail URL');
  }
}

function multipartFields(request) {
  const headers = request.headers();
  const contentType = headers['content-type'] ?? '';
  const match = /^multipart\/form-data;\s*boundary=(?:"([^"]+)"|([^\s;]+))\s*$/i.exec(contentType);
  const body = request.postDataBuffer();
  if (!match || !body || body.length === 0 || body.length > MAX_BODY_BYTES) fail('Unexpected schedule create request');
  const boundary = `--${match[1] ?? match[2]}`;
  let text;
  try { text = utf8.decode(body); } catch { fail('Unexpected schedule create request'); }
  if (!text.endsWith(`${boundary}--\r\n`)) fail('Unexpected schedule create request');
  const pieces = text.split(boundary);
  if (pieces.shift() !== '' || pieces.pop() !== '--\r\n' || pieces.length !== 4) fail('Unexpected schedule create request');
  const fields = Object.create(null);
  for (const rawPiece of pieces) {
    const piece = rawPiece.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
    const split = piece.indexOf('\r\n\r\n');
    if (split < 0) fail('Unexpected schedule create request');
    const head = piece.slice(0, split);
    const value = piece.slice(split + 4).replace(/\r\n$/, '');
    const disposition = /^content-disposition:\s*form-data;\s*name="([^"]+)"\s*$/i.exec(head);
    if (!disposition || head.includes('\r\n') || /;\s*filename\*?=/i.test(head) || Object.hasOwn(fields, disposition[1])) fail('Unexpected schedule create request');
    fields[disposition[1]] = value;
  }
  return fields;
}

function exactFields(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    fail('Unexpected schedule create request');
  }
}

function assertExactCreate(request, page, expected) {
  if (request.frame() !== page.mainFrame() || request.method() !== 'POST' || request.url() !== ORIGIN + CREATE_PATH) fail('Unexpected schedule create request');
  const fields = multipartFields(request);
  exactFields(fields, ['title', 'day', 'night', 'product']);
  if (fields.title !== expected.title || fields.day !== String(expected.days) || fields.night !== String(expected.nights) || fields.product !== expected.productId) {
    fail('Unexpected schedule create request');
  }
}

async function armResponseRedirectBarrier(page) {
  try {
    const session = await page.context().newCDPSession(page);
    session.on('Fetch.requestPaused', async event => {
      try {
        const redirect = event.responseStatusCode >= 300 && event.responseStatusCode < 400;
        if (redirect && !['GET', 'HEAD'].includes(event.request.method)) await session.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' });
        else await session.send('Fetch.continueRequest', { requestId: event.requestId });
      } catch {
        await page.context().close().catch(() => {});
      }
    });
    await session.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Response' }] });
    return session;
  } catch {
    await page.context().close().catch(() => {});
    fail('Live schedule redirect barrier installation failed');
  }
}

export async function installLiveScheduleTransportGuard(page, inputApproval) {
  const expected = approval(inputApproval);
  requireScheduleSession(page);
  assertScheduleLocation(page, expected);
  const context = page.context();
  if (guards.has(context)) fail('Live schedule transport guard already installed for this context');

  const state = { armed: false, sealed: true, permanent: false, consumed: false, forwarded: 0 };
  const forwarded = new WeakSet();
  let stage;
  const guard = {
    verify() { stage.verify(); },
    arm() {
      requireScheduleSession(page);
      assertScheduleLocation(page, expected);
      if (state.permanent || state.armed) fail('Live schedule transport guard cannot be rearmed');
      state.armed = true;
      state.sealed = false;
    },
    seal() { state.sealed = true; state.permanent = true; },
    get count() { return state.forwarded; }
  };
  const deny = route => { guard.seal(); return route.abort('blockedbyclient'); };
  const handler = async route => {
    const request = route.request();
    if (forwarded.has(request)) return route.fallback();
    let url;
    try { url = new URL(request.url()); } catch { return route.abort('blockedbyclient'); }
    const safeRead = request.method() === 'GET' || request.method() === 'HEAD';
    const isCreatePath = url.pathname === CREATE_PATH;
    if (safeRead) {
      if (isCreatePath) return deny(route);
      return route.fallback();
    }
    if (url.origin !== ORIGIN) return route.abort('blockedbyclient');
    if (state.sealed || state.consumed || !state.armed) return deny(route);
    // Consume before parsing the request body or yielding to another route.
    state.consumed = true;
    try {
      requireScheduleSession(page);
      assertScheduleLocation(page, expected);
      assertExactCreate(request, page, expected);
    }
    catch { return deny(route); }
    state.forwarded++;
    forwarded.add(request);
    return route.fallback();
  };

  guards.set(context, guard);
  try {
    stage = await installStageTransport(page, `shell:${expected.productId}`, async () => {
      await context.route('**/*', handler);
      await page.route('**/*', handler);
      const barrier = await armResponseRedirectBarrier(page);
      return async () => { guard.seal(); await page.unroute('**/*', handler); await context.unroute('**/*', handler); await barrier.detach(); };
    });
  } catch {
    guard.seal();
    await context.close().catch(() => {});
    fail('Live schedule transport guard installation failed');
  }
  return guard;
}
