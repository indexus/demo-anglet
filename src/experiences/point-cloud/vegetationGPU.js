// WebGPU drawing of a VegetationTree selection, in the scene renderer
// (rendering/gpu): lit splats. Cells read their fixed part from the CellStore, a
// storage buffer indexed by slot (written once per cell, dirty rows only);
// a walk uploads 16 bytes per drawn cell. Returns: each voxel's returns are
// uploaded once into the blocks the ReturnStore gave it (the arena); a walk
// uploads 16 bytes per drawn block (where it is, where it goes, its fade and
// scale) and a compute pass at the start of the next frame lays the drawn
// returns out one after the other, fade and scale in place, the bytes the
// walk used to upload whole (RETURN_BYTES per return): the discs draw them
// as before.
import { DEPTH_FORMAT } from "../../rendering/gpu/engine.js";
import { BLOCK_RETURNS, INSTANCE_FLOATS, RETURN_BYTES, SLOT_FLOATS, SLOTS_PER_ROW } from "./vegetationTree.js";

const WORDS = RETURN_BYTES / 4,
  BLOCK_BYTES = BLOCK_RETURNS * RETURN_BYTES,
  ENTRY_WORDS = 4, // a drawn block: arena return, drawn return, count | scale << 8, lo | hi << 16
  GROUPS = 65535; // workgroups per dispatch row
const GATHER = /* wgsl */ `
struct Entry { src: u32, dst: u32, info: u32, fade: u32 }
@group(0) @binding(0) var<storage, read> entries: array<Entry>;
@group(0) @binding(1) var<storage, read> arena: array<u32>;
@group(0) @binding(2) var<storage, read_write> drawn: array<u32>;
@group(0) @binding(3) var<uniform> count: vec4u; // entries, workgroups per row
@compute @workgroup_size(${BLOCK_RETURNS}) fn gather(@builtin(workgroup_id) w: vec3u, @builtin(local_invocation_index) i: u32) {
  let e = w.x + w.y * count.y;
  if (e >= count.x) { return; }
  let entry = entries[e];
  if (i >= (entry.info & 0xffu)) { return; }
  let s = (entry.src + i) * ${WORDS}u;
  let d = (entry.dst + i) * ${WORDS}u;
  drawn[d] = arena[s];
  drawn[d + 1u] = arena[s + 1u];
  drawn[d + 2u] = arena[s + 2u];
  drawn[d + 3u] = (arena[s + 3u] & 0x00ffffffu) | ((entry.info >> 8u) << 24u); // rgb, scale
  drawn[d + 4u] = entry.fade; // lo, hi
  drawn[d + 5u] = arena[s + 5u]; // normal
}`;

const CROWNS = 16, // most crowns drawn for one cell (?veg=crowns)
  CROWN_PX = 0.9, // crowns: a crown of a radius under CROWN_PX least sizes is soft (byCrowns, crownShare)
  SOFT_FROM = 64; // m: crowns, cells of this side and more drawn soft only (view.limits.x, .y)
