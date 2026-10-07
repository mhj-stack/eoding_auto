import { ProductSessionStore } from './product-session.mjs';
import { readSource } from './source.mjs';
import { collectWorkbookEvidence, workbookSourceLabel } from './workbook-evidence.mjs';

const SCOPE_NAMES = ['basic', 'shell', 'days', 'departures'];
const fail = message => { throw new Error(message); };

function requestedScope(value) {
  if (value === undefined || value === 'full') return 'full';
  if (!Array.isArray(value) || !value.length || value.some(item => !SCOPE_NAMES.includes(item)) || new Set(value).size !== value.length) {
    fail('실행 범위는 full 또는 basic/shell/days/departures의 중복 없는 배열이어야 합니다.');
  }
  const selected = SCOPE_NAMES.filter(item => value.includes(item));
  if (selected.includes('departures') && ['basic', 'shell', 'days'].some(item => !selected.includes(item))) {
    fail('행사 범위에는 새 기본정보·일정표·모든 일차가 함께 필요합니다.');
  }
  return selected;
}

function configuredStore(dataDir) {
  const directory = dataDir ?? process.env.EODING_DATA_DIR;
  if (typeof directory !== 'string' || !directory.trim()) fail('전용 비공개 폴더 EODING_DATA_DIR을 명시하세요');
  return new ProductSessionStore(directory);
}

/** Creates a durable session only after the requested source evidence is fully collected. */
export async function createProductSourceSession({ url, filePath, scope, dataDir, inputDir, sheet, startRow, rowCount, readers } = {}) {
  const store = configuredStore(dataDir);
  const selectedScope = requestedScope(scope);
  if (Boolean(url) === Boolean(filePath)) fail('공개 URL 또는 xlsx/xlsm 파일 하나만 지정하세요');
  const source = url
    ? { kind: 'url', label: url, evidence: await (readers?.readSource ?? readSource)(url) }
    : { kind: 'excel', label: await workbookSourceLabel(filePath, inputDir), evidence: await collectWorkbookEvidence(filePath, { inputDir, sheet, startRow, rowCount, reader: readers?.readWorkbook }) };
  return store.create({ source, scope: selectedScope });
}

export { collectWorkbookEvidence };
