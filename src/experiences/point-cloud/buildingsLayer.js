// MapLibre custom layer recording the buildings (the scene's buildings collection and its
// fine meshes) into the scene renderer (BuildingsGPU), in the scene's
// rendering frame. Opaque, depth-tested, one row budget and one triangle
// budget. Lit by the scene's sun.
import { BuildingsTree } from "./buildingsTree.js";
import { frustumPlanes } from "../../rendering/math.js";
import { BuildingsGPU, BOX_BYTES } from "./buildingsGPU.js";
import { gpuMatrix, frameSize } from "../../rendering/gpu/engine.js";
import { metrics } from "../../rendering/metrics.js";
import { scheduler } from "../../data/scheduler.js";
const SUN = [0.35, -0.55, 0.76].map((x) => x / Math.hypot(0.35, 0.55, 0.76));

export class BuildingsLayer {
  id = "indexus-buildings";
  type = "custom";
  renderingMode = "3d";
  /**
   * getFrame() -> SceneFrame; source: networkSource(); options: BuildingsTree
   * options (frame, origin, radius…), and `engine`: the scene's WebGPU
   * renderer (rendering/gpu); interval() -> ms: least time between two walks
   * started by a camera move (data and fades are not held back).
   */
  constructor(getFrame, source, { engine, interval = () => 0, frameBudget = scheduler.budget, ...options } = {}) {
    this.getFrame = getFrame;
    this.frameBudget = frameBudget; // the frame's main-thread budget, shared (frameBudget.js)
    this.engine = engine;
    this.interval = interval;
    this.walkAt = -Infinity;
    this.started = performance.now();
    this.tree = new BuildingsTree(source, { ...options, upload: (list, owner) => this.renderer.upload(list, owner) });
    this.tree.onChange = () => {
      this.dirty = true;
      this.map?.triggerRepaint();
    };
  }
  onAdd(map) {
    this.map = map;
    globalThis.__indexusBuildings = this; // diagnostics (bench, captures)
    this.renderer = new BuildingsGPU(this.engine, { onEvict: (ranges) => this.tree.evict(ranges) });
    this.renderer.setPrices(this.prices);
  }
  /** The roofs of the buildings with sales: location -> [r, g, b] (0..255), or none. */
  setPrices(prices) {
    this.prices = prices ?? new Map();
    this.renderer?.setPrices(this.prices);
    this.dirty = true;
    this.map?.triggerRepaint();
  }
  /** Highlight one building (the location of its row), or none. */
  highlight(location, color) {
    this.tree.highlight = location ? { location, color } : null;
    this.dirty = true;
    this.map?.triggerRepaint();
  }
  render(gl) {
    const frame = this.getFrame(),
      matrix = frame?.viewMatrix,
      eye = frame?.cameraLocal;
    if (this.visible === false || !this.renderer || !matrix || !eye || frame.hidden) return;
    const t0 = metrics.start(),
      h = gl.drawingBufferHeight,
      css = Math.max(gl.canvas.clientHeight || h, 1),
      fov = (this.map.getVerticalFieldOfView() * Math.PI) / 180,
      key = Array.prototype.join.call(matrix, ",");
    // decoded meshes go to the GPU a few at a time, once the frame's layers have
    // had their share of the frame's budget (the vegetation's walk after this one)
    if (this.tree.pending.length && !this.flushing) {
      this.flushing = true;
      this.engine.beforePasses(() => {
        this.flushing = false;
        if (!this.renderer) return; // removed meanwhile
        const t1 = metrics.start();
        this.tree.flush(this.frameBudget);
        metrics.time("buildings", "upload", t1);
      });
    }
    // The level walk runs when the camera moved, data arrived or a fade is running,
    // in steps within the frame's budget (tree.steps): the frames between draw the
    // last choice (in world coordinates, so it stays right). A new walk starts once
    // the last one is drawn, with the camera of that moment.
    // A fade runs on the GPU's clock (buildingsGPU.js): no walk is needed for it
    // until it is over (then one, that draws the rows that came as steady).
    const now = performance.now(),
      moved = key !== this.lastKey,
      held = moved && !this.dirty && !this.fading && now - this.walkAt < this.interval(),
      faded = this.fading && now >= (this.renderer.fadeEnd ?? -Infinity),
      want = this.dirty || faded || moved;
    if (held && !this.walk) this.map.triggerRepaint(); // the move is taken up once the interval is over
    if (!this.walk && want && !held) {
      this.walkAt = performance.now();
      this.dirty = false;
      this.lastKey = key;
      this.walkCpu = 0;
      // errors are measured in CSS pixels: the same choice on any screen density
      const view = { eye, planes: frustumPlanes(matrix), focal: css / (2 * Math.tan(fov / 2)), now: performance.now(), matrix };
      this.walk = this.cycle(view);
    }
    if (this.walk) {
      const t1 = performance.now(),
        m1 = metrics.start();
      let step;
      this.frameBudget.run("buildings", () => (step = this.walk.next()).done);
      if (step?.done) {
        this.walk = null;
        this.fading = step.value.fading;
        this.selection = step.value.stats;
      }
      const ms = performance.now() - t1;
      this.walkCpu += ms;
      metrics.time("buildings", "select", m1);
      if (step?.done) metrics.gauge("buildings", "walkMs", this.walkCpu);
      this.map.triggerRepaint();
    }
    const sky = frame.celestial,
      view = {
        matrix,
        eye,
        sun: sky?.sunDirection ?? SUN,
        exposure: 0.45 + 0.55 * (sky?.daylight ?? 1),
        time: now,
        presence: frame.sceneOpacity ?? 1,
      };
    let calls = 0;
    const viewport = frameSize(this.engine, gl);
    this.engine.add("buildings", (pass) => {
      calls = this.renderer.draw(pass, { ...view, matrix: gpuMatrix(matrix), viewport });
    });
    // what a bench or the HUD reads; nothing is written to the page on every frame
    this.stats = this.selection;
    if (metrics.on && this.selection) {
      metrics.gauge("buildings", "items", this.selection.boxes + this.selection.levels[0] + this.selection.levels[1] + this.selection.levels[2]);
      metrics.gauge("buildings", "triangles", this.selection.triangles);
      metrics.gauge("buildings", "gpuBytes", this.renderer.gpuBytes + this.renderer.boxCapacity * BOX_BYTES);
      metrics.gauge("buildings", "drawCalls", calls);
      metrics.gauge("buildings", "pendingUploads", this.tree.pending.length);
      metrics.time("buildings", "render", t0);
    }
    // a frame per frame while a fade runs, the scene fades in or out (SceneFrame) or meshes wait; none after
    if (this.fading || this.tree.pending.length) this.map.triggerRepaint();
  }
  /** One walk, then its draw lists (BuildingsGPU.prepareSteps), as one generator of steps. */
  *cycle(view) {
    const selection = yield* this.tree.steps(view);
    yield* this.renderer.prepareSteps(selection);
    return selection;
  }
  get gpuBytes() {
    return this.renderer?.gpuBytes ?? 0;
  }
  onRemove() {
    this.renderer?.destroy();
    this.renderer = this.map = null;
    if (globalThis.__indexusBuildings === this) delete globalThis.__indexusBuildings;
  }
}
