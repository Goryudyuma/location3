import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { PMTiles, zxyToTileId } from 'pmtiles';
import { createArchiveBlockReader, createBasemapProtocol, createBasemapStyle, tileArchives } from '../web/static/basemap.mjs';

const ORIGIN = 'https://maps.example';
const absolute = path => new URL(path, ORIGIN).href;
const overview = { url: '/basemaps/overview.pmtiles', maxzoom: 8, bytes: 6, blockBytes: 4, blockBase: '/basemap-blocks/overview/' };
const regions = [
  { url: '/basemaps/west.pmtiles', regionKey: '8/226/102' },
  { url: '/basemaps/east-a.pmtiles', regionKey: '9/454/204' },
  { url: '/basemaps/east-b.pmtiles', regionKey: '10/910/408' },
  { url: '/basemaps/east-c.pmtiles', regionKey: '10/911/408' },
  { url: '/basemaps/south.pmtiles', regionKey: '9/454/205' },
].map((entry, index) => ({ ...entry, bytes: 6, blockBytes: 4, blockBase: `/basemap-blocks/region-${index}/` }));
const catalog = { overview, regions };
const request = (z = 9, x = 455, y = 204) => ({ url: `basemap://${z}/${x}/${y}` });
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function harness(options = {}) {
  const calls = { headers: [], network: [], archives: [], unavailable: [], catalog: 0, packs: 0 };
  const state = { packs: [], online: true, savedOnly: false, blobs: new Map() };
  class Reader {
    constructor(source) { this.source = source; calls.headers.push(source.getKey()); }
    async getZxy(z, x, y, signal) { return this.source.getBytes(3, 2, signal, 'archive-etag'); }
  }
  const protocol = createBasemapProtocol({
    catalogLoader: async () => { calls.catalog++; return catalog; },
    packLoader: async () => { calls.packs++; return state.packs; },
    archiveLoader: async url => { calls.archives.push(url); return state.blobs.get(url); },
    pmtiles: () => ({ PMTiles: Reader }),
    fetchFn: async (url, options) => {
      calls.network.push({ url, options });
      return new Response(new Uint8Array(url.endsWith('/0.bin') ? [0, 0, 0, 7] : [8, 0]));
    },
    origin: () => ORIGIN,
    online: () => state.online,
    savedOnly: () => state.savedOnly,
    onUnavailable: error => calls.unavailable.push(error),
    ...options,
  });
  const tile = (value = request(), controller = new AbortController()) => protocol.tile(value, controller);
  return { calls, state, protocol, tile };
}

function blockHarness({ bytes = 11, blockBytes = 4, maxCacheBytes, ...overrides } = {}) {
  const calls = [];
  const entry = { bytes, blockBytes, blockBase: '/basemap-blocks/example/' };
  const content = Uint8Array.from({ length: bytes }, (_, i) => i % 256);
  const reader = createArchiveBlockReader({
    origin: () => ORIGIN,
    maxCacheBytes,
    fetchFn: async (url, options) => {
      calls.push({ url, options });
      const index = Number(/\/(\d+)\.bin$/.exec(url)[1]);
      return new Response(content.slice(index * blockBytes, (index + 1) * blockBytes));
    },
    ...overrides,
  });
  return { reader, calls, entry, content };
}

test('static block ranges preserve exact bytes across boundaries and clamp the final header read', async () => {
  const { reader, calls, entry, content } = blockHarness();
  assert.deepEqual(new Uint8Array((await reader.getBytes(entry, 3, 6)).data), content.slice(3, 9));
  assert.deepEqual(calls.map(call => call.url), [0, 1, 2].map(index => absolute(`${entry.blockBase}${index}.bin`)));
  assert.deepEqual(new Uint8Array((await reader.getBytes(entry, 1, 2)).data), content.slice(1, 3));
  assert.deepEqual(new Uint8Array((await reader.getBytes(entry, 10, 100)).data), content.slice(10));
  assert.deepEqual(new Uint8Array((await reader.getBytes(entry, 0, 16384)).data), content);
  assert.equal(calls.length, 3, 'all ranges share cached blocks');
  assert.ok(calls.every(call => call.options === undefined), 'no Range or per-consumer signal is sent');
});

