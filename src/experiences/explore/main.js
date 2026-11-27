// First: with ?bench its worker probe must be in place before any worker starts.
import "./diagnostics/bench.js";
import "./diagnostics/contexts.js";
import { MapTheme } from "./mapTheme.js";
import { overviewPixelRatio } from "../weather/renderBudget.js";
import { createLoadIndicator } from "./loadIndicator.js";
import { onSessionTrace } from "./diagnostics/trace.js";
import { observeExperienceNetwork, getExperienceNetwork } from "../../data/network.js";
import { weatherView } from "../weather/main.js";
import { readScenes } from "../../data/scenes.js";
import { sceneBounds, sceneGeometry } from "./policy.js";
import { sceneZone } from "../../data/sceneZone.js";
import { addSceneExplorer } from "./scene.js";
import { installCameraFloor } from "./cameraFloor.js";
import { addRealEstate } from "./realestate.js";
import { addLocalSales } from "./localSales.js";
import { mapCameraWatch } from "./saleLabels.js";
import { createExploreCommands } from "./commands.js";
import { createScenePanel } from "./scenePanel.js";
import { TerrainTiles } from "../point-cloud/terrainTiles.js";
import { createCommandPalette } from "./commandPalette.js";
import { datasetLayers, parseDataset } from "./datasets.js";
import * as maplibregl from "maplibre-gl";
import "./style.css";
import { measureMap } from "../../rendering/metrics.js";
import { installHud } from "./diagnostics/hud.js";

const map = weatherView.map;
// the centre on the ground, the camera down to a walker's eye (cameraFloor.js)
installCameraFloor(map, { firstPerson: () => document.body.dataset.firstPerson === "true" });
// diagnostics (bench): the map from the start of the page
if (new URLSearchParams(location.search).has("profile3d")) globalThis.__indexusMap = map;
// resource HUD (the info panel, "h" or ?hud): MapLibre's frame time and every layer's measurements
const stopMapMeasure = measureMap(map);
let sessionTrace = null,
  stopCameraTrace = () => {};
onSessionTrace((trace, { traceCamera }) => {
  if (disposed) return;
  sessionTrace = trace;
  stopCameraTrace = traceCamera(map, trace);
});
const loading = createLoadIndicator(),
  hud = installHud(loading.info);
loading.begin("read", "Connexion Indexus");
let pendingNetwork = 0;
const stopNetworkActivity = observeExperienceNetwork((event) => {
  sessionTrace?.network("réseau principal", event);
  pendingNetwork = Math.max(0, pendingNetwork + (event.phase === "start" ? 1 : -1));
  loading.network("main", pendingNetwork);
});
const status = document.createElement("span");
status.id = "explore-status";
status.setAttribute("role", "status");
const setStatus = (text) => {
  status.textContent = text;
};
const $ = (id) => document.getElementById(id);
$("map").setAttribute("aria-label", "Carte Indexus · Immobilier, météo et LiDAR 3D");
let dvf,
  geometry,
  scenePanel,
  localSales,
  dvfPending,
  disposed = false,
  active3d = false,
  gpu,
  basemapTheme;
const parameters = new URLSearchParams(location.search);
const localOnly = import.meta.env.VITE_DEMO_MODE === "1" || parameters.get("scene") === "anglet-mini" || import.meta.env.VITE_DEFAULT_SCENE === "anglet-mini";
const localLayers = { ortho: true, buildings: true, dvf: !localOnly };
let dataset = parseDataset(parameters.get("data") ?? import.meta.env.VITE_DEFAULT_DATASET),
  weatherEnabled = true,
  enabled3d = true,
  selectedPlace = "";
