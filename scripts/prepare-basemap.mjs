import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const CATALOG = join(ROOT, 'basemaps/catalog.json');
const CACHE = join(ROOT, '.generated/basemaps');
export const MAX_ARCHIVE_BYTES = 24 * 1024 * 1024;
export const BLOCK_BYTES = 256 * 1024;
const SOURCE = 'https://build.protomaps.com/20260920.pmtiles';
const JAPAN = [122, 20, 154, 46];

function validBounds(bounds) {
  return Array.isArray(bounds) && bounds.length === 4 && bounds.every(Number.isFinite)
    && bounds[0] >= -180 && bounds[2] <= 180 && bounds[1] >= -85.051129 && bounds[3] <= 85.051129
    && bounds[0] < bounds[2] && bounds[1] < bounds[3];
}

/** Paths are content addressed and cannot escape either the cache or asset directory. */
export function validateCatalog(catalog) {
  if (catalog?.version !== 1 || typeof catalog.source !== 'string' || !Array.isArray(catalog.regions)) {
    throw new Error('Invalid basemap catalog.');
  }
  const keys = new Set();
  for (const [index, entry] of [catalog.overview, ...catalog.regions].entries()) {
    if (!entry || !/^[a-f0-9]{64}$/.test(entry.sha256) || entry.url !== `/basemaps/${entry.sha256}.pmtiles`
      || entry.blockBytes !== BLOCK_BYTES || entry.blockBase !== `/basemap-blocks/${entry.sha256}/`
      || !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0 || entry.bytes > MAX_ARCHIVE_BYTES
      || !validBounds(entry.bounds) || entry.minzoom !== (index === 0 ? 0 : 9) || entry.maxzoom !== (index === 0 ? 8 : 14)) {
      throw new Error('Invalid basemap archive entry.');
    }
    if (index > 0) {
      if (!/^\d+\/\d+\/\d+$/.test(entry.regionKey) || keys.has(entry.regionKey)) throw new Error('Invalid basemap region key.');
      const [z, x, y] = entry.regionKey.split('/').map(Number);
      if (entry.regionKey !== `${z}/${x}/${y}` || z < 8 || z > 14 || x >= 2 ** z || y >= 2 ** z
        || tileBounds(z, x, y).some((value, i) => Math.abs(value - entry.bounds[i]) > 1e-7)) {
        throw new Error('Basemap region bounds do not match its grid.');
      }
      keys.add(entry.regionKey);
    }
  }
  return catalog;
}

export function tileBounds(z, x, y) {
  if (![z, x, y].every(Number.isInteger) || z < 0 || z > 22 || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) {
    throw new Error('Invalid tile coordinates.');
  }
  const n = 2 ** z;
  const latitude = row => Math.atan(Math.sinh(Math.PI * (1 - 2 * row / n))) * 180 / Math.PI;
  return [x / n * 360 - 180, latitude(y + 1), (x + 1) / n * 360 - 180, latitude(y)];
}

export function gridForBounds(bounds, z = 8) {
  if (!validBounds(bounds) || !Number.isInteger(z) || z < 0 || z > 14) throw new Error('Invalid extraction bounds.');
  const n = 2 ** z;
  const column = lon => (lon + 180) / 360 * n;
  const row = lat => (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * n;
  // Snap floating-point roundoff at exact tile edges, then use half-open bounds.
  const snap = value => Math.abs(value - Math.round(value)) < 1e-9 ? Math.round(value) : value;
  const firstX = Math.max(0, Math.floor(snap(column(bounds[0]))));
  const lastX = Math.min(n - 1, Math.ceil(snap(column(bounds[2]))) - 1);
  const firstY = Math.max(0, Math.floor(snap(row(bounds[3]))));
  const lastY = Math.min(n - 1, Math.ceil(snap(row(bounds[1]))) - 1);
  const result = [];
  for (let y = firstY; y <= lastY; y++) for (let x = firstX; x <= lastX; x++) {
    result.push({ z, x, y, regionKey: `${z}/${x}/${y}`, bounds: tileBounds(z, x, y) });
  }
  return result;
}

async function digestFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function verified(path, entry) {
  try {
    return (await stat(path)).size === entry.bytes && await digestFile(path) === entry.sha256;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function parallel(items, concurrency, operation) {
  let next = 0;
  // Wait for other in-flight writes before reporting failure or removing staging.
  const results = await Promise.allSettled(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) await operation(items[next++]);
  }));
  const failed = results.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
}

