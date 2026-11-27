// The vegetation's far levels as one canopy surface (?veg=canopy): the cells a
// walk draws coarser than 2 m are not drawn one by one; their moments are
// splatted into a grid (4 m by default) as Gaussians widened by half their
// side, then normalised: per texel the density of returns per m2 (opacity:
// the share of the ground their discs cover, 1 - exp(-k D)), the height of the
// canopy top and its colour. The grid is drawn as one draped mesh, lit by its
// own slopes, alpha-blended (depth read, not written): no item per cell, so no
// lattice and no grain at any zoom. The 2 m cells and the returns stay as they
// are, near the camera.
import { DEPTH_FORMAT } from "../../rendering/gpu/engine.js";
import { cellSize } from "./vegetationTree.js";
import { VegetationGPU } from "./vegetationGPU.js";

const K = 2.1, // a cell's axes are K sigma (vegetationTree.js gaussian)
  WIDEN = 0.35, // sigma added, in sides of the cell (?veg=additive: 0.45)
  DISC_AREA = Math.PI * 0.2 * 0.2; // one return's disc (DISC = 0.2 m)

/**
 * coarse: { cells: Cell[], weights: number[] } of a walk (VegetationTree,
 * split). Returns { x0, y0, texel, nx, ny, height: Float32Array, color:
 * Uint8Array (rgba, a = opacity), ms } or null when nothing is coarse.
 */
export function canopyRaster(coarse, { texel = 3, maxTexels = 1024, cover = 0.6 } = {}) {
  const t0 = performance.now(),
    n = coarse.cells.length;
  if (!n) return null;
  // bounds: the cells' means and three widened sigmas
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  const splats = new Float64Array(n * 11);
  for (let i = 0; i < n; i++) {
    const cell = coarse.cells[i],
      row = cell.g.row,
      side = cellSize(cell.depth);
    let sxx = 0,
      sxy = 0,
      syy = 0,
      szz = 0;
    for (let a = 0; a < 3; a++) {
      const ax = row[3 + a * 3] / K,
        ay = row[4 + a * 3] / K,
        az = row[5 + a * 3] / K;
      sxx += ax * ax;
      sxy += ax * ay;
      syy += ay * ay;
      szz += az * az;
    }
    const widen = (WIDEN * side) ** 2 + (texel * texel) / 4;
    sxx += widen;
    syy += widen;
    const det = sxx * syy - sxy * sxy,
      o = i * 11,
      reach = 3 * Math.sqrt(Math.max(sxx, syy));
    splats[o] = cell.x;
    splats[o + 1] = cell.y;
    splats[o + 2] = syy / det; // inverse covariance
    splats[o + 3] = -sxy / det;
    splats[o + 4] = sxx / det;
    splats[o + 5] = (cell.g.n * coarse.weights[i]) / (2 * Math.PI * Math.sqrt(det)); // returns per m2 at the mean
    splats[o + 6] = cell.z + Math.sqrt(szz); // top
    splats[o + 7] = reach;
    splats[o + 8] = row[12];
    splats[o + 9] = row[13];
    splats[o + 10] = row[14];
    x0 = Math.min(x0, cell.x - reach);
    y0 = Math.min(y0, cell.y - reach);
    x1 = Math.max(x1, cell.x + reach);
    y1 = Math.max(y1, cell.y + reach);
  }
  texel = Math.max(texel, (x1 - x0) / maxTexels, (y1 - y0) / maxTexels);
  const nx = Math.ceil((x1 - x0) / texel) + 1,
    ny = Math.ceil((y1 - y0) / texel) + 1,
    D = new Float32Array(nx * ny),
    Hs = new Float32Array(nx * ny),
    R = new Float32Array(nx * ny),
    G = new Float32Array(nx * ny),
    B = new Float32Array(nx * ny);
  for (let i = 0; i < n; i++) {
    const o = i * 11,
      [mx, my, a, b, c, peak, top, reach, r, g, bl] = splats.subarray(o, o + 11),
      i0 = Math.max(0, Math.floor((mx - reach - x0) / texel)),
      i1 = Math.min(nx - 1, Math.ceil((mx + reach - x0) / texel)),
      j0 = Math.max(0, Math.floor((my - reach - y0) / texel)),
      j1 = Math.min(ny - 1, Math.ceil((my + reach - y0) / texel));
    for (let j = j0; j <= j1; j++) {
      const dy = y0 + j * texel - my;
      for (let k = i0; k <= i1; k++) {
        const dx = x0 + k * texel - mx,
          q = a * dx * dx + 2 * b * dx * dy + c * dy * dy;
        if (q > 9) continue;
        const d = peak * Math.exp(-0.5 * q),
          t = j * nx + k;
        D[t] += d;
        Hs[t] += d * top;
        R[t] += d * r;
        G[t] += d * g;
        B[t] += d * bl;
      }
    }
  }
  const height = new Float32Array(nx * ny),
    color = new Uint8Array(nx * ny * 4);
  let low = Infinity;
  for (let i = 0; i < n; i++) low = Math.min(low, splats[i * 11 + 6]);
  for (let t = 0; t < nx * ny; t++) {
    const d = D[t];
    if (d > 1e-6) {
      height[t] = Hs[t] / d;
      color[t * 4] = Math.min(255, (R[t] / d) * 255);
      color[t * 4 + 1] = Math.min(255, (G[t] / d) * 255);
      color[t * 4 + 2] = Math.min(255, (B[t] / d) * 255);
      color[t * 4 + 3] = Math.round(255 * (1 - Math.exp(-cover * DISC_AREA * d)));
    } else height[t] = low;
  }
  return { x0, y0, texel, nx, ny, height, color, ms: performance.now() - t0 };
}

