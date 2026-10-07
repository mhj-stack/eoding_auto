import { digest } from './core.mjs';
import { flightDepartureInputIssue } from './flight-departure.mjs';
import { createFlightDepartureAdapters } from './flight-departure-execution.mjs';
import { ErpOptionsSchema, buildDeparturePlan } from './departure-plan.mjs';
import { prepareDepartureCandidate, readDepartureCandidate } from './departure-candidate.mjs';
import { executeGuardedDeparture, readObservedDepartureList } from './departure-execution.mjs';
import { readBasicForm } from './basic-form.mjs';
import { readDepartureMasterHomepage, readDepartureSnapshot } from './departure-read.mjs';
import { readScheduleDetail } from './schedule-detail-read.mjs';

const ORIGIN = 'https://basecamp.team';
const ID = /^[1-9]\d{0,9}$/;
const fail = message => { throw new Error(message); };
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const clone = value => structuredClone(value);

function canonicalId(value, label) {
  if (typeof value !== 'string' || !ID.test(value)) fail(`Invalid ${label}`);
  return value;
}
function plainText(value, label) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 20_000) fail(`Invalid ${label}`);
  return value;
}
function exactInput(input) {
  if (!plain(input) || Object.keys(input).length !== 3 || !['divisionId', 'bookingStatus', 'departureSettings'].every(key => own(input, key))) return null;
  return input;
}
function constructedOptions(input, { savedScheduleId, expectedAccountName }) {
  return { savedScheduleId, divisionId: input.divisionId, expectedAccountName, bookingStatus: input.bookingStatus, departureSettings: input.departureSettings };
}
function currentInputIssue(product, input, { savedScheduleId = '1', expectedAccountName = 'preflight' } = {}) {
  const exact = exactInput(input);
  if (!exact) return 'Departure input must contain only divisionId, bookingStatus, and departureSettings';
  if (!ID.test(exact.divisionId)) return 'Departure divisionId must be a canonical ERP ID';
  if (exact.bookingStatus !== 'closed') return 'Departure bookingStatus must be closed';
  const options = constructedOptions(exact, { savedScheduleId, expectedAccountName });
  const parsed = ErpOptionsSchema.safeParse(options);
  if (!parsed.success) return `Invalid departure settings: ${parsed.error.issues[0]?.message ?? 'schema mismatch'}`;
  if (digest(parsed.data)!==digest(options)) return 'Departure labels and values must match exactly without normalization';
  for (const setting of exact.departureSettings) {
    if (!Number.isSafeInteger(setting.minPax)||!Number.isSafeInteger(setting.maxPax)||setting.minPax<0||setting.maxPax<1||setting.minPax>setting.maxPax) return 'Invalid departure passenger limits';
    for (const amount of Object.values(setting.fuelSurcharges ?? {})) if (amount.amount !== 0) return 'Departure fuel surcharge must be zero';
  }
  const plan = buildDeparturePlan(product, parsed.data);
  if (!plan.readyForReview) return plan.errors[0]?.message ?? 'Departure input is not ready for review';
  if (plan.departures.length !== product?.departures?.length) return 'Every product departure needs exactly one departure setting';
  for (const departure of plan.departures) {
    if ((Date.parse(departure.sourceReturnDate)-Date.parse(departure.departureDate))/86400000+1!==product.days) return 'No-flight departure duration must match the saved schedule';
    if (departure.fuelIncluded !== true) return 'Only fuel-included departures with zero fuel are supported';
    for (const kind of ['adult', 'child', 'infant']) {
      const price = departure.prices[kind];
      if (price?.currency !== 'KRW' || !Number.isSafeInteger(price.amount) || price.amount < 0) return 'Departure age prices must be non-negative KRW integers';
    }
  }
  return null;
}

/** Pure preflight for the restricted no-flight, KRW, zero-fuel departure path. */
export function departureInputIssue(product, input) {
  return product?.includesFlight === true ? flightDepartureInputIssue(product, input) : currentInputIssue(product, input);
}