test('block reads share in-flight downloads while cancellation only stops the requesting tile', async () => {
  const pending = deferred();
  const begun = deferred();
  let downloads = 0;
  const { reader, entry } = blockHarness({ fetchFn: async () => {
    downloads++;
    begun.resolve();
    return pending.promise;
  } });
  const controller = new AbortController();
  const cancelled = reader.getBytes(entry, 1, 2, controller.signal);
  const rejection = assert.rejects(cancelled, { name: 'AbortError' });
  const retained = reader.getBytes(entry, 2, 2);
  await begun.promise;
  controller.abort();
  await rejection;
  assert.equal(downloads, 1);
  pending.resolve(new Response(new Uint8Array([0, 1, 2, 3])));
  assert.deepEqual(new Uint8Array((await retained).data), new Uint8Array([2, 3]));
  await reader.getBytes(entry, 0, 4);
  assert.equal(downloads, 1);
});

test('the block LRU stays within its memory budget across archives and clear discards cached bytes', async () => {
  const { reader, calls, entry } = blockHarness({ bytes: 12, maxCacheBytes: 8 });
  await reader.getBytes(entry, 0, 1);
  await reader.getBytes(entry, 4, 1);
  await reader.getBytes(entry, 0, 1);
  await reader.getBytes(entry, 8, 1);
  await reader.getBytes(entry, 0, 1);
  await reader.getBytes(entry, 4, 1);
  assert.deepEqual(calls.map(call => call.url.split('/').at(-1)), ['0.bin', '1.bin', '2.bin', '1.bin']);
  await reader.getBytes({ ...entry, blockBase: '/basemap-blocks/another/' }, 8, 1);
  await reader.getBytes(entry, 0, 1);
  assert.equal(calls.length, 6, 'archives share the same bounded cache');
  reader.clear();
  await reader.getBytes(entry, 0, 1);
  assert.equal(calls.length, 7);
});

test('failed and incorrectly sized blocks are removed so a later read can recover', async () => {
  for (const response of [new Response('missing', { status: 404 }), new Response(new Uint8Array(3)), new Response(new Uint8Array(5))]) {
    let count = 0;
    const { reader, entry } = blockHarness({ fetchFn: async () => ++count === 1 ? response : new Response(new Uint8Array([0, 1, 2, 3])) });
    await assert.rejects(reader.getBytes(entry, 0, 2));
    assert.deepEqual(new Uint8Array((await reader.getBytes(entry, 0, 2)).data), new Uint8Array([0, 1]));
    assert.equal(count, 2);
  }
});

test('block readers reject invalid ranges before fetching and derive the immutable path from SHA256', async () => {
  const { reader, calls, entry } = blockHarness();
  for (const [offset, length] of [[-1, 1], [12, 1], [NaN, 1], [0, -1], [0, 0.5]]) {
    await assert.rejects(reader.getBytes(entry, offset, length));
  }
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(reader.getBytes(entry, 0, 1, controller.signal), { name: 'AbortError' });
  assert.equal(calls.length, 0);
  const sha256 = 'a'.repeat(64);
  await reader.getBytes({ ...entry, blockBase: undefined, sha256 }, 0, 1);
  assert.equal(calls[0].url, absolute(`/basemap-blocks/${sha256}/0.bin`));
});