async function downloadVerified(entry, path, { baseURL, fetchImpl }) {
  const response = await fetchImpl(new URL(entry.url, baseURL), { signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) throw new Error(`Cannot download basemap ${entry.sha256}: HTTP ${response.status}.`);
  const temporary = `${path}.${randomUUID()}.download`;
  let bytes = 0;
  const hash = createHash('sha256');
  try {
    const validator = new Transform({ transform(chunk, encoding, callback) {
      bytes += chunk.length;
      if (bytes > entry.bytes) return callback(new Error('Basemap download exceeds catalog size.'));
      hash.update(chunk);
      callback(null, chunk);
    } });
    await pipeline(Readable.fromWeb(response.body), validator, createWriteStream(temporary, { flags: 'wx' }));
    if (bytes !== entry.bytes || hash.digest('hex') !== entry.sha256) throw new Error('Basemap download checksum mismatch.');
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Static Assets ignore Range requests, so publish independently addressable blocks. */
async function writeBlocks(source, entry, outputDir) {
  const destination = join(resolve(outputDir), 'basemap-blocks', entry.sha256);
  await mkdir(destination, { recursive: true });
  const input = await open(source, 'r');
  const buffer = Buffer.alloc(BLOCK_BYTES);
  const hash = createHash('sha256');
  try {
    for (let offset = 0, index = 0; offset < entry.bytes; offset += BLOCK_BYTES, index++) {
      const length = Math.min(BLOCK_BYTES, entry.bytes - offset);
      let filled = 0;
      while (filled < length) {
        const { bytesRead } = await input.read(buffer, filled, length - filled, offset + filled);
        if (bytesRead === 0) throw new Error('Basemap archive ended before the catalog size.');
        filled += bytesRead;
      }
      const block = buffer.subarray(0, length);
      hash.update(block);
      await writeFile(join(destination, `${index}.bin`), block);
    }
    if (hash.digest('hex') !== entry.sha256) throw new Error('Basemap changed while splitting into blocks.');
  } finally { await input.close(); }
}

/** Normal builds use the committed catalog, never the expiring daily planet URL. */
export async function ensureBasemaps(outputDir, {
  catalog, cacheDir = CACHE, baseURL = 'https://l3.063.jp', fetchImpl = fetch, concurrency = 4,
} = {}) {
  catalog = validateCatalog(catalog ?? JSON.parse(await readFile(CATALOG, 'utf8')));
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('Invalid basemap concurrency.');
  await mkdir(cacheDir, { recursive: true });
  const destination = join(resolve(outputDir), 'basemaps');
  await mkdir(destination, { recursive: true });
  const entries = [...new Map([catalog.overview, ...catalog.regions].map(entry => [entry.sha256, entry])).values()];
  await parallel(entries, concurrency, async entry => {
    const filename = `${entry.sha256}.pmtiles`;
    const cached = join(cacheDir, filename);
    if (!await verified(cached, entry)) await downloadVerified(entry, cached, { baseURL, fetchImpl });
    if (resolve(cached) !== resolve(destination, filename)) await copyFile(cached, join(destination, filename), constants.COPYFILE_FICLONE);
    await writeBlocks(cached, entry, outputDir);
  });
  await writeFile(join(destination, 'catalog.json'), `${JSON.stringify(catalog)}\n`);
  return catalog;
}

function runCLI(executable, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let errors = '';
    child.stderr.on('data', chunk => { errors = `${errors}${chunk}`.slice(-8192); });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolvePromise() : reject(new Error(`pmtiles ${args[0]} failed (${code}): ${errors.trim()}`)));
  });
}

async function tileCount(path) {
  const file = await open(path, 'r');
  try {
    const header = Buffer.alloc(127);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    if (bytesRead !== 127 || header.toString('ascii', 0, 7) !== 'PMTiles' || header[7] !== 3) throw new Error('Invalid PMTiles v3 archive.');
    return header.readBigUInt64LE(72);
  } finally { await file.close(); }
}

