// The draped photograph is opaque only inside its clipped scene (a disc, or the
// contour of its zone). Hide covered base geometry there, retaining labels and
// all custom/scene layers. A conservative viewport rectangle must fit inside the
// scene with a guard; hysteresis avoids repeatedly rebuilding terrain textures
// near that boundary. zone: data/sceneZone.js (its contour; a disc answers as before).
export function coveredBasemap({ bounds, center = [0, 0], radius, zone = null, ready, active = false }) {
  if (zone?.kind === "polygon") {
    if (ready !== true || !Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(Number.isFinite) || bounds[0] > bounds[2] || bounds[1] > bounds[3])
      return false;
    return zone.rectInside(bounds[0], bounds[1], bounds[2], bounds[3], 128 * (active ? 1 : 1.5));
  }
  if (
    ready !== true ||
    !Number.isFinite(radius) ||
    radius <= 0 ||
    !Array.isArray(bounds) ||
    bounds.length !== 4 ||
    !bounds.every(Number.isFinite) ||
    bounds[0] > bounds[2] ||
    bounds[1] > bounds[3] ||
    !Array.isArray(center) ||
    center.length !== 2 ||
    !center.every(Number.isFinite)
  )
    return false;
  const guard = Math.min(128, radius * 0.2),
    limit = radius - guard * (active ? 1 : 1.5),
    dx = Math.max(Math.abs(bounds[0] - center[0]), Math.abs(bounds[2] - center[0])),
    dy = Math.max(Math.abs(bounds[1] - center[1]), Math.abs(bounds[3] - center[1]));
  return dx * dx + dy * dy <= limit * limit;
}
const geometry = new Set([
  "fill",
  "line",
  "circle",
  "heatmap",
  "raster",
  "hillshade",
  "fill-extrusion",
  "color-relief",
]);
export class CoveredBasemap {
  constructor(map) {
    this.map = map;
    this.active = false;
    this.saved = new Map();
  }
  update(view) {
    const active = coveredBasemap({ ...view, active: this.active });
    if (active === this.active) return active;
    if (!active) {
      this.restore();
      return false;
    }
    this.active = true;
    for (const layer of this.map.getStyle().layers ?? []) {
      if (layer.id.startsWith("scene-") || !geometry.has(layer.type)) continue;
      const visibility = this.map.getLayoutProperty(layer.id, "visibility");
      if (visibility === "none") continue;
      this.saved.set(layer.id, visibility);
      this.map.setLayoutProperty(layer.id, "visibility", "none");
    }
    return true;
  }
  restore() {
    if (!this.active && !this.saved.size) return;
    this.active = false;
    for (const [id, visibility] of this.saved)
      if (this.map.getLayer(id)) this.map.setLayoutProperty(id, "visibility", visibility);
    this.saved.clear();
  }
  destroy() {
    this.restore();
  }
}
