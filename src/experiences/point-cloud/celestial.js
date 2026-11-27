import { getPosition, getMoonPosition, getMoonIllumination } from "suncalc";
const rad = Math.PI / 180;
const clamp = (x) => Math.max(0, Math.min(1, x));
const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
// SunCalc 2 uses degrees clockwise from north. Scene axes: east, north, up.
export function horizontalDirection(azimuth, altitude) {
  const a = azimuth * rad,
    h = altitude * rad,
    c = Math.cos(h);
  return [Math.sin(a) * c, Math.cos(a) * c, Math.sin(h)];
}
export function celestialState(date, coordinates, clouds = 0) {
  const time = new Date(date);
  if (!Number.isFinite(+time)) throw Error("Invalid celestial time");
  const [lng, lat] = coordinates;
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lat) > 90)
    throw Error("Invalid celestial location");
  const sun = getPosition(time, lat, lng),
    moon = getMoonPosition(time, lat, lng),
    illumination = getMoonIllumination(time);
  const daylight = smooth(-7, 7, sun.altitude),
    direct = smooth(-0.8, 7, sun.altitude) * (1 - 0.7 * clamp(clouds / 100));
  const days = +time / 86400000 - 10957.5;
  return {
    timestamp: +time,
    sunDirection: horizontalDirection(sun.azimuth, sun.altitude),
    moonDirection: horizontalDirection(moon.azimuth, moon.altitude),
    sunAltitude: sun.altitude,
    sunAzimuth: sun.azimuth,
    moonAltitude: moon.altitude,
    moonFraction: illumination.fraction,
    daylight,
    direct,
    clouds: clamp(clouds / 100),
    latitude: lat * rad,
    sidereal: ((280.46061837 + 360.98564736629 * days + lng) % 360) * rad,
  };
}
export function interpolateCelestial(from, to, fraction) {
  const t = smooth(0, 1, fraction),
    mix = (a, b) => a + (b - a) * t;
  const direction = (a, b) => {
    const dot = Math.max(
        -1,
        Math.min(
          1,
          a.reduce((s, v, i) => s + v * b[i], 0),
        ),
      ),
      angle = Math.acos(dot);
    if (angle < 1e-5) return b.slice();
    let tangent = b.map((v, i) => v - a[i] * dot),
      length = Math.hypot(...tangent);
    if (length < 1e-6) {
      const axis = Math.abs(a[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
      tangent = [
        a[1] * axis[2] - a[2] * axis[1],
        a[2] * axis[0] - a[0] * axis[2],
        a[0] * axis[1] - a[1] * axis[0],
      ];
      length = Math.hypot(...tangent);
    }
    return a.map((v, i) => v * Math.cos(angle * t) + (tangent[i] / length) * Math.sin(angle * t));
  };
  const output = {
    ...to,
    sunDirection: direction(from.sunDirection, to.sunDirection),
    moonDirection: direction(from.moonDirection, to.moonDirection),
  };
  for (const key of ["timestamp", "daylight", "direct", "clouds"])
    output[key] = mix(from[key], to[key]);
  const turn = Math.atan2(
    Math.sin(to.sidereal - from.sidereal),
    Math.cos(to.sidereal - from.sidereal),
  );
  output.sidereal = from.sidereal + turn * t;
  return output;
}