/** Explicit dataset maintenance; never called by the application build. */
export async function prepareBasemaps({
  source = SOURCE, sourceFile, cacheDir = CACHE, catalogPath = CATALOG, pmtilesPath = 'pmtiles',
  concurrency = 4, regenerate = false, log = console.log,
} = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('Invalid basemap concurrency.');
  if (!regenerate) {
    let previous;
    try { previous = validateCatalog(JSON.parse(await readFile(catalogPath, 'utf8'))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (previous?.source === source) {
      let complete = true;
      await parallel([previous.overview, ...previous.regions], concurrency, async entry => {
        if (!await verified(join(cacheDir, `${entry.sha256}.pmtiles`), entry)) complete = false;
      });
      if (complete) { log(`Reused verified basemap catalog (${previous.regions.length} regions).`); return previous; }
    }
  }

  await mkdir(cacheDir, { recursive: true });
  const staging = await mkdtemp(join(cacheDir, '.extract-'));
  try {
    if (!sourceFile) {
      const sourceKey = createHash('sha256').update(source).digest('hex').slice(0, 16);
      sourceFile = join(ROOT, '.generated/basemaps-source', `${sourceKey}-japan-z14.pmtiles`);
      await mkdir(dirname(sourceFile), { recursive: true });
      try { await stat(sourceFile); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const partial = `${sourceFile}.download`;
        await rm(partial, { force: true });
        log(`Extracting Japan zooms 0–14 from ${source} (approximately 1.7 GB).`);
        try {
          await runCLI(pmtilesPath, ['extract', source, partial, '--bbox=122,20,154,46', '--minzoom=0', '--maxzoom=14', '--download-threads=4', '--quiet']);
          await runCLI(pmtilesPath, ['verify', partial]);
          await rename(partial, sourceFile);
        } finally { await rm(partial, { force: true }); }
      }
    }
    await runCLI(pmtilesPath, ['verify', sourceFile]);

    async function extract(bounds, minzoom, maxzoom) {
      const path = join(staging, `${randomUUID()}.pmtiles`);
      // A bbox lying exactly on tile edges otherwise includes its east/south neighbour.
      const inset = bounds.map((value, index) => value + (index < 2 ? 1e-8 : -1e-8));
      await runCLI(pmtilesPath, ['extract', sourceFile, path, `--bbox=${inset.join(',')}`, `--minzoom=${minzoom}`, `--maxzoom=${maxzoom}`, '--quiet']);
      return { path, bytes: (await stat(path)).size, count: await tileCount(path) };
    }

    async function store(extracted, fields) {
      await runCLI(pmtilesPath, ['verify', extracted.path]);
      const sha256 = await digestFile(extracted.path);
      await rename(extracted.path, join(cacheDir, `${sha256}.pmtiles`));
      return { url: `/basemaps/${sha256}.pmtiles`, bytes: extracted.bytes, sha256,
        blockBytes: BLOCK_BYTES, blockBase: `/basemap-blocks/${sha256}/`, ...fields };
    }

    const overviewFile = await extract(JAPAN, 0, 8);
    if (overviewFile.bytes > MAX_ARCHIVE_BYTES) throw new Error('Overview exceeds the static asset limit.');
    const overview = await store(overviewFile, { bounds: JAPAN, minzoom: 0, maxzoom: 8 });
    const regions = [];
    let completed = 0;
    const grid = gridForBounds(JAPAN);
    async function buildRegion(region) {
      const extracted = await extract(region.bounds, 9, 14);
      if (extracted.count === 0n) { await rm(extracted.path); return; }
      if (extracted.bytes > MAX_ARCHIVE_BYTES) {
        await rm(extracted.path);
        if (region.z >= 14) throw new Error(`A single tile exceeds the static asset limit: ${region.regionKey}`);
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
          const z = region.z + 1, x = region.x * 2 + dx, y = region.y * 2 + dy;
          await buildRegion({ z, x, y, bounds: tileBounds(z, x, y), regionKey: `${z}/${x}/${y}` });
        }
        return;
      }
      regions.push(await store(extracted, { bounds: region.bounds, minzoom: 9, maxzoom: 14, regionKey: region.regionKey }));
    }
    await parallel(grid, concurrency, async region => {
      await buildRegion(region);
      completed++;
      if (completed % 25 === 0 || completed === grid.length) log(`Prepared ${completed}/${grid.length} grid cells (${regions.length} archives).`);
    });
    regions.sort((a, b) => a.regionKey.localeCompare(b.regionKey, 'en', { numeric: true }));
    const catalog = validateCatalog({ version: 1, source, overview, regions });
    await mkdir(dirname(catalogPath), { recursive: true });
    const temporaryCatalog = `${catalogPath}.${randomUUID()}.tmp`;
    await writeFile(temporaryCatalog, `${JSON.stringify(catalog, null, 2)}\n`);
    await rename(temporaryCatalog, catalogPath);
    const total = [overview, ...regions].reduce((sum, entry) => sum + entry.bytes, 0);
    log(`Prepared ${regions.length} regions + overview, ${(total / 1024 ** 3).toFixed(2)} GiB.`);
    return catalog;
  } finally { await rm(staging, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: {
      source: { type: 'string', default: SOURCE }, input: { type: 'string' },
      pmtiles: { type: 'string', default: 'pmtiles' }, concurrency: { type: 'string', default: '4' },
      regenerate: { type: 'boolean', default: false },
    } });
    await prepareBasemaps({ source: values.source, sourceFile: values.input, pmtilesPath: values.pmtiles,
      concurrency: Number(values.concurrency), regenerate: values.regenerate });
  } catch (error) {
    console.error(`Failed to prepare basemaps: ${error.message}`);
    process.exitCode = 1;
  }
}
