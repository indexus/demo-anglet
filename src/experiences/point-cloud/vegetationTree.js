// Vegetation as one Indexus tree (the scene's `vegetation` collection, named in its
// catalogue entry: AngVegetation001).
//
// Space: east, north, up in [-1024, 1024] (scene metres), 64 children per
// character (4 x 4 x 4). One record per occupied 2 m voxel (depth 5). A
// commune's Space (option `top`, data/collections.js vegetationSpace) has `top`
// characters more above it: its cells of depth `top` are 2 km cubes of the
// scene's frame, under them everything is as here. Depths below are counted
// from those cubes (the levels above them are depths 1 - top to 0). Its
// metrics are Abelian sums, so every zone answers /sets with the exact
// moments of the returns below it:
//   [n, Σx, Σy, Σz, Σxx, Σxy, Σxz, Σyy, Σyz, Σzz, Σr, Σg, Σb]
// A cell is drawn as the Gaussian of those moments (mean, covariance, mean
// colour) at 512, 128, 32, 8 and 2 m. The record's payload holds its returns
// (6 bytes each); one /records read of an 8 m zone returns its voxels.
//
// Level of detail: a fixed budget of drawn items. Cells are refined best
// first (largest on screen) until the budget is spent, so the drawn count
// does not depend on the zoom. `tau` is the size on screen where the budget ran
// out; a cell cross-fades with its children over [tau, tau * band] through
// complementary dither intervals [lo, hi): each pixel belongs to one level.
//
// With a gate (camera.gate, from CrownTree.gate), only 2 m cells and returns
// are drawn, where the gate says so: far vegetation is drawn as crowns, and a
// tree's points grow in (scale 0..1) while its crown fades out.

import { scheduler as sharedScheduler, isCancelled } from "../../data/scheduler.js";
import { payloadBytes } from "../../data/payload.js";

export const LEAF_DEPTH = 5; // 2 m voxels: the records
export const METRICS = 13;
export const DISC = 0.2; // world radius of one return's disc (m)
export const CELL_FLOATS = 21; // centre(3) axes(9) colour(3) alpha, bent normal(3), lo hi
export const SLOT_FLOATS = 20; // a cell's fixed part (19 floats) and its side (m) in the GPU store: 5 RGBA texels
export const SLOTS_PER_ROW = 256; // cells per row of the store's texture
export const INSTANCE_FLOATS = 4; // what a walk writes per drawn cell: slot, lo, hi, scale

/**
 * The cells' fixed part, kept for the GPU: a cell gets a slot the first time
 * it is drawn and keeps it until the tree forgets it. A walk then writes only
 * 16 bytes per drawn cell (slot, fade interval, scale) instead of 84; the
 * renderer uploads the store's rows that changed (dirty), not the whole store.
 */
export class CellStore {
  constructor(capacity = 65536) {
    this.capacity = capacity;
    this.data = new Float32Array(capacity * SLOT_FLOATS);
    this.free = [];
    this.next = 0;
    this.dirty = new Set(); // texture rows written since the last upload
    this.version = 0; // grows when the capacity does: the renderer uploads everything
  }
  /** row: the cell's fixed part (19 floats); size: its side (m), the slot's 20th float. */
  alloc(row, size = 0) {
    let slot = this.free.pop();
    if (slot === undefined) {
      if (this.next === this.capacity) this.grow();
      slot = this.next++;
    }
    this.data.set(row, slot * SLOT_FLOATS);
    this.data[slot * SLOT_FLOATS + SLOT_FLOATS - 1] = size;
    this.dirty.add(Math.floor(slot / SLOTS_PER_ROW));
    return slot;
  }
  release(slot) {
    this.free.push(slot);
  }
  grow() {
    const data = new Float32Array(this.capacity * 2 * SLOT_FLOATS);
    data.set(this.data);
    this.data = data;
    this.capacity *= 2;
    this.version++;
  }
  get bytes() {
    return this.data.byteLength;
  }
}
export const RETURN_BYTES = 24; // xyz f32, rgb u8 + scale u8, lo hi u16, normal i8 x 3 + pad
export const BLOCK_RETURNS = 64; // returns per block of the ReturnStore

/**
 * The 2 m voxels' returns, kept for the GPU in blocks of BLOCK_RETURNS: a
 * voxel gets its blocks the first time it is drawn and keeps them until the
 * tree forgets it; the renderer uploads the voxels in `uploads` once. A walk
 * then hands, per drawn voxel, its blocks and its fade (lo, hi, scale):
 * 16 bytes per block instead of RETURN_BYTES per return.
 */
export class ReturnStore {
  constructor(capacity = 1024) {
    this.capacity = capacity; // blocks
    this.free = [];
    this.next = 0;
    this.uploads = []; // voxels whose returns the renderer has not put on the GPU yet
    this.version = 0; // grows with the capacity: the renderer moves its blocks to a larger buffer
    this.blocks = 0; // blocks held
  }
  alloc(cell) {
    const k = Math.ceil(cell.returns.length / RETURN_BYTES / BLOCK_RETURNS),
      blocks = new Int32Array(k);
    for (let i = 0; i < k; i++) {
      let b = this.free.pop();
      if (b === undefined) {
        if (this.next === this.capacity) {
          this.capacity *= 2;
          this.version++;
        }
        b = this.next++;
      }
      blocks[i] = b;
    }
    this.blocks += k;
    this.uploads.push(cell);
    return blocks;
  }
  release(cell) {
    for (const b of cell.blocks) this.free.push(b);
    this.blocks -= cell.blocks.length;
    cell.blocks = null;
  }
}
/** The voxels a walk draws with their returns: cell, then its fade as u16 lo | hi << 16 and its scale (0..255). */
class LeafList {
  cells = [];
  fades = [];
  scales = [];
  length = 0;
  push(cell, fade, scale) {
    const i = this.length++;
    this.cells[i] = cell;
    this.fades[i] = fade;
    this.scales[i] = scale;
  }
  /** The returns as one array (RETURN_BYTES each, the fade and scale in place): tests and tools, not the renderer. */
  bytes() {
    let n = 0;
    for (let i = 0; i < this.length; i++) n += this.cells[i].returns.length;
    const out = new Uint8Array(n);
    for (let i = 0, start = 0; i < this.length; i++) {
      const chunk = this.cells[i].returns,
        end = start + chunk.length,
        lohi = this.fades[i];
      out.set(chunk, start);
      for (let o = start + 16; o < end; o += RETURN_BYTES) {
        out[o - 1] = this.scales[i];
        out[o] = lohi & 255;
        out[o + 1] = (lohi >>> 8) & 255;
        out[o + 2] = (lohi >>> 16) & 255;
        out[o + 3] = lohi >>> 24;
      }
      start = end;
    }
    return out;
  }
}
const SIDE = 2048,
  K = 2.1, // radius = K sigma: reaches the corners of a full voxel (sigma = half-width / sqrt(3))
  // share of its ellipse a cell of each depth really covers (measured against its returns):
  // makes coverage on screen the same at 128, 32, 8, 2 m and with the returns
  COVER = [1, 0.3, 0.33, 0.47, 0.76, 0.92];
