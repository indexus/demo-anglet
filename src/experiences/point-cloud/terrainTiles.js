// The LiDAR ground, read from its raster collection (the scene's `terrain`,
// named in its catalogue entry: TerraLidHD2025v1; docs/collections.md 1.6).
//
// A tile is the cell (row, col) of quad level T of the shared `gps` Space:
// 65 x 65 altitudes at the corners of its 64 x 64 cells, so neighbours share
// their edges. Its record sits at the 16-character location of its centre
// (tileAnchor), ID "T/row/col". Levels 13 (cells of 38 m north-south) to 19
// (0.6 m). The finest tiles carry the sums [w, w.z, w.zz], so every zone
// answers its mean altitude: far views draw those rows, not tiles.
//
// Heights leave here in the scene's rendering frame: metres above the scene's
// zero (`altitude`), at points given in metres from the scene origin.
import { byteCache, cellIndex, cellOfLocation, localFrame, locationOfCell, tileAnchor } from "./geoSpace.js";
import { scheduler as sharedScheduler } from "../../data/scheduler.js";
import { aligned, magic, payloadBytes, recordPayload } from "../../data/payload.js";

export const LEVELS = [13, 19];
const SIZE = 65,
  CELLS = 64,
  ROW_ZONES = 64, // zones of one read of rows
  ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_",
  HALF_EARTH = Math.PI * 6378137; // metres of 180 degrees of latitude

/**
 * Altitudes (metres) of a tile, row-major from the south-west corner. The
 * payload is an `indexus-terrain-tile-v2` JSON value (its values gzipped in
 * base64) or the bytes of an IXTT binary payload (the values as they are).
 */
export async function decodeTile(payload) {
  let values, scale, offset, deltas;
  if (payload instanceof Uint8Array) {
    const bytes = aligned(payload),
      view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (magic(bytes) !== "IXTT" || view.getUint16(4, true) !== 1 || view.getUint16(6, true) !== SIZE) throw Error("Unknown terrain tile");
    if (bytes.byteLength !== 40 + SIZE * SIZE * 2) throw Error("Invalid terrain tile");
    deltas = (view.getUint32(20, true) & 1) === 1;
    scale = view.getFloat64(24, true);
    offset = view.getFloat64(32, true);
    values = new Uint16Array(bytes.buffer, bytes.byteOffset + 40, SIZE * SIZE);
  } else {
    if (payload.format !== "indexus-terrain-tile-v2" || payload.size !== SIZE) throw Error("Unknown terrain tile");
    const stream = new Blob([payloadBytes(payload.data)]).stream().pipeThrough(new DecompressionStream("gzip"));
    values = new Uint16Array(await new Response(stream).arrayBuffer());
    if (values.length !== SIZE * SIZE) throw Error("Invalid terrain tile");
    ({ scale, offset } = payload);
    deltas = payload.delta === "x";
  }
  const heights = new Float32Array(values.length);
  for (let j = 0, k = 0; j < SIZE; j++)
    for (let i = 0, value = 0; i < SIZE; i++, k++) {
      value = deltas ? (value + values[k]) & 65535 : values[k]; // deltas along the row
      heights[k] = value * scale + offset;
    }
  return heights;
}
/** Bilinear altitude of a tile { t, row, col, heights } at a place, clamped to the tile. */
export function tileHeight(tile, lat, lng) {
  const scale = 2 ** (tile.t + 6),
    u = Math.max(0, Math.min(CELLS - 1e-4, ((lng + 180) / 360) * scale - tile.col * CELLS)),
    v = Math.max(0, Math.min(CELLS - 1e-4, ((lat + 90) / 180) * scale - tile.row * CELLS)),
    i = Math.floor(u),
    j = Math.floor(v),
    a = u - i,
    b = v - j,
    h = tile.heights,
    k = j * SIZE + i;
  return (h[k] * (1 - a) + h[k + 1] * a) * (1 - b) + (h[k + SIZE] * (1 - a) + h[k + SIZE + 1] * a) * b;
}
/** Tile level whose cells are the first not finer than `spacing` metres (north-south); under 13: rows of sums. */
export const levelFor = (spacing) => Math.min(LEVELS[1], Math.floor(Math.log2(HALF_EARTH / spacing)) - 6);

const suffix = (block, row) => {
  let out = "";
  for (let c = 0; c < block.suffixChars; c++) {
    const bit = c * 6,
      at = row * block.keyWords + (bit >> 5),
      shift = 26 - (bit & 31);
    out += ALPHABET[(shift >= 0 ? block.keys[at] >>> shift : (block.keys[at] << -shift) | (block.keys[at + 1] >>> (32 + shift))) & 63];
  }
  return out;
};

