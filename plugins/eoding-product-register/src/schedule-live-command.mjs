import { buildPlan } from './core.mjs';

// Interactive CLI orchestration only; the workflow independently validates and claims.
// This helper is not an approval API and is not exposed through MCP.
export async function runLiveScheduleCommand({product,target,schedule,browser,flow,prompt,report}) {
  ({product,target,schedule}=structuredClone({product,target,schedule}));
  if(!buildPlan(product).readyForReview)throw new Error('상품 검증이 필요합니다');
  report(await browser.open());
  await prompt('전용 브라우저에서 직접 로그인하고 대상 비공개 상품 기본정보를 확인한 뒤 Enter: ');
  const review=await flow.prepareLiveSchedule(product,target,schedule);
  report(review);
  const tenant=await prompt('ERP 화면에서 직접 확인한 회사명: ');
  if(tenant!==product.company.tenant)throw new Error('회사 확인 불일치');
  const answer=await prompt(`기존 비공개 상품에 표시된 일정표 기본틀 1건만 저장하려면 APPROVE ${review.id} 입력: `);
  if(answer!==`APPROVE ${review.id}`)throw new Error('승인하지 않았습니다');
  await flow.store.approve(review.id,review.hash,{tenantObserved:tenant,method:'interactive-cli-tenant-readback'});
  const result=await flow.execute(review.id);
  report(result);
  return result;
}
