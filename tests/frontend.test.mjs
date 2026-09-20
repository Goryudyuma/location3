import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_VIEW, MAX_YEAR, MIN_YEAR, readState, writeState } from '../web/static/state.mjs';
import { createDatasetLoader, searchFeatures } from '../web/static/data.mjs';

const collection = (...features) => ({ type: 'FeatureCollection', features });
const station = (name, line = '中央線', coordinates = [139.7, 35.7], operator = 'JR東日本') => ({
    type: 'Feature',
    properties: { N05_011: name, N05_002: line, N05_003: operator },
    geometry: { type: 'Point', coordinates },
});
const railroad = (name, id = 'rail-1') => ({
    type: 'Feature',
    properties: { N05_002: name, N05_003: 'JR東日本', N05_006: id },
    geometry: { type: 'LineString', coordinates: [[139.7, 35.7], [139.8, 35.8]] },
});
const response = (data = collection()) => ({ ok: true, status: 200, json: async () => data });
const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
    return { promise, resolve, reject };
};

test('readState defaults to the latest year and visible layers', () => {
    assert.deepEqual(readState(''), { year: MAX_YEAR, railroads: true, stations: true, view: null });
    assert.deepEqual(DEFAULT_VIEW, { lat: 36.5, lng: 137.5, zoom: 6 });
});

test('readState validates years and preserves old date links', () => {
    const cases = [
        ['?year=all', null], ['?year=1985', 1985], ['?year=1900', MIN_YEAR],
        ['?year=9999', MAX_YEAR], ['?year=1985junk', MAX_YEAR], ['?year=1e3', MAX_YEAR],
        ['?year=1985.5', MAX_YEAR], ['?year=%201985', MAX_YEAR], ['?year=', MAX_YEAR],
        ['?date=1980-02-29', 1980], ['?date=1981-02-29', MAX_YEAR],
        ['?date=1914-01-01', MIN_YEAR], ['?date=2030-01-01', MAX_YEAR],
        ['?date=1985-13-01', MAX_YEAR], ['?date=1985-01-01junk', MAX_YEAR],
        ['?year=all&date=1985-01-01', null], ['?year=bad&date=1985-01-01', MAX_YEAR],
    ];
    for (const [query, expected] of cases) assert.equal(readState(query).year, expected, query);
});

test('readState preserves all-period legacy shares while retaining the latest-year home page', () => {
    for (const query of [
        '?lat=35.5&lng=139.75&zoom=12', '?lat=35.5', '?lng=139.75', '?zoom=12',
        '?rail=0', '?station=0', '?date=', '?date=&lat=35.5&lng=139.75&zoom=12',
    ]) assert.equal(readState(query).year, null, query);
    for (const query of ['', '?', '?ref=bookmark', '?date=%20', '?date=invalid&rail=0', '?year=&date=']) {
        assert.equal(readState(query).year, MAX_YEAR, query);
    }
    assert.equal(readState('?year=1980&rail=0&date=').year, 1980);
    assert.equal(readState('?date=1980-01-01&rail=0').year, 1980);
    const migrated = writeState(readState('?lat=35.5&lng=139.75&zoom=12&rail=0'));
    assert.equal(migrated.get('year'), 'all');
    assert.equal(migrated.get('rail'), '0');
    assert.deepEqual(readState(migrated), {
        year: null, railroads: false, stations: true, view: { lat: 35.5, lng: 139.75, zoom: 12 },
    });
});

test('readState accepts a complete bounded map view and exact layer flags', () => {
    assert.deepEqual(readState('?year=2000&lat=35.5&lng=139.75&zoom=12&rail=0&station=0'), {
        year: 2000, railroads: false, stations: false, view: { lat: 35.5, lng: 139.75, zoom: 12 },
    });
    assert.deepEqual(readState('?lat=-90&lng=180&zoom=0').view, { lat: -90, lng: 180, zoom: 0 });
    assert.equal(readState('?rail=false&station=').railroads, true);
    assert.equal(readState('?rail=false&station=').stations, true);
});

test('readState rejects partial views, out-of-range coordinates and numeric junk', () => {
    for (const query of [
        '?lat=35&lng=139', '?lat=&lng=139&zoom=6', '?lat=91&lng=139&zoom=6',
        '?lat=35&lng=181&zoom=6', '?lat=35&lng=139&zoom=19', '?lat=35&lng=139&zoom=-1',
        '?lat=35&lng=139&zoom=6.5', '?lat=35junk&lng=139&zoom=6', '?lat=35&lng=139&zoom=6junk',
        '?lat=0x20&lng=139&zoom=6', '?lat=Infinity&lng=139&zoom=6', '?lat=3e1&lng=139&zoom=6',
    ]) assert.equal(readState(query).view, null, query);
});

