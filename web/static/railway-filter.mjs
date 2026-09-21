/** Dataset sentinel values represent unknown boundaries, not calendar years. */
export function parseYear(value) {
  if (typeof value === 'string') {
    if (!/^[+-]?\d+$/.test(value.trim())) return null;
    value = Number(value.trim());
  }
  return Number.isInteger(value) && value > 0 && value < 9000 && value !== 999 ? value : null;
}

function active(feature, year) {
  const start = parseYear(feature.properties?.N05_005b);
  const end = parseYear(feature.properties?.N05_005e);
  return (start === null || year >= start) && (end === null || year <= end);
}

function lineName(feature) {
  const name = feature.properties?.N05_002;
  return typeof name === 'string' ? name.trim() : '';
}

/**
 * Share the Go API's inclusive year bounds and station line membership rule.
 * Geometry and feature objects are reused; source collections are never changed.
 */
export function filterCollections(collections, year) {
  if (year === null) return collections;
  const railroads = collections.railroads.features.filter(feature => active(feature, year));
  const names = new Set(railroads.map(lineName).filter(Boolean));
  const stations = collections.stations.features.filter(feature => active(feature, year) && names.has(lineName(feature)));
  return {
    railroads: { ...collections.railroads, features: railroads },
    stations: { ...collections.stations, features: stations },
  };
}

/** Every calendar year within one interval has exactly the same active features. */
export function periodStarts(collections) {
  const starts = new Set([1]);
  for (const collection of Object.values(collections)) {
    for (const feature of collection.features) {
      const start = parseYear(feature.properties?.N05_005b);
      const end = parseYear(feature.properties?.N05_005e);
      if (start !== null) starts.add(start);
      if (end !== null) starts.add(end + 1);
    }
  }
  return [...starts].sort((a, b) => a - b);
}
