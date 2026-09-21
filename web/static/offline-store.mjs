import { filterCollections } from './railway-filter.mjs';

export const FILE_CACHE = 'location3-offline-files-v1';
export const PACK_CACHE = 'location3-offline-packs-v1';
export const MAX_PACK_BYTES = 200 * 1024 * 1024;
const MUTATION_LOCK = 'location3-offline-mutation-v1';
const activeStores = new WeakSet();

function abortIfNeeded(signal) {
  signal?.throwIfAborted();
}

function abortable(promise, signal) {
  if (!signal) return promise;
  abortIfNeeded(signal);
  return new Promise((resolve, reject) => {
    const cancel = () => reject(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
  });
}

function regionBounds(key) {
  const match = typeof key === 'string' && /^(\d+)\/(\d+)\/(\d+)$/.exec(key);
  if (!match) throw new Error('背景地図の地域範囲がありません。');
  const [zoom, x, y] = match.slice(1).map(Number);
  const tiles = 2 ** zoom;
  if (zoom > 22 || x >= tiles || y >= tiles) throw new Error('背景地図の地域範囲が正しくありません。');
  const latitude = row => Math.atan(Math.sinh(Math.PI * (1 - 2 * row / tiles))) * 180 / Math.PI;
  return [x / tiles * 360 - 180, latitude(y + 1), (x + 1) / tiles * 360 - 180, latitude(y)];
}

function boundsArray(value) {
  if (typeof value?.getWest === 'function') value = [value.getWest(), value.getSouth(), value.getEast(), value.getNorth()];
  else if (typeof value?.toArray === 'function') value = value.toArray();
  else if (value && !Array.isArray(value)) value = [value.west, value.south, value.east, value.north];
  if (Array.isArray(value?.[0])) value = [...value[0], ...value[1]];
  if (!Array.isArray(value) || value.length !== 4 || !value.every(Number.isFinite)
    || value[1] < -90 || value[3] > 90 || value[1] >= value[3]) {
    throw new Error('保存する地図の範囲が正しくありません。');
  }
  let [west, south, east, north] = value;
  if (Math.abs(east - west) >= 360) return [-180, south, 180, north];
  const wrap = longitude => longitude === 180 ? 180 : ((longitude + 180) % 360 + 360) % 360 - 180;
  west = wrap(west);
  east = wrap(east);
  if (west === east) throw new Error('保存する地図の範囲が正しくありません。');
  return [west, south, east, north];
}

function intersects(a, b) {
  if (a[1] > b[3] || b[1] > a[3]) return false;
  const intervals = bounds => bounds[0] <= bounds[2] ? [[bounds[0], bounds[2]]] : [[bounds[0], 180], [-180, bounds[2]]];
  return intervals(a).some(x => intervals(b).some(y => x[0] <= y[1] && y[0] <= x[1]));
}

function collectionValid(value, count) {
  return value?.type === 'FeatureCollection' && Array.isArray(value.features)
    && (count === undefined || value.features.length === count);
}

function storageError(error) {
  if (error?.name === 'QuotaExceededError') return new Error('端末の空き容量が足りません。保存済みの地域を削除して再試行してください。', { cause: error });
  return error;
}

/** Dependencies are injectable so transactions can be verified without a browser. */
export function createOfflineStore({
  cacheStorage = globalThis.caches,
  fetchFn = (...args) => globalThis.fetch(...args),
  origin = globalThis.location?.origin ?? 'http://localhost',
  storage = globalThis.navigator?.storage,
  crypto = globalThis.crypto,
  locks = globalThis.navigator?.locks,
} = {}) {
  origin = new URL(origin).origin;
  const metadataRoot = `${origin}/__offline__/`;
  const packRoot = `${metadataRoot}packs/`;
  const blobs = new Map();
  let railwayKey;
  let railwayPromise;
  let catalogPromise;
  let manifestPromise;

  function urlFor(value) {
    if (typeof value !== 'string' || !value) throw new Error('保存ファイルのURLが正しくありません。');
    const url = new URL(value, origin);
    if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('このサイト以外のファイルは保存できません。');
    }
    url.hash = '';
    return url.href;
  }

  function resource(value, kind) {
    const url = urlFor(value?.url ?? value?.path);
    if (!Number.isSafeInteger(value.bytes) || value.bytes <= 0) throw new Error('保存ファイルの容量情報がありません。ページを更新してください。');
    const sha256 = value.sha256 ?? new URL(url).pathname.match(/\/([a-f0-9]{64})\.geojson$/)?.[1];
    if (sha256 !== undefined && !/^[a-f0-9]{64}$/i.test(sha256)) throw new Error('保存ファイルの検証情報が正しくありません。');
    return { url, bytes: value.bytes, ...(sha256 ? { sha256: sha256.toLowerCase() } : {}), ...(kind ? { kind } : {}) };
  }

  function archive(value, overview = false) {
    const bounds = value.bounds ?? value.bbox ?? (overview ? [-180, -85, 180, 85] : regionBounds(value.regionKey));
    return { ...value, ...resource(value, 'archive'), bounds: boundsArray(bounds), overview };
  }

  function validateCatalog(value) {
    if (!value || !value.overview || !Array.isArray(value.regions)) throw new Error('背景地図の一覧が正しくありません。');
    archive(value.overview, true);
    value.regions.forEach(item => archive(item));
    return value;
  }

  function validateManifest(value) {
    if (value?.version !== 1 || !value.all) throw new Error('鉄道データの一覧が正しくありません。');
    for (const kind of ['railroads', 'stations']) {
      resource(value.all[kind], kind);
      if (!Number.isSafeInteger(value.all[kind].count) || value.all[kind].count < 0) throw new Error('鉄道データの件数が正しくありません。');
    }
    return value;
  }

  async function getIndex(path, key, validate) {
    try {
      const response = await fetchFn(urlFor(path));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const value = validate(await response.json());
      // An unavailable metadata cache must not prevent online browsing/planning.
      try { if (cacheStorage) await (await cacheStorage.open(PACK_CACHE)).put(`${metadataRoot}${key}`, Response.json(value)); } catch {}
      return value;
    } catch (error) {
      if (cacheStorage) {
        const response = await (await cacheStorage.open(PACK_CACHE)).match(`${metadataRoot}${key}`);
        if (response) return validate(await response.json());
        // A committed pack pins its catalog and full dataset manifest for fresh offline pages.
        for (const pack of await listPacks()) {
          if (pack[key]) return validate(pack[key]);
        }
      }
      throw new Error('保存に必要な一覧を取得できません。通信状況を確認してください。', { cause: error });
    }
  }

  const getCatalog = () => catalogPromise ??= getIndex('/basemaps/catalog.json', 'catalog', validateCatalog).catch(error => {
    catalogPromise = undefined;
    throw error;
  });
  const getDatasetManifest = () => manifestPromise ??= getIndex('/datasets/manifest.json', 'manifest', validateManifest).catch(error => {
    manifestPromise = undefined;
    throw error;
  });

  async function listPacks() {
    if (!cacheStorage) return [];
    const cache = await cacheStorage.open(PACK_CACHE);
    const packs = [];
    for (const key of await cache.keys()) {
      if (!key.url.startsWith(packRoot)) continue;
      try {
        const value = await (await cache.match(key)).json();
        if (value?.status === 'ready' && typeof value.id === 'string' && Array.isArray(value.resources) && value.datasets) packs.push(value);
      } catch {}
    }
    return packs.sort((a, b) => b.createdAt - a.createdAt);
  }

  function verified(response, item) {
    return response?.ok && response.headers.get('X-Offline-Bytes') === String(item.bytes)
      && (!item.sha256 || response.headers.get('X-Offline-SHA256') === item.sha256);
  }

  async function digest(blob) {
    if (!crypto?.subtle) throw new Error('このブラウザでは保存データを検証できません。HTTPSで開いてください。');
    const bytes = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
  }

  async function planRegion(value) {
    const bounds = boundsArray(value);
    const [catalog, manifest] = await Promise.all([getCatalog(), getDatasetManifest()]);
    const archives = [archive(catalog.overview, true), ...catalog.regions.map(item => archive(item)).filter(item => intersects(bounds, item.bounds))];
    const datasets = Object.fromEntries(['railroads', 'stations'].map(kind => [kind, { ...manifest.all[kind], ...resource(manifest.all[kind], kind) }]));
    const resources = [...new Map([...archives.map(item => resource(item, 'archive')), ...Object.values(datasets)].map(item => [item.url, item])).values()];
    const bytes = resources.reduce((sum, item) => sum + item.bytes, 0);
    if (bytes > MAX_PACK_BYTES) throw new Error('保存容量が200MBを超えます。地図を拡大して、より小さな地域を選んでください。');
    let downloadBytes = bytes;
    if (cacheStorage) {
      const files = await cacheStorage.open(FILE_CACHE);
      for (const item of resources) if (verified(await files.match(item.url), item)) downloadBytes -= item.bytes;
    }
    const identity = JSON.stringify({ bounds, resources: resources.map(({ url, bytes, sha256 }) => ({ url, bytes, sha256 })) });
    const id = `region-${(await digest(new Blob([identity]))).slice(0, 20)}`;
    return { id, bounds, archives, resources, bytes, downloadBytes, datasets, catalog, manifest };
  }

  function invalidate() {
    blobs.clear();
    railwayKey = undefined;
    railwayPromise = undefined;
  }

  async function mutate(callback) {
    if (!cacheStorage) throw new Error('このブラウザではオフライン保存を利用できません。HTTPSで開いてください。');
    if (activeStores.has(cacheStorage)) throw new Error('保存または削除が進行中です。完了してからお試しください。');
    activeStores.add(cacheStorage);
    try {
      if (locks?.request) return await locks.request(MUTATION_LOCK, { ifAvailable: true }, lock => {
        if (!lock) throw new Error('別の画面で保存または削除が進行中です。');
        return callback();
      });
      return await callback();
    } catch (error) {
      throw storageError(error);
    } finally {
      activeStores.delete(cacheStorage);
    }
  }

  async function downloadPack(plan, { name, onProgress = () => {}, signal } = {}) {
    return mutate(async () => {
      abortIfNeeded(signal);
      if (!/^[a-z0-9_-]+$/i.test(plan?.id ?? '') || !plan.datasets) throw new Error('保存する地域を選び直してください。');
      const resources = plan.resources.map(item => ({ ...item, ...resource(item, item.kind) }));
      const totalBytes = resources.reduce((sum, item) => sum + item.bytes, 0);
      if (totalBytes > MAX_PACK_BYTES) throw new Error('保存容量が200MBを超えます。より小さな地域を選んでください。');
      for (const kind of ['railroads', 'stations']) {
        const descriptor = resource(plan.datasets[kind], kind);
        if (!resources.some(item => item.url === descriptor.url && item.bytes === descriptor.bytes && item.sha256 === descriptor.sha256)) throw new Error('鉄道データの保存計画が正しくありません。');
      }
      const files = await cacheStorage.open(FILE_CACHE);
      const metadata = await cacheStorage.open(PACK_CACHE);
      const existingPacks = await listPacks();
      const referenced = new Set(existingPacks.flatMap(pack => pack.resources.map(item => item.url)));
      let neededBytes = 0;
      for (const item of resources) if (!verified(await files.match(item.url), item)) neededBytes += item.bytes;
      try { await storage?.persist?.(); } catch {}
      try {
        const estimate = await storage?.estimate?.();
        if (Number.isFinite(estimate?.quota) && Number.isFinite(estimate?.usage) && estimate.quota - estimate.usage < neededBytes) {
          throw new DOMException('Storage quota', 'QuotaExceededError');
        }
      } catch (error) { if (error?.name === 'QuotaExceededError') throw error; }

      const added = [];
      let loadedBytes = 0;
      let downloadedBytes = 0;
      let completed = 0;
      const report = currentUrl => onProgress({ loadedBytes, totalBytes, downloadedBytes, downloadBytes: neededBytes, completed, total: resources.length, currentUrl });
      try {
        report(null);
        for (const item of resources) {
          abortIfNeeded(signal);
          const cached = await files.match(item.url);
          if (verified(cached, item)) {
            loadedBytes += item.bytes;
          } else {
            if (cached && referenced.has(item.url)) throw new Error('保存済みデータの版が異なります。古い地域を削除してから保存してください。');
            const response = await abortable(fetchFn(item.url, { signal }), signal);
            if (!response.ok) throw new Error(`地図を保存できませんでした（HTTP ${response.status}）。`);
            let blob;
            if (response.body?.getReader) {
              const reader = response.body.getReader();
              const chunks = [];
              let size = 0;
              try {
                while (true) {
                  abortIfNeeded(signal);
                  const { done, value } = await abortable(reader.read(), signal);
                  if (done) break;
                  size += value.byteLength;
                  if (size > item.bytes) throw new Error('保存ファイルの容量が一致しません。');
                  chunks.push(value);
                  loadedBytes += value.byteLength;
                  downloadedBytes += value.byteLength;
                  report(item.url);
                }
              } catch (error) {
                void reader.cancel().catch(() => {});
                throw error;
              } finally { reader.releaseLock(); }
              blob = new Blob(chunks, { type: response.headers.get('Content-Type') ?? 'application/octet-stream' });
            } else {
              blob = await response.blob();
              loadedBytes += blob.size;
              downloadedBytes += blob.size;
            }
            abortIfNeeded(signal);
            if (blob.size !== item.bytes) throw new Error('保存ファイルの容量が一致しません。通信状況を確認して再試行してください。');
            if (item.sha256 && await digest(blob) !== item.sha256) throw new Error('保存ファイルの検証に失敗しました。再試行してください。');
            if (item.kind === 'railroads' || item.kind === 'stations') {
              if (!collectionValid(JSON.parse(await blob.text()), plan.datasets[item.kind].count)) throw new Error('保存する鉄道データの形式が正しくありません。');
            }
            abortIfNeeded(signal);
            const headers = { 'Content-Type': blob.type || 'application/octet-stream', 'X-Offline-Bytes': String(blob.size) };
            if (item.sha256) headers['X-Offline-SHA256'] = item.sha256;
            added.push(item.url);
            await files.put(item.url, new Response(blob, { headers }));
          }
          completed++;
          report(item.url);
        }
        abortIfNeeded(signal);
        const pack = { ...plan, resources, bytes: totalBytes, name: typeof name === 'string' && name.trim() ? name.trim().slice(0, 80) : '保存した地域', status: 'ready', createdAt: Date.now() };
        // This metadata write is the commit point. Partial packs are never listed as ready.
        await metadata.put(`${packRoot}${plan.id}`, Response.json(pack));
        invalidate();
        return pack;
      } catch (error) {
        await Promise.allSettled(added.map(url => files.delete(url)));
        invalidate();
        throw error;
      }
    });
  }

  async function removePack(id) {
    return mutate(async () => {
      const packs = await listPacks();
      const selected = packs.find(pack => pack.id === id);
      if (!selected) return false;
      const retained = new Set(packs.filter(pack => pack.id !== id).flatMap(pack => pack.resources.map(item => item.url)));
      await (await cacheStorage.open(PACK_CACHE)).delete(`${packRoot}${id}`);
      const files = await cacheStorage.open(FILE_CACHE);
      await Promise.all(selected.resources.filter(item => !retained.has(item.url)).map(item => files.delete(item.url)));
      invalidate();
      return true;
    });
  }

  async function getCachedArchive(value) {
    if (!cacheStorage) return null;
    const url = urlFor(value);
    if (!blobs.has(url)) {
      const pending = (async () => {
        const packs = await listPacks();
        const entry = packs.flatMap(pack => pack.resources).find(item => item.url === url && item.kind === 'archive');
        if (!entry) return null;
        const response = await (await cacheStorage.open(FILE_CACHE)).match(url);
        if (!verified(response, entry)) return null;
        return response.blob();
      })();
      blobs.set(url, pending);
      pending.then(value => { if (value === null && blobs.get(url) === pending) blobs.delete(url); }, () => { if (blobs.get(url) === pending) blobs.delete(url); });
    }
    return blobs.get(url);
  }

  async function savedRailways() {
    if (!cacheStorage) return null;
    const files = await cacheStorage.open(FILE_CACHE);
    for (const pack of await listPacks()) {
      const entries = ['railroads', 'stations'].map(kind => resource(pack.datasets[kind], kind));
      const responses = await Promise.all(entries.map(item => files.match(item.url)));
      if (responses.every((response, index) => verified(response, entries[index]))) return { pack, entries, responses };
    }
    return null;
  }

  async function hasOfflineRailways() {
    return Boolean(await savedRailways());
  }

  async function loadOfflineRailways(year) {
    const saved = await savedRailways();
    if (!saved) return null;
    const key = saved.entries.map(item => `${item.url}:${item.sha256 ?? ''}`).join('|');
    if (key !== railwayKey) {
      railwayKey = key;
      railwayPromise = Promise.all(saved.responses.map(response => response.json())).then(([railroads, stations]) => {
        if (!collectionValid(railroads, saved.pack.datasets.railroads.count) || !collectionValid(stations, saved.pack.datasets.stations.count)) throw new Error('保存済みの鉄道データを読み込めませんでした。');
        return { railroads, stations };
      }).catch(error => { if (railwayKey === key) { railwayKey = undefined; railwayPromise = undefined; } throw error; });
    }
    return filterCollections(await railwayPromise, year);
  }

  return { getCatalog, getDatasetManifest, planRegion, listPacks, downloadPack, removePack, getCachedArchive, loadOfflineRailways, hasOfflineRailways };
}

let defaultStore;
const store = () => defaultStore ??= createOfflineStore();
export const getCatalog = (...args) => store().getCatalog(...args);
export const getDatasetManifest = (...args) => store().getDatasetManifest(...args);
export const planRegion = (...args) => store().planRegion(...args);
export const listPacks = (...args) => store().listPacks(...args);
export const downloadPack = (...args) => store().downloadPack(...args);
export const removePack = (...args) => store().removePack(...args);
export const getCachedArchive = (...args) => store().getCachedArchive(...args);
export const loadOfflineRailways = (...args) => store().loadOfflineRailways(...args);
export const hasOfflineRailways = (...args) => store().hasOfflineRailways(...args);
