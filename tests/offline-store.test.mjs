import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import test from 'node:test';
import { createDatasetLoader } from '../web/static/data.mjs';
import { createOfflineStore, FILE_CACHE, PACK_CACHE, MAX_PACK_BYTES } from '../web/static/offline-store.mjs';

const origin = 'https://railway.test';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const collection = (...features) => ({ type: 'FeatureCollection', features });
const feature = (id, line, start, end) => ({ type: 'Feature', id, properties: { N05_002: line, N05_005b: start, N05_005e: end }, geometry: null });

class MemoryCache {
  entries = new Map();
  failPut;
  key(value) { return typeof value === 'string' ? value : value.url; }
  async put(key, response) {
    if (this.failPut) throw this.failPut;
    this.entries.set(this.key(key), response.clone());
  }
  async match(key) { return this.entries.get(this.key(key))?.clone(); }
  async delete(key) { return this.entries.delete(this.key(key)); }
  async keys() { return [...this.entries.keys()].map(key => new Request(key)); }
}

class MemoryCacheStorage {
  entries = new Map();
  async open(name) {
    if (!this.entries.has(name)) this.entries.set(name, new MemoryCache());
    return this.entries.get(name);
  }
}

function fixture() {
  const cacheStorage = new MemoryCacheStorage();
  const bodies = new Map();
  const descriptor = (path, body, extra = {}) => {
    const bytes = Buffer.from(body);
    bodies.set(`${origin}${path}`, bytes);
    return { url: path, bytes: bytes.byteLength, sha256: sha256(bytes), ...extra };
  };
  const catalog = {
    version: 1,
    overview: descriptor('/basemaps/overview.pmtiles', 'global map', { maxzoom: 7 }),
    regions: [
      descriptor('/basemaps/west.pmtiles', 'western detailed map', { id: 'west', bounds: [125, 25, 135, 40] }),
      descriptor('/basemaps/east.pmtiles', 'eastern detailed map', { id: 'east', bounds: [135, 25, 145, 40] }),
    ],
  };
  const full = {
    railroads: collection(feature('old-line', '旧線', 1950, 1970), feature('new-line', '新線', 1971, 9999)),
    stations: collection(feature('old-station', '旧線', 1950, 1970), feature('new-station', '新線', 1971, 9999)),
  };
  const manifest = { version: 1, all: {}, periods: [] };
  for (const [kind, data] of Object.entries(full)) {
    const body = JSON.stringify(data);
    const path = `/datasets/${sha256(body)}.geojson`;
    const entry = descriptor(path, body);
    manifest.all[kind] = { path, bytes: entry.bytes, count: data.features.length };
  }
  const requests = [];
  const controls = { offline: false, intercept: null };
  const fetchFn = async (url, options) => {
    requests.push(url);
    if (controls.offline) throw new TypeError('offline');
    if (controls.intercept) {
      const result = await controls.intercept(url, options);
      if (result) return result;
    }
    if (url.endsWith('/basemaps/catalog.json')) return Response.json(catalog);
    if (url.endsWith('/datasets/manifest.json')) return Response.json(manifest);
    const body = bodies.get(url);
    if (!body) return new Response('missing', { status: 404 });
    // This intentionally differs from the decoded body size, as with compressed transfers.
    return new Response(body, { headers: { 'Content-Type': url.endsWith('.geojson') ? 'application/geo+json' : 'application/octet-stream', 'Content-Length': '1', 'Content-Encoding': 'gzip' } });
  };
  let persisted = 0;
  const storage = { async persist() { persisted++; return true; }, async estimate() { return { quota: 1024 ** 3, usage: 0 }; } };
  const options = { cacheStorage, fetchFn, origin, storage, crypto: webcrypto, locks: null };
  return { store: createOfflineStore(options), options, cacheStorage, catalog, manifest, full, bodies, controls, requests, persisted: () => persisted };
}

const west = [130, 30, 132, 32];
const east = [138, 30, 140, 32];

test('catalog and dataset indexes share pending requests and failed loads can be retried', async () => {
  const f = fixture();
  f.controls.offline = true;
  await assert.rejects(f.store.getCatalog());
  f.controls.offline = false;
  const [catalog, duplicate] = await Promise.all([f.store.getCatalog(), f.store.getCatalog()]);
  assert.equal(catalog, duplicate);
  assert.equal(f.requests.filter(url => url.endsWith('/catalog.json')).length, 2);
  const [manifest, same] = await Promise.all([f.store.getDatasetManifest(), f.store.getDatasetManifest()]);
  assert.equal(manifest, same);
  assert.equal(f.requests.filter(url => url.endsWith('/manifest.json')).length, 1);
});

