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
import { chromium } from 'playwright';
import { flightPreflight, sourceQuality, workflowTiming, changeWait } from './plugin-workflow.mjs';
import { scopeFor } from './product-only-review.mjs';
import { resumeCheckpoint } from './plugin-resume.mjs';
import { erpLookup, LOOKUP_KINDS } from './erp-lookup.mjs';

const copy = value => structuredClone(value);
const fail = message => { throw new Error(message); };
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const editableStatuses = new Set(['source-ready', 'needs-input', 'ready-for-review']);
// A review that failed before any ERP write (no plan claim, no run journal) can be corrected in place.
const retryableReview = job => job.status === 'review-preparation-failed' && job.failure?.erpWriteStarted === false && job.failure?.retryable === true;
const editable = { has: (status, job) => editableStatuses.has(status) || (job !== undefined && retryableReview(job)) };
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
    departure: result.finalCheck?.result?.departure ?? null,
    phases: result.phases?.map(phase => ({ name: phase.name, status: phase.verification ? 'verified' : 'unverified', durationMs: phase.durationMs })), timing: result.timing,
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

/** The localhost review owns every write claim, including explicitly delegated submissions. */
export class ProductImportPlugin {
  constructor({ dataDir, inputDir, browser, readers = {}, identityReader = readProductOnlyIdentity, launch = startProductOnlyLauncher, launchOptions = {}, approvalBrowserLauncher = chromium } = {}) {
    if (!dataDir?.trim()) fail('EODING_DATA_DIR을 지정하세요.');
    this.root = path.resolve(dataDir);
    if (this.root === path.parse(this.root).root || this.root === homedir() || this.root.startsWith('\\\\')) fail('전용 로컬 작업 폴더가 필요합니다.');
    this.inputDir = path.resolve(inputDir ?? path.join(this.root, 'input'));
    this.browser = browser ?? new ScheduleSessionBrowser({ dataDir: path.join(this.root, 'plugin-browser') });
    this.readers = readers; this.identityReader = identityReader; this.launch = launch; this.launchOptions = launchOptions;
    this.active = null; this.busy = false; this.lock = null; this.reviews = new Set();
    this.approvalBrowserLauncher = approvalBrowserLauncher; this.approvalClients = new Set(); this.approvalTasks = new Set();
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
      const startedAt = new Date().toISOString();
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
      const job = { version: 1, id, createdAt: capturedAt, startedAt, waits: [], status: 'source-ready', seasonMode, source, sourceDigest: digest(source), sourceDescriptor: { id: 'source-' + id, kind: source.kind, reference: source.label, capturedAt }, images: [], draft: null };
      await mkdir(this.directory(id), { mode: 0o700 });
      await writeJson(path.join(this.directory(id), 'job.json'), job, true);
      return this.get({ id, includeSource: true });
    });
  }

  async image({ id, filePath, url, alt } = {}) {
    const result = await this.images({ id, images: [{ filePath, url, alt }] });
    return result.images[0];
  }

  async images({ id, images } = {}) {
    return this.exclusive(async () => {
      const job = await this.load(id);
      if (!editable.has(job.status, job)) fail('검토 중이거나 실행된 작업의 이미지는 변경할 수 없습니다.');
      if (!Array.isArray(images) || images.length < 1 || images.length > 20) fail('이미지를 1~20개 전달하세요.');
      const captured = [];
      // Bound concurrent public reads; persist only after every read succeeds.
      for (let offset = 0; offset < images.length; offset += 4) {
        const batch = await Promise.allSettled(images.slice(offset, offset + 4).map(item => this.captureImage(item)));
        const failed = batch.find(item => item.status === 'rejected');
        if (failed) throw failed.reason;
        captured.push(...batch.map(item => item.value));
      }
      const unique = new Set([...job.images.map(item => item.sha256), ...captured.map(item => item.sha256)]);
      if (unique.size > 20) fail('상품당 최대 20개 이미지를 지원합니다.');
      const result = [];
      for (const { bytes, mimeType, sourceUrl, sha256, alt } of captured) {
        const duplicate = job.images.find(item => item.sha256 === sha256);
        if (duplicate) { result.push(duplicate); continue; }
        const imageId = 'image-' + sha256.slice(0, 24);
        const name = imageId + ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' })[mimeType];
        const image = { id: imageId, name, path: path.join(this.directory(id), name), mimeType, sha256, alt, ...(sourceUrl ? { sourceUrl } : {}) };
        try { await writeFile(image.path, bytes, { flag: 'wx', mode: 0o600 }); }
        catch (error) {
          if (error.code !== 'EEXIST' || (await lstat(image.path)).isSymbolicLink() || createHash('sha256').update(await readFile(image.path)).digest('hex') !== sha256) throw error;
        }
        job.images.push(image); result.push(image);
      }
      job.status = 'source-ready'; job.validation = null;
      await this.save(job); return { images: [...new Map(result.map(item => [item.id, item])).values()], inputImageIds: result.map(item => item.id), totalImages: job.images.length };
    });
  }

  async captureImage({ filePath, url, alt } = {}) {
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
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      return { bytes, mimeType, sourceUrl, sha256, alt };
  }

  async supplement({ id, url, text, sections } = {}) {
    return this.exclusive(async () => {
      const job = await this.load(id);
      if (!editable.has(job.status, job) || job.source.kind !== 'url' || url !== job.source.label) fail('검토 전 같은 상품 URL의 보충 원문만 추가할 수 있습니다.');
      if (typeof text !== 'string' || !text.trim() || text.length > 200000 || !Array.isArray(sections) || !sections.length || sections.some(value => typeof value !== 'string' || !value.trim() || value.length > 200)) fail('보충 원문과 직접 확인한 상세/일차 구간이 필요합니다.');
      job.source.supplements ??= [];
      if (job.source.supplements.length >= 10) fail('보충 원문은 최대 10회 추가할 수 있습니다.');
      if (!job.source.supplements.some(item => item.digest === digest(text))) job.source.supplements.push({ text, sections: copy(sections), url, untrusted: true, digest: digest(text), capturedAt: new Date().toISOString() });
      job.sourceDigest = digest(job.source); job.status = 'source-ready'; job.validation = null;
      await this.save(job); return this.get({ id, includeSource: true });
    });
  }

  async wait({ id, reason } = {}) {
    return this.exclusive(async () => {
      const job = await this.load(id);
      if (this.active?.id === id || job.finishedAt || !editable.has(job.status, job)) fail('실행 중이거나 종료된 작업의 대기 시간은 변경할 수 없습니다.');
      changeWait(job, reason); await this.save(job);
      return { id, timing: workflowTiming(job) };
    });
  }

  assemble(job, observed = { companyId: '1', identity: pendingIdentity }) {
    const { product, registration } = job.draft;
    const plan = {
      ...copy(registration), target: { mode: 'NEW' }, product: copy(product), ...copy(observed),
      source: { digest: job.sourceDigest, rows: product.itinerary.map(day => ({ id: 'day-' + day.day, sourceId: job.sourceDescriptor.id, day: day.day })), images: copy(job.images) },
      itinerary: product.itinerary.map(day => ({ ...copy(day), sourceRowId: 'day-' + day.day })),
      seasonMode: job.seasonMode,
      ...(job.resumeFrom ? { resumeFrom: copy(job.resumeFrom) } : {})
    };
    return validateProductOnlyLaunchPlan(plan);
  }

  validate(job) {
    const questions = [];
    const source = validateProductImport({ product: job.draft.product, seasonMode: job.seasonMode });
    questions.push(...source.errors.map(error => ({ field: error.field, message: error.message })));
    if (job.seasonMode === 'included') questions.push(...flightPreflight(job.draft.registration.season, job.draft.product.departures?.find(item => item.startDate === job.draft.registration.season?.selectedDates?.[0])));
    try {
      const plan = this.assemble(job);
      const adapters = createProductOnlyAdapters({ plan, identity: forbidden, authorizeWrite: forbidden, record: forbidden, loadImage: forbidden, verifyUploadedImage: forbidden });
      for (const name of ['basic', 'media', 'shell', 'day', 'season', 'departure']) {
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
      if (!editable.has(job.status, job)) fail('이미 검토를 시작한 작업입니다. 작업 상태를 먼저 확인하세요.');
      if (!registration || typeof registration !== 'object' || Array.isArray(registration) || Object.keys(registration).some(key => !['basic', 'display', 'content', 'shell', 'season', 'departure'].includes(key))) fail('registration은 basic/display/content/shell/season/departure만 받습니다.');
      if (!Array.isArray(product?.sources) || !product.sources.some(item => same(item, job.sourceDescriptor))) fail('반환된 sourceDescriptor를 product.sources에 그대로 포함하세요.');
      if (job.seasonMode === 'excluded' && Object.hasOwn(registration, 'season')) fail('시즌 제외 작업에는 season을 전달하지 마세요.');
      job.draft = { product: copy(product), registration: copy(registration) };
      changeWait(job, null);
      job.validation = this.validate(job); job.status = job.validation.readyForReview ? 'ready-for-review' : 'needs-input';
      if (job.failure?.retryable === true) job.failure = null;
      await this.save(job); return this.get({ id });
    });
  }

  async openBrowser() {
    return this.exclusive(async () => {
      if (this.active) fail('열린 검토/실행을 먼저 완료하세요.');
      return this.browser.open();
    });
  }

  async resume({ id, season } = {}) {
    return this.exclusive(async () => {
      if (this.active) fail('현재 검토/실행이 끝난 뒤 이어하기를 준비하세요.');
      const parent = await this.load(id);
      if (parent.status !== 'needs-reconciliation' || parent.resumeFrom) fail('시즌 또는 행사 준비 중 중단된 원래 작업만 이어갈 수 있습니다. 다른 중단은 독립 대사가 필요합니다.');
      const planPath = path.join(this.directory(id), 'approved-plan.json'), journalPath = path.join(this.directory(id), 'run', 'journal.jsonl');
      for (const file of [planPath, journalPath]) { const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink()) fail('원래 계획과 장부는 일반 파일이어야 합니다.'); }
      const planText = await readFile(planPath, 'utf8'), journalText = await readFile(journalPath, 'utf8');
      if (!journalText.endsWith('\n')) fail('저장 장부가 중간에 끊겼습니다. 독립 대사가 필요합니다.');
      const originalPlan = JSON.parse(planText), rows = journalText.trimEnd().split('\n').map(JSON.parse);
      const seed = resumeCheckpoint(originalPlan, rows), childId = randomUUID();
      if (!same(originalPlan.product, parent.draft.product)) fail('원래 초안이 승인된 상품과 다릅니다.');
      const from = { id, planDigest: originalPlan.approvalBinding.planDigest, journalDigest: digest(journalText), planFileDigest: digest(planText), target: seed.targets, remaining: copy(seed.remaining) };
      const reservation = path.join(this.directory(id), 'resume-reservation.json');
      // One durable child per interrupted job; neither cancellation nor restart opens a second create path.
      await writeJson(reservation, { childId, ...from }, true);
      const job = { version: 1, id: childId, createdAt: new Date().toISOString(), startedAt: parent.startedAt ?? parent.createdAt, status: 'source-ready', seasonMode: parent.seasonMode, source: copy(parent.source), sourceDigest: parent.sourceDigest, sourceDescriptor: copy(parent.sourceDescriptor), images: copy(parent.images), draft: copy(parent.draft), waits: copy(parent.waits ?? []), resumeFrom: from, resumeSeed: seed };
      if (season !== undefined) { if (seed.remaining[0] !== 'season') fail('시즌이 이미 저장돼 있어 시즌을 바꿀 수 없습니다.'); job.draft.registration.season = copy(season); }
      job.validation = this.validate(job); job.status = job.validation.readyForReview ? 'ready-for-review' : 'needs-input';
      await mkdir(this.directory(childId), { mode: 0o700 }); await writeJson(path.join(this.directory(childId), 'job.json'), job, true);
      return { ...await this.get({ id: childId }), notice: seed.remaining[0] === 'departure' ? '기존 상품·이미지·상세·전체 일정·시즌을 다시 조회한 뒤 남은 행사만 만듭니다. 기본상품과 시즌은 다시 만들지 않습니다.' : '기존 상품·이미지·상세·전체 일정을 다시 조회한 뒤 남은 시즌부터 진행합니다. 새 검토는 기존 위임 범위 안에서 제출할 수 있으며, 기본상품은 다시 만들지 않습니다.' };
    });
  }

  async assertResume(job) {
    const from = job.resumeFrom;
    if (!from) return;
    const root = this.directory(from.id);
    const [planText, journalText, reservation] = await Promise.all([
      readFile(path.join(root, 'approved-plan.json'), 'utf8'), readFile(path.join(root, 'run', 'journal.jsonl'), 'utf8'), readFile(path.join(root, 'resume-reservation.json'), 'utf8').then(JSON.parse)
    ]);
    if (digest(planText) !== from.planFileDigest || digest(journalText) !== from.journalDigest || reservation.childId !== job.id || !same(resumeCheckpoint(JSON.parse(planText), journalText.trimEnd().split('\n').map(JSON.parse)), job.resumeSeed)) fail('원래 저장 장부나 이어하기 대상이 변경됐습니다.');
    const observed = await this.identityReader(await this.browser.ensurePage()), original = JSON.parse(planText);
    if (observed.companyId !== original.companyId || observed.identity.accountKey !== original.identity.accountKey || observed.identity.accountName !== original.identity.accountName) fail('이어하기 회사·계정이 원래 승인과 다릅니다.');
  }
  async context() {
    return this.exclusive(async () => {
      if (this.active) fail('등록 검토 중에는 브라우저를 변경할 수 없습니다.');
      const page = await this.browser.ensurePage();
      const observed = await this.identityReader(page);
      return { companyId: observed.companyId, accountName: observed.identity.accountName, url: page.url(), notice: '회사명과 담당자/도시의 실제 선택값을 확인하세요. 인증 쿠키는 반환하지 않습니다.' };
    });
  }

  /** Read-only exact label/value lookup for city, manager, airline, airport and departure port. */
  async lookup({ kind, query, productId } = {}) {
    return this.exclusive(async () => {
      if (this.active) fail('등록 검토·실행 중에는 조회할 수 없습니다.');
      const page = await this.browser.ensurePage();
      const observed = await this.identityReader(page);
      const found = await erpLookup(page, { kind, query, productId });
      return { companyId: observed.companyId, accountName: observed.identity.accountName, ...found, notice: 'label을 registration·season.selectLabels에 그대로, value를 season.selects에 사용하세요. inactive 항목은 쓰지 마세요.' };
    });
  }

  /** Batch read-only selectors in one owned session, with identity checked at both ends. */
  async lookups({ requests } = {}) {
    if (!Array.isArray(requests) || requests.length < 1 || requests.length > 20) fail('일괄 조회는 1~20개 항목을 받습니다.');
    const keys = new Set();
    for (const item of requests) {
      if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !['key', 'kind', 'query', 'productId'].includes(key))) fail('일괄 조회 항목 형식이 올바르지 않습니다.');
      if (typeof item.key !== 'string' || !item.key.trim() || item.key !== item.key.trim() || item.key.length > 50 || keys.has(item.key)) fail('일괄 조회 key는 중복 없는 1~50자 문자열이어야 합니다.');
      keys.add(item.key);
      if (!LOOKUP_KINDS.includes(item.kind)) fail('지원하지 않는 조회 종류입니다.');
      if (item.kind !== 'departport' && (typeof item.query !== 'string' || !item.query.trim() || item.query.length > 50)) fail('검색어는 1~50자로 입력하세요.');
      if (item.productId !== undefined && (typeof item.productId !== 'string' || !/^[1-9][0-9]{0,12}$/.test(item.productId))) fail('기존 상품 ID(productId) 형식이 올바르지 않습니다.');
    }
    return this.exclusive(async () => {
      if (this.active) fail('등록 검토·실행 중에는 조회할 수 없습니다.');
      const page = await this.browser.ensurePage(), observed = await this.identityReader(page);
      const results = [], errors = [];
      for (let offset = 0; offset < requests.length; offset += 4) {
        const batch = requests.slice(offset, offset + 4);
        const settled = await Promise.allSettled(batch.map(({ key, ...request }) => erpLookup(page, request)));
        for (const [index, outcome] of settled.entries()) {
          if (outcome.status === 'fulfilled') results.push({ key: batch[index].key, ...outcome.value });
          else errors.push({ key: batch[index].key, kind: batch[index].kind, message: String(outcome.reason?.message ?? outcome.reason) });
        }
      }
      if (!same(await this.identityReader(page), observed)) fail('일괄 조회 중 회사·계정·로그인 세션이 변경됐습니다. 결과를 사용하지 마세요.');
      return { companyId: observed.companyId, accountName: observed.identity.accountName, complete: errors.length === 0, results, errors, notice: '각 key의 정확한 label/value를 사용하세요. 오류 항목만 수정해 재조회하고, 조회 결과로 저장 완료를 판단하지 마세요.' };
    });
  }

  async review({ id } = {}) {
    return this.exclusive(async () => {
      if (this.active) fail('다른 등록 검토가 열려 있습니다.');
      const job = await this.load(id);
      if (job.status !== 'ready-for-review' && !retryableReview(job)) fail('등록 준비를 완료하고 작업 상태를 확인하세요.');
      const page = await this.browser.ensurePage(), observed = await this.identityReader(page);
      await this.assertResume(job);
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
        launcher = await this.launch({ budgetMode: 'report', ...this.launchOptions, plan, planPath, dataDir: path.join(this.directory(id), 'run'), browser: ownedBrowser, ...(job.resumeFrom ? { resume: copy(job.resumeSeed), assertResume: () => this.assertResume(job) } : {}) });
      } catch (error) {
        // Preflight is read-only. If the run journal was never created, nothing could have been
        // claimed or written, so drop the unapproved plan and let the draft be corrected in place.
        const runDir = path.join(this.directory(id), 'run');
        const journalCreated = await lstat(runDir).then(() => true, failure => { if (failure.code === 'ENOENT') return false; throw failure; });
        if (!journalCreated) await unlink(planPath);
        job.status = 'review-preparation-failed'; job.failure = { message: error.message, erpWriteStarted: false, retryable: !journalCreated };
        await this.save(job);
        if (!journalCreated) error.message += ' (ERP 저장 전 실패: product_import_prepare로 수정하거나 같은 작업으로 다시 검토할 수 있습니다.)';
        throw error;
      }
      job.status = 'awaiting-approval'; job.planDigest = plan.approvalBinding.planDigest;
      changeWait(job, 'approval');
      const active = { id, launcher, plan:copy(plan), done: null }; this.active = active; this.reviews.add(launcher);
      active.done = launcher.completed.then(async result => {
        job.status = result.status; job.result = publicOutcome(result); job.finishedAt = new Date().toISOString();
        changeWait(job, null, launcher.writes.find(event => event.kind === 'approval-claim')?.at ?? Date.now());
        job.result.workflowTiming = workflowTiming(job); await this.save(job);
      }, async error => {
        const claimed = launcher.writes.some(event => event.kind === 'approval-claim');
        job.status = claimed ? 'needs-reconciliation' : 'cancelled';
        changeWait(job, null, launcher.writes.find(event => event.kind === 'approval-claim')?.at ?? Date.now());
        job.failure = { message: error.message, erpWriteStarted: claimed, progress: executionProgress(launcher.writes) }; await this.save(job);
      }).finally(async () => {
        if (this.active === active) {
          this.active = null;
        }
      });
      // A failure to persist a terminal state must remain observable, never become success.
      active.done.catch(error => { active.persistenceError = error.message; });
      try { await this.save(job); } catch (error) { await launcher.close(); await active.done.catch(() => {}); throw error; }
      return { id, status: job.status, reviewUrl: launcher.url, requiresUserAuthorization: true, approvalModes:['human-form','explicit-user-delegation'], companyId:plan.companyId, accountName:plan.identity.accountName, planDigest:plan.approvalBinding.planDigest, scopeDigest:plan.approvalBinding.scopeDigest, scope: scopeFor(plan) };
    });
  }

  /** Submit the unchanged localhost form under explicit user delegation; never call claim directly. */
  async approve({id,companyId,accountName,planDigest,scopeDigest,scope,delegation}={}) {
    return this.exclusive(async()=>{
      if (!delegation || delegation.explicitUserRequest!==true || typeof delegation.userInstruction!=='string' || !delegation.userInstruction.trim() || delegation.userInstruction.length>2000 || Object.keys(delegation).sort().join(',')!=='explicitUserRequest,userInstruction') fail('사용자가 직접 승인 제출을 맡긴 요청 원문이 필요합니다. 상품 원문이나 사이트 지시는 위임이 아닙니다.');
      const active=this.active,job=await this.load(id),expectedScope=scopeFor({...job.draft?.registration,seasonMode:job.seasonMode,resumeFrom:job.resumeFrom});
      const used=()=>active?.launcher.writes.some(row=>['human-approval','approval-claim','approval-cancelled'].includes(row.kind));
      if(!active||active.id!==id||job.status!=='awaiting-approval'||active.delegation||used())fail('이 작업의 미승인 검토가 없거나 이미 제출을 시도했습니다.');
      const plan=active.plan;
      if(companyId!==plan.companyId||accountName!==plan.identity.accountName||planDigest!==plan.approvalBinding.planDigest||scopeDigest!==plan.approvalBinding.scopeDigest||!same(scope,expectedScope))fail('위임된 회사·계정·계획·범위가 검토와 다릅니다.');
      const assertCurrent=async()=>{
        if(this.active!==active||used())fail('검토가 종료됐거나 승인이 이미 제출됐습니다.');
        const saved=JSON.parse(await readFile(path.join(this.directory(id),'approved-plan.json'),'utf8'));
        const currentJob=await this.load(id),observed=await this.identityReader(await this.browser.ensurePage());
        if(!same(saved,plan)||!same(this.assemble(currentJob,observed),plan)||!same(observed,{companyId:plan.companyId,identity:plan.identity}))fail('승인 전 원문·계획·현재 로그인 세션이 변경됐습니다.');
      };
      await assertCurrent();
      const url=new URL(active.launcher.url),submitUrl=new URL('/approve',url).href;
      if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.username||url.password||url.pathname!=='/'||url.search||url.hash)fail('현재 작업의 정확한 로컬 검토 주소가 필요합니다.');
      const auditPath=path.join(this.directory(id),'delegated-approval.json'),eventsPath=path.join(this.directory(id),'delegated-approval-events.jsonl');
      try{await lstat(auditPath);fail('이미 위임 제출을 시도한 작업입니다. 자동 반복할 수 없습니다.');}catch(error){if(error.code!=='ENOENT')throw error;}
      const client=await this.approvalBrowserLauncher.launch({headless:true});this.approvalClients.add(client);
      let submitted=false,fields=null,resolveSubmitted,rejectSubmitted,timer;
      const dispatched=new Promise((resolve,reject)=>{resolveSubmitted=resolve;rejectSubmitted=reject;});dispatched.catch(()=>{});
      const record=async(kind,details={})=>{const h=await open(eventsPath,'a',0o600);try{await h.writeFile(JSON.stringify({kind,at:Date.now(),actor:'ai-on-user-delegation',...details})+'\n');await h.sync();}finally{await h.close();}};
      const closeClient=async()=>{clearTimeout(timer);this.approvalClients.delete(client);await client.close().catch(()=>{});};
      try{
        const context=await client.newContext({serviceWorkers:'block'}),page=await context.newPage();
        // Browser route.continue follows HTTP redirects without re-running this allowlist.
        // Fetch exactly once and fulfill locally so even a replaced review server cannot redirect it.
        const forward=async(route,isSubmission=false)=>{
          let response;
          try{
            const pending=route.fetch({maxRedirects:0,maxRetries:0,timeout:15*60*1000});
            if(isSubmission)resolveSubmitted();
            response=await pending;
            if(response.status()>=300&&response.status()<400){
              if(isSubmission)await record('delegated-form-redirect-blocked',{status:response.status()});
              return await route.fulfill({status:502,contentType:'text/plain',body:'Local review redirects are not permitted.'});
            }
            await route.fulfill({response});
          }catch(error){await route.abort().catch(()=>{});if(isSubmission)rejectSubmitted(error);}
          finally{await response?.dispose();}
        };
        await context.route('**/*',async route=>{
          const req=route.request();
          if(req.method()==='GET'&&req.url()===url.href)return forward(route);
          if(!fields||submitted||req.method()!=='POST'||req.url()!==submitUrl||req.headers().origin!==url.origin)return route.abort();
          const tuples=[...new URLSearchParams(req.postData()??'')];
          if(tuples.length!==6||new Set(tuples.map(([key])=>key)).size!==6||!same(Object.fromEntries(tuples),fields))return route.abort();
          submitted=true;
          try{await record('delegated-form-submission');await forward(route,true);}catch(error){await route.abort().catch(()=>{});rejectSubmitted(error);}
        });
        const response=await page.goto(url.href,{waitUntil:'domcontentloaded',timeout:10000});
        if(response?.status()!==200||response.url()!==url.href||page.url()!==url.href)fail('검토 화면이 만료되었거나 변경됐습니다.');
        const form=page.locator('form[method="post"][action="/approve"]');if(await form.count()!==1)fail('제출할 미승인 검토 폼이 없습니다.');
        const values={};for(const key of ['csrf','version','scope_hash','scope']){const input=form.locator(`input[type="hidden"][name="${key}"]`);if(await input.count()!==1)fail('검토 폼이 변경됐습니다.');values[key]=await input.inputValue();}
        if(!/^[a-f0-9]{64}$/.test(values.csrf)||values.version!=='1'||values.scope_hash!==scopeDigest||values.scope!==scope.join(','))fail('검토 폼의 버전 또는 승인 범위가 변경됐습니다.');
        const companyTenant=plan.product.company.tenant;
        await form.locator('input[name="company"]').fill(companyTenant);await form.locator('input[name="account"]').fill(accountName);await assertCurrent();
        const audit={kind:'explicit-user-delegated-approval-v1',actor:'ai-on-user-delegation',id,companyId,accountName,planDigest,scopeDigest,scope:copy(scope),delegation:copy(delegation),at:Date.now(),submission:'existing-localhost-form'};
        await writeJson(auditPath,audit,true);active.delegation={actor:audit.actor,status:'prepared',at:audit.at};fields={...values,company:companyTenant,account:accountName};
        const outcome=page.waitForResponse(r=>r.request().method()==='POST'&&r.url()===submitUrl,{timeout:15*60*1000});outcome.catch(()=>{});
        active.delegation.done=outcome.then(async r=>{active.delegation.status='response-received';await record('delegated-form-response',{status:r.status()});},async()=>{active.delegation.status='response-unconfirmed';await record('delegated-form-response-unconfirmed');}).finally(closeClient);
        this.approvalTasks.add(active.delegation.done);
        active.delegation.done.finally(()=>this.approvalTasks.delete(active.delegation.done)).catch(()=>{});
        timer=setTimeout(()=>rejectSubmitted(new Error('제출 결과를 확인할 수 없습니다. 상태를 확인하고 자동 재제출하지 마세요.')),10000);
        form.locator('button[type="submit"]').click({noWaitAfter:true,timeout:10000}).catch(rejectSubmitted);
        await dispatched;clearTimeout(timer);active.delegation.status='submitted';
        return {id,status:'approval-submitted',actor:audit.actor,planDigest,scopeDigest,notice:'동일한 로컬 검토 폼으로 위임 제출했습니다. product_import_get으로 실제 실행과 독립 확인 결과를 확인하세요.'};
      }catch(error){if(active.delegation){active.delegation.status=submitted?'submission-unconfirmed':'submission-failed';await record('delegated-form-submission-failed',{submitted}).catch(()=>{});}if(!submitted)await closeClient();throw error;}
    });
  }

  async get({ id, includeSource = false, compact = false } = {}) {
    if (typeof compact !== 'boolean' || (compact && includeSource)) fail('compact와 includeSource는 함께 사용할 수 없습니다.');
    const job = await this.load(id);
    const intent=await readFile(path.join(this.directory(id),'delegated-approval.json'),'utf8').then(JSON.parse).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    const approvalDelegation=intent?{actor:intent.actor,requestedAt:intent.at,planDigest:intent.planDigest,scopeDigest:intent.scopeDigest,scope:copy(intent.scope),notice:'사용자 위임 요청 기록이며 실제 제출·승인·실행·완료 여부는 작업 상태와 독립 확인 결과를 따릅니다.'}:null;
    let status = job.status;
    const claimAt = this.active?.id === id ? this.active.launcher.writes.find(event => event.kind === 'approval-claim')?.at : null;
    if (claimAt) changeWait(job, null, claimAt);
    if (this.active?.id === id) {
      if (this.active.launcher.writes.some(event => event.kind === 'approval-claim')) status = 'running';
      if (this.active.persistenceError) status = 'needs-reconciliation';
    } else if (['opening-review', 'awaiting-approval'].includes(status)) status = 'interrupted-needs-reconciliation';
    const state = { id, status, resumeFrom: job.resumeFrom ?? null, timing: workflowTiming(job), approvalDelegation, progress: this.active?.id === id ? executionProgress(this.active.launcher.writes) : job.failure?.progress ?? null, validation: job.validation ?? null, result: job.result ?? null, failure: job.failure ?? null };
    if (compact) return { ...state, imageCount: job.images.length };
    return { ...state, sourceQuality: { ...sourceQuality(job.source), supplementCount: job.source.supplements?.length ?? 0 }, seasonMode: job.seasonMode, sourceDescriptor: job.sourceDescriptor, sourceDigest: job.sourceDigest, images: copy(job.images), ...(includeSource ? { source: copy(job.source), draft: copy(job.draft) } : {}) };
  }

  async close() {
    if (this.busy) fail('진행 중인 호출이 끝난 뒤 종료하세요.');
    const active = this.active;
    for (const review of this.reviews) await review.close();
    this.reviews.clear();
    if (active) await active.done;
    for (const client of this.approvalClients) await client.close();
    this.approvalClients.clear();
    await Promise.allSettled([...this.approvalTasks]);
    await this.browser.close();
    if (this.lock) { await this.lock.close(); this.lock = null; await unlink(path.join(this.root, 'plugin-owner.json')); }
    return { status: 'closed' };
  }
}
