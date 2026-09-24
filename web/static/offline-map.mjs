import { savedCoverageFeatures } from './offline-coverage.mjs';

const SOURCE = 'saved-map-coverage';
const LAYERS = ['saved-map-fill', 'saved-map-boundary'];

/** A visual overlay below railway layers, excluded from map feature picking. */
export function createSavedCoverageLayer(map, ready, beforeLayer) {
  let data = savedCoverageFeatures([]);
  let visible = false;
  let initialized = false;
  const visibility = () => visible ? 'visible' : 'none';

  ready.then(() => {
    map.addSource(SOURCE, { type: 'geojson', data });
    map.addLayer({
      id: LAYERS[0], type: 'fill', source: SOURCE,
      layout: { visibility: visibility() },
      paint: { 'fill-color': '#446ba3', 'fill-opacity': 0.07 },
    }, beforeLayer);
    map.addLayer({
      id: LAYERS[1], type: 'line', source: SOURCE,
      layout: { visibility: visibility() },
      paint: { 'line-color': '#446ba3', 'line-width': 1.5, 'line-opacity': 0.8, 'line-dasharray': [3, 2] },
    }, beforeLayer);
    initialized = true;
  });

  return (packs, show) => {
    data = savedCoverageFeatures(packs);
    visible = Boolean(show);
    if (!initialized) return;
    map.getSource(SOURCE).setData(data);
    for (const layer of LAYERS) map.setLayoutProperty(layer, 'visibility', visibility());
  };
}
