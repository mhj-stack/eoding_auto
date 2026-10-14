import { isDeepStrictEqual as same } from 'node:util';
import { createSeasonAdapter } from './product-season-adapter.mjs';

const clone = value => structuredClone(value);
const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
};
const fail = message => { throw new TypeError(message); };
const DIGEST = /^[a-f0-9]{64}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const plainObject = value => value && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value, name) => {
  if (typeof value !== 'string' || !value.trim()) fail(`${name} must be a nonempty string`);
  return value;
};

function preflight(plan) {
  const blockers = [];
  const season = plan?.season;
  if (!plainObject(season)) blockers.push('Missing season plan');
  else {
    if (Object.hasOwn(season, 'event') || Object.hasOwn(season, 'events') || season.eventCreation === true) blockers.push('Season plan does not permit event creation');
    if (!plainObject(season.fields)) blockers.push('Season fields are required');
    if (!plainObject(season.selects)) blockers.push('Season selects are required');
    if (!Array.isArray(season.selectedDates) || !season.selectedDates.length || season.selectedDates.some(value => typeof value !== 'string' || !ISO_DATE.test(value)) || new Set(season.selectedDates).size !== season.selectedDates.length) blockers.push('Season selectedDates must contain unique ISO dates');
  }
  return { canExecute: blockers.length === 0, blockers };
}

function checkedContext(context) {
  const binding = context?.approvalBinding, claim = context?.approvalClaim, target = context?.targets;
  if (!plainObject(binding) || !DIGEST.test(binding.planDigest ?? '') || !DIGEST.test(binding.scopeDigest ?? '') || claim?.planDigest !== binding.planDigest || claim?.scopeDigest !== binding.scopeDigest || !same(claim?.target, { mode: 'NEW' }) || target?.mode !== 'NEW') fail('Season requires the original NEW product approval claim');
  if (!Number.isSafeInteger(target.productId) || target.productId <= 0 || typeof target.masterCode !== 'string' || !target.masterCode || !Number.isSafeInteger(target.scheduleId) || target.scheduleId <= 0) fail('Season requires verified basic and shell targets');
  const basic = context?.verifiedPreviousPhases?.find(item => item?.name === 'basic');
  const shell = context?.verifiedPreviousPhases?.find(item => item?.name === 'shell');
  if (!basic?.verification || basic.receipt?.productId !== target.productId || basic.receipt?.masterCode !== target.masterCode) fail('Season target differs from verified basic receipt');
  if (!shell?.verification || shell.receipt?.scheduleId !== target.scheduleId) fail('Season target differs from verified shell receipt');
  return { binding, claim, target, seasonTarget: { productId: String(target.productId) } };
}

function checkedPlan(plan, current) {
  if (!same(plan?.approvalBinding, current.binding) || !same(plan?.target, current.target)) fail('Season plan binding changed');
}

function approvalAttestation(value, binding) {
  if (!plainObject(value) || value.durable !== true || value.status !== 'approved' || value.bindingDigest !== binding.digest || typeof value.approvalId !== 'string' || !value.approvalId) fail('Season authorization must return durable explicit approval evidence for the exact binding');
  return { status: value.status, bindingDigest: value.bindingDigest, approvalId: value.approvalId };
}

function durableEvidence(value, binding) {
  if (!plainObject(value) || value.durable !== true || value.bindingDigest !== binding.digest || typeof value.evidenceId !== 'string' || !value.evidenceId) fail('Season record must return durable evidence for the exact binding');
  return { durable: true, bindingDigest: value.bindingDigest, evidenceId: value.evidenceId };
}

