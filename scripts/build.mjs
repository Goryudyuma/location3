import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { build } from 'esbuild';
import { prepareData } from './prepare-data.mjs';
import { ensureBasemaps } from './prepare-basemap.mjs';

const outputDir = resolve('.generated/assets');
const result = await prepareData({ inputDir: 'N05-24_GML/UTF-8', staticDir: 'web/static', outputDir });
await ensureBasemaps(outputDir);
const vendor = join(outputDir, 'vendor');
await mkdir(vendor, { recursive: true });
for (const filename of ['maplibre-gl.mjs', 'maplibre-gl-shared.mjs', 'maplibre-gl-worker.mjs', 'maplibre-gl.css']) {
  await cp(resolve('node_modules/maplibre-gl/dist', filename), join(vendor, filename));
}
await build({ entryPoints: ['node_modules/pmtiles/dist/esm/index.js'], outfile: join(vendor, 'pmtiles.mjs'), bundle: true, format: 'esm', minify: true, target: 'es2022' });
await cp(resolve('node_modules/maplibre-gl/LICENSE.txt'), join(vendor, 'maplibre-gl-LICENSE.txt'));
await cp(resolve('third-party/pmtiles-LICENSE.txt'), join(vendor, 'pmtiles-LICENSE.txt'));
const require = createRequire(import.meta.url);
const fflate = require.resolve('fflate', { paths: [require.resolve('pmtiles')] });
await cp(resolve(dirname(fflate), '../LICENSE'), join(vendor, 'fflate-LICENSE.txt'));

// Only the application shell is installed automatically, never national map data.
const files = (await readdir(outputDir)).filter(name => /\.(?:html|css|mjs|svg|webmanifest)$/.test(name) && name !== 'service-worker.mjs').map(name => `/${name}`);
files.push(...(await readdir(vendor)).map(name => `/vendor/${name}`));
files.sort();
const hash = createHash('sha256');
const hashes = {};
for (const file of files) {
  const body = await readFile(join(outputDir, file));
  hash.update(file); hash.update(body);
  hashes[file] = createHash('sha256').update(body).digest('hex');
}
const template = await readFile(join(outputDir, 'service-worker.mjs'), 'utf8');
hash.update(template);
const version = hash.digest('hex').slice(0, 16);
await writeFile(join(outputDir, 'service-worker.mjs'), template.replace('__SHELL_VERSION__', version).replace('__SHELL_FILES__', JSON.stringify(files)).replace('__SHELL_HASHES__', JSON.stringify(hashes)));
console.log(`Built ${result.files} railway assets and ${files.length} offline shell files (${version}).`);
