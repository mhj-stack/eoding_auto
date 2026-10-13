import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { verifyApprovedProductOnlyCdnImage } from '../src/product-only-launcher.mjs';

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x46, 0x58]);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const src = 'https://media.eoding.com/media/travelagent/7/imagecontent/fixture.jpg';
const source = { mimeType: 'image/jpeg', sha256: hash(jpeg) };
const response = ({ bytes = jpeg, contentType = 'image/jpeg', ...overrides } = {}) => ({
  ok: true, url: src, redirected: false,
  headers: new Headers({ 'content-type': contentType }), body: new Response(bytes).body, ...overrides
});

test('CDN verification accepts exact approved JPEG bytes and MIME', async () => {
  let reads = 0;
  const result = await verifyApprovedProductOnlyCdnImage({ receipt: { src }, source, companyId: '7', fetchImpl: async (url, options) => {
    reads++; assert.equal(String(url), src); assert.equal(options.method, 'GET'); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error'); assert.equal(options.headers.Accept, 'image/jpeg');
    return response();
  } });
  assert.equal(reads, 1); assert.deepEqual(result, { tenantId: '7', src, sha256: source.sha256, bytes: jpeg.length });
});

for (const invalid of [{ sha256: source.sha256 }, { ...source, mimeType: 'image/jpg' }, { ...source, sha256: '' }]) test(`CDN verification rejects unbound source metadata ${JSON.stringify(invalid)}`, async () => {
  let reads = 0;
  await assert.rejects(verifyApprovedProductOnlyCdnImage({ receipt: { src }, source: invalid, companyId: '7', fetchImpl: async () => { reads++; return response(); } }), /Approved image MIME and SHA-256 are required/);
  assert.equal(reads, 0);
});

for (const receiptSrc of [src.replace('/7/', '/8/'), src.replace('/imagecontent/', '/other/'), src + '?other=1']) test(`CDN verification retains exact tenant and path checks: ${receiptSrc}`, async () => {
  let reads = 0;
  await assert.rejects(verifyApprovedProductOnlyCdnImage({ receipt: { src: receiptSrc }, source, companyId: '7', fetchImpl: async () => { reads++; return response(); } }), /outside the exact company CDN prefix/);
  assert.equal(reads, 0);
});

for (const scenario of [
  { name: 'different response MIME', reply: { contentType: 'image/png' }, error: /MIME differs/ },
  { name: 'changed JPEG bytes', reply: { bytes: Buffer.concat([jpeg, Buffer.from([1])]) }, error: /SHA-256 differs/ },
  { name: 'redirected image', reply: { redirected: true }, error: /exact approved URL/ },
  { name: 'different image URL', reply: { url: src.replace('fixture.jpg', 'other.jpg') }, error: /exact approved URL/ }
]) test(`CDN verification rejects ${scenario.name}`, async () => {
  await assert.rejects(verifyApprovedProductOnlyCdnImage({ receipt: { src }, source, companyId: '7', fetchImpl: async () => response(scenario.reply) }), scenario.error);
});

test('CDN verification detects a false JPEG MIME even when the approved hash matches', async () => {
  const bytes = Buffer.from('not a JPEG image');
  await assert.rejects(verifyApprovedProductOnlyCdnImage({ receipt: { src }, source: { ...source, sha256: hash(bytes) }, companyId: '7', fetchImpl: async () => response({ bytes }) }), /SHA-256 differs/);
});
