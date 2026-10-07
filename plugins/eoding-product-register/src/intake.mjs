import { buildPlan, validateProduct } from './core.mjs';

const QUESTION_GROUPS = [
  ['source', '출처', ['sources'], '검토할 원문 출처를 확인해 주세요.'],
  ['basic', '상품 기본정보', ['title', 'destinations', 'tripType', 'includesFlight', 'currency'], '상품명·목적지·국내/해외·항공 포함 여부·통화를 확인해 주세요.'],
  ['duration', '여행 기간', ['nights', 'days'], '여행 박수와 일수를 확인해 주세요.'],
  ['company', '회사 설정', ['company', 'company.manager', 'company.city', 'company.departurePoint', 'company.vat'], '담당자·도시·출발지·부가세를 포함한 회사 설정을 확인해 주세요.'],
  ['itinerary', '일정', ['itinerary'], '일자별 일정을 확인해 주세요.'],
  ['cancellation', '취소규정', ['cancellation'], '취소규정을 확인해 주세요.'],
  ['departure', '출발일 및 요금', ['departures'], '등록할 출발일과 적용 요금을 확인해 주세요.'],
  ['evidence', '근거', ['evidence'], '원문 또는 사용자 결정 근거를 연결해 주세요.'],
  ['unresolved', '미해결 항목', ['unresolved'], '미해결 항목을 확인해 주세요.']
];
const NORMALIZATION_FIELDS = new Set(['schemaVersion', 'hotels', 'includes', 'excludes', 'unresolved']);

function valueAt(input, path) {
  return path.split('.').reduce((value, key) => value && typeof value === 'object' ? value[key] : undefined, input);
}
function isMissing(input, field) {
  const value = valueAt(input, field);
  return value === undefined || value === null;
}
function groupFor(field) {
  return QUESTION_GROUPS.find(([, , fields]) => fields.some(candidate => field === candidate || field.startsWith(candidate + '.')));
}
function evidenceReferences(input) {
  if (!Array.isArray(input?.evidence)) return [];
  return input.evidence.filter(reference => reference && typeof reference === 'object').map(reference => ({
    field:reference.field, sourceId:reference.sourceId, location:reference.location, quote:reference.quote
  }));
}
function evidenceFor(input, fields) {
  if (!Array.isArray(input?.evidence)) return [];
  return input.evidence.filter(reference => reference && typeof reference === 'object' && typeof reference.field === 'string' &&
    fields.some(field => reference.field === field || reference.field.startsWith(field + '.') || field.startsWith(reference.field + '.')))
    .map(reference => ({ field:reference.field, sourceId:reference.sourceId, location:reference.location, quote:reference.quote }));
}
function questionFields(group, issues, input) {
  if (group[0] === 'duration') {
    const unknown = group[2].filter(field => isMissing(input, field));
    if (unknown.length) return unknown;
  }
  return [...new Set(issues.map(issue => issue.field))];
}
function question(group, issues, input) {
  const [id, title] = group;
  const fields = questionFields(group, issues, input);
  return { id, type:'missing-choice', title, prompt:group[3], fields,
    messages:[...new Set(issues.map(issue => issue.message))], evidence:evidenceFor(input, fields) };
}
function needsChoice(input, validation, issue, group) {
  if (!group) return false;
  if (isMissing(input, issue.field)) return true;
  if (group[0] === 'duration' && group[2].some(field => isMissing(input, field))) return true;
  if (group[0] === 'basic' && ['tripType', 'includesFlight'].some(field => valueAt(input, field) === 'unknown' || valueAt(input, field) === null)) return true;
  if (group[0] === 'company' && (valueAt(input, 'company.vat') === 'unknown' || group[2].some(field => isMissing(input, field)))) return true;
  if (group[0] === 'itinerary' && Array.isArray(input?.itinerary) && input.itinerary.length === 0) return true;
  if (group[0] === 'departure' && Array.isArray(input?.departures) && input.departures.length === 0) return true;
  if (group[0] === 'evidence' && /^evidence\./.test(issue.field)) return true;
  if (group[0] === 'unresolved') return true;
  if (issue.field.endsWith('.selectedPrice') && /등록할 요금 선택 필요/.test(issue.message)) return isMissing(input, issue.field);
  if (validation.valid && /요금 적용 기준 확인 필요|요금 적용 조건 필요|항공정보 누락/.test(issue.message)) return true;
  return false;
}
function invalid(issues, input) {
  if (!issues.length) return [];
  return [{ id:'normalization-input', type:'invalid-input', title:'정규화 입력 확인',
    fields:[...new Set(issues.map(issue => issue.field))], messages:[...new Set(issues.map(issue => issue.message))],
    evidence:evidenceFor(input, issues.map(issue => issue.field)) }];
}
function scopes(plan) {
  const basic = Boolean(plan.adapter?.canCommitBasicWithLocalApproval);
  const day = Boolean(plan.adapter?.canCommitScheduleDaysWithLocalApproval);
  const unavailable = scope => ({ scope, supported:false, status:'unsupported', reason:'현재 어댑터에서 저장 기능을 제공하지 않습니다.' });
  return {
    basic:{ scope:'basic', supported:basic, status:basic ? 'requires-human-approval' : 'unsupported', reason:'기본정보 저장은 이 읽기 전용 검토에서 수행하지 않습니다.' },
    shell:{ scope:'shell', supported:true, status:'experimental-human-approval', canCommitFromIntake:false, fullProductSupported:false, reason:'전용 실행기와 사용자 직접 승인 화면에서 비공개 상품의 일정표 기본틀 1건만 지원합니다. 전체 상품 등록 지원은 아닙니다.' },
    day:{ scope:'day', supported:day, status:day ? 'requires-human-approval' : 'unsupported', reason:'일차 텍스트·식사 저장은 이 읽기 전용 검토에서 수행하지 않습니다.' },
    hotel:unavailable('hotel'), flight:unavailable('flight'), departure:unavailable('departure'), price:unavailable('price')
  };
}

/** Builds a Korean read-only review intake from agent-internal normalized data. */
export function buildIntake(input) {
  const validation = validateProduct(input);
  const plan = buildPlan(input);
  const grouped = new Map();
  const normalizationIssues = [];
  for (const issue of validation.errors) {
    const group = groupFor(issue.field);
    if (NORMALIZATION_FIELDS.has(issue.field) && isMissing(input, issue.field)) normalizationIssues.push(issue);
    else if (needsChoice(input, validation, issue, group)) {
      if (!grouped.has(group[0])) grouped.set(group[0], []);
      grouped.get(group[0]).push(issue);
    } else normalizationIssues.push(issue);
  }
  const questions = QUESTION_GROUPS.filter(([id]) => grouped.has(id)).map(group => question(group, grouped.get(group[0]), input));
  return {
    readOnly:true,
    readyForReview:validation.readyForReview,
    canCommitFullProduct:false,
    questions,
    invalidInputs:invalid(normalizationIssues, input),
    evidenceReferences:evidenceReferences(input),
    scopes:scopes(plan),
    notice:'검토용 결과입니다. 이 화면은 제공된 내부 정규화 결과만 읽으며 ERP에 저장하지 않습니다.'
  };
}
