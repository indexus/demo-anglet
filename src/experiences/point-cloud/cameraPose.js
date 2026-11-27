import * as maplibregl from "maplibre-gl";
const { MercatorCoordinate } = maplibregl;
// Camera of the first-person view, from a position in the scene's local metres.
// Looking around changes the target, not the observer's world position.
export function cameraOptionsFromLocal(map, scene, position, bearing, pitch) {
  const origin = MercatorCoordinate.fromLngLat(scene.origin),
    unit = scene.unit,
    r = (bearing * Math.PI) / 180,
    distance = 20;
  const lngLat = (x, y) =>
    new MercatorCoordinate(origin.x + x * unit, origin.y - y * unit).toLngLat();
  return {
    ...map.calculateCameraOptionsFromTo(
      lngLat(position[0], position[1]),
      position[2],
      lngLat(position[0] + Math.sin(r) * distance, position[1] + Math.cos(r) * distance),
      position[2] - distance / Math.tan((pitch * Math.PI) / 180),
    ),
    roll: 0,
  };
}
