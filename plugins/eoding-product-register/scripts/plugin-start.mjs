#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { privateDataDir, prepareRuntime, pythonExecutable } from './plugin-bootstrap.mjs';

try {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--setup-only')) throw new Error('Usage: node scripts/plugin-start.mjs [--setup-only]');
  const dataDir = privateDataDir();
  process.env.EODING_DATA_DIR = dataDir;
  process.env.EODING_INPUT_DIR ||= path.join(dataDir, 'input');
  const runtime = await prepareRuntime({ dataDir });
  process.env.EODING_PYTHON = pythonExecutable(runtime);
  if (args[0] === '--setup-only') process.stderr.write(`[eoding-product-register] Setup complete: ${runtime}\n`);
  else await import(pathToFileURL(path.join(runtime, 'src/plugin-mcp.mjs')).href);
} catch (error) {
  process.stderr.write(`[eoding-product-register] ${error.message}\n`);
  process.exitCode = 1;
}
