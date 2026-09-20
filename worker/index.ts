import { PayloadCache } from "./payload-cache.ts";

const RAIL_DATA_KEY = "N05-24_RailroadSection2.geojson";
const STATION_DATA_KEY = "N05-24_Station2.geojson";
const START_YEAR_KEY = "N05_005b";
const END_YEAR_KEY = "N05_005e";
const LINE_NAME_KEY = "N05_002";

interface Dataset {
  original: string;
  parsed: GeoJSONFeatureCollection;
  features: GeoJSONFeature[];
}

interface GeoJSONFeatureCollection {
  type: string;
  features: GeoJSONFeature[];
  [key: string]: unknown;
}

interface GeoJSONFeature {
  type: string;
  properties?: Record<string, unknown> | null;
  geometry: unknown;
  id?: unknown;
  bbox?: unknown;
  [key: string]: unknown;
}

interface Env {
  DATA_BUCKET: R2Bucket;
  ASSETS: Fetcher;
}

interface DatasetCache {
  datasets: Map<string, Promise<Dataset>>;
  responses: PayloadCache;
}

// Keep caches isolated if the worker is reused with a different R2 binding.
const caches = new WeakMap<R2Bucket, DatasetCache>();

function cacheFor(bucket: R2Bucket): DatasetCache {
  let cache = caches.get(bucket);
  if (!cache) {
    cache = { datasets: new Map(), responses: new PayloadCache() };
    caches.set(bucket, cache);
  }
  return cache;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/railroads" || url.pathname === "/api/stations") {
      return handleDatasetRequest(request, env, url);
    }

    return env.ASSETS.fetch(request);
  },
};

async function handleDatasetRequest(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  }

  const dateParam = url.searchParams.get("date")?.trim() ?? "";
  const filterYear = parseFilterYear(dateParam);
  if (filterYear === null) {
    return new Response("invalid date format, use YYYY-MM-DD", { status: 400 });
  }

  const cache = cacheFor(env.DATA_BUCKET);
  const datasetKey = url.pathname === "/api/railroads" ? RAIL_DATA_KEY : STATION_DATA_KEY;
  const responseKey = `${datasetKey}:${filterYear}`;
  const cachedPayload = filterYear === 0 ? undefined : cache.responses.get(responseKey);
  if (cachedPayload) {
    return datasetResponse(request, cachedPayload.body, cachedPayload.count, filterYear);
  }

  let dataset: Dataset;
  try {
    dataset = await loadDataset(env, datasetKey);
  } catch (err) {
    console.error(`failed to load dataset ${datasetKey}:`, err);
    return new Response("failed to load dataset", { status: 500 });
  }

  let features = filterYear === 0 ? dataset.features : filterByYear(dataset.features, filterYear);

  if (filterYear !== 0 && url.pathname === "/api/stations") {
    try {
      const railDataset = await loadDataset(env, RAIL_DATA_KEY);
      const activeRailFeatures = filterByYear(railDataset.features, filterYear);
      const allowedLines = activeLineNames(activeRailFeatures);
      features = features.filter((feature) => allowedLines.has(propertyString(feature.properties, LINE_NAME_KEY)));
    } catch (err) {
      console.error("failed to load rail dataset for station filtering", err);
      return new Response("failed to evaluate station dataset", { status: 500 });
    }
  }

  const featureCount = features.length;
  if (request.method === "HEAD") {
    return datasetResponse(request, null, featureCount, filterYear);
  }

  const body = filterYear === 0
    ? dataset.original
    : JSON.stringify({ ...dataset.parsed, features });

  if (filterYear !== 0) {
    cache.responses.set(responseKey, { body, count: featureCount });
  }

  return datasetResponse(request, body, featureCount, filterYear);
}

function datasetResponse(request: Request, body: string | null, count: number, year: number): Response {
  const headers = new Headers({
    "Content-Type": "application/geo+json",
    "Cache-Control": "public, max-age=300",
    "X-Feature-Count": String(count),
  });
  if (year !== 0) {
    headers.set("X-Filter-Year", String(year));
  }
  return new Response(request.method === "HEAD" ? null : body, { status: 200, headers });
}

function parseFilterYear(value: string): number | 0 | null {
  if (value === "") {
    return 0;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000-")) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  // Date parsing normalizes invalid days (such as February 30); round-trip to
  // reject them and keep the local Go server and Worker behavior identical.
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return null;
  return date.getUTCFullYear();
}

function filterByYear(features: GeoJSONFeature[], year: number): GeoJSONFeature[] {
  return features.filter((feature) => isActiveForYear(feature, year));
}

function isActiveForYear(feature: GeoJSONFeature, year: number): boolean {
  if (year === 0) {
    return true;
  }

  const props = feature.properties ?? undefined;
  const startYear = parseYearField(props, START_YEAR_KEY);
  if (startYear !== null && year < startYear) {
    return false;
  }

  const endYear = parseYearField(props, END_YEAR_KEY);
  if (endYear !== null && year > endYear) {
    return false;
  }

  return true;
}

function parseYearField(props: Record<string, unknown> | undefined, key: string): number | null {
  if (!props) {
    return null;
  }
  const value = props[key];
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^[+-]?\d+$/.test(trimmed)) return null;
    const year = Number(trimmed);
    return Number.isInteger(year) && year > 0 && year < 9000 && year !== 999 ? year : null;
  }

  if (typeof value === "number") {
    return Number.isInteger(value) && value > 0 && value < 9000 && value !== 999 ? value : null;
  }

  return null;
}

function propertyString(props: Record<string, unknown> | undefined | null, key: string): string {
  if (!props) {
    return "";
  }
  const value = props[key];
  return typeof value === "string" ? value.trim() : "";
}

function activeLineNames(features: GeoJSONFeature[]): Set<string> {
  const names = new Set<string>();
  for (const feature of features) {
    const name = propertyString(feature.properties, LINE_NAME_KEY);
    if (name !== "") {
      names.add(name);
    }
  }
  return names;
}

async function loadDataset(env: Env, key: string): Promise<Dataset> {
  const datasetCache = cacheFor(env.DATA_BUCKET).datasets;
  let cached = datasetCache.get(key);
  if (!cached) {
    cached = env.DATA_BUCKET.get(key).then(async (object) => {
      if (!object) {
        throw new Error(`dataset object ${key} not found in R2 bucket`);
      }
      const body = await object.text();
      const parsed = JSON.parse(body) as GeoJSONFeatureCollection;
      if (!Array.isArray(parsed.features)) {
        throw new Error("invalid dataset: missing features array");
      }
      return {
        original: body,
        parsed,
        features: parsed.features,
      };
    }).catch((err) => {
      // A transient R2 or parse error must not poison every subsequent request.
      datasetCache.delete(key);
      throw err;
    });
    datasetCache.set(key, cached);
  }
  return cached;
}
