// Weather effects on WebGPU: the pre-E animated atmosphere layer (experiences
// 6526f24 animatedWeather.js, a WebGL custom layer) ported to WGSL, over the
// ground of any camera: clouds shaped by a noise texture whose broad field is
// carried by the integrated wind, their cover and opacity mapped from the
// cloud grid as before, rain drops and splashes where the rain grid passes
// its threshold, the rain's dashed contour, its veil and its wet tint, on
// land only (the France polygon). The grids are the regional 128 x 128
// Mercator grid of the run and its coarser levels (atmosphere.js), sampled
// bilinearly, blended between the two levels around the zoom (zoom - 5) and
// between the hour and the next one, exactly as the former layer sampled them.
//
//   const effects = new WeatherEffects();
//   effects.init(device, { format, depthFormat });
//   effects.setAtmosphere(atmosphere, polygon);   // atmosphere.js createAtmosphere
//   effects.setState({ hour, zoom, layers: {rain, clouds, opacity}, cloudTravel });
//   effects.encode(pass, camera);                 // in a render pass of the frame
//
// camera: {matrix: world → WebGPU clip (z 0..1), toMercator: [x0, y0, sx, sy]
// world (x, y) → Mercator (x0 + x·sx, y0 + y·sy), ground: world z of the
// ground plane, viewport: [width, height], zone: a scene's contour or null
// (data/sceneZone.js)}. A 2D map: gpuMatrix(mainMatrix), [0, 0, 1, 1], 0. The
// scene: its local matrix, [origin.x, origin.y, unit, -unit], 0.
//
// A scene's contour takes the effects off by state.zoneFade (0..1: 1 while
// the scene is shown, whose own clouds and rain stand over its 3D; on the 2D
// map renderBudget.js zoneWeatherFade, as the orthophoto comes in): never a
// veil of clouds on the photo.

import { landCanvas } from "./atmosphere.js";
import { ATMOSPHERE_PIXELS, boundedRenderScale } from "./renderBudget.js";
import { ZoneMask } from "../../rendering/gpu/zoneMask.js";

const NOISE = 128;

