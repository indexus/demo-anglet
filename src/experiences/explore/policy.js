// Where the scenes are. A scene: { origin: [lng, lat], unit: Mercator units
// per metre, radius: metres }; it covers the disk of that radius, or, with a
// zone (data/sceneZone.js), its contour.
const corner = (scene, MercatorCoordinate, x, y) => {
  const origin = MercatorCoordinate.fromLngLat(scene.origin);
  return new MercatorCoordinate(origin.x + x * scene.unit, origin.y - y * scene.unit).toLngLat().toArray();
};
/** [[west, south], [east, north]] of the scene's square. */
export function sceneBounds(scene, MercatorCoordinate) {
  if (scene.zone?.kind === "polygon") return scene.zone.lngLatBounds();
  const r = scene.radius,
    sw = corner(scene, MercatorCoordinate, -r, -r),
    ne = corner(scene, MercatorCoordinate, r, r);
  return [sw, ne];
}
export function intersects(a, b) {
  return a[0][0] <= b[1][0] && a[1][0] >= b[0][0] && a[0][1] <= b[1][1] && a[1][1] >= b[0][1];
}
/** The scene's outline as a GeoJSON geometry: its contour, or the ring of its disc. */
export function sceneGeometry(scene, MercatorCoordinate) {
  if (scene.zone?.kind === "polygon") return scene.zone.geometry();
  return { type: "Polygon", coordinates: [sceneFootprint(scene, MercatorCoordinate)] };
}
/** Closed ring of the scene's disk (65 points). */
export function sceneFootprint(scene, MercatorCoordinate) {
  return Array.from({ length: 65 }, (_, i) => {
    const angle = ((i % 64) * Math.PI) / 32;
    return corner(scene, MercatorCoordinate, Math.cos(angle) * scene.radius, Math.sin(angle) * scene.radius);
  });
}
/** The scene under the view: the preferred one if it is there. */
export function sceneForView(scenes, bounds, preferred) {
  return scenes.find((s) => s.id === preferred && intersects(bounds, s.bounds)) ?? scenes.find((s) => intersects(bounds, s.bounds));
}
