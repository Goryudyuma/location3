import assert from 'node:assert/strict';
import test from 'node:test';
import { boundsCovered, savedCoverageFeatures } from '../web/static/offline-coverage.mjs';

test('adjacent saved archives cover a viewport spanning their shared border', () => {
  assert.equal(boundsCovered([130, 30, 140, 40], [[130, 30, 135, 40], [135, 30, 140, 40]]), true);
  assert.equal(boundsCovered([130, 30, 140, 40], [[130, 30, 140, 35], [130, 35, 140, 40]]), true);
  assert.equal(boundsCovered([130, 30, 140, 40], [
    [130, 30, 135, 35], [135, 30, 140, 35], [130, 35, 135, 40], [135, 35, 140, 40],
  ]), true);
});

test('gaps and interior holes remain uncovered even when all corners are saved', () => {
  assert.equal(boundsCovered([130, 30, 140, 40], [[130, 30, 135, 40], [135.000001, 30, 140, 40]]), false);
  assert.equal(boundsCovered([130, 30, 140, 40], [[130, 30, 140, 35], [130, 36, 140, 40]]), false);
  assert.equal(boundsCovered([130, 30, 140, 40], [
    [130, 30, 134, 40], [136, 30, 140, 40], [134, 30, 136, 34], [134, 36, 136, 40],
  ]), false);
});

test('partial overlap is insufficient while overlapping archives can complete coverage', () => {
  assert.equal(boundsCovered([130, 30, 140, 40], [[132, 32, 138, 38]]), false);
  assert.equal(boundsCovered([130, 30, 140, 40], [[129, 29, 136, 41], [134, 29, 141, 41]]), true);
  assert.equal(boundsCovered([130, 30, 140, 40], [[130, 30, 136, 36], [134, 34, 140, 40]]), false);
});

test('exact boundaries, point views and duplicate archives use inclusive coverage', () => {
  const archive = [130, 30, 140, 40];
  assert.equal(boundsCovered(archive, [archive]), true);
  assert.equal(boundsCovered([140, 35, 140, 35], [archive]), true);
  assert.equal(boundsCovered([140, 30, 140, 40], [archive, archive]), true);
  assert.equal(boundsCovered([140, 30, 141, 40], [archive]), false);
  assert.equal(boundsCovered([180, 0, 180, 0], [[170, -10, 180, 10]]), true);
});

test('Japan archives do not claim views beyond their geographic coverage', () => {
  const japan = [[122, 20, 154, 46]];
  assert.equal(boundsCovered([138, 34, 141, 37], japan), true);
  assert.equal(boundsCovered([138, 45, 141, 47], japan), false);
  assert.equal(boundsCovered([-125, 30, -120, 35], japan), false);
  assert.equal(boundsCovered([-180, -85, 180, 85], japan), false);
});

test('wrapped viewport and archive longitudes preserve world-copy coverage', () => {
  assert.equal(boundsCovered([498, 34, 501, 37], [[138, 34, 141, 37]]), true);
  assert.equal(boundsCovered([-222, 34, -219, 37], [[138, 34, 141, 37]]), true);
  assert.equal(boundsCovered([138, 34, 141, 37], [[498, 34, 501, 37]]), true);
  const dateLine = [[170, -10, 180, 10], [-180, -10, -170, 10]];
  assert.equal(boundsCovered([175, -5, -175, 5], dateLine), true);
  assert.equal(boundsCovered([175, -5, 185, 5], dateLine), true);
  assert.equal(boundsCovered([175, -5, -175, 5], [dateLine[0]]), false);
  assert.equal(boundsCovered([175, -5, -175, 5], [[170, -10, -170, 10]]), true);
});

test('a full-world view needs coverage of every longitude', () => {
  assert.equal(boundsCovered([-180, -10, 180, 10], [[-180, -10, 0, 10], [0, -10, 180, 10]]), true);
  assert.equal(boundsCovered([-200, -10, 200, 10], [[-180, -10, 180, 10]]), true);
  assert.equal(boundsCovered([-200, -10, 200, 10], [[-179, -10, 180, 10]]), false);
});

test('missing or invalid bounds never claim that a region has been saved', () => {
  for (const bounds of [null, [], [130, 40, 140, 30], [130, -91, 140, 30], [130, 30, NaN, 40]]) {
    assert.equal(boundsCovered(bounds, [[-180, -90, 180, 90]]), false);
  }
  assert.equal(boundsCovered([130, 30, 140, 40], []), false);
  assert.equal(boundsCovered([130, 30, 140, 40], [null, [130, 30, Infinity, 40]]), false);
});

const detail = (regionKey, bounds) => ({ regionKey, bounds });
const polygonBounds = feature => {
  const ring = feature.geometry.coordinates[0];
  return [...ring[0], ...ring[2]];
};

test('saved polygons use detail archive bounds rather than the requested viewport or overview', () => {
  const result = savedCoverageFeatures([{
    bounds: [139.5, 35.5, 139.7, 35.7],
    archives: [
      { overview: true, bounds: [122, 20, 154, 46] },
      { overview: true, regionKey: 'overview', bounds: [-180, -85, 180, 85] },
      detail('8/227/101', [139.21875, 34.307, 140.625, 35.461]),
    ],
  }]);
  assert.equal(result.type, 'FeatureCollection');
  assert.equal(result.features.length, 1);
  assert.deepEqual(polygonBounds(result.features[0]), [139.21875, 34.307, 140.625, 35.461]);
  assert.equal(result.features[0].properties.regionKey, '8/227/101');
  const ring = result.features[0].geometry.coordinates[0];
  assert.deepEqual(ring[0], ring.at(-1));
});

test('shared regional archives are drawn once across overlapping packs and wrapped coordinates', () => {
  const west = detail('west', [130, 30, 135, 35]);
  const east = detail('east', [135, 30, 140, 35]);
  const packs = [
    { archives: [west, east] },
    { archives: [west, detail('east', [495, 30, 500, 35])] },
  ];
  assert.deepEqual(savedCoverageFeatures(packs).features.map(polygonBounds), [west.bounds, east.bounds]);
  assert.deepEqual(savedCoverageFeatures(packs.slice(1)).features.map(polygonBounds), [west.bounds, east.bounds]);
  assert.deepEqual(savedCoverageFeatures([]).features, []);
});

test('date-line regions become canonical polygons without a line spanning the globe', () => {
  for (const bounds of [[170, -10, -170, 10], [170, -10, 190, 10], [530, -10, 550, 10]]) {
    const features = savedCoverageFeatures([{ archives: [detail('date-line', bounds)] }]).features;
    assert.deepEqual(features.map(polygonBounds), [[170, -10, 180, 10], [-180, -10, -170, 10]]);
  }
  const features = savedCoverageFeatures([{ archives: [detail('edge', [170, -10, 180, 10])] }]).features;
  assert.equal(features.length, 1);
});

test('invalid, absent or empty archive boundaries do not produce misleading saved polygons', () => {
  assert.deepEqual(savedCoverageFeatures(undefined).features, []);
  const archives = [null, {}, detail('missing'), detail('bad-latitude', [130, -91, 140, 30]),
    detail('infinite', [130, 30, Infinity, 40]), detail('point', [130, 30, 130, 30]),
    detail('line', [130, 30, 140, 30])];
  assert.deepEqual(savedCoverageFeatures([{}, { archives }]).features, []);
});