const WGSL = /* wgsl */ `
struct View { matrix: mat4x4f, sun: vec4f, grid: vec4f, size: vec4f }
@group(0) @binding(0) var<uniform> view: View;
@group(0) @binding(1) var height: texture_2d<f32>;
@group(0) @binding(2) var color: texture_2d<f32>;
struct Out { @builtin(position) position: vec4f, @location(0) color: vec4f, @location(1) normal: vec3f }
fn h(t: vec2i) -> f32 {
  let n = vec2i(view.size.xy);
  return textureLoad(height, clamp(t, vec2i(0), n - 1), 0).r;
}
fn foliage(c0: vec3f) -> vec3f {
  var c = pow(max(c0, vec3f(0.0)), vec3f(0.8));
  var l = dot(c, vec3f(0.299, 0.587, 0.114));
  c *= clamp(l, 0.24, 0.5) / max(l, 0.02);
  c = mix(c, vec3f(0.30, 0.42, 0.17) * (0.6 + l), 0.3);
  l = dot(c, vec3f(0.299, 0.587, 0.114));
  return clamp(mix(vec3f(l), c, 1.25), vec3f(0.0), vec3f(1.0));
}
@vertex fn vs(@builtin(vertex_index) vi: u32) -> Out {
  let nx = u32(view.size.x);
  let quad = vi / 6u;
  let corner = array<vec2u, 6>(vec2u(0u, 0u), vec2u(1u, 0u), vec2u(0u, 1u), vec2u(0u, 1u), vec2u(1u, 0u), vec2u(1u, 1u))[vi % 6u];
  let t = vec2i(vec2u(quad % (nx - 1u), quad / (nx - 1u)) + corner);
  let z = h(t);
  let p = vec3f(view.grid.x + f32(t.x) * view.grid.z, view.grid.y + f32(t.y) * view.grid.z, z);
  var o: Out;
  o.position = view.matrix * vec4f(p, 1.0);
  // the slopes of the canopy, softened (a crown's edge is not a cliff)
  let gx = (h(t + vec2i(1, 0)) - h(t - vec2i(1, 0))) / (2.0 * view.grid.z);
  let gy = (h(t + vec2i(0, 1)) - h(t - vec2i(0, 1))) / (2.0 * view.grid.z);
  o.normal = normalize(vec3f(-gx, -gy, 1.4));
  o.color = textureLoad(color, t, 0);
  return o;
}
@fragment fn fs(i: Out) -> @location(0) vec4f {
  let a = i.color.a;
  if (a < 1.0 / 255.0) { discard; }
  let lit = 0.45 + 0.6 * max(dot(normalize(i.normal), view.sun.xyz), 0.0);
  return vec4f(foliage(i.color.rgb) * lit * a, a);
}`;