test('tile archive routing preserves split region coverage on both sides of zoom 9 boundaries', () => {
  assert.deepEqual(tileArchives(catalog, 0, 0, 0), [overview]);
  assert.deepEqual(tileArchives(catalog, 8, 227, 102), [overview]);
  assert.deepEqual(tileArchives(catalog, 9, 452, 204), [regions[0]]);
  assert.deepEqual(tileArchives(catalog, 9, 453, 205), [regions[0]]);
  assert.deepEqual(tileArchives(catalog, 9, 454, 204), [regions[1]]);
  assert.deepEqual(tileArchives(catalog, 9, 455, 204), [regions[2], regions[3]]);
  assert.deepEqual(tileArchives(catalog, 10, 910, 408), [regions[2]]);
  assert.deepEqual(tileArchives(catalog, 10, 911, 408), [regions[3]]);
  assert.deepEqual(tileArchives(catalog, 14, 14575, 6543), [regions[2]]);
  assert.deepEqual(tileArchives(catalog, 14, 14576, 6543), [regions[3]]);
  assert.deepEqual(tileArchives(catalog, 9, 454, 205), [regions[4]]);
  assert.deepEqual(tileArchives(catalog, 9, 455, 205), []);
});

test('saved split archives take priority and relative and absolute URLs identify the same file', async () => {
  for (const url of [regions[3].url, absolute(regions[3].url)]) {
    const { calls, state, tile } = harness();
    state.packs = [{ archives: [{ url }] }];
    state.blobs.set(absolute(regions[3].url), new Blob([new Uint8Array([0, 0, 0, 21, 22, 0])]));
    assert.deepEqual(new Uint8Array((await tile()).data), new Uint8Array([21, 22]));
    assert.deepEqual(calls.headers, [absolute(regions[3].url)]);
    assert.equal(calls.network.length, 0);
  }
});

test('saved packs retain their pinned overview and regional map after a catalog deployment', async () => {
  const { calls, state, tile } = harness();
  const oldCatalog = {
    overview: { ...overview, url: '/basemaps/old-overview.pmtiles' },
    regions: [{ url: '/basemaps/old-region.pmtiles', regionKey: '8/227/102' }],
  };
  state.packs = [{ archives: [oldCatalog.overview, ...oldCatalog.regions], catalog: oldCatalog }];
  state.online = false;
  for (const entry of state.packs[0].archives) state.blobs.set(absolute(entry.url), new Blob([new Uint8Array([0, 0, 0, 4, 5])]));
  await tile(request(8, 227, 102));
  await tile();
  assert.deepEqual(calls.headers, [absolute(oldCatalog.overview.url), absolute(oldCatalog.regions[0].url)]);
  assert.equal(calls.network.length, 0);
});

test('online tiles use static blocks instead of relying on HTTP Range support', async () => {
  const { calls, tile } = harness();
  const controller = new AbortController();
  const result = await tile(request(), controller);
  assert.ok(result.data instanceof ArrayBuffer);
  assert.deepEqual(new Uint8Array(result.data), new Uint8Array([7, 8]));
  assert.deepEqual(calls.network, [
    { url: absolute(`${regions[2].blockBase}0.bin`), options: undefined },
    { url: absolute(`${regions[2].blockBase}1.bin`), options: undefined },
  ]);
});

test('uncovered and unsaved offline tiles return empty data without fetching archives', async () => {
  for (const mode of ['uncovered', 'offline', 'savedOnly']) {
    const { calls, state, tile } = harness();
    if (mode === 'offline') state.online = false;
    if (mode === 'savedOnly') state.savedOnly = true;
    const result = await tile(mode === 'uncovered' ? request(9, 455, 205) : request());
    assert.equal(result.data.byteLength, 0);
    assert.equal(calls.headers.length, 0);
    assert.equal(calls.network.length, 0);
  }
});

test('catalog and pack reads are shared between concurrent tiles and refreshed after save or removal', async () => {
  const { calls, state, tile, protocol } = harness();
  await Promise.all([tile(), tile(), tile()]);
  assert.equal(calls.catalog, 1);
  assert.equal(calls.packs, 1);
  assert.equal(calls.headers.length, 1);
  state.packs = [{ archives: [regions[3]] }];
  state.blobs.set(absolute(regions[3].url), new Blob([new Uint8Array([0, 0, 0, 1, 2])]));
  protocol.invalidate();
  await tile();
  assert.equal(calls.catalog, 2);
  assert.equal(calls.packs, 2);
  assert.equal(calls.headers.at(-1), absolute(regions[3].url));
  state.packs = [];
  state.blobs.clear();
  protocol.invalidate();
  await tile();
  assert.equal(calls.headers.at(-1), absolute(regions[2].url));
});

