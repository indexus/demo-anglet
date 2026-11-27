// WebGPU drawing of the buildings, in the scene renderer (rendering/gpu):
// mesh arenas within a GPU budget, ranges and selection lists from the
// buildings tree. Equivalent boxes are instanced;
// steady meshes go out as one draw per merged range, changing ones with their
// cross-fade (dither) values at a dynamic offset.
//
// Sales (setPrices: building location -> [r, g, b] bytes, the 2D map's
// 24-step €/m² ramp): a building with a price draws its roof faces (kind 0:
// the roof planes and their fascia, never the walls, the soffits under the
// eaves, part 254, or the steep faces drawn as walls, part 255) in that
// colour exactly: opaque, unlit. A mesh with a price is a draw of its own
// (the colour in its per-draw uniforms); a box carries it per instance.
//
// Far roofs (buildingsTree.js cellPatch): a row of several buildings is its
// cell at the mean height, drawn on its built share of pixels (coverage, a
// per-pixel hash, as the vegetation's cells; its walls on the share a ray
// through its side meets, wallCover); with sales, the share of its
// buildings that have a price (its cell's most common colour) takes it, on
// the roof faces only. Boxes and patches hang a skirt under their walls that
// grows with distance: where MapLibre's terrain is coarser than the LiDAR
// ground they meet it instead of floating over it (the skirt is under the
// ground's depth everywhere else). Meshes (near) are drawn as before.
import { DEPTH_FORMAT } from "../../rendering/gpu/engine.js";

