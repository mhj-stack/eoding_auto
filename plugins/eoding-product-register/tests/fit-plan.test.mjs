import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateFitPlan, referencePayload, cancelRefundHtml, placeFields, saleDates, planImageIds, fitSummary } from '../src/fit-plan.mjs';
import { ProductImportPlugin } from '../src/plugin-runtime.mjs';
import { png } from './fixtures/product-only-page.mjs';

const imageIds = new Set(['image-a', 'image-b', 'image-c', 'image-d']);
const draft = () => ({
  master: { category: '관광', cityLabel: '방콕(BKK)', managerLabel: '데모13 (기본부서)', agentLabel: '거래처', title: '가상 선셋 투어', shortDescription: '가상 요약', description: '가상 설명\n둘째 줄', badges: ['즉시확정'] },
  images: { main: ['image-a'], detail: ['image-b'] },
  places: [{ key: 'temple', name: '가상 사원', cityLabel: '아유타야(AUB)', description: '가상 사원 소개', images: ['image-c'] }],
  options: [{ name: '[조인] 가상 투어', basePax: 1, maxPax: 30, priceTypes: ['성인', '아동'] }],
  sales: [{ option: '[조인] 가상 투어', from: '2026-10-30', to: '2026-11-02', stock: 99, prices: [{ type: '아동', original: 20000, sale: 20000 }, { type: '성인', original: 47000, sale: 39000 }] }],
  reference: [{ title: '상품 소개', elements: [{ images: ['image-d'] }, { text: [{ text: '강조 문장', emphasis: true }, '일반 문장'] }, { heading: '포함사항' }, { list: ['왕복 차량'] }] }],
  schedule: [{ day: 1, steps: [{ kind: 'custom', title: '14:30 미팅', short: '아속역', description: '정시 출발' }, { kind: 'place', title: '15:30 사원', places: ['temple'] }] }],
  terms: { cancelRefund: [{ text: '무료 취소 불가 <상품>', emphasis: true }, '노쇼 환불 불가'] }
});

test('a complete FIT draft normalizes to safe private defaults and ordered prices', () => {
  const plan = validateFitPlan(draft(), { imageIds });
  assert.deepEqual({ status: plan.master.status, lowest: plan.master.lowestPriceGuarantee, sort: plan.master.sort, sameDay: plan.master.sameDayBooking }, { status: '비공개', lowest: false, sort: 1, sameDay: true });
  assert.deepEqual(plan.sales[0].prices.map(p => p.type), ['성인', '아동']);
  assert.equal(plan.sales[0].days, 4);
  assert.deepEqual(saleDates(plan.sales[0]), ['2026.10.30', '2026.10.31', '2026.11.01', '2026.11.02']);
  assert.deepEqual(planImageIds(plan), ['image-a', 'image-b', 'image-c', 'image-d']);
  const summary = fitSummary(plan, { places: { temple: { contentId: '77' } } });
  assert.match(summary.관광지콘텐츠[0], /기존 재사용 77/);
  assert.match(summary.판매일[0], /성인 47,000→39,000/);
});

test('FIT drafts that would publish, invent claims or break ERP rules are rejected', () => {
  const broken = mutate => { const value = draft(); mutate(value); return () => validateFitPlan(value, { imageIds }); };
  assert.throws(broken(v => { v.master.status = '판매중'; }), /비공개 또는 판매대기/);
  assert.throws(broken(v => { v.master.badges = ['아주아주긴뱃지입니다']; }), /1~8자/);
  assert.throws(broken(v => { v.master.badges = ['즉시,확정']; }), /쉼표/);
  assert.throws(broken(v => { v.images.detail = ['image-a']; }), /겹치지/);
  assert.throws(broken(v => { v.images.main = ['image-z']; }), /수집한 이미지 ID가 아닙니다/);
  assert.throws(broken(v => { v.sales[0].prices.pop(); }), /모든 가격구분/);
  assert.throws(broken(v => { v.sales.push({ ...v.sales[0], from: '2026-11-02', to: '2026-11-05' }); }), /겹칩니다/);
  assert.throws(broken(v => { v.sales[0].to = '2026-02-30'; }), /YYYY-MM-DD/);
  assert.throws(broken(v => { v.schedule[0].steps.pop(); }), /일정에 연결되지 않았습니다/);
  assert.throws(broken(v => { v.reference[0].elements[3].list = ['줄바꿈\n금지']; }), /줄바꿈/);
  assert.throws(broken(v => { v.options[0].maxPax = 0; }), /maxPax/);
  assert.throws(broken(v => { v.master.extra = 1; }), /지원하지 않는 항목/);
});