test('unavailable browser storage does not break the online map and failed pack reads can recover', async () => {
  let reads = 0;
  const { calls, tile } = harness({
    packLoader: async () => {
      if (++reads === 1) throw new Error('CacheStorage unavailable');
      return [{ archives: [regions[3]] }];
    },
    archiveLoader: async () => { throw new Error('CacheStorage unavailable'); },
  });
  await tile();
  await tile();
  assert.deepEqual(calls.headers, [absolute(regions[2].url), absolute(regions[3].url)]);
  assert.equal(calls.network.length, 4);
  assert.equal(calls.unavailable.length, 0);
});

test('failed catalog loads are retried rather than permanently cached', async () => {
  let loads = 0;
  const { tile } = harness({ catalogLoader: async () => {
    if (++loads === 1) throw new Error('Temporary network failure');
    return catalog;
  } });
  await assert.rejects(tile(), /Temporary network failure/);
  await tile();
  assert.equal(loads, 2);
});

test('aborted catalog or storage reads cannot start a tile network request', async () => {
  for (const stage of ['catalog', 'packs', 'archive']) {
    const pending = deferred();
    const controller = new AbortController();
    const begun = deferred();
    const wait = async () => { begun.resolve(); return pending.promise; };
    const options = stage === 'catalog' ? { catalogLoader: wait }
      : stage === 'packs' ? { packLoader: wait } : { archiveLoader: wait };
    const { calls, tile } = harness(options);
    const result = tile(request(), controller);
    const rejection = assert.rejects(result, { name: 'AbortError' });
    await begun.promise;
    controller.abort();
    pending.resolve(stage === 'catalog' ? catalog : stage === 'packs' ? [] : null);
    await rejection;
    assert.equal(calls.network.length, 0);
    assert.equal(calls.unavailable.length, 0);
  }
});

test('aborted saved blob reads never deliver stale tile bytes', async () => {
  const pending = deferred();
  const begun = deferred();
  const controller = new AbortController();
  const { calls, tile } = harness({ archiveLoader: async () => ({ slice: () => ({
    arrayBuffer: () => { begun.resolve(); return pending.promise; },
  }) }) });
  const result = tile(request(), controller);
  const rejection = assert.rejects(result, { name: 'AbortError' });
  await begun.promise;
  controller.abort();
  pending.resolve(new ArrayBuffer(2));
  await rejection;
  assert.equal(calls.network.length, 0);
  assert.equal(calls.unavailable.length, 0);
});

test('invalid tile coordinates and an already aborted request avoid all storage and network work', async () => {
  const { calls, tile } = harness();
  for (const url of ['basemap://9/-1/1', 'basemap://9/512/1', 'basemap://9/1/512', 'basemap://27/1/1', 'https://example.com']) {
    await assert.rejects(tile({ url }), /Invalid map tile/);
  }
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(tile(request(), controller), { name: 'AbortError' });
  assert.equal(calls.catalog, 0);
  assert.equal(calls.packs, 0);
});

function singleTileArchive(z, x, y, bytes) {
  const variable = value => {
    const result = [];
    do {
      const digit = value % 128;
      value = Math.floor(value / 128);
      result.push(digit + (value ? 128 : 0));
    } while (value);
    return result;
  };
  const directory = new Uint8Array([1, ...variable(zxyToTileId(z, x, y)), 1, ...variable(bytes.length), 1]);
  const header = new ArrayBuffer(127);
  new Uint8Array(header).set(new TextEncoder().encode('PMTiles'));
  const view = new DataView(header);
  view.setUint8(7, 3);
  for (const [offset, value] of [[8, 127], [16, directory.length], [56, 127 + directory.length], [64, bytes.length], [72, 1], [80, 1], [88, 1]]) {
    view.setBigUint64(offset, BigInt(value), true);
  }
  for (const offset of [96, 97, 98, 99]) view.setUint8(offset, 1);
  view.setUint8(100, z);
  view.setUint8(101, z);
  return new Blob([header, directory, bytes]);
}

