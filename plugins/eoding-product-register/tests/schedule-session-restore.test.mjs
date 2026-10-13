import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { ScheduleSessionBrowser, requireScheduleSession } from '../src/schedule-session.mjs';

async function temporaryRoot(t) {
  const base = path.resolve(os.tmpdir());
  const root = await mkdtemp(path.join(base, 'eoding-session-restore-'));
  t.after(async () => {
    const relative = path.relative(base, path.resolve(root));
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    assert.ok(path.basename(root).startsWith('eoding-session-restore-'));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

function fakeLauncher(pageCount = 1) {
  const calls = [], listeners = new Map();
  let closed = false;
  const context = {
    setDefaultTimeout() {},
    pages: () => closed ? [] : pages,
    newPage: async () => { const page = makePage(); pages.push(page); return page; },
    once: (name, fn) => listeners.set(name, fn),
    close: async () => { closed = true; listeners.get('close')?.(); }
  };
  const makePage = () => ({ context: () => context, isClosed: () => closed, on() {}, once() {} });
  const pages = Array.from({ length: pageCount }, makePage);
  return { calls, context, get closed() { return closed; }, launchPersistentContext: async (profile, options) => {
    calls.push({ profile, options });
    return context;
  } };
}

test('session restore is opt-in and leaves default browser launch settings unchanged', async t => {
  const root = await temporaryRoot(t);
  for (const restoreSession of [undefined, false, true]) {
    const launcher = fakeLauncher();
    const browser = new ScheduleSessionBrowser({ dataDir: root, launcher, ...(restoreSession === undefined ? {} : { restoreSession }) });
    const page = await browser.ensurePage();
    assert.ok(requireScheduleSession(page).contextId);
    assert.equal(launcher.calls[0].profile, path.join(root, 'browser-profile'));
    assert.deepEqual(launcher.calls[0].options, {
      headless: false, acceptDownloads: false, viewport: { width: 1360, height: 960 }, serviceWorkers: 'block',
      ...(restoreSession ? { args: ['--restore-last-session'], ignoreDefaultArgs: ['about:blank'] } : {})
    });
    await browser.close();
    assert.throws(() => requireScheduleSession(page), /stale or closed/);
  }
  assert.throws(() => new ScheduleSessionBrowser({ dataDir: root, restoreSession: 'true' }), /explicit boolean/);
});

test('restoring does not accept multiple pages or relax page ownership', async t => {
  const root = await temporaryRoot(t);
  const launcher = fakeLauncher(2);
  const browser = new ScheduleSessionBrowser({ dataDir: root, launcher, restoreSession: true });
  await assert.rejects(browser.ensurePage(), /exactly one page/);
  assert.equal(launcher.closed, true);
  assert.equal(browser.context, null);
  assert.equal(browser.page, null);
  assert.throws(() => requireScheduleSession({}), /dedicated owned session page/);
});

async function fixtureServer(t) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    res.setHeader('Cache-Control', 'no-store');
    if (req.url === '/login') {
      // Deliberately session-only: no Expires or Max-Age. This value exists only
      // in the isolated fixture; browser cookies/storage are never exported.
      res.setHeader('Set-Cookie', 'fixture_session=fixture-only; HttpOnly; SameSite=Lax; Path=/');
      res.writeHead(200, { 'Content-Type': 'text/html' }).end('Fixture login set');
    } else if (req.url === '/authenticated') {
      const authenticated = req.headers.cookie?.split(';').some(value => value.trim() === 'fixture_session=fixture-only');
      res.writeHead(authenticated ? 200 : 401, { 'Content-Type': 'text/html' }).end(authenticated ? 'Authenticated fixture' : 'Unauthenticated fixture');
    } else res.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const setOnline = async online => {
    if (online && !server.listening) await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
    if (!online && server.listening) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
  };
  t.after(() => setOnline(false));
  return { origin: `http://127.0.0.1:${port}`, requests, setOnline };
}

for (const [restoreSession, offlineRestore] of [[false, false], [true, false], [true, true]]) test(`Chromium ${restoreSession ? 'restores' : 'does not restore'} a session-only fixture login${offlineRestore ? ' after an offline startup' : ''} without exporting authentication state`, { timeout: 60000 }, async t => {
  const root = await temporaryRoot(t), { origin, requests, setOnline } = await fixtureServer(t);
  const contexts = [], launches = [];
  const launcher = { launchPersistentContext: async (profile, options) => {
    launches.push({ profile, options });
    // Use the full Chromium build with a hidden window; headless-shell does not
    // exercise the same profile/session restoration path as the real browser.
    const context = await chromium.launchPersistentContext(profile, {
      ...options, channel: 'chromium', headless: true,
      ...(offlineRestore && launches.length === 2 ? { offline: true } : {}),
      args: [...(options.args ?? []), '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']
    });
    contexts.push(context);
    return context;
  } };
  t.after(async () => { for (const context of contexts) await context.close().catch(() => {}); });
  const first = new ScheduleSessionBrowser({ dataDir: root, launcher });
  const page = await first.ensurePage();
  const originalContextId = requireScheduleSession(page).contextId;
  await page.goto(origin + '/login');
  assert.equal((await page.goto(origin + '/authenticated')).status(), 200);
  await first.close();
  assert.throws(() => requireScheduleSession(page), /stale or closed/);
  // Chromium can restore a tab before Playwright applies offline emulation.
  // Make the fixture itself unavailable during startup to model a real outage,
  // then bring it back while the reopened context is still explicitly offline.
  if (offlineRestore) await setOnline(false);
  const requestsBeforeRestore = requests.length;

  const reopened = new ScheduleSessionBrowser({ dataDir: root, launcher, restoreSession });
  const restoredPage = await reopened.ensurePage();
  assert.equal(restoredPage.context().pages().length, 1);
  assert.notEqual(requireScheduleSession(restoredPage).contextId, originalContextId);
  assert.deepEqual(launches.map(item => item.profile), [path.join(root, 'browser-profile'), path.join(root, 'browser-profile')]);
  if (offlineRestore) {
    await setOnline(true);
    assert.equal(requests.length, requestsBeforeRestore, 'restored startup cannot reach the fixture server while offline: ' + JSON.stringify(requests.slice(requestsBeforeRestore)));
    await restoredPage.context().route('**/*', route => ['GET', 'HEAD'].includes(route.request().method()) ? route.fallback() : route.abort());
    await restoredPage.context().setOffline(false);
  }
  const response = await restoredPage.goto(origin + '/authenticated');
  assert.equal(response.status(), restoreSession ? 200 : 401);
  assert.equal(await restoredPage.textContent('body'), restoreSession ? 'Authenticated fixture' : 'Unauthenticated fixture');
  await assert.rejects(reopened.assertERP(restoredPage), /어딩 도메인이 아닙니다/);
  const extra = await restoredPage.context().newPage();
  assert.throws(() => requireScheduleSession(restoredPage), /exactly one page/);
  assert.throws(() => requireScheduleSession(extra), /dedicated owned session page/);
  await extra.close();
  assert.ok(requireScheduleSession(restoredPage).contextId);
  await reopened.close();
});
