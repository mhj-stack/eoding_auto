const TIMEOUT = 10_000;
const MAX_MULTIPART_BYTES = 256 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const fail = message => { throw new Error(message); };
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function canonicalCompanyId(value) {
  if (typeof value !== 'string' || !/^[1-9]\d{0,9}$/.test(value)) fail('Invalid display image company ID');
  return value;
}

function canonicalId(value, label = 'display image ID') {
  if (typeof value !== 'string' || !/^[1-9]\d{0,9}$/.test(value)) fail(`Invalid ${label}`);
  return value;
}

function expectedImageSort(images) {
  return JSON.stringify({ images: images.map(image => image.id) });
}

function exactImage(image, tenant) {
  if (!image || typeof image !== 'object' || Array.isArray(image) || Object.keys(image).sort().join(',') !== 'id,src') fail('Invalid display image');
  const id = canonicalId(image.id);
  if (typeof image.src !== 'string') fail('Invalid display image source');
  let url;
  try { url = new URL(image.src); } catch { fail('Invalid display image source'); }
  const path = tenant ? new RegExp(`^/media/travelagent/${tenant}/imagecontent/[^/]+$`) : /^\/media\/travelagent\/[1-9]\d{0,9}\/imagecontent\/[^/]+$/;
  if (url.protocol !== 'https:' || url.hostname !== 'media.eoding.com' || url.port || url.username || url.password || url.search || url.hash || !path.test(url.pathname)) fail('Display image source does not match tenant');
  return { id, src: image.src };
}

/** Validate reusable, pre-existing image references for one exact tenant. */
export function validateDisplayImages(images, companyId) {
  const tenant = canonicalCompanyId(companyId);
  if (!Array.isArray(images) || images.length < 1 || images.length > 20) fail('Display images must contain 1..20 entries');
  const ids = new Set();
  return images.map(image => {
    const checked = exactImage(image, tenant);
    if (ids.has(checked.id)) fail('Display image IDs must be unique numeric IDs');
    ids.add(checked.id);
    return checked;
  });
}

/** Strict parser for native text-only multipart fields. It never accepts files. */
export function parseDisplayMultipart(contentType, body) {
  const match = typeof contentType === 'string' && /^multipart\/form-data;\s*boundary=(?:"([^"\r\n]+)"|([^\s;\r\n]+))\s*$/i.exec(contentType);
  if (!match || !Buffer.isBuffer(body) || body.length < 1 || body.length > MAX_MULTIPART_BYTES) fail('Malformed display multipart');
  let text;
  try { text = utf8.decode(body); } catch { fail('Malformed display multipart'); }
  const boundary = `--${match[1] ?? match[2]}`;
  if (!text.startsWith(`${boundary}\r\n`) || !text.endsWith(`${boundary}--\r\n`)) fail('Malformed display multipart');
  const contents = text.slice(boundary.length + 2, -(boundary.length + 6)).split(`\r\n${boundary}\r\n`);
  if (!contents.length || contents.some(part => !part)) fail('Malformed display multipart');
  return contents.map(part => {
    const separator = part.indexOf('\r\n\r\n');
    if (separator < 1) fail('Malformed display multipart');
    const headers = part.slice(0, separator);
    const value = part.slice(separator + 4);
    const disposition = /^content-disposition:\s*form-data;\s*name="([^"\r\n]+)"\s*$/i.exec(headers);
    if (!disposition || headers.includes('\r\n') || /(?:^|;)\s*filename\*?\s*=/i.test(headers) || /[\0\r\n]/.test(disposition[1])) fail('Malformed display multipart');
    return [disposition[1], value];
  });
}