if (localOnly && dataset === "realestate") dataset = "weather";
let mapTheme = parameters.get("theme") === "dark" ? "dark" : "light";
document.body.dataset.mapTheme = mapTheme;
loading.configure({
  getWork: () => geometry?.workState(),
  // the info panel's sliders (viewerSettings.js), kept per viewer
  onSettings(key, value) {
    sessionTrace?.event("session", "Réglage", { key, value });
    if (key === "refreshRate") geometry?.setRefreshRate(value);
    else geometry?.setResolution(value);
  },
});
// an old link's data=both is the sales now: the address says so
if (parameters.has("data") && parameters.get("data") !== dataset) {
  const url = new URL(location.href);
  url.searchParams.set("data", dataset);
  history.replaceState(null, "", url);
}
const scenes = [];
const timeControls = document.querySelector(".timeline-controls");
function updateTimeControls() {
  const { temporal } = datasetLayers(dataset, weatherEnabled);
  timeControls.hidden = !temporal;
  $("timeline").hidden = !temporal;
  document.querySelector(".readout-date").hidden = !temporal;
  $("dataset-label").hidden = !temporal;
  if (!temporal && weatherView.playing) $("play").click();
}
updateData();
function updateData() {
  document.body.dataset.dataset = dataset;
  // MapLibre draws the photo, roads and labels at the screen's ratio, with the 3D
  // or without; the 3D keeps one pixel per CSS pixel (mapRenderer.js engine scale)
  const ratio = overviewPixelRatio(devicePixelRatio);
  if (map.getPixelRatio() !== ratio) map.setPixelRatio(ratio);
  const layers = datasetLayers(dataset, weatherEnabled);
  weatherView.setVisible(layers.weather);
  weatherView.setPeriod(layers.period);
  updateTimeControls();
  dvf?.setVisible(layers.realestate);
  if (dataset === "weather" && !active3d)
    setStatus("Météo · date commune à la carte et à la frise");
}
/** The sale cards' projection (saleLabels.js): the scene's while it is shown, else the map's. */
function saleProjection() {
  const moved = mapCameraWatch(map);
  let was3d = null;
  const project = (coordinates, width, height) =>
    geometry?.active ? geometry.projectLocation(coordinates, width, height) : map.project(coordinates);
  project.changed = () => {
    const is3d = !!geometry?.active,
      switched = is3d !== was3d,
      // both watches see every pass: neither misses a move
      flat = moved(),
      scene = geometry ? geometry.projectionChanged() : true;
    was3d = is3d;
    return switched || (is3d ? scene : flat);
  };
  return project;
}
/**
 * One dataset at a time: the weather OR the sales. The one left goes whole
 * (its pipelines and workers: no read in the background); the one chosen is
 * made again.
 */
