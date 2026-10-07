import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const SCRIPT = fileURLToPath(new URL('../scripts/read_workbook.py', import.meta.url));
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
// Windows PATH may expose python.cmd, which cannot run with shell:false.
// Prefer the bundled executable, never enable a shell or install dependencies.
const BUNDLED_WINDOWS_PYTHON = path.join(homedir(), '.aside/runtime/python/runtime/python.exe');
const defaultPython = () => process.platform === 'win32' && existsSync(BUNDLED_WINDOWS_PYTHON)
  ? BUNDLED_WINDOWS_PYTHON : (process.platform === 'win32' ? 'python' : 'python3');

export class WorkbookReadError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WorkbookReadError';
    this.code = code;
  }
}

const error = (code, message) => new WorkbookReadError(code, message);

/** Read untrusted local workbook data. Relative filePath is resolved from cwd. */
export async function readWorkbook(filePath, { sheet, startRow = 1, rowCount = 100, inputDir } = {}) {
  if (typeof filePath !== 'string' || !filePath || filePath.includes('\0')) {
    throw error('INVALID_PATH', 'filePath must be a nonempty local path.');
  }
  if (!Number.isInteger(startRow) || startRow < 1 || startRow > 1_048_576 ||
      !Number.isInteger(rowCount) || rowCount < 1 || rowCount > 200) {
    throw error('INVALID_PAGINATION', 'startRow must be 1..1048576; rowCount must be 1..200.');
  }
  if (sheet !== undefined && (typeof sheet !== 'string' || !sheet || sheet.includes('\0'))) {
    throw error('INVALID_SHEET', 'sheet must be a nonempty, case-sensitive worksheet name.');
  }
  let root, resolved, info;
  try {
    root = await realpath(path.resolve(inputDir ?? process.env.EODING_INPUT_DIR ?? 'input'));
    resolved = await realpath(path.resolve(filePath));
    const relative = path.relative(root, resolved);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw error('INPUT_OUTSIDE_ROOT', 'Workbook must resolve inside EODING_INPUT_DIR.');
    }
    info = await stat(resolved);
  } catch (cause) {
    if (cause instanceof WorkbookReadError) throw cause;
    throw error('INPUT_NOT_READABLE', 'Input directory or workbook is missing or unreadable.');
  }
  if (!info.isFile()) throw error('INVALID_FILE', 'Input must be a regular file.');
  const extension = path.extname(resolved).toLowerCase();
  if (extension === '.xls') {
    throw error('UNSUPPORTED_XLS', 'Legacy .xls is unsupported. Convert locally to .xlsx first.');
  }
  if (!['.xlsx', '.xlsm'].includes(extension)) {
    throw error('UNSUPPORTED_EXTENSION', 'Only .xlsx and .xlsm workbooks are supported.');
  }
  if (info.size > MAX_FILE_BYTES) throw error('FILE_TOO_LARGE', 'Workbook exceeds 25 MiB.');

  const args = [SCRIPT, resolved, '--start-row', String(startRow), '--row-count', String(rowCount)];
  if (sheet !== undefined) args.push(`--sheet=${sheet}`);
  return new Promise((resolve, reject) => {
    let finished = false;
    let outputSize = 0;
    const chunks = [];
    let child;
    let timer;
    const finish = (failure, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (failure) reject(failure);
      else resolve(result);
    };
    try {
      child = spawn(process.env.EODING_PYTHON || defaultPython(), args, {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, EODING_INPUT_DIR: root, PYTHONIOENCODING: 'utf-8' },
      });
    } catch {
      finish(error('PYTHON_START_FAILED', 'Could not start Python. Set EODING_PYTHON to an executable path.'));
      return;
    }
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(error('WORKBOOK_TIMEOUT', 'Workbook reader exceeded the 30-second limit.'));
    }, TIMEOUT_MS);
    child.on('error', () => finish(error('PYTHON_START_FAILED',
      'Could not start Python. Set EODING_PYTHON to an executable path.')));
    // Drain but never echo Python warnings or tracebacks containing private data.
    child.stderr.resume();
    child.stdout.on('data', chunk => {
      if (finished) return;
      outputSize += chunk.length;
      if (outputSize > MAX_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        finish(error('OUTPUT_TOO_LARGE', 'Workbook output exceeds 32 MiB. Request fewer rows.'));
      } else chunks.push(chunk);
    });
    child.on('close', (code, signal) => {
      if (finished) return;
      let result;
      try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch {
        finish(error('INVALID_READER_OUTPUT', 'Python reader did not return valid JSON. Check Python and openpyxl.'));
        return;
      }
      if (result?.error) {
        finish(error(result.error.code || 'WORKBOOK_READ_FAILED',
          result.error.message || 'Workbook reader failed.'));
      } else if (code !== 0 || signal || result?.untrusted !== true || !Array.isArray(result.rows)) {
        finish(error('WORKBOOK_READ_FAILED', 'Workbook reader did not complete successfully.'));
      } else finish(null, result);
    });
  });
}
