// WebGPU drawing of the scene's sky and air, in the scene renderer
// (rendering/gpu), ported from the scene's WebGL layers (same look):
//   SkyGPU    the celestial sky (sun, moon, stars, twilight) behind everything
//   AirGPU    sun sprite, cloud and fog billboards, cloud banks, rain streaks
//             and impacts on the scene surface (atmosphere.js)
//   LampsGPU  the street lamps at night (streetLights.js)
// Every colour leaves premultiplied (the canvas is): blend one, 1 - alpha.
import { DEPTH_FORMAT, invert } from "../../rendering/gpu/engine.js";

/** Metres of the eye above the cloud banks where they start to fade and are gone (AIR cloudFade). */
export const CLOUD_FADE = [600, 2000];

const PREMULTIPLIED = {
  color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
  alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
};

/** A render pipeline of the scene: depth-tested, no depth write, blended unless `opaque`. */
function pipeline(device, engine, layout, module, vertex, fragment, { buffers = [], opaque = false, cull = "none" } = {}) {
  return device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    vertex: { module, entryPoint: vertex, buffers },
    fragment: { module, entryPoint: fragment, targets: [{ format: engine.format, ...(opaque ? {} : { blend: PREMULTIPLIED }) }] },
    primitive: { topology: "triangle-list", cullMode: cull, frontFace: "ccw" },
    depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: "less-equal" },
  });
}

