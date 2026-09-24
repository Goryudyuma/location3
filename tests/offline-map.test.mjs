import assert from 'node:assert/strict';
import test from 'node:test';
import { createSavedCoverageLayer } from '../web/static/offline-map.mjs';

function fixture() {
  let finish;
  const ready = new Promise(resolve => { finish = resolve; });
  const layers = [{ id: 'railway-lines' }, { id: 'railway-stations' }];
  const sources = new Map();
  const map = {
    addSource(id, source) { sources.set(id, { ...source, setData(data) { this.data = data; } }); },
    getSource(id) { return sources.get(id); },
    addLayer(layer, before) { layers.splice(layers.findIndex(item => item.id === before), 0, layer); },
    setLayoutProperty(id, key, value) { layers.find(layer => layer.id === id).layout[key] = value; },
  };
  const setCoverage = createSavedCoverageLayer(map, ready, 'railway-lines');
  const data = () => sources.get('saved-map-coverage').data;
  const coverage = () => layers.filter(layer => layer.source === 'saved-map-coverage');
  return { finish, ready, setCoverage, layers, sources, data, coverage };
}

const pack = { archives: [{ regionKey: 'saved-region', bounds: [130, 30, 140, 40] }] };

test('the latest saved coverage is applied after the style loads and remains below railway features', async () => {
  const f = fixture();
  f.setCoverage([], false);
  f.setCoverage([pack], true);
  assert.equal(f.sources.size, 0);
  f.finish();
  await f.ready;
  assert.equal(f.data().features.length, 1);
  assert.deepEqual(f.layers.map(layer => layer.type ?? layer.id), ['fill', 'line', 'railway-lines', 'railway-stations']);
  assert.ok(f.coverage().every(layer => layer.layout.visibility === 'visible'));
});

test('saving, hiding, deleting and showing replace the existing coverage instead of retaining stale areas', async () => {
  const f = fixture();
  f.finish();
  await f.ready;
  assert.equal(f.data().features.length, 0);
  assert.ok(f.coverage().every(layer => layer.layout.visibility === 'none'));
  f.setCoverage([pack], true);
  assert.equal(f.data().features.length, 1);
  f.setCoverage([pack], false);
  assert.ok(f.coverage().every(layer => layer.layout.visibility === 'none'));
  f.setCoverage([], false);
  f.setCoverage([], true);
  assert.equal(f.data().features.length, 0);
  assert.ok(f.coverage().every(layer => layer.layout.visibility === 'visible'));
  assert.equal(f.sources.size, 1);
  assert.equal(f.layers.length, 4);
});
