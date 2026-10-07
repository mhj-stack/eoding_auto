import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, chmod, lstat, open, rename, unlink, link } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const TTL = 15 * 60 * 1000;
const MAX_BYTES = 2 * 1024 * 1024;
const ID = /^[a-f0-9]{64}$/;
const STATES = new Set(['pending', 'approved', 'executing', 'completed', 'needs-reconciliation', 'aborted']);
function error(code, message) { return Object.assign(new Error(message), { code }); }
function checkId(id) {
  if (typeof id !== 'string' || !ID.test(id)) throw error('REVIEW_INVALID_ID', 'Invalid review ID.');
}
function text(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096)
    throw error('REVIEW_INVALID_INPUT', name + ' must be a nonempty string of at most 4096 characters.');
}
// Strict JSON only: never invoke toJSON, discard fields, or accept cycles.
function canonical(value) {
  const ancestors = new Set();
  let bytes = 0;
  function add(s) {
    bytes += Buffer.byteLength(s);
    if (bytes > MAX_BYTES) throw error('REVIEW_TOO_LARGE', 'JSON exceeds the 2 MiB limit.');
    return s;
  }
  function visit(v, depth) {
    if (depth > 64) throw error('REVIEW_INVALID_INPUT', 'JSON nesting exceeds 64 levels.');
    if (v === null) return add('null');
    if (typeof v === 'string' || typeof v === 'boolean') return add(JSON.stringify(v));
    if (typeof v === 'number' && Number.isFinite(v)) return add(JSON.stringify(v));
    if (typeof v !== 'object' || ancestors.has(v)) throw error('REVIEW_INVALID_INPUT', 'Expected finite, acyclic JSON.');
    const array = Array.isArray(v);
    if (!array && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null)
      throw error('REVIEW_INVALID_INPUT', 'Expected plain JSON objects.');
    if (Object.getOwnPropertySymbols(v).length) throw error('REVIEW_INVALID_INPUT', 'Symbol properties are not JSON.');
    if (array && v.length > 100000) throw error('REVIEW_INVALID_INPUT', 'JSON collection is too large.');
    ancestors.add(v);
    const keys = array ? Array.from({ length: v.length }, (_, i) => String(i)) : Object.keys(v).sort();
    if (keys.length > 100000 || (array && Object.keys(v).length !== v.length))
      throw error('REVIEW_INVALID_INPUT', 'Invalid or excessively large JSON collection.');
    const items = keys.map(k => {
      const descriptor = Object.getOwnPropertyDescriptor(v, k);
      if (!descriptor || !('value' in descriptor)) throw error('REVIEW_INVALID_INPUT', 'Accessors and sparse arrays are not JSON.');
      return (array ? '' : add(JSON.stringify(k) + ':')) + visit(descriptor.value, depth + 1);
    });
    ancestors.delete(v);
    add((array ? '[]' : '{}') + ','.repeat(Math.max(0, items.length - 1)));
    return (array ? '[' : '{') + items.join(',') + (array ? ']' : '}');
  }
  return visit(value, 0);
}
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const identity = (fingerprint, accountKey) => digest({ fingerprint, accountKey });
const clone = value => JSON.parse(canonical(value));
// Retried identities receive a fresh attempt nonce, invalidating even same-payload
// approval hashes from the archived attempt. Legacy/first-attempt hashes stay valid.
const reviewHash = record => record.attemptId === undefined ? digest(record.payload) : digest({ payload: record.payload, attemptId: record.attemptId });

/** Local workflow journal, not cryptographic authorization against a same-OS attacker.
 * All APIs are async. Timestamps are epoch milliseconds. Approval and reconciliation
 * must ONLY be wired to an interactive CLI, never exposed as MCP tools. Abandoned
 * locks fail closed; manual reconciliation is required, never automatic lock stealing.
 * Lock contention uses monotonic performance.now(), independent of the injectable
 * wall clock used for persisted timestamps and TTL. Checksums are workflow safeguards,
 * not protection from an attacker who can write local files. POSIX modes are private;
 * on Windows, the caller must provision a private data directory with suitable ACLs.
 */
