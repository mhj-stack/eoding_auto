import path from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { homedir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, open, lstat, realpath, unlink } from 'node:fs/promises';
import { digest } from './core.mjs';
import { readSource } from './source.mjs';
import { collectWorkbookEvidence, workbookSourceLabel } from './workbook-evidence.mjs';
import { validateProductImport } from './product-import-scope.mjs';
import { ScheduleSessionBrowser } from './schedule-session.mjs';
import { ERP_URL } from './browser.mjs';
import { readProductOnlyIdentity, startProductOnlyLauncher, validateProductOnlyLaunchPlan } from './product-only-launcher.mjs';
import { createProductOnlyAdapters } from './product-only-adapters.mjs';
import { readPublicImage, imageMime } from './plugin-image.mjs';

const copy = value => structuredClone(value);
const fail = message => { throw new Error(message); };
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const editable = new Set(['source-ready', 'needs-input', 'ready-for-review']);
const forbidden = () => fail('검증 단계에서는 저장할 수 없습니다.');
const pendingIdentity = { accountName: 'pending-login', accountKey: 'pending-login', sessionKey: 'pending-login' };

async function writeJson(file, value, exclusive = false) {
  const temporary = exclusive ? file : file + '.' + randomUUID() + '.tmp';
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync(); } finally { await handle.close(); }
  if (!exclusive) await rename(temporary, file);
}

function publicOutcome(result) {
  const target = result.finalCheck?.result?.target;
  return {
    status: result.status, finalCheck: result.finalCheck?.status,
    target, productUrl: target?.productId ? `https://basecamp.team/tour/master_product/${target.productId}/change/` : null,
    phases: result.phases?.map(phase => ({ name: phase.name, status: phase.verification ? 'verified' : 'unverified' })), timing: result.timing,
    budget: result.budget
  };
}

function executionProgress(events = []) {
  const evidence = events.filter(event => event.kind === 'coordinator-evidence').map(event => event.value);
  const verified = evidence.filter(event => event.status === 'receipt-verified');
  const basic = verified.find(event => event.phase === 'basic')?.result?.receipt;
  const target = basic ? { productId: basic.productId, masterCode: basic.masterCode } : null;
  return {
    verifiedPhases: verified.map(event => event.phase),
    currentPhase: evidence.at(-1)?.phase ?? null, target,
    productUrl: target ? 'https://basecamp.team/tour/master_product/' + target.productId + '/change/' : null
  };
}

/** AI-independent workflow. The existing local human review owns the only write claim. */
export class ProductImportPlugin {
  constructor({ dataDir, inputDir, browser, readers = {}, identityReader = readProductOnlyIdentity, launch = startProductOnlyLauncher, launchOptions = {} } = {}) {
    if (!dataDir?.trim()) fail('EODING_DATA_DIR을 지정하세요.');
    this.root = path.resolve(dataDir);
    if (this.root === path.parse(this.root).root || this.root === homedir() || this.root.startsWith('\\\\')) fail('전용 로컬 작업 폴더가 필요합니다.');
    this.inputDir = path.resolve(inputDir ?? path.join(this.root, 'input'));
    this.browser = browser ?? new ScheduleSessionBrowser({ dataDir: path.join(this.root, 'plugin-browser') });
    this.readers = readers; this.identityReader = identityReader; this.launch = launch; this.launchOptions = launchOptions;
    this.active = null; this.busy = false; this.lock = null; this.reviews = new Set();
  }

