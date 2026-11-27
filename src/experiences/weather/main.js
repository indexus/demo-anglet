import { localBasemapStyle } from "../explore/basemapStyle.js";
import { attachThumbZoom } from "../../interactions/thumbZoom.js";
import { onSessionTrace } from "../explore/diagnostics/trace.js";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
// MapLibre starts its worker from a file beside its own chunk, which a build does not carry:
// the worker is an asset of its own, with a hashed name (a cached 404 of an earlier URL cannot stick).
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import "./style.css";
import {
  detectWebGPU,
  showWebGPUUnsupported,
  webgpuSupport,
} from "js-indexus-sdk/map";
import {
  disableTerrain,
  brightenDatavizDarkSettlementLabels,
  tuneDatavizDarkBackgroundAndWater,
} from "js-indexus-sdk/map";
import {
  colorInterpolation,
  STOPS,
  temperatureColor,
  TEMPERATURE_BIAS,
  TEMPERATURE_NORMALIZER,
} from "./palette.js";

import { addCityTemperatures, weatherIcons, weatherKind } from "./cityTemperatures.js";
import { atHour, createVariableField } from "./variableField.js";
import { ATMOSPHERE_KINDS, atmosphereGrids, createAtmosphere } from "./atmosphere.js";
import { addWeatherEffects } from "./effectsLayer.js";
import { mapRenderer } from "../../rendering/gpu/mapRenderer.js";
import { HeatDrape } from "../../rendering/gpu/heatDrape.js";
import { KELVIN, WEATHER_RUN, collectionName, townSeries } from "../../data/weather.js";
import { getExperienceConfiguration, getExperienceNetwork } from "../../data/network.js";
import {
  overviewPixelRatio,
  TEMPERATURE_PIXELS,
  PLAYBACK_INTERVAL,
  boundedRenderScale,
  closeZoomOpacity,
  CLOSE_SCENE_ZOOM,
  zoneWeatherFade,
} from "./renderBudget.js";

/** Whether `point` is inside the ring `polygon` (even-odd crossings, as d3.polygonContains). */
function polygonContains(polygon, [x, y]) {
  let [x0, y0] = polygon[polygon.length - 1],
    inside = false;
  for (const [x1, y1] of polygon) {
    if (y1 > y !== y0 > y && x < ((x0 - x1) * (y - y1)) / (y0 - y1) + x1) inside = !inside;
    x0 = x1;
    y0 = y1;
  }
  return inside;
}

const $ = (id) => document.getElementById(id);
let sessionTrace = null;
onSessionTrace((trace) => {
  sessionTrace = trace;
});
const beforeRemove = new Set();
const controls = ["play", "time-slider", "previous-day", "next-day"];

const dateFormat = new Intl.DateTimeFormat("fr-FR", {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "Europe/Paris",
});
const timeFormat = new Intl.DateTimeFormat("fr-FR", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Paris",
});
const shortDate = new Intl.DateTimeFormat("fr-FR", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Paris",
});
let meta = null,
  means = [],
  selected = 12,
  shown = 12,
  playing = false;
let periodLabel = null;
let summaryTimer,
  summaryId = 0,
  summaryPending = false,
  regionalWeather = [];
const meanFormat = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 });
let raf = null,
  lastFrame = 0,
  lastReadout = 0;
let renderReady = false,
  ready = false,
  failed = false;
/** The temperature from its collection (variableField.js), once there is a device. */
let field = null;
let fieldInit = null;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
let paletteDaylight = 1;
const effect = {
  multiplier: 2.3,
  areaMode: 0,
  smoothEdge: 0.55,
  fading: 0,
  colors: 32,
  colorInterpolation,
  interpolateValues: true,
  // a cell's sums are over its zone's area (km²): each level weighs as the
  // pre-E cells of weight 1 did, and a coastal zone by its land share
  coverage: true,
};

maplibregl.setWorkerUrl(maplibreWorkerUrl);
const map = new maplibregl.Map({
  container: "map",
  center: [2.4, 46.6],
  zoom: 5.25,
  minZoom: 3,
  maxZoom: 24,
  maxPitch: 85,
  centerClampedToGround: false,
  ...(matchMedia("(max-width: 700px), (pointer: coarse)").matches
    ? { maxTileCacheSize: 32, maxTileCacheZoomLevels: 2 }
    : {}),
  pixelRatio: overviewPixelRatio(devicePixelRatio),
  attributionControl: {
    compact: true,
    customAttribution:
      "LiDAR HD, BD TOPO, orthophoto © IGN · Cadastre © DGFiP / Etalab · DVF 2020 © DGFiP",
  },
  canvasContextAttributes: { antialias: false },
  style: import.meta.env.VITE_MAP_STYLE_URL || localBasemapStyle(),
});
const thumbZoomControl = attachThumbZoom($("thumb-zoom"), map);

const legendPanel = $("map-legend");
const controlsResize = new ResizeObserver(([entry]) => {
  $("app").style.setProperty("--weather-controls-height", `${entry.contentRect.height}px`);
});
controlsResize.observe(document.querySelector(".timeline-controls"));
/** Rain, cloud cover, solar and wind on the run's regional grid (atmosphere.js), and their effects pass. */
let atmosphere = null,
  effectsLayer = null,
  temperatureHeat = null,
  playedHours = 0,
  francePolygon,
  localSceneActive = false,
  localSceneBounds = null;
