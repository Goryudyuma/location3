import { getCatalog, getCachedArchive, listPacks } from './offline-store.mjs';

let registered = false;
let protocol;

export function savedMapsOnly() {
  try { return localStorage.getItem('location3-saved-only') === 'true'; }
  catch { return false; }
}

export function setSavedMapsOnly(value) {
  try { localStorage.setItem('location3-saved-only', String(value)); } catch { /* Private mode. */ }
}

export function invalidateBasemapCache() {
  protocol?.invalidate();
}

/** Select intersecting regional archives, including a split region's low zoom tiles. */
export function tileArchives(catalog, z, x, y) {
  if (z <= catalog.overview.maxzoom) return [catalog.overview];
  return catalog.regions.filter(region => {
    const [rz, rx, ry] = region.regionKey.split('/').map(Number);
    if (z >= rz) {
      const scale = 2 ** (z - rz);
      return Math.floor(x / scale) === rx && Math.floor(y / scale) === ry;
    }
    const scale = 2 ** (rz - z);
    return Math.floor(rx / scale) === x && Math.floor(ry / scale) === y;
  });
}

function abortable(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

/** Reassemble byte ranges from small static files; the host need not support Range. */
export function createArchiveBlockReader({
  fetchFn = (...args) => fetch(...args),
  origin = () => location.origin,
  maxCacheBytes = 16 * 1024 * 1024,
} = {}) {
  const blocks = new Map();
  let cachedBytes = 0;

  function block(entry, index) {
    const blockBytes = entry.blockBytes ?? 262144;
    const blockBase = entry.blockBase ?? (/^[a-f0-9]{64}$/i.test(entry.sha256 ?? '') ? `/basemap-blocks/${entry.sha256}/` : undefined);
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes <= 0 || !Number.isSafeInteger(blockBytes) || blockBytes <= 0 || !blockBase) {
      throw new Error('背景地図の配信情報が正しくありません');
    }
    const url = new URL(`${blockBase.replace(/\/?$/, '/')}${index}.bin`, origin()).href;
    const existing = blocks.get(url);
    if (existing) {
      blocks.delete(url);
      blocks.set(url, existing);
      return existing.promise;
    }
    const expected = Math.min(blockBytes, entry.bytes - index * blockBytes);
    const item = { bytes: expected };
    // Fetches are shared. Cancelling one tile must not cancel another tile that
    // needs the same block; each consumer aborts its own wait instead.
    item.promise = Promise.resolve().then(async () => {
      const response = await fetchFn(url);
      if (!response.ok) throw new Error(`背景地図を読み込めませんでした (HTTP ${response.status})`);
      const data = await response.arrayBuffer();
      if (data.byteLength !== expected) throw new Error('背景地図のファイル容量が一致しません');
      return data;
    }).catch(error => {
      if (blocks.get(url) === item) {
        blocks.delete(url);
        cachedBytes -= item.bytes;
      }
      throw error;
    });
    blocks.set(url, item);
    cachedBytes += item.bytes;
    while (cachedBytes > maxCacheBytes && blocks.size) {
      const oldest = blocks.keys().next().value;
      cachedBytes -= blocks.get(oldest).bytes;
      blocks.delete(oldest);
    }
    return item.promise;
  }

  return {
    async getBytes(entry, offset, length, signal) {
      signal?.throwIfAborted();
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0
        || !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0 || offset > entry.bytes) {
        throw new Error('背景地図の読込範囲が正しくありません');
      }
      const size = Math.min(length, entry.bytes - offset);
      if (!size) return { data: new ArrayBuffer(0) };
      const blockBytes = entry.blockBytes ?? 262144;
      if (!Number.isSafeInteger(blockBytes) || blockBytes <= 0) throw new Error('背景地図の配信情報が正しくありません');
      const start = Math.floor(offset / blockBytes);
      const end = Math.floor((offset + size - 1) / blockBytes);
      const reads = [];
      for (let index = start; index <= end; index++) reads.push(block(entry, index));
      const buffers = await abortable(Promise.all(reads), signal);
      signal?.throwIfAborted();
      const data = new Uint8Array(size);
      for (let index = start; index <= end; index++) {
        const first = Math.max(offset, index * blockBytes);
        const last = Math.min(offset + size, (index + 1) * blockBytes);
        data.set(new Uint8Array(buffers[index - start], first - index * blockBytes, last - first), first - offset);
      }
      return { data: data.buffer };
    },
    clear() { blocks.clear(); cachedBytes = 0; },
  };
}

