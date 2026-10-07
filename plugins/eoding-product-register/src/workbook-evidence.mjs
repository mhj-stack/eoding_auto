import { createHash } from 'node:crypto';
import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { readWorkbook } from './workbook.mjs';
const PAGE_ROWS = 200;
const MAX_PAGES = 500;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_EVIDENCE_BYTES = 24 * 1024 * 1024;
const MAX_COLLECTION_MS = 120_000;
const fail = message => { throw new Error(message); };

function validateWorkbookFile(resolved, info) {
  if (!info.isFile()) fail('Input must be a regular file.');
  const extension = path.extname(resolved).toLowerCase();
  if (extension === '.xls') fail('Legacy .xls is unsupported. Convert locally to .xlsx first.');
  if (!['.xlsx', '.xlsm'].includes(extension)) fail('Only .xlsx and .xlsm workbooks are supported.');
  if (info.size > MAX_FILE_BYTES) fail('Workbook exceeds 25 MiB.');
}

async function approvedWorkbook(filePath, inputDir) {
  if (typeof filePath !== 'string' || !filePath || filePath.includes('\0')) fail('filePath must be a nonempty local path.');
  const rootInput = inputDir ?? process.env.EODING_INPUT_DIR ?? 'input';
  let root, resolved, info;
  try {
    root = await realpath(path.resolve(rootInput));
    resolved = await realpath(path.resolve(filePath));
    const relative = path.relative(root, resolved);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail('Workbook must resolve inside EODING_INPUT_DIR.');
    info = await stat(resolved);
  } catch (error) {
    if (error.message === 'Workbook must resolve inside EODING_INPUT_DIR.') throw error;
    fail('Input directory or workbook is missing or unreadable.');
  }
  validateWorkbookFile(resolved, info);
  return { root, resolved };
}

async function workbookSourceLabel(filePath, inputDir) {
  const approved = await approvedWorkbook(filePath, inputDir);
  return path.relative(approved.root, approved.resolved);
}