let cityTemperatures,
  weatherVisible = true;
const temperatureToggle = $("weather-temperature");
const temperatureOpacity = () => closeZoomOpacity(map.getZoom(), CLOSE_SCENE_ZOOM);
function syncTemperatureVisibility() {
  if (!temperatureHeat) return;
  temperatureHeat.visible = weatherVisible && temperatureToggle.checked && temperatureOpacity() > 0;
}
map.on("zoom", syncTemperatureVisibility);
temperatureToggle.addEventListener("change", () => {
  if (!temperatureHeat) return;
  syncTemperatureVisibility();
  map.triggerRepaint();
});
const cloudToggle = $("weather-clouds");
const rainToggle = $("weather-rain");
/** {rain, clouds} at a place as the map shows them there (the grid sampled as the GPU does). */
const conditionsAt = (coordinates, hour) => atmosphere?.conditionsAt(coordinates, hour, map.getZoom());
/**
 * The 2D clouds and rain: as the temperature, until CLOSE_SCENE_ZOOM; a scene's
 * contour takes them off (effects.js, zoneFade below): from 11.5 to 12 on the
 * 2D map as the photo comes in, wholly while the scene is shown (its own
 * clouds and rain), and they stay around it.
 */
function effectsState() {
  return {
    rain: rainToggle.checked,
    clouds: cloudToggle.checked,
    opacity: weatherVisible ? temperatureOpacity() : 0,
  };
}
/** How much of the 2D weather a scene's contour takes off: all of it while the scene is shown. */
const zoneFade = (camera) => (camera.scene ? 1 : zoneWeatherFade(camera.zoom));
function updateAnimationLayers() {
  map.triggerRepaint();
}
cloudToggle.addEventListener("change", updateAnimationLayers);
rainToggle.addEventListener("change", updateAnimationLayers);

map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "top-left");
$("distance-scale").append(document.querySelector(".maplibregl-ctrl-scale"));
// Start AROME two levels coarser, then recover detail as the map zooms in:
// the walk depth (bits per axis) of the temperature field.
const FIELD_RESOLUTION = 6;
const liveDepth = () => {
  const zoom = map.getZoom();
  const overviewReduction = Math.max(0, Math.min(2, (9.5 - zoom) / 2));
  return Math.max(7, Math.min(16, zoom + 6.25 - overviewReduction));
};
/** The zoom the field's walk is given: its depth is zoom + FIELD_RESOLUTION. */
const liveZoom = () => liveDepth() - FIELD_RESOLUTION;
const controller = {
  // Keep the smooth temperature field within the same mobile-sized pixel budget.
  getRenderScale: () => {
    const { clientWidth, clientHeight } = map.getContainer();
    const scale = boundedRenderScale(clientWidth, clientHeight, TEMPERATURE_PIXELS);
    return (scale * (map.isZooming() ? 0.75 : 1)) / map.getPixelRatio();
  },
  getZoom: () => map.getZoom(),
  getResolutionConstant: () => liveDepth() - map.getZoom(),
  getEffect: () => effect,
  getNormalizer: () => TEMPERATURE_NORMALIZER,
  getTransitionFactor: () => field?.controller.getTransitionFactor() ?? 1,
  getHeatmapOpacity: () => 0.82 * temperatureOpacity(),
  getPackedData: () => field?.controller.getPackedData() ?? { count: 0 },
};

const pointerToggle = $("pointer-toggle");
const locationReadout = $("location-readout");
const mapTarget = $("map-target");
const mobileTarget = matchMedia("(max-width: 700px)");
let pointerEnabled = false;
let pointerRequest = 0;
let pointerPosition = null;
let pointerFrame = 0;
let pointerIdleTimer;
let pointerSettled = false;

function resetPointerWeather() {
  $("pointer-temperature").textContent = "NA";
  $("pointer-condition").textContent = "NA";
  delete $("pointer-condition").dataset.weather;
  $("pointer-weather").removeAttribute("data-stale");
}

function updatePointerWeather() {
  pointerFrame = 0;
  if (!pointerEnabled) return;
  const panel = $("pointer-weather");
  if (mobileTarget.matches) {
    const { clientWidth, clientHeight } = map.getContainer();
    pointerPosition = { x: clientWidth / 2, y: clientHeight * 0.44 };
    pointerSettled = true;
  }
  if (!pointerPosition || !ready || !francePolygon) {
    resetPointerWeather();
    return;
  }
  if (!pointerSettled || map.isMoving()) {
    panel.setAttribute("data-stale", "");
    return;
  }
  const wasStale = panel.hasAttribute("data-stale");
  const { lng, lat } = map.unproject(pointerPosition);
  const coordinates = [lng, lat];
  const onLand = francePolygon.features.some(({ geometry }) => {
    const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
    return polygons.some(
      ([outer, ...holes]) =>
        polygonContains(outer, coordinates) &&
        !holes.some((hole) => polygonContains(hole, coordinates)),
    );
  });
  if (!onLand) {
    resetPointerWeather();
    return;
  }
  const request = ++pointerRequest;
  field
    ?.pointMeans(coordinates)
    .then((series) => atHour(series, shown))
    .then((temperature) => {
      if (request === pointerRequest) showPointerWeather(coordinates, temperature, wasStale);
    })
    .catch(() => request === pointerRequest && resetPointerWeather());
}

