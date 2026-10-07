import { z } from 'zod';
import { createHash } from 'node:crypto';

const text = z.string().trim().min(1).max(20000);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => {
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.valueOf()) && d.toISOString().slice(0,10) === s;
}, 'Invalid calendar date');
const amount = z.number().finite().nonnegative();
const money = z.object({ currency: z.string().regex(/^[A-Z]{3}$/), amount }).strict();
const price = z.object({
  adult: money, child: money.optional(), infant: money.optional(),
  basis: z.enum(['standard','member','promotion','unknown']),
  conditions: z.string().max(20000).optional(),
  fuelIncluded: z.boolean().nullable().optional(), taxIncluded: z.boolean().nullable().optional()
}).strict();
const flight = z.object({
  number: text, from: text, to: text,
  departureLocal: text, arrivalLocal: text,
  departureTimeZone: text.optional(), arrivalTimeZone: text.optional(),
  status: z.enum(['confirmed','planned','unknown'])
}).strict();
export const ProductSchema = z.object({
  schemaVersion: z.literal('1.0'),
  sources: z.array(z.object({ id:text, kind:z.enum(['url','excel','text']), reference:text, capturedAt:z.string().datetime() }).strict()).min(1).max(100),
  externalCode: text.optional(),
  title: text,
  destinations: z.array(text).min(1).max(100),
  tripType: z.enum(['domestic','overseas','unknown']),
  includesFlight: z.boolean().nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  nights: z.number().int().min(0).max(365).nullable(),
  days: z.number().int().min(1).max(366).nullable(),
  hotels: z.array(z.object({ name:text, status:z.enum(['confirmed','planned','unknown']), room:text.optional() }).strict()).max(200),
  itinerary: z.array(z.object({ day:z.number().int().min(1).max(366), title:text, description:text, meals:z.object({ breakfast:z.string(), lunch:z.string(), dinner:z.string() }).strict().optional() }).strict()).max(366),
  includes: z.array(text), excludes: z.array(text), cancellation: z.string().max(100000).nullable(),
  departures: z.array(z.object({ startDate:date, endDate:date, prices:z.array(price).min(1), selectedPrice:z.number().int().min(0).nullable(), flights:z.array(flight).max(100) }).strict()).max(1000),
  company: z.object({ tenant:text, manager:text.nullable(), city:text.nullable(), departurePoint:text.nullable(), vat:z.enum(['included','excluded','unknown']) }).strict(),
  evidence: z.array(z.object({ field:text, sourceId:text, location:text, quote:text }).strict()).max(10000),
  unresolved: z.array(text).max(1000)
}).strict();

export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
export function digest(value) { return createHash('sha256').update(canonical(value)).digest('hex'); }

