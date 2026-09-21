# Offline basemap assets

The application hosts extracts of the free [Protomaps basemap](https://docs.protomaps.com/basemaps/downloads), derived from OpenStreetMap. These vector tiles can be saved on the device for offline use. They do not use the public OpenStreetMap raster tile service.

`catalog.json` is committed. The binary archives live in the ignored `.generated/basemaps/` directory. The normal application build calls `ensureBasemaps(outputDir)` from `scripts/prepare-basemap.mjs`; it verifies the local cache, fetches missing or corrupt files from `https://l3.063.jp/basemaps/<sha256>.pmtiles`, verifies their size and SHA-256, and copies them into the deployable assets. It also splits each archive into **256 KiB blocks** for online browsing. The build never queries the upstream daily planet archive.

## Current snapshot

- Source: `https://build.protomaps.com/20260920.pmtiles`.
- Protomaps basemap schema/build version: **4.15.2**.
- Extractor: [`protomaps/go-pmtiles` v1.31.2](https://github.com/protomaps/go-pmtiles/releases/tag/v1.31.2).
- Extraction bounds: longitude **122–154**, latitude **20–46**. This rectangle includes Japan and some neighbouring territories; it is not a national boundary polygon.
- Overview: zoom **0–8**, 13,886,594 bytes.
- Detail: zoom **9–14**, initially grouped by zoom-8 tiles. Regions larger than **24 MiB** are recursively divided into four child regions. This snapshot uses 531 zoom-8 regions, 79 zoom-9 regions, and 20 zoom-10 regions.
- Total: **631 archives**, **1,764,412,096 bytes** (1.64 GiB). Largest archive: **24,515,087 bytes** (23.38 MiB), below Cloudflare's 25 MiB per-file limit.
- Online delivery: **7,224 blocks**, containing the same 1,764,412,096 bytes. Archives and blocks together use **7,855 map assets** and 3.29 GiB.

Detail archives retain zoom 9 even when their region is a zoom-10 cell. Such neighbouring archives contain duplicate zoom-9 tiles. The browser must select one deterministic representative archive for a requested tile. Region boundaries describe the tile grid; they are not clipping polygons. PMTiles extraction keeps entire intersecting vector tiles.

The manifest records each archive's same-origin URL, byte size, SHA-256, geographic bounds, zoom range, and (for detail) region key. `blockBytes` is always 262144 and `blockBase` is `/basemap-blocks/<sha256>/`. Online block URLs are `<blockBase>0.bin`, `<blockBase>1.bin`, etc.; block `i` contains archive bytes `[i * blockBytes, min((i + 1) * blockBytes, bytes))`. Only the last block may be shorter, and an exactly divisible archive has no extra empty block. Concatenating the blocks reproduces the complete PMTiles file and its SHA-256.

All archives are checked by `pmtiles verify` before their catalog is published. Block generation verifies the complete archive hash again while splitting. URLs are content addressed, so an updated snapshot produces new URLs and existing device downloads remain tied to their saved catalog. Complete archives and their blocks contain identical data, adding another 1.64 GiB to the deployment; block assets are generated during every application build and are not committed.

## Reproduce or update the extracts

1. Download the `pmtiles` executable for your operating system from the official release page above. Verify the release archive against its published SHA-256. No Java or map build server is needed.
2. Run the explicit data-preparation command from the repository root:

   ```sh
   node scripts/prepare-basemap.mjs --pmtiles /path/to/pmtiles
   ```

   A fully verified existing cache is reused, without executing `pmtiles`. Otherwise the command first extracts the Japan rectangle, zooms 0–14, into `.generated/basemaps-source/`. This intermediate download is approximately 1.7 GB. It then extracts the small archives locally with four concurrent processes and writes the catalog only after every extraction succeeds. Allow space for the intermediate file, the archive cache, and the deployable asset directory. The original railway datasets are untouched.

3. To use an already downloaded Japan source, provide its path:

   ```sh
   node scripts/prepare-basemap.mjs \
     --pmtiles /path/to/pmtiles \
     --input .generated/basemaps-source/20260920-japan-z14.pmtiles
   ```

4. To update to a newer snapshot, find its exact URL in the [official build list](https://maps.protomaps.com/builds/), then pass it explicitly:

   ```sh
   node scripts/prepare-basemap.mjs \
     --pmtiles /path/to/pmtiles \
     --source https://build.protomaps.com/YYYYMMDD.pmtiles
   ```

   `--regenerate` forces extraction even when the selected source is already fully cached. `--concurrency 2` reduces local extraction parallelism. Review the new catalog, test the map, update this snapshot description, and deploy the matching archives together with the application.

The upstream service retains only a limited build history. Keep the generated cache or an archival copy when long-term reproduction of an older catalog is required. The production fallback supports fresh checkouts of the currently deployed catalog; a later deployment need not retain files referenced only by an old catalog. The very first deployment therefore requires the generated local cache.

## Attribution and hosting

Keep visible **© OpenStreetMap contributors** attribution linked to [OpenStreetMap copyright](https://www.openstreetmap.org/copyright), with **Protomaps** attribution linked to [protomaps.com](https://protomaps.com). Protomaps distributes this basemap as an ODbL Produced Work; consult the [official basemap documentation](https://docs.protomaps.com/basemaps/downloads) when changing the distribution or underlying data. Application code and style licensing are separate from the basemap data.

Serve both archives and blocks directly through Workers Static Assets. The deployed Static Assets service returned full `200` responses to `Range` requests during verification, so online rendering uses block URLs and slices the requested bytes in the browser. It does not rely on HTTP byte-range support or download a whole regional archive for its header. Complete PMTiles files are used for explicit offline saves. Do not buffer or decode map data in a Worker. [Static asset storage has no additional cost and asset requests are free and unlimited](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/); each file must remain below the [25 MiB platform limit](https://developers.cloudflare.com/workers/platform/limits/). The browser should download only archives intersecting the user's selected region, together with the overview, application assets, styles/fonts, and railway data needed for offline operation.

Run the build/cache regression tests with:

```sh
node --test tests/basemap-build.test.mjs
```
