import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BLOCK_BYTES, ensureBasemaps, gridForBounds, MAX_ARCHIVE_BYTES, prepareBasemaps, tileBounds, validateCatalog } from '../scripts/prepare-basemap.mjs';

function fixture(overviewBody = 'overview fixture') {
  const bodies = new Map();
  function entry(text, fields) {
    const body = Buffer.from(text);
    const sha256 = createHash('sha256').update(body).digest('hex');
    const url = `/basemaps/${sha256}.pmtiles`;
    bodies.set(url, body);
    return { url, sha256, bytes: body.length, blockBytes: BLOCK_BYTES, blockBase: `/basemap-blocks/${sha256}/`, ...fields };
  }
  const catalog = {
    version: 1,
    source: 'https://build.protomaps.com/20260920.pmtiles',
    overview: entry(overviewBody, { bounds: [122, 20, 154, 46], minzoom: 0, maxzoom: 8 }),
    regions: [entry('regional fixture', { bounds: tileBounds(8, 228, 94), minzoom: 9, maxzoom: 14, regionKey: '8/228/94' })],
  };
  return { catalog, bodies };
}

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'location3-basemap-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, cacheDir: join(root, 'cache'), outputDir: join(root, 'output') };
}

test('grid uses half-open tile bounds, including the last world column and row', () => {
  for (const [z, x, y] of [[8, 228, 94], [8, 227, 100], [9, 454, 201], [10, 909, 403], [8, 255, 255], [0, 0, 0]]) {
    const bounds = tileBounds(z, x, y);
    assert.deepEqual(gridForBounds(bounds, z), [{ z, x, y, regionKey: `${z}/${x}/${y}`, bounds }]);
  }
  const parent = tileBounds(8, 228, 94);
  assert.deepEqual(gridForBounds(parent, 9).map(region => region.regionKey), ['9/456/188', '9/457/188', '9/456/189', '9/457/189']);
  assert.equal(gridForBounds([122, 20, 154, 46]).length, 552);
});

test('catalog rejects escaping paths, oversize archives and inconsistent geographic indexes', () => {
  const { catalog } = fixture();
  assert.equal(validateCatalog(catalog), catalog);
  for (const change of [
    value => { value.overview.url = '/basemaps/../../secret'; },
    value => { value.overview.blockBase = '/basemap-blocks/../../secret/'; },
    value => { value.overview.blockBytes = BLOCK_BYTES / 2; },
    value => { value.overview.bytes = MAX_ARCHIVE_BYTES + 1; },
    value => { value.overview.bytes = 0; },
    value => { value.overview.sha256 = 'g'.repeat(64); },
    value => { value.overview.bounds = [154, 20, 122, 46]; },
    value => { value.regions[0].minzoom = 8; },
    value => { value.regions[0].regionKey = '8/256/94'; },
    value => { value.regions[0].bounds[0] += 0.1; },
    value => { value.regions.push(value.regions[0]); },
  ]) {
    const invalid = structuredClone(catalog);
    change(invalid);
    assert.throws(() => validateCatalog(invalid));
  }
});

test('committed catalog covers every source grid cell without overlapping parent and child regions', async () => {
  const catalog = validateCatalog(JSON.parse(await readFile(new URL('../basemaps/catalog.json', import.meta.url), 'utf8')));
  const leaves = new Set(catalog.regions.map(entry => entry.regionKey));
  const visited = new Set();
  function visit(z, x, y) {
    const key = `${z}/${x}/${y}`;
    if (leaves.has(key)) { visited.add(key); return; }
    assert.ok(z < 14, `Missing region ${key}`);
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) visit(z + 1, x * 2 + dx, y * 2 + dy);
  }
  for (const region of gridForBounds(catalog.overview.bounds)) visit(region.z, region.x, region.y);
  assert.deepEqual(visited, leaves);
});

test('normal build verifies local cache and creates deployable assets without a network request', async t => {
  const { cacheDir, outputDir } = await workspace(t);
  const { catalog, bodies } = fixture();
  await mkdir(cacheDir);
  for (const entry of [catalog.overview, ...catalog.regions]) await writeFile(join(cacheDir, `${entry.sha256}.pmtiles`), bodies.get(entry.url));
  await ensureBasemaps(outputDir, { catalog, cacheDir, fetchImpl() { throw new Error('Unexpected network request'); } });
  assert.deepEqual(JSON.parse(await readFile(join(outputDir, 'basemaps/catalog.json'), 'utf8')), catalog);
  for (const entry of [catalog.overview, ...catalog.regions]) {
    assert.deepEqual(await readFile(join(outputDir, 'basemaps', `${entry.sha256}.pmtiles`)), bodies.get(entry.url));
    assert.deepEqual(await readFile(join(outputDir, 'basemap-blocks', entry.sha256, '0.bin')), bodies.get(entry.url));
  }
});

