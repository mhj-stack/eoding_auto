import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startProductOnlyLauncher } from '../src/product-only-launcher.mjs';

const fail = message => { throw new Error(message); };

function parse(argv) {
  const values = { mode: 'review' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--review' || arg === '--preflight-only') {
      if (values.mode !== 'review') fail('Choose only one of --review or --preflight-only');
      values.mode = arg.slice(2);
      continue;
    }
    if (!['--plan', '--data-dir', '--browser-dir'].includes(arg)) fail(`Unknown flag: ${arg}`);
    const value = argv[++index];
    if (!value || value.startsWith('--') || values[arg]) fail(`Exactly one path is required after ${arg}`);
    values[arg] = value;
  }
  if (!values['--plan'] || !values['--data-dir']) fail('Usage: node scripts/product-only-start.mjs --plan <agent-authored-plan.json> --data-dir <private-journal-dir> [--browser-dir <approved-profile-dir>] [--preflight-only|--review]');
  if (values.mode === 'review' && !values['--browser-dir']) fail('--browser-dir is required for --review');
  return values;
}

async function existing(value, name, type) {
  const resolved = path.resolve(value), stat = await lstat(resolved).catch(error => { if (error.code === 'ENOENT') fail(`${name} path does not exist`); throw error; });
  if ((type === 'file' && !stat.isFile()) || (type === 'directory' && !stat.isDirectory()) || stat.isSymbolicLink()) fail(`${name} must be an existing non-symlink ${type}`);
  return resolved;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parse(argv);
  const planPath = await existing(args['--plan'], '--plan', 'file');
  const dataDir = await existing(args['--data-dir'], '--data-dir', 'directory');
  const browserDir = args['--browser-dir'] ? await existing(args['--browser-dir'], '--browser-dir', 'directory') : undefined;
  let plan;
  try { plan = JSON.parse(await readFile(planPath, 'utf8')); } catch (error) { fail(`--plan must be valid JSON: ${error.message}`); }
  const launcher = await startProductOnlyLauncher({ plan, planPath, dataDir, browserDir, preflightOnly: args.mode === 'preflight-only' });
  if (args.mode === 'preflight-only') {
    console.log(`PREFLIGHT ${JSON.stringify(launcher)}`);
    return launcher;
  }
  console.log(`READY ${JSON.stringify({ url: launcher.url, planDigest: launcher.planDigest, scopeDigest: launcher.scopeDigest, requiresLocalHumanApproval: true, productionWritesBeforeClick: 0 })}`);
  try {
    const result = await launcher.completed;
    console.log(`RESULT ${JSON.stringify(result)}`);
    return result;
  } finally { await launcher.close().catch(() => {}); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
