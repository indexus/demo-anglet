// The scene's street lamps at night (LampsGPU, atmosphereGPU.js): they light
// up in a wave from the view's centre when night falls, in the effects stage
// of the scene renderer (depth-tested, not written).
import * as maplibregl from "maplibre-gl";
import { LampsGPU } from "./atmosphereGPU.js";
import { gpuMatrix, frameSize } from "../../rendering/gpu/engine.js";
export function nightLightAmount(daylight) {
  const t = Math.max(0, Math.min(1, (daylight - 0.08) / 0.57));
  return 1 - t * t * (3 - 2 * t);
}
export class StreetLights {
  id = "scene-street-lights";
  type = "custom";
  renderingMode = "3d";
  // lamps: Float32Array of x, y, z per lamp (local metres), set by the scene
  lamps = null;
  /** engine: the scene's WebGPU renderer (rendering/gpu). */
  constructor(getLayer, { engine }) {
    this.getLayer = getLayer;
    this.engine = engine;
    this.data = null;
    this.count = 0;
    this.started = null;
  }
  onAdd(map) {
    this.map = map;
    this.gpu = new LampsGPU(this.engine);
  }
  render(gl) {
    const layer = this.getLayer();
    if (!layer || layer.hidden || !layer.viewMatrix || !layer.celestial || document.hidden) return;
    const night = nightLightAmount(layer.celestial.daylight);
    if (night < 0.005) {
      this.started = null;
      return;
    }
    const lamps = this.lamps;
    if (!lamps?.length) {
      if (layer.profile)
        this.map.getContainer().dataset.sceneLights = JSON.stringify({ anchors: 0, night });
      return;
    }
    if (lamps !== this.data) {
      this.data = lamps;
      this.count = lamps.length / 3;
      this.gpu.setLamps(lamps);
    }
    const now = performance.now();
    if (this.started === null) {
      this.started = now;
      const q = maplibregl.MercatorCoordinate.fromLngLat(this.map.getCenter()),
        origin = layer.origin;
      this.centre = [
        (q.x - origin.x) / layer.horizontalUnits,
        (origin.y - q.y) / layer.horizontalUnits,
      ];
    }
    const elapsed = (now - this.started) / 1000,
      view = {
        matrix: gpuMatrix(layer.viewMatrix),
        viewport: frameSize(this.engine, gl),
        centre: this.centre,
        elapsed,
        night,
        radius: layer.cropRadius ?? 0,
        opacity: layer.sceneOpacity ?? 1,
        speed: Math.max(55, (layer.cropRadius ?? 0) / 7),
      };
    this.view = view; // what was last drawn (tests, captures)
    this.engine.add("lights", (pass) => this.gpu.draw(pass, view), { stage: "effects" });
    if (layer.profile && now - (this.reportAt ?? 0) > 500) this.report(gl, layer, lamps, now, elapsed, night);
    if (
      elapsed <
      ((layer.cropRadius || 500) + Math.hypot(...this.centre)) /
        Math.max(55, (layer.cropRadius ?? 0) / 7) +
        1
    )
      this.map.triggerRepaint();
  }
  /** What the bench reads (?profile3d): anchors, visible lamps and their pixels. */
  report(gl, layer, lamps, now, elapsed, night) {
    this.reportAt = now;
    const m = layer.viewMatrix,
      visible = [];
    for (let i = 0; i < lamps.length; i += 3) {
      const p = [lamps[i], lamps[i + 1], lamps[i + 2] + 5.5],
        c = [0, 1, 2, 3].map((r) => m[r] * p[0] + m[r + 4] * p[1] + m[r + 8] * p[2] + m[r + 12]);
      if (c[3] > 0 && Math.abs(c[0]) < c[3] && Math.abs(c[1]) < c[3])
        visible.push({
          position: p,
          pixel: [
            ((c[0] / c[3]) * 0.5 + 0.5) * gl.drawingBufferWidth,
            (0.5 - (c[1] / c[3]) * 0.5) * gl.drawingBufferHeight,
          ],
        });
    }
    this.map.getContainer().dataset.sceneLights = JSON.stringify({
      anchors: this.count,
      visible: visible.length,
      samples: visible.slice(0, 5),
      night,
      elapsed,
      waveSpeed: Math.max(55, (layer.cropRadius ?? 0) / 7),
    });
  }
  onRemove() {
    this.data = null;
    this.map = null;
    this.gpu?.destroy();
    this.gpu = null;
  }
}