/** Cells above this depth are never trimmed (their children stay read). */
export const KEEP_DEPTH = 3;
/** Fades in time: a share change smaller than this while the camera moves follows it at once. */
const FOLLOW = 0.08;
const SIZES = [0, 1, 2, 3, 4, 5].map((depth) => SIDE / 4 ** depth);
/** Side of a cell of `depth` (from the 2 km cube; negative above it, in a commune's Space). */
export const cellSize = (depth) => (depth >= 0 ? SIZES[depth] : SIDE * 4 ** -depth);

// ---- moments -> Gaussian ---------------------------------------------------------
function eigenSymmetric(a) {
  // Jacobi on [xx xy xz; xy yy yz; xz yz zz]; returns values and column vectors
  const m = [
      [a[0], a[1], a[2]],
      [a[1], a[3], a[4]],
      [a[2], a[4], a[5]],
    ],
    v = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
  for (let sweep = 0; sweep < 8; sweep++) {
    let off = 0;
    for (let p = 0; p < 2; p++) for (let q = p + 1; q < 3; q++) off += m[p][q] ** 2;
    if (off < 1e-12) break;
    for (let p = 0; p < 2; p++)
      for (let q = p + 1; q < 3; q++) {
        if (Math.abs(m[p][q]) < 1e-15) continue;
        const theta = (m[q][q] - m[p][p]) / (2 * m[p][q]),
          t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1)),
          c = 1 / Math.sqrt(t * t + 1),
          s = t * c;
        for (let k = 0; k < 3; k++) {
          const mkp = m[k][p],
            mkq = m[k][q];
          m[k][p] = c * mkp - s * mkq;
          m[k][q] = s * mkp + c * mkq;
        }
        for (let k = 0; k < 3; k++) {
          const mpk = m[p][k],
            mqk = m[q][k];
          m[p][k] = c * mpk - s * mqk;
          m[q][k] = s * mpk + c * mqk;
        }
        for (let k = 0; k < 3; k++) {
          const vkp = v[k][p],
            vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
  }
  return { values: [m[0][0], m[1][1], m[2][2]], vectors: v };
}

/**
 * Gaussian of Abelian sums `s`, ready to draw: `row` holds centre, the three
 * scaled axes of the ellipsoid, colour, coverage and a normal bent away from
 * `around` (the parent's mean), so a crown is lit as one volume, not cell by cell.
 */
export function gaussian(s, depth = LEAF_DEPTH, around = null) {
  const n = s[0],
    mean = [s[1] / n, s[2] / n, s[3] / n];
  const { values, vectors } = eigenSymmetric([
    s[4] / n - mean[0] * mean[0],
    s[5] / n - mean[0] * mean[1],
    s[6] / n - mean[0] * mean[2],
    s[7] / n - mean[1] * mean[1],
    s[8] / n - mean[1] * mean[2],
    s[9] / n - mean[2] * mean[2],
  ]);
  const row = new Float32Array(CELL_FLOATS - 2),
    radii = [];
  row.set(mean);
  for (let i = 0; i < 3; i++) {
    // + the disc radius of a return: a cell covers what its returns' discs cover
    const r = Math.max(K * Math.sqrt(Math.max(values[i], 0)) + DISC, 0.2);
    radii.push(r);
    for (let k = 0; k < 3; k++) row[3 + i * 3 + k] = vectors[k][i] * r;
  }
  row.set([s[10] / n, s[11] / n, s[12] / n], 12);
  radii.sort((a, b) => b - a);
  // coverage: the returns' discs over the ellipse of the two largest axes
  row[15] = COVER[Math.max(0, depth)] * Math.max(0.25, Math.min(1, (n * DISC ** 2) / (radii[0] * radii[1])));
  const bent = around ? [mean[0] - around[0], mean[1] - around[1], mean[2] - around[2] + cellSize(depth) / 2] : [0, 0, 1],
    l = Math.hypot(...bent);
  row.set(bent.map((v) => v / l), 16);
  return { n, mean, radius: radii[0], flatness: 1 - radii[2] / radii[1], row };
}

/**
 * Returns of one 2 m voxel: payload (6 bytes each, base64 text or a Uint8Array
 * of an IXRB answer) -> RETURN_BYTES per return, with a normal bent away from
 * the voxel's mean (up when flat).
 */
export function decodeReturns(payload, g) {
  const bin = payloadBytes(payload),
    n = bin.length / 6,
    out = new Uint8Array(n * RETURN_BYTES),
    f = new Float32Array(out.buffer), // RETURN_BYTES is a multiple of 4: each return's xyz is aligned
    normal = new Int8Array(out.buffer),
    size = cellSize(LEAF_DEPTH),
    q = size / 256,
    [mx, my, mz] = g.mean,
    lx = Math.floor((mx + SIDE / 2) / size) * size - SIDE / 2,
    ly = Math.floor((my + SIDE / 2) / size) * size - SIDE / 2,
    lz = Math.floor((mz + SIDE / 2) / size) * size - SIDE / 2,
    up = 0.15 + g.flatness * 2;
  if (!Number.isInteger(n)) throw Error("Invalid vegetation payload");
  for (let i = 0, b = 0, o = 0; i < n; i++, b += 6, o += RETURN_BYTES) {
    const x = lx + (bin[b] + 0.5) * q,
      y = ly + (bin[b + 1] + 0.5) * q,
      z = lz + (bin[b + 2] + 0.5) * q,
      dx = x - mx,
      dy = y - my,
      dz = z - mz + up,
      l = Math.hypot(dx, dy, dz) || 1;
    f[o >> 2] = x;
    f[(o >> 2) + 1] = y;
    f[(o >> 2) + 2] = z;
    out[o + 12] = bin[b + 3];
    out[o + 13] = bin[b + 4];
    out[o + 14] = bin[b + 5];
    out[o + 15] = 255; // scale
    normal[o + 20] = Math.round((dx / l) * 127);
    normal[o + 21] = Math.round((dy / l) * 127);
    normal[o + 22] = Math.round((dz / l) * 127);
  }
  return out;
}

// ---- sources ------------------------------------------------------------------------
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";
const firstChar = (block, row) => ALPHABET[(block.keys[row * block.keyWords] >>> 26) & 63];
/**
 * Read the collection through the Indexus network (SDK Network), every read
 * through the shared scheduler (layer "vegetation").
 */
