// DVF 2020 on the Explore map, through the SDK's heat pipeline v2: the worker
// reads IXB2 blocks and walks the view, the main thread packs the cells on the
// GPU and the map's WebGPU renderer drapes them on what it draws
// (heatDrape.js). Sale labels take over at street zoom. Rules and summary:
// data/dvf.js.
//
// In the 3D scene the heat stays out of the scene's disc (heatDrape.js): the
// sales go to the roofs instead, through options.sales(readings) (every sale
// of the point overlay: saleReadings; [] when there is none).
//
// Handle: setVisible(value), summary() (summarizeDvf of the last view: sales,
// averages per sale; null without WebGPU), destroy().
import HeatWorker from "js-indexus-sdk/map/heat-worker?worker";
import {
  COLLECTION_DEFAULTS,
  createHeatmapPipeline,
  showWebGPUUnsupported,
  webgpuSupport,
} from "js-indexus-sdk/map";
import {
  DVF_CELL_POSITION,
  DVF_COLLECTION,
  DVF_HEAT,
  DVF_VALUE_METRIC_INDEX,
  DVF_VISUAL,
  summarizeDvf,
} from "../../data/dvf.js";
import { getExperienceConfiguration } from "../../data/network.js";
import { dvfHeatOpacity, dvfRenderScale } from "../weather/renderBudget.js";
import { onSessionTrace } from "./diagnostics/trace.js";
import { addSaleLabels, saleReadings } from "./saleLabels.js";
import { DVF_COLORS, DVF_INTERPOLATION, DVF_NORMALIZER } from "./priceRamp.js";
import { mapRenderer } from "../../rendering/gpu/mapRenderer.js";
import { HeatDrape } from "../../rendering/gpu/heatDrape.js";
import { Fade } from "../../rendering/fade.js";

const MAX_ZOOM = 18;
const LABEL_ZOOM = 14;
const HEAT_FADE = 400; // ms of the heat's fade when a zoom or the sale cards switch it
const MOVE_DELAY_MS = 70;

function addLegend(map) {
  const legend = document.createElement("div");
  legend.className = "dvf-legend";
  legend.hidden = true;
  const ramp = document.createElement("i");
  const stops = Array.from({ length: 25 }, (_, i) => DVF_INTERPOLATION(i / 24));
  ramp.style.background = `linear-gradient(90deg,${stops.join(",")})`;
  const caption = document.createElement("span");
  caption.textContent = "0 — 10 000 €/m² · Maisons · DVF 2020";
  legend.append(ramp, caption);
  map.getContainer().append(legend);
  return legend;
}

/** Without WebGPU the map says so; the notice is the weather layer's too. */
function unsupported(map, onStatus) {
  showWebGPUUnsupported(map.getContainer(), { reason: webgpuSupport().reason ?? "no-adapter" });
  return {
    setVisible(value) {
      if (value) onStatus("Immobilier indisponible : ce navigateur ne fournit pas WebGPU");
    },
    summary: () => null,
    destroy() {},
  };
}