const uniformBuffer = (device, size) =>
  device.createBuffer({ size, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

const HASH = /* wgsl */ `
fn hash2(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
}`;

// ---- celestial sky ------------------------------------------------------------------------
const SKY = /* wgsl */ `
struct Sky {
  inverse: mat4x4f, // of the frame's view matrix (OpenGL clip)
  camera: vec4f,
  sun: vec4f,
  moon: vec4f,
  state: vec4f, // daylight, cloud cover, latitude, sidereal angle
}
@group(0) @binding(0) var<uniform> sky: Sky;
struct Out {
  @builtin(position) position: vec4f,
  @location(0) ray: vec3f,
}
${HASH}
@vertex fn screen(@builtin(vertex_index) v: u32) -> Out {
  let p = vec2f(select(-1.0, 3.0, v == 1u), select(-1.0, 3.0, v == 2u));
  let far = sky.inverse * vec4f(p, 0.999, 1.0);
  var o: Out;
  o.ray = far.xyz / far.w - sky.camera.xyz;
  // behind everything drawn: the depth of OpenGL's 0.999999
  o.position = vec4f(p, 0.9999995, 1.0);
  return o;
}
@fragment fn color(i: Out) -> @location(0) vec4f {
  let d = normalize(i.ray);
  let sun = sky.sun.xyz;
  let moon = sky.moon.xyz;
  let daylight = sky.state.x;
  let cover = sky.state.y;
  let latitude = sky.state.z;
  let declination = asin(clamp(d.y * cos(latitude) + d.z * sin(latitude), -1.0, 1.0));
  let hourAngle = atan2(-d.x, d.z * cos(latitude) - d.y * sin(latitude));
  let starCoord = vec2f((sky.state.w - hourAngle) / 6.28318530718, declination / 3.14159265359 + 0.5) * vec2f(420.0, 210.0);
  // derivatives before the discard
  let starWidth = max(fwidth(starCoord), vec2f(0.04));
  if (d.z < 0.0) {
    discard;
  }
  let horizon = exp(-d.z * 5.0);
  let sunGlow = pow(max(0.0, dot(d, sun)), 22.0);
  let night = mix(vec3f(0.018, 0.030, 0.062), vec3f(0.065, 0.082, 0.12), horizon);
  let day = mix(vec3f(0.25, 0.48, 0.68), vec3f(0.68, 0.76, 0.79), horizon);
  var c = mix(night, day, daylight);
  let twilight = exp(-abs(sun.z) * 15.0) * (1.0 - cover * 0.65);
  c += vec3f(0.34, 0.12, 0.035) * twilight * horizon * pow(max(0.0, dot(normalize(d.xy), normalize(sun.xy))), 3.0);
  let sunDistance = acos(clamp(dot(d, sun), -1.0, 1.0));
  let sunDisk = 1.0 - smoothstep(0.008, 0.010, sunDistance);
  c += vec3f(1.0, 0.80, 0.42) * (sunDisk * 0.9 + sunGlow * 0.12) * smoothstep(-0.02, 0.02, sun.z) * (1.0 - cover * 0.85);
  var cell = floor(starCoord);
  cell.x = cell.x - 420.0 * floor(cell.x / 420.0);
  let centre = vec2f(hash2(cell + 11.0), hash2(cell + 37.0));
  let spot = length((fract(starCoord) - centre) / starWidth);
  let star = exp(-spot * spot * 1.6) * step(0.978, hash2(cell)) * smoothstep(0.0, 0.12, d.z);
  c += vec3f(0.75, 0.83, 1.0) * star * (1.0 - daylight) * (1.0 - cover) * (1.0 - cover);
  let moonRadius = 0.012;
  if (dot(d, moon) > cos(moonRadius) && moon.z > 0.0) {
    let right = normalize(cross(moon, vec3f(0.0, 0.0, 1.0)));
    let up = normalize(cross(right, moon));
    let uv = vec2f(dot(d, right), dot(d, up)) / sin(moonRadius);
    let r2 = dot(uv, uv);
    let normal = right * uv.x + up * uv.y - moon * sqrt(max(0.0, 1.0 - r2));
    let lit = smoothstep(-0.03, 0.10, dot(normal, sun));
    let relief = 0.87 + 0.08 * sin(uv.x * 31.0 + sin(uv.y * 19.0)) * sin(uv.y * 29.0);
    let edge = 1.0 - smoothstep(0.91, 1.0, r2);
    let visible = (1.0 - cover * 0.9) * mix(0.9, 0.25, daylight);
    c = mix(c, vec3f(0.70, 0.77, 0.87) * relief * (0.045 + 0.95 * lit), edge * visible * (lit + (1.0 - lit) * 0.10 * (1.0 - daylight)));
  }
  return vec4f(c, 1.0);
}`;

export class SkyGPU {
  constructor(engine) {
    const device = (this.device = engine.device),
      module = device.createShaderModule({ code: SKY }),
      layout = device.createBindGroupLayout({
        entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} }],
      });
    this.pipeline = pipeline(device, engine, layout, module, "screen", "color", { opaque: true });
    this.uniforms = uniformBuffer(device, 128);
    this.bindGroup = device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: this.uniforms } }] });
  }
  /** matrix: the frame's view matrix (OpenGL clip); camera; celestial: celestialState(). */
  draw(pass, { matrix, camera, celestial: s }) {
    const data = new Float32Array(32);
    data.set(invert(matrix), 0);
    data.set(camera, 16);
    data.set(s.sunDirection, 20);
    data.set(s.moonDirection, 24);
    data.set([s.daylight, s.clouds, s.latitude, s.sidereal], 28);
    this.device.queue.writeBuffer(this.uniforms, 0, data);
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(3);
  }
  destroy() {
    this.uniforms.destroy();
  }
}