const SHADER = /* wgsl */ `
struct Effects {
  inverse: mat4x4f,     // WebGPU clip -> world
  toMercator: vec4f,
  rect: vec4f,          // the grid: west x, north y, east x, south y (Mercator)
  sampling: vec4f,      // level blend, hour blend, zoomDetail (zoom - 5), seconds
  motion: vec4f,        // cloudTravel, hour, drift, windRange
  layers: vec4f,        // rain on, clouds on, opacity, ground z
  viewport: vec4f,      // width, height, noise level bias (the former layer's render scale), zone fade
  zone: vec4f,          // the contour's mask: its corner (world x, y) and 1 / its size (0: none)
}
@group(0) @binding(0) var<uniform> fx: Effects;
@group(0) @binding(1) var linear: sampler;
@group(0) @binding(2) var repeat: sampler;
@group(0) @binding(3) var coarseField: texture_2d<f32>;
@group(0) @binding(4) var fineField: texture_2d<f32>;
@group(0) @binding(5) var nextCoarseField: texture_2d<f32>;
@group(0) @binding(6) var nextFineField: texture_2d<f32>;
@group(0) @binding(7) var landMask: texture_2d<f32>;
@group(0) @binding(8) var weatherNoise: texture_2d<f32>;
@group(0) @binding(9) var windOffsets: texture_2d<f32>;
@group(0) @binding(10) var nextWindOffsets: texture_2d<f32>;
@group(0) @binding(11) var eastwardWind: texture_2d<f32>;
@group(0) @binding(12) var nextEastwardWind: texture_2d<f32>;
@group(0) @binding(13) var zoneMask: texture_2d<f32>;

const rainThreshold = 0.2 / 3.0;
/** Mip level of the noise for a unit step of its coordinate per pixel (set per fragment). */
var<private> noiseLod: f32 = 0.0;
/** The world (x, y) of the last groundAt. */
var<private> groundWorld: vec2f = vec2f(0.0);

struct Out {
  @builtin(position) position: vec4f,
  @location(0) clip: vec2f,
}
@vertex fn fullscreen(@builtin(vertex_index) i: u32) -> Out {
  let p = vec2f(select(-1.0, 3.0, i == 1u), select(-1.0, 3.0, i == 2u));
  return Out(vec4f(p, 0.0, 1.0), p);
}

/** The grid units (0..1, y south) of the ground under a clip position; z = 0 off the ground. */
fn groundAt(clip: vec2f) -> vec3f {
  let a = fx.inverse * vec4f(clip, 0.0, 1.0);
  let b = fx.inverse * vec4f(clip, 1.0, 1.0);
  let p = a.xyz / a.w;
  let q = b.xyz / b.w;
  let dz = q.z - p.z;
  if (abs(dz) < 1e-12) { return vec3f(0.0); }
  let t = (fx.layers.w - p.z) / dz;
  if (t < 0.0) { return vec3f(0.0); }
  let g = p + (q - p) * t;
  groundWorld = g.xy;
  let m = fx.toMercator.xy + g.xy * fx.toMercator.zw;
  return vec3f((m - fx.rect.xy) / (fx.rect.zw - fx.rect.xy), 1.0);
}

/** 1 inside the contour's mask (world metres), 0 outside it or without one. */
fn insideZone(xy: vec2f) -> f32 {
  if (fx.zone.z <= 0.0) { return 0.0; }
  let m = (xy - fx.zone.xy) * fx.zone.zw;
  if (any(m < vec2f(0.0)) || any(m > vec2f(1.0))) { return 0.0; }
  return select(0.0, 1.0, textureSampleLevel(zoneMask, linear, m, 0.0).r > 0.5);
}
fn hash(p: vec2f) -> f32 {
  var q = fract(vec3f(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
/** texture2D(weatherNoise, uv).r of the former layer: repeat, trilinear; scale = |d uv / d p|. */
fn noiseAt(uv: vec2f, scale: f32) -> f32 {
  return textureSampleLevel(weatherNoise, repeat, uv, max(0.0, noiseLod + log2(scale))).r;
}
fn rainDrop(rainUV: vec2f, cell: vec2f, detail: f32, rainfall: f32, windTilt: f32) -> vec2f {
  let seconds = fx.sampling.w;
  let seedRain = hash(cell + detail * 19.0);
  let clock = seconds * 0.6 * (1.0 + seedRain * 0.95) + seedRain;
  let cycle = floor(clock);
  let age = fract(clock);
  let eventKey = cell + vec2f(37.1, 17.7) * (cycle - 251.0 * floor(cycle / 251.0)) + detail * 19.0;
  let positionX = hash(eventKey + vec2f(2.7, 5.1));
  let positionY = hash(eventKey + vec2f(11.2, 3.4));
  let size = hash(eventKey + vec2f(7.8, 13.2));
  let drop = (rainUV - cell) - vec2f(mix(0.28, 0.72, positionX), mix(0.31, 0.76, positionY));
  let head = mix(-0.48, 0.0, min(age / 0.30, 1.0));
  let dropScale = mix(0.72, 0.92, size);
  let tailDistance = (head - drop.y) / dropScale;
  let trail = smoothstep(-0.026, 0.015, tailDistance) * (1.0 - smoothstep(0.08, 0.28, tailDistance));
  let jitter = (hash(eventKey + vec2f(6.4, 31.7)) - 0.5) * 0.08;
  let slope = clamp(0.055 + windTilt + jitter, -0.20, 0.20);
  let acrossStreak = abs(drop.x - slope * drop.y) / dropScale;
  let streak = (1.0 - smoothstep(0.018, 0.052, acrossStreak)) * trail;
  let streakOutline = (1.0 - smoothstep(0.033, 0.070, acrossStreak)) * trail;
  let impact = clamp((age - 0.30) / 0.70, 0.0, 1.0);
  let maxRadius = mix(0.08, 0.18, size);
  let radius = impact * maxRadius;
  let groundDistance = length(drop * vec2f(1.0, 2.3));
  let ringDistance = abs(groundDistance - radius);
  let decay = 1.0 - smoothstep(0.12, 1.0, impact);
  let ring = (1.0 - smoothstep(0.016, 0.050, ringDistance)) * decay;
  let ringOutline = (1.0 - smoothstep(0.032, 0.068, ringDistance)) * decay;
  let diskRadius = max(radius, maxRadius * 0.46);
  let disk = 1.0 - smoothstep(diskRadius * 0.65, diskRadius, groundDistance);
  let diskOpacity = mix(0.65, 0.25, smoothstep(0.0, 0.42, impact)) * decay;
  let splash = max(ring, disk * diskOpacity);
  let phase = smoothstep(0.28, 0.34, age);
  let threshold = hash(eventKey + vec2f(17.3, 23.9));
  var wet = smoothstep(threshold - 0.08, threshold + 0.08, rainfall);
  wet *= smoothstep(0.0, 0.045, age);
  let opacity = mix(0.95, 0.64, size);
  return vec2f(mix(streak, splash, phase), mix(streakOutline, ringOutline, phase) * 0.38) * wet * opacity;
}
fn windOffset(source: texture_2d<f32>, p: vec2f) -> vec2f {
  let encoded = textureSampleLevel(source, linear, p, 0.0);
  let normalized = (encoded.rb * 256.0 + encoded.ga) / 257.0;
  return (normalized * 2.0 - 1.0) * fx.motion.w;
}
fn eastwardTilt(source: texture_2d<f32>, p: vec2f) -> f32 {
  return (textureSampleLevel(source, linear, p, 0.0).r * 255.0 - 128.0) * (0.16 / 127.0);
}
fn cloudAt(p: vec2f, weather: vec4f) -> vec4f {
  let seconds = fx.sampling.w;
  // only the timeline moves the broad field; the bounded deformation changes the
  // small-scale texture in place, even while playback is paused
  var wind = p * vec2f(0.15, 0.22) - fx.motion.x * vec2f(0.0011, 0.00026);
  if (fx.motion.w > 0.0) {
    let offset = mix(windOffset(windOffsets, p), windOffset(nextWindOffsets, p), fx.sampling.y);
    wind = (p - offset) * vec2f(0.15, 0.22);
  }
  // mat2(.8, .6, -.6, .8) of GLSL, column-major
  let rotate = mat2x2f(0.8, 0.6, -0.6, 0.8);
  let growthUV = wind * 0.58 + vec2f(0.27, 0.63);
  let growthField = vec2f(noiseAt(growthUV, 0.13), noiseAt(rotate * growthUV + vec2f(0.31, 0.47), 0.13));
  let localVariation = growthField * 2.0 - 1.0;
  let deformation = localVariation * sin(seconds * vec2f(0.70, 0.54));
  let folds = rotate * wind * 2.8 + vec2f(0.41, 0.17) + deformation * 0.0022;
  let wisps = rotate * folds * 2.6 + vec2f(0.19, 0.37);
  let body = noiseAt(wind, 0.22);
  let mid = noiseAt(folds, 0.62);
  let fine = noiseAt(wisps, 1.6);
  // at closer zooms the smaller fields drive the silhouette, the broad one keeps the bank
  let split = smoothstep(0.2, 2.8, fx.sampling.z);
  let localSplit = smoothstep(2.8, 5.8, fx.sampling.z);
  let broadDensity = 0.58 * body + 0.29 * mid + 0.13 * fine;
  let regionalDensity = 0.24 * body + 0.57 * mid + 0.19 * fine;
  let localDensity = 0.20 * body + 0.23 * mid + 0.57 * fine;
  var density = mix(mix(broadDensity, regionalDensity, split), localDensity, localSplit);
  if (split > 0.0) {
    let grainUV = rotate * wisps * 3.4;
    density += 0.15 * split * (noiseAt(grainUV, 5.5) - 0.5);
  }
  let coverage = smoothstep(0.04, 0.85, weather.g);
  let precipitation = smoothstep(0.01, 0.88, sqrt(weather.b));
  let daylight = sqrt(weather.a);
  let cycle = vec2f(sin(seconds * 0.59), cos(seconds * 0.71));
  let condensation = 0.31 * dot(localVariation, cycle);
  let growth = smoothstep(0.18, 0.82, growthField.x + condensation);
  var thickness = density - mix(0.71, 0.35, coverage) + mix(-0.16, 0.10, growth);
  thickness += 0.085 * precipitation;
  let opacity = smoothstep(-0.035, 0.24, thickness) * coverage * (mix(0.28, 0.56, growth) + 0.13 * precipitation);
  // the density toward the light reveals relief inside the cloud
  let sunward = noiseAt(wind + vec2f(-0.005, -0.004), 0.22);
  let relief = smoothstep(-0.22, 0.26, body - sunward + (mid - 0.5) * 0.26);
  let light = clamp(0.18 + 0.58 * daylight + 0.24 * relief, 0.0, 1.0);
  let dryCloud = mix(vec3f(0.56, 0.61, 0.70), vec3f(1.0, 0.99, 0.96), light);
  let rainyCloud = mix(vec3f(0.35, 0.38, 0.43), vec3f(0.65, 0.67, 0.69), light);
  let color = mix(dryCloud, rainyCloud, precipitation);
  return vec4f(color * opacity, opacity);
}
fn rainAt(p: vec2f, detail: f32, rainfall: f32, windTilt: f32) -> vec2f {
  let rainUV = p * (17.0 * exp2(detail));
  let cell = floor(rainUV);
  var rain = rainDrop(rainUV, cell, detail, rainfall, windTilt);
  // a streak can start above the cell that owns its impact
  if (fract(rainUV.y) > 0.58) {
    rain = max(rain, rainDrop(rainUV, cell + vec2f(0.0, 1.0), detail, rainfall, windTilt));
  }
  return rain;
}
fn weatherAt(point: vec2f) -> vec4f {
  let current = mix(textureSampleLevel(coarseField, linear, point, 0.0), textureSampleLevel(fineField, linear, point, 0.0), fx.sampling.x);
  let next = mix(textureSampleLevel(nextCoarseField, linear, point, 0.0), textureSampleLevel(nextFineField, linear, point, 0.0), fx.sampling.x);
  return mix(current, next, fx.sampling.y);
}
fn rainfallAt(point: vec2f) -> f32 {
  return weatherAt(point).r;
}

@fragment fn draw(input: Out) -> @location(0) vec4f {
  let pixel = 2.0 / fx.viewport.xy;
  let g = groundAt(input.clip);
  // the scene's contour: its share of the effects taken off (the photo stays clear)
  let kept = 1.0 - fx.viewport.w * insideZone(groundWorld);
  if (kept <= 0.0) { return vec4f(0.0); }
  let gx = groundAt(input.clip + vec2f(pixel.x, 0.0));
  let gy = groundAt(input.clip - vec2f(0.0, pixel.y));
  let p = g.xy;
  let stepX = gx.xy - p;
  let stepY = gy.xy - p;
  // a grid unit per pixel, for the noise's mip level (the former trilinear filter)
  // the former layer drew at ATMOSPHERE_PIXELS (fewer, larger pixels): its noise was that much coarser
  noiseLod = log2(max(max(length(stepX), length(stepY)) * f32(${NOISE}), 1e-6)) + fx.viewport.z;
  if (g.z == 0.0 || min(min(p.x, p.y), min(1.0 - p.x, 1.0 - p.y)) < 0.0) { return vec4f(0.0); }
  let land = textureSampleLevel(landMask, linear, p, 0.0).a;
  if (land <= 0.0) { return vec4f(0.0); }
  let sampleAt = p - vec2f((fx.motion.y - 12.0) * fx.motion.z, 0.0);
  let edge = smoothstep(0.0, 0.08, min(min(sampleAt.x, sampleAt.y), min(1.0 - sampleAt.x, 1.0 - sampleAt.y)));
  if (edge <= 0.0) { return vec4f(0.0); }
  var weather = weatherAt(sampleAt);
  let rawRain = weather.r;
  weather = vec4f(weather.r * fx.layers.x, weather.g * fx.layers.y, weather.b, weather.a);
  var color = vec3f(0.0);
  var alpha = 0.0;
  if (max(weather.r, weather.g) > 0.0) {
    var cloud = vec4f(0.0);
    if (weather.g > 0.04) { cloud = cloudAt(p, weather); }
    var drops = vec2f(0.0);
    let rainPresence = smoothstep(rainThreshold * 0.5, rainThreshold, weather.r);
    if (rainPresence > 0.0) {
      // split the geographic rain grid at every zoom, even past the grid's finest level
      let zoomDetail = fx.sampling.z;
      let rainLevel = floor(zoomDetail);
      let rainBlend = smoothstep(0.0, 1.0, fract(zoomDetail));
      let band = noiseAt(p * vec2f(0.052, 0.086) + vec2f(0.57, 0.13), 0.07);
      let rainfall = mix(0.32, 0.95, smoothstep(rainThreshold, 1.0, weather.r)) * mix(0.85, 1.1, smoothstep(0.15, 0.85, band));
      var windTilt = 0.0;
      if (fx.motion.w > 0.0) {
        windTilt = mix(eastwardTilt(eastwardWind, p), eastwardTilt(nextEastwardWind, p), fx.sampling.y);
      }
      drops = rainAt(p, rainLevel, rainfall, windTilt);
      if (rainBlend > 0.0) { drops = mix(drops, rainAt(p, rainLevel + 1.0, rainfall, windTilt), rainBlend); }
      drops *= rainPresence;
    }
    let rain = drops.x;
    let outline = drops.y;
    let behindRain = 1.0 - rain;
    let behindOutline = 1.0 - outline;
    alpha = rain + (outline + cloud.a * behindOutline) * behindRain;
    color = cloud.rgb * behindOutline * behindRain + vec3f(0.15, 0.26, 0.35) * outline * behindRain + vec3f(0.96, 0.99, 1.0) * rain;
    let veil = 0.22 * smoothstep(0.0, 0.55, weather.r);
    color += vec3f(0.22, 0.24, 0.26) * veil * (1.0 - alpha);
    alpha += veil * (1.0 - alpha);
    // a faint blue interior links the contour to the area it encloses
    let wetArea = 0.035 * rainPresence;
    color = vec3f(0.66, 0.85, 0.94) * wetArea + color * (1.0 - wetArea);
    alpha = wetArea + alpha * (1.0 - wetArea);
    color *= edge * land;
    alpha *= edge * land;
  }
  // the rain's dashed contour (the former full-resolution composite pass)
  if (fx.layers.x > 0.5 && rawRain > 0.0) {
    let gradient = vec2f(rainfallAt(sampleAt + stepX) - rawRain, rainfallAt(sampleAt + stepY) - rawRain);
    let distanceToBoundary = abs(rawRain - 0.2 / 3.0) / max(length(gradient), 0.0001);
    if (distanceToBoundary < 1.05) {
      let grid = p / max(vec2f(length(stepX), length(stepY)), vec2f(0.0000001));
      let pattern = smoothstep(vec2f(-0.12), vec2f(0.12), cos(grid * 0.6283185));
      let horizontal = smoothstep(0.35, 0.65, abs(gradient.y) / max(abs(gradient.x) + abs(gradient.y), 0.00001));
      let dash = mix(pattern.y, pattern.x, horizontal);
      let opacity = dash * (1.0 - smoothstep(0.55, 1.05, distanceToBoundary)) * land * edge;
      color = vec3f(1.0) * opacity + color * (1.0 - opacity);
      alpha = opacity + alpha * (1.0 - opacity);
    }
  }
  return vec4f(color, alpha) * (fx.layers.z * kept);
}
`;

