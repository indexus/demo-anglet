// Buildings as one Indexus tree (the scene's `buildings` and `fine` collections,
// named in its catalogue entry: BuildLidHD2025v2 / f2; docs/collections.md 1.4).
//
// Space: the shared `gps` Space, 8 x 8 children per character. One record per
// building sits at the 16-character location of the centroid of its outline.
// Its metrics are sums over the outline's area a (m2):
//   [n, a, a.h, a.z0, a.cxx, a.cxy, a.cyy, a.r, a.g, a.b, a.hh, a.nx, a.ny, a.nz]
// (h = roof height above the ground, z0 = ground altitude, c = second moments
// of the outline about its centroid). No coordinate: a row's place is its key.
// A zone answers /sets with one row per child; a child that holds one
// building answers that building's own location, so the row is the building.
//
// What a row draws:
//   one building               its box: the area, moments, heights and colour of its sums
//   several (far away)         the cell as one patch at the mean height, drawn on the
//                              built share of its pixels (cellPatch), as the vegetation
//                              draws a cell: the far roofs. The cell is exact, the patch
//                              never moves; with sales, the share of its buildings that
//                              have a price takes their colour (buildingsGPU.js).
// Rows: one budget. Starting from the zones of the scene, the row that is
// largest on screen is replaced by its children until `rows` are drawn or no
// row of several buildings is larger than `cellPixels` (a row refined at the
// last walk stays refined down to cellPixels / sticky: no flicker at the edge).
// A row that appears fades in over ROW_FADE while the one it replaces fades
// out through the complementary dither: a cell and its children cross-fade.
// Meshes: one triangle budget. Every building starts as its box; the upgrades
// (block, 2 m, fine) with the largest screen error are bought first. A record
// "0.<id>" carries the block and 2 m meshes; the fine mesh is the record
// "1.<id>" of the fine collection, read only for buildings due their fine level.
//
// Everything is drawn in the scene's rendering frame (geoSpace.localFrame):
// metres from the scene origin, above the scene's zero.
import { cellBounds, cellIndex, cellMetres, cellOfLocation, locationOfCell } from "./geoSpace.js";
import { scheduler as sharedScheduler, isCancelled } from "../../data/scheduler.js";
import { aligned, magic, payloadBytes, recordPayload } from "../../data/payload.js";
import { metrics } from "../../rendering/metrics.js";

export const METRICS = 14;
export const BOX_TRIANGLES = 10;
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";
const START = 4, // depth of the zones the walk starts from (4.9 km)
  RECORDS = 6, // depth of the zones whose records are read together (76 m, about 17 buildings in town)
  PLACED = 9, // a lone row whose key is this deep is placed to 0.2 m
  DEEPEST = 12; // rows are not refined below this depth
const DEFAULT_LEVELS = [
  { triangles: 20, error: 1.5 },
  { triangles: 170, error: 0.4 },
  { triangles: 560, error: 0 },
];

/**
 * Box of the sums `s` of one building, or mean box of several: a rectangle
 * with their area and second moments, centred at `centre` (frame metres).
 * `area`: draw this area instead (a share of a group). altitude: of the frame's zero;
 * scale: frame metres per metre there.
 */
export function box(s, centre, { altitude = 0, scale = 1 } = {}, area = s[1]) {
  const a = s[1],
    xx = Math.max(s[4] / a, 0.05),
    xy = s[5] / a,
    yy = Math.max(s[6] / a, 0.05),
    angle = 0.5 * Math.atan2(2 * xy, xx - yy),
    spread = Math.hypot((xx - yy) / 2, xy),
    l1 = (xx + yy) / 2 + spread,
    l2 = Math.max((xx + yy) / 2 - spread, 0.02);
  // a rectangle of half sides (u, v) has variances u2/3 and v2/3; keep the ratio, match the area
  const ratio = Math.min(Math.sqrt(l1 / l2), 8),
    v = Math.sqrt(area / (4 * ratio)) * scale,
    u = v * ratio,
    ground = s[3] / a - altitude;
  return {
    count: s[0],
    area,
    centre,
    u: [Math.cos(angle) * u, Math.sin(angle) * u],
    v: [-Math.sin(angle) * v, Math.cos(angle) * v],
    ground,
    roof: ground + s[2] / a,
    radius: Math.hypot(u, v),
    color: [s[7] / a, s[8] / a, s[9] / a],
    coverage: 1,
  };
}
/**
 * A row of several buildings far away (its cell smaller than `cellPixels` on
 * screen, or the row budget spent): the whole cell as one patch at the mean
 * height, drawn on `coverage` of its pixels (the built share of its area), as
 * a vegetation cell is drawn on the share its returns cover. The cell is
 * exact (its key), so the patch never moves; refined, it cross-fades with
 * its children, which cover the same ground with the same built share.
 */
export function cellPatch(s, cell, { altitude = 0 } = {}) {
  const a = s[1],
    ground = s[3] / a - altitude;
  return {
    count: s[0],
    area: a,
    centre: cell.centre,
    u: [cell.half[0], 0],
    v: [0, cell.half[1]],
    ground,
    roof: ground + s[2] / a,
    radius: Math.hypot(cell.half[0], cell.half[1]),
    color: [s[7] / a, s[8] / a, s[9] / a],
    coverage: Math.min(1, a / (4 * cell.half[0] * cell.half[1])),
    patch: true,
  };
}
/** Fade (ms) of a row that appears or leaves: a cell and its children cross-fade, no popping. */
export const ROW_FADE = 300;
/** The four corners of a box, counter-clockwise. */
export const boxCorners = (b) =>
  [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([i, j]) => [b.centre[0] + i * b.u[0] + j * b.v[0], b.centre[1] + i * b.u[1] + j * b.v[1]]);