// ---- air: billboards, fog, clouds, rain ---------------------------------------------------
const AIR = /* wgsl */ `
struct Air {
  matrix: mat4x4f,
  camera: vec4f,
  scene: vec4f, // cloud altitude, sun altitude, mood (0 sun, 1 rain, 2 fog), crop radius
  light: vec4f, // sun direction, daylight
  motion: vec4f, // viewport width and height, rain clock, cloud opacity
  field: vec4f, // bounds of the height field
  range: vec4f, // its altitude range
  fog: array<vec4f, 25>, // fog centres (xy)
}
@group(0) @binding(0) var<uniform> air: Air;
@group(0) @binding(1) var heights: texture_2d<f32>;
@group(0) @binding(2) var linear: sampler;
${HASH}
const CLOUD_FADE = vec2f(${CLOUD_FADE[0].toFixed(1)}, ${CLOUD_FADE[1].toFixed(1)});
fn hash1(x: f32) -> f32 {
  return fract(sin(x * 127.1 + 311.7) * 43758.5453);
}
fn noise(p: vec2f) -> f32 {
  let i = floor(p);
  var f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i), hash2(i + vec2f(1.0, 0.0)), f.x), mix(hash2(i + vec2f(0.0, 1.0)), hash2(i + vec2f(1.0)), f.x), f.y);
}
// ground and top altitudes of the scene surface (two 16-bit heights in RG and BA)
fn sceneHeights(xy: vec2f) -> vec2f {
  let b = air.field;
  let uv = clamp((xy - b.xy) / max(b.zw - b.xy, vec2f(0.01)), vec2f(0.0), vec2f(1.0));
  let data = textureSampleLevel(heights, linear, uv, 0.0);
  let h = vec2f(dot(data.rg, vec2f(65280.0, 255.0)), dot(data.ba, vec2f(65280.0, 255.0))) / 65535.0;
  return mix(vec2f(air.range.x), vec2f(air.range.y), h);
}
fn sceneFieldMask(xy: vec2f) -> f32 {
  let edge = min(xy - air.field.xy, air.field.zw - xy);
  return smoothstep(0.0, 8.0, min(edge.x, edge.y));
}

// sun sprite (instances 0..), cloud billboards (100..), fog (200..)
struct Board {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat) seed: f32,
  @location(2) mask: f32,
  @location(3) @interpolate(flat) part: f32,
}
@vertex fn board(@builtin(vertex_index) v: u32, @builtin(instance_index) k: u32) -> Board {
  let quad = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));
  let part = f32(k / 100u);
  let id = k % 100u;
  var o: Board;
  o.seed = f32(id) + 3.0;
  o.uv = quad[v];
  o.mask = 1.0;
  o.part = part;
  let angle = o.seed * 2.399963;
  let radius = 480.0 + hash1(o.seed + 4.0) * 820.0;
  var centre = vec3f(cos(angle) * radius, sin(angle) * radius, air.scene.x + hash1(o.seed + 8.0) * 25.0);
  if (part < 0.5) {
    centre = vec3f(-1100.0, 850.0, air.scene.y);
  }
  if (part > 1.5) {
    centre = vec3f(air.fog[id].xy, 0.0);
    centre.z = sceneHeights(centre.xy).x + 1.8;
    o.mask = sceneFieldMask(centre.xy);
  }
  let d = centre.xy - air.camera.xy;
  let right = select(vec3f(1.0, 0.0, 0.0), normalize(vec3f(-d.y, d.x, 0.0)), length(d) > 0.01);
  var width = select(110.0 + hash1(o.seed + 17.0) * 135.0, 48.0, part < 0.5);
  var height = select(24.0 + hash1(o.seed + 22.0) * 28.0, 48.0, part < 0.5);
  var up = vec3f(0.0, 0.0, 1.0);
  if (part > 1.5) {
    width = 13.0 + hash1(o.seed + 17.0) * 9.0;
    height = 1.8 + hash1(o.seed + 22.0) * 1.4;
    let delta = centre - air.camera.xyz;
    up = select(vec3f(0.0, 0.0, 1.0), normalize(cross(normalize(delta), right)), length(delta) > 0.01);
    o.mask *= smoothstep(6.0, 14.0, length(delta));
  }
  let p = centre + right * o.uv.x * width + up * o.uv.y * height;
  o.position = air.matrix * vec4f(p, 1.0);
  // the cloud billboards stand upright: seen from high above they are streaks on the photo, faded as the banks
  if (part > 0.5 && part < 1.5) {
    o.mask *= 1.0 - smoothstep(CLOUD_FADE.x, CLOUD_FADE.y, air.camera.z - centre.z);
  }
  return o;
}
@fragment fn boardColor(i: Board) -> @location(0) vec4f {
  if (i.part < 0.5) {
    let r = length(i.uv);
    let a = (1.0 - smoothstep(0.40, 0.46, r)) * 0.88 + exp(-r * r * 5.0) * 0.12;
    if (a < 0.01) {
      discard;
    }
    return vec4f(vec3f(1.0, 0.91, 0.65) * a, a);
  }
  let q = i.uv * vec2f(2.8, 2.0) + vec2f(i.seed * 13.7, i.seed * 4.2);
  let detail = noise(q) * 0.57 + noise(q * 2.13 + 7.0) * 0.29 + noise(q * 4.37 - 11.0) * 0.14;
  let s = i.uv * vec2f(0.85, 1.15);
  let shape = 1.0 - dot(s, s);
  let density = smoothstep(0.20, 0.67, shape * 0.64 + detail * 0.58 - 0.12);
  let edge = 1.0 - smoothstep(0.74, 1.0, abs(i.uv.x));
  let sunny = air.scene.z < 0.5;
  let a = density * edge * select(select(0.48, 0.34, sunny), 0.13, i.part > 1.5) * i.mask;
  if (a < 0.01) {
    discard;
  }
  let shade = 0.84 + 0.15 * detail + 0.035 * i.uv.y;
  var c = select(vec3f(shade * 0.83, shade * 0.88, shade * 0.91), vec3f(shade), sunny);
  if (i.part > 1.5) {
    c = vec3f(0.79, 0.84, 0.82);
  }
  return vec4f(c * a, a);
}

// cloud banks: instanced ellipsoids, discreet: none against the eye, fading
// toward the horizon, and gone when the eye is high above them (the map seen
// from above shows the ground and its photo, not a veil:
// them, from 0.6 km over them, about zoom 16.5 looking down, to 2 km, zoom
// 15.3; lower, at a pitch, they stay)
fn cloudFade(p: vec3f) -> f32 {
  let distance = length(air.camera.xyz - p);
  let above = air.camera.z - air.scene.x;
  return smoothstep(30.0, 150.0, distance) * (1.0 - smoothstep(3000.0, 7000.0, distance)) * (1.0 - smoothstep(CLOUD_FADE.x, CLOUD_FADE.y, above));
}
struct Cloud {
  @builtin(position) position: vec4f,
  @location(0) light: f32,
  @location(1) alpha: f32,
  @location(2) world: vec3f,
}
@vertex fn cloud(@location(0) sphere: vec3f, @location(1) centre: vec3f, @location(2) scale: vec3f, @location(3) shade: f32) -> Cloud {
  let p = centre + sphere * scale;
  let n = normalize(sphere / scale);
  let eye = normalize(air.camera.xyz - p);
  let sun = max(0.0, dot(n, normalize(air.light.xyz)));
  var o: Cloud;
  o.light = shade * (0.78 + 0.22 * sun) * mix(0.47, 1.0, air.light.w);
  o.alpha = 0.30 * air.motion.w * smoothstep(0.03, 0.70, abs(dot(n, eye))) * cloudFade(p);
  o.world = p;
  o.position = air.matrix * vec4f(p, 1.0);
  return o;
}
@fragment fn cloudColor(i: Cloud) -> @location(0) vec4f {
  let r = air.scene.w;
  let mask = select(1.0, 1.0 - smoothstep(r - 2.0, r, length(i.world.xy)), r > 0.0);
  if (mask <= 0.0) {
    discard;
  }
  let a = i.alpha * mask;
  return vec4f(vec3f(i.light * 0.98, i.light, i.light * 1.025) * a, a);
}

// rain: one drop per contact (position, normal, kind/base/phase/seed, start height)
struct Drop {
  @builtin(position) position: vec4f,
  @location(0) opacity: f32,
  @location(1) uv: vec2f,
  @location(2) age: f32,
  @location(3) @interpolate(flat) leaf: f32,
}
struct Contact {
  seed: f32,
  phase: f32,
  ratio: f32, // part of the cycle spent falling
  point: vec3f,
}
fn contact(position: vec3f, normal: vec3f, details: vec4f, start: f32) -> Contact {
  var c: Contact;
  c.seed = details.w;
  let fall = max(0.45, (start - position.z) / 18.0);
  c.phase = fract(c.seed + air.motion.z / (fall + 0.4));
  c.ratio = fall / (fall + 0.4);
  c.point = position + normal * 0.045;
  return c;
}
const HIDDEN = vec4f(2.0, 2.0, 2.0, 1.0);
@vertex fn streak(@builtin(vertex_index) v: u32, @location(0) position: vec3f, @location(1) normal: vec3f,
                  @location(2) details: vec4f, @location(3) start: f32) -> Drop {
  let quad = array<vec2f, 6>(vec2f(-1.0, 0.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0), vec2f(-1.0, 0.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));
  let c = contact(position, normal, details, start);
  var o: Drop;
  o.uv = quad[v];
  let fall = clamp(c.phase / c.ratio, 0.0, 1.0);
  let lean = vec2f(sin(c.seed * 81.0), cos(c.seed * 59.0)) * 0.065;
  let height = (1.0 - fall) * max(0.0, start - c.point.z);
  // the ray stays vertical in narrow streets; the whole streak shortens at the surface
  let p = c.point + vec3f(0.0, 0.0, height);
  let tailHeight = min(1.1 + c.seed * 0.8, height);
  let head = air.matrix * vec4f(p, 1.0);
  let tail = air.matrix * vec4f(p + vec3f(lean * tailHeight, tailHeight), 1.0);
  if (c.phase >= c.ratio || head.w <= 0.001 || tail.w <= 0.001) {
    o.position = HIDDEN;
    return o;
  }
  let viewport = air.motion.xy;
  let projected = (tail.xy / tail.w - head.xy / head.w) * viewport * 0.5;
  let pixels = length(projected);
  let direction = select(vec2f(0.0, 1.0), projected / pixels, pixels > 0.01);
  let shown = clamp(pixels, 3.0, 10.0) * smoothstep(0.0, 0.45, height);
  let across = vec2f(-direction.y, direction.x);
  let clip = mix(head, tail, o.uv.y);
  let offset = (direction * shown * o.uv.y + across * o.uv.x * (0.8 + c.seed * 0.25)) * 2.0 / viewport;
  o.position = vec4f((head.xy / head.w + offset) * clip.w, clip.z, clip.w);
  o.opacity = (0.5 + 0.16 * c.seed) * smoothstep(2.0, 7.0, length(p - air.camera.xyz));
  return o;
}
@fragment fn streakColor(i: Drop) -> @location(0) vec4f {
  let side = 1.0 - smoothstep(0.25, 1.0, abs(i.uv.x));
  let ends = smoothstep(0.0, 0.12, i.uv.y) * (1.0 - smoothstep(0.75, 1.0, i.uv.y));
  let a = i.opacity * side * ends * (1.0 - i.uv.y * 0.6);
  if (a < 0.005) {
    discard;
  }
  return vec4f(vec3f(0.91, 0.96, 1.0) * a, a);
}
@vertex fn impact(@builtin(vertex_index) v: u32, @location(0) position: vec3f, @location(1) normal: vec3f,
                  @location(2) details: vec4f, @location(3) start: f32) -> Drop {
  let quad = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));
  let c = contact(position, normal, details, start);
  var o: Drop;
  o.uv = quad[v];
  o.age = clamp((c.phase - c.ratio) / (1.0 - c.ratio), 0.0, 1.0);
  o.leaf = select(0.0, 1.0, details.x == 3.0 || details.x == 5.0);
  if (c.phase < c.ratio) {
    o.position = HIDDEN;
    return o;
  }
  let n = normalize(normal);
  let t = normalize(cross(select(vec3f(0.0, 0.0, 1.0), vec3f(0.0, 1.0, 0.0), abs(n.z) > 0.95), n));
  let b = cross(n, t);
  let radius = (0.45 + c.seed * 0.65) * mix(1.0, 0.55, o.leaf);
  let p = c.point + (t * o.uv.x + b * o.uv.y) * radius;
  o.position = air.matrix * vec4f(p, 1.0);
  o.opacity = 0.72 * pow(1.0 - o.age, 1.5) * smoothstep(1.0, 5.0, length(p - air.camera.xyz));
  return o;
}
@fragment fn impactColor(i: Drop) -> @location(0) vec4f {
  let r = length(i.uv);
  let aa = max(fwidth(r), 0.018);
  let ring = 1.0 - smoothstep(0.025, 0.025 + aa, abs(r - mix(0.08, 0.90, i.age)));
  let centre = (1.0 - smoothstep(0.03, 0.18 + aa, r)) * (1.0 - smoothstep(0.0, 0.35, i.age));
  // a brief broken sparkle on foliage; a softer circular impact on hard surfaces
  let flecks = mix(1.0, 0.4 + 0.6 * smoothstep(-0.2, 0.7, sin(atan2(i.uv.y, i.uv.x) * 5.0 + i.age * 7.0)), i.leaf);
  let a = i.opacity * max(ring * flecks, centre) * (1.0 - smoothstep(0.94, 1.0, r));
  if (a < 0.008) {
    discard;
  }
  return vec4f(vec3f(0.88, 0.95, 1.0) * a, a);
}`;