/** A simulated network latency (?vegDelay, ms) before a read goes out; cancelled with it. */
export const latency = (ms, signal) =>
  ms > 0
    ? new Promise((resolve, reject) => {
        const t = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => (clearTimeout(t), reject(Object.assign(Error("cancelled"), { name: "AbortError" }))), { once: true });
      })
    : null;
/**
 * collection: the name of the scene's catalogue entry (no default); delay:
 * simulated latency per read (ms, ?vegDelay); zonesAt(depth): the zones of a
 * level over the scene (vegetationZones.js), for the start read.
 */
export function networkSource(network, collection, scheduler = sharedScheduler, { delay = 0, zonesAt = undefined } = {}) {
  if (typeof collection !== "string" || !collection) throw Error("végétation : collection non nommée (catalogue de la scène)");
  const LAYER = "vegetation";
  return {
    bytes: 0,
    requests: 0,
    zonesAt,
    work: (fn, priority) => scheduler.work(LAYER, fn, priority),
    pass: () => scheduler.pass(LAYER),
    /** zones -> Map(zone -> [{location, sums}]): one /sets read (f64 metrics) for many zones */
    children(zones, priority = 0) {
      return scheduler.request(LAYER, "sets/" + zones.join(","), (signal) => this.readChildren(zones, signal), {
        priority,
        size: (out) => out.bytes,
      });
    },
    async readChildren(zones, signal) {
      await latency(delay, signal);
      this.requests++;
      const answer = await network.getSets(collection, zones, { raw: true, metrics: "f64", signal });
      if (answer.format !== "block") throw Error("Indexus node too old for vegetation blocks");
      const out = new Map(zones.map((z) => [z, new Map()]));
      let bytes = 0;
      for (const response of answer.responses) {
        bytes += response.buffer?.byteLength ?? 0;
        for (const block of response.blocks) {
          const zone = block.parent || "@",
            groups = out.get(zone);
          if (!groups || block.suffixChars < 1) continue;
          const prefix = zone === "@" ? "" : zone;
          for (let row = 0; row < block.n; row++) {
            const child = prefix + firstChar(block, row);
            let s = groups.get(child);
            if (!s) groups.set(child, (s = new Float64Array(METRICS)));
            for (let j = 0; j < Math.min(METRICS, block.metricCount); j++)
              s[j] += block.metrics[j * block.n + row];
          }
        }
      }
      this.bytes += bytes;
      for (const zone of answer.unresolved ?? []) out.delete(zone);
      const result = new Map(
        [...out].map(([zone, groups]) => [
          zone,
          [...groups].filter(([, s]) => s[0] > 0).map(([location, sums]) => ({ location, sums })),
        ]),
      );
      result.bytes = bytes;
      return result;
    },
    /** 8 m zone -> Map(2 m location -> payload) */
    returns(zone, priority = 0) {
      return scheduler.request(
        LAYER,
        "rec/" + zone,
        async (signal) => {
          await latency(delay, signal);
          this.requests++;
          const rows = await network.getContentRecords(collection, zone, 64, { signal }),
            out = new Map();
          let bytes = 0;
          for (const row of rows) {
            out.set(row.location, row.payload);
            bytes += row.payload.length;
          }
          this.bytes += bytes;
          out.bytes = bytes;
          return out;
        },
        { priority, size: (out) => out.bytes },
      );
    },
  };
}
/** Same answers from an NDJSON export (lab, tests): the tree's sums, folded locally. */
export function recordsSource(text) {
  const payloads = new Map(),
    zones = new Map();
  let leaf = LEAF_DEPTH; // the records' depth: 5, or more in a commune's Space
  for (const line of text.split("\n")) {
    if (!line) continue;
    const r = JSON.parse(line);
    payloads.set(r.Location, r.Payload);
    leaf = r.Location.length;
    for (let d = 1; d <= r.Location.length; d++) {
      const key = r.Location.slice(0, d);
      let s = zones.get(key);
      if (!s) zones.set(key, (s = new Float64Array(METRICS)));
      r.Metrics.forEach((v, j) => (s[j] += v));
    }
  }
  const under = (zone, depth) => {
    const prefix = zone === "@" ? "" : zone;
    return [...zones].filter(([l]) => l.length === depth && l.startsWith(prefix));
  };
  return {
    bytes: 0,
    requests: 0,
    async children(list) {
      this.requests++;
      const out = new Map();
      for (const zone of list) {
        const rows = under(zone, zone === "@" ? 1 : zone.length + 1).map(([location, sums]) => ({ location, sums }));
        this.bytes += rows.length * (8 + METRICS * 8);
        out.set(zone, rows);
      }
      return out;
    },
    async returns(zone) {
      this.requests++;
      const out = new Map(under(zone, leaf).map(([l]) => [l, payloads.get(l)]));
      for (const p of out.values()) this.bytes += p.length;
      return out;
    },
  };
}

// ---- budgeted tree --------------------------------------------------------------------
class Cell {
  constructor(location, depth, sums, parent = null) {
    this.location = location;
    this.depth = depth;
    this.parent = parent;
    this.g = gaussian(sums, depth, parent?.g.mean);
    [this.x, this.y, this.z] = this.g.mean; // read by every walk
    this.radius = this.g.radius;
    this.inside = 0; // frustum at the last select: 0 outside, 1 crossing, 2 inside with all below it
    this.children = null; // Cell[] from /sets (depth < 5)
    this.returns = null; // Uint8Array from /records (depth 5)
    this.state = 0; // children (or, at depth 4, their returns too): 0 idle, 1 loading, 2 ready, 3 failed
    this.returnsState = 0; // depth 4: returns of its voxels
    this.used = 0; // last select that saw it
    this.refined = 0; // last select that drew its children
    this.px = 0; // size on screen at that select
    this.scale = 1; // gate: share of its size drawn (0..1)
    // fades in time (fadeMs): the share its children take of it goes from k0 to k1 from kAt (ms);
    // k1 < 0: never drawn. fm: per walk parity (2 bits each), 0 drawn whole, 1 shared, 2 children only
    this.k0 = 0;
    this.k1 = -1;
    this.kAt = -Infinity;
    this.fm = 0;
    this.shown = -1; // fades in time, a root: first drawn (ms), it fades in from there
    this.faded = 0; // fades in time: last walk that drew it for its parent's fade out (not `used`)
    this.pStamp = 0; // refade's memo: the share's upper end below which its children are drawn
    this.pVal = 0;
  }
}

/** Cells by size on screen, largest first: 64 buckets per octave from 1/4 px (the order inside a bucket is free). */
class Queue {
  buckets = Array.from({ length: 1024 }, () => []);
  counts = new Int32Array(1024); // the buckets keep their storage from one walk to the next
  top = -1;
  push(cell) {
    const b = Math.max(0, Math.min(1023, ((Math.log2(cell.px) + 2) * 64) | 0));
    this.buckets[b][this.counts[b]++] = cell;
    if (b > this.top) this.top = b;
  }
  pop() {
    for (; this.top >= 0; this.top--) if (this.counts[this.top]) return this.buckets[this.top][--this.counts[this.top]];
  }
  clear() {
    this.counts.fill(0);
    this.top = -1;
  }
}