function showPointerWeather(coordinates, temperature, wasStale) {
  const panel = $("pointer-weather");
  if (!Number.isFinite(temperature)) {
    resetPointerWeather();
    return;
  }
  panel.removeAttribute("data-stale");
  if (wasStale && !reducedMotion.matches) {
    panel.getAnimations().forEach((animation) => animation.cancel());
    panel.animate(
      [
        { opacity: 0.65, transform: "translateY(5px) scale(.97)" },
        { opacity: 1, transform: "translateY(-2px) scale(1.015)", offset: 0.65 },
        { opacity: 1, transform: "translateY(0) scale(1)" },
      ],
      { duration: 280, easing: "ease-out" },
    );
  }
  $("pointer-temperature").textContent = `${meanFormat.format(temperature)} °C`;
  const condition = $("pointer-condition");
  const kind = weatherKind(conditionsAt(coordinates, shown));
  if (!kind) {
    condition.textContent = "NA";
    delete condition.dataset.weather;
  }
  if (kind && condition.dataset.weather !== kind) {
    const [description, path] = weatherIcons[kind];
    condition.dataset.weather = kind;
    condition.innerHTML = `<svg aria-hidden="true" viewBox="0 0 16 16" fill="none"
      stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
      <path d="${path}"/></svg>${description}`;
  }
}

function queuePointerWeather() {
  if (!pointerEnabled) return;
  if (!pointerFrame) pointerFrame = requestAnimationFrame(updatePointerWeather);
}
pointerToggle.addEventListener("click", () => {
  pointerEnabled = !pointerEnabled;
  pointerToggle.setAttribute("aria-pressed", String(pointerEnabled));
  pointerToggle.setAttribute(
    "aria-label",
    pointerEnabled ? "Masquer le relevé local" : "Afficher le relevé local",
  );
  locationReadout.hidden = !pointerEnabled;
  mapTarget.hidden = !pointerEnabled;
  document.querySelector(".map-readout").toggleAttribute("data-location", pointerEnabled);
  clearTimeout(pointerIdleTimer);
  cancelAnimationFrame(pointerFrame);
  pointerFrame = 0;
  resetPointerWeather();
  const { clientWidth, clientHeight } = map.getContainer();
  pointerPosition = pointerEnabled ? { x: clientWidth / 2, y: clientHeight / 2 } : null;
  pointerSettled = pointerEnabled;
  queuePointerWeather();
});
map.on("click", (event) => {
  if (!pointerEnabled || mobileTarget.matches) return;
  clearTimeout(pointerIdleTimer);
  pointerPosition = event.point;
  pointerSettled = true;
  queuePointerWeather();
});
map.on("mousemove", (event) => {
  if (!pointerEnabled || mobileTarget.matches) return;
  pointerPosition = event.point;
  pointerSettled = false;
  $("pointer-weather").setAttribute("data-stale", "");
  clearTimeout(pointerIdleTimer);
  pointerIdleTimer = setTimeout(() => {
    pointerSettled = true;
    queuePointerWeather();
  }, 180);
});
map.getCanvasContainer().addEventListener("mouseleave", () => {
  if (mobileTarget.matches) return;
  pointerPosition = null;
  pointerSettled = false;
  clearTimeout(pointerIdleTimer);
  resetPointerWeather();
});
map.on("move", queuePointerWeather);
map.on("moveend", queuePointerWeather);
map.on("resize", queuePointerWeather);
mobileTarget.addEventListener("change", queuePointerWeather);
map.on("movestart", () => {
  clearTimeout(summaryTimer);
  summaryId++;
  summaryPending = true;
  $("zone-weather").setAttribute("data-stale", "");
  if (pointerPosition) $("pointer-weather").setAttribute("data-stale", "");
});

function showMessage(text, error = false) {
  $("message").hidden = !text;
  $("message").textContent = text;
  $("message").classList.toggle("error", error);
}
function pause() {
  playing = false;
  $("play").removeAttribute("data-playing");
  $("play").setAttribute("aria-label", "Lire l’évolution des températures");
}
function fail(error) {
  failed = true;
  pause();
  showMessage(error.message || String(error), true);
  $("dataset-label").textContent = "Chargement interrompu";
}

