import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { validatePublicUrl } from './source.mjs';

const LIMIT = 2_000_000;
export function imageMime(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  throw new Error('PNG/JPEG/WebP 원본 이미지만 지원합니다.');
}

/** Credential-free bounded download. Pin the validated DNS answer for this request. */
export async function readPublicImage(input, { resolver = lookup, redirects = 0, get } = {}) {
  let answers;
  const url = await validatePublicUrl(input, { resolver: async (host, options) => {
    answers = await resolver(host, options); return answers;
  } });
  if (redirects > 3) throw new Error('이미지 리디렉션이 너무 많습니다.');
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = (get ?? transport.get.bind(transport))(url, {
      agent: false,
      headers: { Accept: 'image/png,image/jpeg,image/webp' },
      lookup: (_host, options, callback) => {
        const entry = answers?.[0];
        if (!entry) return callback(new Error('Validated DNS answer missing'));
        callback(null, ...(options.all ? [[entry]] : [entry.address, entry.family]));
      }
    }, response => {
      if ([301,302,303,307,308].includes(response.statusCode)) {
        response.resume();
        if (!response.headers.location) return reject(new Error('이미지 이동 주소가 없습니다.'));
        let next;
        try { next = new URL(response.headers.location, url).href; } catch (error) { reject(error); return; }
        resolve(readPublicImage(next, { resolver, redirects: redirects + 1, get })); return;
      }
      if (response.statusCode !== 200) { response.resume(); reject(new Error('이미지 다운로드 실패: HTTP ' + response.statusCode)); return; }
      if (Number(response.headers['content-length']) > LIMIT) { response.destroy(); reject(new Error('이미지는 2MB 이하여야 합니다.')); return; }
      let size = 0; const chunks = [];
      response.on('data', chunk => {
        size += chunk.length;
        if (size > LIMIT) { response.destroy(); reject(new Error('이미지는 2MB 이하여야 합니다.')); }
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        try { const bytes = Buffer.concat(chunks); resolve({ bytes, mimeType: imageMime(bytes), sourceUrl: url.href }); }
        catch (error) { reject(error); }
      });
    });
    const deadline = setTimeout(() => request.destroy(new Error('이미지 다운로드 시간 초과')), 20000);
    request.on('close', () => clearTimeout(deadline));
    request.on('error', reject);
  });
}
