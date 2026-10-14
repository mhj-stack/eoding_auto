import { isDeepStrictEqual as same } from 'node:util';
import { createProductOnlyApprovalBinding } from './product-only-execution.mjs';
const fail = message => { throw new Error(`이어하기 차단: ${message}`); };

function originalRun(plan, events) {
  if (!same(plan?.approvalBinding, createProductOnlyApprovalBinding(plan)) || plan.seasonMode === 'excluded') fail('원래 계획과 승인 범위가 다릅니다.');
  if (!Array.isArray(events) || !events.length) fail('원래 저장 장부가 없습니다.');
  const claims = events.filter(row => row.kind === 'approval-claim');
  const approvals = events.filter(row => row.kind === 'human-approval');
  if (claims.length !== 1 || approvals.length !== 1 || claims[0].claim?.planDigest !== plan.approvalBinding.planDigest || claims[0].claim?.scopeDigest !== plan.approvalBinding.scopeDigest || approvals[0].approval?.planDigest !== plan.approvalBinding.planDigest || approvals[0].approval?.scopeDigest !== plan.approvalBinding.scopeDigest) fail('원래 승인과 실행 기록을 확인할 수 없습니다.');
  if (events.some(row => row.kind === 'completed')) fail('이미 완료된 작업입니다.');
  const evidence = events.filter(row => row.kind === 'coordinator-evidence').map(row => row.value);
  const content = ['basic', 'media', 'shell', ...plan.itinerary.map(day => `day:${day.day}`)];
  const prepared = phase => {
    const values = events.filter(row => row.kind === 'write-authorized' && row.event?.phase === phase);
    if (values.length !== 1 || !values[0].event.prepared) fail(`${phase} 저장 전 입력 근거가 없습니다.`);
    return structuredClone(values[0].event.prepared);
  };
  return { evidence, content, prepared };
}

function seed({ evidence, content, prepared }, verifiedPhases, extra = {}) {
  const verified = evidence.filter(row => row.status === 'receipt-verified');
  if (!same(verified.map(row => row.phase), verifiedPhases) || verified.some(row => !row.result?.verification || row.result.name !== row.phase)) fail(`기본·이미지·상세·모든 일차${verifiedPhases.includes('season') ? '·시즌' : ''}의 저장 확인이 필요합니다.`);
  const receipts = verified.map(row => structuredClone(row.result));
  const [basic, media, shell, ...days] = receipts.slice(0, content.length).map(row => row.receipt);
  const checkpoint = { basic, media, shell, days, shellBefore: prepared('shell').before, dayPrepared: days.map(day => prepared(`day:${day.day}`)), ...extra };
  return { results: receipts, checkpoint, targets: { mode: 'NEW', productId: basic.productId, masterCode: basic.masterCode, scheduleId: shell.scheduleId } };
}

/** Narrow recovery boundary: all content saved, season never authorized. Unknown writes never replay. */
export function seasonResumeCheckpoint(plan, events) {
  const run = originalRun(plan, events);
  if (events.some(row => row.kind === 'write-authorized' && ['season', 'departure'].includes(row.event?.phase) || row.kind === 'adapter-evidence' && ['season', 'departure'].includes(row.event?.phase))) fail('시즌/행사 쓰기를 이미 승인했거나 실행한 기록이 있습니다. 먼저 독립 재조회가 필요합니다.');
  const result = seed(run, run.content);
  const starts = run.evidence.filter(row => row.status === 'before-write').map(row => row.phase);
  if (!same(starts, [...run.content, 'season']) || run.evidence.at(-1)?.status !== 'unknown-save-outcome' || run.evidence.at(-1)?.phase !== 'season') fail('시즌 준비 중 중단된 기록만 지원합니다.');
  return { ...result, remaining: ['season'] };
}

/**
 * Departure-only recovery: content and season saved and verified, the event stopped while the form
 * was still being prepared. Any departure write authorization, adapter attempt or pre-POST record
 * means a create may have been forwarded, so those runs stay in reconciliation.
 */
export function departureResumeCheckpoint(plan, events) {
  if (plan?.departure?.create !== true) fail('행사를 요청한 작업이 아닙니다.');
  const run = originalRun(plan, events);
  if (events.some(row => row.event?.phase === 'departure' && ['write-authorized', 'adapter-evidence'].includes(row.kind) || row.kind === 'departure-before-post' || row.event?.kind === 'departure-before-post')) fail('행사 쓰기를 이미 승인했거나 실행한 기록이 있습니다. 먼저 독립 재조회가 필요합니다.');
  const result = seed(run, [...run.content, 'season']);
  const starts = run.evidence.filter(row => row.status === 'before-write').map(row => row.phase);
  if (!same(starts, [...run.content, 'season', 'departure']) || run.evidence.at(-1)?.status !== 'unknown-save-outcome' || run.evidence.at(-1)?.phase !== 'departure') fail('행사 준비 중 중단된 기록만 지원합니다.');
  const season = result.results.at(-1).receipt;
  if (season?.kind !== 'season-save-receipt-v1' || season.target?.productId !== String(result.targets.productId) || !/^[1-9]\d*$/.test(String(season.seasonId))) fail('저장 확인된 시즌 영수증이 없습니다.');
  result.checkpoint.season = { seasonId: String(season.seasonId), receipt: structuredClone(season) };
  return { ...result, remaining: ['departure'] };
}

/** Pick the single supported recovery boundary for an interrupted run. */
export function resumeCheckpoint(plan, events) {
  const last = (Array.isArray(events) ? events : []).filter(row => row.kind === 'coordinator-evidence').at(-1)?.value?.phase;
  return last === 'departure' ? departureResumeCheckpoint(plan, events) : seasonResumeCheckpoint(plan, events);
}