async function initializeMap() {
  // the style is enough to add layers: "load" also waits for every basemap
  // source, and one of them (attribution only) can stay pending for minutes
  const loaded = new Promise((resolve) => map.once("style.load", resolve));
  const gpu = detectWebGPU();
  const [polygonResponse] = await Promise.all([fetch("/france.geojson"), loaded]);
  if (!polygonResponse.ok) throw Error("Contour de la France indisponible.");
  francePolygon = await polygonResponse.json();
  disableTerrain(map);
  brightenDatavizDarkSettlementLabels(map);
  tuneDatavizDarkBackgroundAndWater(map);
  updateAnimationLayers();
  queueViewportSummary();
  queueUpdate();

  const detection = await gpu;
  if (!detection.supported) {
    $("temperature-render-notice").hidden = false;
    showWebGPUUnsupported(map.getContainer(), { reason: webgpuSupport().reason ?? "no-adapter" });
    return detection;
  }
  weatherGPU = detection;
  if (weatherVisible) await startPipelines();
  // real estate first: the map is ready, nothing of the weather to wait for
  else if (!failed) showMessage("");
  return detection;
}

/**
 * The weather's pipelines (temperature, rain, clouds, wind: one worker each)
 * and what draws them (the temperature heat, the effects). Explore shows the
 * weather or the sales, never both: hidden, the weather keeps no pipeline and
 * no worker (stopPipelines), and they are made again when it is shown.
 */
let weatherGPU = null,
  pipelineGeneration = 0;
async function startPipelines() {
  if (!weatherGPU?.supported || field) return;
  const detection = weatherGPU,
    generation = ++pipelineGeneration;
  const init = await fieldInit;
  if (generation !== pipelineGeneration || !weatherVisible) return;
  field = createVariableField({
    kind: "Tempe",
    device: detection.device,
    init,
    hour: shown,
    // the palette reads °C + its bias; the page reads °C
    drawShift: KELVIN - TEMPERATURE_BIAS,
    meanShift: KELVIN,
    onError: (message) => console.warn("[weather-temperature]", message),
  });
  field.registerRepaint(() => map.triggerRepaint());
  if (!failed && !$("message").classList.contains("error")) showMessage("");
  queueViewportSummary();
  field.setHour(shown);
  moveField();
  // the temperature and the weather effects, in the map's WebGPU renderer (one canvas)
  const renderer = await mapRenderer(map);
  if (!renderer) return;
  // hidden meanwhile: stopPipelines took what was made
  if (generation !== pipelineGeneration || !weatherVisible) return;
  // the temperature leaves a scene's contour as its photo comes in (renderBudget.js zoneWeatherFade)
  temperatureHeat = new HeatDrape(renderer, "temperature", controller, detection.features, {
    zoneFade: zoneWeatherFade,
  });
  temperatureHeat.initializeMask(francePolygon);
  temperatureHeat.setMaskEnabled(true);
  effectsLayer = addWeatherEffects(map, renderer, {
    hour: () => shown,
    // without wind the broad cloud field moves with playback only (as before)
    cloudTravel(seconds) {
      const moved = playedHours > 0;
      playedHours = 0;
      return moved ? seconds : 0;
    },
    layers: effectsState,
    zoneFade,
  });
  ensureAtmosphere().then((value) => {
    if (value && generation === pipelineGeneration) effectsLayer?.setAtmosphere(value, francePolygon);
  });
  renderReady = true;
  temperatureToggle.disabled = false;
  syncTemperatureVisibility();
  queueViewportSummary();
  map.triggerRepaint();
}
function stopPipelines() {
  pipelineGeneration++;
  effectsLayer?.remove();
  temperatureHeat?.destroy();
  field?.destroy();
  // the atmosphere's grids stay (read once); the effects that drew them are gone
  effectsLayer = temperatureHeat = field = null;
  renderReady = false;
  map.triggerRepaint();
}

/** The SDK network settings of the field's workers (as Explore's DVF). */
async function networkInit() {
  const configuration = await getExperienceConfiguration();
  return {
    bearer: configuration.bearer,
    network: {
      protocol: "http",
      peers: configuration.hosts,
      concurrency: 4,
      cacheSize: 10000,
      setsPool: {
        gateway: `${location.origin}/api/p2p`,
        navigation: "direct",
        method: "getSets",
        contentRecords: true,
      },
    },
  };
}

/** Records of a variable, by zone (the collection's root). */
async function readRecords(kind) {
  const network = await getExperienceNetwork();
  return network.getContentRecords(collectionName(kind), "@", 10000).catch((error) => {
    console.warn(`[weather] ${collectionName(kind)}:`, error.message);
    return [];
  });
}

/** The atmosphere's grids from the records of its collections (each read whole: a cell a record). */
async function loadAtmosphere() {
  const entries = await Promise.all(
    Object.entries(ATMOSPHERE_KINDS).map(async ([name, kind]) => [name, await readRecords(kind)]),
  );
  const rows = Object.fromEntries(entries);
  if (!rows.rain?.length && !rows.cloud?.length) throw Error("Pluie et nuages indisponibles.");
  const { atmosphere: grid } = WEATHER_RUN;
  const grids = atmosphereGrids(rows, { size: grid.size, hours: WEATHER_RUN.hours });
  atmosphere = createAtmosphere(grids, {
    bounds: grid.bounds,
  });
  cloudToggle.disabled = rainToggle.disabled = false;
  cityTemperatures?.update(shown, conditionsAt, true);
  queueViewportSummary();
  queuePointerWeather();
  map.triggerRepaint();
  return atmosphere;
}
/**
 * The atmosphere's grids: read once, when the weather is first shown, and kept
 * (small CPU grids; what draws them goes with the pipelines).
 */