  async init() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if ((await lstat(this.root)).isSymbolicLink()) fail('작업 폴더는 링크일 수 없습니다.');
    for (const name of ['.git', 'package.json']) if (await lstat(path.join(this.root, name)).catch(() => null)) fail('작업자료는 코드 폴더와 분리하세요.');
    if (!this.lock) {
      const lockPath = path.join(this.root, 'plugin-owner.json');
      try { this.lock = await open(lockPath, 'wx', 0o600); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const owner = JSON.parse(await readFile(lockPath, 'utf8'));
        if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) fail('작업 잠금 확인이 필요합니다.');
        let alive = true;
        try { process.kill(owner.pid, 0); } catch (cause) { if (cause.code === 'ESRCH') alive = false; }
        if (alive) fail('다른 AI가 이 작업 폴더를 사용 중입니다. 기존 연결에서 product_import_close를 호출하세요.');
        await unlink(lockPath);
        this.lock = await open(lockPath, 'wx', 0o600);
      }
      await this.lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })); await this.lock.sync();
    }
    await mkdir(path.join(this.root, 'import-jobs'), { recursive: true, mode: 0o700 });
    await mkdir(this.inputDir, { recursive: true, mode: 0o700 });
  }

  async exclusive(fn) {
    if (this.busy) fail('현재 작업을 처리 중입니다. 순서대로 호출하세요.');
    this.busy = true;
    try { await this.init(); return await fn(); } finally { this.busy = false; }
  }
  directory(id) { if (!idPattern.test(id)) fail('잘못된 작업번호입니다.'); return path.join(this.root, 'import-jobs', id); }
  async load(id) {
    const dir = this.directory(id), stat = await lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('작업 경로를 확인하세요.');
    const file = path.join(dir, 'job.json');
    if ((await lstat(file)).isSymbolicLink()) fail('작업 파일은 링크일 수 없습니다.');
    const job = JSON.parse(await readFile(file, 'utf8'));
    if (job.id !== id || job.sourceDigest !== digest(job.source)) fail('작업 원문이 변경됐습니다.');
    return job;
  }
  async save(job) { job.updatedAt = new Date().toISOString(); await writeJson(path.join(this.directory(job.id), 'job.json'), job); }

  async source({ url, filePath, text, seasonMode } = {}) {
    return this.exclusive(async () => {
      if (!['excluded', 'included'].includes(seasonMode)) fail('시즌 포함/제외 범위를 먼저 정하세요.');
      if ([url, filePath, text].filter(value => value !== undefined).length !== 1) fail('URL, 엑셀, 상품 원문 텍스트 중 하나만 전달하세요.');
      let source;
      if (url !== undefined) source = { kind: 'url', label: url, evidence: await (this.readers.readSource ?? readSource)(url) };
      else if (filePath !== undefined) source = { kind: 'excel', label: await workbookSourceLabel(filePath, this.inputDir), evidence: await collectWorkbookEvidence(filePath, { inputDir: this.inputDir, reader: this.readers.readWorkbook }) };
      else {
        if (typeof text !== 'string' || !text.trim() || text.length > 200000) fail('원문 텍스트는 1~200,000자여야 합니다.');
        source = { kind: 'text', label: '사용자 제공 상품자료', evidence: { untrusted: true, text, coverage: 'user-provided-text' } };
      }
      const id = randomUUID(), capturedAt = new Date().toISOString();
      const job = { version: 1, id, createdAt: capturedAt, status: 'source-ready', seasonMode, source, sourceDigest: digest(source), sourceDescriptor: { id: 'source-' + id, kind: source.kind, reference: source.label, capturedAt }, images: [], draft: null };
      await mkdir(this.directory(id), { mode: 0o700 });
      await writeJson(path.join(this.directory(id), 'job.json'), job, true);
      return this.get({ id, includeSource: true });
    });
  }

  async image({ id, filePath, url, alt } = {}) {
    return this.exclusive(async () => {
      const job = await this.load(id);
      if (!editable.has(job.status)) fail('검토 중이거나 실행된 작업의 이미지는 변경할 수 없습니다.');
      if (typeof alt !== 'string' || !alt.trim() || alt.length > 1000) fail('이미지 설명이 필요합니다.');
      if (Boolean(filePath) === Boolean(url)) fail('로컬 이미지 경로 또는 공개 이미지 URL 하나만 지정하세요.');
      let bytes, mimeType, sourceUrl;
      if (url) ({ bytes, mimeType, sourceUrl } = await (this.readers.readImage ?? readPublicImage)(url));
      else {
        const root = await realpath(this.inputDir), resolved = await realpath(path.resolve(filePath));
        const relative = path.relative(root, resolved);
        if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) fail('이미지는 EODING_INPUT_DIR 안에 있어야 합니다.');
        const stat = await lstat(resolved);
        if (!stat.isFile() || stat.size < 1 || stat.size > 2_000_000) fail('이미지는 2MB 이하의 파일이어야 합니다.');
        bytes = await readFile(resolved); mimeType = imageMime(bytes);
      }
      if (!Buffer.isBuffer(bytes) || bytes.length > 2_000_000 || imageMime(bytes) !== mimeType) fail('이미지 형식/크기를 확인하세요.');
      const sha256 = createHash('sha256').update(bytes).digest('hex'), imageId = 'image-' + sha256.slice(0, 24);
      const duplicate = job.images.find(item => item.sha256 === sha256);
      if (duplicate) return duplicate;
      if (job.images.length >= 20) fail('상품당 최대 20개 이미지를 지원합니다.');
      const name = imageId + ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' })[mimeType];
      const image = { id: imageId, name, path: path.join(this.directory(id), name), mimeType, sha256, alt, ...(sourceUrl ? { sourceUrl } : {}) };
      await writeFile(image.path, bytes, { flag: 'wx', mode: 0o600 });
      job.images.push(image); job.status = 'source-ready'; job.validation = null;
      await this.save(job); return image;
    });
  }

  assemble(job, observed = { companyId: '1', identity: pendingIdentity }) {
    const { product, registration } = job.draft;
    const plan = {
      ...copy(registration), target: { mode: 'NEW' }, product: copy(product), ...copy(observed),
      source: { digest: job.sourceDigest, rows: product.itinerary.map(day => ({ id: 'day-' + day.day, sourceId: job.sourceDescriptor.id, day: day.day })), images: copy(job.images) },
      itinerary: product.itinerary.map(day => ({ ...copy(day), sourceRowId: 'day-' + day.day })),
      seasonMode: job.seasonMode
    };
    return validateProductOnlyLaunchPlan(plan);
  }

  validate(job) {
    const questions = [];
    const source = validateProductImport({ product: job.draft.product, seasonMode: job.seasonMode });
    questions.push(...source.errors.map(error => ({ field: error.field, message: error.message })));
    try {
      const plan = this.assemble(job);
      const adapters = createProductOnlyAdapters({ plan, identity: forbidden, authorizeWrite: forbidden, record: forbidden, loadImage: forbidden, verifyUploadedImage: forbidden });
      for (const name of ['basic', 'media', 'shell', 'day', 'season']) {
        if (!adapters[name]) continue;
        const check = adapters[name].preflight(plan);
        questions.push(...check.blockers.map(message => ({ field: name, message })));
      }
    } catch (error) { questions.push({ field: 'registration', message: error.message }); }
    const unique = [...new Map(questions.map(question => [JSON.stringify(question), question])).values()];
    return { readyForReview: unique.length === 0, questions: unique, erpVerified: false, imageCount: job.images.length };
  }

  async prepare({ id, product, registration } = {}) {
    return this.exclusive(async () => {
      const job = await this.load(id);
      if (!editable.has(job.status)) fail('이미 검토를 시작한 작업입니다. 작업 상태를 먼저 확인하세요.');
      if (!registration || typeof registration !== 'object' || Array.isArray(registration) || Object.keys(registration).some(key => !['basic', 'display', 'content', 'shell', 'season'].includes(key))) fail('registration은 basic/display/content/shell/season만 받습니다.');
      if (!Array.isArray(product?.sources) || !product.sources.some(item => same(item, job.sourceDescriptor))) fail('반환된 sourceDescriptor를 product.sources에 그대로 포함하세요.');
      if (job.seasonMode === 'excluded' && Object.hasOwn(registration, 'season')) fail('시즌 제외 작업에는 season을 전달하지 마세요.');
      job.draft = { product: copy(product), registration: copy(registration) };
      job.validation = this.validate(job); job.status = job.validation.readyForReview ? 'ready-for-review' : 'needs-input';
      await this.save(job); return this.get({ id });
    });
  }

  async openBrowser() {
    return this.exclusive(async () => {
      if (this.active) fail('열린 검토/실행을 먼저 완료하세요.');
      return this.browser.open();
    });
  }
  async context() {
    return this.exclusive(async () => {
      if (this.active) fail('등록 검토 중에는 브라우저를 변경할 수 없습니다.');
      const page = await this.browser.ensurePage();
      const observed = await this.identityReader(page);
      return { companyId: observed.companyId, accountName: observed.identity.accountName, url: page.url(), notice: '회사명과 담당자/도시의 실제 선택값을 확인하세요. 인증 쿠키는 반환하지 않습니다.' };
    });
  }

  async review({ id } = {}) {
    return this.exclusive(async () => {
      if (this.active) fail('다른 등록 검토가 열려 있습니다.');
      const job = await this.load(id);
      if (job.status !== 'ready-for-review') fail('등록 준비를 완료하고 작업 상태를 확인하세요.');
      const page = await this.browser.ensurePage(), observed = await this.identityReader(page);
      const plan = this.assemble(job, observed);
      const planPath = path.join(this.directory(id), 'approved-plan.json');
      await writeJson(planPath, plan, true);
      job.status = 'opening-review'; await this.save(job);
      const ownedBrowser = { open: async () => {
        const owned = await this.browser.ensurePage();
        await owned.goto(ERP_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
        return { page: owned, close: async () => {} };
      } };
      let launcher;
      try {
        launcher = await this.launch({ ...this.launchOptions, plan, planPath, dataDir: path.join(this.directory(id), 'run'), browser: ownedBrowser });
      } catch (error) {
        job.status = 'review-preparation-failed'; job.failure = { message: error.message, erpWriteStarted: false };
        await this.save(job); throw error;
      }
      job.status = 'awaiting-approval'; job.planDigest = plan.approvalBinding.planDigest;
      const active = { id, launcher, done: null }; this.active = active; this.reviews.add(launcher);
      active.done = launcher.completed.then(async result => {
        job.status = result.status; job.result = publicOutcome(result); await this.save(job);
      }, async error => {
        const claimed = launcher.writes.some(event => event.kind === 'approval-claim');
        job.status = claimed ? 'needs-reconciliation' : 'cancelled';
        job.failure = { message: error.message, erpWriteStarted: claimed, progress: executionProgress(launcher.writes) }; await this.save(job);
      }).finally(async () => {
        if (this.active === active) {
          await this.browser.close();
          this.active = null;
        }
      });
      // A failure to persist a terminal state must remain observable, never become success.
      active.done.catch(error => { active.persistenceError = error.message; });
      try { await this.save(job); } catch (error) { await launcher.close(); await active.done.catch(() => {}); throw error; }
      return { id, status: job.status, reviewUrl: launcher.url, requiresHumanApproval: true, scope: ['basic', 'display', 'content', 'shell', 'days', ...(job.seasonMode === 'included' ? ['season'] : [])] };
    });
  }

  async get({ id, includeSource = false } = {}) {
    const job = await this.load(id);
    let status = job.status;
    if (this.active?.id === id) {
      if (this.active.launcher.writes.some(event => event.kind === 'approval-claim')) status = 'running';
      if (this.active.persistenceError) status = 'needs-reconciliation';
    } else if (['opening-review', 'awaiting-approval'].includes(status)) status = 'interrupted-needs-reconciliation';
    return { id, status, progress: this.active?.id === id ? executionProgress(this.active.launcher.writes) : job.failure?.progress ?? null, seasonMode: job.seasonMode, sourceDescriptor: job.sourceDescriptor, sourceDigest: job.sourceDigest, images: copy(job.images), validation: job.validation ?? null, result: job.result ?? null, failure: job.failure ?? null, ...(includeSource ? { source: copy(job.source), draft: copy(job.draft) } : {}) };
  }

  async close() {
    if (this.busy) fail('진행 중인 호출이 끝난 뒤 종료하세요.');
    const active = this.active;
    for (const review of this.reviews) await review.close();
    this.reviews.clear();
    if (active) await active.done;
    await this.browser.close();
    if (this.lock) { await this.lock.close(); this.lock = null; await unlink(path.join(this.root, 'plugin-owner.json')); }
    return { status: 'closed' };
  }
}
