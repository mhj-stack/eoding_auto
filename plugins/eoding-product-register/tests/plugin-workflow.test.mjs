import test from 'node:test';
import assert from 'node:assert/strict';
import { flightPreflight, flightMinutes, workflowTiming, changeWait, sourceQuality } from '../src/plugin-workflow.mjs';
import { createProductOnlyApprovalBinding, ProductOnlyExecutionCoordinator } from '../src/product-only-execution.mjs';
import { departurePreflight, departureExpected, assertDepartureForm } from '../src/plugin-departure.mjs';
import { seasonResumeCheckpoint, departureResumeCheckpoint, resumeCheckpoint } from '../src/plugin-resume.mjs';
import { scopeFor } from '../src/product-only-review.mjs';

const season = () => ({ fields: { 'depart-0-depart_date': '2026-11-01', 'depart-0-depart_time': '10:05', 'depart-0-arrive_time': '12:45', 'depart-0-moving_time': '160', 'arrive-0-depart_date': '2026-11-04', 'arrive-0-depart_time': '14:05', 'arrive-0-arrive_time': '17:30', 'arrive-0-moving_time': '205', currency_code: 'KRW', adult_base_price: '1078600', child_base_price: '1078600', infant_base_price: '107860', adult_fuel_price: '120400', child_fuel_price: '120400', infant_fuel_price: '0', min_pax_count: '10', max_pax_count: '10' }, selects: { departport: '1' }, selectedDates: ['2026-11-01'] });
test('flight duration: observed round trip, timezone difference, date rollover and ambiguous local times', () => {
  assert.equal(flightMinutes('2026-11-01T10:05+09:00', '2026-11-01T12:45+09:00'), 160);
  assert.equal(flightMinutes('2026-11-04T14:05+09:00', '2026-11-04T17:30+09:00'), 205);
  assert.equal(flightMinutes('2026-11-01T23:00+09:00', '2026-11-02T01:00+08:00'), 180);
  assert.throws(() => flightMinutes('2026-11-01T10:00', '2026-11-01T12:00'), /시차/);
  assert.throws(() => flightMinutes('2026-02-30T10:00Z', '2026-03-01T12:00Z'), /날짜/);
});
test('flight preflight catches both missing durations and understands native previous-day code', () => {
  const value = season(), departure = { startDate: '2026-11-01', endDate: '2026-11-04' };
  assert.deepEqual(flightPreflight(value, departure), []);
  delete value.fields['depart-0-moving_time']; delete value.fields['arrive-0-moving_time'];
  assert.equal(flightPreflight(value, departure).filter(item => item.field.endsWith('moving_time')).length, 2);
  const overnight = season(); overnight.fields['arrive-0-depart_date'] = '2026-11-05'; overnight.selects['arrive-0-next_day'] = '3';
  assert.deepEqual(flightPreflight(overnight, departure), []);
});
test('20-minute target includes user waits, deduplicates active wait, and freezes at final readback', () => {
  const job = { startedAt: new Date(1000).toISOString() };
  changeWait(job, 'login', 1000); changeWait(job, 'login', 2000); changeWait(job, null, 61000);
  changeWait(job, 'missing-input', 61000); changeWait(job, 'approval', 121000); changeWait(job, null, 181000);
  job.finishedAt = new Date(1261000).toISOString();
  const value = workflowTiming(job, 9000000);
  assert.equal(value.elapsedMs, 1260000); assert.equal(value.userWaitMs, 180000);
  assert.equal(value.processingAndCoordinationMs, 1080000); assert.equal(value.targetMet, false);
  assert.equal(value.warning, 'over-target'); assert.equal(job.waits.length, 3);
  assert.throws(() => changeWait(job, 'erp-save'), /대기 사유/);
});
test('menu-only capture is marked incomplete, not silently accepted as product evidence', () => {
  assert.equal(sourceQuality({ kind: 'url', evidence: { text: '로그인 메뉴 국내여행 해외여행' } }).needsBrowserRead, true);
});
test('event scope binds one departure, existing season, separate base and fuel, and approved status', () => {
  const plan = { product: { title: '가상 상품', currency: 'KRW' }, season: season(), departure: { create: true, status: '3' } };
  assert.equal(departurePreflight(plan).canExecute, true);
  assert.ok(scopeFor(plan).includes('departure'));
  const expected = departureExpected(plan, { productId: 123, scheduleId: 456 }, '789');
  assert.equal(expected.adult_price, '1078600'); assert.equal(expected.adult_fuel_price, '120400');
  const entries = Object.entries({ ...expected, selected_dates: '2026-11-01' });
  assertDepartureForm(entries, expected, '2026-11-01');
  assert.throws(() => assertDepartureForm(entries.map(([key, value]) => [key, key === 'season' ? '' : value]), expected, '2026-11-01'), /season/);
  plan.departure.status = '6'; assert.equal(departurePreflight(plan).canExecute, false);
});