/** Keep storage failures separate from online rendering, with isolated caches. */
export function createBasemapProtocol({
  catalogLoader = getCatalog,
  packLoader = listPacks,
  archiveLoader = getCachedArchive,
  pmtiles = () => window.pmtiles,
  origin = () => location.origin,
  online = () => navigator.onLine !== false,
  savedOnly = savedMapsOnly,
  onUnavailable = () => window.dispatchEvent(new CustomEvent('basemap-unavailable')),
  fetchFn = (...args) => fetch(...args),
} = {}) {
  let catalogPromise;
  let savedPromise;
  const archives = new Map();
  const absoluteURL = url => new URL(url, origin()).href;
  const network = createArchiveBlockReader({ fetchFn, origin });

  function loadCatalog() {
    catalogPromise ??= Promise.resolve().then(catalogLoader).catch(error => {
      catalogPromise = undefined;
      throw error;
    });
    return catalogPromise;
  }

  function loadSaved() {
    savedPromise ??= Promise.resolve().then(packLoader)
      .then(packs => ({
        urls: new Set(packs.flatMap(pack => pack.archives.map(a => absoluteURL(a.url)))),
        catalogs: packs.map(pack => pack.catalog).filter(Boolean),
      }))
      .catch(() => {
        // A blocked browser cache must not prevent an online map from loading.
        savedPromise = undefined;
        return { urls: new Set(), catalogs: [] };
      });
    return savedPromise;
  }

  function archiveReader(entry) {
    const url = absoluteURL(entry.url);
    if (!archives.has(url)) {
      const { PMTiles } = pmtiles();
      const source = {
        getKey: () => url,
        async getBytes(offset, length, signal) {
          signal?.throwIfAborted();
          let blob;
          try { blob = await archiveLoader(url); }
          catch (error) {
            if (savedOnly() || !online()) throw error;
          }
          signal?.throwIfAborted();
          if (blob) {
            const data = await blob.slice(offset, offset + length).arrayBuffer();
            signal?.throwIfAborted();
            return { data };
          }
          if (savedOnly() || !online()) throw new Error('保存していない地域です');
          return network.getBytes(entry, offset, length, signal);
        },
      };
      archives.set(url, new PMTiles(source));
      // Keep directory/header caches bounded while travelling around Japan.
      if (archives.size > 32) archives.delete(archives.keys().next().value);
    }
    return archives.get(url);
  }

  async function tile(request, controller) {
    controller.signal.throwIfAborted();
    const match = /^basemap:\/\/(\d+)\/(\d+)\/(\d+)$/.exec(request.url);
    if (!match) throw new Error('Invalid map tile');
    const [z, x, y] = match.slice(1).map(Number);
    if (z > 26 || x >= 2 ** z || y >= 2 ** z) throw new Error('Invalid map tile');
    const [catalog, saved] = await Promise.all([loadCatalog(), loadSaved()]);
    controller.signal.throwIfAborted();
    const candidates = tileArchives(catalog, z, x, y);
    // A new deployment may change the catalog while older packs remain saved.
    // Their pinned catalogs preserve the relationship between tiles and files.
    const previous = saved.catalogs.flatMap(value => tileArchives(value, z, x, y));
    const entry = [...candidates, ...previous].find(a => saved.urls.has(absoluteURL(a.url))) ?? candidates[0];
    if (!entry || ((savedOnly() || !online()) && !saved.urls.has(absoluteURL(entry.url)))) {
      return { data: new ArrayBuffer(0) };
    }
    try {
      const tile = await abortable(archiveReader(entry).getZxy(z, x, y, controller.signal), controller.signal);
      controller.signal.throwIfAborted();
      const data = tile?.data ?? new ArrayBuffer(0);
      return {
        data: ArrayBuffer.isView(data) ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data,
        cacheControl: tile?.cacheControl,
        expires: tile?.expires,
      };
    } catch (error) {
      if (controller.signal.aborted) throw error;
      onUnavailable(error);
      throw error;
    }
  }

  return {
    tile,
    invalidate() {
      catalogPromise = undefined;
      savedPromise = undefined;
      archives.clear();
      network.clear();
    },
  };
}