let atmosphereReady = null;
function ensureAtmosphere() {
  return (atmosphereReady ??= loadAtmosphere().catch((error) => {
    console.warn("[weather-atmosphere]", error.message);
    return null;
  }));
}

/** The city labels: read once, when the weather is first shown. */
let townsDeferred = false;
async function loadTowns() {
  await getExperienceNetwork();
  if (!weatherVisible) return void (townsDeferred = true);
  townsDeferred = false;
  const towns = townSeries(await readRecords("Towns"));
  if (!towns.length) throw Error("Températures des villes indisponibles.");
  cityTemperatures?.remove();
  cityTemperatures = addCityTemperatures(map, towns);
  cityTemperatures.setVisible(weatherVisible);
  cityTemperatures.update(shown, conditionsAt);
}

function load() {
  clearTimeout(summaryTimer);
  summaryId++;
  regionalWeather = [];
  $("viewport-mean").textContent = "NA";
  $("viewport-weather").textContent = "NA";
  delete $("viewport-weather").dataset.weather;
  $("zone-weather").removeAttribute("data-stale");
  resetPointerWeather();
  pause();
  failed = false;
  fieldInit = networkInit();
  // awaited only by startPipelines (WebGPU, weather shown), which reports its failure:
  // without them, a gateway down is not an uncaught rejection
  fieldInit.catch(() => {});
  meta = {
    ...WEATHER_RUN,
    sampleDegrees: WEATHER_RUN.gridDegrees,
  };
  means = new Array(meta.hours).fill(NaN);
  ready = true;
  selected = Math.min(selected, meta.hours - 1);
  shown = selected;
  updateView();
  loadTowns().catch((error) => console.warn("[weather-cities]", error.message));
  if (weatherVisible) ensureAtmosphere();
  queueViewportSummary();
  $("dataset-label").textContent = `${meta.sourceLabel} · ${meta.hours} heures`;
  $("sampling").textContent = `mailles ${String(meta.sampleDegrees.toFixed(3)).replace(".", ",")}°`;
  controls.forEach((id) => ($(id).disabled = false));
  updateReadout(performance.now(), true);
  queueUpdate();
}

function hourDate(hour) {
  return new Date((meta.firstTimestamp + hour * 3600) * 1000);
}
const solarIcons = {
  day: [
    "Jour",
    "M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M19 5l-1.5 1.5m-11 11L5 19M17 12a5 5 0 1 1-10 0 5 5 0 0 1 10 0Z",
  ],
  night: ["Nuit", "M20.5 14a8.5 8.5 0 0 1-10.5-10.5A8.5 8.5 0 1 0 20.5 14Z"],
  dawn: ["Aurore", "M2 18h20M7 16a5 5 0 0 1 10 0M4 11l2 2m12 0 2-2M12 8V3m-3 3 3-3 3 3"],
  dusk: ["Coucher du soleil", "M2 18h20M7 16a5 5 0 0 1 10 0M4 11l2 2m12 0 2-2M12 3v5m-3-3 3 3 3-3"],
};

// Use central France as a fixed reference so the light stays stable while panning.
function daylightAt(date) {
  const radians = Math.PI / 180;
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const day = (date.getTime() - yearStart) / 86400000;
  const declination = 23.44 * radians * Math.cos((2 * Math.PI * (day - 172)) / 365.24);
  const latitude = 46.6 * radians;
  const utcHours = (date.getTime() / 3600000) % 24;
  const hourAngle = (15 * (utcHours - 12) + 2.4) * radians;
  const sunHeight =
    Math.sin(latitude) * Math.sin(declination) +
    Math.cos(latitude) * Math.cos(declination) * Math.cos(hourAngle);
  const twilight = Math.max(0, Math.min(1, (sunHeight + 0.12) / 0.3));
  const phase = twilight === 0 ? "night" : twilight === 1 ? "day" : hourAngle < 0 ? "dawn" : "dusk";
  return { light: twilight * twilight * (3 - 2 * twilight), phase };
}

function setSolarPhase(icon, phase) {
  if (icon.dataset.phase === phase) return;
  const [label, path] = solarIcons[phase];
  icon.dataset.phase = phase;
  icon.setAttribute("aria-label", label);
  icon.querySelector("path").setAttribute("d", path);
  icon.removeAttribute("hidden");
}

