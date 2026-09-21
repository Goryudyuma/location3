import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { filterCollections, parseYear, periodStarts } from '../web/static/railway-filter.mjs';
import * as build from '../scripts/prepare-data.mjs';

function feature(id, line, start, end) {
  return {
    type: 'Feature', id,
    properties: { N05_002: line, N05_005b: start, N05_005e: end },
    geometry: null,
  };
}

const collection = (...features) => ({ type: 'FeatureCollection', name: '日本の鉄道', features });

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    Object.values(value).forEach(freeze);
  }
  return value;
}

test('offline and build paths use the same year filtering functions', () => {
  assert.equal(build.filterCollections, filterCollections);
  assert.equal(build.parseYear, parseYear);
  assert.equal(build.periodStarts, periodStarts);
});

test('offline filtering leaves saved all-period collections and feature geometry intact', () => {
  const saved = freeze({
    railroads: collection(feature('old-line', '旧線', 1950, 1960), feature('new-line', '新線', 1961, 9999)),
    stations: collection(feature('old-station', ' 旧線 ', 1950, 1960), feature('new-station', '新線', 1961, 9999)),
  });
  const result = filterCollections(saved, 1960);
  assert.deepEqual(result.railroads.features.map(value => value.id), ['old-line']);
  assert.deepEqual(result.stations.features.map(value => value.id), ['old-station']);
  assert.notEqual(result.railroads.features, saved.railroads.features);
  assert.equal(result.railroads.features[0], saved.railroads.features[0]);
  assert.equal(result.stations.features[0], saved.stations.features[0]);
  assert.equal(result.railroads.name, saved.railroads.name);
  assert.equal(filterCollections(saved, null), saved);
  assert.deepEqual(filterCollections(saved, 1961).stations.features.map(value => value.id), ['new-station']);
});

test('offline stations need both an active year and an active named line', () => {
  const saved = {
    railroads: collection(feature('known', '中央線', '999', '9999'), feature('nameless', '', 1950, 2024)),
    stations: collection(
      feature('active', ' 中央線 ', '999', '9999'),
      feature('closed', '中央線', 1950, 1960),
      feature('future', '中央線', 2020, 9999),
      feature('orphan', '存在しない線', 1950, 2024),
      feature('nameless', '', 1950, 2024),
    ),
  };
  assert.deepEqual(filterCollections(saved, 1980).stations.features.map(value => value.id), ['active']);
  assert.deepEqual(filterCollections(saved, 1960).stations.features.map(value => value.id), ['active', 'closed']);
});

test('manifest byte sizes equal the stored UTF-8 bytes of saved full datasets', async t => {
  const root = await mkdtemp(join(tmpdir(), 'location3-offline-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inputDir = join(root, 'input');
  const staticDir = join(root, 'static');
  const outputDir = join(root, 'output');
  await mkdir(inputDir);
  await mkdir(staticDir);
  for (const name of ['RailroadSection2', 'Station2']) {
    await writeFile(join(inputDir, `N05-24_${name}.geojson`), JSON.stringify(collection(feature(name, '日本線', 1950, 9999))));
  }
  const { manifest } = await build.prepareData({ inputDir, staticDir, outputDir });
  for (const pair of [manifest.all, ...manifest.periods]) {
    for (const entry of [pair.railroads, pair.stations]) {
      const body = await readFile(join(outputDir, entry.path));
      assert.equal(entry.bytes, body.byteLength);
      assert.ok(Number.isSafeInteger(entry.bytes) && entry.bytes > 0);
    }
  }
  const full = await readFile(join(outputDir, manifest.all.railroads.path), 'utf8');
  assert.ok(manifest.all.railroads.bytes > full.length, 'Japanese UTF-8 bytes must not be counted as JS code units');
});
