import { requireScheduleSession } from './schedule-session.mjs';
import { installStageTransport } from './stage-transport.mjs';

const ORIGIN = 'https://basecamp.team';
const MAX_BODY_BYTES = 256 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true });

function fail(message) { throw new Error(message); }

function canonicalId(value) {
  if (typeof value !== 'string' || !/^[1-9]\d{0,9}$/.test(value)) fail('Invalid departure product ID');
  return value;
}

function cloneEntries(value) {
  if (!Array.isArray(value)) fail('Invalid departure transport entries');
  let copy;
  try { copy = structuredClone(value); } catch { fail('Invalid departure transport entries'); }
  for (const entry of copy) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || typeof entry[1] !== 'string'
      || !entry[0] || /[\r\n\0]/.test(entry[0])) fail('Invalid departure transport entries');
  }
  return copy;
}

function values(entries, name) { return entries.filter(([key]) => key === name).map(([, value]) => value); }

function validateExpected(productId, entries) {
  const masters = values(entries, 'master_product_id');
  if (!masters.length || masters.some(value => value !== productId)) fail('Departure entries must bind the master product');
  if (values(entries, 'status').length !== 1 || values(entries, 'status')[0] !== '4') fail('Departure entries must set closed status');
  const schedules = values(entries, 'schedule');
  if (schedules.length !== 1 || schedules[0] !== canonicalId(schedules[0])) fail('Departure entries must bind one saved schedule');
  const dates = values(entries, 'selected_dates');
  if (dates.length !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test(dates[0])) fail('Departure entries must bind one selected date');
  if (values(entries, 'currency_code').length !== 1 || values(entries, 'currency_code')[0] !== 'KRW') fail('Departure entries must bind KRW');
}

function expectedCounts(entries) {
  const counts = new Map();
  for (const [name, value] of entries) {
    const key = `${name}\0${value}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function parseMultipart(request) {
  const contentType = request.headers()['content-type'] ?? '';
  const match = /^multipart\/form-data;\s*boundary=(?:"([^"\r\n]+)"|([^\s;\r\n]+))\s*$/i.exec(contentType);
  const body = request.postDataBuffer();
  if (!match || !body || body.length < 1 || body.length > MAX_BODY_BYTES) fail('Unexpected departure create request');
  let text;
  try { text = utf8.decode(body); } catch { fail('Unexpected departure create request'); }
  const boundary = `--${match[1] ?? match[2]}`;
  if (!text.startsWith(`${boundary}\r\n`) || !text.endsWith(`${boundary}--\r\n`)) fail('Unexpected departure create request');
  const rawParts = text.slice(boundary.length + 2, -(boundary.length + 6)).split(`\r\n${boundary}\r\n`);
  if (!rawParts.length || rawParts.some(part => !part)) fail('Unexpected departure create request');
  return rawParts.map(part => {
    const split = part.indexOf('\r\n\r\n');
    if (split < 1) fail('Unexpected departure create request');
    const head = part.slice(0, split);
    const value = part.slice(split + 4);
    const disposition = /^content-disposition:\s*form-data;\s*name="([^"\r\n]+)"\s*$/i.exec(head);
    if (!disposition || /filename\*?\s*=/i.test(head) || head.includes('\r\n') || /[\r\n\0]/.test(disposition[1])) fail('Unexpected departure create request');
    return [disposition[1], value];
  });
}

function assertExactCreate(request, page, expectedUrl, counts) {
  if (request.frame() !== page.mainFrame() || request.method() !== 'POST' || request.url() !== expectedUrl) fail('Unexpected departure create request');
  const received = expectedCounts(parseMultipart(request));
  if (received.size !== counts.size) fail('Unexpected departure create request');
  for (const [key, count] of counts) if (received.get(key) !== count) fail('Unexpected departure create request');
}

async function installRedirectBarrier(page) {
  try {
    const session = await page.context().newCDPSession(page);
    session.on('Fetch.requestPaused', async event => {
      try {
        const redirect = event.responseStatusCode >= 300 && event.responseStatusCode < 400;
        if (redirect && !['GET', 'HEAD'].includes(event.request.method)) await session.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' });
        else await session.send('Fetch.continueRequest', { requestId: event.requestId });
      } catch { await page.context().close().catch(() => {}); }
    });
    await session.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Response' }] });
    return session;
  } catch {
    await page.context().close().catch(() => {});
    fail('Departure transport redirect barrier installation failed');
  }
}

export async function installDepartureTransportGuard(page, input) {
  // Clone/validate before the first await so caller-owned input cannot race installation.
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 2 || !Object.hasOwn(input, 'productId') || !Object.hasOwn(input, 'entries')) fail('Invalid departure transport input');
  const productId = canonicalId(input.productId);
  const entries = cloneEntries(input.entries);
  validateExpected(productId, entries);
  const expectedUrl = `${ORIGIN}/tour/master_product/${productId}/create_product/?from=${productId}`;
  const expectedCreateUrl = `${ORIGIN}/tour/master_product/${productId}/create_product/`;
  requireScheduleSession(page);
  if (page.url() !== expectedUrl) fail('Departure transport requires the exact event create URL');
  const context = page.context();
  let stage;

  const state = { armed: false, sealed: true, permanent: false, consumed: false, forwarded: 0 };
  const forwarded = new WeakSet();
  const guard = {
    verify() { if (state.forwarded !== 1) fail('Departure transport is not verified'); stage.verify(); },
    arm() {
      requireScheduleSession(page);
      if (page.url() !== expectedUrl) fail('Departure transport requires the exact event create URL');
      if (state.permanent || state.armed) fail('Departure transport guard cannot be rearmed');
      state.armed = true; state.sealed = false;
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
    if (safeRead) return route.fallback();
    // Block unrelated analytics/widgets without consuming or sealing the ERP write.
    if (url.origin !== ORIGIN) return route.abort('blockedbyclient');
    if (state.sealed || state.consumed || !state.armed) return deny(route);
    // Set this before parsing or yielding: exactly one request can ever pass.
    state.consumed = true;
    try {
      requireScheduleSession(page);
      if (page.url() !== expectedUrl) fail('Unexpected departure create request');
      assertExactCreate(request, page, expectedCreateUrl, expectedCounts(entries));
    } catch { return deny(route); }
    state.forwarded++;
    forwarded.add(request);
    return route.fallback();
  };

  try {
    const key=`departure:${productId}:${values(entries,'schedule')[0]}:${values(entries,'selected_dates')[0]}`;
    stage=await installStageTransport(page,key,async()=>{
      await context.route('**/*', handler);
      await page.route('**/*', handler);
      const barrier=await installRedirectBarrier(page);
      return async()=>{guard.seal();await page.unroute('**/*',handler);await context.unroute('**/*',handler);await barrier.detach();};
    });
  } catch {
    guard.seal();
    await context.close().catch(() => {});
    fail('Departure transport guard installation failed');
  }
  return guard;
}
