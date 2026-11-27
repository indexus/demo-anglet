import * as maplibregl from "maplibre-gl";
import { scheduler } from "../../data/scheduler.js";
import { metrics } from "../../rendering/metrics.js";
// MapLibre's terrain, fed from the LiDAR ground collection (TerraLidHD2025v1):
// the orthophoto, roads and labels drape on the same ground that buildings,
// vegetation and lamps stand on. MapLibre picks the DEM tiles by screen size
// and the ground tiles follow the DEM pixel (TerrainTiles.grid), so the cost
// is the same at every zoom; DEM tiles coarser than the coarsest ground tiles
// are drawn from the rows of sums.
let sequence = 0;
export const TILE = 256, // DEM pixels per tile
  MAX_ZOOM = 18, // 0.43 m per DEM pixel: the finest ground tiles (0.6 m cells)
  MIN_ZOOM = 10; // 110 m per DEM pixel: rows of sums
/** Mapbox Terrain-RGB code of an altitude (0.1 m steps). */
export const encodeHeight = (height) => Math.max(0, Math.min(16777215, Math.round((height + 10000) * 10)));
/**
 * The altitude MapLibre's terrain has for a ground sample `height` at (x, y)
 * of the scene frame: eased to zero past the scene's edge (the map has no
 * relief there), then rounded to the DEM's 0.1 m. The WebGPU depth ground
 * (groundLayer.js) uses it too, so both grounds are the same surface.
 */
export function demHeight(height, x, y, radius) {
  const t = easing(x, y, radius);
  return encodeHeight(height * (1 - t * t * (3 - 2 * t))) / 10 - 10000;
}
/**
 * 0 inside the scene, 1 from FADE metres past its edge: the radius of its disc
 * (a number, as before) or its zone (data/sceneZone.js: beyond its contour).
 */
export const FADE = 128;
export function easing(x, y, edge) {
  return typeof edge === "number" ? Math.max(0, Math.min(1, (Math.hypot(x, y) - edge) / FADE)) : edge.beyond(x, y, FADE) / FADE;
}
export class SceneTerrain {
  constructor(map) {
    this.map = map;
    this.protocol = "indexus-terrain-" + ++sequence;
    this.revision = 0;
    this.active = false;
  }
  /** scene: { origin, unit, radius, tiles: TerrainTiles, zone? (data/sceneZone.js) } */
  load(scene) {
    this.clear();
    const tiles = scene.tiles,
      read = { demTiles: 0 },
      revision = ++this.revision,
      origin = maplibregl.MercatorCoordinate.fromLngLat(scene.origin),
      unit = scene.unit,
      // the disc as before; a contour eases past its edge
      radius = scene.zone?.kind === "polygon" ? scene.zone : scene.radius;
    maplibregl.addProtocol(this.protocol, async (params, controller) => {
      controller.signal.throwIfAborted();
      if (revision !== this.revision) throw new DOMException("Obsolete terrain", "AbortError");
      const [z, tx, ty] = new URL(params.url).pathname.slice(1).split("/").map(Number),
        span = 2 ** z,
        x0 = (tx / span - origin.x) / unit,
        x1 = ((tx + 1) / span - origin.x) / unit,
        y0 = (origin.y - (ty + 1) / span) / unit,
        y1 = (origin.y - ty / span) / unit,
        heights = await tiles.grid(x0, y0, x1, y1, TILE, controller.signal);
      controller.signal.throwIfAborted();
      // encoding the DEM pixels is main-thread work: slices of 32 rows within the shared frame budget
      const pixels = new Uint8ClampedArray(TILE * TILE * 4);
      await scheduler.rows(
        "terrain",
        TILE,
        // a contour reads a few edges per pixel near it (data/sceneZone.js): smaller steps, the same frame budget
        typeof radius === "number" ? 32 : 16,
        (from, to) => {
          for (let r = from, k = from * TILE; r < to; r++) {
            const y = y1 - ((r + 0.5) / TILE) * (y1 - y0);
            for (let c = 0; c < TILE; c++, k++) {
              // the ground eases to zero past the scene's edge, as the map has no relief there
              const x = x0 + ((c + 0.5) / TILE) * (x1 - x0),
                t = easing(x, y, radius),
                encoded = encodeHeight(heights[k] * (1 - t * t * (3 - 2 * t)));
              pixels[k * 4] = encoded >> 16;
              pixels[k * 4 + 1] = (encoded >> 8) & 255;
              pixels[k * 4 + 2] = encoded & 255;
              pixels[k * 4 + 3] = 255;
            }
          }
        },
        100 - z,
      );
      controller.signal.throwIfAborted();
      read.demTiles++;
      metrics.count("terrain", "demTiles");
      return { data: await createImageBitmap(new ImageData(pixels, TILE, TILE)) };
    });
    const [bx0, by0, bx1, by1] = scene.zone?.kind === "polygon" ? scene.zone.bounds : [-scene.radius, -scene.radius, scene.radius, scene.radius],
      corner = (x, y) => new maplibregl.MercatorCoordinate(origin.x + x * unit, origin.y - y * unit).toLngLat(),
      sw = corner(bx0 - 152, by0 - 152),
      ne = corner(bx1 + 152, by1 + 152);
    this.map.addSource("scene-terrain", {
      type: "raster-dem",
      tiles: [`${this.protocol}://tiles/{z}/{x}/{y}`],
      tileSize: TILE,
      minzoom: MIN_ZOOM,
      maxzoom: MAX_ZOOM,
      bounds: [sw.lng, sw.lat, ne.lng, ne.lat],
      encoding: "mapbox",
    });
    this.active = true;
    try {
      this.map.setTerrain({ source: "scene-terrain", exaggeration: 1 });
    } catch (error) {
      this.clear();
      throw error;
    }
    this.map.getContainer().dataset.sceneGround = "maplibre-lidar";
  }
  setEnabled(enabled) {
    if (!this.active) return;
    const current = this.map.getTerrain()?.source === "scene-terrain";
    if (current === enabled) return;
    this.map.setTerrain(enabled ? { source: "scene-terrain", exaggeration: 1 } : null);
  }
  clear() {
    ++this.revision;
    if (this.active) {
      if (this.map.getTerrain()?.source === "scene-terrain") this.map.setTerrain(null);
      if (this.map.getSource("scene-terrain")) this.map.removeSource("scene-terrain");
      this.active = false;
      delete this.map.getContainer().dataset.sceneGround;
    }
    maplibregl.removeProtocol(this.protocol);
  }
  destroy() {
    this.clear();
  }
}