function dependencies(context, product) {
  const basic = context?.dependencies?.basic;
  const shell = context?.dependencies?.shell;
  const days = context?.dependencies?.days;
  const identity = context?.identity;
  if (!plain(basic) || !plain(shell) || !Array.isArray(days) || !plain(identity)) fail('Missing verified departure dependencies');
  const productId = canonicalId(basic.productId, 'basic product ID');
  const masterCode = plainText(basic.masterCode, 'basic master code');
  if (canonicalId(shell.productId, 'shell product ID') !== productId) fail('Schedule shell product dependency changed');
  const scheduleId = canonicalId(shell.scheduleId, 'saved schedule ID');
  const scheduleTitle = plainText(shell.fields?.title, 'saved schedule title');
  const accountName = plainText(identity.accountName, 'ERP account');
  const seen = new Set();
  if (!Number.isSafeInteger(product?.days) || product.days < 1 || product.days > 366 || days.length !== product.days) fail('All verified itinerary day dependencies are required');
  for (const item of days) {
    if (!plain(item) || !Number.isSafeInteger(item.day) || item.day < 1 || item.day > product.days || seen.has(item.day)) fail('All verified itinerary day dependencies are required');
    if (item.scheduleId!==scheduleId) fail('Verified itinerary schedule dependency changed');
    seen.add(item.day);
  }
  const {productId: _productId,...basicSnapshot}=basic;
  return { productId, masterCode, scheduleId, scheduleTitle, accountName, dayResults:days, basicSnapshot };
}
function listUrl(masterCode) {
  return `${ORIGIN}/tour/product/?master__master_code=${encodeURIComponent(masterCode)}&start_date=&end_date=&use_flag=True`;
}
function listedEventId(row) {
  const value = row?.id;
  if (typeof value === 'number' && Number.isSafeInteger(value) && ID.test(String(value))) return String(value);
  if (typeof value === 'string' && ID.test(value)) return value;
  fail('Observed departure row has no canonical ID');
}
async function navigate(page, url, label) {
  if (!page || typeof page.goto !== 'function' || typeof page.url !== 'function') fail('Invalid browser page');
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => fail(`${label} navigation failed`));
  if (page.url() !== url) fail(`${label} navigation drifted`);
}
async function waitForObservedList(page) {
  if (typeof page.waitForFunction !== 'function') fail('Invalid browser page');
  await page.waitForFunction(() => {
    const settings = globalThis.jQuery?.fn?.dataTable?.settings;
    return Array.isArray(settings) && settings.length === 1 && settings[0]?._bInitComplete === true;
  }, undefined, { timeout: 15_000 }).catch(() => fail('Observed departure list did not initialize'));
}
function assertMasterAndSchedule(basic, source, required, product) {
  if (basic.url !== `${ORIGIN}/tour/master_product/${required.productId}/change/` || basic.status !== '2' || basic.title !== product.title || basic.masterCode !== required.masterCode) fail('Basic private product identity changed');
  if (source.productId !== required.productId || source.scheduleId !== required.scheduleId || source.schedule.title !== required.scheduleTitle || source.schedule.days !== product.days || source.schedule.nights !== product.nights) fail('Saved source schedule does not match verified shell title or duration');
  if(digest(basic)!==digest(required.basicSnapshot)) fail('Verified basic dependency changed before departure');
  if(source.contentsFingerprint!==digest([])||source.imagesFingerprint!==digest([])) fail('Approved itinerary auxiliary content changed');
  for (const day of product.itinerary) {
    const rows=source.tree.filter(row=>row.day===day.day),custom=rows.filter(row=>row.typeId===7), saved=required.dayResults.find(item=>item.day===day.day);
    const meals=Object.fromEntries(['breakfast','lunch','dinner'].map(kind=>[kind,day.meals[kind]==='불포함'?{type:16,text:''}:{type:17,text:day.meals[kind]}]));
    if(custom.length!==1||custom[0].id!==saved?.detailId||custom[0].step!==1||custom[0].etc1!==day.title||custom[0].description!==day.description||['etc2','etc3','etc4','etc5','etc6'].some(key=>custom[0][key]!=='')) fail('Approved itinerary detail changed before departure');
    if(rows.some(row=>row.dayTitle!==day.title||digest(row.meals)!==digest(meals)||![2,7].includes(row.typeId))) fail('Approved itinerary presentation changed before departure');
    const hotels=rows.filter(row=>row.typeId===2);if(hotels.length>1||hotels.some(row=>row.step!==999||row.etc1!==''||row.etc2!==''||row.description!==null)) fail('Approved itinerary hotel sentinel changed before departure');
  }
}
function frozen(value, seen = new WeakSet()) {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (!value || typeof value !== 'object' || seen.has(value) || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)) fail('Departure candidate must be cloneable plain data');
  seen.add(value);
  for (const child of Object.values(value)) frozen(child, seen);
  seen.delete(value);
  return Object.freeze(value);
}