function updateReadout(now = performance.now(), force = false) {
  if (!meta || (!force && now - lastReadout < 80)) return;
  lastReadout = now;
  cityTemperatures?.update(shown, conditionsAt);
  queuePointerWeather();
  const date = hourDate(shown);
  const { light } = daylightAt(date);
  map.getContainer().style.setProperty("--map-daylight", light.toFixed(3));
  // The renderer recompiles its color ramp on palette changes.
  const paletteLight = Math.round(light * 2) / 2;
  if (paletteLight !== paletteDaylight) {
    paletteDaylight = paletteLight;
    effect.colorInterpolation = (t) => colorInterpolation(t, paletteLight);
    const colors = STOPS.map(([temperature]) => temperatureColor(temperature, paletteLight));
    legendPanel.querySelector(".legend-ramp").style.background =
      `linear-gradient(90deg,${colors.join(",")})`;
    map.triggerRepaint();
  }
  $("date-label").textContent = periodLabel ? "Année des ventes" : dateFormat.format(date);
  const clockDate = playing ? hourDate(Math.floor(shown * 2) / 2) : date;
  $("time-label").textContent = periodLabel ?? timeFormat.format(clockDate);
  setSolarPhase($("time-solar"), daylightAt(clockDate).phase);
  $("time-solar").hidden = !!periodLabel;
  const mean = $("viewport-mean");
  const start = Math.floor(shown);
  const a = means[start],
    b = means[Math.ceil(shown)];
  const zoneStale =
    summaryPending || map.isMoving() || $("zone-weather").hasAttribute("data-stale");
  if (!zoneStale)
    mean.textContent =
      Number.isFinite(a) && Number.isFinite(b)
        ? `${meanFormat.format(a + (b - a) * (shown - start))} °C`
        : "NA";
  const weather = $("viewport-weather");
  const from = regionalWeather[start],
    to = regionalWeather[Math.ceil(shown)];
  const fraction = shown - start;
  const kind =
    !summaryPending && from && to
      ? weatherKind({
          rain: from.rain + (to.rain - from.rain) * fraction,
          clouds: from.clouds + (to.clouds - from.clouds) * fraction,
        })
      : "";
  if (!zoneStale && !kind) {
    weather.textContent = "NA";
    delete weather.dataset.weather;
  }
  if (!zoneStale && kind && weather.dataset.weather !== kind) {
    const [description, path] = weatherIcons[kind];
    weather.dataset.weather = kind;
    weather.innerHTML = `<svg aria-hidden="true" viewBox="0 0 16 16" fill="none"
      stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
      <path d="${path}"/></svg>${description}`;
  }
  $("previous-day").disabled = !ready || selected < 24;
  $("next-day").disabled = !ready || selected + 24 > meta.hours - 1;
  $("time-slider").setAttribute("aria-valuetext", shortDate.format(hourDate(selected)));
}

function updateSolarCursor(hour) {
  const solarIcon = $("solar-icon");
  const progress = hour / Math.max(1, meta.hours - 1);
  solarIcon.style.left = `${progress * 100}%`;
  const { phase } = daylightAt(hourDate(hour));
  setSolarPhase(solarIcon, phase);
}

const tickDateFormat = new Intl.DateTimeFormat("fr-FR", {
  weekday: "short",
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
  timeZone: "Europe/Paris",
});

function updateTimeTicks(span) {
  const ticks = document.createDocumentFragment();
  const hourStep = span > 96 ? 6 : 3;
  for (let hour = 0; hour <= span; hour++) {
    const parts = tickDateFormat.formatToParts(hourDate(hour));
    const localHour = Number(parts.find((part) => part.type === "hour").value);
    const dayStart = localHour === 0 || hour === 0;
    if (!dayStart && localHour % hourStep !== 0) continue;
    const tick = document.createElement("span");
    tick.className = dayStart ? "time-tick day-tick" : "time-tick";
    tick.style.setProperty("--tick-position", `${(hour / Math.max(1, span)) * 100}%`);
    ticks.append(tick);
    if (dayStart) {
      const label = document.createElement("span");
      label.className = "time-tick-label";
      label.style.setProperty("--tick-position", tick.style.getPropertyValue("--tick-position"));
      const day = parts.find((part) => part.type === "day").value;
      const month = parts.find((part) => part.type === "month").value;
      const weekday = parts.find((part) => part.type === "weekday").value;
      label.textContent = `${weekday} ${day}/${month}`;
      ticks.append(label);
    }
  }
  $("time-ticks").replaceChildren(ticks);
}

function updateView() {
  const span = meta.hours - 1;
  $("time-slider").max = span;
  updateTimeTicks(span);
  $("time-slider").value = selected;
  updateTemperatureCurve();
}

const timelineTransitionMs = 360;
let curveFrame = 0;
let displayedCurve = [];
let curveFade;

function drawTemperatureCurve(points) {
  displayedCurve = points;
  const path = points
    .map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(" ");
  $("chart-line").setAttribute("d", path);
  $("chart-area").setAttribute(
    "d",
    points.length ? `${path} L${points.at(-1)[0]},54 L${points[0][0]},54 Z` : "",
  );
}