/** Coordinator bridge for the native season adapter; it creates neither approvals nor events. */
export function createProductOnlySeasonAdapter({ origin = 'https://basecamp.team', assertIdentity, authorizeWrite, record, timeoutMs = 15_000, seedReceipt } = {}) {
  if (typeof origin !== 'string' || new URL(origin).origin !== origin || !origin.startsWith('https://') || ![assertIdentity, authorizeWrite, record].every(callback => typeof callback === 'function')) fail('Season requires exact HTTPS origin, identity, authorization and durable record callbacks');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) fail('Season timeoutMs must be a positive safe integer');
  const native = createSeasonAdapter({ origin, responseTimeoutMs: timeoutMs });
  let invoked = false, saved = null, savedSeasonPlan = null, savedSeasonTarget = null, savedClaim = null, bound = null;

  const identity = (page, target) => async ({ target: observedTarget }) => {
    if (!same(observedTarget, target)) fail('Season adapter identity target changed');
    const identityDigest = await assertIdentity(page, clone(observedTarget));
    nonempty(identityDigest, 'Season identity digest');
    return { identityDigest };
  };

  const openProductForSeason = async (page, target, assertSeasonIdentity) => {
    const url = `${origin}/tour/master_product/${target.productId}/change/`;
    const current = new URL(page.url());
    if (current.origin !== origin || current.pathname !== new URL(url).pathname || current.search || current.username || current.password) fail('Wrong season transition target');
    const beforeIdentity = await assertSeasonIdentity({ target });
    const owner = page.context(); let blockedWrite = false, cdp;
    const guard = route => {
      const request = route.request();
      if (['GET', 'HEAD'].includes(request.method())) return route.fallback();
      // Always block page-load writes, including third-party telemetry. Only
      // an unexpected ERP write invalidates this read-only product transition.
      if (new URL(request.url()).origin === origin) blockedWrite = true;
      return route.abort();
    };
    await owner.route('**/*', guard);
    try {
      cdp = await owner.newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
      await cdp.send('Network.setBypassServiceWorker', { bypass: true });
      // Day saves leave the schedule detail UI active. Reopen the exact product
      // before locating its season tab, including when the URL itself is unchanged.
      const response = await page.goto(url, { waitUntil: 'load', timeout: timeoutMs });
      if (!response || response.status() !== 200 || response.url() !== url || response.fromServiceWorker() || response.request().method() !== 'GET' || response.request().redirectedFrom() || page.url() !== url) fail('Season product GET did not return the exact target');
      if (!same(await assertSeasonIdentity({ target }), beforeIdentity)) fail('Season identity changed during product transition');
      if (blockedWrite) fail('Unexpected write blocked during season product transition');
    } finally {
      await owner.unroute('**/*', guard);
      await cdp?.detach().catch(() => {});
    }
  };

  return {
    preflight,
    async save(page, plan, context) {
      const checked = preflight(plan);
      if (!checked.canExecute) fail(checked.blockers.join('; '));
      if (invoked || seedReceipt) fail('Season stage cannot be retried; reconcile the previous attempt');
      const current = checkedContext(context);
      checkedPlan(plan, current);
      if (bound && !same(bound, { binding: current.binding, target: current.target })) fail('Season execution binding changed');
      invoked = true;
      bound = clone({ binding: current.binding, target: current.target });
      const assertSeasonIdentity = identity(page, current.seasonTarget);
      await openProductForSeason(page, current.seasonTarget, assertSeasonIdentity);
      const prepared = await native.prepare(page, { target: current.seasonTarget, plan: clone(plan.season), assertIdentity: assertSeasonIdentity });
      const receipt = await native.save(page, prepared, {
        assertIdentity: assertSeasonIdentity,
        beforeWrite: async event => {
          const live = checkedContext(context);
          if (!same(live, current)) fail('Season execution binding changed during authorization');
          const envelope = {
            phase: 'season',
            target: clone(current.target),
            approvalBinding: clone(current.binding),
            approvalClaim: clone(context.approvalClaim),
            binding: clone(event.binding),
            bindingDigest: event.binding?.digest,
            prepared: clone(event.prepared)
          };
          const authorized = await authorizeWrite(clone(envelope), clone(context));
          return approvalAttestation(authorized, event.binding);
        },
        record: async event => {
          const envelope = {
            phase: 'season',
            target: clone(current.target),
            approvalBinding: clone(current.binding),
            approvalClaim: clone(context.approvalClaim),
            ...clone(event),
            bindingDigest: event.binding?.digest
          };
          return durableEvidence(await record(clone(envelope), clone(context)), event.binding);
        }
      });
      if (receipt?.kind !== 'season-save-receipt-v1') fail('Season adapter returned an invalid save receipt');
      saved = clone(receipt);
      savedSeasonPlan = freeze(clone(plan.season));
      savedSeasonTarget = freeze(clone(current.seasonTarget));
      savedClaim = freeze(clone(context.approvalClaim));
      return clone(saved);
    },
    async verifyReceipt(page, receipt, context) {
      const current = checkedContext(context);
      if (!bound || !same(bound, { binding: current.binding, target: current.target })) fail('Season execution binding changed');
      if (!saved || !same(receipt, saved)) return false;
      const assertSeasonIdentity = identity(page, current.seasonTarget);
      return native.verifyReceipt(page, clone(receipt), { target: current.seasonTarget, plan: clone(savedSeasonPlan), assertIdentity: assertSeasonIdentity });
    },
    async readFinal(page, receipt, context) {
      const current = checkedContext(context);
      // Departure-only resume: the season was saved by the original run and is re-read here, never rewritten.
      if (!saved && seedReceipt) {
        if (receipt?.kind !== 'season-save-receipt-v1' || !same(receipt, seedReceipt.receipt) || receipt.target?.productId !== current.seasonTarget.productId) fail('Resumed season receipt differs from the verified original');
        return native.verifyReceipt(page, clone(receipt), { target: current.seasonTarget, plan: clone(seedReceipt.plan), assertIdentity: identity(page, current.seasonTarget) });
      }
      if (!saved || !savedSeasonPlan || !savedSeasonTarget || !savedClaim || !same(receipt, saved)) fail('Season final receipt differs from the saved stage receipt');
      if (current.binding.planDigest !== bound?.binding.planDigest || current.binding.scopeDigest !== bound?.binding.scopeDigest || current.claim.planDigest !== savedClaim.planDigest || current.claim.scopeDigest !== savedClaim.scopeDigest || !same(current.claim.target, savedClaim.target)) fail('Season final claim binding changed');
      if (current.target.productId !== bound.target.productId || current.target.masterCode !== bound.target.masterCode || current.target.scheduleId !== bound.target.scheduleId) fail('Season final target changed');
      return native.verifyReceipt(page, clone(saved), { target: clone(savedSeasonTarget), plan: clone(savedSeasonPlan), assertIdentity: identity(page, savedSeasonTarget) });
    }
  };
}
