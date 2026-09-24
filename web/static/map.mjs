import { createBasemapStyle, registerBasemapProtocol } from './basemap.mjs';
import { featureBounds, nearestPointFeature } from './map-geometry.mjs';

const RAIL_COLOR = '#16755e';
const STATION_COLOR = '#d89549';
const EMPTY = { type: 'FeatureCollection', features: [] };
const RAIL_LAYER = 'railway-lines';
const STATION_LAYER = 'railway-stations';
const STATION_LABEL_LAYER = 'railway-station-names';
const SELECTED_LAYERS = ['selected-line', 'selected-point'];
const STATION_HIT_RADIUS = 22;
const STATION_RADII = [[4, 0.7], [6, 1.2], [8, 2], [11, 4], [13, 6], [15, 9], [17, 12]];
const stationRadius = (extra = 0) => ['interpolate', ['linear'], ['zoom'],
  ...STATION_RADII.flatMap(([zoom, radius]) => [zoom, radius + extra])];

function popup(feature, kind) {
  const props = feature.properties ?? {};
  const container = document.createElement('div');
  container.className = 'rail-popup';
  const label = document.createElement('span');
  label.className = 'popup-kind';
  label.textContent = kind === 'station' ? 'STATION / 駅' : 'RAILWAY / 鉄道路線';
  const title = document.createElement('strong');
  title.textContent = (kind === 'station' ? props.N05_011 : props.N05_002) || '名称不明';
  container.append(label, title);
  const detail = document.createElement('p');
  detail.textContent = [kind === 'station' ? props.N05_002 : '', props.N05_003].filter(Boolean).join(' · ');
  container.append(detail);
  const opened = String(props.N05_004 ?? '');
  if (/^\d{4}$/.test(opened) && Number(opened) < 9000) {
    const year = document.createElement('p');
    year.textContent = `${opened}年 開業`;
    container.append(year);
  }
  return container;
}

function abortError() {
  return new DOMException('Aborted', 'AbortError');
}

function withAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(abortError()); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

