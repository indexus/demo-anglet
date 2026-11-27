export const STOPS = [
  [-10, [76, 90, 164]],
  [0, [69, 136, 193]],
  [10, [97, 185, 177]],
  [20, [242, 212, 128]],
  [30, [238, 137, 88]],
  [40, [187, 65, 80]],
];
export function temperatureColor(temperature, daylight = 1) {
  const t = Math.max(-10, Math.min(40, temperature));
  const i = Math.min(
    STOPS.length - 2,
    Math.max(
      0,
      STOPS.findIndex((s, j) => j < STOPS.length - 1 && t <= STOPS[j + 1][0]),
    ),
  );
  const [lo, a] = STOPS[i],
    [hi, b] = STOPS[i + 1],
    f = (t - lo) / (hi - lo);
  const nightTint = [65, 89, 143];
  const nightMix = 0.24 * (1 - daylight);
  return `rgb(${a
    .map((v, j) => {
      const channel = v + (b[j] - v) * f;
      return Math.round(channel + (nightTint[j] - channel) * nightMix);
    })
    .join(",")})`;
}
// Pack a positive scalar for the existing n/d pipeline, supporting T below 0.
export const TEMPERATURE_BIAS = 40;
export const TEMPERATURE_NORMALIZER = 90;
export const colorInterpolation = (t, daylight) =>
  temperatureColor(t * TEMPERATURE_NORMALIZER - TEMPERATURE_BIAS, daylight);
