// Small illustrated cloud banks, built on demand in the site's local metres.
// The same ellipsoids define the visible puffs and the origin of every drop.
// One bank about every 110 m over a 2 km square as before; over a larger
// rectangle (a contour's) at most MAX_BANKS of them, farther apart and as
// much larger, and only those within reach of the contour (`zone`,
// data/sceneZone.js): no square of clouds past the commune.
export const MAX_BANKS = 400;
/** The banks' spacing over `bounds`: 110 m, or more so that the rectangle holds at most `banks`. */
export function bankSpacing([x0, y0, x1, y1], banks = MAX_BANKS) {
  return Math.max(110, Math.sqrt(((x1 - x0) * (y1 - y0)) / banks));
}
export function rainClouds(bounds, altitude, { zone = null, banks: maxBanks = MAX_BANKS } = {}) {
  const instances = [],
    lobes = [],
    banks = [],
    buckets = new Map(),
    cell = 64,
    [x0, y0, x1, y1] = bounds,
    width = x1 - x0,
    height = y1 - y0;
  const spacing = bankSpacing(bounds, maxBanks),
    nx = Math.max(1, Math.ceil(width / spacing)),
    ny = Math.max(1, Math.ceil(height / spacing)),
    // 65 m at most as before, as much larger as the banks are farther apart
    largest = 65 * (spacing / 110);
  let state = 73129;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
  for (let y = 0; y < ny; y++)
    for (let x = 0; x < nx; x++) {
      const start = lobes.length,
        low = [Infinity, Infinity, Infinity],
        high = [-Infinity, -Infinity, -Infinity];
      const cx = x0 + ((x + 0.35 + random() * 0.3) * width) / nx,
        cy = y0 + ((y + 0.35 + random() * 0.3) * height) / ny;
      const radius = Math.min(largest, Math.max(24, Math.min(width / nx, height / ny) * 0.53)),
        z = altitude + random() * 5;
      // a contour: the banks over it or within reach of its edge (the random draws stay the same)
      const kept = !zone || zone.contains(cx, cy) || zone.beyond(cx, cy, 200) < Math.min(200, radius);
      for (let j = 0; j < 6; j++) {
        const angle = j * 2.399963 + random() * 0.4,
          d = j === 0 ? 0 : radius * (0.3 + random() * 0.42);
        const centre = [
          cx + Math.cos(angle) * d,
          cy + Math.sin(angle) * d,
          z + (j === 0 ? 0 : random() * 5),
        ];
        const scale = [
          radius * (0.51 + random() * 0.26),
          radius * (0.46 + random() * 0.24),
          (7 + random() * 6) * Math.sqrt(spacing / 110),
        ];
        const shade = 0.79 + random() * 0.12;
        if (!kept) continue;
        lobes.push({ centre, scale });
        instances.push(...centre, ...scale, shade);
        for (let k = 0; k < 3; k++) {
          low[k] = Math.min(low[k], centre[k] - scale[k]);
          high[k] = Math.max(high[k], centre[k] + scale[k]);
        }
        const id = lobes.length - 1;
        for (
          let ix = Math.floor((centre[0] - scale[0]) / cell);
          ix <= Math.floor((centre[0] + scale[0]) / cell);
          ix++
        )
          for (
            let iy = Math.floor((centre[1] - scale[1]) / cell);
            iy <= Math.floor((centre[1] + scale[1]) / cell);
            iy++
          ) {
            const key = ix + "/" + iy;
            if (!buckets.has(key)) buckets.set(key, []);
            buckets.get(key).push(id);
          }
      }
      if (!kept) continue;
      const centre = low.map((v, k) => (v + high[k]) * 0.5),
        bankRadius = Math.hypot(...low.map((v, k) => (high[k] - v) * 0.5));
      banks.push({ start, count: lobes.length - start, centre, radius: bankRadius });
    }
  const indexStats = { cells: buckets.size, queries: 0, candidates: 0 };
  return {
    instances: new Float32Array(instances),
    count: lobes.length,
    banks,
    indexStats,
    base(q) {
      let z = Infinity;
      const ids = buckets.get(Math.floor(q[0] / cell) + "/" + Math.floor(q[1] / cell)) ?? [];
      indexStats.queries++;
      indexStats.candidates += ids.length;
      for (const id of ids) {
        const { centre: c, scale: s } = lobes[id],
          r = ((q[0] - c[0]) / s[0]) ** 2 + ((q[1] - c[1]) / s[1]) ** 2;
        if (r < 1) z = Math.min(z, c[2] - s[2] * Math.sqrt(1 - r));
      }
      return Number.isFinite(z) ? z : null;
    },
  };
}
export function cloudGeometry() {
  const positions = [],
    indices = [],
    rings = 10,
    segments = 20;
  for (let y = 0; y <= rings; y++)
    for (let x = 0; x <= segments; x++) {
      const a = (x / segments) * Math.PI * 2,
        b = (y / rings) * Math.PI;
      positions.push(Math.cos(a) * Math.sin(b), Math.sin(a) * Math.sin(b), Math.cos(b));
    }
  for (let y = 0; y < rings; y++)
    for (let x = 0; x < segments; x++) {
      const a = y * (segments + 1) + x,
        b = a + segments + 1;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  return { positions: new Float32Array(positions), indices: new Uint16Array(indices) };
}
