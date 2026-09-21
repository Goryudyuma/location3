import assert from 'node:assert/strict';
import test from 'node:test';
import { featureBounds } from '../web/static/map-geometry.mjs';

test('map search bounds include all parts of historical station and railway geometries', () => {
  for (const [geometry, expected] of [
    [{ type: 'Point', coordinates: [141.35, 43.06] }, [141.35, 43.06, 141.35, 43.06]],
    [{ type: 'MultiPoint', coordinates: [[141, 43], [142, 44]] }, [141, 43, 142, 44]],
    [{ type: 'MultiLineString', coordinates: [[[139, 35], [140, 36]], [[141, 34], [138, 37]]] }, [138, 34, 141, 37]],
    [{ type: 'GeometryCollection', geometries: [
      { type: 'Point', coordinates: [130, 30] },
      { type: 'GeometryCollection', geometries: [{ type: 'LineString', coordinates: [[145, 40], [140, 45]] }] },
    ] }, [130, 30, 145, 45]],
  ]) assert.deepEqual(featureBounds({ type: 'Feature', geometry }), expected);
});

test('map search ignores missing or invalid coordinates instead of moving the map', () => {
  for (const geometry of [null, { type: 'Point', coordinates: [181, 35] }, { type: 'Point', coordinates: [139, NaN] },
    { type: 'LineString', coordinates: [] }, { type: 'Point', coordinates: [139] }]) {
    assert.equal(featureBounds({ type: 'Feature', geometry }), null);
  }
  assert.equal(featureBounds(null), null);
  assert.deepEqual(featureBounds({ geometry: { type: 'LineString', coordinates: [[139, 35], [Infinity, 36], [140, 36]] } }), [139, 35, 140, 36]);
});
