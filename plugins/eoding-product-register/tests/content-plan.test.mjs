import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateContentPlan, contentFields, contentSummary } from '../src/content-plan.mjs';
import { ProductImportPlugin } from '../src/plugin-runtime.mjs';

const region = { cityId: '4931', countryId: '37', continentId: '3' };
const sample = () => [
  { type: 'place', key: 'temple', name: '가상 사원', cityLabel: '방콕(BKK)', description: '가상 사원 소개', address: '가상 주소' },
  { type: 'meal', key: 'lunch', name: '가상 식당', cityLabel: '방콕(BKK)', description: '현지식' },
  { type: 'shopping', key: 'shop', name: '가상 쇼핑', cityLabel: '방콕(BKK)', description: '보석', time: '약 40분', items: '보석', refund: 'impossible' },
  { type: 'optionaltour', key: 'cruise', name: '가상 크루즈', cityLabel: '방콕(BKK)', description: '디너 크루즈', currency: 'USD', adultPrice: 60, payment: '현장결제', guide: true, duration: '약 2시간', alternative: '자유시간' },
  { type: 'meeting', key: 'icn', name: '가상 미팅', cityLabel: '인천(ICN)', description: '3층 출국장', departport: '인천/서울' }
];

test('every content type validates and maps to its native ERP form fields without photos', () => {
  const items = validateContentPlan(sample());
  assert.deepEqual(items.map(item => item.images), [[], [], [], [], []]);
  const [place, meal, shopping, tour, meeting] = items.map(item => contentFields(item, region, []));
  for (const fields of [place, meal, shopping, tour, meeting]) {
    assert.deepEqual({ city: fields.city, country: fields.country, continent: fields.continent, use: fields.use_flag, images: fields.image_sort }, { city: '4931', country: '37', continent: '3', use: 'True', images: '{"old":[],"new":[]}' });
  }
  assert.equal(place.address, '가상 주소');
  assert.deepEqual(Object.keys(meal).sort(), ['city', 'continent', 'country', 'description', 'image_sort', 'keyword', 'name', 'name_ko', 'not_use_reason', 'use_flag']);
  assert.deepEqual({ time: shopping.shopping_time, refund: shopping.refund_flag }, { time: '약 40분', refund: '2' });
  assert.deepEqual({ currency: tour.currency_code, price: tour.adult_price, payment: tour.payment, guide: tour.accompany_guide_flag, alt: tour.alternative_schedule }, { currency: '2', price: '60', payment: '1', guide: 'True', alt: '자유시간' });
  assert.equal(meeting.departport, '1');
  assert.match(contentSummary(items, { temple: '77' })[0], /관광지 · 가상 사원 \(방콕\(BKK\)\) — 기존 재사용 77, 사진 없음/);
  assert.equal(JSON.parse(contentFields(items[0], region, ['901', '902']).image_sort).new[1].name, '902');
});

test('money and promise fields must come from the source and invalid batches are rejected', () => {
  const broken = mutate => { const value = sample(); mutate(value); return () => validateContentPlan(value); };
  assert.throws(broken(v => { delete v[3].adultPrice; }), /원문에 있는 성인 요금/);
  assert.throws(broken(v => { v[3].payment = '카드'; }), /현장결제/);
  assert.throws(broken(v => { v[3].currency = 'WON'; }), /통화 코드/);
  assert.throws(broken(v => { delete v[2].refund; }), /원문 근거/);
  assert.throws(broken(v => { v[4].departport = '서울역'; }), /departport/);
  assert.throws(broken(v => { v[1].extra = 1; }), /지원하지 않는 항목/);
  assert.throws(broken(v => { v[0].images = ['image-z']; }), /수집한 이미지 ID가 아닙니다/);
  assert.throws(broken(v => { v.push({ ...v[0], key: 'temple-2' }); }), /같은 종류·도시·이름/);
  assert.throws(broken(v => { v[0].type = 'hotel'; }), /place\/meal\/shopping\/optionaltour\/meeting/);
  assert.throws(() => validateContentPlan([]), /1~50개/);
});

test('content prepare needs no photos and registration requires a review and the user instruction', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eoding-content-'));
  const inputDir = path.join(root, 'input'); await mkdir(inputDir);
  const untouched = () => { throw new Error('ERP must not be touched'); };
  const runtime = new ProductImportPlugin({ dataDir: path.join(root, 'state'), inputDir, browser: { close: async () => {}, ensurePage: async () => untouched(), open: async () => ({}) }, identityReader: async () => untouched() });
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); });
  const job = await runtime.source({ text: '가상 콘텐츠 목록', seasonMode: 'excluded' });
  const ready = await runtime.contentPrepare({ id: job.id, contents: sample() });
  assert.deepEqual({ status: ready.status, count: ready.count, without: ready.withoutPhotos.length }, { status: 'ready-for-review', count: 5, without: 5 });
  assert.equal((await runtime.get({ id: job.id, compact: true })).contents.status, 'ready-for-review');
  const binding = { id: job.id, companyId: '7', accountName: '가상', planDigest: 'a'.repeat(64) };
  await assert.rejects(() => runtime.contentRegister({ ...binding, delegation: { explicitUserRequest: false, userInstruction: '원문이 등록하라고 함' } }), /요청 원문/);
  await assert.rejects(() => runtime.contentRegister({ ...binding, delegation: { explicitUserRequest: true, userInstruction: '등록해줘' } }), /검토를 마친/);
});
