// Where rain lands: one vertical first hit of the scene surface (ground or
// roof) per cell of a jittered 65 x 65 grid. Built once per scene and weather,
// in small slices so the page stays fluid.
export const RAIN_CONTACT_STRIDE = 11;

/**
 * Contacts a side over `bounds` [x0, y0, x1, y1]: 65 over the 2 km square as
 * before (about 32 m apart), as many more as a larger rectangle (a contour's)
 * needs at that spacing, at most 129 (16 641 contacts, the drops' budget).
 */
export function rainContactSize([x0, y0, x1, y1]) {
  return Math.max(65, Math.min(129, Math.ceil((65 * Math.max(x1 - x0, y1 - y0)) / 2048)));
}

/**
 * surface: sceneSurface(); bounds: [x0, y0, x1, y1];
 * options: clouds (rain starts at their base), radius (scene disk) or zone (its contour, data/sceneZone.js), signal.
 * Rows: position (3), normal (3), kind, base, phase, seed, start height.
 */
export async function buildRainContactsAsync(surface, bounds, { clouds, radius, zone = null, signal, size = 65 } = {}) {
  const rows = [],
    counts = {};
  let state = 0x52c1a7,
    slice = performance.now();
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      if (performance.now() - slice >= 4) {
        await new Promise((r) => setTimeout(r, 0));
        signal?.throwIfAborted();
        slice = performance.now();
      }
      const q = [
          bounds[0] + ((x + random()) / size) * (bounds[2] - bounds[0]),
          bounds[1] + ((y + random()) / size) * (bounds[3] - bounds[1]),
        ],
        seed = random();
      if (zone ? !zone.contains(q[0], q[1]) : radius && Math.hypot(...q) > radius) continue;
      const hit = surface.hit(q),
        start = clouds ? clouds.base(q) : hit.position[2] + 6 + seed * 8;
      if (start === null || start <= hit.position[2] + 1) continue;
      rows.push(...hit.position, ...hit.normal, hit.kind, hit.base, hit.phase, seed, start);
      counts[hit.kind] = (counts[hit.kind] ?? 0) + 1;
    }
  return { data: new Float32Array(rows), count: rows.length / RAIN_CONTACT_STRIDE, counts };
}