/** Wall colour of a building from its mean roof colour (0..1): light plaster, slightly tinted. */
export const wallColor = (roof) => roof.map((c, i) => 0.88 * [0.95, 0.93, 0.88][i] + 0.12 * c);

// ---- record payloads -> GPU-ready meshes ----------------------------------------------
async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).arrayBuffer();
}
/**
 * The arrays of the meshes of `infos` ({vertices, triangles}) one after the
 * other from byte `at` of `buffer`: per mesh int16 x, y, z per vertex, uint8
 * part per vertex, uint16 3 indices per triangle. `padded` (binary payloads):
 * each array starts on a 4-byte boundary and is a view, no copy; else (the
 * gunzipped JSON data) the arrays follow each other and are copied.
 */
function meshArrays(buffer, at, infos, padded) {
  const list = infos.map(({ vertices: n, triangles: t }) => {
    const take = (bytes) => {
      const from = at;
      at += padded ? (bytes + 3) & ~3 : bytes;
      return from;
    };
    const xyz = take(6 * n),
      parts = take(n),
      indices = take(6 * t);
    if (at > buffer.byteLength) throw Error("Invalid building payload");
    return padded
      ? { xyz: new Int16Array(buffer, xyz, 3 * n), parts: new Uint8Array(buffer, parts, n), indices: new Uint16Array(buffer, indices, 3 * t) }
      : {
          xyz: new Int16Array(buffer.slice(xyz, xyz + 6 * n)),
          parts: new Uint8Array(buffer, parts, n),
          indices: new Uint16Array(buffer.slice(indices, indices + 6 * t)),
        };
  });
  return { list, end: at };
}
/**
 * Meshes of `infos` from their arrays (meshArrays). Per mesh: vertices (16
 * bytes: float32 x, y, z in frame metres, uint8 r, g, b, kind) and the uint16
 * indices. kind: 0 roof, 100 wall foot, 200 wall top.
 * `scale`: frame metres per metre of the mesh, horizontally.
 */
function meshes(arrays, infos, { origin: [ox, oy, oz], step, scale, colors, wall }) {
  return infos.map((level, k) => {
    const { xyz, parts, indices } = arrays[k],
      n = level.vertices,
      buffer = new ArrayBuffer(n * 16),
      f = new Float32Array(buffer),
      u = new Uint8Array(buffer);
    for (let i = 0; i < n; i++) {
      f[i * 4] = ox + xyz[i * 3] * step * scale;
      f[i * 4 + 1] = oy + xyz[i * 3 + 1] * step * scale;
      f[i * 4 + 2] = oz + xyz[i * 3 + 2] * step;
      const part = parts[i],
        c = part >= 254 ? wall : (colors[part] ?? colors[0]),
        o = i * 16 + 12;
      u[o] = c[0];
      u[o + 1] = c[1];
      u[o + 2] = c[2];
      u[o + 3] = part === 255 ? 200 : part === 254 ? 100 : 0;
    }
    return { vertices: buffer, indices, triangles: level.triangles, error: level.error };
  });
}
/** Where meshes go in the frame: from [lat, lng, altitude] and the payload's colours. */
function placeOf(frame, [lat, lng, altitude], step, colors) {
  const mean = [0, 1, 2].map((i) => colors.reduce((s, c) => s + c[i], 0) / colors.length / 255);
  return {
    origin: [...frame.toLocal(lat, lng), altitude - frame.altitude],
    step,
    scale: frame.scale(lat),
    colors,
    wall: wallColor(mean).map((c) => Math.round(c * 255)),
  };
}
/** The fields of a binary near record (IXBM, docs/collections.md "Binary payloads"). */
function readBuilding(bytes) {
  bytes = aligned(bytes);
  if (magic(bytes) !== "IXBM") throw Error("Unknown building payload");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(4, true) !== 1) throw Error("Unknown building payload version");
  const meshCount = bytes[6],
    colorCount = bytes[7],
    f64 = (at) => view.getFloat64(at, true),
    levelCount = view.getUint32(44, true),
    levels = Array.from({ length: levelCount }, (_, i) => ({
      vertices: view.getUint32(48 + 16 * i, true),
      triangles: view.getUint32(52 + 16 * i, true),
      error: f64(56 + 16 * i),
    })),
    colorsAt = 48 + 16 * levelCount,
    colors = Array.from({ length: colorCount }, (_, i) => [...bytes.subarray(colorsAt + 4 * i, colorsAt + 4 * i + 3)]);
  return { origin: [f64(8), f64(16), f64(24)], step: f64(32), levels, colors, bytes, meshesAt: bytes.byteOffset + colorsAt + 4 * colorCount, meshCount };
}
/**
 * Decode a near record: the block and 2 m meshes, and what the fine record
 * will need (`fine`: its size and how to decode it). The payload is an
 * `indexus-building-v3` JSON value (its arrays gzipped in base64) or the bytes
 * of an IXBM binary payload (the arrays as they are: views, no inflate).
 * Its origin is [lat, lng, altitude] and its meshes are metres east/north/up
 * from it; `frame` (geoSpace.localFrame) puts them in the scene.
 */
