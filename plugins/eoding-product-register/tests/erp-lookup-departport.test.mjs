import test from 'node:test';
import assert from 'node:assert/strict';
import { erpLookup } from '../src/erp-lookup.mjs';

// Execute the actual page.evaluate callbacks against a read-only browser DOM fixture.
// A table exposes only its current rows: paging, drawing and writes are unavailable.
function fixture(t, { rows = [], links = [], pageUrl = 'https://basecamp.team/tour/master_product/', login = false, replies = {}, initializingChecks = 0 } = {}) {
  const previous = new Map(['location', 'document', 'DOMParser', 'jQuery'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  let tableReads = 0, readinessChecks = 0;
  const tableNode = {};
  const table = {
    settings: () => [{ _bInitComplete: ++readinessChecks > initializingChecks }],
    rows: options => { assert.deepEqual(options, { page: 'current' }); tableReads++; return { data: () => ({ toArray: () => rows }) }; }
  };
  const jq = node => { assert.equal(node, tableNode); return { DataTable: () => table }; };
  jq.fn = { dataTable: { isDataTable: node => node === tableNode } };
  Object.assign(globalThis, {
    location: { href: pageUrl },
    document: {
      querySelector: selector => {
        if (selector === 'input[type=password]') return login ? {} : null;
        if (selector === '#DataTables_Table_0') return tableNode;
        throw new Error('Unexpected DOM read: ' + selector);
      },
      querySelectorAll: selector => { assert.equal(selector, 'a[href]'); return links.map(href => ({ href })); }
    },
    jQuery: jq,
    DOMParser: class {
      parseFromString(body, type) {
        assert.equal(type, 'text/html');
        const data = JSON.parse(body);
        return {
          querySelector: selector => { assert.equal(selector, 'input[type=password]'); return data.login ? {} : null; },
          querySelectorAll: selector => {
            assert.equal(selector, 'select#id_departport');
            return (data.lists ?? []).map(options => ({ options: options.map(option => ({ value: option.value, textContent: option.label })) }));
          }
        };
      }
    }
  });
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.deepEqual(options, { method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
    assert.match(url, /^\/tour\/master_product\/([1-9][0-9]*)\/create_product\/\?from=\1$/);
    const id = /^\/tour\/master_product\/([0-9]+)/.exec(url)[1];
    requests.push(id);
    const reply = replies[id] ?? { status: 404 };
    if (reply.networkError) throw new Error('Network unavailable');
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200 });
  });
  return { page: { evaluate: (fn, arg) => fn(arg) }, requests, tableReads: () => tableReads };
}

const ports = [{ value: '', label: '선택' }, { value: '17', label: ' 인천 ' }, { value: '23', label: '부산' }];
const good = { body: { lists: [ports] } };

test('departport discovers a current product-list ID and preserves exact observed option values', async t => {
  const f = fixture(t, { rows: [{ id: 81234 }], replies: { 81234: good } });
  assert.deepEqual(await erpLookup(f.page, { kind: 'departport' }), {
    kind: 'departport', productId: '81234', results: [{ value: '17', label: '인천' }, { value: '23', label: '부산' }]
  });
  assert.deepEqual(f.requests, ['81234']);
  assert.equal(f.tableReads(), 1);
});

test('a supplied product succeeds without collecting or paging the list', async t => {
  const f = fixture(t, { replies: { 81234: good } });
  await erpLookup(f.page, { kind: 'departport', productId: '81234' });
  assert.deepEqual(f.requests, ['81234']);
  assert.equal(f.tableReads(), 0);
});

test('discovery waits briefly for the current table controller and accepts an initialized empty list', async t => {
  const f = fixture(t, { rows: [{ id: 81234 }], initializingChecks: 2, replies: { 81234: good } });
  assert.equal((await erpLookup(f.page, { kind: 'departport' })).productId, '81234');
  assert.equal(f.tableReads(), 1);
  globalThis.jQuery = () => ({ DataTable: () => ({ settings: () => [{ _bInitComplete: true }], rows: () => ({ data: () => ({ toArray: () => [] }) }) }) });
  globalThis.jQuery.fn = { dataTable: { isDataTable: () => true } };
  await assert.rejects(() => erpLookup(f.page, { kind: 'departport' }), /관측된 상품 ID가 없습니다/);
  assert.deepEqual(f.requests, ['81234']);
});

