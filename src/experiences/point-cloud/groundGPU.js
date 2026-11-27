// WebGPU depth of the LiDAR ground, in the scene renderer (rendering/gpu).
// MapLibre draws the ground itself (its terrain with the orthophoto draped,
// explore/sceneBackdrop.js); this draws the same surface into the scene's
// depth buffer only, no colour, so that buildings, vegetation and the effects
// after them are hidden behind it and meet it where they stand. Every tile is
// one instance of the same grid of SIZE x SIZE altitudes, read from a layer of
// a height texture array sized by the slot budget: one draw call for the
// whole ground. A ring of skirt vertices hangs under every tile's edge: no
// crack where a tile meets a coarser neighbour. The depth is biased a little
// away from the eye: what stands on the ground wins over it, never fights it.
import { DEPTH_FORMAT } from "../../rendering/gpu/engine.js";

export const SIZE = 129; // altitudes per tile side: 128 cells, as MapLibre's terrain mesh
const GRID = SIZE + 2; // with the skirt ring

const WGSL = /* wgsl */ `
struct View {
  matrix: mat4x4f,
  ground: vec4f, // exaggeration
}
struct Tile {
  rect: vec4f, // x0, y0 (south), x1, y1 (north) in metres of the scene frame
  info: vec4f, // layer, skirt depth (m)
}
@group(0) @binding(0) var<uniform> view: View;
@group(0) @binding(1) var<storage, read> tiles: array<Tile>;
@group(0) @binding(2) var heights: texture_2d_array<f32>;
@vertex fn grid(@builtin(vertex_index) v: u32, @builtin(instance_index) k: u32) -> @builtin(position) vec4f {
  let tile = tiles[k];
  let gi = i32(v % ${GRID}u);
  let gj = i32(v / ${GRID}u);
  let i = clamp(gi - 1, 0, ${SIZE - 1});
  let j = clamp(gj - 1, 0, ${SIZE - 1});
  let edge = gi == 0 || gj == 0 || gi == ${GRID - 1} || gj == ${GRID - 1};
  // row 0 is the north edge
  let uv = vec2f(f32(i), f32(j)) / ${SIZE - 1}.0;
  let x = mix(tile.rect.x, tile.rect.z, uv.x);
  let y = mix(tile.rect.w, tile.rect.y, uv.y);
  var h = textureLoad(heights, vec2i(i, j), u32(tile.info.x), 0).r * view.ground.x;
  if (edge) {
    h -= tile.info.y;
  }
  return view.matrix * vec4f(x, y, h, 1.0);
}
@fragment fn depth() -> @location(0) vec4f {
  return vec4f(0.0);
}`;

export class GroundGPU {
  /** slots: tiles held on the GPU at most (one 66 kB height layer each). */
  constructor(engine, { slots = 64 } = {}) {
    const device = (this.device = engine.device);
    this.slots = slots;
    this.free = Array.from({ length: slots }, (_, k) => slots - 1 - k);
    this.count = 0;
    this.gpuBytes = slots * SIZE * SIZE * 4 + slots * 32;
    this.heights = device.createTexture({
      size: [SIZE, SIZE, slots],
      format: "r32float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.view = device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.tiles = device.createBuffer({ size: slots * 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const indices = new Uint32Array((GRID - 1) * (GRID - 1) * 6);
    for (let j = 0, k = 0; j < GRID - 1; j++)
      for (let i = 0; i < GRID - 1; i++) {
        const a = j * GRID + i;
        indices.set([a, a + 1, a + GRID, a + 1, a + GRID + 1, a + GRID], k);
        k += 6;
      }
    this.indexCount = indices.length;
    this.index = device.createBuffer({ size: indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.index, 0, indices);
    this.gpuBytes += indices.byteLength;
    const module = device.createShaderModule({ code: WGSL }),
      layout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: {} },
          { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
          {
            binding: 2,
            visibility: GPUShaderStage.VERTEX,
            texture: { sampleType: "unfilterable-float", viewDimension: "2d-array" },
          },
        ],
      });
    this.pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: { module, entryPoint: "grid" },
      // depth only: the colour target is kept as it is (MapLibre's ground shows through)
      fragment: { module, entryPoint: "depth", targets: [{ format: engine.format, writeMask: 0 }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: {
        format: DEPTH_FORMAT,
        depthWriteEnabled: true,
        depthCompare: "less-equal",
        // pushed away from the eye (a few depth steps, more where the ground is seen grazing):
        // a building's foot or a trunk drawn at the ground's altitude is in front, frame after frame
        depthBias: 16,
        depthBiasSlopeScale: 2,
      },
    });
    this.bindGroup = device.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: { buffer: this.view } },
        { binding: 1, resource: { buffer: this.tiles } },
        { binding: 2, resource: this.heights.createView({ dimension: "2d-array" }) },
      ],
    });
  }
  /** A free layer, or -1 when every slot holds a tile. */
  take() {
    return this.free.pop() ?? -1;
  }
  release(slot) {
    this.free.push(slot);
  }
  /** heights: SIZE x SIZE altitudes, north row first. */
  upload(slot, heights) {
    this.device.queue.writeTexture({ texture: this.heights, origin: [0, 0, slot] }, heights, { bytesPerRow: SIZE * 4 }, [SIZE, SIZE]);
  }
  /** tiles: [{ rect, slot }] at most `slots`; call when the list changed. */
  prepare(tiles) {
    const data = new Float32Array(Math.max(tiles.length, 1) * 8);
    tiles.forEach((tile, k) => {
      data.set(tile.rect, k * 8);
      data[k * 8 + 4] = tile.slot;
      data[k * 8 + 5] = Math.max(2, (tile.rect[2] - tile.rect[0]) / 32);
    });
    this.device.queue.writeBuffer(this.tiles, 0, data);
    this.count = tiles.length;
  }
  /** Record the ground's depth into `pass` (engine pass); exaggeration: MapLibre's terrain's (0 without terrain). */
  draw(pass, { matrix, exaggeration = 1 }) {
    if (!this.count) return 0;
    const view = new Float32Array(20);
    view.set(matrix, 0);
    view[16] = exaggeration;
    this.device.queue.writeBuffer(this.view, 0, view);
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.setIndexBuffer(this.index, "uint32");
    pass.drawIndexed(this.indexCount, this.count);
    return 1;
  }
  destroy() {
    for (const r of [this.heights, this.view, this.tiles, this.index]) r.destroy();
    this.count = 0;
  }
}