export function createRailwayMap(element, initialView, onMove) {
  const gl = window.maplibregl;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  registerBasemapProtocol();
  const map = new gl.Map({
    container: element,
    style: createBasemapStyle(),
    center: [initialView.lng, initialView.lat],
    zoom: initialView.zoom,
    minZoom: 3,
    maxZoom: 18,
    maxPitch: 0,
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    keyboard: true,
    attributionControl: false,
    fadeDuration: reducedMotion ? 0 : 150,
    locale: {
      'Map.Title': '鉄道の時間地図',
      'AttributionControl.ToggleAttribution': '地図の出典を表示',
      'Popup.Close': '閉じる',
    },
  });
  map.touchZoomRotate.disableRotation();
  map.keyboard.disableRotation();
  map.addControl(new gl.AttributionControl({
    compact: true,
    customAttribution: '<a href="https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N05-2024.html" target="_blank" rel="noopener">国土数値情報 N05-24</a>',
  }), 'bottom-left');
  map.getCanvas().setAttribute('aria-label', '鉄道の時間地図。矢印キーで移動、プラス・マイナスキーで拡大縮小できます');

  let activePopup;
  let selectionKind;
  let selectionGeneration = 0;
  let renderGeneration = 0;
  let visibility = { railroads: true, stations: true };
  let layersReady = false;

  // style.load does not wait for background tiles, so saved railway data can
  // still be displayed when the selected background area is unavailable.
  const ready = new Promise(resolve => map.once('style.load', () => {
    for (const id of ['railroads', 'stations', 'selection', 'location']) {
      map.addSource(id, { type: 'geojson', data: EMPTY, maxzoom: 16 });
    }
    map.addLayer({
      id: RAIL_LAYER, type: 'line', source: 'railroads',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': RAIL_COLOR,
        'line-width': ['interpolate', ['linear'], ['zoom'], 4, 1.4, 10, 2.3, 16, 3.5],
        'line-opacity': 0.9,
      },
    });
    map.addLayer({
      id: STATION_LAYER, type: 'circle', source: 'stations',
      paint: {
        'circle-radius': stationRadius(),
        'circle-color': STATION_COLOR,
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': ['step', ['zoom'], 0, 6, 0.7, 12, 1.5],
      },
    });
    map.addLayer({
      id: STATION_LABEL_LAYER, type: 'symbol', source: 'stations', minzoom: 11,
      filter: ['!=', ['coalesce', ['get', 'N05_011'], ''], ''],
      layout: {
        'text-field': ['get', 'N05_011'],
        'text-font': ['Noto Sans CJK JP', 'Hiragino Kaku Gothic ProN', 'Meiryo', 'sans-serif'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 11, 12, 16, 15],
        'text-variable-anchor': ['top', 'bottom', 'left', 'right'],
        'text-radial-offset': 1.3,
        'text-padding': 4,
        'text-max-width': 10,
        'text-allow-overlap': false,
      },
      paint: { 'text-color': '#634526', 'text-halo-color': '#ffffff', 'text-halo-width': 2 },
    });
    map.addLayer({
      id: SELECTED_LAYERS[0], type: 'line', source: 'selection',
      filter: ['==', ['geometry-type'], 'LineString'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#de8b38', 'line-width': 6 },
    });
    map.addLayer({
      id: SELECTED_LAYERS[1], type: 'circle', source: 'selection',
      filter: ['==', ['geometry-type'], 'Point'],
      paint: { 'circle-radius': stationRadius(3), 'circle-color': '#de8b38', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 3 },
    });
    map.addLayer({
      id: 'current-location', type: 'circle', source: 'location',
      paint: { 'circle-radius': 8, 'circle-color': '#3686cc', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 3 },
    });
    layersReady = true;
    setVisibility(visibility);
    resolve();
  }));

  map.on('moveend', () => onMove(getView()));

  function getView() {
    const center = map.getCenter().wrap();
    return { lat: center.lat, lng: center.lng, zoom: Math.round(map.getZoom()) };
  }

  function getBounds() {
    const bounds = map.getBounds();
    return [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
  }

  function clearSelection() {
    selectionGeneration++;
    selectionKind = undefined;
    activePopup?.remove();
    activePopup = undefined;
    if (layersReady) map.getSource('selection').setData(EMPTY);
  }

  async function setData(data, signal) {
    const generation = ++renderGeneration;
    await withAbort(ready, signal);
    if (signal?.aborted || generation !== renderGeneration) throw abortError();
    clearSelection();
    // MapLibre prepares the GeoJSON in its workers. Both updates are submitted
    // together, and a later generation always supersedes earlier source data.
    const updates = ['railroads', 'stations'].map(key => map.getSource(key).setData(data[key]));
    await withAbort(Promise.all(updates), signal);
    if (signal?.aborted || generation !== renderGeneration) throw abortError();
  }

  function setVisibility(next) {
    visibility = { railroads: next.railroads !== false, stations: next.stations !== false };
    if (!layersReady) return;
    map.setLayoutProperty(RAIL_LAYER, 'visibility', visibility.railroads ? 'visible' : 'none');
    map.setLayoutProperty(STATION_LAYER, 'visibility', visibility.stations ? 'visible' : 'none');
    map.setLayoutProperty(STATION_LABEL_LAYER, 'visibility', visibility.stations ? 'visible' : 'none');
    if (selectionKind && !visibility[selectionKind === 'station' ? 'stations' : 'railroads']) clearSelection();
  }

  function showPopup(feature, kind, coordinates) {
    activePopup?.remove();
    activePopup = new gl.Popup({ maxWidth: '270px', offset: kind === 'station' ? 18 : 4 })
      .setLngLat(coordinates)
      .setDOMContent(popup(feature, kind))
      .addTo(map);
  }

  function focusResult(result) {
    const bounds = featureBounds(result.feature);
    if (!bounds) return;
    const generation = ++selectionGeneration;
    selectionKind = result.kind;
    fitBounds(bounds, result.kind === 'station' ? 15 : 12);
    ready.then(() => {
      if (generation !== selectionGeneration) return;
      map.getSource('selection').setData(result.feature);
      showPopup(result.feature, result.kind, [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2]);
    });
  }

  function featureAt(point) {
    if (!layersReady) return undefined;
    const box = radius => [[point.x - radius, point.y - radius], [point.x + radius, point.y + radius]];
    if (visibility.stations) {
      const labels = map.queryRenderedFeatures(point, { layers: [STATION_LABEL_LAYER] });
      const label = nearestPointFeature(labels, point, Infinity,
        coordinates => map.project(coordinates), map.getCenter().lng);
      if (label) return { ...label, kind: 'station' };
      const stations = map.queryRenderedFeatures(box(STATION_HIT_RADIUS), { layers: [STATION_LAYER] });
      const nearest = nearestPointFeature(stations, point, STATION_HIT_RADIUS,
        coordinates => map.project(coordinates), map.getCenter().lng);
      if (nearest) return { ...nearest, kind: 'station' };
    }
    if (visibility.railroads) {
      const [feature] = map.queryRenderedFeatures(box(8), { layers: [RAIL_LAYER] });
      if (feature) return { feature, kind: 'railroad' };
    }
  }

  map.on('click', event => {
    const hit = featureAt(event.point);
    if (!hit) return;
    const { feature, kind, coordinates } = hit;
    clearSelection();
    selectionKind = kind;
    showPopup(feature, kind, coordinates ?? event.lngLat);
  });
  if (window.matchMedia('(hover: hover)').matches) {
    map.on('mousemove', event => { map.getCanvas().style.cursor = featureAt(event.point) ? 'pointer' : ''; });
  }

  function fitBounds(bounds, maxZoom = 15) {
    map.fitBounds([[bounds[0], bounds[1]], [bounds[2], bounds[3]]], {
      padding: { top: 65, right: 45, bottom: 45, left: 45 }, maxZoom, duration: 0,
    });
  }

  const resizeObserver = new ResizeObserver(() => map.resize());
  resizeObserver.observe(element);

  return {
    getView,
    getBounds,
    fitBounds,
    setData,
    setVisibility,
    focusResult,
    zoomIn: () => map.zoomIn({ duration: reducedMotion ? 0 : 200 }),
    zoomOut: () => map.zoomOut({ duration: reducedMotion ? 0 : 200 }),
    resetView: () => map.fitBounds([[127, 26], [146, 45.7]], { padding: 30, duration: 0 }),
    showLocation(lat, lng) {
      const feature = { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [lng, lat] } };
      ready.then(() => map.getSource('location').setData(feature));
      map.jumpTo({ center: [lng, lat], zoom: 13 });
    },
    refreshBasemap() {
      if (!layersReady) return;
      const source = map.getSource('basemap');
      const specification = source?.serialize();
      if (specification?.tiles) source.setTiles(specification.tiles);
    },
    destroy() {
      resizeObserver.disconnect();
      map.remove();
    },
  };
}