test('region plans include overview, intersecting archives and full railways with exact byte totals', async () => {
  const { store, manifest } = fixture();
  const plan = await store.planRegion(west);
  assert.deepEqual(plan.archives.map(item => new URL(item.url).pathname), ['/basemaps/overview.pmtiles', '/basemaps/west.pmtiles']);
  assert.equal(plan.resources.length, 4);
  assert.equal(plan.bytes, plan.resources.reduce((sum, item) => sum + item.bytes, 0));
  assert.equal(plan.downloadBytes, plan.bytes);
  assert.equal(plan.datasets.railroads.bytes, manifest.all.railroads.bytes);
  assert.ok(plan.resources.every(item => item.url.startsWith(origin)));
  assert.equal((await store.planRegion([[130, 30], [132, 32]])).id, plan.id);
});

test('regionKey bounds work when the catalog omits a geographic bounding box', async () => {
  const { store, catalog } = fixture();
  catalog.regions[0].regionKey = '1/1/0'; // eastern and northern hemisphere
  delete catalog.regions[0].bounds;
  assert.equal((await store.planRegion(west)).archives.some(item => item.id === 'west'), true);
  assert.equal((await store.planRegion([-130, 30, -128, 32])).archives.some(item => item.id === 'west'), false);
});

test('plans reject invalid bounds, external resources and excessive saved regions', async () => {
  const { store, catalog } = fixture();
  await assert.rejects(store.planRegion([130, 40, 132, 30]), /範囲/);
  catalog.overview.url = 'https://other.test/world.pmtiles';
  await assert.rejects(store.planRegion(west), /一覧/);
  catalog.overview.url = '/basemaps/overview.pmtiles';
  catalog.overview.bytes = MAX_PACK_BYTES;
  await assert.rejects(store.planRegion(west), /200MB/);
});

test('completed packs survive a fresh offline store and serve all years without a network request', async () => {
  const f = fixture();
  const plan = await f.store.planRegion(west);
  const progress = [];
  const pack = await f.store.downloadPack(plan, { name: '西日本', onProgress: value => progress.push(value) });
  assert.equal(pack.status, 'ready');
  assert.equal(pack.name, '西日本');
  assert.equal(progress.at(-1).loadedBytes, plan.bytes);
  assert.equal(progress.at(-1).completed, plan.resources.length);
  assert.equal(f.persisted(), 1);
  const savedFile = await (await f.cacheStorage.open(FILE_CACHE)).match(plan.resources[0].url);
  assert.equal(savedFile.headers.get('Content-Encoding'), null);
  assert.equal((await savedFile.blob()).size, plan.resources[0].bytes);
  f.controls.offline = true;
  const reopened = createOfflineStore(f.options);
  assert.deepEqual(await reopened.getCatalog(), f.catalog);
  assert.deepEqual(await reopened.getDatasetManifest(), f.manifest);
  assert.equal(await reopened.hasOfflineRailways(), true);
  const before = f.requests.length;
  const old = await reopened.loadOfflineRailways(1966);
  const current = await reopened.loadOfflineRailways(2024);
  assert.deepEqual(old.stations.features.map(value => value.id), ['old-station']);
  assert.deepEqual(current.stations.features.map(value => value.id), ['new-station']);
  assert.equal((await reopened.loadOfflineRailways(1966)).stations.features[0], old.stations.features[0], 'full data should be parsed once');
  assert.equal(f.requests.length, before);
  const blob = await reopened.getCachedArchive('/basemaps/west.pmtiles');
  assert.equal(await blob.text(), 'western detailed map');
  assert.equal(await reopened.getCachedArchive('/basemaps/west.pmtiles'), blob);
});

test('committed packs provide pinned manifests even when the current index snapshots are gone', async () => {
  const f = fixture();
  await f.store.downloadPack(await f.store.planRegion(west));
  const metadata = await f.cacheStorage.open(PACK_CACHE);
  await metadata.delete(`${origin}/__offline__/catalog`);
  await metadata.delete(`${origin}/__offline__/manifest`);
  f.controls.offline = true;
  const reopened = createOfflineStore(f.options);
  assert.deepEqual(await reopened.getCatalog(), f.catalog);
  assert.deepEqual(await reopened.getDatasetManifest(), f.manifest);
});

test('deleting a region retains files shared with other ready regions and invalidates memoized blobs', async () => {
  const f = fixture();
  const first = await f.store.planRegion(west);
  await f.store.downloadPack(first);
  const second = await f.store.planRegion(east);
  assert.equal(second.downloadBytes, f.catalog.regions[1].bytes);
  await f.store.downloadPack(second);
  assert.ok(await f.store.getCachedArchive('/basemaps/west.pmtiles'));
  await f.store.removePack(first.id);
  assert.equal(await f.store.getCachedArchive('/basemaps/west.pmtiles'), null);
  assert.ok(await f.store.getCachedArchive('/basemaps/overview.pmtiles'));
  assert.equal(await f.store.hasOfflineRailways(), true);
  assert.equal((await f.store.listPacks()).length, 1);
  await f.store.removePack(second.id);
  assert.equal(await f.store.hasOfflineRailways(), false);
  assert.equal((await (await f.cacheStorage.open(FILE_CACHE)).keys()).length, 0);
});

