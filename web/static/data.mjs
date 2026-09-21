import { MIN_YEAR, MAX_YEAR } from './state.mjs';
import { loadOfflineRailways } from './offline-store.mjs';

function validPosition(value) {
    return Array.isArray(value) && value.length >= 2 && value.every(Number.isFinite)
        && Math.abs(value[0]) <= 180 && Math.abs(value[1]) <= 90;
}

function positions(value, minimum) {
    return Array.isArray(value) && value.length >= minimum && value.every(validPosition);
}

function validRing(value) {
    return positions(value, 4) && value[0].length === value.at(-1).length
        && value[0].every((coordinate, index) => coordinate === value.at(-1)[index]);
}

function validGeometry(geometry) {
    if (geometry === null) return true;
    if (!geometry || typeof geometry !== 'object') return false;
    const coordinates = geometry.coordinates;
    switch (geometry.type) {
    case 'Point': return validPosition(coordinates);
    case 'MultiPoint': return positions(coordinates, 0);
    case 'LineString': return positions(coordinates, 2);
    case 'MultiLineString': return Array.isArray(coordinates) && coordinates.every(line => positions(line, 2));
    case 'Polygon': return Array.isArray(coordinates) && coordinates.every(validRing);
    case 'MultiPolygon': return Array.isArray(coordinates)
        && coordinates.every(polygon => Array.isArray(polygon) && polygon.every(validRing));
    case 'GeometryCollection': return Array.isArray(geometry.geometries)
        && geometry.geometries.every(item => item !== null && validGeometry(item));
    default: return false;
    }
}

function validCollection(data) {
    return data?.type === 'FeatureCollection' && Array.isArray(data.features)
        && data.features.every(feature => feature?.type === 'Feature'
            && (feature.properties === null || (typeof feature.properties === 'object'
                && !Array.isArray(feature.properties)))
            && validGeometry(feature.geometry));
}

async function fetchCollection(fetchFn, endpoint, signal) {
    const response = await fetchFn(endpoint, { signal });
    signal.throwIfAborted();
    if (!response.ok) throw new Error(`データを取得できませんでした（HTTP ${response.status}）。`);
    const data = await response.json();
    signal.throwIfAborted();
    if (!validCollection(data)) throw new Error('取得した地図データの形式が正しくありません。');
    return data;
}

/** Keep only the two most recently used periods, without sharing cancellation between callers. */
export function createDatasetLoader(fetchFn = fetch, { offlineLoader = loadOfflineRailways } = {}) {
    const cache = new Map();
    let generation = 0;

    async function load(year, { signal } = {}) {
        if (year !== null && (!Number.isInteger(year) || year < MIN_YEAR || year > MAX_YEAR)) {
            throw new RangeError(`年は ${MIN_YEAR}〜${MAX_YEAR} または null で指定してください。`);
        }
        signal?.throwIfAborted();
        const offlineEnabled = offlineLoader !== loadOfflineRailways || typeof globalThis.caches !== 'undefined';
        if (!offlineEnabled && cache.has(year)) {
            const data = cache.get(year);
            cache.delete(year);
            cache.set(year, data);
            return data;
        }

        const controller = new AbortController();
        const cancel = () => controller.abort(signal.reason);
        signal?.addEventListener('abort', cancel, { once: true });
        let rejectAbort;
        const aborted = new Promise((_, reject) => { rejectAbort = reject; });
        const onAbort = () => rejectAbort(controller.signal.reason);
        controller.signal.addEventListener('abort', onAbort, { once: true });
        const currentGeneration = generation;
        const query = year === null ? '' : `?date=${year}-01-01`;

        try {
            const resolveData = async () => {
                if (offlineEnabled) {
                    try {
                        const saved = await offlineLoader(year);
                        controller.signal.throwIfAborted();
                        if (saved) return saved;
                    } catch (error) {
                        if (controller.signal.aborted || error?.name === 'AbortError') throw error;
                        // CacheStorage can be unavailable or evicted; online loading still works.
                    }
                    controller.signal.throwIfAborted();
                    if (cache.has(year)) return cache.get(year);
                }
                const [railroads, stations] = await Promise.all([
                    fetchCollection(fetchFn, `/api/railroads${query}`, controller.signal),
                    fetchCollection(fetchFn, `/api/stations${query}`, controller.signal),
                ]);
                return { railroads, stations };
            };
            const data = await Promise.race([
                resolveData(),
                aborted,
            ]);
            controller.signal.throwIfAborted();
            if (currentGeneration === generation) {
                cache.delete(year);
                cache.set(year, data);
                if (cache.size > 2) cache.delete(cache.keys().next().value);
            }
            return data;
        } catch (error) {
            controller.abort();
            throw error;
        } finally {
            signal?.removeEventListener('abort', cancel);
            controller.signal.removeEventListener('abort', onAbort);
        }
    }

    return {
        load,
        clear() {
            generation += 1;
            cache.clear();
        },
    };
}

function text(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function normalize(value) {
    return text(value).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Search only the loaded period; prioritize name matches, then stations when equally relevant. */
export function searchFeatures(data, query, limit = 8) {
    const normalizedQuery = normalize(query);
    if (!normalizedQuery || !Number.isInteger(limit) || limit <= 0) return [];
    const tokens = normalizedQuery.split(' ');
    const matches = [];
    const seen = new Set();

    for (const [kind, collection] of [['station', data?.stations], ['railroad', data?.railroads]]) {
        for (const feature of collection?.features ?? []) {
            const properties = feature?.properties;
            const line = text(properties?.N05_002);
            const operator = text(properties?.N05_003);
            const name = kind === 'station' ? text(properties?.N05_011) : line;
            if (!name || !feature.geometry) continue;
            const normalizedName = normalize(name);
            const haystack = `${normalizedName} ${normalize(line)} ${normalize(operator)}`;
            if (!tokens.every(token => haystack.includes(token))) continue;
            const identity = kind === 'station'
                ? JSON.stringify([kind, normalizedName, normalize(line), normalize(operator), feature.geometry.coordinates])
                : JSON.stringify([kind, normalizedName, normalize(operator), properties?.N05_006 ?? feature.geometry.coordinates]);
            if (seen.has(identity)) continue;
            seen.add(identity);
            const nameRank = normalizedName === normalizedQuery ? 0
                : normalizedName.startsWith(normalizedQuery) ? 1
                    : normalizedName.includes(normalizedQuery) ? 2 : 3;
            matches.push({ result: { kind, feature, name, line, operator }, rank: nameRank * 2 + (kind === 'station' ? 0 : 1) });
        }
    }
    return matches.sort((a, b) => a.rank - b.rank).slice(0, limit).map(match => match.result);
}