function assertState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state) || Object.keys(state).sort().join(',') !== 'fields,images' || !Array.isArray(state.fields) || !Array.isArray(state.images)) fail('Invalid display image state');
  const sort = expectedImageSort(state.images);
  let sortCount = 0;
  for (const field of state.fields) {
    if (!Array.isArray(field) || field.length !== 2 || typeof field[0] !== 'string' || typeof field[1] !== 'string') fail('Invalid display image fields');
    if (field[0] === 'csrfmiddlewaretoken') fail('Display image state must exclude CSRF');
    if (field[0] === 'image_sort') { sortCount++; if (field[1] !== sort) fail('Display image sort is not normalized'); }
  }
  if (sortCount !== 1) fail('Display image state must contain one image_sort');
  const ids = new Set();
  for (const image of state.images) {
    if (!image || typeof image !== 'object' || Array.isArray(image) || Object.keys(image).sort().join(',') !== 'decoded,id,src' || typeof image.decoded !== 'boolean') fail('Invalid display image readback');
    const checked = exactImage({ id: image.id, src: image.src });
    if (ids.has(checked.id)) fail('Duplicate display image ID in state');
    ids.add(checked.id);
  }
  return state;
}

/** Read only the observed homepage form controls and selected display-image order. */
export async function readDisplayImageState(page) {
  if (!page || typeof page.evaluate !== 'function') fail('Invalid display image page');
  const state = await page.evaluate(() => {
    const one = (selector, label) => {
      const nodes = [...document.querySelectorAll(selector)];
      if (nodes.length !== 1) throw new Error(`Expected one ${label}`);
      return nodes[0];
    };
    const base = one('#base', 'homepage tab');
    const form = one('#base #homepage_post', 'homepage form');
    const areas = [...base.querySelectorAll('#image_homepage_area')];
    if (areas.length !== 1) throw new Error('Expected one homepage image area');
    const images = [...areas[0].querySelectorAll('.image_list[data-id]')].map(item => {
      const picture = [...item.querySelectorAll('img')];
      if (picture.length !== 1 || !picture[0].getAttribute('src')) throw new Error('Malformed homepage image');
      return { id: item.dataset.id, src: picture[0].src, decoded: picture[0].complete && picture[0].naturalWidth > 0 };
    });
    const fields = [...new FormData(form).entries()].filter(([name]) => name !== 'csrfmiddlewaretoken').map(([name, value]) => {
      if (typeof value !== 'string') throw new Error('Unexpected homepage file field');
      return [name, value];
    });
    const sort = JSON.stringify({ images: images.map(image => image.id) });
    const sortIndexes = fields.flatMap(([name], index) => name === 'image_sort' ? [index] : []);
    if (sortIndexes.length !== 1) throw new Error('Expected one native image_sort field');
    fields[sortIndexes[0]][1] = sort;
    if (!fields.some(([name]) => name === 'badge_list')) {
      const badges = ['badge1', 'badge2', 'badge3'].map(name => {
        const matches = [...form.querySelectorAll(`#id_${CSS.escape(name)}, [name="${name}"]`)];
        const unique = [...new Set(matches)];
        if (unique.length > 1) throw new Error(`Ambiguous ${name}`);
        const field = unique[0];
        if (field && !['INPUT', 'TEXTAREA', 'SELECT'].includes(field.tagName)) throw new Error(`Unexpected ${name}`);
        return field?.value.trim() ?? '';
      }).filter(Boolean);
      fields.push(['badge_list', JSON.stringify(badges)]);
    }
    return { fields, images };
  });
  return assertState(state);
}

function stateImagesEqual(actual, expected) {
  return actual.length === expected.length && actual.every((image, index) => image.id === expected[index].id && image.src === expected[index].src);
}

/** Assert that only image_sort (and its corresponding selected image list) changed. */
export function assertDisplayImageDelta(before, after, images) {
  assertState(before); assertState(after);
  if (!Array.isArray(images) || images.length < 1 || images.length > 20) fail('Invalid approved display images');
  const approved = images.map(image => exactImage(image));
  if (new Set(approved.map(image => image.id)).size !== approved.length) fail('Invalid approved display images');
  if (!stateImagesEqual(after.images, approved)) fail('Display images are not in the exact approved order');
  if (before.fields.length !== after.fields.length) fail('Unexpected display field change');
  for (let index = 0; index < before.fields.length; index++) {
    const [beforeName, beforeValue] = before.fields[index];
    const [afterName, afterValue] = after.fields[index];
    if (beforeName !== afterName) fail('Unexpected display field change');
    if (beforeName !== 'image_sort' && beforeValue !== afterValue) fail('Unexpected display field change');
  }
  return after;
}

