// The scene's WebGPU renderer: one device (the SDK's, shared with its heat
// layers and compute kernels), one canvas, one depth buffer, one submit per
// frame. Layers add passes during MapLibre's frame; the composite layer
// (composite.js) runs them, submits, and draws the canvas into MapLibre's
// framebuffer under the labels. A pass is timed by timestamp queries when the
// device has them and the metrics are on (HUD: gpu.<pass>).
import { getGPUContext } from "js-indexus-sdk/gpu";
import { metrics } from "../metrics.js";

export const DEPTH_FORMAT = "depth24plus";
const MAX_PASSES = 12;
const STAGES = { opaque: 0, drape: 1, effects: 2 };

/** The shared device (it has timestamp-query when the adapter does), or null without WebGPU. */
export async function sceneDevice() {
  return (await getGPUContext())?.device ?? null;
}

/** A MapLibre view matrix (clip z in -1..1) for WebGPU (clip z in 0..1), as float32. */
export function gpuMatrix(m, out = new Float32Array(16)) {
  for (let c = 0; c < 4; c++) {
    out[c * 4] = m[c * 4];
    out[c * 4 + 1] = m[c * 4 + 1];
    out[c * 4 + 2] = 0.5 * m[c * 4 + 2] + 0.5 * m[c * 4 + 3];
    out[c * 4 + 3] = m[c * 4 + 3];
  }
  return out;
}

// for each element (c, r) of the inverse, the 3 x 3 minor of (r, c): its entries' indices in m
const MINORS = (() => {
  const t = new Uint8Array(16 * 9);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      const rows = [0, 1, 2, 3].filter((k) => k !== c),
        cols = [0, 1, 2, 3].filter((k) => k !== r);
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) t[(c * 4 + r) * 9 + i * 3 + j] = cols[j] * 4 + rows[i];
    }
  return t;
})();
/** Inverse of a 4 x 4 column-major matrix, in double precision, by cofactors (no allocation but `out`). */
export function invert(m, out = new Float64Array(16)) {
  const t = MINORS;
  for (let k = 0, o = 0; k < 16; k++, o += 9) {
    const minor =
      m[t[o]] * (m[t[o + 4]] * m[t[o + 8]] - m[t[o + 5]] * m[t[o + 7]]) -
      m[t[o + 1]] * (m[t[o + 3]] * m[t[o + 8]] - m[t[o + 5]] * m[t[o + 6]]) +
      m[t[o + 2]] * (m[t[o + 3]] * m[t[o + 7]] - m[t[o + 4]] * m[t[o + 6]]);
    out[k] = (((k >> 2) + (k & 3)) % 2 ? -1 : 1) * minor;
  }
  const det = m[0] * out[0] + m[4] * out[1] + m[8] * out[2] + m[12] * out[3];
  for (let k = 0; k < 16; k++) out[k] = out[k] / det;
  return out;
}

/** Clip matrix of a Mercator rectangle [west x, north y, east x, south y]: x to -1..1, north to +1. */
export function rectMatrix([x0, y0, x1, y1], out = new Float32Array(16)) {
  out.fill(0);
  out[0] = 2 / (x1 - x0);
  out[5] = -2 / (y1 - y0);
  out[10] = 1;
  out[12] = -1 - (2 * x0) / (x1 - x0);
  out[13] = 1 + (2 * y0) / (y1 - y0);
  out[15] = 1;
  return out;
}

/**
 * The size of the frame's canvas for MapLibre's drawable `gl`: the engine's
 * frameSize (its scale applied), or the drawable's for an engine without one (tests).
 */
export function frameSize(engine, gl) {
  return engine?.frameSize ? engine.frameSize(gl) : [gl.drawingBufferWidth, gl.drawingBufferHeight];
}

