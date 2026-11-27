// A heat map (the SDK's AverageGridLayerWebGPU in host-drawn mode) in the
// map's frame, two ways:
//   - the 2D map (no scene shown): the heat is drawn in screen space, with the
//     map's Mercator matrix, into a texture of the drawable's size times the
//     controller's render scale: the image of the MapLibre layer it was before
//     the single renderer (same passes, same pixels, same fades, every frame),
//     then copied (sampled at each pixel's centre) into the frame;
//   - a 3D scene shown: the heat is drawn into a texture over a Web Mercator
//     rectangle around the view, with as many texels as the screen-space one,
//     then a full-screen pass finds each pixel's place from the depth buffer
//     (the ground, a roof, a wall) and takes the heat there. Where nothing was
//     drawn the pixel's ray meets the ground plane. Inside the scene's disc
//     (camera.disc, metres from its origin), or its contour (camera.zone,
//     data/sceneZone.js: a mask texture made once per scene), nothing is
//     draped: the scene shows the sales on the roofs and the weather as rain,
//     no heat.
// On the 2D map, the contour of the scene the view is near (camera.zone,
// mapRenderer.js setNearZone) takes the heat off by `zoneFade(zoom)` (0..1,
// renderBudget.js zoneWeatherFade for the temperature; none by default):
// each pixel's place on the ground is read in the mask, as in the 3D.
// Premultiplied, like the heat texture.
import { AverageGridLayerWebGPU } from "js-indexus-sdk/map";
import { mercatorRect } from "js-indexus-sdk/gpu";
import { invert, rectMatrix } from "./engine.js";
import { ZoneMask } from "./zoneMask.js";

/** The view's bounds [w, s, e, n] grown by `margin` of its span on each side (the 3D view's edges). */
export function drapeBounds([west, south, east, north], margin = 0.25) {
  const dx = (east - west) * margin,
    dy = (north - south) * margin;
  return [Math.max(-180, west - dx), Math.max(-85, south - dy), Math.min(180, east + dx), Math.min(85, north + dy)];
}

/**
 * Texels of the heat texture: in screen space the drawable's times the
 * render scale (the MapLibre layer's); over a Mercator rectangle the same
 * count, shaped like the rectangle, at most `max` a side.
 */
export function heatSize(viewport, scale = 1, rect = null, max = 8192) {
  const [w, h] = viewport.map((v) => Math.max(1, Math.ceil(v * scale)));
  if (!rect) return [w, h];
  // square texels on the ground (Mercator is conformal)
  const aspect = (rect[2] - rect[0]) / (rect[3] - rect[1]),
    width = Math.min(max, Math.sqrt(w * h * aspect)),
    height = Math.min(max, width / aspect);
  return [Math.max(1, Math.round(height * aspect)), Math.max(1, Math.round(height))];
}

