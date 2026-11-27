// A scene's zone, in metres of its frame (east and north of the origin, Web
// Mercator times the scale at the origin, as the rest of the scene): the
// disc of `radius` metres (the scenes before) or a contour, the `zone` of the
// catalogue entry (a GeoJSON Polygon or MultiPolygon in WGS84, written by core
// tools/prep/scenes from the entry's `boundary` file: Anglet, the whole commune).
//
// What the scene asks of it, every answer in metres of the frame:
//   bounds                [x0, y0, x1, y1]
//   radius                the disc around the origin that holds the zone
//   contains(x, y)        inside (even-odd over the rings)
//   beyond(x, y, reach)   distance outside the zone, 0 inside, at most reach (reach <= REACH)
//   touches(x0, y0, x1, y1, margin)   the rectangle is within margin of the zone (margin <= REACH)
//   rectInside(x0, y0, x1, y1, guard) the rectangle is inside, more than guard from the edge (guard <= REACH)
//   rectDistance(x0, y0, x1, y1)      exact distance between the rectangle and the zone, 0 when they meet
//   geometry()            GeoJSON geometry in degrees (the map's outline of the scene)
//   lngLatBounds()        [[west, south], [east, north]]
//
// A contour is cut into BUCKET m buckets that list the edges within REACH of
// them; a bucket with none is wholly inside or outside. A point's answer reads
// its bucket's few edges (and the parity of the segment from the bucket's
// centre, whose side is known): DEM tiles ask it of every pixel. No answer
// allocates. The disc answers with the formulas the scene had (the same
// numbers, so the same pixels inside).

export const BUCKET = 64,
  REACH = 200;

const EARTH = 6378137;
/** MapLibre's Web Mercator (0..1) of degrees. */
export const mercatorX = (lng) => (180 + lng) / 360;
export const mercatorY = (lat) => (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360;
const lngOf = (x) => x * 360 - 180;
const latOf = (y) => (360 / Math.PI) * Math.atan(Math.exp(((180 - y * 360) * Math.PI) / 180)) - 90;

/** The frame of a scene { origin: [lng, lat], unit }: degrees <-> metres. */
export function sceneFrame({ origin, unit }) {
  const ox = mercatorX(origin[0]),
    oy = mercatorY(origin[1]),
    u = unit ?? 1 / (2 * Math.PI * EARTH * Math.cos((origin[1] * Math.PI) / 180));
  return {
    unit: u,
    toLocal: (lng, lat) => [(mercatorX(lng) - ox) / u, (oy - mercatorY(lat)) / u],
    toLngLat: (x, y) => [lngOf(ox + x * u), latOf(oy - y * u)],
  };
}

/** Distance from the point (px, py) to the segment (ax, ay)-(bx, by). */
function segmentPoint(ax, ay, bx, by, px, py) {
  const dx = bx - ax,
    dy = by - ay,
    l = dx * dx + dy * dy,
    t = l > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l)) : 0;
  return Math.hypot(ax + t * dx - px, ay + t * dy - py);
}
/** Distance from the segment to the full rectangle [x0, x1] x [y0, y1] (0 when it meets it). */
export function segmentRect(ax, ay, bx, by, x0, y0, x1, y1) {
  // Liang-Barsky: does the segment cross the rectangle?
  let t0 = 0,
    t1 = 1,
    hit = true;
  const dx = bx - ax,
    dy = by - ay,
    p = [-dx, dx, -dy, dy],
    q = [ax - x0, x1 - ax, ay - y0, y1 - ay];
  for (let k = 0; k < 4 && hit; k++) {
    if (p[k] === 0) {
      if (q[k] < 0) hit = false;
    } else {
      const r = q[k] / p[k];
      if (p[k] < 0) t0 = Math.max(t0, r);
      else t1 = Math.min(t1, r);
      if (t0 > t1) hit = false;
    }
  }
  if (hit) return 0;
  const box = (x, y) => Math.hypot(Math.max(x0 - x, 0, x - x1), Math.max(y0 - y, 0, y - y1));
  return Math.min(
    box(ax, ay),
    box(bx, by),
    segmentPoint(ax, ay, bx, by, x0, y0),
    segmentPoint(ax, ay, bx, by, x0, y1),
    segmentPoint(ax, ay, bx, by, x1, y0),
    segmentPoint(ax, ay, bx, by, x1, y1),
  );
}
// the segment-rectangle test above allocates two small arrays: the hot paths use this one
function segmentRectFast(ax, ay, bx, by, x0, y0, x1, y1) {
  let t0 = 0,
    t1 = 1;
  const dx = bx - ax,
    dy = by - ay;
  const clip = (p, q) => {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) t0 = r > t0 ? r : t0;
    else t1 = r < t1 ? r : t1;
    return t0 <= t1;
  };
  if (clip(-dx, ax - x0) && clip(dx, x1 - ax) && clip(-dy, ay - y0) && clip(dy, y1 - ay)) return 0;
  const bax = Math.max(x0 - ax, 0, ax - x1),
    bay = Math.max(y0 - ay, 0, ay - y1),
    bbx = Math.max(x0 - bx, 0, bx - x1),
    bby = Math.max(y0 - by, 0, by - y1);
  return Math.min(
    Math.sqrt(bax * bax + bay * bay),
    Math.sqrt(bbx * bbx + bby * bby),
    segmentPoint(ax, ay, bx, by, x0, y0),
    segmentPoint(ax, ay, bx, by, x0, y1),
    segmentPoint(ax, ay, bx, by, x1, y0),
    segmentPoint(ax, ay, bx, by, x1, y1),
  );
}

