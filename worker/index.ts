interface AssetEntry {
  path: string;
  count: number;
}

interface DatasetPair {
  railroads: AssetEntry;
  stations: AssetEntry;
}

interface Period extends DatasetPair {
  startYear: number;
}

interface Manifest {
  version: 1;
  all: DatasetPair;
  periods: Period[];
}

interface Env {
  ASSETS: Fetcher;
}

// Only the small index stays in memory. GeoJSON bodies are streamed directly
// from static assets, avoiding national datasets in the Worker heap or CPU.
const manifests = new WeakMap<Fetcher, Promise<Manifest>>();

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/api/railroads" && url.pathname !== "/api/stations") {
      return env.ASSETS.fetch(request);
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    }

    const year = parseFilterYear(url.searchParams.get("date")?.trim() ?? "");
    if (year === null) {
      return new Response("invalid date format, use YYYY-MM-DD", { status: 400 });
    }

    try {
      const manifest = await loadManifest(env.ASSETS, request.url);
      const datasets = year === 0 ? manifest.all : periodForYear(manifest.periods, year);
      const entry = url.pathname === "/api/railroads" ? datasets.railroads : datasets.stations;
      const assetHeaders = new Headers();
      const encoding = request.headers.get("Accept-Encoding");
      if (encoding) assetHeaders.set("Accept-Encoding", encoding);
      // Let static assets validate their own ETags without reading GeoJSON here.
      // If-None-Match takes precedence over If-Modified-Since (RFC 9110).
      const etag = request.headers.get("If-None-Match");
      const modifiedSince = request.headers.get("If-Modified-Since");
      if (etag !== null) assetHeaders.set("If-None-Match", etag);
      else if (modifiedSince !== null) assetHeaders.set("If-Modified-Since", modifiedSince);
      const asset = await env.ASSETS.fetch(new Request(new URL(entry.path, request.url), {
        method: request.method,
        headers: assetHeaders,
      }));
      if (asset.status !== 200 && asset.status !== 304) throw new Error(`dataset asset returned ${asset.status}`);
      // Some asset runtimes only recognize a single tag. Complete weak/list/*
      // matching using response headers, without consuming the dataset stream.
      const notModified = asset.status === 304 || matchesETag(etag, asset.headers.get("ETag"));
      if (notModified && asset.body) await asset.body.cancel();

      const headers = new Headers(asset.headers);
      headers.set("Content-Type", "application/geo+json");
      headers.set("Cache-Control", "public, max-age=300");
      headers.set("X-Feature-Count", String(entry.count));
      if (year !== 0) headers.set("X-Filter-Year", String(year));
      else headers.delete("X-Filter-Year");
      if (notModified) {
        headers.delete("Content-Length");
        headers.delete("Content-Encoding");
      }

      return new Response(request.method === "HEAD" || notModified ? null : asset.body, {
        status: notModified ? 304 : 200,
        headers,
        // Preserve any pre-encoded asset bytes and their Content-Encoding.
        encodeBody: "manual",
      });
    } catch (error) {
      console.error("Failed to serve dataset:", error instanceof Error ? error.message : "unknown error");
      return new Response("failed to load dataset", { status: 500 });
    }
  },
};

function matchesETag(value: string | null, current: string | null): boolean {
  if (value === null) return false;
  const input = value.trim();
  if (input === "*") return true;
  if (current === null) return false;
  // An opaque tag may contain commas. Empty list elements are allowed by HTTP.
  const tag = /(?:W\/)?("[\x21\x23-\x7e\x80-\xff]*")/y;
  const selected = current.replace(/^W\//, "");
  let matched = false;
  let offset = 0;
  while (offset < input.length) {
    while (offset < input.length && /[ \t,]/.test(input[offset])) offset++;
    if (offset === input.length) break;
    tag.lastIndex = offset;
    const item = tag.exec(input);
    if (!item) return false;
    matched ||= item[1] === selected;
    offset = tag.lastIndex;
    while (offset < input.length && /[ \t]/.test(input[offset])) offset++;
    if (offset < input.length && input[offset++] !== ",") return false;
  }
  return matched;
}

async function loadManifest(assets: Fetcher, origin: string): Promise<Manifest> {
  let pending = manifests.get(assets);
  if (!pending) {
    pending = (async () => {
      const response = await assets.fetch(new Request(new URL("/datasets/manifest.json", origin)));
      if (response.status !== 200) throw new Error(`dataset manifest returned ${response.status}`);
      const manifest: unknown = await response.json();
      if (!validManifest(manifest)) throw new Error("invalid dataset manifest");
      return manifest;
    })().catch((error) => {
      // Share concurrent loads, but never retain a failed fetch or validation.
      manifests.delete(assets);
      throw error;
    });
    manifests.set(assets, pending);
  }
  return pending;
}

function validEntry(value: unknown): value is AssetEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as AssetEntry;
  return typeof entry.path === "string" && /^\/datasets\/[a-f0-9]{64}\.geojson$/.test(entry.path)
    && Number.isSafeInteger(entry.count) && entry.count >= 0;
}

function validPair(value: unknown): value is DatasetPair {
  if (!value || typeof value !== "object") return false;
  const pair = value as DatasetPair;
  return validEntry(pair.railroads) && validEntry(pair.stations);
}

function validManifest(value: unknown): value is Manifest {
  if (!value || typeof value !== "object") return false;
  const manifest = value as Manifest;
  if (manifest.version !== 1 || !validPair(manifest.all)
    || !Array.isArray(manifest.periods) || manifest.periods.length === 0
    || manifest.periods.length > 9999) return false;
  let previousYear = 0;
  for (const period of manifest.periods) {
    if (!validPair(period) || !Number.isInteger(period.startYear)
      || period.startYear <= previousYear || period.startYear > 9999) return false;
    previousYear = period.startYear;
  }
  return manifest.periods[0].startYear === 1;
}

function periodForYear(periods: Period[], year: number): Period {
  let low = 0;
  let high = periods.length;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (periods[middle].startYear <= year) low = middle;
    else high = middle;
  }
  return periods[low];
}

function parseFilterYear(value: string): number | null {
  if (value === "") return 0;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000-")) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  // Date parsing normalizes invalid days; reject them by round-tripping.
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return null;
  return date.getUTCFullYear();
}