export class TerrainTiles {
  /**
   * scene: { origin: [lng, lat], unit, altitude }; cacheBytes: decoded tiles kept (17 kB each).
   * Every read goes through the shared scheduler (layer "terrain"): coarse
   * levels first, so a parent tile is drawn before its children.
   */
  constructor(network, collection, scene, { cacheBytes = 16 << 20, scheduler = sharedScheduler } = {}) {
    if (typeof collection !== "string" || !collection) throw Error("sol : collection non nommée (catalogue de la scène)");
    this.network = network;
    this.collection = collection;
    this.frame = localFrame(scene);
    this.scheduler = scheduler;
    this.tiles = byteCache(cacheBytes);
    this.zones = byteCache(1 << 20);
    this.bytes = 0;
    this.requests = 0;
  }
  /**
   * Promise of the tile { t, row, col, heights }, or null when the collection has none there.
   * signal: the caller's cancel (a MapLibre DEM tile); the read stops when every caller has cancelled.
   */
  tile(t, row, col, signal = null) {
    const key = t + "/" + row + "/" + col;
    let pending = this.tiles.get(key);
    if (!pending) {
      const location = tileAnchor(t, row, col, this.collection);
      pending = this.scheduler
        .request(
          "terrain",
          key,
          async (readSignal) => {
            this.requests++;
            const rows = await this.network.getContentRecords(this.collection, location, 4, { signal: readSignal }),
              record = rows.find((r) => r.location === location && r.id === key);
            if (!record) return null;
            const payload = recordPayload(record),
              bytes = payload.data?.length ?? payload.length;
            this.bytes += bytes;
            return { t, row, col, heights: await decodeTile(payload), bytes };
          },
          { priority: 100 - t, size: (tile) => tile?.bytes ?? 64, signal },
        )
        .then(
          (tile) => {
            this.tiles.resize(key, tile ? SIZE * SIZE * 4 : 64);
            pending.value = tile;
            if (tile) this.onTile?.(tile); // the ground got finer there (the scene's surface)
            return tile;
          },
          (error) => {
            this.tiles.delete(key); // asked again next time
            throw error;
          },
        );
      this.tiles.set(key, pending);
    } else if (signal && pending.value === undefined) {
      // one more caller holds the same read
      this.scheduler.request("terrain", key, null, { priority: 100 - t, signal });
    }
    return pending;
  }
  *loadedCells() { for (const [, pending] of this.tiles.entries()) if (pending.value) yield pending.value; }
  /** The tile if it is already read (no read is started): { t, row, col, heights }, null, or undefined. */
  peek(t, row, col) {
    return this.tiles.get(t + "/" + row + "/" + col)?.value;
  }
  /** The tile, or the nearest tile above it that exists (down to level 13). */
  async cover(t, row, col, signal = null) {
    for (; t >= LEVELS[0]; t--, row = Math.floor(row / 2), col = Math.floor(col / 2)) {
      const tile = await this.tile(t, row, col, signal);
      if (tile) return tile;
    }
    return null;
  }
  /** Altitude above the scene's zero at a frame point from the tiles already read (finest first), or undefined. */
  heightAt(x, y, finest = LEVELS[1]) {
    const [lat, lng] = this.frame.toDegrees(x, y);
    for (let t = finest; t >= LEVELS[0]; t--) {
      const scale = 2 ** t,
        tile = this.peek(t, Math.floor(((lat + 90) / 180) * scale), Math.floor(((lng + 180) / 360) * scale));
      if (tile) return tileHeight(tile, lat, lng) - this.frame.altitude;
    }
    return undefined;
  }
  /**
   * Mean altitudes of the children of zones (one /sets read): Map(child location -> altitude).
   * A row is the sum of the finest tiles under it: [w, w.z, w.zz].
   */
  async means(zones) {
    const out = new Map(),
      missing = zones.filter((zone) => !this.zones.get(zone));
    if (missing.length) {
      const answer = await this.scheduler.request(
        "terrain",
        "sets/" + missing.join(","),
        (signal) => {
          this.requests++;
          return this.network.getSets(this.collection, missing, { raw: true, metrics: "f64", signal });
        },
        { priority: 1000, size: (a) => a.responses?.reduce((n, r) => n + (r.buffer?.byteLength ?? 0), 0) ?? 0 },
      );
      if (answer.format !== "block") throw Error("Indexus node too old for terrain rows");
      const read = new Map(missing.map((zone) => [zone, new Map()]));
      for (const response of answer.responses) {
        this.bytes += response.buffer?.byteLength ?? 0;
        for (const block of response.blocks) {
          const rows = read.get(block.parent);
          if (!rows || block.suffixChars < 1 || block.metricCount < 2) continue;
          for (let row = 0; row < block.n; row++) {
            const child = block.parent + suffix(block, row)[0],
              sums = rows.get(child) ?? [0, 0];
            sums[0] += block.metrics[row];
            sums[1] += block.metrics[block.n + row];
            rows.set(child, sums);
          }
        }
      }
      for (const zone of answer.unresolved ?? []) read.delete(zone);
      for (const [zone, rows] of read) this.zones.set(zone, rows, 64 + rows.size * 48);
    }
    for (const zone of zones)
      for (const [child, [w, wz]] of this.zones.get(zone) ?? []) if (w > 0) out.set(child, wz / w);
    return out;
  }
  /**
   * Heights of a regular grid: `size` x `size` samples over [x0, x1] x [y0, y1]
   * of the scene frame (row 0 = north), in metres above the scene's zero; 0
   * where there is no ground. The tile level follows the sample spacing, so a
   * grid costs the same number of tiles at every scale; coarser than the
   * coarsest tiles, the rows of sums are read instead.
   */
  async grid(x0, y0, x1, y1, size, signal = null) {
    const frame = this.frame,
      lat = new Float64Array(size),
      lng = new Float64Array(size);
    for (let k = 0; k < size; k++) {
      lat[k] = frame.toDegrees(0, y1 - ((k + 0.5) / size) * (y1 - y0))[0];
      lng[k] = frame.toDegrees(x0 + ((k + 0.5) / size) * (x1 - x0), 0)[1];
    }
    const t = levelFor((y1 - y0) / size),
      out = new Float32Array(size * size);
    if (t < LEVELS[0]) return this.rowsGrid(lat, lng, (y1 - y0) / size, out);
    const scale = 2 ** t,
      rowOf = (v) => Math.floor(((v + 90) / 180) * scale),
      colOf = (v) => Math.floor(((v + 180) / 360) * scale),
      tiles = new Map(),
      wait = [];
    for (let row = rowOf(lat[size - 1]); row <= rowOf(lat[0]); row++)
      for (let col = colOf(lng[0]); col <= colOf(lng[size - 1]); col++)
        wait.push(this.cover(t, row, col, signal).then((tile) => tiles.set(row * scale + col, tile)));
    await Promise.all(wait);
    signal?.throwIfAborted();
    // sampling a 256 x 256 grid is a few ms: slices of 32 rows within the shared main-thread budget
    await this.scheduler.rows(
      "terrain",
      size,
      32,
      (from, to) => {
        for (let r = from, k = from * size; r < to; r++) {
          const row = rowOf(lat[r]);
          for (let c = 0; c < size; c++, k++) {
            const tile = tiles.get(row * scale + colOf(lng[c]));
            out[k] = tile ? tileHeight(tile, lat[r], lng[c]) - frame.altitude : 0;
          }
        }
      },
      100 - t,
    );
    return out;
  }
  /**
   * The same grid from rows of sums: mean altitudes of cells of depth 6 (76 m)
   * or shallower, bilinear between their centres. The depth follows the
   * spacing and is lowered until one read of at most ROW_ZONES zones covers
   * the grid: a far grid never costs more than a near one.
   */
  async rowsGrid(lat, lng, spacing, out) {
    const size = lat.length;
    let depth = spacing < 300 ? 6 : 5,
      level,
      scale,
      zones;
    for (; ; depth--) {
      level = 3 * depth;
      scale = 2 ** level;
      const south = cellIndex(lat[size - 1], lng[0], level),
        north = cellIndex(lat[0], lng[size - 1], level);
      zones = new Set();
      // the zones of the cells under the grid, one cell more on each side for the interpolation
      for (let row = Math.floor((south.row - 1) / 8); row <= Math.floor((north.row + 1) / 8); row++)
        for (let col = Math.floor((south.col - 1) / 8); col <= Math.floor((north.col + 1) / 8); col++)
          zones.add(locationOfCell(row, col, depth - 1, this.collection));
      if (zones.size <= ROW_ZONES || depth <= 3) break;
    }
    const means = new Map();
    for (const [location, altitude] of await this.means([...zones])) {
      const cell = cellOfLocation(location, this.collection);
      means.set(cell.row * scale + cell.col, altitude);
    }
    for (let r = 0, k = 0; r < size; r++) {
      const v = ((lat[r] + 90) / 180) * scale - 0.5,
        j = Math.floor(v),
        b = v - j;
      for (let c = 0; c < size; c++, k++) {
        const u = ((lng[c] + 180) / 360) * scale - 0.5,
          i = Math.floor(u),
          a = u - i;
        let total = 0,
          weight = 0;
        for (const [dj, di, w] of [[0, 0, (1 - a) * (1 - b)], [0, 1, a * (1 - b)], [1, 0, (1 - a) * b], [1, 1, a * b]]) {
          const altitude = means.get((j + dj) * scale + i + di);
          if (altitude === undefined) continue;
          total += altitude * w;
          weight += w;
        }
        out[k] = weight > 0 ? total / weight - this.frame.altitude : 0;
      }
    }
    return out;
  }
}
