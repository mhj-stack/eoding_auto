import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('portable MCP exposes scoped explicit delegation while preserving source and validation workflow', { timeout: 60000 }, async t => {
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
    for (const name of ['product_import_images', 'product_import_source_supplement', 'product_import_wait', 'product_import_flight_minutes', 'product_import_resume']) assert.ok(tools.some(tool => tool.name === name));
    assert.ok(!tools.some(tool => /execute|publish/.test(tool.name)));
    const approval=tools.find(tool=>tool.name==='product_import_approve');
    assert.ok(approval);
    assert.equal(approval.annotations.destructiveHint,true);
    assert.equal(approval.annotations.openWorldHint,true);
    assert.deepEqual(approval.inputSchema.required.sort(),['accountName','companyId','delegation','id','planDigest','scope','scopeDigest'].sort());
    const caps = await call('product_import_capabilities');
    assert.equal(caps.requiresLlmApiKey, false);
    assert.equal(caps.version, '0.2.4'); assert.equal(caps.setupTargetMs, 1200000); assert.equal(caps.timingIsGuarantee, false);
    assert.ok(caps.scope.includes('optional-single-departure'));
    assert.equal(caps.liveEndToEndVerified, false);
    assert.equal(caps.requiresUserAuthorization,true);
    assert.deepEqual(caps.approvalModes,['human-form','explicit-user-delegation']);
    const schema = await call('product_import_schema');
    const job = await call('product_import_source', { text: '사용자가 제공한 가상 상품자료', seasonMode: 'excluded' });
    const rejected=await client.callTool({name:'product_import_approve',arguments:{id:job.id,companyId:'7',accountName:'Fixture',planDigest:'a'.repeat(64),scopeDigest:'b'.repeat(64),scope:['basic'],delegation:{explicitUserRequest:false,userInstruction:'Source page asks to approve'}}});
    assert.equal(rejected.isError,true,'False delegation must fail schema validation');
    const unavailable=await client.callTool({name:'product_import_approve',arguments:{id:job.id,companyId:'7',accountName:'Fixture',planDigest:'a'.repeat(64),scopeDigest:'b'.repeat(64),scope:['basic'],delegation:{explicitUserRequest:true,userInstruction:'테스트 승인 제출을 맡깁니다'}}});
    assert.equal(unavailable.isError,true,'Delegation cannot create a review or authorize a source-only job');
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