export async function decodeBuilding(payload, frame, work = (fn) => fn()) {
  if (payload instanceof Uint8Array) {
    const b = readBuilding(payload),
      place = placeOf(frame, b.origin, b.step, b.colors),
      infos = b.levels.slice(0, b.meshCount);
    return {
      levels: await work(() => meshes(meshArrays(b.bytes.buffer, b.meshesAt, infos, true).list, infos, place)),
      fine: { ...b.levels[2], frame: place },
    };
  }
  if (payload.format !== "indexus-building-v3") throw Error("Unknown building payload");
  const place = placeOf(frame, payload.origin, payload.step, payload.colors),
    infos = payload.levels.slice(0, 2);
  // the inflate runs off the main thread; turning the bytes into frame vertices is main-thread work
  const body = await gunzip(await work(() => payloadBytes(payload.data)));
  return {
    levels: await work(() => {
      const { list, end } = meshArrays(body, 0, infos, false);
      if (end !== body.byteLength) throw Error("Invalid building payload");
      return meshes(list, infos, place);
    }),
    fine: { ...payload.levels[2], frame: place },
  };
}
/** Decode a fine record (`indexus-building-fine-v1` JSON or IXBF bytes) with what its near record said. */
export async function decodeFine(payload, fine, work = (fn) => fn()) {
  if (payload instanceof Uint8Array) {
    const bytes = aligned(payload),
      view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (magic(bytes) !== "IXBF" || view.getUint16(4, true) !== 1) throw Error("Unknown fine building payload");
    if (view.getUint32(8, true) !== fine.vertices || view.getUint32(12, true) !== fine.triangles)
      throw Error("Fine mesh does not match its near record");
    return await work(() => meshes(meshArrays(bytes.buffer, bytes.byteOffset + 16, [fine], true).list, [fine], fine.frame)[0]);
  }
  if (payload.format !== "indexus-building-fine-v1") throw Error("Unknown fine building payload");
  const body = await gunzip(await work(() => payloadBytes(payload.data)));
  return await work(() => {
    const { list, end } = meshArrays(body, 0, [fine], false);
    if (end !== body.byteLength) throw Error("Invalid building payload");
    return meshes(list, [fine], fine.frame)[0];
  });
}

// ---- source ---------------------------------------------------------------------------
const suffix = (block, row) => {
  let out = "";
  for (let c = 0; c < block.suffixChars; c++) {
    const bit = c * 6,
      word = block.keys[row * block.keyWords + (bit >> 5)],
      shift = 26 - (bit & 31);
    out += ALPHABET[(shift >= 0 ? word >>> shift : (word << -shift) | (block.keys[row * block.keyWords + (bit >> 5) + 1] >>> (32 + shift))) & 63];
  }
  return out;
};
/**
 * Read the collections through the Indexus network (SDK Network), every read
 * through the shared scheduler (layer "buildings"): `priority` orders them
 * against the other layers' reads, and what leaves the view is dropped.
 */
const named = (collection, what) => {
  if (typeof collection !== "string" || !collection) throw Error(`${what} : collection non nommée (catalogue de la scène)`);
  return collection;
};
/** collection, fine: the names of the scene's catalogue entry (no default). */
export function networkSource(network, collection, fine, scheduler = sharedScheduler) {
  named(collection, "bâtiments");
  named(fine, "bâtiments fins");
  const LAYER = "buildings";
  const rows = (name, zone, prefix, source, priority) =>
    scheduler.request(
      LAYER,
      name + "/" + zone,
      async (signal) => {
        source.requests++;
        const list = await network.getContentRecords(name, zone, 4096, { signal });
        let bytes = 0;
        const out = list
          .filter((r) => r.id.startsWith(prefix))
          .map((r) => {
            const payload = recordPayload(r);
            bytes += payload.data?.length ?? payload.length;
            return { id: r.id.slice(prefix.length), location: r.location, payload };
          });
        source.bytes += bytes;
        out.bytes = bytes;
        return out;
      },
      { priority, size: (out) => out.bytes },
    );
  return {
    collection,
    bytes: 0,
    requests: 0,
    work: (fn, priority) => scheduler.work(LAYER, fn, priority),
    pass: () => scheduler.pass(LAYER),
    /**
     * zones -> Map(zone -> [{location, sums}]): one row per child of each zone.
     * location is the child's, or, when the child holds one place only, that
     * place (up to 4 characters below the zone).
     */
    children(zones, priority = 0) {
      return scheduler.request(LAYER, "sets/" + zones.join(","), (signal) => this.readChildren(zones, signal), {
        priority,
        size: (out) => out.bytes,
      });
    },
    async readChildren(zones, signal) {
      this.requests++;
      const answer = await network.getSets(collection, zones, { raw: true, metrics: "f64", signal });
      if (answer.format !== "block") throw Error("Indexus node too old for building blocks");
      const out = new Map(zones.map((z) => [z, new Map()]));
      let bytes = 0;
      for (const response of answer.responses) {
        bytes += response.buffer?.byteLength ?? 0;
        for (const block of response.blocks) {
          const zone = block.parent || "@",
            groups = out.get(zone);
          if (!groups || block.suffixChars < 1) continue;
          for (let row = 0; row < block.n; row++) {
            const key = (zone === "@" ? "" : zone) + suffix(block, row),
              child = key.slice(0, zone === "@" ? 1 : zone.length + 1);
            let group = groups.get(child);
            if (!group) groups.set(child, (group = { location: key, sums: new Float64Array(METRICS) }));
            else group.location = child; // two keys under one child: the row is the child
            for (let j = 0; j < Math.min(METRICS, block.metricCount); j++) group.sums[j] += block.metrics[j * block.n + row];
          }
        }
      }
      this.bytes += bytes;
      for (const zone of answer.unresolved ?? []) out.delete(zone);
      const result = new Map([...out].map(([zone, groups]) => [zone, [...groups.values()].filter((g) => g.sums[1] > 0)]));
      result.bytes = bytes;
      return result;
    },
    /** near records ("0.<id>") under a zone: [{id, location, payload}] */
    records(zone, priority = 0) {
      return rows(collection, zone, "0.", this, priority);
    },
    /** fine mesh records ("1.<id>") under a zone, same shape */
    fine(zone, priority = 0) {
      return rows(fine, zone, "1.", this, priority);
    },
  };
}