/** The disc of `radius` metres around the origin. */
export class DiscZone {
  kind = "disc";
  constructor(radius, frame = null) {
    this.radius = radius;
    this.frame = frame;
    this.bounds = [-radius, -radius, radius, radius];
  }
  contains(x, y) {
    return x * x + y * y <= this.radius * this.radius;
  }
  beyond(x, y, reach) {
    return Math.max(0, Math.min(reach, Math.hypot(x, y) - this.radius));
  }
  rectDistance(x0, y0, x1, y1) {
    return Math.max(0, Math.hypot(Math.max(x0, 0, -x1), Math.max(y0, 0, -y1)) - this.radius);
  }
  touches(x0, y0, x1, y1, margin = 0) {
    return this.rectDistance(x0, y0, x1, y1) <= margin;
  }
  rectInside(x0, y0, x1, y1, guard = 0) {
    const dx = Math.max(Math.abs(x0), Math.abs(x1)),
      dy = Math.max(Math.abs(y0), Math.abs(y1)),
      limit = this.radius - guard;
    return limit > 0 && dx * dx + dy * dy <= limit * limit;
  }
  /** Closed ring of the disc (65 points), as the map outlined it. */
  geometry() {
    const ring = Array.from({ length: 65 }, (_, i) => {
      const angle = ((i % 64) * Math.PI) / 32;
      return this.frame.toLngLat(Math.cos(angle) * this.radius, Math.sin(angle) * this.radius);
    });
    return { type: "Polygon", coordinates: [ring] };
  }
  lngLatBounds() {
    const r = this.radius;
    return [this.frame.toLngLat(-r, -r), this.frame.toLngLat(r, r)];
  }
}

