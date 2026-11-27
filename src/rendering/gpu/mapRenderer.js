// The map's one WebGPU renderer: the SDK's device, one engine (one canvas, one
// depth buffer, one submit of its passes per frame) and one composite layer,
// the only WebGL program of what it draws. MapLibre keeps the basemap and the
// labels; the scene, the heat maps and the weather are drawn here, in one
// frame. The composite sits where the heat maps did as MapLibre layers, under
// the water, the roads and the borders, while the map is 2D; under the labels
// while a scene is shown (its 3D stands over the basemap).
//
// Layers that record passes (the scene's) are added before the composite
// (map.addLayer(layer, renderer.before)). Hosts (heat drapes, the weather
// effects) are called when the composite runs, with the frame's camera, and
// add their passes then. The camera's world is in metres: from the scene's
// origin while a scene is shown (setScene), else from the map's centre, so
// that float32 stays precise at street zoom:
//   { matrix: world → WebGPU clip, glMatrix: world → OpenGL clip,
//     toMercator: [x0, y0, sx, sy], ground: 0, viewport, bounds: [w, s, e, n],
//     disc: the scene's radius in metres (with a scene), zone: its contour (data/sceneZone.js),
//     mercatorMatrix: Mercator → OpenGL clip, the 2D map's (no scene shown),
//     scene: whether a scene is shown, zoom: the map's, engineScale: the canvas's
//     pixels per drawable pixel (engine.js) }
// Without a scene shown, `zone` is the contour of the scene the view is near
// (setNearZone, scene.js), if any: the 2D weather fades out over it as the
// orthophoto comes in (renderBudget.js zoneWeatherFade).
//
// While a scene is shown the canvas has one pixel per CSS pixel (the 3D's
// budget of before) and MapLibre draws the photo, roads and labels at the
// screen's ratio: the composite stretches the canvas (engine.scale).
import * as maplibregl from "maplibre-gl";
import { frameOf } from "js-indexus-sdk/gpu";
import { SceneEngine, gpuMatrix, sceneDevice } from "./engine.js";
import { SceneComposite } from "./composite.js";
import { localMatrix } from "../../experiences/point-cloud/sceneFrame.js";

const renderers = new WeakMap();
// the heat maps' slot of the 2D map, as their MapLibre layers had it
const HEAT_BEFORE = ["Water", "water", "water-shadow", "Country labels", "country-label"];

/** The map's renderer, made on first use; null without WebGPU. */
export function mapRenderer(map) {
  let renderer = renderers.get(map);
  if (!renderer) {
    renderer = sceneDevice().then((device) => (device ? new MapRenderer(map, device) : null));
    renderers.set(map, renderer);
  }
  return renderer;
}

class MapRenderer {
  constructor(map, device) {
    this.map = map;
    this.device = device;
    this.engine = new SceneEngine(device);
    this.hosts = new Set();
    this.scene = null;
    this.near = null;
    // a scene shown: the canvas at one pixel per CSS pixel
    const scale = () => (this.scene && !this.scene.hidden ? 1 / Math.max(1, map.getPixelRatio()) : 1);
    Object.defineProperty(this.engine, "scale", { get: scale, configurable: true });
    this.composite = new SceneComposite(this.engine);
    this.composite.beforeRender = (gl, args) => this.frame(gl, args);
    this.labels = map.getLayersOrder().find((id) => map.getLayer(id)?.type === "symbol");
    this.flat = HEAT_BEFORE.find((id) => map.getLayer(id)) ?? this.labels;
    map.addLayer(this.composite, this.flat);
  }
  /** The layer id to add a pass-recording layer before. */
  get before() {
    return this.composite.id;
  }
  /** host(camera) adds its passes every frame; returns its removal. */
  host(host) {
    this.hosts.add(host);
    return () => this.hosts.delete(host);
  }
  /**
   * The scene's frame (SceneFrame) while a scene is shown, else null. Set it
   * before adding the scene's layers (before this.before): the composite
   * moves under the labels with a scene, back to the heat maps' slot without.
   */
  setScene(frame) {
    this.scene = frame;
    const before = frame ? this.labels : this.flat;
    if (this.map.getLayer(this.composite.id) && before !== this.composite.id) this.map.moveLayer(this.composite.id, before);
  }
  /** The contour of the scene the view is near (data/sceneZone.js), or null: the 2D weather leaves it as the photo comes. */
  setNearZone(zone) {
    this.near = zone?.kind === "polygon" ? zone : null;
  }
  camera(gl, args) {
    const viewport = this.engine.frameSize(gl),
      bounds = this.map.getBounds().toArray().flat(),
      scene = this.scene,
      zoom = this.map.getZoom(),
      engineScale = this.engine.scale;
    if (scene?.viewMatrix && !scene.hidden) {
      const { origin, horizontalUnits: unit } = scene;
      return {
        glMatrix: scene.viewMatrix,
        matrix: gpuMatrix(scene.viewMatrix),
        toMercator: [origin.x, origin.y, unit, -unit],
        ground: 0,
        viewport,
        bounds,
        // the scene's disc, or its contour: the heat maps keep out of it (heatDrape.js)
        disc: scene.cropRadius ?? 0,
        zone: scene.zone ?? null,
        scene: true,
        // the scene fading in or out (SceneFrame.setHidden): 0..1
        presence: scene.sceneOpacity ?? 1,
        zoom,
        engineScale,
      };
    }
    const origin = maplibregl.MercatorCoordinate.fromLngLat(this.map.getCenter()),
      unit = origin.meterInMercatorCoordinateUnits(),
      glMatrix = localMatrix(args.defaultProjectionData.mainMatrix, origin, unit);
    return {
      glMatrix,
      matrix: gpuMatrix(glMatrix),
      toMercator: [origin.x, origin.y, unit, -unit],
      ground: 0,
      viewport,
      bounds,
      // the heat maps' screen-space matrix, the one their MapLibre layers read
      // (MapLibre 5+ hands it to custom layers as defaultProjectionData.mainMatrix)
      mercatorMatrix: this.map.transform?.mercatorMatrix ?? args.defaultProjectionData?.mainMatrix ?? null,
      zone: this.near,
      scene: false,
      zoom,
      engineScale,
    };
  }
  /** Before the engine's frame: the hosts add their passes, then the device's frame (heat packs and rasters) is submitted. */
  frame(gl, args) {
    if (this.hosts.size) {
      const camera = this.camera(gl, args);
      for (const host of this.hosts) host(camera);
    }
    frameOf(this.device).submit();
  }
}
