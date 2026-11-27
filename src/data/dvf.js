// DVF 2020 (houses, sales) as the real estate view reads it. The rules leave
// the SDK (heat pipeline v2, decision 7). Metrics of a sale: [valeur,
// surface, €/m², lat, lng].
import { DVF_COLLECTION_NAME } from "./collections.js";

/** Columns of a sale's metrics. */
export const DVF_METRICS = { valeur: 0, surface: 1, euroM2: 2, lat: 3, lng: 4 };

export const DVF_COLLECTION = {
  name: DVF_COLLECTION_NAME,
  dimensions: [{ name: "gps", type: "spherical", args: [-90, 90, -180, 180] }],
};

// A cell shows Σ(€/m²) / count, the mean €/m² of its sales; a cell without
// prices shows its density, log1p(count).
export const DVF_HEAT = [
  { num: 2, den: -1 },
  { num: -1, den: -1, transform: 1 },
];

/**
 * A cell sits at the mean position of its sales, from metrics 3 and 4 (the
 * SDK's metric encoding of a latitude and a longitude).
 */
export const DVF_CELL_POSITION = {
  mode: "metrics",
  metricLatIndex: DVF_METRICS.lat,
  metricLngIndex: DVF_METRICS.lng,
};

/** A sale of the point overlay carries its €/m². */
export const DVF_VALUE_METRIC_INDEX = DVF_METRICS.euroM2;

/** A cell draws as a disk (areaMode 0), 2.5 times its size, at its centroid. */
export const DVF_VISUAL = { multiplier: 2.5, areaMode: 0, centroidSnap: 0 };

/** Summary of a view: `count` sales and their metric sums. */
export const summarizeDvf = (count, sums) => ({
  transactions: Math.round(Math.max(count, 0)),
  avgValeurFonciere: count > 0 ? (sums[0] ?? 0) / count : null,
  avgSurfaceM2: count > 0 ? (sums[1] ?? 0) / count : null,
  avgEuroM2: count > 0 && sums[2] > 0 ? sums[2] / count : null,
});
