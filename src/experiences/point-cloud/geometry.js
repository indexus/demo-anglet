export function insideRing(p, ring) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i],
      b = ring[j];
    if (
      a[1] > p[1] !== b[1] > p[1] &&
      p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      hit = !hit;
  }
  return hit;
}
export function insidePolygon(p, polygon) {
  if (!insideRing(p, polygon[0])) return false;
  for (let i = 1; i < polygon.length; i++) if (insideRing(p, polygon[i])) return false;
  return true;
}