/** Inverse of a column-major 4 × 4 matrix (float64, into `out`: no allocation), or null. */
export function invert(m, out = new Float64Array(16)) {
  const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3], a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7],
    a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11], a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];
  const b00 = a00 * a11 - a01 * a10,
    b01 = a00 * a12 - a02 * a10,
    b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11,
    b04 = a01 * a13 - a03 * a11,
    b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30,
    b07 = a20 * a32 - a22 * a30,
    b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31,
    b10 = a21 * a33 - a23 * a31,
    b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return null;
  const d = 1 / det;
  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * d;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * d;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * d;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * d;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * d;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * d;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * d;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * d;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * d;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * d;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * d;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * d;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * d;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * d;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * d;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * d;
  return out;
}

/** The former noise texture: 128 × 128 bytes of one LCG, and its mip chain (2 × 2 means, as generateMipmap). */
export function noiseLevels() {
  const noise = new Uint8Array(NOISE * NOISE);
  let seed = 71647;
  for (let i = 0; i < noise.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    noise[i] = seed >>> 24;
  }
  const levels = [{ size: NOISE, data: noise }];
  while (levels.at(-1).size > 1) {
    const { size, data } = levels.at(-1),
      half = size / 2,
      next = new Uint8Array(half * half);
    for (let y = 0; y < half; y++)
      for (let x = 0; x < half; x++) {
        const a = 2 * y * size + 2 * x;
        next[y * half + x] = Math.round(
          (data[a] + data[a + 1] + data[a + size] + data[a + size + 1]) / 4,
        );
      }
    levels.push({ size: half, data: next });
  }
  return levels;
}