export async function addRealEstate(map, gpu, onStatus, mask, options = {}) {
  if (!gpu?.supported) return unsupported(map, onStatus);
  const { project, highlight, is3d = () => false, sales = () => {} } = options;
  let trace = null;
  let moveId = 0;
  onSessionTrace((value) => {
    trace = value;
  });
  const configuration = await getExperienceConfiguration();
  const worker = new HeatWorker();
  const effect = {
    ...DVF_VISUAL,
    smoothEdge: 0,
    fading: 0,
    colors: DVF_COLORS,
    colorInterpolation: DVF_INTERPOLATION,
  };
  const heat = createHeatmapPipeline({
    worker,
    collection: DVF_COLLECTION,
    device: gpu.device,
    heat: DVF_HEAT,
    summarize: summarizeDvf,
    cellPosition: DVF_CELL_POSITION,
    normalizer: DVF_NORMALIZER,
    effect,
  });
  let enabled = false;
  let pointMode = false;
  let heatFade = null, // the heat's opacity, eased in time (getHeatmapOpacity)
    heatOff = false;
  const labels = addSaleLabels(map, project, highlight);
  const legend = addLegend(map);

  // The pipeline's controller, with Explore's camera, render budget and fades.
  const controller = {
    ...heat.controller,
    getZoom: () => Math.min(MAX_ZOOM, map.getZoom()),
    getRenderScale() {
      const container = map.getContainer();
      const ratio = map.getPixelRatio();
      return dvfRenderScale(container.clientWidth, container.clientHeight, ratio);
    },
    getHeatmapOpacity() {
      // the 3D scene shown: the heat fades out on the whole map as before the
      // single renderer (gone from zoom 16, back with the same fade), and never
      // inside the scene's disc (heatDrape.js). Its steps (a zoom crossed, the
      // sale cards coming) fade over HEAT_FADE ms: frames are asked for while it runs
      const now = performance.now(),
        target = dvfHeatOpacity(map.getZoom(), { scene: is3d(), points: pointMode, labelZoom: LABEL_ZOOM });
      if (!heatFade) heatFade = new Fade(target, HEAT_FADE);
      heatFade.set(target, now);
      if (heatFade.active(now)) map.triggerRepaint();
      else if (target === 0 && is3d() && !heatOff) {
        // faded out with the scene: the layer goes off (visibility), once
        heatOff = true;
        queueMicrotask(() => {
          heatOff = false;
          visibility();
        });
      }
      return heatFade.value(now);
    },
  };
  // drawn by the map's WebGPU renderer, draped on what the frame shows
  const renderer = await mapRenderer(map);
  if (!renderer) return unsupported(map, onStatus);
  const layer = new HeatDrape(renderer, "dvf", controller, gpu.features, {
    onDeviceLost: (info) => heat.controller.onDeviceLost(info),
    onDeviceRestored: (next) => heat.controller.onDeviceRestored(next),
  });
  if (mask) layer.initializeMask(mask);
  layer.setMaskEnabled(!!mask);
  layer.visible = false;
  heat.registerRepaint(() => map.triggerRepaint());

  // Sale labels need each sale's metrics, which the point overlay leaves out.
  let salesShown = "";
  function showSales(payload, pointsBuffer) {
    if (payload.showPoints && pointsBuffer) {
      pointMode = true;
      const points = new Float32Array(pointsBuffer);
      labels.update(points, payload.pointMetrics, payload.pointKeys);
      reportSales(saleReadings(points, payload.pointMetrics, payload.pointKeys));
    } else if (!payload.pointsPending) {
      pointMode = false;
      labels.update(new Float32Array());
      reportSales([]);
    }
  }
  function reportSales(readings) {
    const signature = readings.map((r) => r.coordinates.join("/") + ":" + r.price).join(",");
    if (signature === salesShown) return;
    salesShown = signature;
    sales(readings);
  }

  worker.addEventListener("message", ({ data }) => {
    const { type, payload } = data;
    if (type === "NETWORK_ACTIVITY") {
      for (const event of payload?.events ?? []) trace?.network("réseau DVF", event);
    }
    if (type === "ERROR") onStatus(`DVF : ${payload}`);
    if (type !== "PLAN" && type !== "VIEWPORT") return;
    showSales(payload, data.pointsBuffer);
    if (type !== "PLAN") return;
    trace?.event("DVF", "Plan reçu", {
      instances: payload.instanceCount,
      snapshot: payload.snapshotVersion,
      dataDriven: !!payload.dataDriven,
      emptyConfirmed: payload.emptyConfirmed,
    });
    if (enabled) {
      const count = payload.instanceCount.toLocaleString("fr-FR");
      onStatus(`DVF 2020 · ${count} agrégats visibles · prix de vente au m²`);
    }
  });

  heat.init({
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
    cubeOpt: { limit: 5, children: 4, resolution: 5 },
    pointOverlay: { maxPoints: COLLECTION_DEFAULTS.pointOverlayMaxPoints },
    polygonFilterEnabled: true,
    valueMetricIndex: DVF_VALUE_METRIC_INDEX,
    childVirtualizationEnabled: false,
  });

  function move() {
    if (!enabled || document.hidden) return;
    const b = map.getBounds();
    const segment = [b.getSouth(), b.getNorth(), b.getWest(), b.getEast()];
    const zoom = Math.min(MAX_ZOOM, map.getZoom());
    trace?.event("DVF", "Vue demandée", { id: ++moveId, zoom, bounds: segment });
    const bounds = [{ dimension: 0, segment }];
    heat.move({ zoom, bounds, strictBounds: bounds });
  }

  let timer = 0;
  const schedule = () => {
    if (timer || !enabled) return;
    timer = setTimeout(() => {
      timer = 0;
      move();
    }, MOVE_DELAY_MS);
  };

  let readVisible = null;
  function visibility() {
    // (on until its fade out is over)
    layer.visible =
      enabled && (!is3d() || dvfHeatOpacity(map.getZoom(), { scene: true }) > 0 || !!heatFade?.active(performance.now()));
    // wherever the roofs carry the prices (the 3D shown), their cards are shown too
    labels.setVisible(enabled && (is3d() || map.getZoom() >= LABEL_ZOOM));
    legend.hidden = !enabled;
    const active = enabled && !document.hidden;
    if (active !== readVisible) {
      readVisible = active;
      trace?.event("DVF", "Visibilité et lectures", {
        visible: active,
        cancellationRequested: !active,
      });
      heat.controller.setReadVisibility(active);
      if (active) move();
    }
    map.triggerRepaint();
  }

  document.addEventListener("visibilitychange", visibility);
  map.on("move", schedule);
  map.on("moveend", schedule);
  map.on("zoom", visibility);
  return {
    setVisible(value) {
      if (enabled === value) return visibility();
      enabled = value;
      visibility();
      if (value) {
        onStatus("Chargement des agrégats DVF…");
        move();
      }
    },
    summary: () => heat.controller.getPointOverlay().stats.summary ?? null,
    destroy() {
      clearTimeout(timer);
      map.off("move", schedule);
      map.off("moveend", schedule);
      map.off("zoom", visibility);
      document.removeEventListener("visibilitychange", visibility);
      heat.destroy();
      reportSales([]);
      labels.destroy();
      legend.remove();
      layer.destroy();
    },
  };
}
