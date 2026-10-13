// The element-type picker has the image option (4). Text rows also contain
// color (0..3) and bold (0..1) selects inside reference_element containers.
const selector = '#reference_body .cont_box.reference_element select:has(option[value="4"])';
const fail = () => { throw new Error('Unsupported native reference picker'); };

/** Operate either the visible native select or its exact Materialize UI pair.
 * The same ERP uses Materialize for the basic status field. Unknown widgets stay blocked.
 */
export async function prepareReferencePicker(page, types, timeout = 5000) {
  const selector = '#reference_body .cont_box.reference_element select:has(option[value="4"])';
  const select = page.locator(selector);
  if (await select.count() !== 1 || !await select.isEnabled()) fail();
  const options = await select.locator('option').evaluateAll(nodes => nodes.map(node => ({
    value: node.value, label: node.textContent.trim(), disabled: node.disabled || node.parentElement?.disabled === true
  })));
  const labels = new Map();
  for (const type of types) {
    const matches = options.filter(option => option.value === type && !option.disabled);
    if (matches.length !== 1 || !matches[0].label) fail();
    labels.set(type, matches[0].label);
  }
  if (await select.isVisible()) return {
    async choose(type) {
      if (!labels.has(type) || !await select.isVisible() || !await select.isEnabled()) fail();
      await select.selectOption(type, { timeout });
      if (await select.inputValue() !== type) fail();
    }
  };
  const parent = select.locator('..');
  if (!(await parent.getAttribute('class') ?? '').split(/\s+/).includes('select-wrapper')) fail();
  const input = parent.locator('input.select-dropdown.dropdown-trigger');
  if (await input.count() !== 1 || !await input.isVisible() || !await input.isEnabled()) fail();
  const target = await input.getAttribute('data-target');
  if (!target || !/^[A-Za-z0-9_-]+$/.test(target)) fail();
  const menu = page.locator('ul[id="' + target + '"]');
  if (await menu.count() !== 1) fail();
  const optionFor = label => menu.locator('li:not(.disabled):not([aria-disabled="true"]) span').filter({ hasText: new RegExp('^\\s*' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$') });
  const check = async () => {
    if (await select.count() !== 1 || await select.isVisible() || !await select.isEnabled() || await input.getAttribute('data-target') !== target) fail();
  };
  const previous = await select.inputValue();
  await input.click({ timeout });
  await menu.waitFor({ state: 'visible', timeout });
  try {
    for (const label of labels.values()) {
      const option = optionFor(label);
      if (await option.count() !== 1 || !await option.isVisible()) fail();
    }
  } finally {
    await input.press('Escape', { timeout });
    // Some ERP Materialize builds leave this menu open after Escape. Close only
    // the widget whose trigger and menu were verified above; never select a value.
    try { await menu.waitFor({ state: 'hidden', timeout: Math.min(timeout, 350) }); }
    catch {
      const closed = await input.evaluate((element, target) => {
        const getInstance = window.M?.Dropdown?.getInstance;
        if (typeof getInstance !== 'function') return false;
        const instance = getInstance(element);
        if (!instance || instance.el !== element || instance.dropdownEl !== document.getElementById(target) || typeof instance.close !== 'function') return false;
        instance.close();
        return true;
      }, target);
      if (!closed) fail();
    }
    await menu.waitFor({ state: 'hidden', timeout });
  }
  if (await select.inputValue() !== previous) fail();
  return {
    async choose(type) {
      if (!labels.has(type)) fail();
      // ERP tab GETs and added rows may rebuild Materialize with a new menu ID.
      // Revalidate the replacement widget instead of using the stale binding.
      if (await input.count() === 1 && await input.getAttribute('data-target') !== target) {
        const replacement = await prepareReferencePicker(page, types, timeout);
        return replacement.choose(type);
      }
      await check();
      await input.click({ timeout });
      await menu.waitFor({ state: 'visible', timeout });
      const option = optionFor(labels.get(type));
      if (await option.count() !== 1 || !await option.isVisible()) fail();
      await option.click({ timeout });
      await page.waitForFunction(({ selector, type }) => {
        const matches = document.querySelectorAll(selector);
        return matches.length === 1 && matches[0].value === type;
      }, { selector, type }, { timeout });
    }
  };
}
