// The scene's local frame: east, north and up in metres from the scene origin.
// Draws nothing. Added before the scene's layers, it publishes for this frame
// the view matrix and the eye in local metres; buildings, vegetation, lights,
// sky and weather read them. Also carries the sun (`celestial`).
import * as maplibregl from "maplibre-gl";
import { Fade } from "../../rendering/fade.js";

/** ms of the scene's fade in or out (setHidden). */
export const PRESENCE = 400;

// Transform in double precision on the CPU before uploading the combined
// matrix: no float32 global Mercator coordinates, even when zoomed in.
export function localMatrix(world, origin, horizontalUnits) {
  const { x, y, z } = origin,
    zScale = origin.meterInMercatorCoordinateUnits(),
    s = horizontalUnits ?? zScale;
  const out = new Float32Array(16);
  for (let r = 0; r < 4; r++) {
    out[r] = world[r] * s;
    out[4 + r] = -world[4 + r] * s;
    out[8 + r] = world[8 + r] * zScale;
    out[12 + r] = world[r] * x + world[4 + r] * y + world[8 + r] * z + world[12 + r];
  }
  return out;
}
/** Eye position of a view-projection matrix, in its local coordinates. */
export function cameraPosition(matrix) {
  const a = [matrix[0], matrix[4], matrix[8]],
    b = [matrix[1], matrix[5], matrix[9]],
    c = [matrix[3], matrix[7], matrix[11]];
  const cross = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const bc = cross(b, c),
    ca = cross(c, a),
    ab = cross(a, b),
    det = a.reduce((s, x, i) => s + x * bc[i], 0);
  return Math.abs(det) > 1e-20
    ? bc.map((x, i) => (-matrix[12] * x - matrix[13] * ca[i] - matrix[15] * ab[i]) / det)
    : [0, 0, 1000];
}

export class SceneFrame {
  id = "scene-frame";
  type = "custom";
  renderingMode = "3d";
  hidden = false;
  sceneOpacity = 1;
  celestial = null;
  viewMatrix = null;
  cameraLocal = null;
  /**
   * scene: { origin: [lng, lat], unit: Mercator units per metre, radius: metres, zone? (data/sceneZone.js) }.
   * cropRadius: the disc the GPU effects keep to (heat, clouds, lamp glows); 0 with a contour, whose
   * consumers ask `zone` on the CPU (rain contacts, lamps).
   */
  constructor(scene, { profile = false } = {}) {
    this.origin = maplibregl.MercatorCoordinate.fromLngLat(scene.origin);
    this.horizontalUnits = scene.unit;
    this.zone = scene.zone ?? null;
    this.cropRadius = this.zone?.kind === "polygon" ? 0 : scene.radius;
    this.profile = profile;
    // the scene fades in as it starts (its first rows fade in besides), and in and out at SCENE_ZOOM
    this.hiding = false;
    this.presence = new Fade(0, PRESENCE);
    this.presence.set(1, performance.now());
    this.sceneOpacity = 0;
  }
  onAdd(map) {
    this.map = map;
  }
  /**
   * Show or hide the scene (the zoom crosses SCENE_ZOOM): it fades in or out
   * over PRESENCE ms (sceneOpacity, read by the layers), and is hidden only
   * once faded out. false when it was going that way already.
   */
  setHidden(hidden, now = performance.now()) {
    if (hidden === this.hiding) return false;
    this.hiding = hidden;
    if (!hidden) this.hidden = false;
    this.presence.set(hidden ? 0 : 1, now);
    this.map?.triggerRepaint();
    return true;
  }
  /** The fade of the scene's presence at `now`: sceneOpacity, and hidden once gone. */
  updatePresence(now = performance.now()) {
    this.sceneOpacity = this.presence.value(now);
    if (!this.presence.active(now)) {
      if (this.hiding) this.hidden = true;
      return false;
    }
    return true;
  }
  render(gl, args) {
    if (this.hidden) return;
    // a frame per frame while the scene fades in or out, none after
    if (this.updatePresence()) this.map?.triggerRepaint();
    if (this.hidden) return;
    this.viewMatrix = localMatrix(args.defaultProjectionData.mainMatrix, this.origin, this.horizontalUnits);
    this.cameraLocal = cameraPosition(this.viewMatrix);
  }
}
