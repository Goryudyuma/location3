/** Bounds for Point/MultiPoint, lines, polygons and nested geometry collections. */
export function featureBounds(feature) {
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  function coordinates(values) {
    if (!Array.isArray(values)) return;
    if (typeof values[0] === 'number') {
      const [lng, lat] = values;
      if (!Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lng) > 180 || Math.abs(lat) > 90) return;
      bounds[0] = Math.min(bounds[0], lng);
      bounds[1] = Math.min(bounds[1], lat);
      bounds[2] = Math.max(bounds[2], lng);
      bounds[3] = Math.max(bounds[3], lat);
    } else {
      values.forEach(coordinates);
    }
  }
  function geometry(value) {
    if (!value) return;
    if (value.type === 'GeometryCollection') value.geometries?.forEach(geometry);
    else coordinates(value.coordinates);
  }
  geometry(feature?.geometry);
  return bounds.every(Number.isFinite) ? bounds : null;
}
