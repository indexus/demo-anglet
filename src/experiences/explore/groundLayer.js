// The scene's ground in the WebGPU renderer, depth only: MapLibre draws the
// ground (its terrain fed by sceneTerrain.js, the orthophoto draped), and
// this writes the same surface into the scene's depth buffer, so that
// buildings, vegetation and the effects after them are hidden behind the
// relief and meet the ground where they stand. Same surface: the altitudes
// of MapLibre's DEM pixels (TerrainTiles.grid at the DEM's spacing, eased
// and rounded as sceneTerrain.js encodes them, demHeight), taken where
// MapLibre's 128-cell terrain mesh reads them (vertex i of a tile on DEM
// pixel 2i), times the terrain's exaggeration (0 while MapLibre has no
// terrain). Which tiles: groundTiles.js; drawing: groundGPU.js.
import * as maplibregl from "maplibre-gl";
import { frustumPlanes } from "../../rendering/math.js";
import { GroundGPU, SIZE } from "../point-cloud/groundGPU.js";
import { rootTiles, selectGround, tileRect } from "../point-cloud/groundTiles.js";
import { MAX_ZOOM, TILE, demHeight } from "./sceneTerrain.js";
import { gpuMatrix } from "../../rendering/gpu/engine.js";
import { metrics } from "../../rendering/metrics.js";
import { scheduler } from "../../data/scheduler.js";

const ROOT_ZOOM = 14, // 1.8 km tiles: a handful cover a scene
  EDGE = 152, // metres of ground past the scene's edge (its radius or its contour), easing to the map's zero
  SLOTS = 64, // tiles held on the GPU (4 MB)
  BUDGET = 40, // tiles drawn at most
  READS = 8, // tiles read at once
  UPLOADS = 4; // tiles put on the GPU per frame at most