export const SKIRT = 0.012; // metres of skirt per metre of distance, under boxes and patches
/** ms of a fade (buildingsTree.js ROW_FADE and a level's): the draw lists carry when each started. */
export const FADE = 300;
const FADE_DONE = -1e6; // the start of a fade long over (s)
const WGSL = /* wgsl */ `
// exposure.yz: viewport, exposure.w: the scene's presence (its fade in or out); clock.x: s since the epoch
struct View { matrix: mat4x4f, eye: vec4f, sun: vec4f, highlight: vec4f, exposure: vec4f, clock: vec4f }
// fade: when the fade started (s since the epoch, FADE_DONE: over), appearing (1) or leaving (top - 1:
// 0, or less for a row that leaves while it was fading in, on top of its pixels)
struct Draw { fade: vec2f, mark: f32, pad: f32, price: vec4f } // price.a 1: the roof takes price.rgb
@group(0) @binding(0) var<uniform> view: View;
@group(0) @binding(1) var<uniform> draw: Draw;
struct Out {
  @builtin(position) position: vec4f,
  @location(6) @interpolate(flat) cover: vec4f, // drawn share of roof pixels, share with the price, seed, of wall pixels
  @location(0) world: vec3f,
  @location(1) color: vec3f,
  @location(2) @interpolate(flat) kind: f32,
  @location(3) @interpolate(flat) fade: vec2f,
  @location(4) @interpolate(flat) mark: f32,
  @location(5) @interpolate(flat) price: vec4f,
}
fn shade(color: vec3f, n: vec3f, kind: f32) -> vec3f {
  let lambert = max(dot(n, view.sun.xyz), 0.0);
  // walls (kind > 0): a little darker at the foot
  let wall = step(50.0, kind);
  let foot = clamp((kind - 100.0) / 100.0, 0.0, 1.0);
  let light = mix(0.50 + 0.62 * lambert, (0.62 + 0.42 * lambert) * mix(0.80, 1.0, foot), wall);
  return color * light * view.exposure.x;
}
fn dither(p: vec2f) -> f32 {
  return fract(52.9829189 * fract(dot(p, vec2f(0.06711056, 0.00583715))));
}
// a per-pixel hash of its own (not the fade's dither), as the vegetation's cells
fn hash(q: vec2f, s: f32) -> f32 {
  let p = vec2u(q) + vec2u(u32(s) * 7919u, u32(s) * 104729u);
  var h = (p.x * 2654435761u) ^ (p.y * 2246822519u);
  h = (h ^ (h >> 15u)) * 2246822519u;
  h ^= h >> 13u;
  return f32(h & 0xffffffu) / 16777216.0;
}
@vertex fn mesh(@location(0) p: vec3f, @location(1) c: vec4f) -> Out {
  var o: Out;
  o.position = view.matrix * vec4f(p, 1.0);
  o.world = p;
  o.color = c.rgb;
  o.kind = c.a * 255.0;
  o.fade = draw.fade;
  o.mark = draw.mark;
  o.price = draw.price;
  o.cover = vec4f(1.0, 1.0, 0.0, 1.0);
  return o;
}
// corner: x, y in -1..1, top (0|1), kind; centre: x, y, ground, roof; axes: u.xy, v.xy
// cover: drawn share of roof pixels, share with the price, of wall pixels (patches of several buildings; 1 for one)
@vertex fn box(@location(0) corner: vec4f, @location(1) centre: vec4f, @location(2) axes: vec4f,
               @location(3) color: vec4f, @location(4) fade: vec2f, @location(5) price: vec4f, @location(6) cover: vec4f) -> Out {
  var o: Out;
  // the skirt: 1 m near, ${SKIRT} m per metre of distance further
  let skirt = max(1.0, ${SKIRT} * distance(vec3f(centre.xy, centre.w), view.eye.xyz));
  let p = vec3f(centre.xy + corner.x * axes.xy + corner.y * axes.zw, mix(centre.z - skirt, centre.w, corner.z));
  o.position = view.matrix * vec4f(p, 1.0);
  o.world = p;
  o.kind = corner.w;
  o.color = select(color.rgb, 0.88 * vec3f(0.95, 0.93, 0.88) + 0.12 * color.rgb, corner.w > 50.0);
  o.fade = fade;
  o.mark = color.a;
  o.price = price;
  // the hash's seed from the place: the same pixels of a patch from one walk to the next
  o.cover = vec4f(cover.xy, f32(u32(abs(centre.x * 7.0 + centre.y * 13.0)) % 4096u), cover.z);
  return o;
}
@fragment fn surface(i: Out) -> @location(0) vec4f {
  // flat faces: the normal from the screen derivatives, turned toward the eye
  var n = normalize(cross(dpdx(i.world), dpdy(i.world)));
  if (dot(n, view.eye.xyz - i.world) < 0.0) { n = -n; }
  // the fade runs on the GPU's clock, eased: smooth on every frame, whatever the walks' pace
  let raw = (view.clock.x - i.fade.x) / ${(FADE / 1000).toFixed(3)};
  if (raw < 1.0 || i.fade.y < 0.5) {
    // on bottom-up pixel rows, as the WebGL renderer
    let d = dither(vec2f(i.position.x, view.exposure.z - i.position.y));
    if (i.fade.y > 0.5) {
      // appearing: on the pixels under the eased fade
      if (d >= smoothstep(0.0, 1.0, raw)) { discard; }
    } else {
      // leaving: from the pixels it had (under top: 1, or less if it was still fading in), the
      // ones the rows that replace it take (under the same eased fade, started as it left) first
      let top = 1.0 + i.fade.y;
      if (d >= top || d < smoothstep(0.0, 1.0, raw - (1.0 - top))) { discard; }
    }
  }
  // the scene fading in or out: a share of the pixels, a hash of its own (not the fade's dither)
  if (view.exposure.w < 1.0 && hash(i.position.xy, 8191.0) >= view.exposure.w) { discard; }
  // a far patch: its built share of pixels, and the share of them with a price
  let cover = select(i.cover.x, i.cover.w, i.kind > 50.0);
  if (cover < 1.0 && hash(i.position.xy, i.cover.z) >= cover) { discard; }
  var price = i.price;
  if (i.cover.y < 1.0 && hash(i.position.xy, i.cover.z + 4099.0) >= i.cover.y) { price.a = 0.0; }
  // a building with sales: its roof faces in the colour of its €/m², as the 2D map draws it
  if (price.a > 0.5 && i.kind < 50.0) {
    return vec4f(price.rgb, 1.0);
  }
  // a highlighted building (sale under the pointer): its roof takes the colour
  let mark = i.mark * step(i.kind, 50.0);
  return vec4f(shade(mix(i.color, view.highlight.rgb, 0.48 * mark), n, i.kind), 1.0);
}`;

const ARENA_VERTICES = 1 << 19, // 8 MB of vertices
  ARENA_INDICES = 3 << 19, // 6 MB of uint32 indices
  SLOT = 256; // bytes of one draw's uniforms (dynamic offset alignment)