test('writeState round-trips all-time state and produces only safe parameters', () => {
    const state = { year: null, railroads: false, stations: true, view: { lat: 35.123456, lng: 139.5, zoom: 8 } };
    const query = writeState(state);
    assert.ok(query instanceof URLSearchParams);
    assert.equal(query.toString(), 'year=all&lat=35.12346&lng=139.50000&zoom=8&rail=0');
    assert.deepEqual(readState(query), { ...state, view: { ...state.view, lat: 35.12346 } });
    assert.equal(writeState({ year: NaN, view: { lat: Infinity, lng: 0, zoom: 6 } }).toString(), 'year=2024');
    assert.equal(writeState({ year: 1900, view: null, stations: false }).toString(), 'year=1950&station=0');
    assert.equal(writeState({ year: '<script>' }).toString(), 'year=2024');
    assert.equal(writeState(null).toString(), 'year=2024');
});

test('loader starts both endpoints concurrently with January 1 of the chosen year', async () => {
    const requests = [];
    const pending = deferred();
    const loader = createDatasetLoader((url, options) => {
        requests.push({ url, signal: options.signal });
        return pending.promise;
    });
    const loading = loader.load(2000);
    assert.deepEqual(requests.map(request => request.url), ['/api/railroads?date=2000-01-01', '/api/stations?date=2000-01-01']);
    assert.equal(requests.length, 2);
    assert.ok(requests.every(request => request.signal instanceof AbortSignal));
    pending.resolve(response());
    assert.deepEqual(await loading, { railroads: collection(), stations: collection() });
});

test('loader requests all periods without a date and rejects invalid API input', async () => {
    const requests = [];
    const loader = createDatasetLoader(async url => { requests.push(url); return response(); });
    await loader.load(null);
    assert.deepEqual(requests, ['/api/railroads', '/api/stations']);
    for (const year of [1949, 2025, NaN, Infinity, 2000.5, '2000', undefined]) {
        await assert.rejects(loader.load(year), RangeError);
    }
    assert.equal(requests.length, 2);
});

test('loader cache retains the two most recently used periods and supports clear', async () => {
    let requests = 0;
    const loader = createDatasetLoader(async () => { requests += 1; return response(); });
    const first = await loader.load(2024);
    await loader.load(2023);
    assert.equal(await loader.load(2024), first);
    await loader.load(null);
    assert.equal(requests, 6);
    assert.equal(await loader.load(2024), first);
    await loader.load(2023);
    assert.equal(requests, 8, '2023 was least recently used and must be fetched again');
    loader.clear();
    await loader.load(2023);
    assert.equal(requests, 10);
});

test('clearing during an outstanding request prevents it from repopulating the cache', async () => {
    const pending = deferred();
    let requests = 0;
    const loader = createDatasetLoader(async () => {
        requests += 1;
        return requests <= 2 ? pending.promise : response();
    });
    const loading = loader.load(2024);
    loader.clear();
    pending.resolve(response());
    await loading;
    await loader.load(2024);
    assert.equal(requests, 4);
});

test('failed responses reject and can be retried without a poisoned cache', async () => {
    let failing = true;
    let requests = 0;
    const loader = createDatasetLoader(async () => {
        requests += 1;
        return failing ? { ok: false, status: 503 } : response();
    });
    await assert.rejects(loader.load(2024), /HTTP 503/);
    failing = false;
    await loader.load(2024);
    assert.equal(requests, 4);
});

test('loader rejects malformed GeoJSON including feature geometry', async () => {
    const malformed = [
        null, {}, { type: 'FeatureCollection', features: {} },
        collection({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: ['139', 35] } }),
        collection({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [139, 100] } }),
        collection({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[139, 35]] } }),
        collection({ type: 'Feature', properties: {}, geometry: { type: 'Unknown', coordinates: [] } }),
        collection({ type: 'Feature', properties: [], geometry: null }),
    ];
    for (const data of malformed) {
        const loader = createDatasetLoader(async () => response(data));
        await assert.rejects(loader.load(2024), /形式/);
    }
    const loader = createDatasetLoader(async () => ({ ok: true, json: async () => { throw new SyntaxError('invalid JSON'); } }));
    await assert.rejects(loader.load(2024), SyntaxError);
});

test('loader accepts real station/railway geometries and empty collections', async () => {
    const stations = collection(station('東京'));
    const railroads = collection(railroad('中央線'));
    const loader = createDatasetLoader(async url => response(url.includes('stations') ? stations : railroads));
    assert.deepEqual(await loader.load(2024), { railroads, stations });
});