export class CanopyGPU {
  constructor(engine) {
    this.engine = engine;
    const device = (this.device = engine.device),
      module = device.createShaderModule({ code: WGSL }),
      blend = { color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" }, alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" } };
    this.layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} },
        { binding: 1, visibility: GPUShaderStage.VERTEX, texture: { sampleType: "unfilterable-float" } },
        { binding: 2, visibility: GPUShaderStage.VERTEX, texture: { sampleType: "unfilterable-float" } },
      ],
    });
    this.pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      vertex: { module, entryPoint: "vs" },
      fragment: { module, entryPoint: "fs", targets: [{ format: engine.format, blend }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: "less-equal" },
    });
    this.viewBuffer = device.createBuffer({ size: 112, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.raster = null;
    this.uploaded = 0;
  }
  /** A raster of canopyRaster (or null: nothing drawn). */
  set(raster) {
    this.raster = raster;
    if (!raster) return;
    const { nx, ny, device } = { ...raster, device: this.device };
    if (!this.height || this.height.width !== nx || this.height.height !== ny) {
      this.height?.destroy();
      this.color?.destroy();
      this.height = device.createTexture({ size: [nx, ny], format: "r32float", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      this.color = device.createTexture({ size: [nx, ny], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      this.group = device.createBindGroup({
        layout: this.layout,
        entries: [
          { binding: 0, resource: { buffer: this.viewBuffer } },
          { binding: 1, resource: this.height.createView() },
          { binding: 2, resource: this.color.createView() },
        ],
      });
    }
    device.queue.writeTexture({ texture: this.height }, raster.height, { bytesPerRow: nx * 4 }, [nx, ny]);
    device.queue.writeTexture({ texture: this.color }, raster.color, { bytesPerRow: nx * 4 }, [nx, ny]);
    this.uploaded = nx * ny * 8;
  }
  /** view: { matrix (WebGPU), sun } */
  draw(pass, view) {
    const r = this.raster;
    if (!r || !this.group) return;
    const u = new Float32Array(28);
    u.set(view.matrix, 0);
    u.set(view.sun.slice(0, 3), 16);
    u.set([r.x0, r.y0, r.texel, 0], 20);
    u.set([r.nx, r.ny, 0, 0], 24);
    this.device.queue.writeBuffer(this.viewBuffer, 0, u);
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.group);
    pass.draw((r.nx - 1) * (r.ny - 1) * 6);
  }
  record(engine, view) {
    engine.add("vegetation.canopy", (pass) => this.draw(pass, view), { stage: "drape" });
  }
  destroy() {
    this.height?.destroy();
    this.color?.destroy();
    this.viewBuffer.destroy();
  }
}

/**
 * The vegetation's drawing for a mode (?veg): dither (as before), additive,
 * crowns, canopy (the coarse cells as one surface, the 2 m cells and returns
 * as additive). set(selection) after each walk, record(engine, view) each frame.
 */
export class VegetationRenderer {
  constructor(engine, { mode = "dither", compact = true } = {}) {
    this.mode = mode;
    this.splats = new VegetationGPU(engine, { mode: mode === "canopy" ? "additive" : mode, compact });
    this.canopy = mode === "canopy" ? new CanopyGPU(engine) : null;
    this.canopyMs = 0;
  }
  get gpuBytes() {
    return this.splats.gpuBytes + (this.canopy?.uploaded ?? 0);
  }
  get uploaded() {
    return this.splats.uploaded + (this.canopy?.uploaded ?? 0);
  }
  /** Fades in time: the last selection's fades moved (VegetationTree.refade). */
  refade(selection) {
    this.splats.refade(selection);
  }
  get refaded() {
    return this.splats.refaded ?? 0;
  }
  set(selection) {
    this.splats.set(selection);
    if (this.canopy) {
      const raster = canopyRaster(selection.coarse);
      this.canopyMs = raster?.ms ?? 0;
      this.canopy.set(raster);
    }
  }
  record(engine, view) {
    this.splats.record(engine, view);
    this.canopy?.record(engine, view);
  }
  destroy() {
    this.splats.destroy();
    this.canopy?.destroy();
  }
}
