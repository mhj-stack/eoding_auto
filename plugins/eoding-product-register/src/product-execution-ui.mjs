import { startProductReviewUI } from './product-review-ui.mjs';

/** Explicit supported-scope runner. A blocked full request is never reduced. */
export async function startProductExecutionReviewUI({ coordinator, store, sessionId, input, ttlMs } = {}) {
  const executionInput = structuredClone(input);
  if (!coordinator || !['preflight','prepareApproval','execute'].every(name => typeof coordinator[name] === 'function')) throw new TypeError('실행 코디네이터가 필요합니다.');
  const checked = await coordinator.preflight(sessionId, executionInput);
  if (!checked.canExecute) throw new Error('등록 차단: ' + checked.blockers.map(item => `${item.stage}: ${item.reason}`).join('; '));
  await coordinator.prepareApproval(sessionId, executionInput);
  return startProductReviewUI({ store, sessionId, ...(ttlMs === undefined ? {} : {ttlMs}), onApproved: () => coordinator.execute(sessionId, executionInput) });
}