/** A contour: rings of [x, y] metres of the frame (even-odd). */
export class PolygonZone {
  kind = "polygon";
  constructor(rings, frame = null, geometry = null) {
    this.frame = frame;
    this.source = geometry;
    let n = 0;
    for (const ring of rings) n += ring.length - (ringClosed(ring) ? 1 : 0);
    const e = (this.edges = new Float64Array(n * 4));
    let k = 0,
      x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity,
      radius = 0;
    for (const ring of rings) {
      const m = ring.length - (ringClosed(ring) ? 1 : 0);
      for (let i = 0; i < m; i++) {
        const a = ring[i],
          b = ring[(i + 1) % m];
        e[k++] = a[0];
        e[k++] = a[1];
        e[k++] = b[0];
        e[k++] = b[1];
        x0 = Math.min(x0, a[0]);
        y0 = Math.min(y0, a[1]);
        x1 = Math.max(x1, a[0]);
        y1 = Math.max(y1, a[1]);
        radius = Math.max(radius, Math.hypot(a[0], a[1]));
      }
    }
    if (!n) throw Error("contour vide");
    this.count = n;
    this.bounds = [x0, y0, x1, y1];
    this.radius = radius;
    this.buildBuckets();
  }
  buildBuckets() {
    const [x0, y0, x1, y1] = this.bounds,
      pad = REACH + BUCKET;
    this.gx = x0 - pad;
    this.gy = y0 - pad;
    this.nx = Math.ceil((x1 - x0 + 2 * pad) / BUCKET);
    this.ny = Math.ceil((y1 - y0 + 2 * pad) / BUCKET);
    const cells = this.nx * this.ny,
      count = new Int32Array(cells + 1),
      e = this.edges,
      each = (k, visit) => {
        const ax = e[4 * k],
          ay = e[4 * k + 1],
          bx = e[4 * k + 2],
          by = e[4 * k + 3],
          i0 = Math.max(0, Math.floor((Math.min(ax, bx) - REACH - this.gx) / BUCKET)),
          i1 = Math.min(this.nx - 1, Math.floor((Math.max(ax, bx) + REACH - this.gx) / BUCKET)),
          j0 = Math.max(0, Math.floor((Math.min(ay, by) - REACH - this.gy) / BUCKET)),
          j1 = Math.min(this.ny - 1, Math.floor((Math.max(ay, by) + REACH - this.gy) / BUCKET));
        for (let j = j0; j <= j1; j++)
          for (let i = i0; i <= i1; i++) {
            const bx0 = this.gx + i * BUCKET,
              by0 = this.gy + j * BUCKET;
            if (segmentRectFast(ax, ay, bx, by, bx0, by0, bx0 + BUCKET, by0 + BUCKET) <= REACH) visit(j * this.nx + i);
          }
      };
    for (let k = 0; k < this.count; k++) each(k, (c) => count[c + 1]++);
    for (let c = 0; c < cells; c++) count[c + 1] += count[c];
    const list = new Int32Array(count[cells]),
      at = count.slice(0, cells);
    for (let k = 0; k < this.count; k++) each(k, (c) => (list[at[c]++] = k));
    this.start = count;
    this.list = list;
    // each bucket's centre: inside or not (crossings of its row, to the right)
    const inside = (this.inside = new Uint8Array(cells)),
      xs = [];
    for (let j = 0; j < this.ny; j++) {
      const py = this.gy + (j + 0.5) * BUCKET;
      xs.length = 0;
      for (let k = 0; k < this.count; k++) {
        const ay = e[4 * k + 1],
          by = e[4 * k + 3];
        if (ay > py !== by > py) xs.push(e[4 * k] + ((py - ay) * (e[4 * k + 2] - e[4 * k])) / (by - ay));
      }
      xs.sort((a, b) => a - b);
      for (let i = 0, c = 0; i < this.nx; i++) {
        const px = this.gx + (i + 0.5) * BUCKET;
        while (c < xs.length && xs[c] <= px) c++;
        inside[j * this.nx + i] = (xs.length - c) & 1;
      }
    }
  }
  /** Whether (px, py), in bucket b, is inside: the bucket centre's side, flipped at each listed edge the segment centre -> point crosses. */
  side(b, px, py) {
    const nx = this.nx,
      cx = this.gx + ((b % nx) + 0.5) * BUCKET,
      cy = this.gy + (Math.floor(b / nx) + 0.5) * BUCKET,
      e = this.edges;
    let odd = this.inside[b];
    for (let s = this.start[b]; s < this.start[b + 1]; s++) {
      const k = this.list[s] * 4,
        ax = e[k],
        ay = e[k + 1],
        bx = e[k + 2],
        by = e[k + 3];
      // the edge's ends on either side of the line centre -> point (an end on the line counts as left)
      const oa = (px - cx) * (ay - cy) - (py - cy) * (ax - cx),
        ob = (px - cx) * (by - cy) - (py - cy) * (bx - cx);
      if (oa >= 0 === ob >= 0) continue;
      // the centre and the point on either side of the edge
      const oc = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax),
        op = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
      if (oc > 0 !== op > 0 && oc !== 0 && op !== 0) odd ^= 1;
    }
    return odd === 1;
  }
  bucket(x, y) {
    const i = Math.floor((x - this.gx) / BUCKET),
      j = Math.floor((y - this.gy) / BUCKET);
    return i < 0 || j < 0 || i >= this.nx || j >= this.ny ? -1 : j * this.nx + i;
  }
  contains(x, y) {
    const b = this.bucket(x, y);
    if (b < 0) return false;
    if (this.start[b] === this.start[b + 1]) return this.inside[b] === 1;
    return this.side(b, x, y);
  }
  beyond(x, y, reach) {
    const b = this.bucket(x, y);
    if (b < 0) return reach;
    if (this.start[b] === this.start[b + 1]) return this.inside[b] === 1 ? 0 : reach;
    if (this.side(b, x, y)) return 0;
    let d = reach;
    const e = this.edges;
    for (let s = this.start[b]; s < this.start[b + 1]; s++) {
      const k = this.list[s] * 4,
        v = segmentPoint(e[k], e[k + 1], e[k + 2], e[k + 3], x, y);
      if (v < d) d = v;
    }
    return d;
  }
  /** The edges listed in the buckets under the rectangle: visit(k) for each (with repeats), until it returns true. */
  scan(x0, y0, x1, y1, visit, empty = null) {
    const i0 = Math.max(0, Math.floor((x0 - this.gx) / BUCKET)),
      i1 = Math.min(this.nx - 1, Math.floor((x1 - this.gx) / BUCKET)),
      j0 = Math.max(0, Math.floor((y0 - this.gy) / BUCKET)),
      j1 = Math.min(this.ny - 1, Math.floor((y1 - this.gy) / BUCKET));
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const b = j * this.nx + i;
        if (this.start[b] === this.start[b + 1]) {
          if (empty?.(b)) return true;
          continue;
        }
        for (let s = this.start[b]; s < this.start[b + 1]; s++) if (visit(this.list[s] * 4)) return true;
      }
    return false;
  }
  touches(x0, y0, x1, y1, margin = 0) {
    const [bx0, by0, bx1, by1] = this.bounds;
    if (x1 < bx0 - margin || x0 > bx1 + margin || y1 < by0 - margin || y0 > by1 + margin) return false;
    if (margin > REACH) return this.rectDistance(x0, y0, x1, y1) <= margin;
    if (this.contains(x0, y0)) return true;
    const e = this.edges;
    // a bucket wholly inside under the rectangle, or an edge within the margin
    return this.scan(
      x0,
      y0,
      x1,
      y1,
      (k) => segmentRectFast(e[k], e[k + 1], e[k + 2], e[k + 3], x0, y0, x1, y1) <= margin,
      (b) => this.inside[b] === 1,
    );
  }
  rectInside(x0, y0, x1, y1, guard = 0) {
    if (!this.contains(x0, y0)) return false;
    if (guard > REACH) return this.edgeDistance(x0, y0, x1, y1) > guard;
    const e = this.edges;
    return !this.scan(x0, y0, x1, y1, (k) => segmentRectFast(e[k], e[k + 1], e[k + 2], e[k + 3], x0, y0, x1, y1) <= guard);
  }
  /** Distance from the rectangle to the nearest edge (every edge). */
  edgeDistance(x0, y0, x1, y1) {
    let d = Infinity;
    const e = this.edges;
    for (let k = 0; k < 4 * this.count; k += 4) d = Math.min(d, segmentRectFast(e[k], e[k + 1], e[k + 2], e[k + 3], x0, y0, x1, y1));
    return d;
  }
  rectDistance(x0, y0, x1, y1) {
    if (this.contains(x0, y0)) return 0;
    return this.edgeDistance(x0, y0, x1, y1);
  }
  geometry() {
    if (this.source) return this.source;
    throw Error("contour sans géométrie");
  }
  lngLatBounds() {
    const [x0, y0, x1, y1] = this.bounds;
    return [this.frame.toLngLat(x0, y0), this.frame.toLngLat(x1, y1)];
  }
}
const ringClosed = (ring) => ring.length > 1 && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1];

