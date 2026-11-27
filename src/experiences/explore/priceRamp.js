// The €/m² colours of the DVF 2020 sales, as the 2D map draws them: the SDK's
// heat layer quantizes value / normalizer into `DVF_COLORS` steps of the
// ramp (generateColorRampWgsl: stop i at t = (i + 1) / n, a value t takes
// stop i for the first i with t <= stop i + 1, the last stop past them). The
// 3D scene's roofs take these colours (scene.js), so a roof and the 2D map
// under it agree to the byte, with the same legend (realestate.js). The
// sale pastilles (saleLabels.js) take the ramp itself, unquantized.
import { rgbRamp } from "js-indexus-sdk/map";

export const DVF_COLORS = 24;
/** €/m² at the top of the ramp: a cell shows value / DVF_NORMALIZER. */
export const DVF_NORMALIZER = 10000;
/**
 * The €/m² ramp on the light basemap, t = €/m² / DVF_NORMALIZER → "rgb(r, g, b)":
 * d3.scaleLinear().interpolate(d3.interpolateRgb) of these stops (the SDK's rgbRamp).
 */
export const DVF_INTERPOLATION = rgbRamp(
  [0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.65, 0.9],
  [
    "rgb(255,255,224)",
    "rgb(253,227,178)",
    "rgb(248,199,135)",
    "rgb(240,146,94)",
    "rgb(230,81,56)",
    "rgb(204,33,46)",
    "rgb(157,32,68)",
    "rgb(32,23,115)",
    "rgb(33,33,33)",
  ],
);

/** [r, g, b] bytes of a CSS colour "rgb(r, g, b)" or "#rrggbb" (what d3 interpolators return). */
export function colorBytes(text) {
  const hex = /^#([0-9a-f]{6})$/i.exec(text);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16));
  const parts = String(text).match(/-?[\d.]+/g);
  if (!parts || parts.length < 3) throw Error(`couleur illisible : ${text}`);
  return parts.slice(0, 3).map((v) => Math.max(0, Math.min(255, Math.round(Number(v)))));
}

/** The ramp's stops: [{ t (float32, as the shader's literal), color: [r, g, b] }]. */
export function rampStops(colors = DVF_COLORS, interpolation = DVF_INTERPOLATION) {
  return Array.from({ length: colors }, (_, i) => {
    const t = (i + 1) / colors;
    return { t: Math.fround(Number(t.toFixed(6))), color: colorBytes(interpolation(t)) };
  });
}

/** The stop a normalized value takes (the shader's interpolateColor). */
export function rampColor(t, stops) {
  const v = Math.fround(t);
  for (let i = 0; i < stops.length - 1; i++) if (v <= stops[i + 1].t) return stops[i].color;
  return stops[stops.length - 1].color;
}

let dvfStops = null;
/** [r, g, b] bytes of a mean €/m², as the 2D map draws it. */
export function dvfPriceColor(price) {
  dvfStops ??= rampStops();
  return rampColor(Math.fround(price) / DVF_NORMALIZER, dvfStops);
}

/**
 * Building location -> [r, g, b] of the mean €/m² of its sales. sales:
 * saleReadings ({coordinates, sum, count}); locate(coordinates) -> the
 * building ({id}) or null.
 */
export function roofPrices(sales, locate) {
  const sums = new Map();
  for (const sale of sales) {
    const building = locate(sale.coordinates);
    if (!building || !(sale.count > 0)) continue;
    const entry = sums.get(building.id) ?? { sum: 0, count: 0 };
    entry.sum += sale.sum;
    entry.count += sale.count;
    sums.set(building.id, entry);
  }
  return new Map([...sums].map(([id, { sum, count }]) => [id, dvfPriceColor(sum / count)]));
}
