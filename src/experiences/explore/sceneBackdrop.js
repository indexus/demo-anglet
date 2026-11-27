import { createOrthoTileSource, orthoCoverage, orthoTileSize } from "./orthoTiles.js";
import { SceneTerrain } from "./sceneTerrain.js";
import * as maplibregl from "maplibre-gl";
import { CoveredBasemap } from "./coveredBasemap.js";
import { getExperienceNetwork } from "../../data/network.js";
import { ORTHO_OPACITY, ORTHO_ZOOM, SCENE_ZOOM, ZONE_FADE_ZOOM } from "../weather/renderBudget.js";

// The scene's orthophoto (its raster collection) and LiDAR ground under the
// 3D layers, in MapLibre: its terrain (sceneTerrain.js) and a raster layer.
// The WebGPU scene draws a depth-only copy of the same terrain
// (groundLayer.js) so that its buildings and trees meet this ground.
// Zooms (renderBudget.js): the photo fades in from 11.5 to 12 (read from 11),
// covers the basemap from 12 when the view is inside the contour, the terrain
// from 12.5 (off under 12) so that the 3D of 13 stands on it.
export class SceneBackdrop {
  constructor(map) {
    this.map = map;
    this.serial = 0;
    this.daylight = 1;
    this.appliedDaylight = null;
    this.scene = null;
    this.terrain = new SceneTerrain(map);
    this.covered = new CoveredBasemap(map);
    this.move = () => this.syncCover();
    this.data = (e) => {
      if (e.sourceId === this.cover?.source && e.sourceDataType === "content") {
        this.coverReady = true;
        this.syncCover();
      }
    };
    map.on("move", this.move);
    map.on("sourcedata", this.data);
  }
  syncCover() {
    const enabled = this.map.getTerrain()?.source === "scene-terrain";
    this.terrain.setEnabled(this.terrainVisible !== false && this.map.getZoom() >= SCENE_ZOOM - (enabled ? 1 : 0.5));
    const terrain = this.map.getTerrain()?.source === "scene-terrain" ? "active" : "cached",
      data = this.map.getContainer().dataset;
    if (data.sceneTerrain !== terrain) data.sceneTerrain = terrain;
    if (!this.cover) return;
    const c = this.cover,
      b = this.map.getBounds(),
      nw = maplibregl.MercatorCoordinate.fromLngLat([b.getWest(), b.getNorth()]),
      se = maplibregl.MercatorCoordinate.fromLngLat([b.getEast(), b.getSouth()]);
    const bounds = [
      (nw.x - c.origin.x) / c.unit,
      (c.origin.y - se.y) / c.unit,
      (se.x - c.origin.x) / c.unit,
      (c.origin.y - nw.y) / c.unit,
    ];
    const ready =
      this.photoVisible !== false && this.coverReady &&
      this.map.getZoom() >= ORTHO_ZOOM &&
      this.map.isSourceLoaded(c.source);
    const state = this.covered.update({ ...c, bounds, ready }) ? "covered" : "visible";
    if (data.sceneBasemap !== state) data.sceneBasemap = state;
  }
  setGroundVisible(visible) { this.terrainVisible = visible; this.syncCover(); }
  setPhotoVisible(visible) {
    this.photoVisible = visible;
    if (this.map.getLayer("scene-orthophoto")) this.map.setLayoutProperty("scene-orthophoto", "visibility", visible ? "visible" : "none");
    if (!visible) this.covered.restore();
    this.syncCover();
  }
  setDaylight(value) {
    const daylight = Math.round(Math.max(0, Math.min(1, value)) * 40) / 40;
    this.daylight = daylight;
    if (daylight === this.appliedDaylight) return;
    this.appliedDaylight = daylight;
    const maximum = 0.32 + 0.68 * daylight;
    if (this.map.getLayer("scene-orthophoto"))
      this.map.setPaintProperty("scene-orthophoto", "raster-brightness-max", maximum);
    // the layer ids only: getStyle() would serialise the whole style on every daylight step
    for (const id of this.map.getLayersOrder())
      if (id.startsWith("scene-road-"))
        this.map.setPaintProperty(id, "line-color", daylight > 0.5 ? "#fafbf8" : "#79828d");
  }
  clear() {
    this.cover = null;
    this.coverReady = false;
    this.appliedDaylight = null;
    this.covered.restore();
    delete this.map.getContainer().dataset.sceneBasemap;
    delete this.map.getContainer().dataset.sceneTerrain;
    this.terrain.clear();
    this.tiles?.destroy();
    this.tiles = null;
    for (const layer of this.map.getStyle().layers.filter((l) => l.id.startsWith("scene-road-")))
      this.map.removeLayer(layer.id);
    if (this.map.getLayer("scene-orthophoto")) this.map.removeLayer("scene-orthophoto");
    if (this.map.getSource("scene-orthophoto")) this.map.removeSource("scene-orthophoto");
  }
  update(scene) {
    if (this.map.getZoom() < ZONE_FADE_ZOOM - 0.5 || !scene) return;
    if (this.scene === scene) return;
    this.abort?.abort();
    this.abort = new AbortController();
    this.scene = scene;
    const serial = ++this.serial;
    this.load(scene, serial).catch(() => {
      if (serial === this.serial) this.scene = null;
    });
  }
  async load(scene, serial) {
    // the photo is a collection of the scene: its tiles are read at their address, no manifest
    const network = await getExperienceNetwork();
    if (serial !== this.serial) return;
    const origin = maplibregl.MercatorCoordinate.fromLngLat(scene.origin),
      unit = scene.unit,
      corner = (x, y) => new maplibregl.MercatorCoordinate(origin.x + x * unit, origin.y - y * unit).toLngLat(),
      // the disc's square, or the contour's rectangle
      zone = scene.zone?.kind === "polygon" ? scene.zone : null,
      [bx0, by0, bx1, by1] = zone ? zone.bounds : [-scene.radius, -scene.radius, scene.radius, scene.radius],
      sw = corner(bx0, by0),
      ne = corner(bx1, by1);
    this.clear();
    this.terrain.load(scene);
    if (serial !== this.serial) return;
    this.syncCover();
    const paint = {
        "raster-opacity": ORTHO_OPACITY,
        "raster-fade-duration": 200,
      },
      before =
        this.map.getStyle().layers.find((layer) => layer.type === "symbol")?.id ??
        (this.map.getLayer("scene-frame") ? "scene-frame" : undefined);
    this.tiles = createOrthoTileSource(network, scene.collections.ortho, {
      levels: scene.orthoLevels,
      // a dense screen reads the level above (512-pixel tiles over 256 CSS pixels)
      tileSize: orthoTileSize(globalThis.devicePixelRatio),
      bounds: [sw.lng, sw.lat, ne.lng, ne.lat],
      covers: orthoCoverage({ origin: scene.origin, radius: scene.radius, levels: scene.orthoLevels, zone }),
    });
    this.cover = { source: "scene-orthophoto", origin, unit, center: [0, 0], radius: scene.radius, zone };
    this.map.addSource("scene-orthophoto", this.tiles.source);
    this.map.addLayer(
      { id: "scene-orthophoto", type: "raster", source: "scene-orthophoto", paint },
      before,
    );
    // Reuse the vector road geometry already loaded by the basemap. Keep names
    // above this white overlay and the 3D objects above the ground.
    const labels =
      this.map.getStyle().layers.find((l) => l.type === "symbol")?.id ??
      (this.map.getLayer("scene-frame") ? "scene-frame" : undefined);
    for (const road of this.map
      .getStyle()
      .layers.filter(
        (l) =>
          l.type === "line" &&
          /road|path/i.test(l.id) &&
          !/outline|casing/i.test(l.id) &&
          !l.id.startsWith("scene-"),
      )) {
      this.map.addLayer(
        {
          ...road,
          id: "scene-road-" + road.id,
          paint: {
            ...road.paint,
            "line-color": "#fafbf8",
            "line-opacity": ["interpolate", ["linear"], ["zoom"], ZONE_FADE_ZOOM, 0, ORTHO_ZOOM, 0.88],
            "line-blur": 0,
          },
        },
        labels,
      );
    }
    this.setPhotoVisible(this.photoVisible !== false);
    this.setDaylight(this.daylight);
  }
  destroy() {
    ++this.serial;
    this.abort?.abort();
    this.map.off("move", this.move);
    this.map.off("sourcedata", this.data);
    this.clear();
    this.covered.destroy();
  }
}
