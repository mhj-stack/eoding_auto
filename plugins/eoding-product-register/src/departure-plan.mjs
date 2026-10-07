import { z } from 'zod';
import { validateProduct } from './core.mjs';

const text = z.string().trim().min(1).max(20_000);
const safeAmount = z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER);
const money = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/),
  amount: safeAmount
}).strict();

/** Explicit, planner-only inputs. IDs and labels are not verified against the ERP. */
export const ErpOptionsSchema = z.object({
  savedScheduleId: text,
  divisionId: text,
  expectedAccountName: text,
  bookingStatus: z.literal('closed'),
  departureSettings: z.array(z.object({
    index: z.number().int().min(0),
    minPax: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    maxPax: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    outboundOperatorLabel: text,
    returnOperatorLabel: text,
    fuelSurcharges: z.object({
      adult: money.optional(),
      child: money.optional(),
      infant: money.optional()
    }).strict().optional()
  }).strict()).max(1000)
}).strict();

const issue = (errors, field, message) => errors.push({ field, message });
const cloneMoney = value => ({ currency: value.currency, amount: value.amount });
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

/**
 * Builds unverified ERP departure instructions only. It never performs ERP I/O
 * and can never authorize a commit.
 */
export function buildDeparturePlan(product, erpOptions) {
  const core = validateProduct(product);
  const errors = [...core.errors];
  const warnings = [...core.warnings];
  const parsedOptions = ErpOptionsSchema.safeParse(erpOptions);

  if (!parsedOptions.success) {
    for (const item of parsedOptions.error.issues) {
      const suffix = item.path.join('.') || item.keys?.join('.') || 'root';
      issue(errors, `erpOptions.${suffix}`, item.message);
    }
  }

  const p = core.product;
  const options = parsedOptions.success ? parsedOptions.data : null;
  const plannedDepartures = [];
  if (p?.includesFlight) issue(errors, 'includesFlight', '항공 포함 행사의 항공편 입력기는 아직 검증되지 않았습니다');
  if (p && p.currency !== 'KRW') issue(errors, 'currency', '현재 관찰된 행사 가격 매핑은 KRW만 검증 대상으로 지원합니다');

  if (p && options) {
    const settingsByIndex = new Map();
    for (const [settingPosition, setting] of options.departureSettings.entries()) {
      const field = `erpOptions.departureSettings.${settingPosition}`;
      if (setting.index >= p.departures.length) {
        issue(errors, `${field}.index`, '출발일 범위를 벗어난 설정 인덱스입니다');
        continue;
      }
      if (settingsByIndex.has(setting.index)) {
        issue(errors, `${field}.index`, '출발일별 설정은 정확히 하나여야 합니다');
        continue;
      }
      settingsByIndex.set(setting.index, setting);
      if (setting.minPax > setting.maxPax) issue(errors, `${field}.minPax`, '최소 인원은 최대 인원보다 클 수 없습니다');
    }
    if (options.departureSettings.length !== p.departures.length) {
      issue(errors, 'erpOptions.departureSettings', '각 원본 출발일에 정확히 하나의 설정이 필요합니다');
    }
    for (let i = 0; i < p.departures.length; i++) {
      if (!settingsByIndex.has(i)) issue(errors, 'erpOptions.departureSettings', `출발일 ${i}의 설정이 없습니다`);
    }

    const starts = new Map();
    for (const [i, departure] of p.departures.entries()) {
      const previous = starts.get(departure.startDate);
      if (previous !== undefined) {
        issue(errors, `departures.${i}.startDate`, `같은 출발일(${departure.startDate}) 변형은 자동 병합할 수 없습니다 (기존 ${previous})`);
      } else starts.set(departure.startDate, i);
    }

    for (const [i, departure] of p.departures.entries()) {
      const setting = settingsByIndex.get(i);
      if (!setting) continue;
      const at = `departures.${i}`;
      const selected = departure.selectedPrice === null ? null : departure.prices[departure.selectedPrice];
      if (!selected) continue;
      if (selected.basis !== 'standard') issue(errors, `${at}.prices.${departure.selectedPrice}.basis`, '표준 요금만 ERP 출발일 계획에 매핑할 수 있습니다');
      const selectedKinds = ['adult', 'child', 'infant'];
      for (const kind of selectedKinds) {
        if (!hasOwn(selected, kind) || !selected[kind]) issue(errors, `${at}.prices.${departure.selectedPrice}.${kind}`, '성인/소아/유아 선택 요금을 명시해야 합니다');
        else if (selected[kind].currency !== p.currency || !Number.isFinite(selected[kind].amount) || selected[kind].amount < 0 || selected[kind].amount > Number.MAX_SAFE_INTEGER) issue(errors, `${at}.prices.${departure.selectedPrice}.${kind}`, '상품 통화의 안전한 0 이상 금액이어야 합니다');
      }

      const surcharge = setting.fuelSurcharges;
      if (selected.fuelIncluded === true) {
        for (const kind of selectedKinds) if (surcharge?.[kind]?.amount > 0) issue(errors, `erpOptions.departureSettings.${i}.fuelSurcharges.${kind}`, '유류할증료 포함 요금에는 양수 유류할증료를 추가할 수 없습니다');
      } else if (selected.fuelIncluded === false) {
        for (const kind of selectedKinds) {
          if (!surcharge?.[kind]) issue(errors, `erpOptions.departureSettings.${i}.fuelSurcharges.${kind}`, '유류할증료 미포함 요금에는 성인/소아/유아 금액이 모두 필요합니다');
        }
      } else {
        issue(errors, `${at}.prices.${departure.selectedPrice}.fuelIncluded`, '유류할증료 포함 여부 확인이 필요합니다');
      }
      for (const kind of selectedKinds) {
        const value = surcharge?.[kind];
        if (value && (value.currency !== p.currency || !Number.isFinite(value.amount) || value.amount < 0 || value.amount > Number.MAX_SAFE_INTEGER)) issue(errors, `erpOptions.departureSettings.${i}.fuelSurcharges.${kind}`, '상품 통화의 안전한 0 이상 금액이어야 합니다');
      }

      if (selectedKinds.every(kind => hasOwn(selected, kind) && selected[kind])) {
        plannedDepartures.push({
          sourceDepartureIndex: i,
          departureDate: departure.startDate,
          sourceReturnDate: departure.endDate,
          erpBookingStatus: { label: 'closed', observedValue: '4', verification: 'unverified' },
          savedScheduleId: { value: options.savedScheduleId, verification: 'unverified' },
          divisionId: { value: options.divisionId, verification: 'unverified' },
          operators: {
            outbound: { label: setting.outboundOperatorLabel, verification: 'unverified' },
            return: { label: setting.returnOperatorLabel, verification: 'unverified' }
          },
          minPax: setting.minPax,
          maxPax: setting.maxPax,
          prices: Object.fromEntries(selectedKinds.map(kind => [kind, cloneMoney(selected[kind])])),
          fuelIncluded: selected.fuelIncluded,
          fuelSurcharges: surcharge ? Object.fromEntries(Object.entries(surcharge).map(([kind, value]) => [kind, cloneMoney(value)])) : undefined,
          conditions: selected.conditions ?? null,
          plannerOnly: true
        });
      }
    }
  }

  return {
    valid: core.valid && parsedOptions.success,
    readyForReview: errors.length === 0,
    needsInput: errors.length > 0,
    canCommit: false,
    errors,
    warnings,
    erp: options ? {
      expectedAccountName: options.expectedAccountName,
      bookingStatus: { label: 'closed', observedValue: '4', verification: 'unverified' },
      plannerOnly: true
    } : null,
    departures: plannedDepartures,
    notice: '계획 전용 결과입니다. ERP ID와 운영사 라벨은 검증되지 않았고 ERP 저장은 수행하지 않습니다.'
  };
}