async function chooseData(value) {
  sessionTrace?.event("session", "Jeu de données", { value });
  dataset = value;
  updateParameter("data", value);
  if (!datasetLayers(value).realestate) dropRealEstate();
  updateData();
  if (datasetLayers(value).realestate && !dvf) {
    if (!active3d) setStatus("Connexion à la collection DVF…");
    const pending = (dvfPending ??= addRealEstate(
      map,
      gpu,
      (text) => {
        if (datasetLayers(dataset).realestate && !active3d) setStatus(text);
      },
      weatherView.boundary,
      {
        highlight: (building, color) => geometry?.highlightBuilding(building, color),
        is3d: () => !!geometry?.active,
        project: saleProjection(),
        // the sales on the roofs of the 3D scene (scene.js setSales)
        sales: (readings) => geometry?.setSales(readings),
      },
    ));
    let handle;
    try {
      handle = await pending;
    } catch (error) {
      if (dvfPending === pending) dvfPending = null;
      if (dataset === value) {
        dataset = "weather";
        updateData();
      }
      throw error;
    }
    // the weather was chosen again while the sales were being made, or the page went
    if (disposed || dvfPending !== pending || !datasetLayers(dataset).realestate) {
      if (dvfPending === pending) dvfPending = null;
      handle.destroy();
      return;
    }
    dvf = handle;
  }
  updateData();
}
function dropRealEstate() {
  dvfPending = null;
  geometry?.setSales([]);
  if (!dvf) return;
  dvf.destroy();
  dvf = null;
}
function setToggle(id, value) {
  const input = $(id);
  if (input.checked === value) return;
  input.checked = value;
  input.dispatchEvent(new Event("change"));
}
function visitScene(scene) {
  selectedPlace = scene.id;
  geometry?.setPreferredScene(scene.id);
  const url = new URL(location.href);
  if (localOnly) url.searchParams.delete("scene");
  else url.searchParams.set("scene", scene.id);
  history.replaceState(null, "", url);
  map.setVerticalFieldOfView(36.87);
  const radius = scene.radius;
  // the centre follows the ground (cameraFloor.js): no elevation to set
  map.flyTo({
    // a disc: its centre; a contour (a commune): its origin, the scene's address
    center:
      scene.zone?.kind === "polygon"
        ? scene.origin
        : [(scene.bounds[0][0] + scene.bounds[1][0]) / 2, (scene.bounds[0][1] + scene.bounds[1][1]) / 2],
    zoom: Math.max(16.4, 17.6 - Math.log2(radius / 100)),
    pitch: 50,
    bearing: -20,
    duration: matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 1000,
  });
}
function updateParameter(key, value) {
  sessionTrace?.event("session", "Réglage", { key, value });
  const url = new URL(location.href);
  url.searchParams.set(key, String(value));
  history.replaceState(null, "", url);
}
function setMapTheme(value) {
  mapTheme = value === "dark" ? "dark" : "light";
  document.body.dataset.mapTheme = mapTheme;
  basemapTheme?.set(mapTheme);
  updateParameter("theme", mapTheme);
  palette.refresh();
}
const commands = createExploreCommands({
  state: () => ({
    localOnly,
    dataset,
    mapTheme,
    enabled3d,
    active3d,
    geometry,
    ready: !!gpu,
    scenes,
    selectedPlace,
  }),
  control: $,
  actions: {
    chooseData,
    setMapTheme,
    visitScene,
    openScene() {
      geometry.setEnabled(true);
      enabled3d = true;
      visitScene(scenes.find((s) => s.id === selectedPlace) ?? scenes[0]);
    },
    hideScene() {
      enabled3d = false;
      geometry.setEnabled(false);
    },
    async toggleWeather(id) {
      if (!datasetLayers(dataset).weather) await chooseData("weather");
      setToggle(id, !$(id).checked);
    },
    async toggleTarget() {
      if (!datasetLayers(dataset).weather) await chooseData("weather");
      $("pointer-toggle").click();
    },
  },
});
const palette = createCommandPalette({
  commands,
  status,
  context: () =>
    `${{ weather: "Météo", realestate: "Immobilier · 2020" }[dataset]}${active3d ? " + 3D" : ""}${selectedPlace ? " · " + (scenes.find((s) => s.id === selectedPlace)?.label ?? selectedPlace) : ""}`,
});
const availability = new MutationObserver((records) => {
  if (
    records.some((record) => record.oldValue !== record.target.getAttribute(record.attributeName))
  )
    palette.refresh();
});
availability.observe(document.querySelector(".timeline-controls"), {
  subtree: true,
  attributes: true,
  attributeOldValue: true,
  attributeFilter: ["disabled"],
});
const catalogueAbort = new AbortController();
weatherView.beforeRemove(() => {
  disposed = true;
  catalogueAbort.abort();
  stopCameraTrace();
  stopNetworkActivity();
  loading.destroy();
  availability.disconnect();
  palette.destroy();
  geometry?.destroy();
  dropRealEstate();
  sessionTrace?.close();
  scenePanel?.destroy();
  localSales?.destroy();
  hud.destroy();
  stopMapMeasure();
});
async function initialize() {
  gpu = await weatherView.initialized;
  if (disposed) return;
  if (!gpu) throw Error("Initialisation de la carte impossible.");
  basemapTheme = new MapTheme(map);
  basemapTheme.set(mapTheme);
  palette.refresh();
  if (datasetLayers(dataset).realestate) await chooseData(dataset);
  // Each scene is a record at its origin (SceneExplo2026v1): frame, photo, collections.
  const network = await getExperienceNetwork(),
    catalogue = await readScenes(network, { signal: catalogueAbort.signal });
  const loaded = catalogue.map((entry) => {
    // the scene's zone: its contour (a commune), or the disc of its radius as before
    const zone = sceneZone(entry),
      scene = { ...entry, zone, radius: zone.radius };
    return { ...scene, bounds: sceneBounds(scene, maplibregl.MercatorCoordinate), tiles: new TerrainTiles(network, entry.collections.terrain, entry) };
  });
  if (!loaded.length) throw Error("Aucun extrait disponible dans le catalogue");
  if (disposed) return;
  scenes.push(...loaded);
  palette.refresh();
  const features = scenes.map((s) => ({
    type: "Feature",
    properties: { id: s.id, label: s.label },
    geometry: sceneGeometry(s, maplibregl.MercatorCoordinate),
  }));
  map.addSource("explore-coverage", {
    type: "geojson",
    data: { type: "FeatureCollection", features },
  });
  map.addLayer({
    id: "explore-coverage-fill",
    type: "fill",
    source: "explore-coverage",
    paint: { "fill-color": "#a7dbc6", "fill-opacity": 0.09 },
  });
  map.addLayer({
    id: "explore-coverage-line",
    type: "line",
    source: "explore-coverage",
    paint: { "line-color": "#caeddd", "line-width": 1.5, "line-dasharray": [3, 3] },
  });
  geometry = addSceneExplorer(
    map,
    scenes,
    setStatus,
    (active, bounds, local = true) => {
      active3d = active;
      weatherView.setLocalScene(active && local, bounds);
      updateData();
      palette.refresh();
    },
    // the 3D's rain and clouds are the weather's: none while the sales are shown
    (coordinates) => (datasetLayers(dataset, weatherEnabled).weather ? weatherView.conditionsAt(coordinates) : null),
    () => weatherView.date,
    loading,
  );
  geometry.setRefreshRate(loading.settings.refreshRate);
  geometry.setResolution(loading.settings.resolution);
  scenePanel = createScenePanel({
    map,
    guided: localOnly,
    visitLocal: () => visitScene(scenes[0]),
    visitOverview: () => map.flyTo({center:[2.4,46.6],zoom:5.25,pitch:0,bearing:0,duration:matchMedia("(prefers-reduced-motion: reduce)").matches?0:1100}),
    setLayerVisible(role, visible) {
      if (role === "dvf") { localLayers.dvf=visible;localSales?.setEnabled(visible); return; }
      if (role in localLayers) localLayers[role] = visible;
      geometry?.setLayerVisible(role, visible);
      if (role === "weather") {
        weatherEnabled = visible;
        updateData();
      }
    },
    getLoadedGrid: role => role === "weather" ? weatherView.loadedGrid() : geometry?.loadedGrid(role),
    setGridCells: cells => geometry?.setGridCells(cells),
    projectGridCell: cell => geometry?.projectGridCell(cell),
    setNearby: (...args) => geometry?.setNearby(...args),
    pickNearby: point => geometry?.pickNearby(point),
    getNearbyDetails: row => geometry?.nearbyDetails(row),
    getScene: () => scenes.find(scene => scene.id === selectedPlace) ?? scenes[0],
    getNetwork: getExperienceNetwork,
  });
  if (localOnly) {
    localSales = await addLocalSales({map,network,scene:scenes[0],geometry,
      isVisible:()=>!!geometry?.active && localLayers.ortho && localLayers.buildings,
      project:saleProjection()});
    localSales.setEnabled(localLayers.dvf);
  }
  map.on("click", "explore-coverage-fill", (event) => {
    if (active3d) return;
    const scene = scenes.find((s) => s.id === event.features[0].properties.id);
    if (scene) visitScene(scene);
  });
  setStatus(`${scenes.length === 1 ? scenes[0].label : scenes.length + " extraits LiDAR"} · LiDAR 3D`);
  palette.refresh();
  const requested = scenes.find(
    (scene) => scene.id === (new URLSearchParams(location.search).get("scene") ?? import.meta.env.VITE_DEFAULT_SCENE),
  );
  if (requested && !localOnly) visitScene(requested);
  else loading.hide();
}
initialize().catch((error) => {
  catalogueAbort.abort();
  if (disposed) return;
  loading.fail(error.message);
  setStatus(error.message);
  palette.refresh();
});
