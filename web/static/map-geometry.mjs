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

/** Pick the closest point within a screen-space radius, including wrapped maps. */
export function nearestPointFeature(features, point, radius, project, centerLongitude = 0) {
  let nearest;
  let shortestSquared = radius * radius;
  for (const feature of features) {
    if (feature.geometry?.type !== 'Point') continue;
    const [lng, lat] = feature.geometry.coordinates;
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
    const coordinates = [lng + 360 * Math.round((centerLongitude - lng) / 360), lat];
    const screen = project(coordinates);
    const distanceSquared = (screen.x - point.x) ** 2 + (screen.y - point.y) ** 2;
    if (distanceSquared > shortestSquared || (nearest && distanceSquared === shortestSquared)) continue;
    shortestSquared = distanceSquared;
    nearest = { feature, coordinates };
  }
  return nearest;
}