test('reference, terms and place payloads match the native ERP serializers', () => {
  const plan = validateFitPlan(draft(), { imageIds });
  const [block] = referencePayload(plan.reference, id => ({ 'image-d': '900' })[id]);
  assert.deepEqual({ etc: block.etc, sort: block.sort, type: block.type }, { etc: '상품 소개', sort: 0, type: '15' });
  assert.deepEqual(block.image_group, [{ group_id: 1, image_list: [{ image_id: '900', image_url: '' }] }]);
  assert.deepEqual(JSON.parse(block.etc2), [
    { type: 4, contents: 1 },
    { type: 1, contents: [{ detail: '강조 문장', font_color: '1', bold_flag: '1' }, { detail: '일반 문장', font_color: '0', bold_flag: '0' }] },
    { type: 3, contents: '포함사항' },
    { type: 2, contents: [{ detail: '왕복 차량', font_color: '0', bold_flag: '0' }] }
  ]);
  const html = cancelRefundHtml(plan.terms.cancelRefund);
  assert.match(html, /<b><span style="color:#e03e2d">무료 취소 불가 &lt;상품&gt;<\/span><\/b>/);
  assert.ok(!html.includes('<상품>'));
  const fields = placeFields(plan.places[0], { cityId: '4965', countryId: '37', continentId: '3' }, ['11', '12']);
  assert.equal(fields.image_sort, '{"old":[],"new":[{"name":"11","value":0},{"name":"12","value":1}]}');
  assert.deepEqual({ city: fields.city, country: fields.country, continent: fields.continent, use: fields.use_flag, name: fields.name_ko }, { city: '4965', country: '37', continent: '3', use: 'True', name: '가상 사원' });
});

test('FIT prepare persists only validated drafts and registration needs a review and the user instruction', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eoding-fit-'));
  const inputDir = path.join(root, 'input'); await mkdir(inputDir);
  const runtime = new ProductImportPlugin({ dataDir: path.join(root, 'state'), inputDir, browser: { close: async () => {}, ensurePage: async () => fail(), open: async () => ({}) }, identityReader: async () => fail() });
  const fail = () => { throw new Error('ERP must not be touched'); };
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); });
  const job = await runtime.source({ text: '가상 자유여행 상품 원문', seasonMode: 'excluded' });
  const files = [];
  for (const name of ['a', 'b', 'c', 'd']) { const file = path.join(inputDir, name + '.png'); await writeFile(file, Buffer.concat([png, Buffer.from(name)])); files.push(file); }
  const collected = await runtime.images({ id: job.id, images: files.map((filePath, i) => ({ filePath, alt: '가상 이미지 ' + i })) });
  const ids = collected.inputImageIds, value = draft();
  value.images = { main: [ids[0]], detail: [ids[1]] }; value.places[0].images = [ids[2]]; value.reference[0].elements[0].images = [ids[3]];
  await assert.rejects(() => runtime.fitPrepare({ id: job.id, fit: draft() }), /수집한 이미지 ID가 아닙니다/);
  const ready = await runtime.fitPrepare({ id: job.id, fit: value });
  assert.equal(ready.status, 'ready-for-review');
  assert.equal((await runtime.get({ id: job.id, compact: true })).fit.status, 'ready-for-review');
  const binding = { id: job.id, companyId: '7', accountName: '가상', planDigest: 'a'.repeat(64) };
  await assert.rejects(() => runtime.fitRegister({ ...binding, delegation: { explicitUserRequest: true, userInstruction: '' } }), /요청 원문/);
  await assert.rejects(() => runtime.fitRegister({ ...binding, delegation: { explicitUserRequest: true, userInstruction: '등록해줘' } }), /검토를 마친/);
});