test('soft time target never abandons remaining writes or final verification at 20 minutes', async () => {
  let now = 0; const writes = [], events = [];
  const plan = { productId: '1', basic: {}, display: { images: [{ sourceImageId: 'i' }] }, content: {}, shell: {}, seasonMode: 'excluded', source: { rows: [{ id: 'r' }], images: [{ id: 'i' }] }, itinerary: [{ day: 1, sourceRowId: 'r' }] };
  const adapters = Object.fromEntries(['basic', 'display', 'content', 'shell', 'day'].map(name => [name, { async save() { writes.push(name); now += 6 * 60000; return {}; }, async verifyReceipt() { return true; } }]));
  adapters.finalCheck = { async get() { writes.push('final'); return { ok: true }; }, async verify() { return true; } };
  const coordinator = new ProductOnlyExecutionCoordinator({ clock: () => now, budgetMode: 'report', adapters, browser: { async open() { return { page: {}, async close() {} }; } }, approval: { async claim() { return {}; } }, journal: { async start() { return { mode: 'wx', path: 'fixture' }; }, async append(value) { events.push(value); }, async checkpoint() {} } });
  const result = await coordinator.execute(plan);
  assert.equal(result.status, 'completed-over-budget'); assert.equal(result.finalCheck.status, 'verified'); assert.equal(writes.at(-1), 'final');
  assert.equal(result.phases.length, 5); assert.equal(result.phases[0].durationMs, 360000);
});

test('resume accepts only a complete saved prefix before any season authorization', () => {
  const plan = { target: { mode: 'NEW' }, itinerary: [{ day: 1, sourceRowId: 'r' }], product: {}, source: { rows: [], images: [] }, display: { images: [] }, season: {} };
  plan.approvalBinding = createProductOnlyApprovalBinding(plan);
  const phases = ['basic', 'media', 'shell', 'day:1'];
  const events = [{ kind: 'human-approval', approval: plan.approvalBinding }, { kind: 'approval-claim', claim: plan.approvalBinding }];
  for (const phase of phases) {
    events.push({ kind: 'coordinator-evidence', value: { status: 'before-write', phase } });
    events.push({ kind: 'write-authorized', event: { phase, prepared: { before: {} } } });
    events.push({ kind: 'coordinator-evidence', value: { status: 'receipt-verified', phase, result: { name: phase, verification: true, receipt: { productId: 1, masterCode: 'CODE', scheduleId: 2, ...(phase.startsWith('day') ? { day: 1 } : {}) } } } });
  }
  events.push({ kind: 'coordinator-evidence', value: { status: 'before-write', phase: 'season' } }, { kind: 'coordinator-evidence', value: { status: 'unknown-save-outcome', phase: 'season' } });
  assert.equal(seasonResumeCheckpoint(plan, events).targets.productId, 1);
  assert.throws(() => seasonResumeCheckpoint(plan, [...events, { kind: 'write-authorized', event: { phase: 'season' } }]), /독립 재조회/);
  assert.throws(() => seasonResumeCheckpoint(plan, events.filter(item => item.value?.phase !== 'day:1')), /모든 일차/);
});

test('event form accepts the live ERP calendar date already copied into selected_dates', () => {
  const plan = { product: { title: '가상 상품', currency: 'KRW' }, season: season(), departure: { create: true, status: '3' } };
  const expected = departureExpected(plan, { productId: 123, scheduleId: 456 }, '789');
  assertDepartureForm(Object.entries({ ...expected, selected_dates: '' }), expected, '');
  assertDepartureForm(Object.entries({ ...expected, selected_dates: '2026-11-01' }), expected, '2026-11-01');
  assert.throws(() => assertDepartureForm(Object.entries({ ...expected, selected_dates: '2026-11-01,2026-11-02' }), expected, '2026-11-01'), /selected_dates.*실제/);
});

test('departure-only resume needs a verified season and no departure write attempt', () => {
  const plan = { target: { mode: 'NEW' }, itinerary: [{ day: 1, sourceRowId: 'r' }], product: {}, source: { rows: [], images: [] }, display: { images: [] }, season: {}, departure: { create: true, status: '3' } };
  plan.approvalBinding = createProductOnlyApprovalBinding(plan);
  const events = [{ kind: 'human-approval', approval: plan.approvalBinding }, { kind: 'approval-claim', claim: plan.approvalBinding }];
  for (const phase of ['basic', 'media', 'shell', 'day:1', 'season']) {
    const receipt = phase === 'season' ? { kind: 'season-save-receipt-v1', seasonId: '77', target: { productId: '1' } } : { productId: 1, masterCode: 'CODE', scheduleId: 2, ...(phase.startsWith('day') ? { day: 1 } : {}) };
    events.push({ kind: 'coordinator-evidence', value: { status: 'before-write', phase } });
    events.push({ kind: 'write-authorized', event: { phase, prepared: { before: {} } } });
    events.push({ kind: 'coordinator-evidence', value: { status: 'receipt-verified', phase, result: { name: phase, verification: true, receipt } } });
  }
  events.push({ kind: 'coordinator-evidence', value: { status: 'before-write', phase: 'departure' } }, { kind: 'coordinator-evidence', value: { status: 'unknown-save-outcome', phase: 'departure' } });
  const seed = resumeCheckpoint(plan, events);
  assert.deepEqual(seed.remaining, ['departure']); assert.equal(seed.checkpoint.season.seasonId, '77'); assert.equal(seed.results.length, 5);
  assert.deepEqual(scopeFor({ ...plan, resumeFrom: { remaining: seed.remaining } }), ['departure']);
  assert.throws(() => resumeCheckpoint(plan, [...events.slice(0, -1), { kind: 'write-authorized', event: { phase: 'departure' } }, events.at(-1)]), /독립 재조회/);
  assert.throws(() => resumeCheckpoint(plan, [...events.slice(0, -1), { kind: 'adapter-evidence', event: { phase: 'departure', kind: 'departure-before-post' } }, events.at(-1)]), /독립 재조회/);
  assert.throws(() => departureResumeCheckpoint(plan, events.filter(item => item.value?.phase !== 'season' || item.value.status !== 'receipt-verified')), /시즌/);
});
