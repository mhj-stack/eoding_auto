import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('portable MCP advertises a complete workflow, persists source and questions, and has no AI approval tool', { timeout: 60000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'plugin-mcp-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/plugin-mcp.mjs', import.meta.url))], env: { ...process.env, EODING_DATA_DIR: root, EODING_INPUT_DIR: path.join(root, 'input') }, stderr: 'pipe' });
  const client = new Client({ name: 'plugin-contract-test', version: '1.0.0' });
  const call = async (name, args = {}) => {
    const response = await client.callTool({ name, arguments: args });
    assert.notEqual(response.isError, true, JSON.stringify(response));
    return JSON.parse(response.content[0].text);
  };
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    assert.equal(tools.length, 10);
    assert.ok(!tools.some(tool => /approve|execute|publish/.test(tool.name)));
    const caps = await call('product_import_capabilities');
    assert.equal(caps.requiresLlmApiKey, false);
    assert.equal(caps.liveEndToEndVerified, false);
    const schema = await call('product_import_schema');
    const job = await call('product_import_source', { text: '사용자가 제공한 가상 상품자료', seasonMode: 'excluded' });
    const product = schema.fictionalProductExample;
    product.sources = [job.sourceDescriptor];
    product.evidence = product.evidence.map(item => ({ ...item, sourceId: job.sourceDescriptor.id }));
    const draft = await call('product_import_prepare', { id: job.id, product, registration: {} });
    assert.equal(draft.status, 'needs-input');
    assert.ok(draft.validation.questions.length);
    assert.equal((await call('product_import_get', { id: job.id })).sourceDigest, job.sourceDigest);
    assert.equal((await call('product_import_close')).status, 'closed');
  } finally { await client.close(); await transport.close(); }
});