export function registerBasemapProtocol(maplibregl = window.maplibregl) {
  if (registered) return;
  protocol = createBasemapProtocol();
  maplibregl.addProtocol('basemap', protocol.tile);
  registered = true;
}

/** A quiet contextual map; historical railways are drawn separately above it. */
export function createBasemapStyle() {
  const source = 'basemap';
  const layer = (id, type, sourceLayer, paint, extra = {}) => ({
    id, type, source, 'source-layer': sourceLayer, paint, ...extra,
  });
  const name = ['coalesce', ['get', 'name:ja'], ['get', 'name'], ['get', 'name:en']];
  const fonts = ['Noto Sans CJK JP', 'Hiragino Kaku Gothic ProN', 'Meiryo', 'sans-serif'];
  return {
    version: 8,
    // With no glyphs URL, MapLibre 6 draws labels using installed fonts, offline too.
    sources: { [source]: {
      type: 'vector', tiles: ['basemap://{z}/{x}/{y}'], minzoom: 0, maxzoom: 14,
      bounds: [122, 20, 154, 46],
      attribution: '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap</a> · <a href="https://protomaps.com">Protomaps</a> · Natural Earth',
    } },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#d7e9ec' } },
      layer('land', 'fill', 'earth', { 'fill-color': '#f4f4ec' }),
      layer('landcover', 'fill', 'landcover', {
        'fill-color': ['match', ['get', 'kind'], ['forest', 'scrub', 'grassland'], '#e0e9d8', 'urban_area', '#eeeae2', '#f0efdf'],
        'fill-opacity': 0.7,
      }),
      layer('parks', 'fill', 'landuse', { 'fill-color': '#e0eadb' }, {
        filter: ['in', ['get', 'kind'], ['literal', ['forest', 'wood', 'grass', 'park', 'garden', 'nature_reserve', 'national_park']]],
      }),
      layer('water', 'fill', 'water', { 'fill-color': '#d7e9ec' }, { filter: ['==', ['geometry-type'], 'Polygon'] }),
      layer('rivers', 'line', 'water', { 'line-color': '#bedde4', 'line-width': 1 }, { filter: ['==', ['geometry-type'], 'LineString'] }),
      layer('boundaries', 'line', 'boundaries', { 'line-color': '#b4b6ad', 'line-width': 0.7, 'line-dasharray': [3, 3] }),
      layer('buildings', 'fill', 'buildings', { 'fill-color': '#e1e1d8' }, { minzoom: 13 }),
      layer('road-casing', 'line', 'roads', {
        'line-color': '#dedbcf',
        'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.7, 10, 2, 14, 5, 18, 12],
      }, { filter: ['in', ['get', 'kind'], ['literal', ['highway', 'major_road', 'minor_road']]] }),
      layer('roads', 'line', 'roads', {
        'line-color': ['match', ['get', 'kind'], 'highway', '#f5e3ac', '#ffffff'],
        'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.4, 10, 1, 14, 3.5, 18, 10],
      }, { filter: ['in', ['get', 'kind'], ['literal', ['highway', 'major_road', 'minor_road']]] }),
      layer('road-names', 'symbol', 'roads', { 'text-color': '#8b9186', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 }, {
        minzoom: 13, filter: ['in', ['get', 'kind'], ['literal', ['highway', 'major_road', 'minor_road']]],
        layout: { 'symbol-placement': 'line', 'text-field': name, 'text-font': fonts, 'text-size': 10 },
      }),
      layer('place-names', 'symbol', 'places', { 'text-color': '#66756b', 'text-halo-color': '#ffffff', 'text-halo-width': 2 }, {
        filter: ['in', ['get', 'kind'], ['literal', ['country', 'region', 'locality']]],
        layout: {
          'text-field': name, 'text-font': fonts,
          'text-size': ['interpolate', ['linear'], ['zoom'], 4, 11, 10, 13, 16, 16],
          'text-max-width': 8, 'symbol-sort-key': ['coalesce', ['get', 'min_zoom'], 0],
        },
      }),
      layer('neighbourhood-names', 'symbol', 'places', { 'text-color': '#7c887e', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 }, {
        minzoom: 13,
        filter: ['in', ['get', 'kind'], ['literal', ['macrohood', 'neighbourhood']]],
        layout: { 'text-field': name, 'text-font': fonts, 'text-size': 11, 'text-max-width': 8, 'symbol-sort-key': ['coalesce', ['get', 'min_zoom'], 0] },
      }),
    ],
  };
}
