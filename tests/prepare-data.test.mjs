import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { filterCollections, parseYear, periodStarts, prepareData } from '../scripts/prepare-data.mjs';

const inputDir = fileURLToPath(new URL('../internal/server/testdata/', import.meta.url));
const collections = {
  railroads: JSON.parse(await readFile(join(inputDir, 'N05-24_RailroadSection2.geojson'), 'utf8')),
  stations: JSON.parse(await readFile(join(inputDir, 'N05-24_Station2.geojson'), 'utf8')),
};

test('precomputed data preserves the Go API year boundaries, unknown values and active lines', () => {
  const cases = [
    [null, ['historic', 'modern', 'boundary', 'unknown', 'malformed'], ['old-station', 'modern-station', 'boundary-station', 'orphan-station', 'nameless-station', 'closed-station']],
    [1899, ['unknown', 'malformed'], []],
    [1900, ['historic', 'unknown', 'malformed'], ['old-station']],
    [1950, ['historic', 'boundary', 'unknown', 'malformed'], ['old-station', 'boundary-station']],
    [1951, ['modern', 'unknown', 'malformed'], ['modern-station']],
  ];
  for (const [year, railroads, stations] of cases) {
    const result = filterCollections(collections, year);
    assert.deepEqual(result.railroads.features.map(feature => feature.id), railroads);
    assert.deepEqual(result.stations.features.map(feature => feature.id), stations);
    assert.equal(result.railroads.name, collections.railroads.name);
    const historic = result.railroads.features.find(feature => feature.id === 'historic');
    if (historic) assert.equal(historic.sourceNote, 'preserve foreign members');
  }
});

test('period boundaries preserve results across the entire supported calendar range', () => {
  const starts = periodStarts(collections);
  assert.equal(starts[0], 1);
  for (let year = 1; year <= 9999; year++) {
    const start = starts.findLast(value => value <= year);
    for (const kind of ['railroads', 'stations']) {
      assert.deepEqual(filterCollections(collections, start)[kind].features, filterCollections(collections, year)[kind].features, `${kind}: ${year}`);
    }
  }
});

test('year parsing rejects malformed/sentinel/fractional values consistently', () => {
  for (const value of [999, '9999', 'bad', '1900bad', '', null, undefined, 1950.5, Infinity, -1, 0]) assert.equal(parseYear(value), null);
  for (const value of [' 1950 ', '+1950', 1950]) assert.equal(parseYear(value), 1950);
});

test('build emits content-addressed assets, counts, frontend files and deterministic manifest', async t => {
  const root = await mkdtemp(join(tmpdir(), 'location3-build-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const staticDir = join(root, 'static');
  const outputDir = join(root, 'out');
  await mkdir(staticDir);
  await writeFile(join(staticDir, 'index.html'), '<title>Railway test</title>');
  const first = await prepareData({ inputDir, staticDir, outputDir });
  assert.equal(await readFile(join(outputDir, 'index.html'), 'utf8'), '<title>Railway test</title>');
  const manifest = JSON.parse(await readFile(join(outputDir, 'datasets/manifest.json'), 'utf8'));
  for (const entry of [manifest.all, ...manifest.periods]) {
    for (const kind of ['railroads', 'stations']) {
      const { path, count } = entry[kind];
      const body = await readFile(join(outputDir, path));
      assert.equal(path, `/datasets/${createHash('sha256').update(body).digest('hex')}.geojson`);
      assert.equal(JSON.parse(body).features.length, count);
    }
  }
  const second = await prepareData({ inputDir, staticDir, outputDir });
  assert.deepEqual(first, second);
  await assert.rejects(prepareData({ inputDir, staticDir, outputDir, maxAssetBytes: 100 }), /asset limit/);
  assert.deepEqual(JSON.parse(await readFile(join(outputDir, 'datasets/manifest.json'), 'utf8')), manifest);
});

test('build refuses to overwrite source data or an unmarked directory', async t => {
  const root = await mkdtemp(join(tmpdir(), 'location3-build-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const staticDir = join(root, 'static');
  const outputDir = join(root, 'out');
  await mkdir(staticDir);
  await mkdir(outputDir);
  await assert.rejects(prepareData({ inputDir, staticDir, outputDir: staticDir }), /separate/);
  await assert.rejects(prepareData({ inputDir, staticDir, outputDir }), /unmarked/);
});
