import { digest } from './core.mjs';
import { prepareDeparture, readDepartureForm } from './departure-form.mjs';
import { buildDepartureContract } from './departure-contract.mjs';

const NOTICE = 'Prepared native contract only. No approval, claim, final creation or POST occurred. Fingerprint is an integrity check, not authorization.';
const KEYS = ['status','canCommit','sourceDepartureIndex','state','summary','notice','source','contract','fingerprint'];
const invalid = () => { throw new Error('Invalid or changed departure candidate; prepare and review again'); };
function cloneData(value) {
  let nodes=0;
  const seen=new Set();
  function visit(v,depth=0) {
    if(++nodes>100000||depth>50)invalid();
    if(v===null||typeof v==='boolean'||typeof v==='string')return;
    if(typeof v==='number'){if(!Number.isFinite(v))invalid();return;}
    if(!v||typeof v!=='object'||seen.has(v)||(!Array.isArray(v)&&Object.getPrototypeOf(v)!==Object.prototype))invalid();
    seen.add(v);for(const entry of Object.values(v))visit(entry,depth+1);seen.delete(v);
  }
  visit(value);
  const serialized=JSON.stringify(value);if(serialized.length>2000000)invalid();
  return JSON.parse(serialized);
}
function packet(prepared,source) {
  const contract=buildDepartureContract({...source,preparedState:prepared.state});
  const body={status:'prepared-only',canCommit:false,sourceDepartureIndex:source.index,state:prepared.state,summary:prepared.summary,notice:NOTICE,source,contract};
  return {...body,fingerprint:digest(body)};
}
function checkedCandidate(input) {
  const candidate=cloneData(input);
  if(!candidate||Array.isArray(candidate)||Object.keys(candidate).length!==KEYS.length||KEYS.some(key=>!Object.hasOwn(candidate,key)))invalid();
  if(candidate.status!=='prepared-only'||candidate.canCommit!==false||candidate.notice!==NOTICE||!candidate.source||Object.keys(candidate.source).sort().join(',')!=='index,options,product,target'||candidate.sourceDepartureIndex!==candidate.source.index)invalid();
  const expected=packet(candidate,candidate.source);
  if(digest(candidate)!==digest(expected))invalid();
  return candidate;
}

/** Adds a source-bound, non-authorizing contract to the existing unsaved form preparation. */
export async function prepareDepartureCandidate(page,inputProduct,inputOptions,inputTarget,index) {
  const source=cloneData({product:inputProduct,options:inputOptions,target:inputTarget,index});
  const prepared=await prepareDeparture(page,source.product,source.options,source.target,source.index);
  return cloneData(packet(prepared,source));
}

/** Re-read only. Never creates a review/claim or consumes a write allowance. */
export async function readDepartureCandidate(page,inputCandidate) {
  try {
    const candidate=checkedCandidate(inputCandidate);
    const state=await readDepartureForm(page,candidate.source.target);
    const current=packet({...candidate,state},candidate.source);
    if(digest(current)!==digest(candidate))invalid();
    return cloneData(current);
  } catch { invalid(); }
}