/** m from the eye: foliage drawn not at all within NEAR[0], all of it from NEAR[1] (thinned between). */
export const NEAR = [1.5, 6];
const APPEAR = "0.6"; // s: a cell drawn with nothing above it fades in (VegetationTree appear)
const WGSL = /* wgsl */ `
// limits: cells drawn soft from a side of x (m), as volumes below y
// lod: tau (px), band, focal (px of 1 m at 1 m), 1 when the fades are per pixel (?vegFade=pixel)
struct View { matrix: mat4x4f, eye: vec4f, sun: vec4f, viewport: vec2f, minPixels: f32, radius: f32, limits: vec4f, lod: vec4f, scene: vec4f }
@group(0) @binding(0) var<uniform> view: View;
@group(0) @binding(1) var<storage, read> store: array<f32>;
// the same per-pixel hash as the WebGL splats, on bottom-up pixel rows
fn hash(q: vec2f, s: f32) -> f32 {
  let p = vec2u(vec2f(q.x, view.viewport.y - q.y)) + vec2u(u32(s) * 7919u, u32(s) * 104729u);
  var h = (p.x * 2654435761u) ^ (p.y * 2246822519u);
  h = (h ^ (h >> 15u)) * 2246822519u;
  h ^= h >> 13u;
  return f32(h & 0xffffffu) / 16777216.0;
}
// orthophoto crowns are dark and blue-grey: keep the hue, lift into a foliage range
fn foliage(c0: vec3f) -> vec3f {
  var c = pow(max(c0, vec3f(0.0)), vec3f(0.8));
  var l = dot(c, vec3f(0.299, 0.587, 0.114));
  c *= clamp(l, 0.24, 0.5) / max(l, 0.02);
  c = mix(c, vec3f(0.30, 0.42, 0.17) * (0.6 + l), 0.3);
  l = dot(c, vec3f(0.299, 0.587, 0.114));
  return clamp(mix(vec3f(l), c, 1.25), vec3f(0.0), vec3f(1.0));
}
fn light(n: vec3f) -> f32 { return 0.45 + 0.6 * max(dot(n, view.sun.xyz), 0.0); }
// pixels per metre at p along the unit direction d
fn pixels(p: vec3f, d: vec3f) -> f32 {
  let a = view.matrix * vec4f(p, 1.0);
  let b = view.matrix * vec4f(p + d, 1.0);
  return length((b.xy / b.w - a.xy / a.w) * view.viewport * 0.5);
}
fn corner(i: u32) -> vec2f { return vec2f(f32(i & 1u) * 2.0 - 1.0, f32(i >> 1u) * 2.0 - 1.0); }
// Fades per pixel (lod.w = 1): a cell's share is worked out where it is drawn, from the
// size on screen its side has there, not once per cell: neighbours at the same distance
// fade alike, there are no rows of cells at different stages (the lattice seen from afar).
// Only one level fades at a pixel (band < 4): a cell draws [t(side) t(parent), t(parent)),
// t(parent) = 1 unless its parent is drawn (flags & 2), t(side) = 0 unless its children
// are (flags & 1).
fn fadeAt(side: f32, p: vec3f) -> f32 {
  let px = side * view.lod.z / max(distance(p, view.eye.xyz), 0.5);
  return smoothstep(0.0, 1.0, (px - view.lod.x) / (view.lod.x * (view.lod.y - 1.0)));
}
// a cell drawn with nothing above it fades in over APPEAR s from its birth (limits.w: now, s)
fn appearing(birth: f32) -> f32 {
  return clamp((view.limits.w - birth) / ${APPEAR}, 0.0, 1.0);
}
fn shareAt(flags: u32, side: f32, p: vec3f) -> vec2f {
  let up = select(1.0, fadeAt(side * 4.0, p), (flags & 2u) != 0u);
  let down = select(0.0, fadeAt(side, p), (flags & 1u) != 0u);
  return vec2f(down * up, up);
}

struct Cell {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec3f,
  @location(2) @interpolate(flat) x: vec3f,
  @location(3) @interpolate(flat) y: vec3f,
  @location(4) @interpolate(flat) z: vec3f,
  @location(5) @interpolate(flat) plane: vec3f,
  @location(6) @interpolate(flat) fade: vec3f,
  @location(7) @interpolate(flat) bent: vec3f,
  @location(8) @interpolate(flat) seed: f32,
  @location(9) world: vec3f,
  @location(10) @interpolate(flat) lod: vec3f, // flags, side (m), birth (s)
}
@vertex fn cell(@builtin(vertex_index) vi: u32, @location(0) inst: vec4f) -> Cell {
  var o: Cell;
  let k = u32(inst.x + 0.5) * ${SLOT_FLOATS}u;
  let centre = vec3f(store[k], store[k + 1u], store[k + 2u]);
  let a0 = vec3f(store[k + 3u], store[k + 4u], store[k + 5u]) * inst.w;
  let a1 = vec3f(store[k + 6u], store[k + 7u], store[k + 8u]) * inst.w;
  let a2 = vec3f(store[k + 9u], store[k + 10u], store[k + 11u]) * inst.w;
  let color = vec3f(store[k + 12u], store[k + 13u], store[k + 14u]);
  let alpha = store[k + 15u];
  let bent = vec3f(store[k + 16u], store[k + 17u], store[k + 18u]);
  let c = corner(vi);
  let v = normalize(centre - view.eye.xyz);
  let right = normalize(cross(v, vec3f(0.0, 0.0, 1.0)));
  let up = cross(right, v);
  // ellipse of the ellipsoid seen along the view: covariance of its axes in (right, up)
  let px = vec3f(dot(a0, right), dot(a1, right), dot(a2, right));
  let py = vec3f(dot(a0, up), dot(a1, up), dot(a2, up));
  var xx = dot(px, px);
  var yy = dot(py, py);
  let xy = dot(px, py);
  // additive: widened by eye.w x its side (the Gaussians of a level overlap into one field,
  // not a lattice of blobs), its opacity lowered by as much (the same mass)
  let det0 = max(xx * yy - xy * xy, 1e-6);
  let widen = view.eye.w * store[k + 19u] * 2.1;
  xx += widen * widen;
  yy += widen * widen;
  let thinned = sqrt(det0 / max(xx * yy - xy * xy, 1e-6));
  let m = 0.5 * (xx + yy);
  let d = sqrt(max(m * m - (xx * yy - xy * xy), 0.0));
  var e = select(vec2f(0.0, 1.0), vec2f(1.0, 0.0), xx >= yy);
  if (abs(xy) > 1e-6) { e = normalize(vec2f(xy, m + d - xx)); }
  let least = view.minPixels / max(pixels(centre, right), 1e-6);
  // 1.05: makes up for the ragged edge of the fragment shader
  let r = max(sqrt(vec2f(m + d, max(m - d, 0.0))) * 1.05, vec2f(least));
  o.x = right * e.x + up * e.y;
  o.y = up * e.x - right * e.y;
  o.z = -v;
  // drawn half-way to the front of the ellipsoid, so a crown hides what stands behind its middle
  let depth = length(vec3f(dot(a0, v), dot(a1, v), dot(a2, v)));
  o.world = centre - v * depth * 0.5 + o.x * c.x * r.x + o.y * c.y * r.y;
  o.position = view.matrix * vec4f(o.world, 1.0);
  o.lod = vec3f(inst.y, store[k + 19u], inst.z);
  // flat cells (grass, hedge tops, crown skins) shade as their plane
  let l0 = dot(a0, a0);
  let l1 = dot(a1, a1);
  let l2 = dot(a2, a2);
  var thin = select(select(a2, a1, l1 < l2), a0, l0 < l1 && l0 < l2);
  let least2 = min(l0, min(l1, l2));
  let middle = max(min(l0, l1), min(max(l0, l1), l2));
  thin = normalize(thin);
  thin *= sign(dot(thin, vec3f(0.0, 0.0, 1.0)) + 1e-4);
  o.plane = thin * clamp(1.0 - sqrt(least2 / middle), 0.0, 1.0) * 0.8;
  o.uv = c;
  o.color = foliage(color);
  o.fade = vec3f(alpha * thinned, inst.y, inst.z);
  // crowns: a cell is soft from limits.x (m), or where its crowns would be under limits.z px (volume() draws the rest)
  let side = store[k + 19u];
  if (side < view.limits.x) {
    let soft = 1.0 - crownShare(crownPixels(side, centre, right, length(a0)));
    o.fade.x *= soft;
    if (soft <= 0.0) { o.position = vec4f(2.0, 2.0, 2.0, 1.0); }
  }
  o.bent = normalize(mix(vec3f(0.0, 0.0, 1.0), bent, view.sun.w));
  o.seed = inst.x;
  return o;
}
fn cellShare(i: Cell) -> vec2f {
  if (view.lod.w > 0.0) {
    let share = shareAt(u32(i.lod.x + 0.5), i.lod.y, i.world);
    return vec2f(share.x, share.x + (share.y - share.x) * appearing(i.lod.z));
  }
  return i.fade.yz;
}
// the scene's presence (SceneFrame.sceneOpacity, its fade in or out at SCENE_ZOOM): pixels left out
fn absent(q: vec2f) -> bool { return view.scene.x < 1.0 && hash(q, 8191.0) >= view.scene.x; }
// foliage a few metres from the eye thins out (the camera down to a walker's eye, cameraFloor.js):
// none within NEAR.x, all of it from NEAR.y; a 2 m cell or a return there would fill the screen
fn tooNear(q: vec2f, world: vec3f) -> bool {
  let d = distance(world, view.eye.xyz);
  return d < ${NEAR[1].toFixed(1)} && hash(q, 4093.0) >= smoothstep(${NEAR[0].toFixed(1)}, ${NEAR[1].toFixed(1)}, d);
}
@fragment fn cellColor(i: Cell) -> @location(0) vec4f {
  if (absent(i.position.xy) || tooNear(i.position.xy, i.world)) { discard; }
  let r2 = dot(i.uv, i.uv);
  let h = hash(i.position.xy, 0.0);
  let share = cellShare(i);
  if (h < share.x || h >= share.y) { discard; }
  // ragged edge, and holes where the cell holds few returns
  let own = hash(i.position.xy, i.seed + 1.0);
  if (r2 > 1.0 - 0.5 * own || fract(own * 7.31) > i.fade.x) { discard; }
  var n = normalize(mix(i.uv.x * i.x + i.uv.y * i.y + sqrt(max(1.0 - r2, 0.0)) * i.z, i.bent, 0.8));
  let flatness = length(i.plane);
  if (flatness > 0.01) { n = normalize(mix(n, i.plane / flatness, flatness)); }
  return vec4f(i.color * light(n), 1.0);
}

struct Disc {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec3f,
  @location(2) @interpolate(flat) x: vec3f,
  @location(3) @interpolate(flat) y: vec3f,
  @location(4) @interpolate(flat) z: vec3f,
  @location(5) @interpolate(flat) bent: vec3f,
  @location(6) @interpolate(flat) fade: vec2f,
  @location(7) @interpolate(flat) world: vec3f,
}
// rgb.a: scale (its crown fading out: the disc grows in)
@vertex fn disc(@builtin(vertex_index) vi: u32, @location(0) pos: vec3f, @location(1) rgb: vec4f,
                @location(2) fade: vec2f, @location(3) bent: vec4f) -> Disc {
  return discAt(vi, pos, rgb, fade, bent);
}
fn discAt(vi: u32, pos: vec3f, rgb: vec4f, fade: vec2f, bent: vec4f) -> Disc {
  var o: Disc;
  if ((fade.y <= fade.x && view.lod.w == 0.0) || rgb.a <= 0.0) { o.position = vec4f(2.0, 2.0, 2.0, 1.0); return o; }
  let c = corner(vi);
  let v = normalize(pos - view.eye.xyz);
  o.x = normalize(cross(v, vec3f(0.0, 0.0, 1.0)));
  o.y = cross(o.x, v);
  o.z = -v;
  let r = max(view.radius, view.minPixels / max(pixels(pos, o.x), 1e-6)) * rgb.a;
  o.position = view.matrix * vec4f(pos + (o.x * c.x + o.y * c.y) * r, 1.0);
  o.uv = c;
  o.color = foliage(rgb.rgb);
  o.fade = fade;
  o.world = pos;
  // per pixel: the returns take [0, t(voxel)) where their voxel is still drawn (lo > 0), all of it else
  if (view.lod.w > 0.0) { o.fade = vec2f(0.0, select(1.0, fadeAt(2.0, pos), fade.x > 0.0)); }
  o.bent = normalize(mix(vec3f(0.0, 0.0, 1.0), bent.xyz, view.sun.w));
  return o;
}
@fragment fn discColor(i: Disc) -> @location(0) vec4f {
  if (absent(i.position.xy) || tooNear(i.position.xy, i.world)) { discard; }
  let r2 = dot(i.uv, i.uv);
  if (r2 > 1.0) { discard; }
  let h = hash(i.position.xy, 0.0);
  if (h < i.fade.x || h >= i.fade.y) { discard; }
  // a small sphere, bent toward the way out of its 2 m voxel
  let n = normalize(mix(i.uv.x * i.x + i.uv.y * i.y + sqrt(1.0 - r2) * i.z, i.bent, 0.8));
  return vec4f(i.color * light(n), 1.0);
}

// ---- additive (?veg=additive): no dither. A cell is a soft Gaussian, alpha-blended
// (premultiplied, depth read, not written): its weight is the share the walk gave it
// (hi - lo of its fade interval), its opacity its coverage. A parent and its
// children add up over the fade instead of owning complementary pixels.
@fragment fn cellSoft(i: Cell) -> @location(0) vec4f {
  let r2 = dot(i.uv, i.uv);
  if (r2 > 1.0) { discard; }
  let share = cellShare(i);
  let w = share.y - share.x;
  // mean of exp(-2.2 r2) over the disc is 0.4: the disc's mean opacity is its coverage
  let a = w * min(1.0, i.fade.x / 0.4 * (exp(-2.2 * r2) - 0.11) / 0.89);
  if (a < 1.0 / 255.0) { discard; }
  var n = normalize(mix(i.uv.x * i.x + i.uv.y * i.y + sqrt(max(1.0 - r2, 0.0)) * i.z, i.bent, 0.8));
  let flatness = length(i.plane);
  if (flatness > 0.01) { n = normalize(mix(n, i.plane / flatness, flatness)); }
  return vec4f(i.color * light(n) * a, a);
}
// returns of a voxel fading in: they grow with their share (no dither), opaque
@vertex fn discGrow(@builtin(vertex_index) vi: u32, @location(0) pos: vec3f, @location(1) rgb: vec4f,
                    @location(2) fade: vec2f, @location(3) bent: vec4f) -> Disc {
  var w = fade.y - fade.x;
  if (view.lod.w > 0.0) { w = select(1.0, fadeAt(2.0, pos), fade.x > 0.0); }
  var o = discAt(vi, pos, vec4f(rgb.rgb, rgb.a * sqrt(max(w, 0.0))), vec2f(0.0, 1.0), bent);
  o.fade = vec2f(0.0, 1.0);
  if (w <= 1.0 / 255.0) { o.position = vec4f(2.0, 2.0, 2.0, 1.0); }
  return o;
}

// ---- volumes (?veg=crowns): a cell is an opaque ellipsoid, ray-traced in its billboard
// (true silhouette, normal and depth), its axes shrunk to its coverage (a cell covering
// a third of its ellipse is an ellipsoid of a third of the area); a parent and its
// children trade size over the fade (the parent shrinks as they grow), no dither.
struct Volume {
  @builtin(position) position: vec4f,
  @location(0) world: vec3f,
  @location(1) color: vec3f,
  @location(2) @interpolate(flat) centre: vec3f,
  @location(3) @interpolate(flat) a0: vec3f,
  @location(4) @interpolate(flat) a1: vec3f,
  @location(5) @interpolate(flat) a2: vec3f,
}
// the size on screen of a cell's crowns (its own ellipsoid for a 2 m cell): crowns smaller
// than limits.z px are not drawn as volumes but soft (sub-pixel: coverage, not dots)
fn crownPixels(side: f32, centre: vec3f, right: vec3f, own: f32) -> f32 {
  let crown = select(select(own, 2.5, side > 4.0), 3.5, side > 16.0);
  return crown * pixels(centre, right);
}
// the share drawn as volumes (crowns), the rest soft: 0 under 0.7 limits.z px, 1 from 1.4 limits.z
fn crownShare(px: f32) -> f32 {
  if (view.limits.z <= 0.0) { return 0.0; }
  return smoothstep(0.7 * view.limits.z, 1.4 * view.limits.z, px);
}
// a coarse cell is drawn as up to CROWNS ellipsoids sampled from its Gaussian (a hash of
// its slot: the same every frame), each of the size of a crown, as many as its covered
// area holds: the same coverage, the same mean and spread, no lattice of one blob per cell
fn rand(a: u32, b: u32) -> f32 {
  var h = (a * 2654435761u) ^ (b * 2246822519u + 374761393u);
  h = (h ^ (h >> 15u)) * 2246822519u;
  h ^= h >> 13u;
  return (f32(h & 0xffffffu) + 0.5) / 16777216.0;
}
@vertex fn volume(@builtin(vertex_index) index: u32, @location(0) inst: vec4f) -> Volume {
  var o: Volume;
  let slot = u32(inst.x + 0.5);
  let k = slot * ${SLOT_FLOATS}u;
  let sub = index / 6u;
  let corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
  let c = corners[index % 6u];
  let alpha = store[k + 15u];
  let size = store[k + 19u];
  var w = inst.z - inst.y;
  var centre = vec3f(store[k], store[k + 1u], store[k + 2u]);
  var a0 = vec3f(store[k + 3u], store[k + 4u], store[k + 5u]) * inst.w;
  var a1 = vec3f(store[k + 6u], store[k + 7u], store[k + 8u]) * inst.w;
  var a2 = vec3f(store[k + 9u], store[k + 10u], store[k + 11u]) * inst.w;
  // the crowns this cell holds: its covered area over a crown's (radius 2.5 m at 8 m, 3.5 m above)
  let l0 = length(a0);
  let l1 = length(a1);
  let l2 = length(a2);
  let big = max(l0, max(l1, l2));
  let small = min(l0, min(l1, l2));
  let area = 3.14159 * big * (l0 + l1 + l2 - big - small) * clamp(alpha, 0.05, 1.0);
  let crown = select(2.5, 3.5, size > 16.0);
  let count = select(1u, u32(clamp(floor(area / (3.14159 * crown * crown) + 0.5), 1.0, ${CROWNS}.0)), size > 4.0);
  let rightOf = normalize(cross(normalize(centre - view.eye.xyz), vec3f(0.0, 0.0, 1.0)));
  let volumeShare = crownShare(crownPixels(size, centre, rightOf, l0));
  if (sub >= count || size >= view.limits.y || volumeShare <= 0.0) { o.position = vec4f(2.0, 2.0, 2.0, 1.0); return o; }
  if (count > 1u) {
    // a point of the Gaussian (Box-Muller, cut at 1.8 sigma), a crown around it
    let u1 = rand(slot, sub * 3u + 1u);
    let u2 = rand(slot, sub * 3u + 2u);
    let u3 = rand(slot, sub * 3u + 3u);
    let rr = sqrt(-2.0 * log(u1));
    let g = clamp(vec3f(rr * cos(6.28318 * u2), rr * sin(6.28318 * u2), sqrt(-2.0 * log(u3)) * cos(6.28318 * u1)), vec3f(-1.8), vec3f(1.8)) / 2.1;
    centre += a0 * g.x + a1 * g.y + a2 * g.z * 0.6;
    let r = crown * (0.75 + 0.5 * rand(slot, sub * 3u + 7u));
    a0 = vec3f(r, 0.0, 0.0);
    a1 = vec3f(0.0, r, 0.0);
    a2 = vec3f(0.0, 0.0, r * 0.8);
  }
  // per pixel: the share at the crown's own centre (crowns of neighbouring cells fade alike)
  if (view.lod.w > 0.0) {
    let share = shareAt(u32(inst.y + 0.5), size, centre);
    w = (share.y - share.x) * appearing(inst.z);
  }
  if (w <= 1.0 / 255.0) { o.position = vec4f(2.0, 2.0, 2.0, 1.0); return o; }
  // the fade as a share of volume (cube root), and the share left to the soft cells
  var s = pow(w * volumeShare, 0.3333);
  // one crown: the cell's own ellipsoid, its area shrunk to its coverage
  if (count == 1u) { s *= sqrt(clamp(alpha, 0.2, 1.0)); }
  a0 *= s;
  a1 *= s;
  a2 *= s;
  // never thinner than a third of its widest axis: a flat cell is a cushion, not a sheet
  let widest = max(length(a0), max(length(a1), length(a2)));
  a0 = a0 / max(length(a0), 1e-4) * max(length(a0), widest * 0.33);
  a1 = a1 / max(length(a1), 1e-4) * max(length(a1), widest * 0.33);
  a2 = a2 / max(length(a2), 1e-4) * max(length(a2), widest * 0.33);
  let v = normalize(centre - view.eye.xyz);
  let right = normalize(cross(v, vec3f(0.0, 0.0, 1.0)));
  let up = cross(right, v);
  // bounding square of the ellipsoid seen along v (its extents on right and up), a little more for perspective
  let ex = sqrt(dot(a0, right) * dot(a0, right) + dot(a1, right) * dot(a1, right) + dot(a2, right) * dot(a2, right));
  let ey = sqrt(dot(a0, up) * dot(a0, up) + dot(a1, up) * dot(a1, up) + dot(a2, up) * dot(a2, up));
  let least = view.minPixels / max(pixels(centre, right), 1e-6);
  // tiny on screen: a sphere of the least size
  let grow = max(least / max(max(ex, ey), 1e-4), 1.0);
  a0 *= grow;
  a1 *= grow;
  a2 *= grow;
  let r = vec2f(ex, ey) * grow * 1.15;
  let ez = sqrt(dot(a0, v) * dot(a0, v) + dot(a1, v) * dot(a1, v) + dot(a2, v) * dot(a2, v));
  o.world = centre - v * ez + right * c.x * r.x + up * c.y * r.y;
  o.position = view.matrix * vec4f(o.world, 1.0);
  o.centre = centre;
  o.a0 = a0;
  o.a1 = a1;
  o.a2 = a2;
  o.color = foliage(vec3f(store[k + 12u], store[k + 13u], store[k + 14u]) * (0.85 + 0.3 * rand(slot, sub + 99u)));
  return o;
}
struct VolumeOut { @location(0) color: vec4f, @builtin(frag_depth) depth: f32 }
@fragment fn volumeColor(i: Volume) -> VolumeOut {
  // the ray from the eye through this point of the billboard, in the ellipsoid's frame (unit sphere)
  let l0 = dot(i.a0, i.a0);
  let l1 = dot(i.a1, i.a1);
  let l2 = dot(i.a2, i.a2);
  let o = view.eye.xyz - i.centre;
  let d = normalize(i.world - view.eye.xyz);
  let ol = vec3f(dot(o, i.a0) / l0, dot(o, i.a1) / l1, dot(o, i.a2) / l2);
  let dl = vec3f(dot(d, i.a0) / l0, dot(d, i.a1) / l1, dot(d, i.a2) / l2);
  let A = dot(dl, dl);
  let B = dot(ol, dl);
  let C = dot(ol, ol) - 1.0;
  let disc = B * B - A * C;
  if (disc < 0.0) { discard; }
  let t = (-B - sqrt(disc)) / A;
  let hit = view.eye.xyz + d * t;
  let p = vec3f(dot(hit - i.centre, i.a0) / l0, dot(hit - i.centre, i.a1) / l1, dot(hit - i.centre, i.a2) / l2);
  let n = normalize(i.a0 * p.x / l0 + i.a1 * p.y / l1 + i.a2 * p.z / l2);
  // lit as a volume: the sun, and darker toward its foot (self-shadow of a crown)
  let height = max(sqrt(i.a0.z * i.a0.z + i.a1.z * i.a1.z + i.a2.z * i.a2.z), 0.3);
  let foot = 0.72 + 0.28 * clamp((hit.z - i.centre.z) / height * 0.5 + 0.5, 0.0, 1.0);
  var out: VolumeOut;
  out.color = vec4f(i.color * light(normalize(mix(n, vec3f(0.0, 0.0, 1.0), 0.25))) * foot, 1.0);
  let clip = view.matrix * vec4f(hit, 1.0);
  out.depth = clip.z / clip.w;
  return out;
}`;