/** The zone of a catalogue entry: its contour (`zone`, GeoJSON) or the disc of its `radius`. */
export function sceneZone(entry) {
  const frame = sceneFrame(entry),
    geometry = entry.zone;
  if (geometry) {
    if (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon") throw Error(`Scène ${entry.id ?? "?"} : contour ${geometry.type} inconnu`);
    const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates,
      rings = polygons.flatMap((p) => p.map((ring) => ring.map(([lng, lat]) => frame.toLocal(lng, lat))));
    return new PolygonZone(rings, frame, geometry);
  }
  if (!(entry.radius > 0)) throw Error(`Scène ${entry.id ?? "?"} : ni contour ni rayon`);
  return new DiscZone(entry.radius, frame);
}

/**
 * The zone as a mask for the GPU (heatDrape.js: no heat inside the scene):
 * at most `size` texels a side over its rectangle, 255 where the texel's
 * centre is inside. Once per scene. { width, height, data (rows from the south), rect }.
 */
export function zoneMask(zone, size = 512) {
  const [x0, y0, x1, y1] = zone.bounds,
    step = Math.max(x1 - x0, y1 - y0) / size,
    width = Math.max(1, Math.ceil((x1 - x0) / step)),
    height = Math.max(1, Math.ceil((y1 - y0) / step)),
    data = new Uint8Array(width * height);
  for (let j = 0; j < height; j++)
    for (let i = 0; i < width; i++) data[j * width + i] = zone.contains(x0 + (i + 0.5) * step, y0 + (j + 0.5) * step) ? 255 : 0;
  return { width, height, data, rect: [x0, y0, x0 + width * step, y0 + height * step] };
}
