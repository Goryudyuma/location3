export const MIN_YEAR = 1950;
export const MAX_YEAR = 2024;
export const DEFAULT_VIEW = Object.freeze({ lat: 36.5, lng: 137.5, zoom: 6 });

function normalizeYear(value) {
    if (value === null || value === 'all') return null;
    const year = typeof value === 'number'
        ? value
        : typeof value === 'string' && /^\d{4}$/.test(value) ? Number(value) : NaN;
    return Number.isInteger(year) ? Math.min(MAX_YEAR, Math.max(MIN_YEAR, year)) : MAX_YEAR;
}

function legacyYear(date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) return MAX_YEAR;
    const parsed = new Date(`${date}T00:00:00Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return MAX_YEAR;
    return normalizeYear(date.slice(0, 4));
}

function readYear(params) {
    if (params.has('year')) return normalizeYear(params.get('year'));
    if (params.has('date')) return params.get('date') === '' ? null : legacyYear(params.get('date'));
    // Previous shared links omitted the date when showing all periods.
    if (['lat', 'lng', 'zoom', 'rail', 'station'].some(key => params.has(key))) return null;
    return MAX_YEAR;
}

function decimal(value) {
    if (typeof value === 'number') return value;
    return typeof value === 'string' && /^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)
        ? Number(value) : NaN;
}

function normalizeView(view) {
    if (!view || typeof view !== 'object') return null;
    const lat = decimal(view.lat);
    const lng = decimal(view.lng);
    const zoom = decimal(view.zoom);
    if (!Number.isFinite(lat) || Math.abs(lat) > 90
        || !Number.isFinite(lng) || Math.abs(lng) > 180
        || !Number.isInteger(zoom) || zoom < 0 || zoom > 18) return null;
    return { lat, lng, zoom };
}

/** Read both the current year links and the previous date-based links. */
export function readState(search = '') {
    const params = new URLSearchParams(search);
    return {
        year: readYear(params),
        railroads: params.get('rail') !== '0',
        stations: params.get('station') !== '0',
        view: normalizeView({ lat: params.get('lat'), lng: params.get('lng'), zoom: params.get('zoom') }),
    };
}

/** Serialize only validated, shareable state; unrelated query parameters are omitted. */
export function writeState(state = {}) {
    const params = new URLSearchParams();
    const year = normalizeYear(state?.year);
    params.set('year', year === null ? 'all' : String(year));
    const view = normalizeView(state?.view);
    if (view) {
        params.set('lat', view.lat.toFixed(5));
        params.set('lng', view.lng.toFixed(5));
        params.set('zoom', String(view.zoom));
    }
    if (state?.railroads === false) params.set('rail', '0');
    if (state?.stations === false) params.set('station', '0');
    return params;
}
