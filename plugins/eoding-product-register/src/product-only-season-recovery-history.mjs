import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { digest } from './core.mjs';
import { createProductOnlyApprovalBinding } from './product-only-execution.mjs';

const fail = message => { throw new Error('Season recovery lineage blocked: ' + message); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const clone = value => structuredClone(value);
const plainPlan = value => { const plan = clone(value); for (const key of ['identity', 'continuation', 'approvalBinding']) delete plan[key]; return plan; };
const one = (events, kind, optional = false) => {
  const found = events.filter(row => row.kind === kind);
  if (found.length !== 1 && !(optional && !found.length)) fail('missing or duplicate ' + kind);
  return found[0];
};

async function canonical(value, directory = false) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) fail('absolute canonical evidence path required');
  const stat = await lstat(value);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) || await realpath(value) !== value) fail('evidence path changed or is a link');
  return value;
}
async function json(file) { await canonical(file); return JSON.parse(await readFile(file, 'utf8')); }
async function journal(dir) {
  const file = path.join(dir, 'continuation.jsonl'); await canonical(file);
  const value = await readFile(file, 'utf8');
  if (!value.trim() || !value.endsWith('\n')) fail('historical journal is truncated');
  return value.trimEnd().split('\n').map(line => JSON.parse(line));
}
async function tree(dir, prefix = '') {
  await canonical(dir, true);
  const result = [];
  for (const name of await readdir(dir)) {
    const file = path.join(dir, name), stat = await lstat(file), relative = path.join(prefix, name).replace(/\\/g, '/');
    if (stat.isSymbolicLink()) fail('historical evidence contains a link');
    if (stat.isDirectory()) result.push(...await tree(file, relative));
    else if (stat.isFile()) result.push({ name: relative, sha256: hash(await readFile(file)) });
    else fail('historical evidence is not a regular file');
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}
function continuationPath(originalJournal, originalPlan, recovery, prior) {
  const original = originalPlan.approvalBinding.planDigest;
  const key = prior ? digest({ original, recovery: recovery.manifest, priorFailure: prior.reservation })
    : recovery ? digest({ original, recovery: recovery.manifest }) : original;
  return path.join(path.dirname(originalJournal), '.continuation-reservations', key + '.json');
}
function resumedPath(source, kind) {
  return path.join(path.dirname(source.reservation.path), kind, digest({ reservation: source.reservation.path, claim: source.claim.id, scopeDigest: source.claim.scopeDigest }) + '.json');
}
function reviewScope({ target, originalManifest, plan, recovery, prior, zero, upload }) {
  return digest({ kind: 'product-only-continuation-review-v1', target, manifest: originalManifest,
    ...(recovery ? { recovery: { directory: recovery.dir, manifest: recovery.manifest, detail: recovery.detail } } : {}),
    ...(prior ? { priorFailure: prior } : {}), ...(zero ? { unforwardedFailure: zero } : {}), ...(upload ? { verifiedUploadFailure: upload } : {}),
    phases: ['media', 'shell', 'day', 'season', 'finalCheck'], renewalBinding: plan.approvalBinding });
}

/** File-only verification of every pinned predecessor and its canonical consumed slot.
 * No history, reservation, approval or execution record is written by this helper.
 */
export async function verifySeasonRecoveryLineage({ events, originalPlan, originalManifest, originalJournal, failedDir, claimRow } = {}) {
  await canonical(originalJournal, true); await canonical(failedDir, true);
  if (!Array.isArray(events) || !same(claimRow, one(events, 'approval-claim'))) fail('current claim row differs');
  const recovery = one(events, 'detail-recovery-verified', true)?.recovery;
  const prior = one(events, 'prior-failure-verified', true)?.priorFailure;
  const zero = one(events, 'unforwarded-failure-verified', true)?.source;
  const upload = one(events, 'verified-upload-failure-verified', true)?.source;
  if (prior && !recovery || zero && (!recovery || !prior) || upload && (!recovery || !prior || !zero)) fail('predecessor chain is incomplete');
  const failedPlan = await json(path.join(failedDir, 'continuation-plan.json'));
  const target = failedPlan.continuation?.target;
  if (!target || !Number.isSafeInteger(target.productId) || !target.masterCode) fail('historical target is missing');
  const fingerprints = { runs: [], reservations: [] };
  const seen = new Set([failedDir]);

  async function validateRun(dir, rows, plan, expectedReservation, { recovery: detail, prior: priorRun, zero: zeroRun, upload: uploadRun, predecessor, expectedSource } = {}) {
    if (!same(plainPlan(plan), plainPlan(originalPlan)) || !same(plan.approvalBinding, createProductOnlyApprovalBinding(plan))
      || plan.identity?.accountName !== originalPlan.identity.accountName || plan.identity?.accountKey !== originalPlan.identity.accountKey
      || !same(plan.continuation?.target, target) || !same(plan.continuation?.original?.approvalBinding, originalPlan.approvalBinding)
      || !same(plan.continuation?.original?.manifest, originalManifest) || !same(await json(path.join(dir, 'original-manifest.json')), originalManifest)
      || !same(rows[0]?.manifest, originalManifest) || !same(one(rows, 'original-evidence-verified').target, target)
      || !same(one(rows, 'session-renewal-review').plan, plan)) fail('historical plan, identity or original lineage changed');
    if (rows.some((row, index) => !Number.isSafeInteger(row.at) || row.at < 0 || index && row.at < rows[index - 1].at)) fail('historical timestamps changed');
    for (const [kind, key, expected] of [['detail-recovery-verified', 'recovery', detail], ['prior-failure-verified', 'priorFailure', priorRun], ['unforwarded-failure-verified', 'source', zeroRun], ['verified-upload-failure-verified', 'source', uploadRun]]) {
      if (!same(one(rows, kind, true)?.[key], expected)) fail('historical predecessor reference changed');
    }
    const approvalRow = one(rows, 'human-approval'), currentClaimRow = one(rows, 'approval-claim'), approval = approvalRow.approval, claim = currentClaimRow.claim;
    const scope = reviewScope({ target, originalManifest, plan, recovery: detail, prior: priorRun, zero: zeroRun, upload: uploadRun });
    if (approval?.status !== 'approved' || approval.method !== 'localhost-human-form' || approval.planDigest !== plan.approvalBinding.planDigest || approval.scopeDigest !== scope
      || approval.tenantObserved !== String(plan.product.company.tenant) || approval.accountObserved !== plan.identity.accountName
      || claim?.id !== 'product-only:' + plan.approvalBinding.planDigest || claim.planDigest !== approval.planDigest || claim.scopeDigest !== scope || !same(claim.target, { mode: 'NEW' })
      || ![approval.approvedAt, approval.expiresAt, claim.claimedAt].every(Number.isSafeInteger) || approval.approvedAt > approvalRow.at || approvalRow.at > claim.claimedAt || claim.claimedAt >= approval.expiresAt || currentClaimRow.at < claim.claimedAt || currentClaimRow.at >= approval.expiresAt) fail('historical approval or claim changed');
    if (currentClaimRow.reservation !== expectedReservation) fail('consumed reservation is not the canonical one-use slot');
    await canonical(expectedReservation);
    const bytes = await readFile(expectedReservation), reservation = JSON.parse(bytes), at = reservation.at;
    const expected = { kind: uploadRun ? 'product-only-verified-upload-resumption' : zeroRun ? 'product-only-zero-write-resumption' : 'product-only-continuation-reservation', originalJournal,
      ...(predecessor ? { consumedReservation: predecessor.reservation, failedRun: predecessor.dir, approval: predecessor.approval, claim: predecessor.claim } : {}), dataDir: dir, at };
    if (!same(reservation, expected) || !Number.isSafeInteger(at) || at < claim.claimedAt || at > currentClaimRow.at) fail('consumed reservation contents changed');
    const reservationProof = { path: expectedReservation, sha256: hash(bytes) };
    if (expectedSource && (!same(expectedSource.plan, plan) || !same(expectedSource.approval, approval) || !same(expectedSource.claim, claim) || !same(expectedSource.reservation, reservationProof))) fail('approved predecessor snapshot differs from its actual files');
    fingerprints.reservations.push(reservationProof);
    return { reservationPath: expectedReservation, reservation, proof: reservationProof };
  }

  async function predecessor(source, expectedReservation, options = {}) {
    if (!source || seen.has(source.dir)) fail('historical directories must be distinct');
    seen.add(source.dir); await canonical(source.dir, true);
    const actual = await tree(source.dir);
    if (!same(actual, source.manifest)) fail('historical manifest changed');
    const result = await validateRun(source.dir, await journal(source.dir), await json(path.join(source.dir, 'continuation-plan.json')), expectedReservation, options);
    fingerprints.runs.push({ directory: source.dir, manifest: actual });
    return result.proof;
  }

  let detailReservation, priorReservation;
  if (recovery) detailReservation = await predecessor(recovery, continuationPath(originalJournal, originalPlan));
  if (prior) {
    priorReservation = await predecessor(prior, continuationPath(originalJournal, originalPlan, recovery), { recovery });
    if (prior.reservation !== priorReservation.path || !same(prior.reservations, [detailReservation, priorReservation])) fail('prior failed-run reservation chain changed');
  }
  if (zero) await predecessor(zero, continuationPath(originalJournal, originalPlan, recovery, prior), { recovery, prior, expectedSource: zero });
  if (upload) await predecessor(upload, resumedPath(zero, '.zero-write-resumptions'), { recovery, prior, zero, predecessor: zero, expectedSource: upload });
  const expectedReservation = upload ? resumedPath(upload, '.verified-upload-resumptions') : zero ? resumedPath(zero, '.zero-write-resumptions') : continuationPath(originalJournal, originalPlan, recovery, prior);
  const current = await validateRun(failedDir, events, failedPlan, expectedReservation, { recovery, prior, zero, upload, predecessor: upload ?? zero });
  return { reservationPath: current.reservationPath, reservation: clone(current.reservation), fingerprint: fingerprints };
}