test('an already aborted caller performs no fetch and cannot consume cached results', async () => {
    let requests = 0;
    const loader = createDatasetLoader(async () => { requests += 1; return response(); });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(loader.load(2024, { signal: controller.signal }), { name: 'AbortError' });
    assert.equal(requests, 0);
    await loader.load(2024);
    await assert.rejects(loader.load(2024, { signal: controller.signal }), { name: 'AbortError' });
    assert.equal(requests, 2);
});

test('abort rejects promptly, cancels both requests and never caches a late response', async () => {
    const pending = deferred();
    const signals = [];
    let requests = 0;
    const loader = createDatasetLoader((_, { signal }) => {
        signals.push(signal);
        requests += 1;
        return requests <= 2 ? pending.promise : Promise.resolve(response());
    });
    const controller = new AbortController();
    const loading = loader.load(2024, { signal: controller.signal });
    controller.abort();
    await assert.rejects(loading, { name: 'AbortError' });
    assert.ok(signals.every(signal => signal.aborted));
    pending.resolve(response());
    await loader.load(2024);
    assert.equal(requests, 4);
});

test('aborting one caller leaves a concurrent caller independent', async () => {
    const pending = deferred();
    const loader = createDatasetLoader(async () => pending.promise);
    const controller = new AbortController();
    const canceled = loader.load(2024, { signal: controller.signal });
    const continuing = loader.load(2024);
    controller.abort();
    await assert.rejects(canceled, { name: 'AbortError' });
    pending.resolve(response());
    assert.deepEqual(await continuing, { railroads: collection(), stations: collection() });
});

test('search normalizes width and whitespace, accepts partial names and matches metadata', () => {
    const feature = station('ＡＢＣ東京', '中央線', [139, 35], 'ＪＲ東日本');
    const data = { stations: collection(feature), railroads: collection() };
    assert.equal(searchFeatures(data, '　abc　')[0].feature, feature);
    assert.equal(searchFeatures(data, '東京 中央')[0].feature, feature);
    assert.equal(searchFeatures(data, 'jr東')[0].feature, feature);
    assert.deepEqual(searchFeatures(data, '　 '), []);
    assert.deepEqual(searchFeatures(data, '大阪'), []);
});

test('search ranks names by relevance and prefers stations for equally relevant names', () => {
    const data = {
        stations: collection(station('新東京'), station('東京'), station('東京港')),
        railroads: collection(railroad('東京')),
    };
    const results = searchFeatures(data, '東京', 4);
    assert.deepEqual(results.map(result => [result.kind, result.name]), [
        ['station', '東京'], ['railroad', '東京'], ['station', '東京港'], ['station', '新東京'],
    ]);
    assert.deepEqual(Object.keys(results[0]).sort(), ['feature', 'kind', 'line', 'name', 'operator']);
    assert.equal(searchFeatures(data, '東京', 2).length, 2);
});

test('an exact railway name appears before stations matching that line in their metadata', () => {
    const line = railroad('東海道新幹線');
    const data = {
        stations: collection(...Array.from({ length: 12 }, (_, index) => station(`駅${index}`, '東海道新幹線', [139 + index / 100, 35]))),
        railroads: collection(line),
    };
    const results = searchFeatures(data, '東海道新幹線');
    assert.equal(results.length, 8);
    assert.equal(results[0].kind, 'railroad');
    assert.equal(results[0].feature, line);
    assert.ok(results.slice(1).every(result => result.kind === 'station'));
});

test('search deduplicates historical station records but retains distinct places and lines', () => {
    const original = station('中央');
    const historical = { ...station('中央'), properties: { ...original.properties, N05_005b: '1950' } };
    const data = {
        stations: collection(original, historical, station('中央', '中央線', [135, 35]), station('中央', '別路線')),
        railroads: collection(),
    };
    const results = searchFeatures(data, '中央');
    assert.equal(results.length, 3);
    assert.equal(results[0].feature, original);
});

test('search considers only supplied data and handles empty input and result limits', () => {
    assert.deepEqual(searchFeatures(null, '東京'), []);
    const previous = { stations: collection(station('廃駅')), railroads: collection() };
    const current = { stations: collection(station('新駅')), railroads: collection() };
    assert.equal(searchFeatures(previous, '廃駅').length, 1);
    assert.deepEqual(searchFeatures(current, '廃駅'), []);
    for (const limit of [0, -1, NaN, 1.5]) assert.deepEqual(searchFeatures(current, '新駅', limit), []);
});