const WGSL = /* wgsl */ `
struct Drape {
  inverse: mat4x4f, // WebGPU clip -> world
  toRect: vec4f, // world (x, y) -> Mercator less the texture's corner: (x0 + x sx, y0 + y sy)
  size: vec4f, // the texture's Mercator width and height, the viewport's
  ground: vec4f, // ground plane z, opacity, 1 when the texture is the screen's, the scene's disc radius (0: none)
  zone: vec4f, // the scene's contour: its mask's corner (x, y) and 1 / its size (0: none)
  fade: vec4f, // how much of the heat the contour takes off (1 with a scene shown), the disc's heat kept (1 - its presence)
}
@group(0) @binding(0) var<uniform> drape: Drape;
@group(0) @binding(1) var heat: texture_2d<f32>;
@group(0) @binding(2) var linear: sampler;
@group(0) @binding(3) var depth: texture_depth_2d;
@group(0) @binding(4) var zoneMask: texture_2d<f32>;
struct Out {
  @builtin(position) position: vec4f,
  @location(0) clip: vec2f,
}
@vertex fn screen(@builtin(vertex_index) i: u32) -> Out {
  let p = vec2f(select(-1.0, 3.0, i == 1u), select(-1.0, 3.0, i == 2u));
  return Out(vec4f(p, 0.0, 1.0), p);
}
/** 1 inside the contour's mask (world metres), 0 outside it or without one. */
fn inside(xy: vec2f) -> f32 {
  if (drape.zone.z <= 0.0) {
    return 0.0;
  }
  let m = (xy - drape.zone.xy) * drape.zone.zw;
  if (any(m < vec2f(0.0)) || any(m > vec2f(1.0))) {
    return 0.0;
  }
  return select(0.0, 1.0, textureSampleLevel(zoneMask, linear, m, 0.0).r > 0.5);
}
fn unproject(clip: vec2f, z: f32) -> vec3f {
  let p = drape.inverse * vec4f(clip, z, 1.0);
  return p.xyz / p.w;
}
@fragment fn color(i: Out) -> @location(0) vec4f {
  if (drape.ground.z > 0.5) {
    // the 2D map: the heat in screen space, at this pixel's centre
    var heat = textureSampleLevel(heat, linear, i.position.xy / drape.size.zw, 0.0) * drape.ground.y;
    if (drape.zone.z > 0.0 && drape.fade.x > 0.0) {
      // the contour near the view: where the pixel's ray meets the ground
      let a = unproject(i.clip, 0.0);
      let b = unproject(i.clip, 1.0);
      let t = (drape.ground.x - a.z) / (b.z - a.z);
      heat *= 1.0 - drape.fade.x * inside(mix(a, b, t).xy);
    }
    return heat;
  }
  let d = textureLoad(depth, vec2i(i.position.xy), 0);
  var world = unproject(i.clip, d);
  if (d >= 1.0) {
    // nothing drawn here: where the ray meets the ground plane, in front of the eye
    let a = unproject(i.clip, 0.0);
    let b = unproject(i.clip, 1.0);
    let t = (drape.ground.x - a.z) / (b.z - a.z);
    if (!(t > 0.0)) {
      discard;
    }
    world = mix(a, b, t);
  }
  // the scene's disc: no heat on its ground, trees or roofs (fade.y of it kept while the scene fades in or out)
  var disc = 1.0;
  if (dot(world.xy, world.xy) < drape.ground.w * drape.ground.w) {
    if (drape.fade.y <= 0.0) {
      discard;
    }
    disc = drape.fade.y;
  }
  // the scene's contour: no heat inside it either
  let kept = (1.0 - drape.fade.x * inside(world.xy)) * disc;
  if (kept <= 0.0) {
    discard;
  }
  // offsets from the texture's corner: small numbers, precise in float32 at street zoom
  let uv = (drape.toRect.xy + world.xy * drape.toRect.zw) / drape.size.xy;
  if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0))) {
    discard;
  }
  return textureSampleLevel(heat, linear, uv, 0.0) * (drape.ground.y * kept);
}`;