test('online blocks have fixed byte offsets and reconstruct complete archives without an empty trailing block', async t => {
  for (const length of [BLOCK_BYTES * 2, BLOCK_BYTES * 2 + 37]) {
    const { cacheDir, outputDir } = await workspace(t);
    const body = Buffer.alloc(length);
    for (let index = 0; index < body.length; index++) body[index] = (index * 31 + Math.floor(index / 251)) % 256;
    const { catalog, bodies } = fixture(body);
    await mkdir(cacheDir);
    for (const entry of [catalog.overview, ...catalog.regions]) await writeFile(join(cacheDir, `${entry.sha256}.pmtiles`), bodies.get(entry.url));
    await ensureBasemaps(outputDir, { catalog, cacheDir, fetchImpl() { throw new Error('Unexpected network request'); } });
    const directory = join(outputDir, 'basemap-blocks', catalog.overview.sha256);
    const count = Math.ceil(length / BLOCK_BYTES);
    assert.deepEqual((await readdir(directory)).sort(), Array.from({ length: count }, (_, index) => `${index}.bin`));
    const blocks = [];
    for (let index = 0; index < count; index++) {
      const block = await readFile(join(directory, `${index}.bin`));
      assert.equal(block.length, Math.min(BLOCK_BYTES, length - index * BLOCK_BYTES));
      assert.deepEqual(block, body.subarray(index * BLOCK_BYTES, (index + 1) * BLOCK_BYTES));
      blocks.push(block);
    }
    assert.deepEqual(Buffer.concat(blocks), body);
    assert.equal(createHash('sha256').update(Buffer.concat(blocks)).digest('hex'), catalog.overview.sha256);
  }
});

test('missing and same-size corrupted cache files are replaced from the published host', async t => {
  const { cacheDir, outputDir } = await workspace(t);
  const { catalog, bodies } = fixture();
  await mkdir(cacheDir);
  await writeFile(join(cacheDir, `${catalog.overview.sha256}.pmtiles`), Buffer.alloc(catalog.overview.bytes, 120));
  const requested = [];
  await ensureBasemaps(outputDir, { catalog, cacheDir, baseURL: 'https://published.example', fetchImpl: async url => {
    requested.push(url.href);
    return new Response(bodies.get(url.pathname));
  } });
  assert.deepEqual(requested.sort(), [...bodies.keys()].map(path => `https://published.example${path}`).sort());
  for (const entry of [catalog.overview, ...catalog.regions]) {
    assert.deepEqual(await readFile(join(cacheDir, `${entry.sha256}.pmtiles`)), bodies.get(entry.url));
  }
});

test('failed downloads cannot enter the verified cache or publish a catalog', async t => {
  for (const kind of ['checksum', 'truncated', 'oversize', 'http-error']) {
    const { cacheDir, outputDir } = await workspace(t);
    const { catalog } = fixture();
    await assert.rejects(ensureBasemaps(outputDir, { catalog, cacheDir, concurrency: 1, fetchImpl: async () => {
      if (kind === 'http-error') return new Response('Unavailable', { status: 503 });
      const length = catalog.overview.bytes + (kind === 'truncated' ? -1 : kind === 'oversize' ? 1 : 0);
      return new Response(Buffer.alloc(length, 120));
    } }), /checksum|size|HTTP 503/);
    assert.deepEqual(await readdir(cacheDir), [], kind);
    await assert.rejects(readFile(join(outputDir, 'basemaps/catalog.json')), { code: 'ENOENT' });
    assert.deepEqual(await readdir(join(outputDir, 'basemaps')), [], kind);
  }
});

test('explicit preparation skips the CLI when the committed catalog is fully cached and verified', async t => {
  const { root, cacheDir } = await workspace(t);
  const { catalog, bodies } = fixture();
  const catalogPath = join(root, 'catalog.json');
  await mkdir(cacheDir);
  await writeFile(catalogPath, JSON.stringify(catalog));
  for (const entry of [catalog.overview, ...catalog.regions]) await writeFile(join(cacheDir, `${entry.sha256}.pmtiles`), bodies.get(entry.url));
  const result = await prepareBasemaps({ source: catalog.source, cacheDir, catalogPath, pmtilesPath: '/nonexistent/pmtiles', log() {} });
  assert.deepEqual(result, catalog);
});