const CONTACT = {
  arrayStride: 44,
  stepMode: "instance",
  attributes: [
    { shaderLocation: 0, offset: 0, format: "float32x3" },
    { shaderLocation: 1, offset: 12, format: "float32x3" },
    { shaderLocation: 2, offset: 24, format: "float32x4" },
    { shaderLocation: 3, offset: 40, format: "float32" },
  ],
};

export class AirGPU {
  /** geometry: cloudGeometry(); cloudBytes: bytes of the cloud instances at most. */
  constructor(engine, geometry, cloudBytes) {
    const device = (this.device = engine.device),
      module = device.createShaderModule({ code: AIR }),
      both = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
      layout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: both, buffer: {} },
          { binding: 1, visibility: GPUShaderStage.VERTEX, texture: {} },
          { binding: 2, visibility: GPUShaderStage.VERTEX, sampler: {} },
        ],
      }),
      make = (vertex, fragment, options) => pipeline(device, engine, layout, module, vertex, fragment, options);
    this.layout = layout;
    this.boards = make("board", "boardColor");
    this.clouds = make("cloud", "cloudColor", {
      cull: "back",
      buffers: [
        { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] },
        {
          arrayStride: 28,
          stepMode: "instance",
          attributes: [
            { shaderLocation: 1, offset: 0, format: "float32x3" },
            { shaderLocation: 2, offset: 12, format: "float32x3" },
            { shaderLocation: 3, offset: 24, format: "float32" },
          ],
        },
      ],
    });
    this.streaks = make("streak", "streakColor", { buffers: [CONTACT] });
    this.impacts = make("impact", "impactColor", { buffers: [CONTACT] });
    this.uniforms = uniformBuffer(device, 160 + 25 * 16);
    this.sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
    const buffer = (data, usage) => {
      const b = device.createBuffer({ size: Math.ceil(data.byteLength / 4) * 4, usage: usage | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(b, 0, data.buffer, data.byteOffset, Math.ceil(data.byteLength / 4) * 4);
      return b;
    };
    this.sphere = buffer(geometry.positions, GPUBufferUsage.VERTEX);
    const indices = new Uint16Array(Math.ceil(geometry.indices.length / 2) * 2);
    indices.set(geometry.indices);
    this.sphereIndices = buffer(indices, GPUBufferUsage.INDEX);
    this.sphereCount = geometry.indices.length;
    this.cloudInstances = device.createBuffer({ size: cloudBytes, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.gpuBytes = geometry.positions.byteLength + indices.byteLength + cloudBytes;
    this.setField({ size: 1, pixels: new Uint8Array(4), bounds: [0, 0, 1, 1], range: [0, 1] });
  }
  /** The scene surface's height field (atmosphereField): fog stands on it. */
  setField(field) {
    this.fieldTexture?.destroy();
    this.fieldTexture = this.device.createTexture({
      size: [field.size, field.size],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.device.queue.writeTexture({ texture: this.fieldTexture }, field.pixels, { bytesPerRow: field.size * 4 }, [field.size, field.size]);
    this.field = field;
    this.bindGroup = this.device.createBindGroup({
      layout: this.layout,
      entries: [
        { binding: 0, resource: { buffer: this.uniforms } },
        { binding: 1, resource: this.fieldTexture.createView() },
        { binding: 2, resource: this.sampler },
      ],
    });
  }
  /** Visible cloud lobes (CloudVisibility.data, 7 floats each). */
  setClouds(data, count) {
    if (count) this.device.queue.writeBuffer(this.cloudInstances, 0, data, 0, count * 7);
  }
  /** Rain contacts (rainContacts.js, 11 floats each). */
  setContacts(data) {
    this.contacts?.destroy();
    this.contacts = null;
    if (!data.length) return;
    this.contacts = this.device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(this.contacts, 0, data);
  }
  /**
   * plan: { matrix (WebGPU clip), camera, scene: [cloud altitude, sun altitude, mood, crop
   * radius], light: [x, y, z, daylight], viewport, time, cloudOpacity, fog (centres),
   * sun, boards, clouds (count), drops (count) }
   */
  draw(pass, plan) {
    const data = new Float32Array(40 + 100),
      field = this.field;
    data.set(plan.matrix, 0);
    data.set(plan.camera, 16);
    data.set(plan.scene, 20);
    data.set(plan.light, 24);
    data.set([plan.viewport[0], plan.viewport[1], plan.time, plan.cloudOpacity], 28);
    data.set(field.bounds, 32);
    data.set(field.range, 36);
    if (plan.fog) for (let k = 0; k < 25; k++) data.set([plan.fog[2 * k], plan.fog[2 * k + 1]], 40 + 4 * k);
    this.device.queue.writeBuffer(this.uniforms, 0, data);
    pass.setBindGroup(0, this.bindGroup);
    if (plan.sun || plan.boards || plan.fog) {
      pass.setPipeline(this.boards);
      if (plan.sun) pass.draw(6, 1, 0, 0);
      if (plan.boards) pass.draw(6, 16, 0, 100);
      if (plan.fog) pass.draw(6, 25, 0, 200);
    }
    if (plan.clouds) {
      pass.setPipeline(this.clouds);
      pass.setVertexBuffer(0, this.sphere);
      pass.setVertexBuffer(1, this.cloudInstances);
      pass.setIndexBuffer(this.sphereIndices, "uint16");
      pass.drawIndexed(this.sphereCount, plan.clouds);
    }
    if (plan.drops && this.contacts) {
      for (const p of [this.streaks, this.impacts]) {
        pass.setPipeline(p);
        pass.setVertexBuffer(0, this.contacts);
        pass.draw(6, plan.drops);
      }
    }
  }
  destroy() {
    for (const b of [this.uniforms, this.sphere, this.sphereIndices, this.cloudInstances, this.contacts, this.fieldTexture])
      b?.destroy();
  }
}

// ---- street lamps ----------------------------------------------------------------------------
const LAMPS = /* wgsl */ `
struct Lamps {
  matrix: mat4x4f,
  view: vec4f, // viewport width and height, wave centre
  wave: vec4f, // elapsed (s), night, crop radius, opacity
  speed: vec4f, // wave speed (m/s)
}
@group(0) @binding(0) var<uniform> lamps: Lamps;
struct Out {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) world: vec2f,
  @location(2) strength: f32,
  @location(3) @interpolate(flat) part: u32,
}
@vertex fn lamp(@builtin(vertex_index) k: u32, @location(0) anchor: vec3f) -> Out {
  let v = k % 6u;
  var o: Out;
  o.part = k / 6u;
  o.uv = vec2f(select(-1.0, 1.0, v == 1u || v == 2u || v == 4u), select(-1.0, 1.0, v >= 2u && v <= 4u));
  let delay = distance(anchor.xy, lamps.view.zw) / lamps.speed.x + fract(sin(dot(anchor.xy, vec2f(12.9898, 78.233))) * 43758.5453) * 0.18;
  o.world = anchor.xy;
  o.strength = lamps.wave.y * smoothstep(delay, delay + 0.65, lamps.wave.x) * lamps.wave.w;
  let radius = lamps.wave.z;
  if (radius > 0.0 && length(anchor.xy) > radius) {
    o.strength = 0.0;
  }
  let top = lamps.matrix * vec4f(anchor + vec3f(0.0, 0.0, 5.5), 1.0);
  if (o.part == 0u) {
    let p = anchor + vec3f(o.uv * 7.0, 0.06);
    o.world = p.xy;
    o.position = lamps.matrix * vec4f(p, 1.0);
  } else {
    o.position = vec4f(top.xy + o.uv * vec2f(9.0) / lamps.view.xy * top.w, top.zw);
  }
  return o;
}
@fragment fn glow(i: Out) -> @location(0) vec4f {
  let radius = lamps.wave.z;
  if (radius > 0.0 && length(i.world) > radius) {
    discard;
  }
  var a: f32;
  if (i.part == 0u) {
    let d = dot(i.uv, i.uv);
    a = exp(-d * 4.0) * (1.0 - smoothstep(0.65, 1.0, d)) * 0.40;
  } else {
    let d = length(i.uv);
    a = (exp(-d * d * 5.0) * 0.80 + (1.0 - smoothstep(0.12, 0.35, d)) * 0.60) * (1.0 - smoothstep(0.7, 1.0, d));
  }
  a = clamp(a * i.strength, 0.0, 1.0);
  if (a < 0.002) {
    discard;
  }
  return vec4f(vec3f(1.0, 0.96, 0.86) * a, a);
}`;

export class LampsGPU {
  constructor(engine) {
    const device = (this.device = engine.device),
      module = device.createShaderModule({ code: LAMPS }),
      layout = device.createBindGroupLayout({
        entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} }],
      });
    this.pipeline = pipeline(device, engine, layout, module, "lamp", "glow", {
      buffers: [{ arrayStride: 12, stepMode: "instance", attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] }],
    });
    this.uniforms = uniformBuffer(device, 112);
    this.bindGroup = device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: this.uniforms } }] });
    this.count = 0;
  }
  /** lamps: x, y, z per lamp (local metres). */
  setLamps(lamps) {
    this.anchors?.destroy();
    this.count = lamps.length / 3;
    this.anchors = this.device.createBuffer({ size: Math.max(12, lamps.byteLength), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    if (lamps.length) this.device.queue.writeBuffer(this.anchors, 0, lamps);
  }
  /** matrix (WebGPU clip), viewport, centre, elapsed, night, radius, opacity, speed */
  draw(pass, u) {
    if (!this.count) return;
    const data = new Float32Array(28);
    data.set(u.matrix, 0);
    data.set([u.viewport[0], u.viewport[1], u.centre[0], u.centre[1]], 16);
    data.set([u.elapsed, u.night, u.radius, u.opacity], 20);
    data[24] = u.speed;
    this.device.queue.writeBuffer(this.uniforms, 0, data);
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.setVertexBuffer(0, this.anchors);
    pass.draw(12, this.count);
  }
  destroy() {
    this.uniforms.destroy();
    this.anchors?.destroy();
  }
}
