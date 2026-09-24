/** Split geographic bounds into rectangles in the canonical longitude range. */
function rectangles(bounds) {
  if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(Number.isFinite)) return [];
  const [west, south, east, north] = bounds;
  if (south > north || south < -90 || north > 90) return [];
  const difference = east - west;
  if (Math.abs(difference) >= 360) return [[-180, south, 180, north]];
  const width = difference < 0 ? difference + 360 : difference;
  const left = west >= -180 && west < 180 ? west : west - Math.floor((west + 180) / 360) * 360;
  const right = left + width;
  if (right > 180) return [[left, south, 180, north], [-180, south, right - 360, north]];
  const result = [[left, south, right, north]];
  // The date line is the same boundary at +180 and -180, including point views.
  if (right === 180) result.push([-180, south, -180, north]);
  return result;
}

function latitudeCovered(south, north, intervals) {
  intervals.sort((a, b) => a[0] - b[0]);
  let covered = south;
  for (const [start, end] of intervals) {
    if (start > covered) return false;
    covered = Math.max(covered, end);
    if (covered >= north) return true;
  }
  return false;
}

function rectangleCovered(view, archives) {
  const [west, south, east, north] = view;
  const clipped = archives.map(bounds => [
    Math.max(west, bounds[0]), Math.max(south, bounds[1]),
    Math.min(east, bounds[2]), Math.min(north, bounds[3]),
  ]).filter(bounds => bounds[0] <= bounds[2] && bounds[1] <= bounds[3]);
  if (!clipped.length) return false;
  const edges = [...new Set([west, east, ...clipped.flatMap(bounds => [bounds[0], bounds[2]])])].sort((a, b) => a - b);
  if (edges.length === 1) edges.push(edges[0]);
  // Between consecutive vertical edges, the set of covering rectangles is fixed.
  for (let i = 1; i < edges.length; i++) {
    const intervals = clipped.filter(bounds => bounds[0] <= edges[i - 1] && bounds[2] >= edges[i])
      .map(bounds => [bounds[1], bounds[3]]);
    if (!latitudeCovered(south, north, intervals)) return false;
  }
  return true;
}

/** True only when the union of saved [west, south, east, north] bounds covers the view. */
export function boundsCovered(bounds, archivesBounds) {
  const views = rectangles(bounds);
  if (!views.length || !Array.isArray(archivesBounds)) return false;
  const archives = archivesBounds.flatMap(rectangles);
  return views.every(view => rectangleCovered(view, archives));
}

/** Show only saved detail archives; a pack's viewport is not its saved boundary. */
export function savedCoverageFeatures(packs) {
  const features = new Map();
  for (const pack of packs ?? []) {
    for (const archive of pack.archives ?? []) {
      if (!archive?.regionKey || archive.overview) continue;
      for (const bounds of rectangles(archive.bounds)) {
        const [west, south, east, north] = bounds;
        if (west === east || south === north) continue;
        const key = bounds.join(',');
        if (features.has(key)) continue;
        features.set(key, {
          type: 'Feature',
          properties: { regionKey: archive.regionKey },
          geometry: {
            type: 'Polygon',
            coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]],
          },
        });
      }
    }
  }
  return { type: 'FeatureCollection', features: [...features.values()] };
}