export class HeatDrape {
  /**
   * renderer: mapRenderer(map), which calls it every frame; name: of the
   * pass (HUD gpu.<name>); controller and options: the SDK heat layer's
   * (AverageGridLayerWebGPU). `visible` switches it.
   */
  constructor(renderer, name, controller, features, { zoneFade = null, ...options } = {}) {
    const engine = renderer.engine,
      device = (this.device = engine.device);
    Object.assign(this, { engine, name, controller, zoneFade, visible: true, rect: null, screen: null, size: [1, 1] });
    this.matrix = new Float32Array(16);
    this.layer = new AverageGridLayerWebGPU(name, controller, device, features, {
      ...options,
      surface: {
        matrix: () => this.screen ?? (this.rect ? rectMatrix(this.rect, this.matrix) : null),
        size: () => this.size,
      },
    });
    const module = device.createShaderModule({ code: WGSL });
    this.layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "depth" } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      ],
    });
    this.pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      vertex: { module, entryPoint: "screen" },
      fragment: {
        module,
        entryPoint: "color",
        targets: [
          {
            format: engine.format,
            blend: {
              color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
              alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
            },
          },
        ],
      },
      primitive: { topology: "triangle-list" },
      depthStencil: { format: "depth24plus", depthWriteEnabled: false, depthCompare: "always" },
    });
    this.uniforms = device.createBuffer({ size: 144, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.data = new Float32Array(36); // the uniforms, written every frame (no allocation)
    this.inverse = new Float64Array(16);
    this.mask = new ZoneMask(device);
    this.sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
    this.groups = new WeakMap(); // (heat view, depth texture) -> bind group
    this.removeHost = renderer.host((camera) => this.frame(camera));
  }
  /**
   * Draw the heat for this frame (its passes go into the device's frame,
   * submitted before the engine's) and add the drape pass. camera: the
   * renderer's ({ matrix (WebGPU clip), toMercator, ground, bounds,
   * viewport, disc (the scene's radius, m) with a scene, and mercatorMatrix
   * (Mercator → clip) on the 2D map });
   * opacity: 0..1 over the heat's own.
   */
  frame(camera, opacity = 1) {
    if (!this.visible || !(opacity > 0)) return;
    const scale = this.controller.getRenderScale?.() ?? 1,
      screen = camera.mercatorMatrix ?? null;
    let rect = null;
    if (screen) {
      this.screen = screen;
      this.rect = null;
    } else {
      this.screen = null;
      rect = this.rect = mercatorRect(drapeBounds(camera.bounds));
    }
    // the controllers' scales are of MapLibre's drawable; the canvas may be smaller (engine.js scale)
    this.size = heatSize(camera.viewport, scale / (camera.engineScale ?? 1), rect, this.device.limits?.maxTextureDimension2D);
    const heat = this.layer.draw();
    if (!heat) return;
    // the contour: no heat inside it with a scene shown, `zoneFade` of it on the 2D map
    // (a scene fading in or out: from the 2D map's share to all of it, as its 3D comes)
    const flat = this.zoneFade?.(camera.zoom) ?? 0,
      fade = camera.scene ? flat + (1 - flat) * (camera.presence ?? 1) : !screen ? 1 : flat;
    this.setZone(fade > 0 ? (camera.zone ?? null) : this.mask.zone);
    const data = this.data;
    data.fill(0);
    if (screen || rect) data.set(invert(camera.matrix, this.inverse), 0);
    if (rect) {
      const t = camera.toMercator;
      data[16] = t[0] - rect[0];
      data[17] = t[1] - rect[1];
      data[18] = t[2];
      data[19] = t[3];
      data[20] = rect[2] - rect[0];
      data[21] = rect[3] - rect[1];
    }
    data[22] = camera.viewport[0];
    data[23] = camera.viewport[1];
    data[24] = camera.ground;
    data[25] = opacity;
    data[26] = screen ? 1 : 0;
    data[27] = screen ? 0 : (camera.disc ?? 0);
    if (fade > 0 && camera.zone) {
      this.mask.place(camera.toMercator, data, 28);
      data[32] = fade;
    }
    data[33] = camera.scene ? 1 - (camera.presence ?? 1) : 0;
    this.device.queue.writeBuffer(this.uniforms, 0, data);
    this.engine.add(
      this.name,
      (pass, frame) => {
        pass.setPipeline(this.pipeline);
        pass.setBindGroup(0, this.bindGroup(heat, frame.depth));
        pass.draw(3);
      },
      { stage: "drape" },
    );
  }
  /** The contour (data/sceneZone.js), or null: its mask is made once, when the contour changes. */
  setZone(zone) {
    if (this.mask.set(zone)) this.groups = new WeakMap(); // the bind groups hold the mask
  }
  get zone() {
    return this.mask.zone;
  }
  /** Whether the last frame draped the heat on the 3D (else it was drawn in screen space). */
  get draped() {
    return !!this.rect;
  }
  bindGroup(heat, depth) {
    let byDepth = this.groups.get(heat);
    if (!byDepth) this.groups.set(heat, (byDepth = new WeakMap()));
    let group = byDepth.get(depth);
    if (!group)
      byDepth.set(
        depth,
        (group = this.device.createBindGroup({
          layout: this.layout,
          entries: [
            { binding: 0, resource: { buffer: this.uniforms } },
            { binding: 1, resource: heat },
            { binding: 2, resource: this.sampler },
            { binding: 3, resource: depth.createView() },
            { binding: 4, resource: this.mask.texture.createView() },
          ],
        })),
      );
    return group;
  }
  initializeMask(geojson) {
    this.layer.initializeMask(geojson);
  }
  setMaskEnabled(value) {
    this.layer.setMaskEnabled(value);
  }
  destroy() {
    this.removeHost();
    this.layer.onRemove();
    this.uniforms.destroy();
    this.mask.destroy();
  }
}