/** Select the source-declared path; never downgrade a flight product to no-flight. */
export function createProductDepartureAdapters() {
  const noFlight=createNoFlightDepartureAdapters().departures;
  const flight=createFlightDepartureAdapters().departures;
  const select=product=>product?.includesFlight===true?flight:noFlight;
  return {departures:{
    prepare:(page,product,input,context)=>select(product).prepare(page,product,input,context),
    read:(page,product,input,context)=>select(product).read(page,product,input,context),
    save:(page,prepared,input,context)=>select(context?.product).save(page,prepared,input,context)
  }};
}

/** Compose the guarded no-flight primitives for the product execution coordinator. */
function createNoFlightDepartureAdapters() {
  return {
    departures: {
      async prepare(page, product, input, context) {
        if (!Number.isSafeInteger(context?.departureIndex)||context.departureIndex<0||context.departureIndex>=product?.departures?.length) fail('Invalid departure source index');
        const required = dependencies(context, product);
        const issue = currentInputIssue(product, input, { savedScheduleId: required.scheduleId, expectedAccountName: required.accountName });
        if (issue) fail(issue);
        const options = constructedOptions(input, { savedScheduleId: required.scheduleId, expectedAccountName: required.accountName });
        const target = { productId: required.productId, masterCode: required.masterCode, title: product.title, account: required.accountName };
        const observedUrl = listUrl(required.masterCode);
        await navigate(page, observedUrl, 'Observed departure list');
        await waitForObservedList(page);
        const beforeList = await readObservedDepartureList(page, { url: observedUrl, extractEventId: listedEventId });
        const events = [];
        for (const row of beforeList.rows) events.push(await readDepartureSnapshot(page, { eventId: row.eventId }));
        const detailUrl = `${ORIGIN}/tour/master_product/${required.productId}/change/`;
        await navigate(page, detailUrl, 'Master detail');
        const masterBasic = await readBasicForm(page);
        const masterHomepage = await readDepartureMasterHomepage(page, { masterId: required.productId });
        const sourceSchedule = await readScheduleDetail(page, { productId: required.productId, scheduleId: required.scheduleId });
        assertMasterAndSchedule(masterBasic, sourceSchedule, required, product);
        const candidate = await prepareDepartureCandidate(page, product, options, target, context.departureIndex);
        return clone({ candidate, before: { productId: required.productId, events, masterBasic, masterHomepage, sourceSchedule }, beforeList });
      },
      async read(page, product, input, context) {
        const issue = departureInputIssue(product, input);
        if (issue) fail(issue);
        const prepared = clone(context?.prepared);
        if (!plain(prepared) || !own(prepared, 'candidate') || !own(prepared, 'before') || !own(prepared, 'beforeList')) fail('Missing prepared departure');
        return { ...prepared, candidate: await readDepartureCandidate(page, prepared.candidate) };
      },
      async save(page, prepared, _input, context) {
        const required = dependencies(context, context?.product ?? { days: prepared?.candidate?.contract?.days });
        const source = clone(prepared);
        if (!plain(source) || !own(source, 'candidate') || !own(source, 'before') || !own(source, 'beforeList')) fail('Missing prepared departure');
        const candidate = frozen(source.candidate);
        const sessionId = plainText(context?.identity?.sessionKey, 'ERP session key');
        if (typeof context?.assertIdentity !== 'function' || typeof context?.claimDeparture !== 'function') fail('Departure identity guard and durable claim callback are required');
        const observedUrl = listUrl(required.masterCode);
        return executeGuardedDeparture(page, {
          candidate,
          identity: { account: required.accountName, sessionId },
          inspectIdentity: async () => {
            await context.assertIdentity();
            return { account: required.accountName, sessionId, candidate };
          },
          claim: async ({ candidate: claimedCandidate }) => context.claimDeparture(claimedCandidate),
          before: source.before,
          beforeList: source.beforeList,
          list: { url: observedUrl, extractEventId: listedEventId }
        });
      }
    }
  };
}