function updateTemperatureCurve() {
  const span = Math.max(1, meta.hours - 1);
  const lo = Math.min(...means.filter(Number.isFinite)) - 1,
    hi = Math.max(...means.filter(Number.isFinite)) + 1;
  const points = [];
  for (let hour = 0; hour <= span; hour++) {
    const t = means[hour];
    if (!Number.isFinite(t)) continue;
    points.push([(hour / span) * 1000, 48 - ((t - lo) / (hi - lo)) * 40]);
  }
  cancelAnimationFrame(curveFrame);
  const chart = $("time-chart");
  const opacity = Number(getComputedStyle(chart).opacity);
  curveFade?.cancel();
  const from = displayedCurve;
  if (reducedMotion.matches) {
    drawTemperatureCurve(points);
    return;
  }
  if (!points.length) {
    if (!from.length) return;
    curveFade = chart.animate([{ opacity }, { opacity: 0 }], {
      duration: timelineTransitionMs,
      fill: "forwards",
    });
    curveFade.finished.then(
      () => {
        drawTemperatureCurve([]);
        curveFade.cancel();
      },
      () => {},
    );
    return;
  }
  const canMorph =
    from.length === points.length && from.every(([x], index) => x === points[index][0]);
  if (!canMorph) {
    drawTemperatureCurve(points);
    curveFade = chart.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: timelineTransitionMs,
      easing: "ease-out",
    });
    return;
  }
  if (opacity < 1)
    curveFade = chart.animate([{ opacity }, { opacity: 1 }], { duration: timelineTransitionMs });
  const start = performance.now();
  function morph(now) {
    const progress = Math.min(1, (now - start) / timelineTransitionMs);
    const eased = progress * progress * (3 - 2 * progress);
    drawTemperatureCurve(
      points.map(([x, y], index) => [x, from[index][1] + (y - from[index][1]) * eased]),
    );
    if (progress < 1) curveFrame = requestAnimationFrame(morph);
  }
  curveFrame = requestAnimationFrame(morph);
}

let timelineWeatherConditions = [];
const timelineWeatherResize = new ResizeObserver(() =>
  updateTimelineWeather(timelineWeatherConditions),
);
timelineWeatherResize.observe($("timeline-weather"));

function updateTimelineWeather(conditions) {
  timelineWeatherConditions = conditions;
  const strip = $("timeline-weather");
  const existing = new Map(
    [...strip.children]
      .filter((icon) => !icon.hasAttribute("data-exiting"))
      .map((icon) => [icon.dataset.key, icon]),
  );
  const slots = Math.max(1, Math.floor(strip.clientWidth / 40));
  const minimumHours = Math.ceil(conditions.length / slots);
  const step =
    [1, 2, 3, 4, 6, 8, 12, 24, 48, 72, 168].find((hours) => hours >= minimumHours) ?? minimumHours;
  for (let start = 0; start < conditions.length; start += step) {
    const end = Math.min(start + step, conditions.length);
    const counts = new Map();
    for (const condition of conditions.slice(start, end)) {
      const kind = weatherKind(condition);
      if (kind) counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    const kind = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a))[0];
    if (!kind) continue;
    const [description, path] = weatherIcons[kind];
    const key = `${start}/${end}/${kind}`;
    if (existing.delete(key)) continue;
    const icon = document.createElement("span");
    icon.dataset.key = key;
    icon.dataset.weather = kind;
    const center = (start + end - 1) / 2;
    icon.style.left = `${(center / Math.max(1, meta.hours - 1)) * 100}%`;
    const period =
      end - start === 1
        ? shortDate.format(hourDate(start))
        : `${shortDate.format(hourDate(start))} – ${shortDate.format(hourDate(end - 1))}`;
    icon.innerHTML = `<svg viewBox="0 0 16 16" role="img"
      aria-label="${description}, ${period}"
      fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"
      stroke-linejoin="round"><path d="${path}"/></svg>`;
    strip.append(icon);
    if (!reducedMotion.matches) {
      icon.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: timelineTransitionMs,
        easing: "ease-out",
      });
    }
  }
  for (const icon of existing.values()) {
    if (reducedMotion.matches) {
      icon.remove();
      continue;
    }
    icon.dataset.exiting = "";
    icon.setAttribute("aria-hidden", "true");
    const opacity = getComputedStyle(icon).opacity;
    icon.getAnimations().forEach((animation) => animation.cancel());
    icon
      .animate([{ opacity }, { opacity: 0 }], { duration: timelineTransitionMs, fill: "forwards" })
      .finished.then(
        () => icon.remove(),
        () => {},
      );
  }
}

function queueViewportSummary() {
  if (!ready || !francePolygon) return;
  clearTimeout(summaryTimer);
  const id = ++summaryId;
  summaryPending = true;
  $("zone-weather").setAttribute("data-stale", "");
  summaryTimer = setTimeout(async () => {
    const bounds = localSceneBounds ?? map.getBounds().toArray().flat();
    sessionTrace?.event("météo", "Moyenne de zone demandée", { id, bounds, zoom: map.getZoom() });
    if (!field) return;
    const [result, weather] = await Promise.all([
      field.regionMeans(bounds).catch(() => null),
      Promise.resolve(atmosphere?.regionalConditions(bounds, francePolygon) ?? null),
    ]);
    regionalWeather = weather ?? [];
    if (id !== summaryId) return;
    summaryPending = false;
    if (!result) return;
    $("zone-weather").removeAttribute("data-stale");
    means = result;
    updateTemperatureCurve();
    updateTimelineWeather(regionalWeather);
    updateReadout(performance.now(), true);
  }, 180);
}

let moveTimer = 0;
/** The view to the temperature field's walk. */
function moveField() {
  clearTimeout(moveTimer);
  moveTimer = setTimeout(() => {
    if (!field || document.hidden) return;
    const [west, south, east, north] = map.getBounds().toArray().flat();
    field.move({ zoom: liveZoom(), bounds: [west, south, east, north] });
  }, 70);
}

