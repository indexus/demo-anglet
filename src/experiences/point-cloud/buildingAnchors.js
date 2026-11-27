import { insidePolygon } from "./geometry.js";
import { spatialIndex } from "./spatialIndex.js";
export function ringBounds(ring) {
  return [
    Math.min(...ring.map((p) => p[0])),
    Math.min(...ring.map((p) => p[1])),
    Math.max(...ring.map((p) => p[0])),
    Math.max(...ring.map((p) => p[1])),
  ];
}
function edgeDistance(p, ring) {
  let nearest = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i],
      b = ring[(i + 1) % ring.length],
      dx = b[0] - a[0],
      dy = b[1] - a[1],
      t = Math.max(
        0,
        Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)),
      );
    nearest = Math.min(nearest, Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy));
  }
  return nearest;
}
export function buildingRoofPoint(polygon) {
  const box = ringBounds(polygon[0]),
    cx = (box[0] + box[2]) / 2,
    cy = (box[1] + box[3]) / 2;
  if (insidePolygon([cx, cy], polygon)) return [cx, cy];
  let best = null,
    distance = Infinity;
  for (let i = 1; i < 8; i++)
    for (let j = 1; j < 8; j++) {
      const p = [box[0] + ((box[2] - box[0]) * i) / 8, box[1] + ((box[3] - box[1]) * j) / 8],
        d = Math.hypot(p[0] - cx, p[1] - cy);
      if (d < distance && insidePolygon(p, polygon)) {
        best = p;
        distance = d;
      }
    }
  return best;
}
/** The building at p among `rows` ({id, polygon, bounds}), or null when none or two are as close. */
export function pickBuilding(rows, p) {
  const candidates = rows
    .map((b) => ({ b, d: insidePolygon(p, b.polygon) ? 0 : edgeDistance(p, b.polygon[0]) }))
    .filter((r) => r.d <= 12)
    .sort((a, b) => a.d - b.d);
  if (!candidates.length || (candidates[1] && candidates[1].d - candidates[0].d < 1)) return null;
  const { b, d } = candidates[0],
    point = buildingRoofPoint(b.polygon);
  return point ? { ...b, key: b.id + "/" + b.bounds.join("/"), point, distance: d, approximate: d > 0 } : null;
}
export function buildingLocator(buildings) {
  const rows = buildings.map((b) => ({ ...b, bounds: ringBounds(b.polygon[0]) })),
    near = spatialIndex(rows, (b) => b.bounds);
  return (p) => pickBuilding(near([p[0] - 12, p[1] - 12, p[0] + 12, p[1] + 12]), p);
}