export class SceneEngine {
  /**
   * canvas: where the frame is drawn; by default an OffscreenCanvas that the
   * composite layer copies into MapLibre's framebuffer (a test page passes
   * its own, with its usage).
   */
  constructor(device, { canvas = new OffscreenCanvas(1, 1), usage = GPUTextureUsage.RENDER_ATTACHMENT } = {}) {
    this.device = device;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.canvas = canvas;
    this.context = this.canvas.getContext("webgpu");
    this.context.configure({ device, format: this.format, alphaMode: "premultiplied", usage });
    this.passes = [];
    this.preparing = [];
    this.before = [];
    this.depth = null;
    // the canvas's pixels per drawable pixel (mapRenderer.js: 1 / pixel ratio while a
    // scene is shown, the 3D's single-pixel budget; the composite stretches it over the map)
    this.scale = 1;
    this.viewport = [1, 1];
    if (device.features.has("timestamp-query")) {
      this.queries = device.createQuerySet({ type: "timestamp", count: 2 * MAX_PASSES });
      this.resolved = device.createBuffer({ size: 16 * MAX_PASSES, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
      this.readback = device.createBuffer({ size: 16 * MAX_PASSES, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      this.reading = false;
    }
  }
  /**
   * record(pass, frame) draws into this frame's colour and depth. Stages run in
   * order: "opaque" (the 3D, depth written), "drape" (what lies on the 3D:
   * heat maps), then "effects" (sky effects, weather, lamps). In the last
   * two the depth attachment is read-only and frame.depth, the depth
   * texture, can be sampled in the same pass.
   */
  add(name, record, { stage = "opaque" } = {}) {
    this.passes.push({ name, record, stage });
  }
  /** fn() runs once, when the frame's layers have run and before its passes are recorded (uploads). */
  beforePasses(fn) {
    this.before.push(fn);
  }
  /** encode(encoder) runs once, at the start of the next frame's encoder (compute, rasters). */
  prepare(encode) {
    this.preparing.push(encode);
  }
  /** [width, height] of this frame's canvas for MapLibre's drawable (the same array every frame). */
  frameSize(gl) {
    const s = this.scale ?? 1;
    this.viewport[0] = Math.max(1, Math.round(gl.drawingBufferWidth * s));
    this.viewport[1] = Math.max(1, Math.round(gl.drawingBufferHeight * s));
    return this.viewport;
  }
  /** Run the frame's passes into a width x height canvas; false when there was nothing to draw. */
  render(width, height) {
    const { device } = this;
    for (const fn of this.before.splice(0)) fn();
    if (this.canvas.width !== width || this.canvas.height !== height || !this.depth) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.depth?.destroy();
      this.depth = device.createTexture({
        size: [width, height],
        format: DEPTH_FORMAT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
    }
    const passes = this.passes.splice(0).sort((a, b) => STAGES[a.stage] - STAGES[b.stage]),
      encoder = device.createCommandEncoder(),
      color = this.context.getCurrentTexture().createView(),
      depth = this.depth.createView(),
      timed = this.queries && metrics.on && !this.reading ? passes.slice(0, MAX_PASSES) : [];
    for (const encode of this.preparing.splice(0)) encode(encoder);
    // the first render pass clears colour and depth: an opaque one, empty when
    // the frame has only effects (their depth is read-only). Timed, every pass
    // is a render pass with its begin/end timestamps; otherwise the passes of
    // the same depth use share one render pass (one load and store of the
    // attachments): the opaque ones, then the drape and effects ones.
    const run = passes[0]?.stage === "opaque" ? passes : [{ name: "clear", record() {}, stage: "opaque" }, ...passes],
      groups = [];
    for (const p of run) {
      const last = groups.at(-1);
      if (last && !timed.length && (last[0].stage === "opaque") === (p.stage === "opaque")) last.push(p);
      else groups.push([p]);
    }
    groups.forEach((group, i) => {
      const effects = group[0].stage !== "opaque",
        k = timed.indexOf(group[0]),
        pass = encoder.beginRenderPass({
          colorAttachments: [{ view: color, loadOp: i ? "load" : "clear", storeOp: "store", clearValue: [0, 0, 0, 0] }],
          depthStencilAttachment: effects
            ? { view: depth, depthReadOnly: true }
            : { view: depth, depthLoadOp: i ? "load" : "clear", depthClearValue: 1, depthStoreOp: "store" },
          ...(k >= 0
            ? { timestampWrites: { querySet: this.queries, beginningOfPassWriteIndex: 2 * k, endOfPassWriteIndex: 2 * k + 1 } }
            : {}),
        });
      for (const p of group) p.record(pass, { depth: this.depth, width, height });
      pass.end();
    });
    if (timed.length) {
      encoder.resolveQuerySet(this.queries, 0, 2 * timed.length, this.resolved, 0);
      encoder.copyBufferToBuffer(this.resolved, 0, this.readback, 0, 16 * timed.length);
    }
    this.beforeSubmit?.(encoder, this.context.getCurrentTexture());
    device.queue.submit([encoder.finish()]);
    if (timed.length) this.readTimes(timed.map((p) => p.name));
    return passes.length > 0;
  }
  /** Pass times for the HUD: a statistic the CPU reads, a frame or two late. */
  readTimes(names) {
    this.reading = true;
    this.readback.mapAsync(GPUMapMode.READ).then(
      () => {
        const t = new BigUint64Array(this.readback.getMappedRange());
        names.forEach((name, i) => metrics.gauge("gpu", name, Number(t[2 * i + 1] - t[2 * i]) / 1e6));
        this.readback.unmap();
        this.reading = false;
      },
      () => (this.reading = false),
    );
  }
  destroy() {
    this.depth?.destroy();
    this.queries?.destroy();
    this.resolved?.destroy();
    this.readback?.destroy();
    this.context.unconfigure();
  }
}
