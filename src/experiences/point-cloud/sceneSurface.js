// What the camera, the weather and the lights stand on: the LiDAR ground and
// the building boxes (the buildings' sums). It fills in as the scene loads:
// the ground answers from the finest ground tile already read, else from a
// coarse grid (the rows of sums of the scene, one read); a building joins the
// roof index when its row gets its place (addRoof). Nothing walks the whole
// scene. Answers: height(q), surface(q), heights(q), hit(q), roof(q), bounds,
// start, version (grows with every change).
import { boxCorners } from "./buildingsTree.js";

const CELL = 16; // metres per bucket of the roof index

/** Bilinear sampler of a size x size grid over bounds (row 0 = north, heights at cell centres). */
export function gridHeight(ground, size, bounds) {
  const [x0, y0, x1, y1] = bounds,
    sx = (x1 - x0) / size,
    sy = (y1 - y0) / size;
  return (q) => {
    const u = Math.max(0, Math.min(size - 1.001, (q[0] - x0) / sx - 0.5)),
      v = Math.max(0, Math.min(size - 1.001, (y1 - q[1]) / sy - 0.5)),
      i = Math.floor(u),
      j = Math.floor(v),
      a = u - i,
      b = v - j,
      k = j * size + i;
    return (ground[k] * (1 - a) + ground[k + 1] * a) * (1 - b) + (ground[k + size] * (1 - a) + ground[k + size + 1] * a) * b;
  };
}

/**
 * bounds: [x0, y0, x1, y1]; coarse(q) -> height (always answers);
 * fine(q) -> height or undefined (the tiles read so far).
 */
export function liveSurface(bounds, coarse, fine = () => undefined) {
  const buckets = new Map(),
    roofs = [];
  let version = 0,
    start = null;
  const height = (q) => fine(q[0], q[1]) ?? coarse(q);
  const inside = (b, q) => {
    const dx = q[0] - b.centre[0],
      dy = q[1] - b.centre[1],
      uu = b.u[0] ** 2 + b.u[1] ** 2,
      vv = b.v[0] ** 2 + b.v[1] ** 2;
    return Math.abs(dx * b.u[0] + dy * b.u[1]) <= uu && Math.abs(dx * b.v[0] + dy * b.v[1]) <= vv;
  };
  /** the building box under q, if any (the highest) */
  const roof = (q) => {
    let best = null;
    for (const r of buckets.get(Math.floor(q[0] / CELL) + "/" + Math.floor(q[1] / CELL)) ?? [])
      if (inside(r.box, q) && (!best || r.box.roof > best.box.roof)) best = r;
    return best;
  };
  const surface = (q) => Math.max(height(q), roof(q)?.box.roof ?? -Infinity);
  return {
    bounds,
    roofs,
    roof,
    height,
    surface,
    get version() {
      return version;
    },
    /** A building placed by the buildings tree ({location, box}): it joins the buckets it touches. */
    addRoof({ location, box }) {
      const corners = boxCorners(box),
        r = { location, box, lo: [0, 1].map((d) => Math.min(...corners.map((c) => c[d]))), hi: [0, 1].map((d) => Math.max(...corners.map((c) => c[d]))) };
      roofs.push(r);
      for (let i = Math.floor(r.lo[0] / CELL); i <= Math.floor(r.hi[0] / CELL); i++)
        for (let j = Math.floor(r.lo[1] / CELL); j <= Math.floor(r.hi[1] / CELL); j++) {
          const key = i + "/" + j;
          if (!buckets.has(key)) buckets.set(key, []);
          buckets.get(key).push(r);
        }
      version++;
      start = null;
    },
    /** The ground got finer somewhere (a tile was read). */
    touch() {
      version++;
    },
    /** Boxes whose bucket is within `radius` of p (for the sale anchors). */
    near(p, radius) {
      const out = new Set();
      for (let i = Math.floor((p[0] - radius) / CELL); i <= Math.floor((p[0] + radius) / CELL); i++)
        for (let j = Math.floor((p[1] - radius) / CELL); j <= Math.floor((p[1] + radius) / CELL); j++)
          for (const r of buckets.get(i + "/" + j) ?? []) out.add(r);
      return [...out];
    },
    heights: (q) => {
      const ground = height(q);
      return [ground, Math.max(ground, roof(q)?.box.roof ?? -Infinity)];
    },
    /** first hit of a vertical ray: position, normal, kind (1 roof, 4 ground) */
    hit: (q) => {
      const r = roof(q),
        z = height(q);
      if (r && r.box.roof > z) return { position: [...q, r.box.roof], normal: [0, 0, 1], kind: 1, base: r.box.ground, phase: 0 };
      const e = 2,
        n = [height([q[0] - e, q[1]]) - height([q[0] + e, q[1]]), height([q[0], q[1] - e]) - height([q[0], q[1] + e]), 2 * e],
        l = Math.hypot(...n);
      return { position: [...q, z], normal: n.map((c) => c / l), kind: 4, base: 0, phase: 0 };
    },
    /** the person view starts on the ground nearest the scene centre, away from the buildings known so far */
    get start() {
      if (!start) {
        let at = [0, 0];
        search: for (let r = 0; r < 200; r += 4)
          for (let a = 0; a < 16; a++) {
            const q = [Math.cos((a * Math.PI) / 8) * r, Math.sin((a * Math.PI) / 8) * r];
            if (!roof(q) && !roof([q[0] + 3, q[1]]) && !roof([q[0] - 3, q[1]])) {
              at = q;
              break search;
            }
          }
        start = { position: [...at, height(at) + 1.8], bearing: 0 };
      }
      return start;
    },
  };
}

/**
 * The whole surface at once (tests, fixed scenes): ground: Float32Array of
 * size x size heights over `bounds` (row 0 = north), cells: [{location, box}].
 */
export function sceneSurface(ground, size, bounds, cells) {
  const surface = liveSurface(bounds, gridHeight(ground, size, bounds));
  for (const cell of cells) surface.addRoof(cell);
  return surface;
}
