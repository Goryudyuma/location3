const fields = ['N05_011', 'N05_002', 'N05_003', 'N05_004', 'N05_005b', 'N05_005e'];
const key = feature => JSON.stringify(fields.map(field => String(feature.properties?.[field] ?? '')));
const longitudeDifference = (a, b) => ((a - b + 180) % 360 + 360) % 360 - 180;
const isPoint = feature => feature?.geometry?.type === 'Point'
  && feature.geometry.coordinates.slice(0, 2).length === 2
  && feature.geometry.coordinates.slice(0, 2).every(Number.isFinite);

/** Use original coordinates, not the quantized coordinates of rendered tiles. */
export function stationChoices(feature, stations) {
  if (!isPoint(feature)) return [];
  const identity = key(feature);
  const [lng, lat] = feature.geometry.coordinates;
  let original = feature;
  let distance = Infinity;
  for (const candidate of stations) {
    if (!isPoint(candidate) || key(candidate) !== identity) continue;
    const [x, y] = candidate.geometry.coordinates;
    const next = longitudeDifference(x, lng) ** 2 + (y - lat) ** 2;
    if (next < distance) { original = candidate; distance = next; }
  }
  const [x, y] = original.geometry.coordinates;
  const seen = new Set();
  return [original, ...stations].filter(candidate => {
    if (!isPoint(candidate)) return false;
    const [a, b] = candidate.geometry.coordinates;
    if (Math.abs(longitudeDifference(a, x)) > 0.00001 || Math.abs(b - y) > 0.00001) return false;
    const id = key(candidate);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}
