import assert from 'node:assert/strict';
import test from 'node:test';
import { readProductOnlyIdentity } from '../src/product-only-launcher.mjs';
import { ERP_URL } from '../src/browser.mjs';

function fixture({ initial = 'https://basecamp.team/v2/dashboard', accountVisible = false, redirect = ERP_URL, loginAfterNavigation = false } = {}) {
  let current = initial;
  const visits = [];
  return {
    visits,
    url: () => current,
    goto: async url => { visits.push(url); current = redirect; },
    context: () => ({ cookies: async () => [{ name: 'fixture', value: 'test-only', domain: 'basecamp.team', path: '/', httpOnly: true }] }),
    locator: selector => ({
      count: async () => selector === '#eoding-name' ? Number(accountVisible || visits.length > 0) : Number(loginAfterNavigation && visits.length > 0),
      innerText: async () => accountVisible || visits.length > 0 ? 'Fixture Operator' : '',
      evaluateAll: async callback => callback([{ src: 'https://media.eoding.com/media/travelagent/7/logo/a.png' }])
    })
  };
}

test('new dashboard without account marker recovers identity through the product list once', async () => {
  for (const suffix of ['', '/']) {
    const page = fixture({ initial: 'https://basecamp.team/v2/dashboard' + suffix });
    const result = await readProductOnlyIdentity(page);
    assert.equal(result.companyId, '7');
    assert.equal(result.identity.accountName, 'Fixture Operator');
    assert.deepEqual(page.visits, [ERP_URL]);
  }
});

test('dashboard recovery rechecks origin and login after navigation', async () => {
  await assert.rejects(readProductOnlyIdentity(fixture({ redirect: 'https://other.example/' })), /approved Basecamp origin/);
  await assert.rejects(readProductOnlyIdentity(fixture({ loginAfterNavigation: true })), /Login is required/);
});

test('identity recovery preserves existing product forms and dashboards with an account marker', async () => {
  const form = fixture({ initial: ERP_URL + '7/' });
  await assert.rejects(readProductOnlyIdentity(form), /account name is missing/);
  assert.deepEqual(form.visits, []);
  const dashboard = fixture({ accountVisible: true });
  assert.equal((await readProductOnlyIdentity(dashboard)).companyId, '7');
  assert.deepEqual(dashboard.visits, []);
});