/**
 * select(camera) returns what to draw:
 *   instances: Float32Array, INSTANCE_FLOATS per drawn cell (slot, lo, hi, scale)
 *   store:     the CellStore the slots point into (fixed part of every cell)
 *   leaves:    the voxels drawn with their returns (LeafList), in the ReturnStore `returnStore`
 *   returns:   (getter) Uint8Array, RETURN_BYTES each: the leaves' returns as drawn
 *   cells:     (getter) the drawn cells in the full CELL_FLOATS layout
 * Options: budget (drawn items), returnCost (one return against one cell),
 * floor (px: a cell smaller than this is never refined), band (cross-fade
 * width), maxCells / maxReturns (kept in memory), maxLoads, batch.
 */
export class VegetationTree {
  constructor(source, options = {}) {
    Object.assign(
      this,
      {
        budget: 40000,
        returnCost: 0.5,
        floor: 4,
        band: 1.5,
        maxCells: 160000, // about 40 MB of cells in the JS heap
        maxReturns: 400000, // 9.6 MB
        maxLoads: 24,
        batch: 96,
        top: 0, // levels of the Space above the 2 km cube (a commune's)
        fade: "cell", // ?vegFade: "pixel" for fades worked out per pixel by the shader (no rows of cells at different stages)
        mode: "dither", // ?veg: canopy hands the coarse cells to the caller (selection.coarse) instead of drawing them
        // deepest level used (?vegMaxDepth): 1..5 cells of 512, 128, 32, 8, 2 m drawn at most, 6 the returns too (all)
        maxDepth: LEAF_DEPTH + 1,
        // levels read for the whole Space as soon as the root is there, before the view asks (?vegPrefetch; 0: none)
        prefetch: 0,
        // zones per /sets of the read at start (prefetch)
        prefetchBatch: 192,
        // levels coarser than this (from the 2 km cube) are walked, never drawn (?vegMinDraw): 3, the
        // 32 m cells, the first a crown can be drawn from; the 128 m ones and above (the commune's
        // 2 and 8 km among them) left the ortho alone. A cell drawn with nothing above it fades in.
        minDraw: -Infinity,
        appear: 600, // ms of that fade
        // fades in time (?vegFadeMs, fades per cell): when a cell's children (or a voxel's returns)
        // arrive, or it stops being refined, or its share jumps, the dither threshold between it and
        // its children moves over fadeMs (smoothstep) instead of at once; 0: as before
        fadeMs: 0,
        movingLoads: Infinity, // reads in flight at most while the camera moves fast (Infinity: maxLoads, as before)
        movingDepth: Infinity, // while it moves fast, the children of cells only up to this depth are read (Infinity: all, as before)
      },
      options,
      { source },
    );
    this.root = null;
    this.loading = 0;
    this.frame = 0;
    this.queue = new Queue();
    this.cellCount = 0;
    this.returnCount = 0;
    this.onChange = null;
    this.stats = {};
    this.store = new CellStore();
    this.returnStore = new ReturnStore();
    this.instances = new Float32Array(INSTANCE_FLOATS * 1024);
    // fades in time: a walk's instances and their cells, by walk parity (the frames of the next
    // walk still move the fades of the last one)
    this.instancePair = [this.instances, null];
    this.instanceCells = [[], []];
    this.drawn = null; // the last walk's: { parity, n, instances, cells, leaves }
    this.fadingUntil = -Infinity; // ms: the fades in time are over then
    this.refadedAt = -Infinity;
    this.fadeStamp = 0;
    this.leafLists = [new LeafList(), new LeafList()]; // a walk's and the one before it
    // the root is asked again while the collection answers nothing (still being imported, node starting)
    let wait = 2000;
    this.t0 = performance.now(); // the time base of the fades in (instances carry a birth in s from it)
    this.lastBirth = -Infinity;
    // the levels of the start read whose zones the source can list (zonesAt): asked with the root
    const direct = this.prefetch && this.source.zonesAt ? this.readDirect() : null;
    const root = () =>
      this.source.children(["@"], 1e9).then(
        (m) => {
          const rows = m.get("@") ?? [];
          if (rows.length) {
            this.root = this.adopt(null, rows);
            this.onChange?.();
            if (direct) this.prefetched = this.adoptDirect(direct);
            else if (this.prefetch) this.prefetched = this.prefetchLevels(this.root, this.prefetch);
          } else setTimeout(root, (wait = Math.min(wait * 2, 30000)));
        },
        () => setTimeout(root, (wait = Math.min(wait * 2, 30000))),
      );
    this.ready = root();
  }
  /**
   * The start read with the zones known in advance (source.zonesAt(depth): the
   * Space's locations over the scene, vegetationZones.js): every level down to
   * `prefetch` asked at once, with the root, at the highest priority; a level
   * the source will not list (too many zones) and the ones below are left to
   * the walks. Returns one promise per level: Map(zone -> rows).
   */
  readDirect() {
    const levels = [];
    for (let d = 1 - this.top; d < Math.min(this.prefetch, LEAF_DEPTH); d++) {
      const zones = this.source.zonesAt(d);
      if (!zones?.length) break;
      levels.push(zones);
    }
    const batch = this.prefetchBatch;
    return levels.map((zones) =>
      Promise.all(
        Array.from({ length: Math.ceil(zones.length / batch) }, (_, i) => {
          this.loading++;
          return this.source
            .children(zones.slice(i * batch, (i + 1) * batch), 1e8)
            .catch(() => new Map())
            .finally(() => this.loading--);
        }),
      ).then((maps) => new Map(maps.flatMap((m) => [...m]))),
    );
  }
  /** The start read's levels into the tree, in order, as they arrive (a cell already read keeps its children). */
  async adoptDirect(levels) {
    const t0 = performance.now();
    let level = this.root;
    for (const pending of levels) {
      const answer = await pending;
      for (const cell of level)
        if (cell.state !== 2 && cell.state !== -1 && answer.has(cell.location)) {
          cell.children = this.adopt(cell, answer.get(cell.location));
          cell.state = 2;
        }
      level = level.flatMap((c) => c.children ?? []);
      this.onChange?.();
    }
    return { ms: Math.round(performance.now() - t0), bytes: this.source.bytes, requests: this.source.requests, levels: levels.length };
  }
  /**
   * Read every cell down to `depth` (from the 2 km cube) for the whole Space,
   * level by level, in large batches at the highest priority: the coarse levels
   * of a commune (32 m: about 2 MB for Anglet) are there before the view asks.
   */
  async prefetchLevels(cells, depth) {
    const t0 = performance.now();
    let level = cells;
    while (level.length && level[0].depth < Math.min(depth, LEAF_DEPTH)) {
      const todo = level.filter((c) => c.state === 0),
        batch = this.batch * 4;
      for (const c of todo) c.state = 1;
      await Promise.all(
        Array.from({ length: Math.ceil(todo.length / batch) }, (_, i) => {
          const group = todo.slice(i * batch, (i + 1) * batch);
          this.loading++;
          return this.source
            .children(
              group.map((c) => c.location),
              1e8,
            )
            .then((map) => {
              for (const cell of group) {
                if (cell.state !== 1) continue;
                const rows = map.get(cell.location);
                cell.state = rows ? 2 : 0;
                if (rows) cell.children = this.adopt(cell, rows);
              }
            })
            .catch(() => group.forEach((c) => c.state === 1 && (c.state = 0)))
            .finally(() => {
              this.loading--;
              this.onChange?.();
            });
        }),
      );
      level = level.flatMap((c) => c.children ?? []);
    }
    return { ms: Math.round(performance.now() - t0), bytes: this.source.bytes, requests: this.source.requests };
  }
  adopt(parent, rows) {
    this.cellCount += rows.length;
    // depth from the 2 km cube: the root's children are 1 - top
    return rows.map((r) => new Cell(r.location, (parent?.depth ?? -this.top) + 1, r.sums, parent));
  }
  /** Ask for what the walk wants, largest on screen first; the scheduler orders it against the other layers. */
  load(queue, limit = this.maxLoads) {
    queue.sort((a, b) => b[0] - a[0]);
    const zones = [],
      done = () => {
        this.loading--;
        this.onChange?.();
      },
      // a failed read is asked again later (state 3 keeps the time it failed)
      failed = (cell, key, error) => {
        if (isCancelled(error)) cell[key] = 0;
        else {
          cell[key] = 3;
          cell.failedAt = performance.now();
          console.warn("vegetation", cell.location, error);
        }
      };
    for (const [px, cell, returns] of queue) {
      if (this.loading >= limit) break;
      if (returns) {
        if (cell.returnsState !== 0) continue;
        cell.returnsState = 1;
        this.loading++;
        const work = (fn) => this.source.work?.(fn, px) ?? fn();
        this.source
          .returns(cell.location, px)
          .then((payloads) =>
            Promise.all(
              cell.children.map(async (child) => {
                const payload = payloads.get(child.location);
                if (!payload || cell.returnsState !== 1) return;
                child.returns = await work(() => decodeReturns(payload, child.g));
                this.returnCount += child.g.n;
              }),
            ),
          )
          .then(() => {
            if (cell.returnsState === 1) cell.returnsState = 2;
          })
          .catch((e) => cell.returnsState === 1 && failed(cell, "returnsState", e))
          .finally(done);
      } else if (cell.state === 0 && zones.length < this.batch * 4) {
        cell.state = 1;
        cell.want = px;
        zones.push(cell);
      }
    }
    for (let i = 0; i < zones.length; i += this.batch) {
      const group = zones.slice(i, i + this.batch);
      this.loading++;
      this.source
        .children(
          group.map((c) => c.location),
          group[0].want,
        )
        .then((map) => {
          for (const cell of group) {
            if (cell.state !== 1) continue;
            const rows = map.get(cell.location);
            cell.state = rows ? 2 : 0; // unresolved: ask again
            if (rows) cell.children = this.adopt(cell, rows);
          }
        })
        .catch((e) => {
          for (const cell of group) if (cell.state === 1) failed(cell, "state", e);
        })
        .finally(done);
    }
  }
  /** Forget the least recently drawn subtrees and returns beyond the memory caps. */
  /**
   * The LiDAR points the screen stands for: every point under the cells this walk stopped at
   * (a cell not refined, a leaf whose returns are drawn); the children of a refined cell out of
   * view are not on screen. No allocation (the walk's own stack).
   */
  covered(frame) {
    const stack = (this.coverStack ??= []);
    let n = 0,
      top = 0;
    for (const cell of this.root ?? []) if (cell.used === frame) stack[top++] = cell;
    while (top > 0) {
      const cell = stack[--top];
      let down = false;
      if (cell.refined === frame && cell.depth < LEAF_DEPTH && cell.children)
        for (const child of cell.children)
          if (child.used === frame) {
            stack[top++] = child;
            down = true;
          }
      if (!down) n += cell.g.n;
    }
    return n;
  }
  trim() {
    if (this.cellCount <= this.maxCells && this.returnCount <= this.maxReturns) return;
    const stale = [];
    const walk = (cell) => {
      if (!cell.children) return;
      // the coarse levels stay (cells down to 128 m keep their children): they are few
      // (a few thousand over a commune) and every dezoom read them again (up to 15 times
      // in a 6 min tour of Anglet, the stale subtree going from the top)
      if (cell.used < this.frame && cell.depth >= KEEP_DEPTH) stale.push(cell);
      else cell.children.forEach(walk);
    };
    this.root?.forEach(walk);
    stale.sort((a, b) => a.used - b.used);
    const drop = (cell) => {
      for (const child of cell.children ?? []) {
        drop(child);
        this.cellCount--;
        if (child.slot !== undefined) this.store.release(child.slot);
        child.slot = undefined;
        if (child.blocks) this.returnStore.release(child);
        if (child.returns) this.returnCount -= child.g.n;
        child.state = child.returnsState = -1; // gone: a read still in flight is ignored
      }
      cell.children = null;
      cell.state = cell.returnsState = 0;
    };
    for (const cell of stale) {
      if (this.cellCount <= this.maxCells * 0.8 && this.returnCount <= this.maxReturns * 0.8) break;
      drop(cell);
    }
  }
  /**
   * Fades in time: the cell's share toward `target`, from where it is now (no jump). A change in
   * the same direction while it fades keeps its pace; a reversal, or a change once it is over,
   * starts a fade of fadeMs (one smaller than eps, the camera moving, is followed at once).
   * Returns the share now.
   */
  retarget(cell, target, now, eps = 0) {
    if (cell.k1 < 0) {
      // first drawn: as it is (its parent, if any, was drawn whole until now)
      cell.k0 = cell.k1 = target;
      cell.kAt = -Infinity;
      return target;
    }
    const p = Math.min(Math.max((now - cell.kAt) / this.fadeMs, 0), 1),
      e = p * p * (3 - 2 * p),
      v = cell.k0 + (cell.k1 - cell.k0) * e;
    if (target === cell.k1) return v;
    if (p >= 1) {
      if (Math.abs(target - v) <= eps) {
        cell.k0 = cell.k1 = target;
        return target;
      }
    } else if ((target - v) * (cell.k1 - v) > 0 && e < 0.9) {
      // the same way: the same fade, toward the new target, from where it is
      cell.k1 = target;
      cell.k0 = (v - target * e) / (1 - e);
      return v;
    }
    cell.k0 = v;
    cell.k1 = target;
    cell.kAt = now;
    if (now + this.fadeMs > this.fadingUntil) this.fadingUntil = now + this.fadeMs;
    return v;
  }
  /** True while the last walk's fades in time still move (a frame more, refade, is wanted). */
  fading() {
    return this.drawn !== null && this.refadedAt < this.fadingUntil;
  }
  /**
   * The last walk's fades at `now` (ms): each drawn cell's interval [P, top), each drawn voxel's
   * returns [0, P), in place (instances, leaves.fades). No allocation: a frame's work while fading.
   */
  refade(now = performance.now()) {
    const d = this.drawn;
    if (!d) return;
    this.fadeNow = now;
    this.fadeShift = d.parity * 2;
    this.fadeStamp++;
    const { instances, cells, leaves } = d;
    for (let i = 0; i < d.n; i++) {
      const cell = cells[i],
        o = i * INSTANCE_FLOATS;
      instances[o + 1] = this.lower(cell);
      instances[o + 2] = cell.parent ? this.lower(cell.parent) : this.appearOf(cell);
    }
    for (let i = 0; i < leaves.length; i++) leaves.fades[i] = (Math.round(Math.min(Math.max(this.lower(leaves.cells[i]), 0), 1) * 65535) << 16) >>> 0;
    this.refadedAt = now;
  }
  /** A root fading in from when it was first drawn (0..1). */
  appearOf(cell) {
    const p = Math.min(Math.max((this.fadeNow - cell.shown) / this.fadeMs, 0), 1);
    return p * p * (3 - 2 * p);
  }
  /** P: the upper end of its children's interval (its own lower end) at refade's time. */
  lower(cell) {
    if (cell.pStamp === this.fadeStamp) return cell.pVal;
    const top = cell.parent ? this.lower(cell.parent) : this.appearOf(cell),
      fm = (cell.fm >> this.fadeShift) & 3;
    let share = fm === 2 ? 1 : 0;
    if (fm === 1) {
      const p = Math.min(Math.max((this.fadeNow - cell.kAt) / this.fadeMs, 0), 1);
      share = Math.min(Math.max(cell.k0 + (cell.k1 - cell.k0) * p * p * (3 - 2 * p), 0), 1);
    }
    cell.pStamp = this.fadeStamp;
    return (cell.pVal = share * top);
  }
  /**
   * camera: {eye:[3], planes: Float64Array(24) (a,b,c,d inward), focal: px of 1 m at 1 m,
   * gate?: {reach (m), leaf(cell, distance) -> scale 0..1 or -1}}
   */
  select(camera) {
    const walk = this.steps(camera);
    for (;;) {
      const step = walk.next();
      if (step.done) return step.value;
    }
  }
  /** The walk as a generator that yields every few hundred cells (see BuildingsTree.steps). */
  *steps(camera) {
    this.source.pass?.(); // reads asked before and not asked again in this walk leave the queue
    const { eye, planes, focal, gate = null, matrix = null } = camera,
      frame = ++this.frame,
      { queue: heap, floor, budget, maxDepth } = this,
      queue = [],
      stats = { byDepth: [0, 0, 0, 0, 0, 0] };
    const visible = (c) => {
      const r = 1.2 * c.radius,
        all = 2.4 * cellSize(c.depth); // reaches every cell below it
      let inside = 2;
      for (let i = 0; i < 24; i += 4) {
        const d = planes[i] * c.x + planes[i + 1] * c.y + planes[i + 2] * c.z + planes[i + 3];
        if (d < -r) return 0;
        if (d < all) inside = 1;
      }
      return inside;
    };
    // reads: the centre of the view first (1 at the centre, 1/2 at the edge of the screen)
    const centrality = (c) => {
      if (!matrix) return 1;
      const w = matrix[3] * c.x + matrix[7] * c.y + matrix[11] * c.z + matrix[15];
      if (w <= 0) return 0.25;
      return 1 / (1 + Math.hypot((matrix[0] * c.x + matrix[4] * c.y + matrix[8] * c.z + matrix[12]) / w, (matrix[1] * c.x + matrix[5] * c.y + matrix[9] * c.z + matrix[13]) / w));
    };
    let spent = 0,
      tau = floor; // size on screen where the budget ran out
    const push = (list, inside) => {
      for (const cell of list) {
        if (!(cell.inside = inside === 2 ? 2 : visible(cell))) continue;
        const x = cell.x - eye[0],
          y = cell.y - eye[1],
          z = cell.z - eye[2],
          d = Math.sqrt(x * x + y * y + z * z);
        if (gate) {
          // nothing of it can be drawn beyond the gate's reach; a leaf asks the gate
          if (cell.depth < LEAF_DEPTH ? d - 1.75 * cellSize(cell.depth) > gate.reach : (cell.scale = gate.leaf(cell, d)) < 0) continue;
        } else cell.scale = 1;
        cell.px = (cellSize(cell.depth) * focal) / Math.max(d - cell.radius, 0.5);
        cell.distance = d;
        cell.used = frame;
        if (cell.px > floor && cell.depth < maxDepth) heap.push(cell); // smaller (or deeper than maxDepth allows): never refined
        spent++;
      }
    };
    // 1. best first: refine the largest cells until the budget is spent
    if (this.root) push(this.root, 1);
    let tick = 0;
    for (let cell; (cell = heap.pop()); ) {
      if ((++tick & 63) === 0) yield;
      const leaf = cell.depth === LEAF_DEPTH,
        voxel = leaf ? cell.parent : cell;
      // a failed read is asked again 5 s later
      const now = performance.now();
      if (cell.state === 3 && now - cell.failedAt > 5000) cell.state = 0;
      if (leaf && voxel.returnsState === 3 && now - voxel.failedAt > 5000) voxel.returnsState = 0;
      if (cell.state === 3 || (leaf && voxel.returnsState === 3)) continue;
      const ready = leaf ? !!cell.returns : cell.state === 2,
        cost = leaf ? cell.g.n * this.returnCost : ready ? cell.children.length : 8;
      if (spent + cost > budget) {
        tau = Math.max(tau, cell.px); // the largest cell left
        if (budget - spent < budget / 100) break; // nothing worth fitting in what is left
        continue;
      }
      if (!ready) {
        // not here yet: its place in the budget is kept, the cell is drawn meanwhile
        spent += cost;
        if (leaf ? voxel.returnsState === 0 : cell.state === 0) queue.push([cell.px * centrality(cell), voxel, leaf]);
        continue;
      }
      cell.refined = frame;
      if (leaf) spent += cost;
      else push(cell.children, cell.inside);
    }
    heap.clear();
    // fades in time: memory trimmed before the emit, as the walk's reads left it (the cells kept for
    // a fade out are not counted as used: what is held stays as without fades; a fade out whose
    // cells were trimmed ends at once)
    const fadesInTime = this.fadeMs > 0 && this.fade !== "pixel" && !gate && this.mode !== "canopy" && this.mode !== "crowns";
    if (fadesInTime) this.trim();
    // 2. emit: a refined cell cross-fades with its children over [tau, tau * band]
    const store = this.store,
      returnStore = this.returnStore,
      leaves = this.leafLists[frame & 1];
    leaves.length = 0;
    const parity = frame & 1,
      temporal = fadesInTime,
      instCells = this.instanceCells[parity],
      shift = parity * 2,
      // the camera still since the last walk: every change of share fades; on the move, small ones follow it
      still = !this.lastEye || (eye[0] === this.lastEye[0] && eye[1] === this.lastEye[1] && eye[2] === this.lastEye[2]),
      eps = still ? 0 : FOLLOW;
    let instances = temporal ? (this.instancePair[parity] ??= new Float32Array(INSTANCE_FLOATS * 1024)) : this.instances,
      nCells = 0,
      nReturns = 0;
    const band = this.band,
      pixel = this.fade === "pixel",
      fadeOf = (px) => {
        const t = Math.min(Math.max((px - tau) / (tau * (band - 1)), 0), 1);
        return t * t * (3 - 2 * t);
      },
      instance = (cell, a, b) => {
        if ((nCells + 1) * INSTANCE_FLOATS > instances.length) {
          const grown = new Float32Array(instances.length * 2);
          grown.set(instances);
          instances = grown;
        }
        cell.slot ??= store.alloc(cell.g.row, cellSize(cell.depth));
        const o = nCells++ * INSTANCE_FLOATS;
        instances[o] = cell.slot;
        instances[o + 1] = a;
        instances[o + 2] = b;
        instances[o + 3] = cell.scale;
        stats.byDepth[Math.max(0, cell.depth)]++;
      },
      // fades per pixel (?vegFade=pixel): the shader works the shares out where it draws
      // (vegetationGPU.js shareAt); the walk says which levels are drawn over a cell: the
      // cell unless its children take all of it at its farthest point, its children when
      // they are there and take some of it at its nearest. Instance: slot, flags
      // (1: its children drawn, 2: its parent drawn), birth (s from t0, when it fades
      // in; -1e9: not fading in), scale.
      now = performance.now(),
      // fades in time: the cell's share of its children goes toward its target (its spatial fade when
      // refined, 0 else); it is drawn [P, top), its children [0, P) (P = share x top, worked out by
      // refade at each frame); a cell no longer refined keeps its children drawn while they fade out
      emitTemporal = (cell) => {
        const leaf = cell.depth === LEAF_DEPTH;
        let target = 0;
        if (cell.refined === frame) {
          target = fadeOf(cell.px);
          if (target < 1 / 256) target = 0;
          else if (target > 1 - 1 / 256) target = 1;
        }
        const has = leaf ? !!cell.returns : cell.state === 2 && !!cell.children;
        if (cell.parent === null && cell.shown < 0) {
          cell.shown = now;
          if (now + this.fadeMs > this.fadingUntil) this.fadingUntil = now + this.fadeMs;
        }
        let fm = 0;
        if (has) {
          const v = this.retarget(cell, target, now, eps),
            lo = Math.min(v, cell.k1),
            hi = Math.max(v, cell.k1);
          fm = hi <= 0 ? 0 : lo >= 1 ? 2 : 1;
        } else {
          cell.k0 = cell.k1 = 0;
          cell.kAt = -Infinity;
        }
        cell.fm = (cell.fm & ~(3 << shift)) | (fm << shift);
        if (fm !== 2) {
          instCells[nCells] = cell;
          instance(cell, 0, 1);
        }
        if (fm === 0) return;
        if (!leaf) {
          // fading out: its children drawn as they were, not walked (nothing read for them)
          // (marked apart from `used`: what trimming keeps does not change with the fades)
          if (cell.refined !== frame) for (const child of cell.children) child.faded = frame;
          return void into(cell, 0, 0);
        }
        cell.blocks ??= returnStore.alloc(cell);
        leaves.push(cell, 0, Math.round(cell.scale * 255));
        nReturns += cell.returns.length / RETURN_BYTES;
      },
      emitPixel = (cell, parentDrawn) => {
        const side = cellSize(cell.depth),
          reach = 1.2 * side;
        let down = cell.refined === frame,
          self = true,
          share = 1; // its own share, the mean over it (canopy)
        if (down) {
          const near = fadeOf((side * focal) / Math.max(cell.distance - reach, 0.5)),
            far = fadeOf((side * focal) / (cell.distance + reach));
          down = near > 0;
          self = !down || far < 1;
          if (down) share = 1 - (near + far) / 2;
        }
        // coarser than minDraw: walked through, not drawn (its children have nothing drawn above them)
        if (cell.depth < this.minDraw) self = false;
        if (self) {
          // drawn with nothing above it for the first time: it fades in from its birth (s from t0)
          let birth = -1e9;
          if (cell.born === undefined) {
            cell.born = now;
            if (!parentDrawn) this.lastBirth = now;
          }
          if (!parentDrawn && now - cell.born < this.appear) birth = (cell.born - this.t0) / 1000;
          if (split && cell.depth < LEAF_DEPTH) {
            coarse.cells.push(cell);
            coarse.weights.push(share * (birth > -1e9 ? Math.min(1, (now - cell.born) / this.appear) : 1));
            stats.byDepth[Math.max(0, cell.depth)]++;
          } else instance(cell, (down ? 1 : 0) | (parentDrawn ? 2 : 0), birth);
        }
        if (!down) return;
        if (cell.depth < LEAF_DEPTH) return void into(cell, self ? 1 : 0, 0);
        cell.blocks ??= returnStore.alloc(cell);
        // the returns' fade: lo 1 where their voxel is still drawn, hi all
        leaves.push(cell, ((self ? 1 : 0) | (65535 << 16)) >>> 0, Math.round(cell.scale * 255));
        nReturns += cell.returns.length / RETURN_BYTES;
      },
      split = this.mode === "canopy",
      coarse = { cells: [], weights: [] };
    // depth first, children in order, without a generator per cell: an explicit stack
    // (one frame per depth: the cell, the interval its children share, the next child)
    const stack = [],
      stackLo = new Float64Array(LEAF_DEPTH + 1 + this.top),
      stackHi = new Float64Array(LEAF_DEPTH + 1 + this.top),
      next = new Int32Array(LEAF_DEPTH + 1 + this.top);
    let top = -1;
    const into = (cell, lo, hi) => {
      top++;
      stack[top] = cell;
      stackLo[top] = lo;
      stackHi[top] = hi;
      next[top] = 0;
    };
    const emit = (cell, lo, hi) => {
      if (gate && cell.depth < LEAF_DEPTH) {
        // gated: coarse cells are not drawn (crowns are), only walked through
        if (cell.refined === frame) into(cell, lo, hi);
        return;
      }
      if (cell.scale <= 0) return; // its crown is still drawn
      if (pixel) return emitPixel(cell, lo);
      if (temporal) return emitTemporal(cell);
      let mid = lo;
      if (cell.refined === frame) {
        const t = Math.min(Math.max((cell.px - tau) / (tau * (band - 1)), 0), 1);
        mid = lo + t * t * (3 - 2 * t) * (hi - lo);
        if (mid - lo < 1 / 256) mid = lo;
        else if (hi - mid < 1 / 256) mid = hi;
      }
      if (mid < hi && split && cell.depth < LEAF_DEPTH) {
        // split (canopy): coarse cells handed to the caller with their share, not drawn
        coarse.cells.push(cell);
        coarse.weights.push(hi - mid);
        stats.byDepth[Math.max(0, cell.depth)]++;
      } else if (mid < hi) {
        if ((nCells + 1) * INSTANCE_FLOATS > instances.length) {
          const grown = new Float32Array(instances.length * 2);
          grown.set(instances);
          instances = grown;
        }
        cell.slot ??= store.alloc(cell.g.row, cellSize(cell.depth));
        const o = nCells++ * INSTANCE_FLOATS;
        instances[o] = cell.slot;
        instances[o + 1] = mid;
        instances[o + 2] = hi;
        instances[o + 3] = cell.scale;
        stats.byDepth[Math.max(0, cell.depth)]++;
      }
      if (mid === lo) return;
      if (cell.depth < LEAF_DEPTH) {
        into(cell, lo, mid);
        return;
      }
      // the voxel's returns stay where they are (its blocks); the walk hands its fade and scale
      cell.blocks ??= returnStore.alloc(cell);
      leaves.push(cell, (Math.round(lo * 65535) | (Math.round(mid * 65535) << 16)) >>> 0, Math.round(cell.scale * 255));
      nReturns += cell.returns.length / RETURN_BYTES;
    };
    for (const root of this.root ?? []) {
      if (root.used !== frame) continue;
      if ((++tick & 255) === 0) yield;
      emit(root, 0, 1);
      while (top >= 0) {
        const children = stack[top].children;
        let i = next[top];
        while (i < children.length && children[i].used !== frame && children[i].faded !== frame) i++;
        if (i === children.length) {
          stack[top--] = null;
          continue;
        }
        next[top] = i + 1;
        if ((++tick & 255) === 0) yield;
        emit(children[i], stackLo[top], stackHi[top]);
      }
    }
    if (temporal) {
      this.instancePair[parity] = instances;
      instCells.length = nCells;
      this.drawn = { parity, n: nCells, instances, cells: instCells, leaves };
    } else {
      this.instances = instances;
      this.drawn = null;
    }
    leaves.cells.length = leaves.fades.length = leaves.scales.length = leaves.length;
    if (temporal) this.refade(performance.now());
    // a camera on the move fast (a zoom, a flight faster than its height per second; a pan at
    // reading speed is not): the views it passes through are read only
    // down to movingDepth (their coarse cells) and with movingLoads reads at most; once it slows,
    // everything. Prod: no limit (movingDepth Infinity).
    const t = performance.now(),
      height = Math.max(Math.abs(eye[2] - (this.root?.[0]?.z ?? 0)), 1),
      dt = Math.max((t - (this.lastWalkAt ?? t)) / 1000, 1e-3),
      moved = this.lastEye ? Math.hypot(eye[0] - this.lastEye[0], eye[1] - this.lastEye[1]) : 0,
      // flying: the ground passing faster than its height per second; zooming: the height changing by a quarter per second
      flying = this.lastEye && moved / height / dt > 1,
      zooming = this.lastEye && Math.abs(Math.log(height / this.lastHeight)) / dt > 0.25;
    this.lastEye = [eye[0], eye[1], eye[2]];
    this.lastHeight = height;
    this.lastWalkAt = t;
    // fast for 300 ms after the last fast walk (a few slow frames inside a flight do not read all)
    if (flying || zooming) this.fastUntil = t + 300;
    this.moving = t < (this.fastUntil ?? 0);
    if (this.moving && this.movingDepth < Infinity) {
      let n = 0;
      for (const item of queue) if (item[1].depth < this.movingDepth && !item[2]) queue[n++] = item;
      // reads held back: a walk again once the camera has slowed (nothing else would ask for one
      // when it stops: no move, no data arriving), the walk after reads them
      if (n < queue.length) {
        clearTimeout(this.deferred);
        this.deferred = setTimeout(() => this.onChange?.(), this.fastUntil - t + 20);
      }
      queue.length = n;
    }
    this.load(queue, this.moving ? Math.min(this.movingLoads, this.maxLoads) : this.maxLoads);
    if (!fadesInTime) this.trim();
    this.stats = Object.assign(stats, {
      cells: nCells,
      returns: nReturns,
      covered: this.covered(frame),
      spent: Math.round(spent),
      tau: +tau.toFixed(1),
      loading: this.loading,
      held: [this.cellCount, this.returnCount],
      bytes: this.source.bytes,
      requests: this.source.requests,
    });
    return {
      instances: instances.subarray(0, nCells * INSTANCE_FLOATS),
      store,
      leaves,
      returnStore,
      coarse, // split (canopy): the coarse cells not drawn, and their shares
      /** The drawn returns as one array (RETURN_BYTES each): tests and tools, not the renderer. */
      get returns() {
        return leaves.bytes();
      },
      stats,
      /** The drawn cells in the full layout (CELL_FLOATS each): tests and tools, not the renderer. */
      get cells() {
        return cellRows(this.instances, store);
      },
    };
  }
}

/** Drawn cells as CELL_FLOATS rows (axes scaled), from a walk's instances and the store. */
export function cellRows(instances, store) {
  const n = instances.length / INSTANCE_FLOATS,
    out = new Float32Array(n * CELL_FLOATS);
  for (let i = 0; i < n; i++) {
    const [slot, lo, hi, scale] = instances.subarray(i * INSTANCE_FLOATS, (i + 1) * INSTANCE_FLOATS),
      o = i * CELL_FLOATS;
    out.set(store.data.subarray(slot * SLOT_FLOATS, slot * SLOT_FLOATS + CELL_FLOATS - 2), o);
    if (scale < 1) for (let k = o + 3; k < o + 12; k++) out[k] *= scale;
    out[o + 19] = lo;
    out[o + 20] = hi;
  }
  return out;
}