export const BOX_BYTES = 52; // one box instance: centre, axes, colour and mark, fade, price, cover
// box: roof (2 triangles) and 4 walls (8), wall foot kind 100, wall top 200
const BOX = (() => {
  const c = [[-1, -1], [1, -1], [1, 1], [-1, 1]],
    v = [];
  for (const [a, b, d] of [[0, 1, 2], [0, 2, 3]]) for (const k of [a, b, d]) v.push(c[k][0], c[k][1], 1, 0);
  for (let k = 0; k < 4; k++) {
    const p = c[k],
      q = c[(k + 1) % 4];
    v.push(p[0], p[1], 1, 200, q[0], q[1], 1, 200, q[0], q[1], 0, 100);
    v.push(p[0], p[1], 1, 200, q[0], q[1], 0, 100, p[0], p[1], 0, 100);
  }
  return new Float32Array(v);
})();

export class BuildingsGPU {
  /** budget: GPU bytes of mesh arenas at most; past it, the arena drawn the longest ago goes and onEvict(ranges) tells the tree. */
  constructor(engine, { budget = 96 << 20, onEvict = null } = {}) {
    const device = (this.device = engine.device);
    Object.assign(this, { engine, budget, onEvict, frame: 0, arenas: [], gpuBytes: 0, boxCount: 0, boxCapacity: 0, slots: 0, prices: new Map() });
    const module = device.createShaderModule({ code: WGSL }),
      layout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} },
          { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { hasDynamicOffset: true } },
        ],
      }),
      pipeline = (entryPoint, buffers) =>
        device.createRenderPipeline({
          layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
          vertex: { module, entryPoint, buffers },
          fragment: { module, entryPoint: "surface", targets: [{ format: engine.format }] },
          primitive: { topology: "triangle-list", cullMode: "none" },
          depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: "less-equal" },
        });
    this.layout = layout;
    this.meshPipeline = pipeline("mesh", [
      { arrayStride: 16, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }, { shaderLocation: 1, offset: 12, format: "unorm8x4" }] },
    ]);
    this.boxPipeline = pipeline("box", [
      { arrayStride: 16, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x4" }] },
      {
        arrayStride: BOX_BYTES,
        stepMode: "instance",
        attributes: [
          { shaderLocation: 1, offset: 0, format: "float32x4" },
          { shaderLocation: 2, offset: 16, format: "float32x4" },
          { shaderLocation: 3, offset: 32, format: "unorm8x4" },
          { shaderLocation: 4, offset: 36, format: "float32x2" },
          { shaderLocation: 5, offset: 44, format: "unorm8x4" },
          { shaderLocation: 6, offset: 48, format: "unorm8x4" },
        ],
      },
    ]);
    this.viewBuffer = device.createBuffer({ size: 144, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.boxShape = device.createBuffer({ size: BOX.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.boxShape, 0, BOX);
    this.growSlots(64);
  }
  /** Room for `count` per-draw uniforms (steady, marked, then one per changing range). */
  growSlots(count) {
    if (count <= this.slots) return;
    this.slots = Math.max(count, this.slots * 2);
    this.drawBuffer?.destroy();
    this.drawBuffer = this.device.createBuffer({ size: this.slots * SLOT, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.bindGroup = this.device.createBindGroup({
      layout: this.layout,
      entries: [
        { binding: 0, resource: { buffer: this.viewBuffer } },
        { binding: 1, resource: { buffer: this.drawBuffer, size: 32 } },
      ],
    });
  }
  /** Free the arena drawn the longest ago (never one drawn in the current frame). */
  evictOne() {
    let oldest = null;
    for (const a of this.arenas) if (a.used < this.frame && (!oldest || a.used < oldest.used)) oldest = a;
    if (!oldest) return false;
    oldest.vbo.destroy();
    oldest.ibo.destroy();
    this.arenas.splice(this.arenas.indexOf(oldest), 1);
    this.gpuBytes -= oldest.bytes;
    this.onEvict?.(oldest.ranges);
    return true;
  }
  /** Append meshes ({vertices, indices}) as one drawable range; owner is handed back on eviction. */
  upload(list, owner = null) {
    const device = this.device,
      vertices = list.reduce((s, m) => s + m.vertices.byteLength / 16, 0),
      count = list.reduce((s, m) => s + m.indices.length, 0);
    let arena = this.arenas.at(-1);
    if (!arena || arena.vertices + vertices > ARENA_VERTICES || arena.indices + count > ARENA_INDICES) {
      const v = Math.max(ARENA_VERTICES, vertices) * 16,
        i = Math.max(ARENA_INDICES, count) * 4;
      while (this.gpuBytes + v + i > this.budget && this.evictOne());
      arena = {
        vbo: device.createBuffer({ size: v, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST }),
        ibo: device.createBuffer({ size: i, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST }),
        vertices: 0,
        indices: 0,
        bytes: v + i,
        ranges: [],
        used: this.frame,
      };
      this.arenas.push(arena);
      this.gpuBytes += v + i;
    }
    const indices = new Uint32Array(count),
      range = { arena, offset: arena.indices * 4, count, owner };
    arena.ranges.push(range);
    let at = 0;
    for (const m of list) {
      device.queue.writeBuffer(arena.vbo, arena.vertices * 16, m.vertices);
      for (let k = 0; k < m.indices.length; k++) indices[at++] = m.indices[k] + arena.vertices;
      arena.vertices += m.vertices.byteLength / 16;
    }
    device.queue.writeBuffer(arena.ibo, range.offset, indices);
    arena.indices += count;
    return range;
  }
  /**
   * The sales' colours: building location -> [r, g, b] (0..255) of its €/m²;
   * the next prepare draws them.
   */
  setPrices(prices) {
    this.prices = prices ?? new Map();
    this.cellPrices = cellPrices(this.prices);
  }
  /** Turn a selection into draw lists at once; call when the selection changed. */
  prepare(selection) {
    const steps = this.prepareSteps(selection);
    while (!steps.next().done);
  }
  /**
   * The same in steps (a generator: it yields every few thousand boxes, so a
   * layer spreads it over its frame budget). The boxes are written into a
   * staging buffer kept from one selection to the next; the GPU buffers and
   * the draw lists change together in the last step, so the frames between
   * draw the last selection.
   */
  *prepareSteps(selection) {
    const boxes = selection.boxes,
      n = boxes.length,
      mark = selection.highlight?.location,
      prices = this.prices,
      cells = this.cellPrices ?? (this.cellPrices = cellPrices(prices));
    if (n * BOX_BYTES > (this.staging?.byteLength ?? 0)) {
      this.staging = new ArrayBuffer(Math.max(n * BOX_BYTES, (this.staging?.byteLength ?? 0) * 2, BOX_BYTES * 1024));
      this.stagingF = new Float32Array(this.staging);
      this.stagingU = new Uint8Array(this.staging);
    }
    const f = this.stagingF,
      u = this.stagingU,
      // the fades as when they started, on the clock of the walk (selection.now, ms): the GPU runs them on
      now = selection.now ?? 0,
      epoch = (this.epoch ??= now),
      fades = boxes.fades;
    let end = -Infinity;
    for (let i = 0; i < n; i++) {
      if ((i & 2047) === 2047) yield;
      const node = boxes.nodes[i],
        b = node.box,
        o = (i * BOX_BYTES) / 4,
        at = i * BOX_BYTES,
        // a row of several buildings (a far patch): its cell's colour, on the share of its buildings with one
        cell = node.lone === false ? cells.get(node.location) : undefined,
        price = cell ? cell.color : node.location !== undefined && node.lone !== false ? prices.get(node.location) : undefined,
        share = cell ? Math.min(1, cell.count / Math.max(b.count, 1)) : 1;
      f[o] = b.centre[0];
      f[o + 1] = b.centre[1];
      f[o + 2] = b.ground;
      f[o + 3] = b.roof;
      f[o + 4] = b.u[0];
      f[o + 5] = b.u[1];
      f[o + 6] = b.v[0];
      f[o + 7] = b.v[1];
      for (let k = 0; k < 3; k++) u[at + 32 + k] = Math.max(0, Math.min(255, Math.round(b.color[k] * 255)));
      u[at + 35] = node.location === mark ? 255 : 0;
      const fade = fades[i];
      if (fade < 1) end = Math.max(end, now + (1 - fade) * FADE);
      f[o + 9] = fade >= 1 ? FADE_DONE : (now - epoch - fade * FADE) / 1000;
      f[o + 10] = fade >= 1 ? 1 : boxes.appearing[i]; // a fade over is drawn, whichever way it went (as before)
      u[at + 44] = price ? price[0] : 0;
      u[at + 45] = price ? price[1] : 0;
      u[at + 46] = price ? price[2] : 0;
      u[at + 47] = price ? 255 : 0;
      u[at + 48] = Math.max(1, Math.round(Math.max(0, Math.min(1, b.coverage ?? 1)) * 255));
      u[at + 49] = Math.round(share * 255);
      // a far patch has no walls: its cell's sides, light and facing the camera, made rows of
      // stripes across the map at a grazing view (the ortho already shows those buildings);
      // a building or box of its own keeps its walls
      u[at + 50] = b.patch ? 0 : Math.max(1, Math.round(wallCover(b) * 255));
      u[at + 51] = 0;
    }
    if (n > this.boxCapacity) {
      this.boxCapacity = Math.max(n, this.boxCapacity * 2, 1024);
      this.boxBuffer?.destroy();
      this.boxBuffer = this.device.createBuffer({ size: this.boxCapacity * BOX_BYTES, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    }
    if (n) this.device.queue.writeBuffer(this.boxBuffer, 0, this.staging, 0, n * BOX_BYTES);
    this.boxCount = n;
    // steady meshes: per arena, ranges merged where they touch
    const steady = new Map(),
      meshes = selection.meshes;
    this.fading = [];
    this.marked = [];
    this.priced = [];
    this.highlight = selection.highlight?.color ?? [1, 0.6, 0.2];
    this.frame++;
    for (let i = 0; i < meshes.length; i++) {
      const leaf = meshes.nodes[i],
        fade = meshes.fades[i],
        appearing = meshes.appearing[i],
        range = leaf.levels?.[meshes.levels[i]]?.range;
      if (!range) continue; // let go by the GPU budget during a walk spread over frames
      range.arena.used = this.frame;
      if (fade < 1) end = Math.max(end, now + (1 - fade) * FADE);
      const price = prices.get(leaf.location);
      // a building with sales is a draw of its own, its colour in the uniforms (fade included)
      if (price) this.priced.push([range, fade, appearing, price]);
      else if (leaf.location === mark) this.marked.push(range);
      else if (fade < 1) this.fading.push([range, fade, appearing]);
      else {
        let list = steady.get(range.arena);
        if (!list) steady.set(range.arena, (list = []));
        list.push(range);
      }
    }
    this.steady = [...steady].map(([arena, list]) => {
      list.sort((a, b) => a.offset - b.offset);
      const merged = [];
      for (const r of list) {
        const last = merged.at(-1);
        if (last && last.offset + last.count * 4 === r.offset) last.count += r.count;
        else merged.push({ offset: r.offset, count: r.count });
      }
      return { arena, merged };
    });
    // per-draw uniforms (8 floats a slot): 0 steady, 1 marked, 2.. changing, then the priced
    const count = 2 + this.fading.length + this.priced.length,
      floats = (count * SLOT) / 4;
    this.growSlots(count);
    if ((this.slotData?.length ?? 0) < floats) this.slotData = new Float32Array(Math.max(floats, (this.slotData?.length ?? 0) * 2));
    const slots = this.slotData,
      slot = (k, fade, appearing, mark, price = null) => {
        const o = (k * SLOT) / 4;
        slots[o] = fade >= 1 ? FADE_DONE : (now - epoch - fade * FADE) / 1000;
        slots[o + 1] = fade >= 1 ? 1 : appearing;
        slots[o + 2] = mark;
        slots[o + 3] = 0;
        slots[o + 4] = price ? price[0] / 255 : 0;
        slots[o + 5] = price ? price[1] / 255 : 0;
        slots[o + 6] = price ? price[2] / 255 : 0;
        slots[o + 7] = price ? 1 : 0;
      };
    slot(0, 1, 1, 0);
    slot(1, 1, 1, 1);
    this.fading.forEach(([, fade, appearing], k) => slot(2 + k, fade, appearing, 0));
    this.priced.forEach(([, fade, appearing, price], k) => slot(2 + this.fading.length + k, fade, appearing, 0, price));
    this.device.queue.writeBuffer(this.drawBuffer, 0, slots, 0, floats);
    // when the last fade of these lists is over (ms, the walk's clock): no walk is needed before
    this.fadeEnd = end;
  }
  /** Record the draws into `pass` (engine pass); returns the draw calls. */
  /**
   * time: the clock of the walks (ms, performance.now() in the app): the fades
   * at that moment; presence: the scene's (SceneFrame.sceneOpacity), 0..1.
   */
  draw(pass, { matrix, eye, sun, exposure = 1, viewport, time = performance.now(), presence = 1 }) {
    const view = (this.viewData ??= new Float32Array(36));
    view.set(matrix, 0);
    view.set(eye, 16);
    view.set(sun, 20);
    view.set(this.highlight ?? [1, 0.6, 0.2], 24);
    view[28] = exposure;
    view[29] = viewport[0];
    view[30] = viewport[1];
    view[31] = presence;
    view[32] = (time - (this.epoch ?? time)) / 1000;
    this.device.queue.writeBuffer(this.viewBuffer, 0, view);
    let calls = 0;
    pass.setPipeline(this.meshPipeline);
    const ranges = (arena, list, slot) => {
      pass.setBindGroup(0, this.bindGroup, [slot * SLOT]);
      pass.setVertexBuffer(0, arena.vbo);
      pass.setIndexBuffer(arena.ibo, "uint32");
      for (const r of list) {
        pass.drawIndexed(r.count, 1, r.offset / 4);
        calls++;
      }
    };
    for (const { arena, merged } of this.steady ?? []) ranges(arena, merged, 0);
    (this.fading ?? []).forEach(([range], k) => ranges(range.arena, [range], 2 + k));
    for (const range of this.marked ?? []) ranges(range.arena, [range], 1);
    const first = 2 + (this.fading?.length ?? 0);
    (this.priced ?? []).forEach(([range], k) => ranges(range.arena, [range], first + k));
    if (this.boxCount) {
      pass.setPipeline(this.boxPipeline);
      pass.setBindGroup(0, this.bindGroup, [0]);
      pass.setVertexBuffer(0, this.boxShape);
      pass.setVertexBuffer(1, this.boxBuffer);
      pass.draw(30, this.boxCount);
      calls++;
    }
    return calls;
  }
  destroy() {
    for (const arena of this.arenas) {
      arena.vbo.destroy();
      arena.ibo.destroy();
    }
    for (const b of [this.boxShape, this.boxBuffer, this.viewBuffer, this.drawBuffer]) b?.destroy();
    this.arenas = [];
    this.steady = this.fading = this.priced = null;
    this.boxCount = this.gpuBytes = 0;
  }
}

/**
 * The share of a patch's wall pixels: a ray through the side of a cell of n
 * buildings on `coverage` of its ground crosses about sqrt(n) rows, each
 * filled on sqrt(coverage) of its width: 1 - (1 - sqrt(coverage))^sqrt(n).
 * Its roof is drawn on `coverage` of its pixels (seen from above), its walls
 * on this (seen from the side): on screen, about what its buildings cover.
 */
export function wallCover(b) {
  const c = Math.max(0, Math.min(1, b.coverage ?? 1));
  return c >= 1 ? 1 : 1 - (1 - Math.sqrt(c)) ** Math.sqrt(Math.max(b.count ?? 1, 1));
}
/**
 * The far patches' prices: for every cell key above a building with a price,
 * its most common colour (a step of the ramp, never a mix) and how many of its
 * buildings have one. Made once per setPrices, not per frame.
 */
export function cellPrices(prices) {
  const tally = new Map();
  for (const [location, color] of prices) {
    if (typeof location !== "string") continue;
    const key = color.join();
    for (let length = 1; length < location.length; length++) {
      const prefix = location.slice(0, length);
      let cell = tally.get(prefix);
      if (!cell) tally.set(prefix, (cell = { count: 0, colors: new Map() }));
      cell.count++;
      const c = cell.colors.get(key);
      if (c) c.n++;
      else cell.colors.set(key, { n: 1, color });
    }
  }
  const out = new Map();
  for (const [prefix, cell] of tally) {
    let best = null;
    for (const c of cell.colors.values()) if (!best || c.n > best.n) best = c;
    out.set(prefix, { count: cell.count, color: best.color });
  }
  return out;
}
