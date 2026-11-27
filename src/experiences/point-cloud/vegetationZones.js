// The vegetation's zones of a level over a scene, without reading them: the
// locations of the Space's cells (SDK Space.encode of the collection: its name
// gives the mask and offset) that the scene's contour (or disc) and its
// heights can hold. VegetationTree's start read (prefetch) asks for all the
// coarse levels at once with them, instead of one round trip per level; an
// empty zone answers nothing. Bounded: a level of more than maxZones is not
// listed (null), the walks read it as before.
import { Collection, Space } from "js-indexus-sdk";

/**
 * collection: the vegetation's name; top: levels above the 2 km cube;
 * min, side: the Space's cube (scene metres; [-1024]*3, 2048 for a scene's own);
 * bounds [x0, y0, x1, y1] and contains(x, y) of the scene's zone; heights [low,
 * high] of its ground (the vegetation is looked for from low - 5 to high + 50).
 * Returns zonesAt(depth) -> locations of the cells of `depth` (from the 2 km
 * cube) or null when there are more than maxZones.
 */
export function zoneLister({ collection, top = 0, min = [-1024, -1024, -1024], side = 2048, bounds, contains = null, heights = [-50, 150], maxZones = 1500 }) {
  const definition = new Collection(
      collection,
      ["x", "y", "z"].map((name, i) => ({ name, type: "linear", args: [min[i], min[i] + side] })),
    ),
    space = new Space(definition.dimensions(), definition.mask(), definition.offset()),
    z0 = heights[0] - 5,
    z1 = heights[1] + 50,
    cache = new Map();
  const range = (lo, hi, m, size) => [Math.max(0, Math.floor((lo - m) / size)), Math.min(Math.round(side / size) - 1, Math.floor((hi - m) / size))];
  // a cell meets the zone: one of 25 points of it inside, or the zone's box inside the cell
  const meets = (x, y, size) => {
    if (!contains) return true;
    for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++) if (contains(x + (i / 4) * size, y + (j / 4) * size)) return true;
    return bounds[0] >= x && bounds[2] <= x + size && bounds[1] >= y && bounds[3] <= y + size;
  };
  return (depth) => {
    const length = depth + top;
    if (length <= 0) return ["@"];
    if (cache.has(length)) return cache.get(length);
    const size = side / 4 ** length,
      [i0, i1] = range(bounds[0], bounds[2], min[0], size),
      [j0, j1] = range(bounds[1], bounds[3], min[1], size),
      [k0, k1] = range(z0, z1, min[2], size);
    let out = [];
    if ((i1 - i0 + 1) * (j1 - j0 + 1) * (k1 - k0 + 1) > maxZones * 4) out = null;
    else
      for (let i = i0; i <= i1 && out; i++)
        for (let j = j0; j <= j1 && out; j++) {
          const x = min[0] + i * size,
            y = min[1] + j * size;
          if (!meets(x, y, size)) continue;
          for (let k = k0; k <= k1; k++) {
            const centre = [x + size / 2, y + size / 2, min[2] + (k + 0.5) * size];
            out.push(space.encode(centre.map((v, a) => space.dimension(a).newPoint([v])), length));
          }
          if (out.length > maxZones) out = null;
        }
    cache.set(length, out);
    return out;
  };
}
