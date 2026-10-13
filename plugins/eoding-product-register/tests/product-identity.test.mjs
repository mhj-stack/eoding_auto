import assert from 'node:assert/strict';
import test from 'node:test';
import { readProductOnlyIdentity } from '../src/product-only-launcher.mjs';

function page(images, { name = 'Operator', login = false, cookies = true } = {}) {
  return {
    url: () => 'https://basecamp.team/tour/master_product/',
    context: () => ({ cookies: async () => cookies ? [{ name: 'fixture', value: 'test-only', domain: 'basecamp.team', path: '/', httpOnly: true }] : [] }),
    locator: selector => ({
      count: async () => Number(login), innerText: async () => name,
      evaluateAll: async callback => callback(images.map(src => ({ src })))
    })
  };
}

test('company identity accepts both real ERP logo paths and preserves account/session binding', async () => {
  const oldLogo = await readProductOnlyIdentity(page(['https://media.eoding.com/media/travelagent/7/erp_logo/a.png']));
  const currentLogo = await readProductOnlyIdentity(page(['https://media.eoding.com/media/travelagent/7/logo/a.png']));
  assert.equal(currentLogo.companyId, '7');
  assert.deepEqual(oldLogo, currentLogo);
  assert.equal(currentLogo.identity.accountName, 'Operator');
  assert.match(currentLogo.identity.sessionKey, /^[a-f0-9]{64}$/);
});

test('company identity still rejects ambiguous, unrelated and unauthenticated pages', async () => {
  for (const images of [[], ['https://other.example/media/travelagent/7/logo/a.png'], ['https://media.eoding.com/media/travelagent/7/gallery/a.png'], ['https://media.eoding.com/media/travelagent/7/logo/a.png','https://media.eoding.com/media/travelagent/999/erp_logo/a.png']]) {
    await assert.rejects(readProductOnlyIdentity(page(images)), /missing or ambiguous/);
  }
  const images = ['https://media.eoding.com/media/travelagent/7/logo/a.png'];
  await assert.rejects(readProductOnlyIdentity(page(images, { login: true })), /Login is required/);
  await assert.rejects(readProductOnlyIdentity(page(images, { cookies: false })), /HttpOnly/);
  await assert.rejects(readProductOnlyIdentity(page(images, { name: '' })), /account name is missing/);
});