/** The field level blend of a zoom (zoom - 5 over four levels, smoothstep): {level, blend}. */
export function levelAt(zoom, levels = 4) {
  const detail = Math.max(0, Math.min(levels - 1, zoom - 5));
  const level = Math.floor(detail);
  const fraction = detail - level;
  return { level, blend: fraction * fraction * (3 - 2 * fraction) };
}

const rgba = (bytes, single) => {
  if (!single) return bytes;
  const out = new Uint8Array(bytes.length * 4);
  for (let i = 0; i < bytes.length; i++) {
    out[i * 4] = bytes[i];
    out[i * 4 + 3] = 255;
  }
  return out;
};

export class WeatherEffects {
  init(device, { format, depthFormat = "depth24plus" } = {}) {
    this.device = device;
    this.uniform = device.createBuffer({
      label: "weather effects",
      size: 16 * 4 + 7 * 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.data = new Float32Array(44);
    this.inverse = new Float64Array(16);
    this.zoneMask = new ZoneMask(device);
    this.linear = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
    this.repeat = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "linear",
      addressModeU: "repeat",
      addressModeV: "repeat",
    });
    const module = device.createShaderModule({ label: "weather effects", code: SHADER });
    this.pipeline = device.createRenderPipeline({
      label: "weather effects: clouds and rain",
      layout: "auto",
      vertex: { module, entryPoint: "fullscreen" },
      fragment: {
        module,
        entryPoint: "draw",
        targets: [
          {
            format,
            blend: {
              color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
              alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
            },
          },
        ],
      },
      depthStencil: depthFormat
        ? { format: depthFormat, depthWriteEnabled: false, depthCompare: "always" }
        : undefined,
    });
    const levels = noiseLevels();
    this.noise = device.createTexture({
      label: "weather noise",
      size: [NOISE, NOISE],
      mipLevelCount: levels.length,
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    levels.forEach(({ size, data }, mipLevel) =>
      device.queue.writeTexture(
        { texture: this.noise, mipLevel },
        rgba(data, true),
        { bytesPerRow: size * 4 },
        [size, size],
      ),
    );
    this.atmosphere = null;
    this.state = { hour: 0, zoom: 5, layers: {}, cloudTravel: 0, zoneFade: 0 };
    this.seconds = 0;
    return this;
  }

  texture(size, label) {
    return this.device.createTexture({
      label,
      size: [size, size],
      format: "rgba8unorm",
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }

  /** The run's grids (atmosphere.js createAtmosphere) and the land polygon (GeoJSON). */
  setAtmosphere(atmosphere, polygon) {
    this.destroyTextures();
    this.atmosphere = atmosphere;
    if (!atmosphere) return;
    const { device } = this;
    const sizes = atmosphere.tilesAt(0).map((t) => t.size);
    this.fields = [0, 1].map((k) =>
      sizes.map((size) => this.texture(size, `weather field ${k} ${size}`)),
    );
    const wind = atmosphere.advection.size;
    this.wind = [0, 1].map(() => this.texture(wind, "weather wind offsets"));
    this.east = [0, 1].map(() => this.texture(wind, "weather east wind"));
    this.uploaded = { hour: -1 };
    // the land mask: the polygon over the grid's rectangle, 2048 texels a side
    const mask = (this.mask = this.texture(2048, "weather land"));
    const canvas =
      globalThis.OffscreenCanvas && polygon && landCanvas(polygon, atmosphere.bounds, 2048);
    if (canvas)
      device.queue.copyExternalImageToTexture({ source: canvas }, { texture: mask }, [2048, 2048]);
    else
      device.queue.writeTexture(
        { texture: mask },
        new Uint8Array(2048 * 2048 * 4).fill(255),
        { bytesPerRow: 2048 * 4 },
        [2048, 2048],
      );
    this.groups = new Map();
  }

  /**
   * {hour (fraction blended), zoom, layers: {rain, clouds, opacity}, cloudTravel (s of playback, no wind),
   * zoneFade (0..1: how much of the effects the camera's contour takes off)}.
   */
  setState(state) {
    Object.assign(this.state, state);
  }

  /** Seconds of animation since the last frame (the drops fall, the clouds deform). */
  advance(seconds) {
    this.seconds += seconds;
  }

  upload(hour) {
    const { device, atmosphere } = this;
    const start = Math.floor(hour),
      next = Math.min(start + 1, atmosphere.hours - 1);
    if (this.uploaded.hour === start) return;
    [start, next].forEach((h, k) => {
      atmosphere
        .tilesAt(h)
        .forEach(({ size, data }, i) =>
          device.queue.writeTexture(
            { texture: this.fields[k][i] },
            data,
            { bytesPerRow: size * 4 },
            [size, size],
          ),
        );
      const { size } = atmosphere.advection;
      device.queue.writeTexture(
        { texture: this.wind[k] },
        atmosphere.advection.frame(h),
        { bytesPerRow: size * 4 },
        [size, size],
      );
      device.queue.writeTexture(
        { texture: this.east[k] },
        atmosphere.advection.eastward(h),
        { bytesPerRow: size * 4 },
        [size, size],
      );
    });
    this.uploaded.hour = start;
  }

  bindGroup(level) {
    const fine = Math.min(level + 1, this.fields[0].length - 1);
    const key = `${level}/${fine}`;
    if (!this.groups.has(key)) {
      const views = [
        this.fields[0][level],
        this.fields[0][fine],
        this.fields[1][level],
        this.fields[1][fine],
        this.mask,
        this.noise,
        this.wind[0],
        this.wind[1],
        this.east[0],
        this.east[1],
        this.zoneMask.texture,
      ];
      this.groups.set(
        key,
        this.device.createBindGroup({
          layout: this.pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: this.uniform } },
            { binding: 1, resource: this.linear },
            { binding: 2, resource: this.repeat },
            ...views.map((t, i) => ({ binding: 3 + i, resource: t.createView() })),
          ],
        }),
      );
    }
    return this.groups.get(key);
  }

  /** Draws the clouds and the rain into `pass` (a render pass of the frame). */
  encode(pass, camera) {
    const { atmosphere, state } = this;
    if (!atmosphere) return false;
    const inverse = invert(camera.matrix, this.inverse);
    if (!inverse) return false;
    const hour = Math.max(0, Math.min(atmosphere.hours - 1, state.hour));
    this.upload(hour);
    const fade = state.zoneFade > 0 ? Math.min(1, state.zoneFade) : 0;
    // the contour's mask, once per contour (the bind groups hold it)
    if (fade > 0 && this.zoneMask.set(camera.zone ?? null)) this.groups = new Map();
    const { level, blend } = levelAt(state.zoom, this.fields[0].length);
    const d = this.data,
      t = camera.toMercator,
      layers = state.layers ?? {};
    d.set(inverse, 0);
    d[16] = t ? t[0] : 0;
    d[17] = t ? t[1] : 0;
    d[18] = t ? t[2] : 1;
    d[19] = t ? t[3] : 1;
    d[20] = atmosphere.northwest.x;
    d[21] = atmosphere.northwest.y;
    d[22] = atmosphere.southeast.x;
    d[23] = atmosphere.southeast.y;
    d[24] = blend;
    d[25] = hour - Math.floor(hour);
    d[26] = state.zoom - 5;
    d[27] = this.seconds;
    d[28] = state.cloudTravel ?? 0;
    d[29] = hour;
    d[30] = 0;
    d[31] = atmosphere.advection.range;
    d[32] = layers.rain === false ? 0 : 1;
    d[33] = layers.clouds === false ? 0 : 1;
    d[34] = layers.opacity ?? 1;
    d[35] = camera.ground ?? 0;
    const width = camera.viewport?.[0] ?? 1,
      height = camera.viewport?.[1] ?? 1;
    // the former layer's pixels: the view within ATMOSPHERE_PIXELS (renderBudget.js), CSS pixels
    const ratio = camera.pixelRatio ?? 1;
    const scale = boundedRenderScale(width / ratio, height / ratio, ATMOSPHERE_PIXELS) / ratio;
    d[36] = width;
    d[37] = height;
    d[38] = Math.max(0, -Math.log2(scale));
    d[39] = fade > 0 && camera.zone ? fade : 0;
    this.zoneMask.place(d[39] > 0 ? t : null, d, 40);
    this.device.queue.writeBuffer(this.uniform, 0, d);
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup(level));
    pass.draw(3);
    return true;
  }

  destroyTextures() {
    for (const t of [
      ...(this.fields?.flat() ?? []),
      ...(this.wind ?? []),
      ...(this.east ?? []),
      this.mask,
    ])
      t?.destroy();
    this.fields = this.wind = this.east = this.mask = null;
    this.groups = new Map();
  }

  destroy() {
    this.destroyTextures();
    this.zoneMask?.destroy();
    this.noise?.destroy();
    this.uniform?.destroy();
  }
}
