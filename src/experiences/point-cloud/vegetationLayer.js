// MapLibre custom layer recording the vegetation collection into the scene
// renderer (VegetationGPU), in the scene's local frame. Opaque and
// depth-tested; a fixed budget of items.
import { VegetationTree, networkSource } from "./vegetationTree.js";
import { frustumPlanes } from "../../rendering/math.js";
import { VegetationRenderer } from "./vegetationCanopy.js";
import { zoneLister } from "./vegetationZones.js";
import { gpuMatrix, frameSize } from "../../rendering/gpu/engine.js";
import { metrics } from "../../rendering/metrics.js";
import { scheduler } from "../../data/scheduler.js";
const SUN = [0.35, -0.55, 0.76].map((x) => x / Math.hypot(0.35, 0.55, 0.76));

export class VegetationLayer {
  id = "indexus-vegetation";
  type = "custom";
  renderingMode = "3d";
  /**
   * options: collection, `engine` (the scene's WebGPU renderer), then
   * VegetationTree options; `floor` is in CSS pixels; interval() -> ms: least
   * time between two walks started by a camera move (data is not held back)
   */
  constructor(getPointLayer, getNetwork, { engine, interval = () => 0, frameBudget = scheduler.budget, delay = 0, zones = null, ...options } = {}) {
    // frameBudget: the frame's main-thread budget, shared (frameBudget.js)
    // options.mode (?veg) and options.fade (?vegFade) go to the tree and the renderer; delay: ?vegDelay
    // zones: the scene for the start read's zones (vegetationZones.js zoneLister options, collection aside)
    Object.assign(this, { getPointLayer, getNetwork, options, engine, interval, frameBudget, delay, zones, walkAt: -Infinity });
  }
  async onAdd(map) {
    this.map = map;
    this.splats = new VegetationRenderer(this.engine, { mode: this.options.mode ?? "dither" });
    this.started = performance.now();
    globalThis.__indexusVegetation = this; // diagnostics (bench, captures)
    const { collection, ...options } = this.options,
      zonesAt = this.zones && options.prefetch ? zoneLister({ collection, top: options.top ?? 0, ...this.zones }) : undefined,
      tree = new VegetationTree(networkSource(await this.getNetwork(), collection, scheduler, { delay: this.delay, zonesAt }), options);
    tree.onChange = () => {
      this.stale = true;
      map.triggerRepaint();
    };
    // drawn as soon as the root is there; the root is asked again while the collection is empty
    this.tree = tree;
    await tree.ready;
    tree.onChange();
  }
  render(gl) {
    const points = this.getPointLayer(),
      matrix = points?.viewMatrix,
      eye = points?.cameraLocal;
    if (this.visible === false || !this.tree || !matrix || !eye || points.hidden) return;
    // the frame's canvas (engine.js frameSize): one pixel per CSS pixel while the scene is shown
    const viewport = frameSize(this.engine, gl),
      height = viewport[1],
      ratio = height / Math.max(gl.canvas.clientHeight || height, 1), // canvas px per CSS px
      fov = ((this.map.getVerticalFieldOfView?.() ?? 36.87) * Math.PI) / 180;
    // the tree is walked when the camera moved or data arrived, in steps within
    // the frame's budget (tree.steps); the frames between draw the last walk
    const key = Array.prototype.join.call(matrix, ",");
    const held = !this.stale && key !== this.key && performance.now() - this.walkAt < this.interval();
    if (held && !this.walk) this.map.triggerRepaint(); // the move is taken up once the interval is over
    if (!this.walk && (this.stale || key !== this.key) && this.tree.root && !held) {
      this.walkAt = performance.now();
      this.stale = false;
      this.key = key;
      this.tree.floor = (this.options.floor ?? 4) * ratio;
      this.camera = { eye, planes: frustumPlanes(matrix), focal: height / (2 * Math.tan(fov / 2)), matrix };
      this.walk = this.tree.steps(this.camera);
    }
    if (this.walk) {
      const m0 = metrics.start();
      let step;
      this.frameBudget.run("vegetation", () => (step = this.walk.next()).done);
      if (step?.done) {
        this.walk = null;
        const t1 = performance.now();
        this.selection = step.value;
        this.splats.set(step.value);
        this.frameBudget.charge("vegetation.upload", performance.now() - t1);
        this.firstDraw ??= this.tree.stats.cells ? Math.round(performance.now() - this.started) : undefined;
        this.stats = { ...this.tree.stats, gpuBytes: this.splats.gpuBytes, firstDrawMs: this.firstDraw };
        if (metrics.on) {
          metrics.gauge("vegetation", "items", this.tree.stats.cells + this.tree.stats.returns);
          metrics.gauge("vegetation", "gpuBytes", this.splats.gpuBytes);
          metrics.count("vegetation", "uploadBytes", this.splats.uploaded ?? 0);
          metrics.gauge("vegetation", "held", this.tree.cellCount + this.tree.returnCount);
        }
      }
      metrics.time("vegetation", "select", m0);
      this.map.triggerRepaint();
    }
    // fades in time (?vegFadeMs): the last walk's fades moved to this frame, while they move only
    // (a frame asked for each, none once they are over); a walk just done set them itself
    // (not while a walk is under way: it trims before its emit, the last walk's cells may be gone)
    if (!this.walk && this.selection && this.tree.fading() && this.tree.refadedAt < performance.now() - 1) {
      const t2 = performance.now();
      this.tree.refade(t2);
      this.splats.refade(this.selection);
      this.frameBudget.charge("vegetation.fade", performance.now() - t2);
      if (metrics.on) metrics.count("vegetation", "fadeBytes", this.splats.refaded);
    }
    if (this.tree.fading()) this.map.triggerRepaint();
    // per pixel fades: the last walk's tau and band, the camera's focal
    const lod = this.tree.fade === "pixel" && this.camera ? { tau: this.tree.stats.tau ?? this.tree.floor, band: this.tree.band, focal: this.camera.focal } : null,
      now = performance.now();
    // cells fading in (their birth, VegetationTree appear): frames until they are all in
    if (now - this.tree.lastBirth < this.tree.appear + 50) this.map.triggerRepaint();
    this.splats.record(this.engine, { matrix: gpuMatrix(matrix), eye, sun: SUN, minPixels: 1.6 * ratio, viewport, lod, time: (now - this.tree.t0) / 1000, presence: points.sceneOpacity ?? 1 });
  }
  onRemove() {
    this.splats?.destroy();
    this.tree = this.splats = null;
    if (globalThis.__indexusVegetation === this) delete globalThis.__indexusVegetation;
  }
}