// ---- view helpers ------------------------------------------------------------------------
/** Whether a sphere is not wholly outside the planes (rendering/math.js frustumPlanes). */
const visible = (planes, x, y, z, r) => {
  for (let i = 0; i < planes.length; i += 4) if (planes[i] * x + planes[i + 1] * y + planes[i + 2] * z + planes[i + 3] < -r) return false;
  return true;
};

// ---- tree --------------------------------------------------------------------------------
/**
 * What a walk draws, one column per field (no array per item), kept from one
 * walk to the next: node (a Node, or a mean box { box }), level (-1 for a
 * box), fade 0..1 and appearing (1) or leaving (0, or top - 1 for a row that
 * leaves while it was still fading in: it was there on `top` of its pixels).
 */
export class DrawList {
  nodes = [];
  levels = [];
  fades = [];
  appearing = [];
  length = 0;
  push(node, level, fade, appearing) {
    const i = this.length++;
    this.nodes[i] = node;
    this.levels[i] = level;
    this.fades[i] = fade;
    this.appearing[i] = appearing;
  }
  clear() {
    this.length = 0;
  }
  /** Drop what is past the length (the nodes of an older, longer walk). */
  trim() {
    this.nodes.length = this.levels.length = this.fades.length = this.appearing.length = this.length;
  }
  /** A list from [node, level, fade, appearing] rows (tools, tests). */
  static of(rows) {
    const list = new DrawList();
    for (const [node, level, fade, appearing] of rows) list.push(node, level, fade, appearing);
    return list;
  }
}

class Node {
  /** location: the row's key; depth: of the zone the row stands for (its parent's + 1) */
  constructor(location, depth, sums, parent, tree) {
    this.location = location;
    this.depth = depth;
    this.sums = sums;
    this.parent = parent;
    this.lone = Math.round(sums[0]) === 1;
    // a lone row is as large as the cell of its key: it is placed once that is small
    const at = this.lone ? location : location.slice(0, depth),
      cell = tree.cell(at);
    this.side = cell.side;
    this.placed = this.lone && at.length >= PLACED;
    this.full = !this.lone && sums[1] > 4 * cell.half[0] * cell.half[1]; // more roof than cell: buildings piled in it
    const place = { altitude: tree.frame.altitude, scale: cell.k };
    this.box = this.lone ? box(sums, cell.centre, place) : cellPatch(sums, cell, place);
    this.cell = cell;
    this.children = null;
    this.state = 0; // children: 0 idle, 1 loading, 2 ready
    this.rowWalk = -1; // last walk that drew this row
    this.refinedWalk = -1; // last walk that drew its children instead
    this.rowSince = 0; // time it appeared (its fade in)
    this.leftAt = -1; // time it left (its fade out), -1 while drawn or gone
    this.levels = null; // lone: [block, 2 m, fine] of the building, once read
    this.fine = null; // lone: what decoding its fine record needs
    this.id = null; // lone: the building's id, once read
    this.level = -1; // level drawn (-1 = box)
    this.since = -1e9; // time of the last level change (fade)
    this.from = -1;
  }
  get refinable() {
    return this.lone ? !this.placed : this.depth < DEEPEST;
  }
}

/** A max-heap of nodes on node.priority. */
function push(heap, node) {
  let i = heap.length;
  heap.push(node);
  while (i > 0) {
    const up = (i - 1) >> 1;
    if (heap[up].priority >= node.priority) break;
    heap[i] = heap[up];
    i = up;
  }
  heap[i] = node;
}
function pop(heap) {
  const top = heap[0],
    last = heap.pop();
  if (heap.length) {
    let i = 0;
    for (;;) {
      let down = 2 * i + 1;
      if (down >= heap.length) break;
      if (down + 1 < heap.length && heap[down + 1].priority > heap[down].priority) down++;
      if (heap[down].priority <= last.priority) break;
      heap[i] = heap[down];
      i = down;
    }
    heap[i] = last;
  }
  return top;
}

