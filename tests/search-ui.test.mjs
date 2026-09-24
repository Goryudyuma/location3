import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { MIN_YEAR, MAX_YEAR, DEFAULT_VIEW, readState, writeState } from '../web/static/state.mjs';
import { createDatasetLoader, searchFeatures } from '../web/static/data.mjs';

const html = await readFile(new URL('../web/static/index.html', import.meta.url), 'utf8');
// Supply the browser-only imports below while exercising the production event handlers.
const script = (await readFile(new URL('../web/static/app.mjs', import.meta.url), 'utf8'))
  .replace(/^import .*;\n/gm, '');
const collection = (...features) => ({ type: 'FeatureCollection', features });
const station = name => ({
  type: 'Feature', properties: { N05_011: name, N05_002: '試験線' },
  geometry: { type: 'Point', coordinates: [139.7, 35.7] },
});
const empty = { railroads: collection(), stations: collection() };

function harness() {
  const nodes = new Map();
  const makeNode = () => ({
    value: '', hidden: true, checked: true, textContent: '', children: [], dataset: {},
    attributes: new Map(), listeners: new Map(), style: { setProperty() {} }, classList: { toggle() {} },
    setAttribute(name, value) { this.attributes.set(name, value); },
    addEventListener(name, handler) { this.listeners.set(name, handler); },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    focus() { document.activeElement = this; },
    blur() { document.activeElement = null; },
  });
  for (const [, id] of html.matchAll(/\bid="([^"]+)"/g)) nodes.set(id, makeNode());
  const document = {
    readyState: 'loading', activeElement: null,
    getElementById(id) {
      assert.ok(nodes.has(id), `Control ${id} must exist in the page`);
      return nodes.get(id);
    },
    querySelector: () => makeNode(), querySelectorAll: () => [], createElement: makeNode,
  };
  const pending = [];
  const view = { lat: 35.7, lng: 139.7, zoom: 12 };
  let panelClosed = 0;
  let cameraMoved = 0;
  const window = {
    location: new URL('https://location3.example/?year=2024&lat=35.7&lng=139.7&zoom=12'),
    maplibregl: {}, addEventListener() {},
  };
  const context = {
    window, document, URL, AbortController, setTimeout, clearTimeout, console: { error() {} },
    MIN_YEAR, MAX_YEAR, DEFAULT_VIEW, readState, writeState, searchFeatures,
    history: { replaceState(_state, _title, url) { window.location = new URL(url); } },
    createDatasetLoader: () => createDatasetLoader(url => new Promise((resolve, reject) => {
      pending.push({ url, resolve, reject, settled: false });
    })),
    createMobilePanel: () => ({ close() { panelClosed++; } }),
    createOfflineControls: () => ({}),
    createRailwayMap: () => ({
      getView: () => ({ ...view }), setVisibility() {}, async setData() {},
      resetView() { cameraMoved++; }, focusResult() { cameraMoved++; },
    }),
  };
  vm.runInNewContext(script, context);
  context.init();
  const element = id => nodes.get(id);
  const click = id => element(id).listeners.get('click')({ target: element(id) });
  const input = value => {
    element('searchInput').value = value;
    element('searchInput').listeners.get('input')();
  };
  async function complete(data, error) {
    for (const request of pending.filter(request => !request.settled)) {
      request.settled = true;
      if (error) request.reject(error);
      else request.resolve({ ok: true, json: async () => request.url.startsWith('/api/stations') ? data.stations : data.railroads });
    }
    await new Promise(resolve => setImmediate(resolve));
  }
  return {
    element, click, input, complete, pending, window, document,
    get panelClosed() { return panelClosed; }, get cameraMoved() { return cameraMoved; },
  };
}

test('a failed year search can expand to all periods without losing its query, view or open panel', async () => {
  const app = harness();
  app.input('廃駅');
  assert.equal(app.element('searchAllYears').hidden, true, 'Loading must not offer a premature no-results action');
  await app.complete(empty);
  assert.equal(app.element('searchAllYears').hidden, false);
  assert.match(app.element('searchHint').textContent, /2024年/);

  app.click('searchAllYears');
  assert.equal(app.element('searchAllYears').hidden, true);
  assert.equal(app.element('searchInput').value, '廃駅');
  assert.equal(app.document.activeElement, app.element('searchInput'));
  assert.equal(app.window.location.searchParams.get('year'), 'all');
  assert.deepEqual(['lat', 'lng', 'zoom'].map(key => app.window.location.searchParams.get(key)), ['35.70000', '139.70000', '12']);
  assert.deepEqual(app.pending.slice(-2).map(request => request.url), ['/api/railroads', '/api/stations']);
  await app.complete({ ...empty, stations: collection(station('廃駅')) });
  assert.equal(app.element('searchResults').children.length, 1);
  assert.equal(app.element('searchAllYears').hidden, true);
  assert.equal(app.element('searchInput').attributes.get('aria-label'), '全期間の駅・路線を検索');
  assert.equal(app.panelClosed, 0);
  assert.equal(app.cameraMoved, 0);
});

test('empty input, matches, loading and all-period misses do not offer a broader search', async () => {
  const app = harness();
  await app.complete({ ...empty, stations: collection(station('東京')) });
  for (const query of ['', '　 ', '東京']) {
    app.input(query);
    assert.equal(app.element('searchAllYears').hidden, true, query);
  }
  app.input('見つからない駅');
  assert.equal(app.element('searchAllYears').hidden, false);
  app.click('searchAllYears');
  assert.equal(app.element('searchAllYears').hidden, true);
  await app.complete(empty);
  assert.equal(app.element('searchAllYears').hidden, true);
  assert.match(app.element('searchHint').textContent, /全期間でも見つかりません/);
});

test('all-period loading errors can be retried inside the search panel with the query intact', async () => {
  const app = harness();
  await app.complete(empty);
  app.input('廃駅');
  app.click('searchAllYears');
  await app.complete(null, new Error('Offline'));
  assert.equal(app.element('retrySearch').hidden, false);
  assert.equal(app.element('retry').hidden, false, 'The existing map retry remains available');
  assert.equal(app.element('searchAllYears').hidden, true);
  app.click('retrySearch');
  assert.equal(app.element('retrySearch').hidden, true);
  assert.equal(app.element('searchInput').value, '廃駅');
  assert.deepEqual(app.pending.slice(-2).map(request => request.url), ['/api/railroads', '/api/stations']);
  await app.complete({ ...empty, stations: collection(station('廃駅')) });
  assert.equal(app.element('searchResults').children.length, 1);
  assert.equal(app.element('retrySearch').hidden, true);
  assert.equal(app.panelClosed, 0);
  assert.equal(app.cameraMoved, 0);
});
