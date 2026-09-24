import assert from 'node:assert/strict';
import test from 'node:test';
import { featureBounds, nearestPointFeature } from '../web/static/map-geometry.mjs';

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

const pointFeature = (name, coordinates) => ({
  type: 'Feature', properties: { name }, geometry: { type: 'Point', coordinates },
});
const project = ([x, y]) => ({ x, y });

test('station picking chooses the closest point, independent of drawing order', () => {
  const farther = pointFeature('farther', [115, 50]);
  const closer = pointFeature('closer', [104, 50]);
  for (const features of [[farther, closer], [closer, farther]]) {
    assert.deepEqual(nearestPointFeature(features, { x: 100, y: 50 }, 22, project), {
      feature: closer, coordinates: [104, 50],
    });
  }
});

test('station picking accepts nearby taps but excludes the corners of its query box', () => {
  const edge = pointFeature('edge', [122, 50]);
  assert.equal(nearestPointFeature([edge], { x: 100, y: 50 }, 22, project).feature, edge);
  for (const features of [[], [pointFeature('outside', [122.1, 50])], [pointFeature('corner', [120, 70])]]) {
    assert.equal(nearestPointFeature(features, { x: 100, y: 50 }, 22, project), undefined);
  }
});

test('station picking keeps the topmost of coincident stations and ignores lines', () => {
  const first = pointFeature('first', [100, 50]);
  const second = pointFeature('second', [100, 50]);
  const line = { geometry: { type: 'LineString', coordinates: [[100, 50], [110, 50]] } };
  assert.equal(nearestPointFeature([line, first, second], { x: 100, y: 50 }, 22, project).feature, first);
});

test('station picking uses projected screen distance and anchors popups to the visible world copy', () => {
  const station = pointFeature('wrapped station', [141, 43]);
  const projectWrapped = ([lng, lat]) => ({ x: (lng - 500) * 10, y: (lat - 43) * 10 });
  assert.deepEqual(nearestPointFeature([station], { x: 30, y: 0 }, 22, projectWrapped, 501), {
    feature: station, coordinates: [501, 43],
  });
  assert.equal(nearestPointFeature([station], { x: 33, y: 0 }, 22, projectWrapped, 501), undefined);
});
