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
      const asset = await env.ASSETS.fetch(new Request(new URL(entry.path, request.url), {
        method: request.method,
        headers: assetHeaders,
      }));
      if (asset.status !== 200) throw new Error(`dataset asset returned ${asset.status}`);

      const headers = new Headers(asset.headers);
      headers.set("Content-Type", "application/geo+json");
      headers.set("Cache-Control", "public, max-age=300");
      headers.set("X-Feature-Count", String(entry.count));
      if (year !== 0) headers.set("X-Filter-Year", String(year));
      else headers.delete("X-Filter-Year");

      return new Response(request.method === "HEAD" ? null : asset.body, {
        status: 200,
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