test('a stale product returning 500 falls back to a product actually observed in the same session', async t => {
  const f = fixture(t, { rows: [{ id: '81234' }], replies: { 99999: { status: 500 }, 81234: good } });
  const found = await erpLookup(f.page, { kind: 'departport', productId: '99999' });
  assert.equal(found.productId, '81234');
  assert.deepEqual(f.requests, ['99999', '81234']);
});

test('discovery accepts only observed same-origin product links and deduplicates IDs', async t => {
  const f = fixture(t, {
    rows: [{ id: 'not-an-id' }],
    links: ['https://example.com/tour/master_product/1/change/', 'https://attacker@basecamp.team/tour/master_product/2/change/', '/tour/master_product/81234/change/', '/tour/master_product/81234/create_product/?from=81234', '/tour/product/99/change/'],
    replies: { 81234: good }
  });
  assert.equal((await erpLookup(f.page, { kind: 'departport' })).productId, '81234');
  assert.deepEqual(f.requests, ['81234']);
});

test('all unavailable candidates stop after three GETs and report each product/status', async t => {
  const f = fixture(t, { rows: [1, 2, 3, 4].map(id => ({ id })), replies: { 1: { status: 500 }, 2: { status: 404 }, 3: { body: {} }, 4: good } });
  await assert.rejects(() => erpLookup(f.page, { kind: 'departport' }), /1: HTTP 500; 2: HTTP 404; 3: 출발지 선택 목록 없음/);
  assert.deepEqual(f.requests, ['1', '2', '3']);
});

test('a login response aborts distinctly without retrying another product', async t => {
  const f = fixture(t, { rows: [{ id: 81234 }], replies: { 99999: { body: { login: true } }, 81234: good } });
  await assert.rejects(() => erpLookup(f.page, { kind: 'departport', productId: '99999' }), /로그인이 필요/);
  assert.deepEqual(f.requests, ['99999']);
});

test('permission and ambiguous select responses never fall back to another product', async t => {
  const f = fixture(t, { rows: [{ id: 81234 }], replies: { 99999: { status: 403 }, 88888: { body: { lists: [ports, ports] } }, 81234: good } });
  await assert.rejects(() => erpLookup(f.page, { kind: 'departport', productId: '99999' }), /로그인 또는 접근 권한.*403/);
  await assert.rejects(() => erpLookup(f.page, { kind: 'departport', productId: '88888' }), /목록이 여러 개/);
  assert.deepEqual(f.requests, ['99999', '88888']);
});

test('wrong origin or existing login form stops before GET and no observed IDs is explicit', async t => {
  const f = fixture(t, { pageUrl: 'https://example.com/tour/master_product/', rows: [{ id: 81234 }] });
  await assert.rejects(() => erpLookup(f.page, { kind: 'departport' }), /로그인된 어딩 ERP/);
  globalThis.location.href = 'https://basecamp.team/tour/master_product/';
  globalThis.document.querySelector = selector => selector === 'input[type=password]' ? {} : null;
  await assert.rejects(() => erpLookup(f.page, { kind: 'departport' }), /로그인이 필요/);
  globalThis.document.querySelector = () => null;
  await assert.rejects(() => erpLookup(f.page, { kind: 'departport' }), /관측된 상품 ID가 없습니다/);
  assert.deepEqual(f.requests, []);
});

test('lookup does not navigate away from a possibly edited product form to find candidates', async t => {
  const f = fixture(t, { pageUrl: 'https://basecamp.team/tour/master_product/81234/change/', rows: [{ id: 81234 }], replies: { 81234: good } });
  await assert.rejects(() => erpLookup(f.page, { kind: 'departport' }), /관측된 상품 ID가 없습니다/);
  assert.deepEqual(f.requests, []);
  assert.equal(f.tableReads(), 0);
});
