// ERP content registration: reuse an exact active same-type/city/name record, otherwise upload the
// item's source photos (if any), create it once and confirm by an independent search.
import { cityName } from './fit-plan.mjs';
import { CONTENT_TYPES, contentFields } from './content-plan.mjs';
import { onErp, getJson, post, uploadImage, resolveRegion } from './fit-execution.mjs';

const fail = message => { throw new Error(message); };
const ID = /^[1-9][0-9]{0,12}$/;

async function readBatches(items, read) {
  const results = [];
  for (let offset = 0; offset < items.length; offset += 4) {
    const settled = await Promise.allSettled(items.slice(offset, offset + 4).map(read));
    const failed = settled.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    results.push(...settled.map(result => result.value));
  }
  return results;
}

export async function findContents(page, item) {
  const { path } = CONTENT_TYPES[item.type];
  const body = await getJson(page, `/contents/${path}/?name_ko=${encodeURIComponent(item.name)}&datatable-draw=1&datatable-start=0&datatable-length=50`, true);
  if (!Array.isArray(body?.data)) fail(`${CONTENT_TYPES[item.type].label} 검색 응답 형식이 예상과 다릅니다.`);
  return body.data.filter(row => row.list_name_ko === item.name && row.list_city === cityName(item.cityLabel) && row.list_use_flag === 'Y').map(row => String(row.id));
}

/** Read-only review: regions and existing matches. Ambiguous duplicates must be cleaned up in ERP first. */
export async function resolveContents(page, items) {
  await onErp(page);
  const regions = {}, existing = {};
  const labels = [...new Set(items.map(item => item.cityLabel))];
  const resolvedRegions = await readBatches(labels, label => resolveRegion(page, label));
  labels.forEach((label, index) => { regions[label] = resolvedRegions[index]; });
  const matches = await readBatches(items, item => findContents(page, item));
  for (const [index, item] of items.entries()) {
    const found = matches[index];
    if (found.length > 1) fail(`같은 도시에 같은 이름의 ${CONTENT_TYPES[item.type].label} 콘텐츠가 여러 개입니다: ${item.name}. ERP에서 정리 후 다시 검토하세요.`);
    existing[item.key] = found[0] ?? null;
  }
  return { regions, existing };
}

/** Find-or-create every item; journal rows make a re-run reuse earlier uploads and records. */
export async function runContents({ page, items, resolved, images, journal, assertIdentity, companyId, progress = () => {} }) {
  const byId = new Map(images.map(image => [image.id, image]));
  const uploaded = new Map(journal.rows.filter(row => row.phase === 'image').map(row => [row.sha256, row.erpId]));
  const results = [];
  for (const item of items) {
    progress(`${CONTENT_TYPES[item.type].label}:${item.name}`);
    await assertIdentity(); await onErp(page);
    const earlier = journal.rows.find(row => row.phase === 'content' && row.key === item.key)?.contentId;
    const found = await findContents(page, item);
    if (found.length > 1) fail(`같은 이름의 ${CONTENT_TYPES[item.type].label} 콘텐츠가 여러 개입니다: ${item.name}`);
    if (found.length === 1) {
      await assertIdentity();
      if (earlier && earlier !== found[0]) fail(`이전에 저장한 ${item.name}의 콘텐츠 번호가 달라졌습니다. ERP에서 확인하세요.`);
      if (earlier !== found[0]) await journal.append({ phase: 'content', key: item.key, type: item.type, contentId: found[0], created: false });
      results.push({ key: item.key, type: item.type, name: item.name, contentId: found[0], created: journal.rows.some(row => row.phase === 'content' && row.key === item.key && row.created), photos: item.images.length });
      continue;
    }
    if (earlier) fail(`이전에 저장한 ${item.name}(${earlier})을 찾을 수 없습니다. ERP에서 확인하세요.`);
    if (journal.rows.some(row => row.phase === 'content-attempt' && row.key === item.key)) fail(`${item.name}의 저장 시도 기록이 있지만 재조회되지 않습니다. 결과가 불명확하므로 자동 재생성하지 않습니다. ERP에서 확인하세요.`);
    const erpImages = [];
    for (const id of item.images) {
      const image = byId.get(id) ?? fail(`이미지 ${id}가 작업에 없습니다.`);
      if (!uploaded.has(image.sha256)) {
        await assertIdentity();
        const result = await uploadImage(page, image, image.alt);
        if (result.status !== 201) fail(`이미지 업로드 응답이 ${result.status}입니다: ${id}`);
        const body = JSON.parse(result.text), erpId = String(body.id ?? '');
        if (!ID.test(erpId) || !String(body.src ?? '').startsWith(`https://media.eoding.com/media/travelagent/${companyId}/`)) fail('이미지 업로드 영수증이 이 회사의 이미지가 아닙니다.');
        await journal.append({ phase: 'image', imageId: id, sha256: image.sha256, erpId, src: body.src }); uploaded.set(image.sha256, erpId);
      }
      erpImages.push(uploaded.get(image.sha256));
    }
    await assertIdentity();
    await journal.append({ phase: 'content-attempt', key: item.key });
    const response = await post(page, `/contents/${CONTENT_TYPES[item.type].path}/add/`, { fields: contentFields(item, resolved.regions[item.cityLabel], erpImages) });
    let contentId = '';
    try { contentId = String(JSON.parse(response.text).id ?? ''); } catch {}
    if (![200, 201].includes(response.status) || !ID.test(contentId)) fail(`${CONTENT_TYPES[item.type].label} 저장 응답이 ${response.status}입니다: ${item.name}`);
    const readback = await findContents(page, item);
    if (readback.length !== 1 || readback[0] !== contentId) fail(`${item.name} 저장 후 재조회가 맞지 않습니다.`);
    await assertIdentity();
    await journal.append({ phase: 'content', key: item.key, type: item.type, contentId, created: true });
    results.push({ key: item.key, type: item.type, name: item.name, contentId, created: true, photos: erpImages.length });
  }
  return results;
}