export class BuildingsTree {
  /**
   * source: networkSource(); options.frame: geoSpace.localFrame(scene);
   * options.origin: [lng, lat] and options.radius: the disc that is drawn;
   * options.zone: or the scene's contour (data/sceneZone.js), in place of the disc;
   * rows: rows drawn at most; budget: triangles drawn at most;
   * maxLoads: reads asked for at once (the scheduler decides which go first);
   * upload(meshes, owner) -> range, in the layer's render (flush()).
   */
  constructor(source, options = {}) {
    const { frame, origin, radius = Infinity, zone = null, rows = 4096, cellPixels = 16, budget = 200000, minError = 0.8 } = options,
      { sticky = 1.3, maxLoads = 24, batch = 64, upload } = options;
    Object.assign(this, { source, frame, radius, zone, rows, cellPixels, budget, minError, sticky, maxLoads, batch, upload });
    this.collection = source.collection;
    this.root = null;
    this.loading = 0;
    this.onChange = null;
    this.onPlaced = null; // (node): a building got its place (surface, sale anchors)
    this.firstMesh = null;
    this.highlight = null; // {location, color} of the highlighted building
    this.zones = new Map(); // RECORDS-deep location -> { location, records, fine, leaves, spare }
    this.cells = new Map(); // geometry of a location, in the frame
    this.pending = []; // leaves whose decoded meshes wait for the GPU (flush)
    this.band = new Int16Array(0); // work arrays of select()
    this.bands = new Float64Array(160);
    // two pairs of draw lists, a walk's and the one before it (what the layer may still hold)
    this.lists = [
      [new DrawList(), new DrawList()],
      [new DrawList(), new DrawList()],
    ];
    this.walks = 0;
    // the rows a walk drew, the walk's and the one before it, and the rows fading out
    this.rowLists = [[], []];
    this.leaving = [];
    const start = () =>
      source.children(zone ? this.zoneStart(zone) : this.startZones(origin, radius), 1e9).then(
        (answer) => {
          this.root = [];
          for (const [zone, list] of answer) for (const r of list) this.root.push(new Node(r.location, zone === "@" ? 1 : zone.length + 1, r.sums, null, this));
          for (const node of this.root) this.register(node);
          this.onChange?.();
        },
        // the scheduler already asked again; a node still starting answers later
        () => new Promise((resolve) => setTimeout(resolve, 2000)).then(start),
      );
    this.ready = start();
  }
  /** The zones of depth START that touch the disc: where the walk starts (the root without a disc). */
  startZones(origin, radius) {
    if (!origin || !Number.isFinite(radius)) return ["@"];
    const dlat = radius / 111319.49,
      dlng = dlat / Math.cos((origin[1] * Math.PI) / 180),
      a = cellIndex(origin[1] - dlat, origin[0] - dlng, 3 * START),
      b = cellIndex(origin[1] + dlat, origin[0] + dlng, 3 * START),
      out = [];
    for (let row = a.row; row <= b.row; row++) for (let col = a.col; col <= b.col; col++) out.push(locationOfCell(row, col, START, this.collection));
    return out;
  }
  /** The zones of depth START over the contour's rectangle. */
  zoneStart(zone) {
    const [[west, south], [east, north]] = zone.lngLatBounds(),
      a = cellIndex(south, west, 3 * START),
      b = cellIndex(north, east, 3 * START),
      out = [];
    for (let row = a.row; row <= b.row; row++) for (let col = a.col; col <= b.col; col++) out.push(locationOfCell(row, col, START, this.collection));
    return out;
  }
  /** { centre, half: [east-west, north-south], side } of a location's cell, in frame metres. */
  cell(location) {
    let cell = this.cells.get(location);
    if (!cell) {
      const { row, col, depth } = cellOfLocation(location, this.collection),
        b = cellBounds(row, col, 3 * depth),
        lat = (b.south + b.north) / 2,
        [ns, ew] = cellMetres(3 * depth, lat),
        k = this.frame.scale(lat),
        half = [(ew * k) / 2, (ns * k) / 2];
      cell = { centre: this.frame.toLocal(lat, (b.west + b.east) / 2), half, side: 2 * Math.max(half[0], half[1]), k };
      // only the cells of rows are kept: as many as nodes
      this.cells.set(location, cell);
    }
    return cell;
  }
  /** A placed building joins the zone its records are read with; meshes read before it arrived are handed over. */
  register(node) {
    if (!node.placed) return;
    const key = node.location.slice(0, RECORDS);
    let zone = this.zones.get(key);
    if (!zone) this.zones.set(key, (zone = { location: key, records: 0, fine: 0, leaves: new Map(), byId: new Map(), spare: new Map() }));
    zone.leaves.set(node.location, node);
    node.zone = zone;
    for (const [location, decoded] of zone.spare)
      if (location.startsWith(node.location)) {
        zone.spare.delete(location);
        this.attach(node, decoded);
      }
    this.onPlaced?.(node);
  }
  /** Decoded meshes of a building: kept until flush() puts them on the GPU. */
  attach(leaf, { id, levels, fine }) {
    leaf.fine = fine;
    leaf.id = id;
    leaf.zone.byId.set(id, leaf);
    if (leaf.levels || leaf.decoded) return; // already there (a zone read again after an eviction)
    leaf.decoded = levels;
    this.pending.push(leaf);
  }
  /**
   * Upload decoded meshes, nearest first: one building per step of `budget`
   * (frameBudget.js, consumer "uploads"), or for at most `budget` ms.
   */
  flush(budget = 2) {
    if (!this.pending.length) return 0;
    this.pending.sort((a, b) => (b.scale ?? 0) - (a.scale ?? 0));
    let done = 0;
    const one = () => {
      const leaf = this.pending[done++];
      if (leaf.decoded) {
        leaf.levels = leaf.decoded.map((l, k) => ({ range: this.upload([l], { leaf, level: k }), triangles: l.triangles, error: l.error }));
        leaf.levels.push({ range: null, triangles: leaf.fine.triangles, error: leaf.fine.error });
        leaf.decoded = null;
      }
      if (leaf.fineDecoded && leaf.levels && !leaf.levels[2].range) leaf.levels[2].range = this.upload([leaf.fineDecoded], { leaf, level: 2 });
      leaf.fineDecoded = null;
      return done >= this.pending.length;
    };
    if (typeof budget === "number") {
      const t0 = performance.now();
      while (done < this.pending.length && (done === 0 || performance.now() - t0 < budget)) one();
    } else budget.run("uploads", one);
    if (!done) return 0;
    this.pending.splice(0, done);
    this.firstMesh ??= performance.now();
    this.onChange?.();
    return done;
  }
  /** The GPU let ranges go (its memory budget): their buildings fall back to their box and are read again when wanted. */
  evict(ranges) {
    for (const range of ranges) {
      const { leaf, level } = range.owner ?? {};
      if (!leaf?.levels || leaf.levels[level]?.range !== range) continue;
      if (level === 2) {
        leaf.levels[2].range = null;
        leaf.asked = false;
        if (leaf.zone.fine === 2) leaf.zone.fine = 0;
      } else {
        leaf.levels = null;
        if (leaf.zone.records === 2) leaf.zone.records = 0;
      }
    }
    metrics.count("buildings", "evicted", ranges.length);
  }
  inside(node) {
    const c = node.box.centre;
    if (this.zone) {
      // the contour: asked once per node (its box does not move)
      if (node.inZone === undefined) {
        const r = node.cell.side;
        node.inZone = this.zone.touches(c[0] - r, c[1] - r, c[0] + r, c[1] + r, 0);
      }
      return node.inZone;
    }
    return Math.hypot(c[0], c[1]) - node.cell.side <= this.radius;
  }
  loadChildren(nodes, priority = 0) {
    for (let i = 0; i < nodes.length; i += this.batch) {
      const part = nodes.slice(i, i + this.batch),
        // a lone row is asked at its key: the answer is the same place, 4 characters deeper
        zoneOf = (n) => (n.lone ? n.location : n.location.slice(0, n.depth));
      for (const n of part) n.state = 1;
      this.loading++;
      this.source
        .children(part.map(zoneOf), Math.max(...part.map((n) => n.want ?? priority)))
        .then((answer) => {
          for (const n of part) {
            const rows = answer.get(zoneOf(n));
            if (!rows) n.state = 0;
            else {
              n.children = rows.map((r) => new Node(r.location, zoneOf(n).length + 1, r.sums, n, this));
              for (const child of n.children) this.register(child);
              n.state = 2;
            }
          }
        })
        .catch((error) => {
          // dropped (left the view): asked again when it comes back; failed: in a moment
          if (isCancelled(error)) part.forEach((n) => (n.state = 0));
          else setTimeout(() => part.forEach((n) => (n.state = 0)), 2000);
        })
        .finally(() => {
          this.loading--;
          this.onChange?.();
        });
    }
  }
  /** Read the near records of a zone and decode their meshes for its buildings. */
  loadRecords(zone, priority = 0) {
    zone.records = 1;
    this.loading++;
    const work = (fn) => this.source.work?.(fn, priority) ?? fn();
    this.source
      .records(zone.location, priority)
      .then((rows) =>
        Promise.all(
          rows.map(async (r) => {
            const decoded = { id: r.id, ...(await decodeBuilding(r.payload, this.frame, work)) };
            let leaf = null;
            for (let length = r.location.length; length > RECORDS && !leaf; length--) leaf = zone.leaves.get(r.location.slice(0, length));
            // a building whose row is not read yet waits for it: one read per zone, whatever the order
            if (leaf) this.attach(leaf, decoded);
            else zone.spare.set(r.location, decoded);
          }),
        ),
      )
      .then(() => (zone.records = 2))
      .catch((error) => {
        if (isCancelled(error)) zone.records = 0;
        else {
          console.warn("[buildings]", zone.location, error);
          setTimeout(() => (zone.records = 0), 2000); // asked again in a moment
        }
      })
      .finally(() => {
        this.loading--;
        this.onChange?.();
      });
  }
  /** Read the fine meshes of a zone whose buildings are already read. */
  loadFine(zone, priority = 0) {
    zone.fine = 1;
    this.loading++;
    const work = (fn) => this.source.work?.(fn, priority) ?? fn();
    this.source
      .fine(zone.location, priority)
      .then((rows) =>
        Promise.all(
          rows.map(async (r) => {
            const leaf = zone.byId.get(r.id);
            if (!leaf || leaf.levels?.[2].range || !leaf.fine) return;
            leaf.fineDecoded = await decodeFine(r.payload, leaf.fine, work);
            this.pending.push(leaf);
          }),
        ),
      )
      .then(() => (zone.fine = 2))
      .catch((error) => {
        if (isCancelled(error)) zone.fine = 0;
        else {
          console.warn("[buildings] fine", zone.location, error);
          setTimeout(() => (zone.fine = 0), 2000);
        }
      })
      .finally(() => {
        this.loading--;
        this.onChange?.();
      });
  }
  /**
   * What to draw for `view` = { eye, planes, focal (pixels), now (ms) }, as
   * two DrawLists, valid until the walk after next:
   *  boxes:  drawn as boxes (a building, a cell, or a mean box of a cell), level -1
   *  meshes: a building's mesh of `level`
   * The whole walk at once; steps(view) is the same walk in steps.
   */
  select(view) {
    const walk = this.steps(view);
    for (;;) {
      const step = walk.next();
      if (step.done) return step.value;
    }
  }
  /**
   * The walk as a generator: it yields every few dozen rows or buildings, so a
   * layer can spread it over frames within a time budget (the frames between
   * draw the last selection). Data that arrives meanwhile is seen or not; it
   * is drawn by the next walk.
   */
  *steps(view) {
    const { eye, planes, focal, now, matrix = null } = view,
      walk = ++this.walks,
      [boxes, meshes] = this.lists[walk & 1],
      leaves = [],
      wantChildren = [],
      heap = [],
      stats = { boxes: 0, triangles: 0, levels: [0, 0, 0], visible: 0, rows: 0, cells: 0, loading: this.loading };
    const scaleOf = (b) =>
      focal / Math.max(Math.hypot(b.centre[0] - eye[0], b.centre[1] - eye[1], (b.roof + b.ground) / 2 - eye[2]) - b.radius, 1);
    // reads: the centre of the view first (1 at the centre, 1/2 at the edge of the screen)
    const centrality = (b) => {
      if (!matrix) return 1;
      const z = (b.roof + b.ground) / 2,
        w = matrix[3] * b.centre[0] + matrix[7] * b.centre[1] + matrix[11] * z + matrix[15];
      if (w <= 0) return 0.25;
      return 1 / (1 + Math.hypot((matrix[0] * b.centre[0] + matrix[4] * b.centre[1] + matrix[8] * z + matrix[12]) / w, (matrix[1] * b.centre[0] + matrix[5] * b.centre[1] + matrix[9] * z + matrix[13]) / w));
    };
    this.source.pass?.(); // what was asked before and is not asked again now leaves the queue
    // rows: the largest on screen is replaced by its children, within the row budget.
    // priority: pixels over what is allowed (a cell of several: cellPixels; a lone row not placed yet: 1)
    const enter = (node) => {
      const b = node.box;
      if (!this.inside(node) || !visible(planes, b.centre[0], b.centre[1], (b.roof + b.ground) / 2, b.radius + (b.roof - b.ground))) return false;
      node.scale = scaleOf(b);
      node.priority = !node.refinable ? 0 : node.full ? 1e9 : (node.side * node.scale) / (node.lone ? 1 : this.cellPixels);
      push(heap, node);
      return true;
    };
    let count = 0;
    for (const node of this.root ?? []) if (enter(node)) count++;
    const drawn = [];
    let tick = 0;
    while (heap.length) {
      if ((++tick & 31) === 0) yield;
      const node = pop(heap);
      // refined at the last walk: kept so down to 1 / sticky
      if (node.priority <= (node.refinedWalk === walk - 1 ? 1 / this.sticky : 1)) {
        drawn.push(node);
        continue;
      }
      if (node.state !== 2) {
        if (node.state === 0) {
          node.want = Math.min(node.priority, 1e6) * centrality(node.box);
          wantChildren.push(node);
        }
        drawn.push(node);
        continue;
      }
      let shown = 0;
      for (const child of node.children) shown += this.inside(child) ? 1 : 0;
      if (count - 1 + shown > this.rows) {
        // the budget is spent: this row and every smaller one stay as they are
        drawn.push(node);
        for (const rest of heap) drawn.push(rest);
        break;
      }
      count--;
      node.refinedWalk = walk;
      for (const child of node.children) if (enter(child)) count++;
    }
    if (wantChildren.length && this.loading < this.maxLoads) this.loadChildren(wantChildren.slice(0, this.batch * (this.maxLoads - this.loading)));
    boxes.clear();
    meshes.clear();
    // a row that was not drawn by the last walk fades in (from where its fade out was, if it was leaving)
    const age = (since) => (now >= since ? Math.min((now - since) / ROW_FADE, 1) : 1),
      rows = this.rowLists[walk & 1],
      before = this.rowLists[(walk + 1) & 1];
    rows.length = 0;
    let fading = false;
    for (const node of drawn) {
      if ((++tick & 127) === 0) yield;
      if (node.rowWalk !== walk - 1) node.rowSince = now - (1 - (node.leftAt >= 0 ? age(node.leftAt) : 1)) * ROW_FADE;
      node.rowWalk = walk;
      node.leftAt = -1;
      node.rowFade = age(node.rowSince);
      if (node.rowFade < 1) fading = true;
      rows.push(node);
      if (node.lone) leaves.push(node);
      else {
        boxes.push(node, -1, node.rowFade, 1);
        stats.cells++;
      }
    }
    // the rows of the last walk not drawn now fade out, through the complementary dither
    // (one still fading in leaves from where it is: as much gone as it was not there yet)
    for (const node of before)
      if (node.rowWalk !== walk && node.leftAt < 0) {
        // leaveTop: how much of it was there; it leaves on the pixels it had (buildingsGPU.js), not on others
        node.leaveTop = age(node.rowSince);
        node.leftAt = now - (1 - node.leaveTop) * ROW_FADE;
        this.leaving.push(node);
      }
    before.length = 0;
    let kept = 0;
    for (const node of this.leaving) {
      const gone = node.rowWalk === walk || node.leftAt < 0 ? 1 : age(node.leftAt);
      if (gone >= 1) {
        if (node.rowWalk !== walk) node.leftAt = -1;
        continue;
      }
      this.leaving[kept++] = node;
      fading = true;
      const top = (node.leaveTop ?? 1) - 1;
      if (node.lone && node.level >= 0 && node.levels?.[node.level]?.range) meshes.push(node, node.level, gone, top);
      else boxes.push(node, -1, gone, top);
    }
    this.leaving.length = kept;
    stats.rows = drawn.length;
    // Every building has three upgrade steps (block, 2 m, fine), each with a
    // screen error in pixels and a cost in triangles. The steps with the
    // largest error are bought first until the budget is spent. No sort: the
    // costs are summed per error band (16 bands per doubling), the band where
    // the budget runs out is found, and only that band is bought one by one.
    const n = leaves.length,
      bands = this.bands,
      top = bands.length - 1;
    if (this.band.length < n * 3) this.band = new Int16Array(n * 4);
    const band = this.band;
    bands.fill(0);
    for (let i = 0; i < n; i++) {
      if ((++tick & 127) === 0) yield;
      const leaf = leaves[i],
        levels = leaf.levels ?? DEFAULT_LEVELS;
      let error = Math.max(1.2, 0.3 * Math.sqrt(leaf.box.area)), // the box against the real roof
        cost = BOX_TRIANGLES;
      leaf.target = -1;
      for (let k = 0; k < 3; k++) {
        // a level already drawn is kept a little longer (sticky): no flicker at the budget edge
        const e = error * leaf.scale * (k <= leaf.level ? this.sticky : 1),
          b = e < this.minError ? -1 : Math.min(top, Math.floor(Math.log2(e / this.minError) * 16));
        band[i * 3 + k] = b;
        if (b >= 0) bands[b] += levels[k].triangles - cost;
        error = Math.min(error, levels[k].error);
        cost = levels[k].triangles;
      }
    }
    let spent = (n + boxes.length) * BOX_TRIANGLES,
      edge = top;
    for (; edge >= 0 && spent + bands[edge] <= this.budget; edge--) spent += bands[edge];
    const wantRecords = new Set(),
      wantFine = new Set();
    for (let i = 0; i < n; i++) {
      if ((++tick & 127) === 0) yield;
      const leaf = leaves[i],
        levels = leaf.levels ?? DEFAULT_LEVELS;
      for (let k = 0; k < 3 && band[i * 3 + k] >= edge && band[i * 3 + k] >= 0; k++) {
        if (band[i * 3 + k] === edge) {
          // the band where the budget runs out: bought in tree order while it fits
          const cost = levels[k].triangles - (k ? levels[k - 1].triangles : BOX_TRIANGLES);
          if (spent + cost > this.budget) break;
          spent += cost;
        }
        leaf.target = k;
      }
      const zone = leaf.zone;
      if (!zone) continue; // not placed yet: its box only
      const want = leaf.scale * centrality(leaf.box);
      zone.near = zone.pass === now ? Math.max(zone.near, want) : want;
      zone.pass = now;
      if (leaf.target >= 0 && !leaf.levels && zone.records === 0) wantRecords.add(zone);
      if (leaf.target === 2 && leaf.levels && !leaf.levels[2].range) {
        if (zone.fine === 0) wantFine.add(zone);
        else if (zone.fine === 2 && !leaf.asked) {
          // the zone's fine meshes were read before this building's near record: once more
          leaf.asked = true;
          zone.fine = 0;
          wantFine.add(zone);
        }
      }
    }
    // one read per zone of depth RECORDS, the zones nearest to the eye first
    const nearest = (zones) => [...zones].sort((a, b) => b.near - a.near);
    for (const zone of nearest(wantRecords)) if (this.loading < this.maxLoads) this.loadRecords(zone, zone.near);
    for (const zone of nearest(wantFine)) if (this.loading < this.maxLoads) this.loadFine(zone, zone.near / 2);
    for (const leaf of leaves) {
      // a fine mesh not read yet: the 2 m mesh stands in
      let level = leaf.levels ? leaf.target : -1;
      if (level === 2 && !leaf.levels[2].range) level = 1;
      if (level !== leaf.level) {
        leaf.from = leaf.level;
        leaf.level = level;
        leaf.since = now;
      }
      leaf.fade = Math.min((now - leaf.since) / 300, 1);
      if (leaf.fade < 1) fading = true;
      // fade 0..1, then 1 = appearing | 0 = leaving
      // a building that was not drawn before (its row just appeared) fades in as its row
      if (level < 0) boxes.push(leaf, -1, leaf.from < 0 || leaf.fade >= 1 ? leaf.rowFade : leaf.fade, 1);
      else if (leaf.fade < 1 && leaf.from < 0) boxes.push(leaf, -1, leaf.fade, 0);
      if (level >= 0) {
        meshes.push(leaf, level, leaf.fade < 1 ? leaf.fade : leaf.rowFade, 1);
        stats.levels[level]++;
        stats.triangles += leaf.levels[level].triangles;
      }
      if (leaf.fade < 1 && leaf.from >= 0 && leaf.levels?.[leaf.from]?.range) meshes.push(leaf, leaf.from, leaf.fade, 0);
    }
    boxes.trim();
    meshes.trim();
    stats.boxes = boxes.length;
    stats.triangles += boxes.length * BOX_TRIANGLES;
    stats.visible = leaves.length;
    // the buildings what is drawn stands for: a far patch holds its cell's buildings
    let represented = 0;
    for (const leaf of leaves) represented += leaf.patch ? leaf.count : 1;
    stats.represented = represented;
    stats.pending = wantRecords.size + wantFine.size;
    // now: the clock the fades were taken on (the GPU runs them on from there: buildingsGPU.js)
    return { boxes, meshes, fading, stats, highlight: this.highlight, now };
  }
}