export class GroundLayer {
  id = "scene-ground";
  type = "custom";
  renderingMode = "3d";
  /** scene: { origin, unit, radius, heights, tiles: TerrainTiles, zone? (data/sceneZone.js) }; engine: SceneEngine. */
  /** budget: the frame's main-thread budget (frameBudget.js): the ground comes first in it, and is never held back. */
  constructor(getFrame, scene, engine, budget = scheduler.budget) {
    const origin = maplibregl.MercatorCoordinate.fromLngLat(scene.origin);
    // the disc as before (a square around it); a contour: its rectangle, and the tiles near it
    const zone = scene.zone?.kind === "polygon" ? scene.zone : null;
    Object.assign(this, { getFrame, engine, budget, terrain: scene.tiles, radius: zone ?? scene.radius });
    this.ground = {
      origin,
      unit: scene.unit,
      extent: zone ? zone.bounds.map((v, i) => v + (i < 2 ? -EDGE : EDGE)) : scene.radius + EDGE,
      heights: scene.heights,
      maxZoom: MAX_ZOOM,
      zone,
      edge: EDGE,
      near: new Map(), // tile key -> within EDGE of the contour
    };
    this.roots = rootTiles(ROOT_ZOOM, this.ground.extent, origin, scene.unit);
    this.held = new Map(); // key -> { slot, range, used }
    this.reads = new Map(); // key -> AbortController
    this.ready = []; // read tiles waiting for the GPU
    this.frameCount = 0;
    this.drawn = "";
  }
  onAdd(map) {
    this.map = map;
    this.gpu = new GroundGPU(this.engine, { slots: SLOTS });
  }
  render(gl) {
    const frame = this.getFrame(),
      matrix = frame?.viewMatrix,
      eye = frame?.cameraLocal;
    if (this.visible === false || !this.gpu || !matrix || !eye || frame.hidden) return;
    this.budget.run("ground", () => this.select(gl, matrix, eye), { forced: true });
  }
  /** The frame's tiles: uploads, selection, reads, draw. */
  select(gl, matrix, eye) {
    const t0 = metrics.start();
    this.frameCount++;
    let uploads = 0;
    while (this.ready.length && uploads < UPLOADS) {
      // no slot to give (every tile is drawn or wanted): the read waits, it is not read again
      if (!this.place(this.ready[0])) break;
      this.ready.shift();
      uploads++;
    }
    const css = Math.max(gl.canvas.clientHeight || gl.drawingBufferHeight, 1),
      fov = (this.map.getVerticalFieldOfView() * Math.PI) / 180,
      view = { eye, planes: frustumPlanes(matrix), focal: css / (2 * Math.tan(fov / 2)) },
      { draw, want } = selectGround(view, this.roots, this.ground, (key) => this.held.get(key)?.range, {
        budget: BUDGET,
      });
    this.request(want);
    const tiles = draw.map((tile) => {
        const held = this.held.get(tile.key);
        held.used = this.frameCount;
        // the tiles above a drawn one stay too: zooming out finds them, no hole
        for (let z = tile.z - 1, x = tile.x >> 1, y = tile.y >> 1; z >= ROOT_ZOOM; z--, x >>= 1, y >>= 1) {
          const above = this.held.get(`${z}/${x}/${y}`);
          if (above) above.used = this.frameCount;
        }
        return { rect: tile.rect, slot: held.slot };
      }),
      drawn = draw.map((tile) => tile.key).join(",");
    if (drawn !== this.drawn) {
      this.gpu.prepare(tiles);
      this.drawn = drawn;
    }
    // MapLibre's ground: its terrain's exaggeration, flat while it has none
    const terrain = this.map.getTerrain?.(),
      exaggeration = terrain?.source === "scene-terrain" ? (terrain.exaggeration ?? 1) : 0;
    this.engine.add("ground", (pass) => this.gpu.draw(pass, { matrix: gpuMatrix(matrix), exaggeration }));
    if (this.ready.length) this.map.triggerRepaint();
    if (metrics.on) {
      metrics.gauge("ground", "tiles", tiles.length);
      metrics.gauge("ground", "held", this.held.size);
      metrics.gauge("ground", "reads", this.reads.size);
      metrics.gauge("ground", "gpuBytes", this.gpu.gpuBytes);
      metrics.count("ground", "uploads", uploads);
      metrics.time("ground", "render", t0);
    }
    return true;
  }
  /** Read the wanted tiles (nearest first, READS at once); stop the reads no longer wanted. */
  request(want) {
    const wanted = new Set(want.map((tile) => tile.key));
    this.wanted = wanted;
    for (const [key, abort] of this.reads)
      if (!wanted.has(key)) {
        abort.abort();
        this.reads.delete(key);
      }
    for (const tile of want) {
      if (this.reads.size >= READS) break;
      if (this.reads.has(tile.key) || this.held.has(tile.key)) continue;
      // the slots are all taken by tiles drawn or wanted: reading more would only push
      // one of them out and read it again (24 reads a second of the same 6 tiles, at rest)
      if (this.reads.size + this.ready.length >= this.gpu.free.length + this.evictable()) break;
      const abort = new AbortController();
      this.reads.set(tile.key, abort);
      this.read(tile, abort.signal).then(
        (read) => {
          if (this.reads.get(tile.key) !== abort) return;
          this.reads.delete(tile.key);
          this.ready.push(read);
          this.map?.triggerRepaint();
        },
        (error) => {
          if (this.reads.get(tile.key) === abort) this.reads.delete(tile.key);
          if (error?.name !== "AbortError") console.warn("[ground]", tile.key, error);
        },
      );
    }
  }
  /** The tile's altitudes at its SIZE x SIZE vertices, as MapLibre's terrain has them. */
  async read(tile, signal) {
    const rect = tileRect(tile.z, tile.x, tile.y, this.ground.origin, this.ground.unit),
      dem = await demGrid(this.terrain, rect, signal);
    // near a contour each vertex reads a few of its edges: a step of the frame budget, not a long task
    if (this.ground.zone) return scheduler.work("ground", () => ({ key: tile.key, ...groundHeights(dem, rect, this.radius) }), 1);
    return { key: tile.key, ...groundHeights(dem, rect, this.radius) };
  }
  /**
   * Put a read tile on the GPU, in a free slot or the one drawn the longest
   * ago (never one of the last frame's); false when there is none.
   */
  place({ key, heights, range }) {
    let slot = this.gpu.take();
    if (slot < 0) {
      let oldest = null;
      for (const [k, held] of this.held)
        if (this.canEvict(k, held) && (!oldest || held.used < oldest[1].used)) oldest = [k, held];
      if (!oldest) return false;
      this.held.delete(oldest[0]);
      slot = oldest[1].slot;
    }
    this.gpu.upload(slot, heights);
    // placed now: not the first to go (a placed tile waiting for its siblings was pushed out next)
    this.held.set(key, { slot, range, used: this.frameCount });
    return true;
  }
  /** A held tile may give its slot: not drawn in the last frame, not wanted. */
  canEvict(key, held) {
    return held.used < this.frameCount - 1 && !this.wanted?.has(key);
  }
  evictable() {
    let n = 0;
    for (const [k, held] of this.held) if (this.canEvict(k, held)) n++;
    return n;
  }
  get gpuBytes() {
    return this.gpu?.gpuBytes ?? 0;
  }
  onRemove() {
    for (const abort of this.reads.values()) abort.abort();
    this.reads.clear();
    this.ready = [];
    this.held.clear();
    this.gpu?.destroy();
    this.gpu = this.map = null;
  }
}

/**
 * MapLibre's DEM pixels of the tile `rect` (sceneTerrain.js: TILE x TILE, the
 * pixel centres, north row first) and one more column and row, its east and
 * south neighbours' first, which MapLibre's mesh reads at the tile's edge:
 * (TILE + 1)² samples at the same spacing, so TerrainTiles reads the same level.
 */
export function demGrid(terrain, [x0, , x1, y1], signal = null) {
  const d = (x1 - x0) / TILE,
    n = TILE + 1;
  return terrain.grid(x0, y1 - n * d, x0 + n * d, y1, n, signal);
}
/**
 * From demGrid(): the SIZE x SIZE vertex altitudes (vertex i on DEM pixel 2i, as MapLibre's mesh) and their range;
 * edge: the scene's radius, or its zone (data/sceneZone.js).
 */
export function groundHeights(dem, [x0, , x1, y1], radius) {
  const n = TILE + 1,
    step = TILE / (SIZE - 1),
    d = (x1 - x0) / TILE,
    heights = new Float32Array(SIZE * SIZE);
  let low = Infinity,
    high = -Infinity;
  for (let j = 0; j < SIZE; j++)
    for (let i = 0; i < SIZE; i++) {
      const r = j * step,
        c = i * step,
        h = demHeight(dem[r * n + c], x0 + (c + 0.5) * d, y1 - (r + 0.5) * d, radius);
      heights[j * SIZE + i] = h;
      low = Math.min(low, h);
      high = Math.max(high, h);
    }
  return { heights, range: [low, high] };
}
