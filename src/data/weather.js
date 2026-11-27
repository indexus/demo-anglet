// The AROME run of Explore as native collections (core tools/prep/weather):
// one collection per variable, a record [area km², v·area for each hour of
// the run] (73 metrics). A zone's sums are the area-weighted means of what
// lies below it, so the far views are the node's zone sums, and hour h is
// column 1 + h of a block. The map asks the node for the columns it draws
// only (`/sets?columns=0,h+1,h+2`); the 72-hour curve reads every column of
// a few coarse zones.
//
// Temperature, rain, cloud cover and wind go through the SDK heat pipeline
// (one per variable) to the GPU; the city labels are read as records, by zone.
import { Collection, Space } from "js-indexus-sdk";

export const GPS = [{ name: "gps", type: "spherical", args: [-90, 90, -180, 180] }];
export const KELVIN = 273.15;

/** The run: what weather.py's weather.json says. */
export const WEATHER_RUN = Object.freeze({
  sourceLabel: "AROME HD · France",
  firstTimestamp: 1738022400, // 2025-01-28 00:00 UTC
  hours: 72,
  /** Vintage of the names: the run's first day, and the layout's version. */
  vintage: "0128",
  version: "v2",
  /**
   * Temperature records: the native 0.01° points of the run, each alone in its
   * zone of 16 bits per axis (0.0027° × 0.0055°): the node keeps the sums of
   * every zone above, so a far view reads coarse zones and a near one the grid.
   */
  depth: 16,
  /** Spacing of the native grid, degrees. */
  gridDegrees: 0.01,
  /**
   * Rain, cloud, solar and wind: the regional Web Mercator grid of the run
   * (west, south, east, north), a record per cell (ID m<size>-<row>-<column>).
   */
  atmosphere: Object.freeze({ size: 128, bounds: Object.freeze([-8, 39, 12, 53]) }),
});

/** Collection of a variable: "Tempe", "Rainf", "Cloud", "Solar", "WindU", "WindV", "Towns". */
export const collectionName = (kind, run = WEATHER_RUN) =>
  `${kind}AROME${run.vintage}${run.version}`;

export const definitionOf = (name) => ({ name, dimensions: GPS });

/** Column of hour `h` (clamped to the run). */
export const hourColumn = (hour, run = WEATHER_RUN) =>
  1 + Math.max(0, Math.min(run.hours - 1, Math.floor(hour)));

/** Every column of a variable: the area and each hour. */
export const allColumns = (run = WEATHER_RUN) => Array.from({ length: run.hours + 1 }, (_, j) => j);

/**
 * The columns the map reads at `hour`, and the heat rules over them: the area,
 * the hour and the next one (previous = the hour, current = the next, blended
 * by the fraction); the last hour alone.
 */
export function hourPair(hour, shift = 0, run = WEATHER_RUN) {
  const column = hourColumn(hour, run);
  if (column >= run.hours)
    return { columns: [0, column], heat: hourRule(1, shift), previous: null };
  return {
    columns: [0, column, column + 1],
    heat: hourRule(2, shift),
    previous: hourRule(1, shift),
  };
}

/**
 * The columns a field reads around hour `base`: the area, the pair (base,
 * base + 1) and the hour after it, read ahead so that playback into the next
 * hour finds its pair in the blocks already held.
 */
export function hourColumns(base, run = WEATHER_RUN) {
  const first = hourColumn(base, run);
  return [0, ...new Set([first, first + 1, first + 2].filter((c) => c <= run.hours))];
}

/**
 * Rules of the pair (base, base + 1) over blocks that hold `columns`: the
 * positions of the two hours there (previous = base, current = base + 1; the
 * last hour alone), or null when the blocks do not hold them.
 */
export function pairRules(base, columns, shift = 0, run = WEATHER_RUN) {
  const a = columns.indexOf(hourColumn(base, run));
  if (a < 0) return null;
  if (hourColumn(base, run) >= run.hours) return { heat: hourRule(a, shift), previous: null };
  const b = columns.indexOf(hourColumn(base + 1, run));
  return b < 0 ? null : { heat: hourRule(b, shift), previous: hourRule(a, shift) };
}

/**
 * Heat rule of a metric position: Σ v·area / Σ area minus `shift`, so that the
 * drawn value is v - shift (the palette wants °C + its bias).
 */
export const hourRule = (position, shift = 0) => [{ num: position, den: 0, minDen: 0, shift }];

/** Means of every hour of the run from the sums of every column, minus `shift`. */
export function hourlyMeans(sums, shift = 0, run = WEATHER_RUN) {
  const area = sums?.[0];
  return Array.from({ length: run.hours }, (_, h) =>
    area > 0 && Number.isFinite(sums[1 + h]) ? sums[1 + h] / area - shift : NaN,
  );
}

const spaces = new Map();
function spaceOf(name) {
  if (!spaces.has(name)) {
    const collection = new Collection(name, GPS);
    spaces.set(name, new Space(collection.dimensions(), collection.mask(), collection.offset()));
  }
  return spaces.get(name);
}

/** [lat, lng] of the centre of the zone of a location of `collection`. */
export function locationCentre(collection, location) {
  const [south, north, west, east] = spaceOf(collection).decode(location)[0].value();
  return [(south + north) / 2, (west + east) / 2];
}

/**
 * City labels from the records of the Towns collection (rows {location, id,
 * metrics, payload}): [{name, coordinates: [lng, lat], minZoom, temperatures:
 * °C per hour, 0.01 °C}].
 */
export function townSeries(rows, run = WEATHER_RUN) {
  const name = collectionName("Towns", run);
  return (rows ?? []).map((row) => {
    const payload = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
    const [lat, lng] = locationCentre(name, row.location);
    const area = row.metrics[0];
    return {
      name: payload?.name ?? row.id,
      coordinates: [lng, lat],
      minZoom: payload?.minZoom ?? 0,
      temperatures: Array.from({ length: run.hours }, (_, h) =>
        area > 0 ? Math.round((row.metrics[1 + h] / area - KELVIN) * 100) / 100 : null,
      ),
    };
  });
}
