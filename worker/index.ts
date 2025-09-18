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

interface CachedPayload {
  body: string;
  count: number;
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

const datasetCache = new Map<string, Promise<Dataset>>();
const filteredResponseCache = new Map<string, Map<number, CachedPayload>>();

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/railroads" || url.pathname === "/api/stations") {
      return handleDatasetRequest(request, env, url);
    }

    return env.ASSETS.fetch(request);
  },
};

async function handleDatasetRequest(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("method not allowed", { status: 405 });
  }

  const datasetKey = url.pathname === "/api/railroads" ? RAIL_DATA_KEY : STATION_DATA_KEY;

  let dataset: Dataset;
  try {
    dataset = await loadDataset(env, datasetKey);
  } catch (err) {
    console.error(`failed to load dataset ${datasetKey}:`, err);
    return new Response("failed to load dataset", { status: 500 });
  }

  const dateParam = url.searchParams.get("date")?.trim() ?? "";
  const filterYear = parseFilterYear(dateParam);
  if (filterYear === null) {
    return new Response("invalid date format, use YYYY-MM-DD", { status: 400 });
  }

  let cacheBucket: Map<number, CachedPayload> | undefined;
  let cachedPayload: CachedPayload | undefined;

  if (filterYear !== 0) {
    cacheBucket = filteredResponseCache.get(url.pathname);
    if (!cacheBucket) {
      cacheBucket = new Map<number, CachedPayload>();
      filteredResponseCache.set(url.pathname, cacheBucket);
    } else {
      cachedPayload = cacheBucket.get(filterYear);
    }

    if (cachedPayload) {
      const cachedHeaders = new Headers({
        "Content-Type": "application/geo+json",
        "Cache-Control": "public, max-age=300",
        "X-Feature-Count": String(cachedPayload.count),
        "X-Filter-Year": String(filterYear),
      });
      if (request.method === "HEAD") {
        return new Response(null, { status: 200, headers: cachedHeaders });
      }
      return new Response(cachedPayload.body, { status: 200, headers: cachedHeaders });
    }
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
  const headers = new Headers({
    "Content-Type": "application/geo+json",
    "Cache-Control": "public, max-age=300",
    "X-Feature-Count": String(featureCount),
  });
  if (filterYear !== 0) {
    headers.set("X-Filter-Year", String(filterYear));
  }

  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }

  const body = filterYear === 0
    ? dataset.original
    : JSON.stringify({ ...dataset.parsed, features });

  if (filterYear !== 0 && cacheBucket) {
    cacheBucket.set(filterYear, { body, count: featureCount });
  }

  return new Response(body, { status: 200, headers });
}

function parseFilterYear(value: string): number | 0 | null {
  if (value === "") {
    return 0;
  }
  const time = Date.parse(value);
  if (Number.isNaN(time)) {
    return null;
  }
  return new Date(time).getUTCFullYear();
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
    if (trimmed === "" || trimmed === "999" || trimmed === "9999") {
      return null;
    }
    const parsed = Number.parseInt(trimmed, 10);
    return Number.isNaN(parsed) || parsed >= 9000 ? null : parsed;
  }

  if (typeof value === "number") {
    return value === 999 || value >= 9000 ? null : Math.trunc(value);
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
    });
    datasetCache.set(key, cached);
  }
  return cached;
}