async function uniqueVisible(page, selector, description) {
  const locator = page.locator(selector).filter({ visible: true });
  await locator.first().waitFor({ state: 'visible', timeout: TIMEOUT });
  if (await locator.count() !== 1) fail(`Ambiguous ${description}`);
  return locator;
}

async function drawModalTable(page) {
  await page.waitForFunction(() => {
    const table = document.querySelector('#modal_table table');
    const $ = window.jQuery;
    return !!table && typeof $ === 'function' && !!$.fn?.dataTable
      && $.fn.dataTable.isDataTable('#modal_table table') && $(table).DataTable().settings()[0]?._bInitComplete === true;
  }, undefined, { timeout: TIMEOUT });
  const result = await page.evaluate(async timeout => {
    const modal = document.querySelector('#content-modal');
    const table = window.jQuery('#modal_table table');
    const api = table.DataTable();
    const waitForDraw = () => new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('Timed out waiting for image table draw')), timeout);
      table.one('draw.dt', () => { window.clearTimeout(timer); resolve(); });
    });
    const search = modal?.querySelector('button.search');
    if (!search) throw new Error('Expected image search control');
    const searchDraw = waitForDraw();
    search.click();
    await searchDraw;
    const pageDraw = waitForDraw();
    api.page.len(20).draw();
    await pageDraw;
    return {
      recordsDisplay: api.page.info().recordsDisplay,
      rows: document.querySelectorAll('#modal_table table tbody tr').length,
    };
  }, TIMEOUT);
  if (!Number.isInteger(result.recordsDisplay) || result.recordsDisplay < 0 || result.recordsDisplay > 20 || result.rows !== result.recordsDisplay) fail('Unexpected image search result table');
}

/** Select existing exact image-library rows and import them into the unsaved homepage form. Never saves or uploads. */
export async function prepareExistingDisplayImages(page, { images, companyId, query } = {}) {
  const approved = validateDisplayImages(images, companyId);
  if (typeof query !== 'string' || !query || query !== query.trim()) fail('Invalid display image search query');
  const before = await readDisplayImageState(page);
  if (before.images.length) {
    if (!stateImagesEqual(before.images, approved)) fail('Cannot overwrite nonempty display images');
    return before;
  }
  await (await uniqueVisible(page, '#image_popup', 'image popup control')).click({ timeout: TIMEOUT });
  await (await uniqueVisible(page, '#content-modal', 'image modal')).waitFor({ state: 'visible', timeout: TIMEOUT });
  await (await uniqueVisible(page, '#content-modal #id_title', 'image search field')).fill(query, { timeout: TIMEOUT });
  await drawModalTable(page);
  for (const image of approved) {
    const selector = `#content-modal .select-row[data-id="${image.id}"]`;
    const button = await uniqueVisible(page, selector, `image ${image.id} selection`);
    if (await button.getAttribute('data-src') !== image.src) fail('Image selection source does not exactly match approval');
    await button.click({ timeout: TIMEOUT });
    const selected = page.locator(`#content-modal #selected_image_area .import-image[data-id="${image.id}"]`);
    if (await selected.count() !== 1 || await selected.getAttribute('src') !== image.src) fail('Image selection did not stick');
  }
  await (await uniqueVisible(page, '#content-modal #import-image-btn', 'image import control')).click({ timeout: TIMEOUT });
  await page.locator('#content-modal').waitFor({ state: 'hidden', timeout: TIMEOUT });
  const after = await readDisplayImageState(page);
  return assertDisplayImageDelta(before, after, approved);
}
