import * as maplibregl from '/vendor/maplibre-gl.mjs';
import * as pmtiles from '/vendor/pmtiles.mjs';

// Both the renderer and its module worker are served and cached on this origin.
maplibregl.setWorkerUrl('/vendor/maplibre-gl-worker.mjs');
window.maplibregl = maplibregl;
window.pmtiles = pmtiles;