test('failed checksum or byte validation rolls back only the new files', async () => {
  for (const failure of ['checksum', 'size']) {
    const f = fixture();
    const first = await f.store.planRegion(west);
    await f.store.downloadPack(first);
    const plan = await f.store.planRegion(east);
    const original = f.bodies.get(`${origin}/basemaps/east.pmtiles`);
    f.bodies.set(`${origin}/basemaps/east.pmtiles`, failure === 'checksum' ? Buffer.alloc(original.length, 65) : Buffer.from('truncated'));
    await assert.rejects(f.store.downloadPack(plan), /検証|容量/);
    assert.equal((await f.store.listPacks()).length, 1);
    assert.ok(await f.store.getCachedArchive('/basemaps/west.pmtiles'));
    assert.equal(await f.store.hasOfflineRailways(), true);
    assert.equal(await (await f.cacheStorage.open(FILE_CACHE)).match(`${origin}/basemaps/east.pmtiles`), undefined);
  }
});

test('canceling a partially written pack removes its new files and commits no metadata', async () => {
  const f = fixture();
  const plan = await f.store.planRegion(west);
  const controller = new AbortController();
  await assert.rejects(f.store.downloadPack(plan, {
    signal: controller.signal,
    onProgress(progress) { if (progress.completed === 1) controller.abort(); },
  }), { name: 'AbortError' });
  assert.deepEqual(await f.store.listPacks(), []);
  assert.equal((await (await f.cacheStorage.open(FILE_CACHE)).keys()).length, 0);
});

test('metadata quota failure rolls back downloaded files rather than exposing a partial ready pack', async () => {
  const f = fixture();
  const plan = await f.store.planRegion(west);
  (await f.cacheStorage.open(PACK_CACHE)).failPut = new DOMException('full', 'QuotaExceededError');
  await assert.rejects(f.store.downloadPack(plan), /空き容量/);
  assert.deepEqual(await f.store.listPacks(), []);
  assert.equal((await (await f.cacheStorage.open(FILE_CACHE)).keys()).length, 0);
});

test('simultaneous mutations are rejected and an aborted blocked fetch releases the lock', async () => {
  const f = fixture();
  const plan = await f.store.planRegion(west);
  let started;
  const fetched = new Promise(resolve => { started = resolve; });
  f.controls.intercept = url => {
    if (url.endsWith('.pmtiles')) { started(); return new Promise(() => {}); }
  };
  const controller = new AbortController();
  const pending = f.store.downloadPack(plan, { signal: controller.signal });
  await fetched;
  await assert.rejects(f.store.removePack(plan.id), /進行中/);
  await assert.rejects(createOfflineStore(f.options).downloadPack(plan), /進行中/);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  f.controls.intercept = null;
  assert.equal((await f.store.downloadPack(plan)).status, 'ready');
});

test('dataset loader prefers a saved full pair and still supports online fallback', async () => {
  const f = fixture();
  await f.store.downloadPack(await f.store.planRegion(west));
  let networkRequests = 0;
  const loader = createDatasetLoader(async () => { networkRequests++; return Response.json(collection()); }, { offlineLoader: f.store.loadOfflineRailways });
  assert.deepEqual((await loader.load(1966)).stations.features.map(value => value.id), ['old-station']);
  assert.deepEqual((await loader.load(2024)).stations.features.map(value => value.id), ['new-station']);
  assert.equal(networkRequests, 0);
  const empty = createDatasetLoader(async () => { networkRequests++; return Response.json(collection()); }, { offlineLoader: async () => null });
  await empty.load(2024);
  assert.equal(networkRequests, 2);
});

test('unsupported browser storage does not prevent the online dataset path', async () => {
  const store = createOfflineStore({ cacheStorage: undefined });
  assert.deepEqual(await store.listPacks(), []);
  assert.equal(await store.getCachedArchive('/basemaps/missing.pmtiles'), null);
  assert.equal(await store.loadOfflineRailways(2024), null);
  let requests = 0;
  const loader = createDatasetLoader(async () => { requests++; return Response.json(collection()); }, {
    offlineLoader: async () => { throw new DOMException('disabled', 'SecurityError'); },
  });
  await loader.load(2024);
  assert.equal(requests, 2);
});
