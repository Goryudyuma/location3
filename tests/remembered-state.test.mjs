import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_YEAR, MIN_YEAR, readInitialState, readState, saveLastState } from '../web/static/state.mjs';

const previous = {
    year: 1966,
    railroads: false,
    stations: true,
    view: { lat: 43.89393, lng: 142.50092, zoom: 9 },
};
function memoryStorage(value = null) {
    const values = new Map(value === null ? [] : [['location3-last-state', value]]);
    return {
        getItem: key => values.get(key) ?? null,
        setItem: (key, item) => values.set(key, item),
    };
}

test('home and unrelated query parameters restore the previous map, year and layers', () => {
    const storage = memoryStorage();
    assert.equal(saveLastState(previous, () => storage), true);
    for (const search of ['', '?', '?ref=bookmark', '?utm_source=home&ref=phone']) {
        assert.deepEqual(readInitialState(search, () => storage), previous, search);
    }
    assert.deepEqual(previous.view, { lat: 43.89393, lng: 142.50092, zoom: 9 });
});

test('all-period mode and the most recent view replace the earlier saved state', () => {
    const storage = memoryStorage();
    saveLastState(previous, () => storage);
    const latest = { year: null, railroads: true, stations: false, view: { lat: 33.59, lng: 130.42, zoom: 15 } };
    saveLastState(latest, () => storage);
    assert.deepEqual(readInitialState('', () => storage), latest);
});

test('any explicit current or legacy share parameter takes precedence without merging storage', () => {
    let storageReads = 0;
    const getStorage = () => { storageReads++; return memoryStorage(JSON.stringify({ version: 1, ...previous })); };
    for (const search of [
        '?year=2000', '?year=all', '?year=bad', '?year=',
        '?date=1980-01-01', '?date=', '?date=bad',
        '?lat=35&lng=139&zoom=12', '?lat=35', '?lng=139', '?zoom=12',
        '?rail=0', '?station=0', '?rail=bad', '?station=',
        '?ref=bookmark&year=1950&lat=35.5&lng=139.75&zoom=12&rail=0&station=0',
    ]) {
        assert.deepEqual(readInitialState(search, getStorage), readState(search), search);
    }
    assert.equal(storageReads, 0, 'shared links must not read saved state');
});

test('missing, corrupt, incomplete and unsupported saved states use the normal home defaults', () => {
    const saved = { version: 1, ...previous };
    const invalid = [
        null, '', '{', 'null', '[]', 'true', '1', '"text"', '{}',
        ...[
            previous, { ...saved, version: 2 }, { ...saved, year: '1966' },
            { ...saved, year: MIN_YEAR - 1 }, { ...saved, year: MAX_YEAR + 1 },
            { ...saved, year: 1966.5 }, { ...saved, year: undefined },
            { ...saved, railroads: 0 }, { ...saved, stations: undefined },
            { ...saved, view: null }, { ...saved, view: { lat: 35, lng: 139 } },
            { ...saved, view: { ...previous.view, lat: '43.89' } },
            { ...saved, view: { ...previous.view, lat: 91 } },
            { ...saved, view: { ...previous.view, lng: -181 } },
            { ...saved, view: { ...previous.view, zoom: 19 } },
            { ...saved, view: { ...previous.view, zoom: 9.5 } },
        ].map(value => JSON.stringify(value)),
    ];
    for (const value of invalid) {
        const storage = memoryStorage(value);
        assert.deepEqual(readInitialState('?ref=home', () => storage), readState(''), String(value));
    }
});

test('storage access and read failures leave startup and saving usable', () => {
    for (const getStorage of [
        () => undefined,
        () => { throw new Error('SecurityError'); },
        () => ({ getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('QuotaExceededError'); } }),
    ]) {
        assert.deepEqual(readInitialState('', getStorage), readState(''));
        assert.equal(saveLastState(previous, getStorage), false);
    }
});

test('invalid state cannot overwrite a valid previous visit', () => {
    const storage = memoryStorage();
    saveLastState(previous, () => storage);
    for (const value of [undefined, null, {}, { ...previous, view: null }, { ...previous, year: NaN }, { ...previous, view: { ...previous.view, lng: Infinity } }]) {
        assert.equal(saveLastState(value, () => storage), false);
        assert.deepEqual(readInitialState('', () => storage), previous);
    }
});

test('only the map state is persisted and caller objects are not reused on restore', () => {
    const storage = memoryStorage();
    saveLastState({ ...previous, search: '駅名', locationPermission: true }, () => storage);
    const saved = JSON.parse(storage.getItem('location3-last-state'));
    assert.deepEqual(saved, { version: 1, ...previous });
    const restored = readInitialState('', () => storage);
    restored.view.lat = 0;
    assert.deepEqual(readInitialState('', () => storage), previous);
});