const ROW_BYTES = SLOTS_PER_ROW * SLOT_FLOATS * 4;

export class VegetationGPU {
  /** mode: ?veg; compact (crowns): cells drawn in runs by their crowns (byCrowns), false: 6 CROWNS vertices each */
  constructor(engine, { mode = "dither", compact = true } = {}) {
    this.engine = engine;
    this.mode = mode;
    this.compact = compact;
    const device = (this.device = engine.device),
      module = device.createShaderModule({ code: WGSL });
    this.layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
      ],
    });
    const blend = { color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" }, alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" } };
    const pipeline = (vertex, fragment, buffers, soft = false, topology = "triangle-strip") =>
      device.createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
        vertex: { module, entryPoint: vertex, buffers },
        fragment: { module, entryPoint: fragment, targets: [{ format: engine.format, ...(soft ? { blend } : {}) }] },
        primitive: { topology, cullMode: "none" },
        depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: !soft, depthCompare: "less-equal" },
      });
    const cellBuffers = [
        { arrayStride: INSTANCE_FLOATS * 4, stepMode: "instance", attributes: [{ shaderLocation: 0, offset: 0, format: "float32x4" }] },
      ],
      discBuffers = [
        {
          arrayStride: RETURN_BYTES,
          stepMode: "instance",
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },
            { shaderLocation: 1, offset: 12, format: "unorm8x4" },
            { shaderLocation: 2, offset: 16, format: "unorm16x2" },
            { shaderLocation: 3, offset: 20, format: "snorm8x4" },
          ],
        },
      ];
    // per mode: the cells' pipeline (soft: blended in the drape stage), the returns'
    if (mode === "dither") {
      this.cellPipeline = pipeline("cell", "cellColor", cellBuffers);
      this.discPipeline = pipeline("disc", "discColor", discBuffers);
    } else {
      this.discPipeline = pipeline("discGrow", "discColor", discBuffers);
      if (mode === "crowns") {
        this.cellPipeline = pipeline("volume", "volumeColor", cellBuffers, false, "triangle-list");
        this.cellVertices = 6 * CROWNS;
      }
      this.softPipeline = pipeline("cell", "cellSoft", cellBuffers, true);
    }
    this.viewBuffer = device.createBuffer({ size: 160, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.cells = { buffer: null, capacity: 0, count: 0 };
    this.returns = { buffer: null, capacity: 0, count: 0 }; // the drawn returns, laid out by the gather pass
    this.storeBuffer = null;
    this.storeVersion = -1;
    this.arena = null; // the ReturnStore's blocks
    this.arenaVersion = -1;
    this.entries = { buffer: null, capacity: 0, data: new Uint32Array(ENTRY_WORDS * 1024) };
    this.gatherCount = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.gatherPipeline = device.createComputePipeline({
      layout: "auto",
      compute: { module: device.createShaderModule({ code: GATHER }), entryPoint: "gather" },
    });
    this.uploaded = 0;
  }
  get gpuBytes() {
    return this.cells.capacity + this.returns.capacity + (this.storeBuffer?.size ?? 0) + (this.arena?.size ?? 0) + this.entries.capacity;
  }
  /** Upload a selection ({instances, store, leaves, returnStore} of VegetationTree.select); bytes in this.uploaded. */
  set(selection) {
    const store = this.uploadStore(selection.store),
      instances = this.cellVertices && this.compact ? this.byCrowns(selection.instances, selection.store) : selection.instances;
    this.grow(this.cells, instances.byteLength, GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST);
    if (instances.byteLength) this.device.queue.writeBuffer(this.cells.buffer, 0, instances.buffer, instances.byteOffset, instances.byteLength);
    this.cells.count = instances.length / INSTANCE_FLOATS;
    // what the returns cost this walk: the voxels drawn for the first time, and the drawn blocks' entries
    this.returnBytes = this.uploadReturns(selection.returnStore) + this.gather(selection.leaves);
    this.uploaded = store + instances.byteLength + this.returnBytes;
  }
  /**
   * Fades in time (VegetationTree.refade): the same selection, its fades moved in place: its
   * instances again (16 bytes per drawn cell) and the returns' entries and gather. Bytes in this.refaded.
   */
  refade(selection) {
    const instances = selection.instances;
    if (this.cellVertices && this.compact) return void (this.refaded = 0); // crowns: not faded in time
    if (instances.byteLength && this.cells.buffer && instances.byteLength <= this.cells.capacity)
      this.device.queue.writeBuffer(this.cells.buffer, 0, instances.buffer, instances.byteOffset, instances.byteLength);
    this.refaded = instances.byteLength + this.gather(selection.leaves);
  }
  /**
   * Crowns: the instances in runs by the crowns each cell holds (as volume() counts
   * them): 1 (6 vertices), up to 4 (24), up to CROWNS (6 CROWNS), then the cells only
   * drawn soft (64 m and more: no volume draw). this.runs: [vertices, first, count].
   */
  byCrowns(instances, store) {
    const n = instances.length / INSTANCE_FLOATS,
      d = store.data,
      kinds = new Uint8Array(n),
      counts = [0, 0, 0, 0];
    for (let i = 0; i < n; i++) {
      const o = i * INSTANCE_FLOATS,
        k = instances[o] * SLOT_FLOATS,
        w = instances[o + 3],
        size = d[k + 19];
      let kind = 0;
      // crowns under the soft limit on screen (as crownShare: under 0.7 limits.z px), seen from the last frame's eye: soft only
      const seen = this.seen,
        own = Math.hypot(d[k + 3], d[k + 4], d[k + 5]) * w,
        crownSize = size > 16 ? 3.5 : size > 4 ? 2.5 : own,
        tooSmall = seen && (crownSize * seen.focal) / Math.max(Math.hypot(d[k] - seen.eye[0], d[k + 1] - seen.eye[1], d[k + 2] - seen.eye[2]), 0.5) < 0.6 * seen.limit;
      if (size >= SOFT_FROM || tooSmall) kind = 3;
      else if (size > 4) {
        const l0 = Math.hypot(d[k + 3], d[k + 4], d[k + 5]) * w,
          l1 = Math.hypot(d[k + 6], d[k + 7], d[k + 8]) * w,
          l2 = Math.hypot(d[k + 9], d[k + 10], d[k + 11]) * w,
          big = Math.max(l0, l1, l2),
          small = Math.min(l0, l1, l2),
          crown = size > 16 ? 3.5 : 2.5,
          area = Math.PI * big * (l0 + l1 + l2 - big - small) * Math.min(Math.max(d[k + 15], 0.05), 1),
          count = Math.min(Math.max(Math.round(area / (Math.PI * crown * crown)), 1), CROWNS);
        kind = count <= 1 ? 0 : count <= 4 ? 1 : 2;
      }
      kinds[i] = kind;
      counts[kind]++;
    }
    const out = (this.sorted?.length >= instances.length ? this.sorted : (this.sorted = new Float32Array(instances.length * 1.25))).subarray(0, instances.length),
      at = [0, counts[0], counts[0] + counts[1], counts[0] + counts[1] + counts[2]];
    this.runs = [
      [6, 0, counts[0]],
      [24, at[1], counts[1]],
      [6 * CROWNS, at[2], counts[2]],
    ];
    for (let i = 0; i < n; i++) out.set(instances.subarray(i * INSTANCE_FLOATS, (i + 1) * INSTANCE_FLOATS), at[kinds[i]]++ * INSTANCE_FLOATS);
    return out;
  }
  /** A buffer of at least `bytes` (a quarter more when it grows); true when it was made again. */
  grow(slot, bytes, usage) {
    if (bytes <= slot.capacity && slot.buffer) return false;
    slot.capacity = Math.max(Math.ceil((bytes * 1.25) / 4) * 4, 4);
    slot.buffer?.destroy();
    slot.buffer = this.device.createBuffer({ size: slot.capacity, usage });
    return true;
  }
  /** The voxels drawn for the first time: their returns into their blocks (the arena moves to a larger buffer when the store grew). */
  uploadReturns(store) {
    const device = this.device,
      size = store.capacity * BLOCK_BYTES;
    if (!this.arena || this.arena.size < size) {
      const arena = device.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
      if (this.arena) {
        const encoder = device.createCommandEncoder();
        encoder.copyBufferToBuffer(this.arena, 0, arena, 0, this.arena.size);
        device.queue.submit([encoder.finish()]);
        this.arena.destroy();
      }
      this.arena = arena;
      this.gatherGroup = null;
    }
    let bytes = 0;
    for (const cell of store.uploads) {
      if (!cell.blocks) continue; // forgotten before it was uploaded
      const data = cell.returns;
      for (let k = 0; k < cell.blocks.length; k++) {
        const from = k * BLOCK_BYTES,
          length = Math.min(BLOCK_BYTES, data.length - from);
        device.queue.writeBuffer(this.arena, cell.blocks[k] * BLOCK_BYTES, data.buffer, data.byteOffset + from, length);
        bytes += length;
      }
    }
    store.uploads.length = 0;
    return bytes;
  }
  /** The drawn blocks' entries, and the gather pass that lays their returns out for the discs (next frame's encoder). */
  gather(leaves) {
    let n = 0,
      returns = 0,
      data = this.entries.data;
    for (let i = 0; i < leaves.length; i++) {
      const cell = leaves.cells[i];
      if (!cell.blocks) continue; // trimmed since (a fade's frame after the walk that drew it)
      const count = cell.returns.length / RETURN_BYTES,
        info = leaves.scales[i] << 8,
        fade = leaves.fades[i];
      for (let k = 0; k < cell.blocks.length; k++) {
        if ((n + 1) * ENTRY_WORDS > data.length) {
          const grown = new Uint32Array(data.length * 2);
          grown.set(data);
          this.entries.data = data = grown;
        }
        const o = n++ * ENTRY_WORDS,
          inBlock = Math.min(BLOCK_RETURNS, count - k * BLOCK_RETURNS);
        data[o] = cell.blocks[k] * BLOCK_RETURNS;
        data[o + 1] = returns;
        data[o + 2] = inBlock | info;
        data[o + 3] = fade;
        returns += inBlock;
      }
    }
    this.returns.count = returns;
    this.dispatch = false;
    if (!n) return 0;
    const device = this.device;
    let regroup = !this.gatherGroup;
    regroup = this.grow(this.entries, n * ENTRY_WORDS * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST) || regroup;
    regroup = this.grow(this.returns, returns * RETURN_BYTES, GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX) || regroup;
    if (regroup)
      this.gatherGroup = device.createBindGroup({
        layout: this.gatherPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.entries.buffer } },
          { binding: 1, resource: { buffer: this.arena } },
          { binding: 2, resource: { buffer: this.returns.buffer } },
          { binding: 3, resource: { buffer: this.gatherCount } },
        ],
      });
    const rows = Math.ceil(n / GROUPS),
      perRow = Math.min(n, GROUPS);
    device.queue.writeBuffer(this.entries.buffer, 0, data.buffer, 0, n * ENTRY_WORDS * 4);
    // no allocation here: a frame's work while the fades in time move (refade)
    const count = (this.countData ??= new Uint32Array(4));
    count[0] = n;
    count[1] = perRow;
    device.queue.writeBuffer(this.gatherCount, 0, count);
    this.dispatch = true;
    this.dispatchX = perRow;
    this.dispatchY = rows;
    // one gather in the next frame's encoder, with the last walk's entries and buffers
    if (!this.gatherQueued) {
      this.gatherQueued = true;
      this.engine.prepare(
        (this.encodeGather ??= (encoder) => {
          this.gatherQueued = false;
          // destroyed meanwhile (scene left, layer removed): its buffers must not reach the submit
          if (this.destroyed || !this.dispatch || !this.gatherGroup) return;
          const pass = encoder.beginComputePass();
          pass.setPipeline(this.gatherPipeline);
          pass.setBindGroup(0, this.gatherGroup);
          pass.dispatchWorkgroups(this.dispatchX, this.dispatchY);
          pass.end();
        }),
      );
    }
    return n * ENTRY_WORDS * 4 + 16;
  }
  /** The store: all of it when it grew, else its dirty rows. */
  uploadStore(store) {
    let bytes = 0;
    if (store.version !== this.storeVersion || !this.storeBuffer || this.storeBuffer.size !== store.data.byteLength) {
      this.storeBuffer?.destroy();
      this.storeBuffer = this.device.createBuffer({ size: store.data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      this.device.queue.writeBuffer(this.storeBuffer, 0, store.data);
      this.bindGroup = this.device.createBindGroup({
        layout: this.layout,
        entries: [
          { binding: 0, resource: { buffer: this.viewBuffer } },
          { binding: 1, resource: { buffer: this.storeBuffer } },
        ],
      });
      this.storeVersion = store.version;
      bytes = store.data.byteLength;
    } else
      for (const row of store.dirty) {
        this.device.queue.writeBuffer(this.storeBuffer, row * ROW_BYTES, store.data.buffer, store.data.byteOffset + row * ROW_BYTES, ROW_BYTES);
        bytes += ROW_BYTES;
      }
    store.dirty.clear();
    return bytes;
  }
  /** view: {matrix, eye, sun (w: how much the normals bend away from the parent, 0.6), viewport: [w, h], minPixels?, radius?} */
  writeView(view) {
    const u = (this.viewData ??= new Float32Array(40));
    u.set(view.matrix, 0);
    u.set(view.eye, 16);
    u[19] = view.widen ?? (this.mode === "dither" ? 0 : 0.45);
    u.set(view.sun, 20);
    u[23] = view.sun[3] ?? 0.6;
    u.set(view.viewport, 24);
    u[26] = view.minPixels ?? 1.6;
    u[27] = view.radius ?? 0.2;
    // crowns: the levels above 32 m soft (a crown per few hundred m2 cannot be drawn), below as volumes
    u[28] = this.mode === "crowns" ? SOFT_FROM : 0;
    u[29] = this.mode === "crowns" ? SOFT_FROM : 1e9;
    u[30] = this.mode === "crowns" ? CROWN_PX * (view.minPixels ?? 1.6) : 0; // crowns of a radius about 1 px (2 px across): soft below
    // what the next byCrowns() culls with: crowns too small seen from here are not given to volume()
    if (this.mode === "crowns" && view.lod) this.seen = { eye: [...view.eye], focal: view.lod.focal, limit: u[30] };
    u[31] = view.time ?? 1e9; // s from the tree's t0: the fades in (VegetationTree appear)
    // per pixel fades: the walk's tau and band, the camera's focal (view.lod: { tau, band, focal })
    const lod = view.lod;
    u.set(lod ? [lod.tau, lod.band, lod.focal, 1] : [0, 0, 0, 0], 32);
    u[36] = view.presence ?? 1; // the scene's fade in or out (SceneFrame.sceneOpacity)
    this.device.queue.writeBuffer(this.viewBuffer, 0, u);
  }
  /** The opaque part (depth written): cells (dither, crowns) and returns. */
  draw(pass, view) {
    if (!this.bindGroup) return;
    this.writeView(view);
    pass.setBindGroup(0, this.bindGroup);
    for (const [pipeline, slot, vertices] of [
      [this.cellPipeline, this.cells, this.cellVertices ?? 4],
      [this.discPipeline, this.returns, 4],
    ]) {
      if (!slot.count || !pipeline) continue;
      pass.setPipeline(pipeline);
      pass.setVertexBuffer(0, slot.buffer);
      // crowns: one draw per run of cells holding as many crowns (byCrowns)
      if (slot === this.cells && this.cellVertices && this.compact && this.runs) {
        for (const [v, first, count] of this.runs) if (count) pass.draw(v, count, 0, first);
      } else pass.draw(vertices, slot.count);
    }
  }
  /** The blended part (additive, canopy: the cells as soft Gaussians), depth read only. */
  drawSoft(pass) {
    if (!this.bindGroup || !this.softPipeline || !this.cells.count) return;
    pass.setBindGroup(0, this.bindGroup);
    pass.setPipeline(this.softPipeline);
    pass.setVertexBuffer(0, this.cells.buffer);
    pass.draw(4, this.cells.count);
  }
  /** Add this frame's passes to the engine: view as draw() takes it. */
  record(engine, view) {
    engine.add("vegetation", (pass) => this.draw(pass, view));
    if (this.softPipeline) engine.add("vegetation.soft", (pass) => this.drawSoft(pass), { stage: "drape" });
  }
  destroy() {
    this.destroyed = true;
    this.dispatch = false;
    this.bindGroup = null;
    for (const b of [this.cells.buffer, this.returns.buffer, this.storeBuffer, this.viewBuffer, this.arena, this.entries.buffer, this.gatherCount]) b?.destroy();
  }
}
