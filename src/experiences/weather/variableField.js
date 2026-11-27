// One weather variable of the AROME run, read from its native collection
// (src/data/weather.js) through the SDK heat pipeline: the view's zones as
// IXB2 blocks of four columns only (the area, the hour, the next one and the
// one after, `/sets?columns=`), into the GPU arena and packed there, the next
// hour beside the hour so that whoever draws the instances (the temperature
// layer, a field raster) blends the two on the GPU. The far views are the
// node's zone sums.
//
// As the pre-E temperature did (frames of three levels around the camera,
// swapped whole when read, the levels weighted on the GPU by the zoom):
// - no cross-fade between plans (`fades: false`) and no plan of a view half
//   read (`completePlans`): the plan on screen stays until the next one is
//   complete, and the renderer's level weights keep the image continuous;
// - a new hour is a rule change when the blocks hold its pair (the hour read
//   ahead), then a column swap whose rules apply with the first plan of the new
//   blocks: no pack mixes two hours (fieldHours.js).
//
// createVariableField({kind, device, init, drawShift, meanShift, pointRadius}):
//   kind         "Tempe", "Rainf", "Cloud", "WindU", "WindV"…
//   drawShift    subtracted from the mean in the instances (temperature: to the palette's °C)
//   meanShift    subtracted from the means given to the page (temperature: kelvin → °C)
//   pointRadius  degrees around a point whose records give its value (about a cell)
//
// Handle: controller, move({zoom, bounds}), setHour(hour), setVisible(value),
// regionMeans(bounds) → value per hour of the run (a coarse read of every
// column), pointMeans([lng, lat]), registerRepaint(f), destroy().
import HeatWorker from "js-indexus-sdk/map/heat-worker?worker";
import { createHeatmapPipeline } from "js-indexus-sdk/map";
import {
  WEATHER_RUN,
  allColumns,
  collectionName,
  definitionOf,
  hourlyMeans,
} from "../../data/weather.js";
import { hourState } from "./fieldHours.js";

const BOUNDS = {
  mode: "bounds",
  latIndex: 0,
  lngIndex: 0,
  metricScale: 1,
  latOffset: 0,
  lngOffset: 0,
};
/** walk depth = zoom + 6 bits per axis (main.js liveZoom gives the zoom). */
const RESOLUTION = 6;
const segment = ([west, south, east, north]) => [
  { dimension: 0, segment: [south, north, west, east] },
];

export function createVariableField({
  kind,
  device,
  init,
  drawShift = 0,
  meanShift = 0,
  pointRadius = 0.03,
  hour = 12,
  run = WEATHER_RUN,
  onError = () => {},
}) {
  const worker = new HeatWorker();
  const hours = hourState({ run, shift: drawShift, hour });
  const pipeline = createHeatmapPipeline({
    worker,
    collection: definitionOf(collectionName(kind, run)),
    device,
    heat: hours.heat,
    previousHeat: hours.previousHeat,
    position: BOUNDS,
    fades: false,
  });
  hours.controller = pipeline.controller;
  pipeline.init({
    ...init,
    completePlans: true,
    columns: hours.columns,
    cubeOpt: { limit: 5, children: 4, resolution: RESOLUTION },
    // a weather row stands for its native points: the overlay of items never applies
    pointOverlay: { maxPoints: 1 },
    polygonFilterEnabled: false,
    childVirtualizationEnabled: false,
  });
  worker.addEventListener("message", ({ data }) => {
    if (data.type === "ERROR") onError(data.payload);
  });
  let camera = null;
  const all = allColumns(run);
  let repaint = () => {};
  // the first plan of a swap's blocks applies its rules: the blend follows in the same frame
  pipeline.registerRepaint(() => {
    hours.sync();
    repaint();
  });

  async function means(bounds, maxZones) {
    const { metricSums } = await pipeline.sums({ bounds: segment(bounds), columns: all, maxZones });
    return hourlyMeans(metricSums, meanShift, run);
  }

  const field = {
    kind,
    controller: pipeline.controller,
    loadedGrid() {
      return {kind:"gps-zones",collection:collectionName(kind,run),locations:pipeline.controller.getLoadedZones(),activeLocations:pipeline.controller.getDrawnZones()};
    },
    move(next) {
      camera = next;
      const strict = segment(next.bounds);
      pipeline.move({ zoom: next.zoom, bounds: strict, strictBounds: strict });
    },
    /** The hour shown (fraction blended): fieldHours.js. */
    setHour(next) {
      hours.setHour(next);
    },
    setVisible(value) {
      pipeline.controller.setReadVisibility(value);
      if (value && camera) field.move(camera);
    },
    /** Value per hour of the run over `bounds` [west, south, east, north]: a coarse read. */
    regionMeans(bounds) {
      return means(bounds, 16);
    },
    /** Value per hour of the run at a point: the records within pointRadius. */
    pointMeans([lng, lat]) {
      const r = pointRadius;
      return means([lng - r, lat - r, lng + r, lat + r], 4);
    },
    registerRepaint(next) {
      repaint = typeof next === "function" ? next : () => {};
    },
    destroy() {
      pipeline.destroy();
    },
  };
  return field;
}

/** Value at `hour` (fraction blended) of a series of the run. */
export function atHour(series, hour, run = WEATHER_RUN) {
  const h = Math.max(0, Math.min(run.hours - 1, hour));
  const a = series[Math.floor(h)];
  const b = series[Math.min(run.hours - 1, Math.ceil(h))];
  return a + (b - a) * (h - Math.floor(h));
}