export function validateProduct(input) {
  const parsed = ProductSchema.safeParse(input);
  if (!parsed.success) return { valid:false, readyForReview:false, errors:parsed.error.issues.map(x=>({field:x.path.join('.'),message:x.message})), warnings:[] };
  const p = parsed.data, errors = [], warnings = [];
  const issue = (field,message)=>errors.push({field,message});
  if (p.tripType === 'unknown') issue('tripType','국내/해외 구분 확인 필요');
  if (p.includesFlight === null) issue('includesFlight','항공 포함 여부 확인 필요');
  if (p.nights === null || p.days === null) issue('days','박/일 수 확인 필요');
  if (p.nights !== null && p.days !== null && p.nights >= p.days) issue('nights','숙박 수는 여행 일수보다 작아야 합니다');
  for (const key of ['manager','city','departurePoint']) if (!p.company[key]) issue('company.'+key,'회사별 필수 설정 확인 필요');
  if (p.company.vat === 'unknown') issue('company.vat','부가세 설정을 원문 가격에서 추정하지 마세요');
  if (!p.cancellation) issue('cancellation','취소규정 확인 필요');
  if (!p.departures.length) issue('departures','등록할 출발일 확인 필요');
  if (!p.itinerary.length) issue('itinerary','일자별 일정 확인 필요');
  const seenDays = new Set();
  for (const [i,d] of p.itinerary.entries()) {
    if (seenDays.has(d.day)) issue(`itinerary.${i}.day`,'중복 일차');
    seenDays.add(d.day);
    if (p.days !== null && d.day > p.days) issue(`itinerary.${i}.day`,'여행 일수를 초과한 일차');
  }
  if (p.days !== null && seenDays.size !== p.days) issue('itinerary','전체 일차가 있어야 합니다');
  const departures = new Set();
  p.departures.forEach((d,i)=>{
    const at = `departures.${i}`;
    if (d.endDate < d.startDate) issue(at+'.endDate','귀국일이 출발일보다 빠릅니다');
    const duration=(Date.parse(d.endDate)-Date.parse(d.startDate))/86400000+1;
    if (p.days !== null && duration!==p.days) warnings.push({field:at,message:'여행 일수와 달력상 기간이 다릅니다. 시차·날짜변경선을 확인하세요'});
    const key=d.startDate+'|'+d.endDate+'|'+d.flights.map(x=>x.number).join(',');
    if (departures.has(key)) issue(at,'동일 출발일·항공 조합 중복. 객실/요금 변형은 별도 검토 필요');
    departures.add(key);
    if (d.selectedPrice===null || !d.prices[d.selectedPrice]) issue(at+'.selectedPrice','등록할 요금 선택 필요');
    else {
      const selected=d.prices[d.selectedPrice];
      if (selected.basis==='unknown') issue(at+'.prices','요금 적용 기준 확인 필요');
      if (selected.basis!=='standard' && !selected.conditions) issue(at+'.prices','회원/프로모션 요금 적용 조건 필요');
      for (const kind of ['adult','child','infant']) if (selected[kind] && selected[kind].currency!==p.currency) issue(at+'.prices.'+kind,'상품 통화와 요금 통화 불일치');
      if (selected.adult.amount===0) warnings.push({field:at,message:'성인가 0원: 의도한 값인지 검토하세요'});
    }
    if (p.includesFlight && !d.flights.length) issue(at+'.flights','항공 포함 상품의 항공정보 누락');
  });
  const sourceIds = new Set(p.sources.map(s=>s.id));
  if(sourceIds.size!==p.sources.length) issue('sources','중복 출처 ID');
  for (const e of p.evidence) if(!sourceIds.has(e.sourceId)) issue('evidence','존재하지 않는 sourceId: '+e.sourceId);
  const requiredEvidence=['title','destinations','tripType','includesFlight','currency','nights','days','itinerary','cancellation','departures'];
  for(const field of requiredEvidence) if(!p.evidence.some(e=>e.field===field || e.field.startsWith(field+'.'))) issue('evidence.'+field,'원문 또는 사용자 결정 근거 필요');
  if(p.hotels.some(h=>h.status!=='confirmed')) warnings.push({field:'hotels',message:'예정/미확정 호텔을 확정으로 바꾸지 마세요'});
  for(const q of p.unresolved) issue('unresolved',q);
  warnings.push({field:'duplicateCheck',message:'로컬 fingerprint는 ERP 중복 검사가 아닙니다. ERP 조회 별도 필요'});
  return { valid:true, readyForReview:errors.length===0, errors, warnings, product:p };
}

export function buildPlan(input) {
  const result=validateProduct(input);
  if(!result.valid) return result;
  const p=result.product;
  // Identity excludes capture timestamp/quotes. Changes in commercial data still require ERP reconciliation.
  const fingerprint=digest({tenant:p.company.tenant, externalCode:p.externalCode ?? null,title:p.title,destinations:p.destinations,departures:p.departures.map(d=>({startDate:d.startDate,endDate:d.endDate,flights:d.flights}))});
  return { ...result, planId:digest(p), fingerprint,
    adapter:{name:'eoding-browser',version:'0.5.0-alpha.2',canPrepareCreation:p.currency==='KRW',canCommitBasicWithLocalApproval:p.currency==='KRW',canCommitScheduleDaysWithLocalApproval:true,canCommitFullProduct:false,canCommit:false},
    stages:[
      {name:'source-analysis',status:'completed-by-calling-agent'},
      {name:'schema-validation',status:result.readyForReview?'passed':'blocked'},
      {name:'erp-duplicate-check',status:'pending'},
      {name:'creation-settings',status:p.currency==='KRW'?'requires-local-human-approval':'unsupported-currency'},
      {name:'product-itinerary-departure-save',status:'blocked-unverified-adapter'}
    ],
    notice:'등록 계획입니다. 아직 ERP에 저장하지 않았습니다. 비공개 기본정보 저장은 별도 사용자 승인 흐름으로 실행합니다. 빈 일차 텍스트·식사는 별도 승인 흐름으로 저장할 수 있습니다. 일정표 생성/기존 일정 덮어쓰기/행사/항공/호텔/가격 저장은 미지원입니다.'
  };
}

export function buildBatchPlan(inputs) {
  if(!Array.isArray(inputs) || inputs.length<1 || inputs.length>100) throw new Error('배치는 상품 1~100개 배열이어야 합니다');
  const plans=inputs.map(buildPlan), seen=new Map(), duplicates=[];
  plans.forEach((plan,index)=>{
    if(!plan.fingerprint)return;
    if(seen.has(plan.fingerprint)) duplicates.push({index,duplicateOf:seen.get(plan.fingerprint),fingerprint:plan.fingerprint});
    else seen.set(plan.fingerprint,index);
  });
  return {count:plans.length,readyForReview:duplicates.length===0 && plans.every(p=>p.readyForReview),canCommit:false,duplicates,plans,notice:'배치 내 후보 중복 검사만 수행했습니다. ERP 등록/중복 조회는 수행하지 않았습니다.'};
}
