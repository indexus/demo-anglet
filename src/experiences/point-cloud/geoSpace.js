// The shared geographic Space of the collections (docs/collections.md): one
// spherical dimension `gps`, latitude -90..90 and longitude -180..180, 8 x 8
// children per character. Twin of the SDK's Space and of scripts/world/space.py
// for what readers need: cells of a location, tile addresses, and the scene's
// rendering frame (metres from the scene origin), which is derived from
// degrees and is never a data space.
//
// Rows count from the south, columns from the west. Quad level q = 3 x depth
// (+ 1 or 2 for the 2x steps inside a character). Indices stay under 2^48:
// exact in a double.
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";
const INDEX = new Map([...ALPHABET].map((c, i) => [c, i]));
export const MAX_DEPTH = 16;
const METRES_PER_DEGREE = (Math.PI * 6378137) / 180;

const offset = (collection, level) => INDEX.get(collection[level % collection.length]);

/** Location of the cell (row, col) of quad level 3 * depth. */
export function locationOfCell(row, col, depth, collection) {
  let out = "";
  for (let l = 0; l < depth; l++) {
    const scale = 8 ** (depth - 1 - l),
      r = Math.floor(row / scale) % 8,
      c = Math.floor(col / scale) % 8;
    let idx = 0;
    for (let b = 2; b >= 0; b--) idx = idx * 4 + ((r >> b) & 1) * 2 + ((c >> b) & 1);
    out += ALPHABET[(offset(collection, l) + idx) % 64];
  }
  return out;
}
/** { row, col, depth } of a location. */
export function cellOfLocation(location, collection) {
  let row = 0,
    col = 0;
  for (let l = 0; l < location.length; l++) {
    const idx = (INDEX.get(location[l]) - offset(collection, l) + 64) % 64;
    let r = 0,
      c = 0;
    for (let b = 0; b < 3; b++) {
      const pair = (idx >> (2 * (2 - b))) & 3;
      r = r * 2 + (pair >> 1);
      c = c * 2 + (pair & 1);
    }
    row = row * 8 + r;
    col = col * 8 + c;
  }
  return { row, col, depth: location.length };
}
/** Cell that holds a point, as the SDK rounds: a point on a boundary belongs to the cell below it. */
export function cellIndex(lat, lng, level) {
  const scale = 2 ** level,
    clamp = (v) => Math.max(0, Math.min(scale - 1, v));
  return { row: clamp(Math.ceil(((lat + 90) / 180) * scale) - 1), col: clamp(Math.ceil(((lng + 180) / 360) * scale) - 1) };
}
/** { south, north, west, east } in degrees of the cell (row, col) of a quad level. */
export function cellBounds(row, col, level) {
  const dlat = 180 / 2 ** level,
    dlng = 360 / 2 ** level;
  return { south: -90 + row * dlat, north: -90 + (row + 1) * dlat, west: -180 + col * dlng, east: -180 + (col + 1) * dlng };
}
/** [north-south, east-west] size in metres of a cell of a quad level at a latitude. */
export function cellMetres(level, lat) {
  return [(180 / 2 ** level) * METRES_PER_DEGREE, (360 / 2 ** level) * METRES_PER_DEGREE * Math.cos((lat * Math.PI) / 180)];
}
/**
 * 16-character location of the centre of the tile (row, col) of quad level t:
 * where its record sits. The centre is on the grid of level t + 1 and of no
 * coarser one, so every level has its own locations.
 */
export function tileAnchor(t, row, col, collection) {
  if (!(t >= 0 && t < 3 * MAX_DEPTH)) throw new RangeError("tile level out of range");
  const scale = 2 ** (3 * MAX_DEPTH - t - 1);
  // on a boundary of level t + 1 the SDK keeps the cell below
  return locationOfCell((2 * row + 1) * scale - 1, (2 * col + 1) * scale - 1, MAX_DEPTH, collection);
}
const mercatorLat = (y, z) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;
const mercatorRow = (lat, z) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 2 ** z;
};
/**
 * Space tiles that cover the MapLibre tile z/x/y: the same column x at level
 * t = z (longitude is linear in both), two or three rows, north first. top and
 * bottom: where the tile's north and south edges fall in the MapLibre tile's
 * height (0 = its top, 1 = its bottom; the first and last stick out).
 */
export function tilesOfZxy(z, x, y) {
  const north = mercatorLat(y, z),
    south = mercatorLat(y + 1, z),
    scale = 2 ** z / 180,
    first = Math.max(0, Math.floor((south + 90) * scale)),
    last = Math.min(2 ** z - 1, Math.ceil((north + 90) * scale) - 1),
    out = [];
  for (let row = last; row >= first; row--) {
    const top = mercatorRow(-90 + (row + 1) / scale, z) - y,
      bottom = mercatorRow(-90 + row / scale, z) - y;
    if (bottom > 0 && top < 1) out.push({ t: z, row, col: x, top, bottom });
  }
  return out;
}
/**
 * The rendering frame of a scene { origin: [lng, lat], unit: Mercator units
 * per metre, altitude: metres of its zero }: east, north in metres from the
 * origin, as MapLibre draws them (Web Mercator scaled at the origin).
 */
export function localFrame(scene) {
  const mx = (lng) => (lng + 180) / 360,
    my = (lat) => mercatorRow(lat, 0),
    ox = mx(scene.origin[0]),
    oy = my(scene.origin[1]),
    unit = scene.unit,
    cos0 = Math.cos((scene.origin[1] * Math.PI) / 180);
  return {
    altitude: scene.altitude ?? 0,
    /** [x, y] of a place */
    toLocal: (lat, lng) => [(mx(lng) - ox) / unit, (oy - my(lat)) / unit],
    /** [lat, lng] of a point of the frame */
    toDegrees: (x, y) => [mercatorLat(oy - y * unit, 0), (ox + x * unit) * 360 - 180],
    /** frame metres per true horizontal metre at a latitude (1 at the origin) */
    scale: (lat) => cos0 / Math.cos((lat * Math.PI) / 180),
  };
}
/** A cache with a size in bytes: the least recently used entries leave first. */
export function byteCache(limit) {
  const entries = new Map();
  let bytes = 0;
  return {
    *entries() { for (const [key, entry] of entries) yield [key, entry.value]; },
    get bytes() {
      return bytes;
    },
    get size() {
      return entries.size;
    },
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    },
    /** `size` may be set later with resize(), once a pending value is known */
    set(key, value, size = 0) {
      this.delete(key);
      entries.set(key, { value, size });
      bytes += size;
      this.trim();
    },
    resize(key, size) {
      const entry = entries.get(key);
      if (!entry) return;
      bytes += size - entry.size;
      entry.size = size;
      this.trim();
    },
    delete(key) {
      const entry = entries.get(key);
      if (entry) bytes -= entry.size;
      entries.delete(key);
    },
    trim() {
      for (const [key, entry] of entries) {
        if (bytes <= limit || entries.size <= 1) break;
        bytes -= entry.size;
        entries.delete(key);
      }
    },
    clear() {
      entries.clear();
      bytes = 0;
    },
  };
}