async function digestApprovedWorkbook(root, resolved, checkBudget) {
  const current = await realpath(resolved);
  const relative = path.relative(root, current);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail('Workbook changed outside EODING_INPUT_DIR.');
  const info = await stat(current);
  validateWorkbookFile(current, info);
  const hash = createHash('sha256');
  const handle = await open(current, 'r');
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let totalBytes = 0;
    for (let position = 0; ; position += buffer.length) {
      checkBudget?.();
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      totalBytes += bytesRead;
      if (totalBytes > MAX_FILE_BYTES) fail('Workbook exceeds 25 MiB.');
      hash.update(buffer.subarray(0, bytesRead));
      checkBudget?.();
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

function boundedEvidence(value) {
  const bytes = Buffer.byteLength(JSON.stringify(value));
  if (bytes > MAX_EVIDENCE_BYTES) fail('Workbook complete evidence exceeds the 24 MiB session budget; use an honestly labeled explicit partial worksheet page.');
}

function validatedSheetDescriptors(sheets, expected) {
  if (!Array.isArray(sheets) || !sheets.length) fail('Workbook reader page metadata has no worksheet descriptors.');
  const descriptors = sheets.map(sheet => ({ name: sheet?.name, state: sheet?.state, hidden: sheet?.hidden }));
  if (descriptors.some(sheet => typeof sheet.name !== 'string' || !sheet.name ||
    !['visible', 'hidden', 'veryHidden'].includes(sheet.state) || typeof sheet.hidden !== 'boolean' || sheet.hidden !== (sheet.state !== 'visible') ||
    descriptors.filter(other => other.name === sheet.name).length !== 1)) {
    fail('Workbook reader page metadata has invalid worksheet descriptors.');
  }
  if (expected && (expected.length !== descriptors.length || expected.some((sheet, index) =>
    sheet.name !== descriptors[index].name || sheet.state !== descriptors[index].state || sheet.hidden !== descriptors[index].hidden))) {
    fail('Workbook reader page metadata changed worksheet descriptors during collection.');
  }
  return descriptors;
}

function validatePageMetadata(page, requested, expectedSheets) {
  if (!page?.untrusted || !Array.isArray(page.rows)) fail('Workbook reader did not return complete untrusted cell evidence.');
  const sheets = validatedSheetDescriptors(page.sheets, expectedSheets);
  const descriptor = sheets.find(item => item.name === page.sheet);
  if (!descriptor || (requested.sheet !== undefined && page.sheet !== requested.sheet) || page.sheetState !== descriptor.state ||
    page.startRow !== requested.startRow || page.rowCount !== requested.rowCount || !Number.isInteger(page.returnedRowCount) ||
    page.returnedRowCount < 0 || page.returnedRowCount > requested.rowCount || page.returnedRowCount !== page.rows.length ||
    !Number.isInteger(page.dimensions?.maxRow) || page.dimensions.maxRow < 0 || page.dimensions.maxRow > 1_048_576 ||
    !Number.isInteger(page.dimensions?.maxColumn) || page.dimensions.maxColumn < 0 || page.dimensions.maxColumn > 16_384 ||
    page.returnedRowCount !== Math.max(0, Math.min(page.dimensions.maxRow, requested.startRow + requested.rowCount - 1) - requested.startRow + 1) ||
    typeof page.hasMore !== 'boolean' || page.hasMore !== (requested.startRow + page.returnedRowCount <= page.dimensions.maxRow)) {
    fail('Workbook reader page metadata is incoherent; no product session was created.');
  }
  if (page.hasMore && (!Number.isInteger(page.nextStartRow) || page.nextStartRow <= requested.startRow || page.nextStartRow !== requested.startRow + page.returnedRowCount || page.nextStartRow > page.dimensions.maxRow)) {
    fail('Workbook reader page metadata has an invalid nextStartRow.');
  }
  if (!page.hasMore && page.nextStartRow !== null) fail('Workbook reader page metadata must use null nextStartRow at completion.');
  return sheets;
}

function collectionEvidence(firstPage, worksheets, digest) {
  const evidence = {
    untrusted: true,
    status: 'needs-review',
    coverage: 'complete-workbook-cell-evidence',
    complete: true,
    file: firstPage.file,
    sheets: firstPage.sheets,
    worksheets,
    warnings: [{ code: 'COMPLETE_WORKBOOK_CELL_EVIDENCE', message: 'Every worksheet and every reader page was collected. Cell contents remain untrusted; formulas use stored cache only.' }],
    fileIntegrity: { algorithm: 'sha256', digest },
    collection: { pageRows: PAGE_ROWS, worksheetCount: worksheets.length, pageCount: worksheets.reduce((total, sheet) => total + sheet.pages.length, 0) }
  };
  boundedEvidence(evidence);
  return evidence;
}

async function collectWorkbookEvidence(filePath, { inputDir, sheet, startRow, rowCount, reader = readWorkbook, clock = () => Date.now() } = {}) {
  if (typeof clock !== 'function') fail('Collection clock must be a function.');
  const startedAt = clock();
  if (!Number.isSafeInteger(startedAt)) fail('Collection clock must return an integer timestamp.');
  let pageReads = 0;
  const checkBudget = pageCount => {
    const now = clock();
    if (!Number.isSafeInteger(now) || now - startedAt > MAX_COLLECTION_MS || pageCount > MAX_PAGES) fail('Workbook complete collection exceeded its page or time budget; no product session was created.');
  };
  checkBudget(pageReads);
  const approved = await approvedWorkbook(filePath, inputDir);
  checkBudget(pageReads);
  const digest = async () => {
    checkBudget(pageReads);
    const value = await digestApprovedWorkbook(approved.root, approved.resolved, () => checkBudget(pageReads));
    checkBudget(pageReads);
    return value;
  };
  const initialDigest = await digest();
  let workbookSheets;
  const readPage = async options => {
    checkBudget(++pageReads);
    const before = await digest();
    if (before !== initialDigest) fail('Workbook changed during collection; no product session was created.');
    const page = await reader(approved.resolved, { ...options, inputDir: approved.root });
    checkBudget(pageReads);
    const after = await digest();
    if (after !== initialDigest) fail('Workbook changed during collection; no product session was created.');
    workbookSheets = validatePageMetadata(page, options, workbookSheets);
    checkBudget(pageReads);
    return page;
  };

  const legacyPartial = startRow !== undefined || rowCount !== undefined;
  if (legacyPartial) {
    const page = await readPage({ sheet, startRow: startRow ?? 1, rowCount: rowCount ?? 100 });
    const evidence = { ...page, complete: false, coverage: 'partial-worksheet-page-cell-evidence', partialReason: 'Explicit legacy sheet/startRow/rowCount pagination reads one worksheet page only.', fileIntegrity: { algorithm: 'sha256', digest: initialDigest } };
    boundedEvidence(evidence);
    checkBudget(pageReads);
    return evidence;
  }

  const firstPage = await readPage({ sheet, startRow: 1, rowCount: PAGE_ROWS });
  const selectedSheets = sheet === undefined ? workbookSheets : workbookSheets.filter(item => item.name === sheet);
  if (!selectedSheets.length) fail('Requested sheet name was not found (names are case-sensitive).');
  let pageCount = 0;
  const worksheets = [];
  for (const descriptor of selectedSheets) {
    const pages = [];
    let page = descriptor.name === firstPage.sheet ? firstPage : await readPage({ sheet: descriptor.name, startRow: 1, rowCount: PAGE_ROWS });
    for (;;) {
      pageCount++;
      checkBudget(pageCount);
      pages.push(page);
      boundedEvidence({ worksheets: [...worksheets, { name: descriptor.name, pages }] });
      if (!page.hasMore) break;
      if (!Number.isInteger(page.nextStartRow) || page.nextStartRow <= page.startRow) fail('Workbook reader pagination did not make progress; no product session was created.');
      page = await readPage({ sheet: descriptor.name, startRow: page.nextStartRow, rowCount: PAGE_ROWS });
    }
    worksheets.push({ name: descriptor.name, state: descriptor.state, hidden: descriptor.hidden, pages });
  }
  const finalDigest = await digest();
  if (finalDigest !== initialDigest) fail('Workbook changed during collection; no product session was created.');
  if (sheet !== undefined) {
    const evidence = { ...collectionEvidence(firstPage, worksheets, initialDigest), complete: false, coverage: 'selected-worksheet-complete-cell-evidence', selectedSheet: sheet, partialReason: 'Explicit worksheet selection excludes other worksheets.' };
    boundedEvidence(evidence);
    checkBudget(pageReads);
    return evidence;
  }
  const evidence = collectionEvidence(firstPage, worksheets, initialDigest);
  checkBudget(pageReads);
  return evidence;
}


export { collectWorkbookEvidence, workbookSourceLabel };