function queueUpdate() {
  if (raf === null) raf = requestAnimationFrame(tick);
}
function tick(now) {
  raf = null;
  if (playing && lastFrame && now - lastFrame < PLAYBACK_INTERVAL - 1) {
    queueUpdate();
    return;
  }
  const elapsed = lastFrame ? Math.min(100, now - lastFrame) : 0;
  lastFrame = now;
  if (ready && !failed) {
    // one hour of the run per second; the field blends the two hours on the GPU
    if (playing) {
      playedHours += Math.min(meta.hours - 1, selected + elapsed / 1000) - selected;
      selected = Math.min(meta.hours - 1, selected + elapsed / 1000);
      if (selected >= meta.hours - 1) pause();
    }
    $("time-slider").value = selected;
    updateSolarCursor(selected);
    shown = selected;
    field?.setHour(shown);
    if (renderReady) map.triggerRepaint();
    updateReadout(now, !playing && !map.isMoving());
  }
  if (playing) queueUpdate();
}

map.on("move", queueUpdate);
map.on("move", moveField);
map.on("moveend", queueViewportSummary);
map.on("zoomend", () => {
  map.triggerRepaint();
  queueUpdate();
});
map.on("error", (event) => {
  console.warn("[weather-map]", event.error?.message || event.error);
});
$("play").onclick = () => {
  if (playing) pause();
  else {
    if (selected >= meta.hours - 1) selected = 0;
    playing = true;
    lastFrame = 0;
    $("play").setAttribute("data-playing", "");
    $("play").setAttribute("aria-label", "Mettre en pause");
    queueUpdate();
  }
};
function seek(value) {
  if (!meta) return;
  pause();
  selected = Math.max(0, Math.min(meta.hours - 1, value));
  queueUpdate();
}
$("previous-day").onclick = () => seek(selected - 24);
$("next-day").onclick = () => seek(selected + 24);
$("time-slider").oninput = (event) => seek(Number(event.target.value));
$("time-slider").onkeydown = (event) => {
  if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
    event.preventDefault();
    seek(selected + (event.key === "ArrowRight" ? 1 : -1));
  }
};
document.addEventListener("visibilitychange", () => {
  if (document.hidden) pause();
});
window.addEventListener("pagehide", () => {
  for (const dispose of beforeRemove) dispose();
  beforeRemove.clear();
  thumbZoomControl.cancel();
  cancelAnimationFrame(pointerFrame);
  clearTimeout(pointerIdleTimer);
  timelineWeatherResize.disconnect();
  controlsResize.disconnect();
  clearTimeout(summaryTimer);
  cancelAnimationFrame(curveFrame);
  cityTemperatures?.remove();
  effectsLayer?.remove();
  temperatureHeat?.destroy();
  clearTimeout(moveTimer);
  field?.destroy();
  map.remove();
});

// Read-only diagnostics for local QA; not needed by the application flow.
globalThis.weatherDebug = {
  get state() {
    return {
      ready,
      renderReady,
      selected,
      shown,
      playing,
      cellCount: field?.controller.getPackedData().count ?? 0,
      transition: field?.controller.getTransitionFactor() ?? 1,
      atmosphereCells: atmosphere ? atmosphere.size ** 2 : 0,
    };
  },
};
export const weatherView = {
  map,
  initialized: initializeMap().catch((error) => {
    fail(error);
    return null;
  }),
  beforeRemove(dispose) {
    beforeRemove.add(dispose);
    return () => beforeRemove.delete(dispose);
  },
  get hour() {
    return shown;
  },
  get boundary() {
    return francePolygon;
  },
  get date() {
    return meta ? hourDate(shown) : null;
  },
  get playing() {
    return playing;
  },
  setPeriod(label) {
    periodLabel = label;
    if (label) pause();
    updateReadout(performance.now(), true);
  },
  loadedGrid() { return field?.loadedGrid()??null; },
  conditionsAt(coordinates) {
    const values = conditionsAt(coordinates, shown);
    return (
      values && {
        ...values,
        observedRain: values.rain,
        rain: rainToggle.checked ? values.rain : 0,
        clouds: cloudToggle.checked ? values.clouds : 0,
      }
    );
  },
  setLocalScene(active, bounds) {
    document.body.classList.toggle("local-scene-active", active);
    localSceneActive = active;
    localSceneBounds = active && bounds ? bounds.flat() : null;
    queueViewportSummary();
    updateAnimationLayers();
  },
  setVisible(visible) {
    if (weatherVisible === visible) return;
    weatherVisible = visible;
    document.body.classList.toggle("weather-hidden", !visible);
    if (visible) {
      ensureAtmosphere();
      startPipelines().catch(fail);
      if (townsDeferred) loadTowns().catch((error) => console.warn("[weather-cities]", error.message));
    } else stopPipelines();
    syncTemperatureVisibility();
    cityTemperatures?.setVisible(visible);
    updateAnimationLayers();
    map.triggerRepaint();
  },
  setTemperature(visible) {
    temperatureToggle.checked = visible;
    temperatureToggle.dispatchEvent(new Event("change"));
  },
};
load();
