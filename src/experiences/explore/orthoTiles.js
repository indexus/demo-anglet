import * as maplibregl from "maplibre-gl";
import { byteCache, cellBounds, tileAnchor, tilesOfZxy } from "../point-cloud/geoSpace.js";
import { scheduler as sharedScheduler } from "../../data/scheduler.js";
import { metrics } from "../../rendering/metrics.js";
// The orthophoto as a MapLibre raster source read from its collection
// (OrthoBDORT2024v1, docs/collections.md 1.5). A tile of the collection is a
// cell of the shared Space, at the 16-character location of its centre; a
// MapLibre tile z/x/y is the same column of two or three of them, stacked
// here. No manifest: the address of a tile is computed. Which tiles exist is
// known from the catalogue (orthoCoverage), so no read asks for a place
// without a tile; one that still answers "missing content" is remembered.
// MapLibre owns visibility, priority, cancellation, texture eviction,
// mipmaps and parent/child fades, so the number of tiles on screen is the
// same at every zoom.
let sequence = 0;
const SIZE = 512,
  METRES_PER_DEGREE = (Math.PI * 6378137) / 180;

/**
 * Which tiles of the collection exist: scripts/world/ortho.py writes the cells
 * of its finest level that touch the scene's disc (`radius` metres around
 * `origin` [lng, lat]), and their parents at the coarser levels, which touch
 * the disc too. With a contour (`zone`, data/sceneZone.js: core
 * tools/prep/commune writes the cells that touch it), a cell is its rectangle
 * in the scene's frame, and is there when it touches the zone. Returns
 * (t, row, col) -> boolean.
 */
export function orthoCoverage({ origin, radius, levels, zone = null }) {
  if (zone?.kind === "polygon") {
    const local = zone.frame.toLocal;
    return (t, row, col) => {
      if (levels && (t < levels[0] || t > levels[1])) return false;
      const b = cellBounds(row, col, t),
        [x0, y0] = local(b.west, b.south),
        [x1, y1] = local(b.east, b.north);
      return zone.touches(x0, y0, x1, y1, 0);
    };
  }
  const [lng, lat] = origin,
    cos = Math.cos((lat * Math.PI) / 180);
  return (t, row, col) => {
    if (levels && (t < levels[0] || t > levels[1])) return false;
    const b = cellBounds(row, col, t),
      dy = Math.max(b.south - lat, 0, lat - b.north) * METRES_PER_DEGREE,
      dx = Math.max(b.west - lng, 0, lng - b.east) * METRES_PER_DEGREE * cos;
    return dx * dx + dy * dy < radius * radius;
  };
}

/**
 * What the MapLibre tile z/x/y is made of: [{ id, location, y, height }] in
 * pixels of a `size` tile, north first. The rows of the collection's tiles
 * stack on whole pixels: each part from its rounded top to its rounded bottom
 * (a 0.5 px shift at most), so that two parts meet without a seam; drawn at
 * fractional rows, the canvas blended both edges and a faint line of the
 * map under the photo showed between them.
 */
export function tilePlan(collection, z, x, y, size = SIZE) {
  return tilesOfZxy(z, x, y).map(({ t, row, col, top, bottom }) => {
    const y0 = Math.round(top * size),
      y1 = Math.round(bottom * size);
    return {
      t,
      row,
      col,
      id: `${t}/${row}/${col}`,
      location: tileAnchor(t, row, col, collection),
      y: y0,
      height: y1 - y0,
    };
  });
}
/**
 * MapLibre's tile size for the photo on a screen of `ratio` device pixels per
 * CSS pixel: 512 (a tile of the collection over 512 CSS pixels), 256 on a
 * dense screen (a tile of the level above at the same place: one texel per
 * device pixel, as many more tiles to read).
 */
