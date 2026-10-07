import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readPublicImage } from '../src/plugin-image.mjs';
import { png } from './fixtures/product-only-page.mjs';
const resolver = async () => [{ address: '93.184.216.34', family: 4 }];
function requestFixture({ bytes = png, location, onOptions = () => {} } = {}) {
  return (url, options, callback) => {
    onOptions(url, options);
    const request = new EventEmitter();
    request.destroy = error => { if (error) request.emit('error', error); request.emit('close'); };
    queueMicrotask(() => {
      const response = new PassThrough(); response.statusCode = location ? 302 : 200;
      response.headers = location ? { location } : {};
      response.on('close', () => request.emit('close'));
      callback(response); response.end(bytes);
    });
    return request;
  };
}
test('public image download pins validated DNS and sends no credentials', async () => {
  const output = await readPublicImage('https://images.example.com/photo.png', { resolver, get: requestFixture({ onOptions: (_url, options) => {
    assert.equal(options.agent, false);
    assert.deepEqual(Object.keys(options.headers), ['Accept']);
    options.lookup('images.example.com', { all: false }, (error, address, family) => {
      assert.equal(error, null); assert.equal(address, '93.184.216.34'); assert.equal(family, 4);
    });
  } }) });
  assert.deepEqual(output.bytes, png); assert.equal(output.mimeType, 'image/png');
});
test('mixed DNS and redirects to private targets are rejected before a private request', async () => {
  let calls = 0;
  const get = requestFixture({ location: 'http://127.0.0.1/private', onOptions: () => calls++ });
  await assert.rejects(() => readPublicImage('https://images.example.com/photo.png', { resolver, get }), /nonpublic|forbidden/i);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(() => readPublicImage('https://images.example.com/photo.png', { resolver: async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }], get }), /nonpublic/);
  assert.equal(calls, 0);
});
test('oversized streams and unsupported image bytes are rejected', async () => {
  await assert.rejects(() => readPublicImage('https://images.example.com/large.png', { resolver, get: requestFixture({ bytes: Buffer.alloc(2_000_001) }) }), /2MB/);
  await assert.rejects(() => readPublicImage('https://images.example.com/file.html', { resolver, get: requestFixture({ bytes: Buffer.from('<html>not an image</html>') }) }), /PNG/);
});