test('real PMTiles reads headers, directories and tiles entirely from a saved Blob', async () => {
  const bytes = new Uint8Array([26, 0]);
  const blob = singleTileArchive(9, 455, 204, bytes);
  let ranges = 0;
  const protocol = createBasemapProtocol({
    catalogLoader: async () => catalog,
    packLoader: async () => [{ archives: [regions[3]] }],
    archiveLoader: async url => { assert.equal(url, absolute(regions[3].url)); ranges++; return blob; },
    pmtiles: () => ({ PMTiles, FetchSource: class {
      getBytes() { throw new Error('The saved tile must not make network requests'); }
    } }),
    origin: () => ORIGIN,
    online: () => false,
    savedOnly: () => true,
    onUnavailable: error => { throw error; },
  });
  const result = await protocol.tile(request(), new AbortController());
  assert.ok(result.data instanceof ArrayBuffer);
  assert.deepEqual(new Uint8Array(result.data), bytes);
  assert.ok(ranges >= 2, 'reads the archive header and then the actual tile');
  const empty = await protocol.tile(request(9, 454, 204), new AbortController());
  assert.equal(empty.data.byteLength, 0);
  const missing = await protocol.tile(request(10, 911, 408), new AbortController());
  assert.equal(missing.data.byteLength, 0);
});

test('real PMTiles reconstructs header, directory and tile from regular 200 static block responses', async () => {
  const bytes = Uint8Array.from({ length: 190 }, (_, index) => index);
  const blob = singleTileArchive(9, 455, 204, bytes);
  const entry = { ...regions[3], bytes: blob.size, blockBytes: 64 };
  const fetched = [];
  const protocol = createBasemapProtocol({
    catalogLoader: async () => ({ overview, regions: [entry] }),
    packLoader: async () => [],
    archiveLoader: async () => null,
    pmtiles: () => ({ PMTiles }),
    origin: () => ORIGIN,
    online: () => true,
    savedOnly: () => false,
    fetchFn: async (url, options) => {
      assert.equal(options, undefined);
      assert.ok(url.startsWith(absolute(entry.blockBase)));
      fetched.push(url);
      const index = Number(/\/(\d+)\.bin$/.exec(url)[1]);
      return new Response(blob.slice(index * 64, (index + 1) * 64));
    },
    onUnavailable: error => { throw error; },
  });
  const result = await protocol.tile(request(), new AbortController());
  assert.deepEqual(new Uint8Array(result.data), bytes);
  assert.equal(fetched.length, Math.ceil(blob.size / 64));
  await protocol.tile(request(), new AbortController());
  assert.equal(fetched.length, Math.ceil(blob.size / 64), 'repeat tile reads reuse downloaded blocks');
});

test('the background style can label streets and places without external fonts or sprites', () => {
  const style = createBasemapStyle();
  const { validateStyleMin } = createRequire(import.meta.resolve('maplibre-gl'))('@maplibre/maplibre-gl-style-spec');
  assert.deepEqual(validateStyleMin(style).map(error => error.message), []);
  assert.equal(style.version, 8);
  assert.equal(style.glyphs, undefined);
  assert.equal(style.sprite, undefined);
  assert.deepEqual(style.sources.basemap.tiles, ['basemap://{z}/{x}/{y}']);
  assert.ok(style.layers.some(layer => layer['source-layer'] === 'roads' && layer.type === 'symbol'));
  assert.ok(style.layers.some(layer => layer['source-layer'] === 'places' && layer.type === 'symbol'));
});
