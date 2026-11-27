// Which ground tiles to draw (groundLayer.js): Web Mercator tiles z/x/y, the
// same as the orthophoto's, as rectangles of the scene frame (metres east and
// north of the origin). A tile is split while its error on screen (its side
// over its distance, in CSS pixels) is over `pixels`, the largest error
// first, until `budget` tiles: the cost of a view is the same at every zoom.
// A tile is split only once its visible children are read; until then it is
// drawn itself, so the ground never has a hole.

/** Rectangle [x0, y0, x1, y1] of tile z/x/y in the frame of `origin` (Mercator {x, y}) and `unit` (Mercator per metre). */
export function tileRect(z, x, y, origin, unit) {
  const span = 2 ** z;
  return [
    (x / span - origin.x) / unit,
    (origin.y - (y + 1) / span) / unit,
    ((x + 1) / span - origin.x) / unit,
    (origin.y - y / span) / unit,
  ];
}

/**
 * Tiles of level z over the square [-extent, extent]² of the frame, or over the
 * rectangle [x0, y0, x1, y1] (a scene's zone and its edge).
 */
export function rootTiles(z, extent, origin, unit) {
  const [ex0, ey0, ex1, ey1] = typeof extent === "number" ? [-extent, -extent, extent, extent] : extent,
    span = 2 ** z,
    x0 = Math.floor((origin.x + ex0 * unit) * span),
    x1 = Math.floor((origin.x + ex1 * unit) * span),
    y0 = Math.floor((origin.y - ey1 * unit) * span),
    y1 = Math.floor((origin.y - ey0 * unit) * span),
    out = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push({ z, x, y, key: `${z}/${x}/${y}` });
  return out;
}

const children = ({ z, x, y }) =>
  [0, 1, 2, 3].map((k) => {
    const cx = 2 * x + (k & 1),
      cy = 2 * y + (k >> 1);
    return { z: z + 1, x: cx, y: cy, key: `${z + 1}/${cx}/${cy}` };
  });

/**
 * view: { eye, planes (frustumPlanes), focal (CSS px) }; roots: rootTiles();
 * ground: { origin, unit, extent, heights: [low, high], maxZoom }, and with a
 * scene's zone (data/sceneZone.js) { zone, edge }: a tile is drawn when it is
 * within `edge` metres of the zone (the answer is kept per tile in ground.near);
 * extent is then the rectangle [x0, y0, x1, y1] around it;
 * range(key): [low, high] of a read tile, or undefined while it is not read.
 * Returns { draw: tiles to draw, want: tiles to read, nearest first }.
 */
export function selectGround(view, roots, ground, range, { pixels = 384, budget = 40 } = {}) {
  const { origin, unit, extent, maxZoom } = ground,
    want = [],
    leaves = [];
  // a tile with its rectangle, height range, distance and error, or null when off screen or off the scene
  const place = (tile) => {
    const rect = tileRect(tile.z, tile.x, tile.y, origin, unit),
      [low, high] = range(tile.key) ?? ground.heights;
    if (typeof extent === "number") {
      if (rect[2] < -extent || rect[0] > extent || rect[3] < -extent || rect[1] > extent) return null;
    } else {
      if (rect[2] < extent[0] || rect[0] > extent[2] || rect[3] < extent[1] || rect[1] > extent[3]) return null;
      if (ground.zone) {
        let near = ground.near.get(tile.key);
        if (near === undefined) ground.near.set(tile.key, (near = ground.zone.touches(rect[0], rect[1], rect[2], rect[3], ground.edge)));
        if (!near) return null;
      }
    }
    const c = [(rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2, (low + high) / 2],
      r = Math.hypot(rect[2] - rect[0], rect[3] - rect[1], high - low) / 2;
    const planes = view.planes;
    for (let i = 0; i < planes.length; i += 4) if (planes[i] * c[0] + planes[i + 1] * c[1] + planes[i + 2] * c[2] + planes[i + 3] < -r) return null;
    const [ex, ey, ez] = view.eye,
      dx = Math.max(rect[0] - ex, 0, ex - rect[2]),
      dy = Math.max(rect[1] - ey, 0, ey - rect[3]),
      dz = Math.max(low - ez, 0, ez - high),
      distance = Math.max(Math.hypot(dx, dy, dz), 1);
    return { ...tile, rect, distance, error: ((rect[2] - rect[0]) / distance) * view.focal };
  };
  for (const root of roots) {
    const tile = place(root);
    if (!tile) continue;
    if (range(tile.key)) leaves.push(tile);
    else want.push(tile);
  }
  // split the leaf with the largest error while the budget allows
  for (;;) {
    let best = -1;
    for (let i = 0; i < leaves.length; i++) {
      const leaf = leaves[i];
      if (leaf.final || leaf.error <= pixels || leaf.z >= maxZoom) continue;
      if (best < 0 || leaf.error > leaves[best].error) best = i;
    }
    if (best < 0) break;
    const leaf = leaves[best],
      parts = children(leaf).map(place).filter(Boolean),
      missing = parts.filter((p) => !range(p.key));
    if (leaves.length - 1 + parts.length > budget) {
      leaf.final = true;
      continue;
    }
    if (missing.length) {
      want.push(...missing);
      leaf.final = true;
      continue;
    }
    leaves.splice(best, 1, ...parts);
  }
  want.sort((a, b) => a.z - b.z || a.distance - b.distance);
  return { draw: leaves, want };
}
