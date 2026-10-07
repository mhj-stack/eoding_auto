import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { EodingBrowser } from './browser.mjs';

const pageProvenance = new WeakMap();
const contextProvenance = new WeakMap();

function fail(message) { throw new Error(message); }

function assertPrivateDataDir(dataDir) {
  if (typeof dataDir !== 'string' || !dataDir.trim()) fail('Schedule session requires an explicit nonempty dataDir');
  const resolved = path.resolve(dataDir);
  if (resolved === path.parse(resolved).root || resolved === homedir() || resolved.startsWith(String.fromCharCode(92, 92))
    || existsSync(path.join(resolved, 'package.json')) || existsSync(path.join(resolved, '.git'))) {
    fail('Schedule session dataDir must be a dedicated private folder');
  }
  return resolved;
}

export class ScheduleSessionBrowser extends EodingBrowser {
  constructor(options = {}) {
    const dataDir = assertPrivateDataDir(options.dataDir);
    super({ ...options, dataDir });
    this.dataDir = dataDir;
    this._scheduleSession = null;
  }

  async ensurePage() {
    if (this.page && !this.page.isClosed()) return this.page;
    if (this.context) await this.context.close().catch(() => {});
    this.context = null;
    this.page = null;
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    await writeFile(path.join(this.dataDir, '.gitignore'), '*\n!.gitignore\n', { flag: 'wx', mode: 0o600 }).catch(error => {
      if (error.code !== 'EEXIST') throw error;
    });
    const context = await this.launcher.launchPersistentContext(path.join(this.dataDir, 'browser-profile'), {
      headless: false, acceptDownloads: false, viewport: { width: 1360, height: 960 }, serviceWorkers: 'block'
    });
    context.setDefaultTimeout(10000);
    const pages = context.pages();
    if (pages.length > 1) {
      await context.close().catch(() => {});
      fail('Schedule session must launch with exactly one page');
    }
    const page = pages[0] || await context.newPage();
    const identity = randomUUID();
    const state = { context, page, contextId: identity, closed: false };
    contextProvenance.set(context, state);
    pageProvenance.set(page, state);
    context.once('close', () => { state.closed = true; });
    page.once('close', () => { if (!state.closed) state.pageClosed = true; });
    page.on('dialog', dialog => dialog.dismiss().catch(() => {}));
    this.context = context;
    this.page = page;
    this._scheduleSession = state;
    return page;
  }

  async close() {
    const state = this._scheduleSession;
    if (state) state.closed = true;
    this._scheduleSession = null;
    return super.close();
  }
}

export function requireScheduleSession(page) {
  const state = pageProvenance.get(page);
  if (!state) fail('Schedule transport requires a dedicated owned session page');
  if (state.closed || state.pageClosed || page.isClosed?.()) fail('Schedule transport session is stale or closed');
  if (page.context() !== state.context || contextProvenance.get(state.context) !== state) fail('Schedule transport requires a dedicated owned session page');
  const pages = state.context.pages();
  if (pages.length !== 1 || pages[0] !== page) fail('Schedule transport session requires exactly one page');
  return { contextId: state.contextId };
}