export class ReviewStore {
  constructor(dataDir, { clock = () => Date.now() } = {}) {
    if (typeof dataDir !== 'string' || !dataDir || typeof clock !== 'function')
      throw error('REVIEW_INVALID_INPUT', 'A data directory and clock function are required.');
    this.directory = path.resolve(dataDir, 'reviews');
    this.clock = clock;
  }
  async _init() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw error('REVIEW_UNSAFE_PATH', 'Reviews must be a real directory.');
    await chmod(this.directory, 0o700);
    try {
      const file = await open(path.join(this.directory, '.gitignore'), 'wx', 0o600);
      try { await file.writeFile('*\n!.gitignore\n'); } finally { await file.close(); }
    } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  _now() {
    const now = this.clock();
    if (!Number.isSafeInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - TTL)
      throw error('REVIEW_INVALID_CLOCK', 'Clock must return a valid epoch millisecond timestamp.');
    return now;
  }
  _file(id) { checkId(id); return path.join(this.directory, id + '.json'); }
  async _read(id, optional = false) {
    const filename = this._file(id);
    let file;
    try { file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)); }
    catch (e) {
      if (e.code === 'ENOENT') {
        if (optional) return null;
        throw error('REVIEW_NOT_FOUND', 'Review not found.');
      }
      throw e;
    }
    let envelope;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('Invalid review file.');
      envelope = JSON.parse(await file.readFile('utf8'));
    } catch (e) { throw error('REVIEW_TAMPERED', 'Cannot read valid review JSON: ' + e.message); }
    finally { await file.close(); }
    try {
      const r = envelope.record;
      if (!r || r.id !== id || !STATES.has(r.status) || !ID.test(r.hash) ||
          !Number.isSafeInteger(r.createdAt) || r.createdAt < 0 || r.expiresAt !== r.createdAt + TTL ||
          (r.attemptId !== undefined && (typeof r.attemptId !== 'string' || !/^[a-f0-9]{32}$/.test(r.attemptId))) ||
          reviewHash(r) !== r.hash || digest(r) !== envelope.integrity ||
          identity(r.payload.fingerprint, r.payload.accountKey) !== id) throw new Error('Integrity mismatch.');
      text(r.payload.fingerprint, 'fingerprint'); text(r.payload.accountKey, 'accountKey'); text(r.payload.formHash, 'formHash');
      return r;
    } catch { throw error('REVIEW_TAMPERED', 'Review integrity check failed.'); }
  }
  async _write(record) {
    const filename = this._file(record.id);
    const data = canonical({ record, integrity: digest(record) });
    const temporary = filename + '.' + randomBytes(12).toString('hex') + '.tmp';
    let file;
    try {
      file = await open(temporary, 'wx', 0o600);
      await file.writeFile(data);
      await file.sync();
      await file.close(); file = null;
      await rename(temporary, filename);
      if (process.platform !== 'win32') {
        const dir = await open(this.directory, 'r');
        try { await dir.sync(); } finally { await dir.close(); }
      }
    } finally {
      if (file) await file.close();
      await unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; });
    }
  }
  async _archive(record) {
    const directory = path.join(this.directory, 'archive');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw error('REVIEW_UNSAFE_PATH', 'Archive must be a real directory.');
    await chmod(directory, 0o700);
    const destination = path.join(directory, record.id + '.' + randomBytes(16).toString('hex') + '.json');
    // Exclusive, atomic hard-link publication preserves the exact full envelope.
    // The current record is subsequently replaced via rename, never edited in-place.
    // If a crash intervenes, the aborted original remains safe and retryable.
    await link(this._file(record.id), destination);
    if (process.platform !== 'win32') {
      const dir = await open(directory, 'r');
      try { await dir.sync(); } finally { await dir.close(); }
    }
  }
  async _locked(id, action) {
    checkId(id); await this._init();
    const lock = path.join(this.directory, id + '.lock');
    const deadline = performance.now() + 10000;
    let handle;
    while (!handle) {
      try { handle = await open(lock, 'wx', 0o600); }
      catch (e) {
        // Windows can report access denied while the previous holder's deleted
        // lock is still delete-pending. Retrying exclusive open never steals it.
        const contended = e.code === 'EEXIST' || (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(e.code));
        if (!contended) throw e;
        if (performance.now() >= deadline) throw error('REVIEW_LOCKED', 'Review is locked; reconcile an abandoned lock manually.');
        await delay(10);
      }
    }
    try { return await action(); }
    finally { await handle.close(); await unlink(lock); }
  }
  _fresh(record) {
    const now = this._now();
    if (now < record.createdAt || now >= record.expiresAt)
      throw error('REVIEW_EXPIRED', 'Review expired or clock moved backwards; do not execute.');
    return now;
  }
  _hash(record, hash) {
    if (typeof hash !== 'string' || hash !== record.hash)
      throw error('REVIEW_HASH_MISMATCH', 'Approval hash does not match the reviewed payload.');
  }
  _state(record, expected) {
    if (record.status !== expected) throw error('REVIEW_INVALID_STATE', 'Expected ' + expected + ', found ' + record.status + '.');
  }
  async create(payload) {
    payload = clone(payload);
    if (!payload || Array.isArray(payload) || typeof payload !== 'object') throw error('REVIEW_INVALID_INPUT', 'Payload must be a JSON object.');
    text(payload.fingerprint, 'fingerprint'); text(payload.accountKey, 'accountKey'); text(payload.formHash, 'formHash');
    const id = identity(payload.fingerprint, payload.accountKey);
    return this._locked(id, async () => {
      const existing = await this._read(id, true);
      // Only an operator-confirmed abort can restart. Expired/failed reviews remain
      // blocked until explicitly reconciled; completed reviews never restart.
      if (existing && existing.status !== 'aborted') return existing;
      const createdAt = this._now();
      const record = { id, hash: digest(payload), createdAt, expiresAt: createdAt + TTL, status: 'pending', payload };
      if (existing) {
        record.attemptId = randomBytes(16).toString('hex');
        record.hash = reviewHash(record);
        canonical({ record, integrity: digest(record) });
        await this._archive(existing);
      }
      await this._write(record); return record;
    });
  }
  async get(id) { checkId(id); await this._init(); return this._read(id); }
  async approve(id, hash, attestation) {
    if (attestation !== undefined) attestation = clone(attestation);
    return this._locked(id, async () => {
      const r = await this._read(id); this._hash(r, hash); this._state(r, 'pending');
      r.approvedAt = this._fresh(r); r.status = 'approved';
      if (attestation !== undefined) r.operatorAttestation = attestation;
      await this._write(r); return r;
    });
  }
  // UI teardown may only revoke reviews before any execution claim exists. This is
  // intentionally separate from operator reconciliation, which concerns ERP state.
  async cancelUnclaimed(id) {
    return this._locked(id, async () => {
      const r = await this._read(id);
      if (!['pending', 'approved'].includes(r.status))
        throw error('REVIEW_INVALID_STATE', 'Only an unclaimed review can be cancelled.');
      r.status = 'aborted'; r.cancelledAt = this._now();
      await this._write(r); return r;
    });
  }
  async claim(id, { hash, accountKey, formHash } = {}) {
    return this._locked(id, async () => {
      const r = await this._read(id); this._hash(r, hash); this._state(r, 'approved');
      if (accountKey !== r.payload.accountKey || formHash !== r.payload.formHash)
        throw error('REVIEW_CONTEXT_MISMATCH', 'Account or live form no longer matches the review.');
      r.claimedAt = this._fresh(r); r.status = 'executing';
      await this._write(r); return r;
    });
  }
  async finish(id, result) {
    result = clone(result);
    return this._locked(id, async () => {
      const r = await this._read(id); this._state(r, 'executing');
      r.status = 'completed'; r.completedAt = this._now(); r.result = result;
      await this._write(r); return r;
    });
  }
  async fail(id, message, partialResult) {
    text(message, 'message');
    if (partialResult !== undefined) partialResult = clone(partialResult);
    return this._locked(id, async () => {
      const r = await this._read(id); this._state(r, 'executing');
      r.status = 'needs-reconciliation'; r.failedAt = this._now(); r.message = message;
      if (partialResult !== undefined) r.partialResult = partialResult;
      await this._write(r); return r;
    });
  }
  // Interactive CLI only. The caller must obtain an operator's ERP verification;
  // the store intentionally cannot infer whether a remote record exists.
  async reconcile(id, evidence) {
    evidence = clone(evidence);
    if (!evidence || Array.isArray(evidence) || typeof evidence !== 'object' ||
        !['completed', 'aborted'].includes(evidence.outcome) ||
        Object.keys(evidence).some(key => !['outcome', 'productId', 'note'].includes(key)))
      throw error('REVIEW_INVALID_INPUT', 'Reconciliation requires outcome, note, and optional productId.');
    text(evidence.note, 'note');
    if (evidence.outcome === 'completed' || evidence.productId !== undefined) text(evidence.productId, 'productId');
    return this._locked(id, async () => {
      const r = await this._read(id);
      const unexecutedAbort = evidence.outcome === 'aborted' && ['pending', 'approved'].includes(r.status);
      if ((!unexecutedAbort && !['executing', 'needs-reconciliation'].includes(r.status)) || r.operatorReconciliation !== undefined)
        throw error('REVIEW_INVALID_STATE', 'Only unresolved execution or an explicitly cancelled unexecuted review can be reconciled.');
      const reconciledAt = this._now();
      r.operatorReconciliation = { ...evidence, reconciledAt };
      r.status = evidence.outcome;
      if (evidence.outcome === 'completed') {
        if (r.result !== undefined) r.priorResult = r.result;
        r.result = { productId: evidence.productId, verifiedBy: 'operator-reconciliation', note: evidence.note };
        r.completedAt = reconciledAt;
      } else {
        r.abortedAt = reconciledAt;
      }
      await this._write(r); return r;
    });
  }
  async findByFingerprint(fingerprint, accountKey) {
    text(fingerprint, 'fingerprint'); text(accountKey, 'accountKey'); await this._init();
    const record = await this._read(identity(fingerprint, accountKey), true);
    return record ? [record] : [];
  }
}
