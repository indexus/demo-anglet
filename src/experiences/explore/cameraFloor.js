// The camera close to the ground: the map's centre follows the terrain (centerClampedToGround),
// and the zoom stops where the eye would come down to EYE_HEIGHT above that centre's ground.
// Before, the centre sat at the scene's mean height (29 m over Anglet, 21 m above the ground
// there): the camera could not come down below the roofs.

export const EYE_HEIGHT = 2; // m above the centre's ground, as a walker's eye (first person: 1.8)
const EARTH = 40075016.68557849; // m around the equator
const WORLD = 512; // MapLibre's world at zoom 0, in px

/**
 * The zoom at which the eye is `height` m above the centre's ground: the camera stands
 * cameraToCenterDistance px from the centre (half the viewport's height over tan(fov / 2)),
 * pitch degrees from the vertical.
 */
export function floorZoom({ height, fov, pitch, lat }, eye = EYE_HEIGHT) {
  const toCentre = (0.5 * height) / Math.tan(((fov * Math.PI) / 180) / 2),
    vertical = Math.max(Math.cos((pitch * Math.PI) / 180), 1e-3),
    metres = EARTH * Math.cos((lat * Math.PI) / 180);
  return Math.log2((toCentre * vertical * metres) / (WORLD * eye));
}

/**
 * The map's transform constrain: the zoom below the floor (first person, at its own height, left
 * as asked), then MapLibre's own constrain (min and max zoom, the world's edges). `base`: that
 * constrain (MapLibre gives no public handle on it: its transform's, else zoom and latitude only).
 */
export function cameraFloor(map, { firstPerson = () => false, eye = EYE_HEIGHT, base = null } = {}) {
  const fallback = (lngLat, zoom) => {
    const lat = Math.max(-85.051129, Math.min(85.051129, lngLat.lat));
    return {
      center: lat === lngLat.lat ? lngLat : new lngLat.constructor(lngLat.lng, lat),
      zoom: Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), zoom)),
    };
  };
  const own = (lngLat, zoom) => (base ?? map._camera?.transform?.defaultConstrain ?? fallback)(lngLat, zoom);
  return (lngLat, zoom) => {
    if (zoom == null) return { center: lngLat, zoom };
    if (firstPerson()) return own(lngLat, zoom);
    const floor = floorZoom(
      { height: map.getCanvas().clientHeight || 800, fov: map.getVerticalFieldOfView?.() ?? 36.87, pitch: map.getPitch(), lat: lngLat.lat },
      eye,
    );
    return own(lngLat, Math.min(zoom, floor));
  };
}

/** The centre on the ground, the zoom down to the floor. */
export function installCameraFloor(map, options) {
  map.setCenterClampedToGround(true);
  map.setTransformConstrain(cameraFloor(map, options));
}