export function orthoTileSize(ratio = 1) {
  return (Number(ratio) || 1) >= 1.5 ? 256 : SIZE;
}
const hex = (buffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * Encoded tiles kept (about 270 tiles of 90 kB): with 8 MB a 6 min tour of Anglet
 * read 40 % of its tiles again (1572 reads of 949 tiles); the node answers them no-store.
 */
export const ORTHO_CACHE_BYTES = 24 << 20;

/**
 * Reader of the collection's tiles: bytes(part) -> ArrayBuffer of the
 * image, or null where the collection has no tile. Encoded tiles are kept in a
 * cache of `cacheBytes` (a tile serves the MapLibre tile above and below it).
 */
export function orthoReader(network, collection, { cacheBytes = ORTHO_CACHE_BYTES, scheduler = sharedScheduler, covers = null } = {}) {
  const cache = byteCache(cacheBytes),
    stats = { requests: 0, bytes: 0, missing: 0 },
    // locations where the collection has no tile: kept for the session (the byte cache would evict them)
    missing = new Set();
  async function read(part, signal) {
    stats.requests++;
    let value;
    try {
      value = await network.readContent(collection, part.location, {
        path: part.id,
        signal,
        consume: async (response) => ({
          sha256: response.headers.get("X-Indexus-Sha256"),
          buffer: await response.arrayBuffer(),
        }),
      });
    } catch (error) {
      // no tile there: the node finds no content part at that location
      if (/HTTP 422/.test(error?.message)) {
        stats.missing++;
        missing.add(part.location);
        return null;
      }
      throw error;
    }
    if (value.sha256 && hex(await crypto.subtle.digest("SHA-256", value.buffer)) !== value.sha256.toLowerCase())
      throw Object.assign(Error("Orthophoto tile checksum mismatch"), { fatal: true });
    stats.bytes += value.buffer.byteLength;
    return value.buffer;
  }
  return {
    stats,
    *loadedCells() { for (const [, pending] of cache.entries()) if (pending.value) yield pending.cell; },
    get cacheBytes() {
      return cache.bytes;
    },
    /**
     * One read serves every MapLibre tile that waits for it; it goes through the
     * shared scheduler (layer "ortho", coarse levels first) and stops when every
     * waiting tile has been cancelled by MapLibre.
     */
    bytes(part, signal = null, priority = 0) {
      // outside the collection's coverage: nothing to ask for
      if (covers && !covers(part.t, part.row, part.col)) {
        stats.skipped = (stats.skipped ?? 0) + 1;
        return Promise.resolve(null);
      }
      if (missing.has(part.location)) return Promise.resolve(null);
      let pending = cache.get(part.location);
      if (!pending) {
        pending = scheduler
          .request("ortho", part.location, (readSignal) => read(part, readSignal), {
            priority,
            size: (buffer) => buffer?.byteLength ?? 64,
            signal,
          })
          .then(
            (buffer) => {
              cache.resize(part.location, buffer?.byteLength ?? 64);
              pending.value = buffer;
              return buffer;
            },
            (error) => {
              cache.delete(part.location); // asked again next time
              throw error;
            },
          );
        pending.cell = { t: part.t, row: part.row, col: part.col };
        cache.set(part.location, pending);
      } else if (signal && pending.value === undefined) scheduler.request("ortho", part.location, null, { priority, signal });
      return pending;
    },
  };
}
/**
 * The image of the MapLibre tile z/x/y (SIZE x SIZE, north up) from the
 * collection's tiles: an ImageBitmap, transparent where the collection has no
 * tile.
 */
export async function orthoImage(reader, collection, z, x, y, signal = null) {
  const plan = tilePlan(collection, z, x, y);
  signal?.throwIfAborted();
  const parts = await Promise.all(plan.map((part) => reader.bytes(part, signal, 100 - z)));
  signal?.throwIfAborted();
  const canvas = new OffscreenCanvas(SIZE, SIZE),
    context = canvas.getContext("2d");
  for (let k = 0; k < plan.length; k++) {
    if (!parts[k] || plan[k].height <= 0) continue;
    const image = await createImageBitmap(new Blob([parts[k]], { type: "image/webp" }));
    // a tile's rows are even in latitude; inside one tile that is Mercator to 0.03 px
    context.drawImage(image, 0, plan[k].y, SIZE, plan[k].height);
    image.close();
  }
  signal?.throwIfAborted();
  metrics.count("ortho", "tiles");
  metrics.gauge("ortho", "cacheBytes", reader.cacheBytes);
  return canvas.transferToImageBitmap();
}
/**
 * MapLibre source of the collection: { source, stats, destroy() }.
 * levels: [coarsest, finest] tile levels the collection holds; bounds: [west, south, east, north];
 * covers: orthoCoverage() of the scene (no read outside it); tileSize: orthoTileSize().
 */
export function createOrthoTileSource(network, collection, { levels, bounds, cacheBytes, covers = null, tileSize = SIZE }) {
  if (!Array.isArray(levels) || !(levels[0] >= 0 && levels[0] <= levels[1] && levels[1] <= 22))
    throw Error("Invalid orthophoto levels");
  const reader = orthoReader(network, collection, { cacheBytes, covers }),
    protocol = "indexus-ortho-" + ++sequence;
  maplibregl.addProtocol(protocol, async (params, controller) => {
    const [z, x, y] = new URL(params.url).pathname.slice(1).split("/").map(Number);
    return { data: await orthoImage(reader, collection, z, x, y, controller.signal) };
  });
  return {
    stats: reader.stats,
    loadedCells: () => reader.loadedCells(),
    source: {
      type: "raster",
      tiles: [`${protocol}://tiles/{z}/{x}/{y}`],
      // the images are SIZE pixels whatever the tile size MapLibre lays them over
      tileSize,
      minzoom: levels[0],
      maxzoom: levels[1],
      bounds,
    },
    destroy() {
      maplibregl.removeProtocol(protocol);
    },
  };
}
