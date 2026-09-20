const RAIL_COLOR = '#16755e';
const STATION_COLOR = '#d89549';

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

export function createRailwayMap(element, initialView, onMove) {
  const L = window.L;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const map = L.map(element, {
    zoomControl: false,
    preferCanvas: true,
    renderer: L.canvas({ padding: 0.3, tolerance: 7 }),
    minZoom: 3,
    maxZoom: 18,
    worldCopyJump: true,
    fadeAnimation: !reducedMotion,
    zoomAnimation: !reducedMotion,
    markerZoomAnimation: !reducedMotion,
  }).setView([initialView.lat, initialView.lng], initialView.zoom);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> | <a href="https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N05-2024.html" target="_blank" rel="noopener">国土数値情報 N05-24</a>',
  }).addTo(map);

  let layers = {};
  let selection;
  let selectionKind;
  let locationMarker;
  let renderGeneration = 0;
  let visibility = { railroads: true, stations: true };

  map.on('moveend', () => onMove(getView()));

  function getView() {
    const center = map.getCenter().wrap();
    return { lat: center.lat, lng: center.lng, zoom: map.getZoom() };
  }

  function createLayer(kind) {
    return L.geoJSON(null, {
      style: kind === 'railroad' ? { color: RAIL_COLOR, weight: 2, opacity: 0.85 } : undefined,
      pointToLayer: (_feature, latlng) => L.circleMarker(latlng, {
        radius: stationRadius(),
        color: '#fff',
        weight: map.getZoom() < 6 ? 0 : 0.7,
        fillColor: STATION_COLOR,
        fillOpacity: 1,
      }),
      onEachFeature: (feature, layer) => layer.bindPopup(() => popup(feature, kind), { maxWidth: 270 }),
    });
  }

  function stationRadius() {
    return map.getZoom() < 6 ? 0.8 : map.getZoom() < 8 ? 1.6 : map.getZoom() < 11 ? 2.7 : 4.5;
  }

  map.on('zoomend', () => {
    layers.stations?.eachLayer(layer => {
      layer.setRadius?.(stationRadius());
      layer.setStyle({ weight: map.getZoom() < 6 ? 0 : 0.7 });
    });
  });

  async function setData(data, signal) {
    const generation = ++renderGeneration;
    const next = { railroads: createLayer('railroad'), stations: createLayer('station') };
    // Build off-map in small batches so the timeline remains responsive on phones.
    for (const key of ['railroads', 'stations']) {
      const features = data[key].features;
      for (let i = 0; i < features.length; i += 600) {
        if (signal.aborted || generation !== renderGeneration) {
          throw new DOMException('Aborted', 'AbortError');
        }
        next[key].addData(features.slice(i, i + 600));
        await new Promise(requestAnimationFrame);
      }
    }
    if (signal.aborted || generation !== renderGeneration) {
      throw new DOMException('Aborted', 'AbortError');
    }
    if (selection) map.removeLayer(selection);
    map.closePopup();
    Object.values(layers).forEach(layer => map.removeLayer(layer));
    layers = next;
    setVisibility(visibility);
  }

  function setVisibility(next) {
    visibility = { ...next };
    for (const key of ['railroads', 'stations']) {
      if (!layers[key]) continue;
      if (visibility[key]) layers[key].addTo(map);
      else map.removeLayer(layers[key]);
    }
    if (selection && !visibility[selectionKind === 'station' ? 'stations' : 'railroads']) {
      map.removeLayer(selection);
      map.closePopup();
      selection = undefined;
    }
  }

  function focusResult(result) {
    if (selection) map.removeLayer(selection);
    selectionKind = result.kind;
    selection = L.geoJSON(result.feature, {
      style: { color: '#de8b38', weight: 6, opacity: 1 },
      pointToLayer: (_feature, latlng) => L.circleMarker(latlng, {
        radius: 8, color: '#fff', weight: 3, fillColor: '#de8b38', fillOpacity: 1,
      }),
    }).addTo(map);
    const bounds = selection.getBounds();
    if (!bounds.isValid()) return;
    map.fitBounds(bounds, { padding: [45, 65], maxZoom: result.kind === 'station' ? 15 : 12, animate: false });
    L.popup({ maxWidth: 270 }).setLatLng(bounds.getCenter()).setContent(popup(result.feature, result.kind)).openOn(map);
  }

  const resizeObserver = new ResizeObserver(() => map.invalidateSize({ pan: true, animate: false, debounceMoveend: true }));
  resizeObserver.observe(element);

  return {
    getView,
    setData,
    setVisibility,
    focusResult,
    zoomIn: () => map.zoomIn(),
    zoomOut: () => map.zoomOut(),
    resetView: () => map.fitBounds([[26, 127], [45.7, 146]], { padding: [25, 40], animate: false }),
    showLocation(lat, lng) {
      if (locationMarker) map.removeLayer(locationMarker);
      locationMarker = L.circleMarker([lat, lng], {
        radius: 8, color: '#fff', weight: 3, fillColor: '#3686cc', fillOpacity: 1,
      }).addTo(map).bindTooltip('現在地');
      map.setView([lat, lng], 13, { animate: false });
    },
  };
}
