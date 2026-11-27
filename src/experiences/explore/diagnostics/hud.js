// Resource HUD: live curves of the last 30 s from the metrics registry
// (src/rendering/metrics.js). Toggled by the "h" key or ?hud; nothing runs
// while it is closed (no timer, no observer: the registry stops too).
// One canvas, redrawn 4 times a second. Each panel has one unit; a dashed red
// line is the budget of that panel. Hover a panel to read the values at a time.
import { metrics } from "../../../rendering/metrics.js";

const SPAN = 30000,
  PANEL = 64,
  GAP = 20,
  PAD = 8,
  SURFACE = "#1a1a19",
  INK = "#f0efec",
  INK2 = "#c3c2b7",
  MUTED = "#898781",
  GRID = "#2c2c2a",
  BUDGET = "#d03b3b";
// a fixed colour per layer (categorical slots in order, dark steps): never re-assigned
const LAYERS = [
  ["buildings", "#3987e5"],
  ["ground", "#d95926"],
  ["vegetation", "#199e70"],
  ["ortho", "#c98500"],
  ["heat", "#d55181"],
  ["map", "#9085e9"],
  ["other", "#c3c2b7"],
];
const colorOf = (layer) => (LAYERS.find(([l]) => l === layer) ?? LAYERS.at(-1))[1];
const DRAWN = ["buildings", "ground", "vegetation", "ortho", "heat"];
// the scene renderer's passes (gpu.<pass>) and the layer whose colour they take
const PASSES = { temperature: "heat", dvf: "heat" };
const mb = (v) => (v / 1048576).toFixed(1);

/** Panels: title, unit, budget, series [key, label, layer, mode] (mode: max | rate | last). */
function panels(keys, gpuSupported) {
  const layered = (suffix, mode) =>
    DRAWN.filter((l) => keys.includes(l + "." + suffix)).map((l) => [l + "." + suffix, l, l, mode]);
  const work = [...DRAWN, "scene"].filter((l) => keys.includes(l + ".work")).map((l) => [l + ".work", l + " work", l, "max"]);
  return [
    { title: "Frame time", unit: "ms", budget: 16.7, series: [["frame.ms", "frame", "map", "max"]], floor: 33 },
    {
      title: "Main thread per frame",
      unit: "ms",
      budget: 4,
      series: [
        ["main.ms", "map + jobs", "map", "max"],
        ["main.budget", "scene budget", "other", "max"],
        ["map.renderMs", "map render", "map", "max"],
        ...work,
        ["main.blockingMs", "blocking", "other", "max"],
      ],
      floor: 8,
    },
    gpuSupported
      ? {
          title: "GPU per pass",
          unit: "ms",
          budget: 8,
          series: keys.filter((k) => k.startsWith("gpu.")).map((k) => [k, k.slice(4), PASSES[k.slice(4)] ?? k.slice(4), "last"]),
          floor: 4,
        }
      : { title: "GPU per pass", note: "n/a: the WebGPU device has no timestamp-query" },
    { title: "Network", unit: "kB/s", scale: 1 / 1024, series: [...layered("bytes", "rate"), ["net.bytes", "page total", "other", "rate"]], floor: 64 },
    { title: "Reads in flight / queued", unit: "reads", budget: 6, series: [["net.inflight", "in flight", "map", "last"], ["net.queued", "queued", "other", "last"]], floor: 8 },
    { title: "Memory", unit: "MB", scale: 1 / 1048576, series: [["memory.jsHeap", "JS heap", "other", "last"], ...layered("gpuBytes", "last")], floor: 64 },
    { title: "Items drawn", unit: "items", series: layered("items", "last"), floor: 100 },
  ];
}

/** Column values of one series over the window: max, rate (per second) or last. */
function columns(w, key, mode, n) {
  const values = w.get(key),
    t = w.t,
    end = t.length ? t[t.length - 1] : 0,
    out = new Float32Array(n).fill(NaN),
    sums = new Float32Array(n),
    seen = new Uint8Array(n);
  for (let i = 0; i < t.length; i++) {
    const c = Math.min(n - 1, Math.floor(((t[i] - (end - SPAN)) / SPAN) * n));
    if (c < 0) continue;
    const v = values[i];
    if (mode === "rate") sums[c] += v;
    else if (mode === "max") out[c] = seen[c] ? Math.max(out[c], v) : v;
    else out[c] = v;
    seen[c] = 1;
  }
  if (mode === "rate") for (let c = 0; c < n; c++) out[c] = seen[c] ? sums[c] / (SPAN / n / 1000) : NaN;
  return out;
}

/**
 * The HUD's panel. embedded: drawn inside another panel (the info panel of
 * performanceDock.js), which places it and closes it; else a fixed panel of its own.
 */
export function createHud(parent = document.body, { embedded = false, width = 380 } = {}) {
  const W = width,
    root = document.createElement("div");
  root.className = "resource-hud";
  root.setAttribute("role", "region");
  root.setAttribute("aria-label", "Ressources : courbes des 30 dernières secondes");
  if (embedded) Object.assign(root.style, { color: INK, font: "11px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace" });
  else Object.assign(root.style, {
    position: "fixed",
    right: "12px",
    top: "12px",
    zIndex: 50,
    width: W + "px",
    background: SURFACE,
    color: INK,
    font: "11px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace",
    borderRadius: "8px",
    boxShadow: "0 4px 18px #0008",
    padding: "6px 0 8px",
    maxHeight: "calc(100vh - 24px)",
    overflow: "auto",
  });
  root.innerHTML =
    '<div style="display:flex;gap:8px;align-items:center;padding:0 8px 4px"><strong style="flex:1">Ressources · 30 s</strong>' +
    '<button type="button" data-export style="font:inherit">Export JSON</button>' +
    (embedded ? "" : '<button type="button" data-close aria-label="Fermer" style="font:inherit">×</button>') +
    "</div>" +
    '<div data-head style="padding:0 8px 4px;color:#c3c2b7"></div><canvas></canvas><div data-events style="padding:4px 8px 0;color:#c3c2b7;white-space:pre-wrap"></div>';
  parent.append(root);
  const canvas = root.querySelector("canvas"),
    head = root.querySelector("[data-head]"),
    events = root.querySelector("[data-events]"),
    context = canvas.getContext("2d"),
    ratio = Math.min(devicePixelRatio || 1, 2);
  let hover = null,
    layout = [];
  canvas.addEventListener("pointermove", (e) => {
    const box = canvas.getBoundingClientRect();
    hover = { x: e.clientX - box.left, y: e.clientY - box.top };
    draw();
  });
  canvas.addEventListener("pointerleave", () => {
    hover = null;
    draw();
  });
  root.querySelector("[data-export]").onclick = () => {
    const blob = new Blob([JSON.stringify(metrics.trace())], { type: "application/json" }),
      a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `indexus-trace-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  if (!embedded) root.querySelector("[data-close]").onclick = () => hud.hide();

  function draw() {
    const w = metrics.window(SPAN),
      list = panels(metrics.keys(), metrics.keys().some((k) => k.startsWith("gpu."))),
      cols = W - 2 * PAD,
      height = list.length * (PANEL + GAP);
    if (canvas.height !== height * ratio) {
      canvas.width = W * ratio;
      canvas.height = height * ratio;
      canvas.style.width = W + "px";
      canvas.style.height = height + "px";
    }
    const g = context;
    g.setTransform(ratio, 0, 0, ratio, 0, 0);
    g.clearRect(0, 0, W, height);
    g.font = "10px ui-monospace, Menlo, monospace";
    layout = [];
    list.forEach((p, k) => {
      const top = k * (PANEL + GAP) + 14,
        bottom = top + PANEL - 14;
      g.fillStyle = INK;
      g.fillText(p.title + (p.unit ? ` (${p.unit})` : ""), PAD, top - 3);
      if (p.note) {
        g.fillStyle = MUTED;
        g.fillText(p.note, PAD, top + 18);
        return;
      }
      const data = p.series.map(([key, label, layer, mode]) => ({ key, label, layer, values: columns(w, key, mode, cols) })),
        scale = p.scale ?? 1;
      let max = p.floor ?? 1;
      for (const s of data) for (const v of s.values) if (v * scale > max) max = v * scale;
      if (p.budget && p.budget * 1.25 > max) max = p.budget * 1.25;
      const y = (v) => bottom - (Math.min(v * scale, max) / max) * (bottom - top);
      g.strokeStyle = GRID;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(PAD, bottom + 0.5);
      g.lineTo(W - PAD, bottom + 0.5);
      g.stroke();
      g.fillStyle = MUTED;
      g.fillText(max < 10 ? max.toFixed(1) : Math.round(max).toString(), W - PAD - 30, top + 8);
      if (p.budget) {
        g.strokeStyle = BUDGET;
        g.setLineDash([3, 3]);
        g.beginPath();
        g.moveTo(PAD, Math.round(y(p.budget / scale)) + 0.5);
        g.lineTo(W - PAD, Math.round(y(p.budget / scale)) + 0.5);
        g.stroke();
        g.setLineDash([]);
      }
      g.lineWidth = 1.5;
      for (const s of data) {
        g.strokeStyle = colorOf(s.layer);
        g.beginPath();
        let open = false;
        for (let c = 0; c < cols; c++) {
          const v = s.values[c];
          if (Number.isNaN(v)) {
            open = false;
            continue;
          }
          if (open) g.lineTo(PAD + c, y(v));
          else g.moveTo(PAD + c, y(v));
          open = true;
        }
        g.stroke();
      }
      // legend: name and latest value in ink, a colour swatch beside it
      let x = PAD;
      for (const s of data) {
        let last = NaN;
        for (let c = cols - 1; c >= 0 && Number.isNaN(last); c--) last = s.values[c];
        const text = `${s.label} ${Number.isNaN(last) ? "–" : fmt(last * scale)}`;
        g.fillStyle = colorOf(s.layer);
        g.fillRect(x, bottom + 5, 6, 6);
        g.fillStyle = INK2;
        g.fillText(text, x + 9, bottom + 11);
        x += g.measureText(text).width + 18;
      }
      layout.push({ top, bottom, data, scale, unit: p.unit });
    });
    if (hover) {
      const c = Math.round(hover.x - PAD),
        p = layout.find((l) => hover.y >= l.top && hover.y <= l.bottom + 14);
      if (p && c >= 0 && c < cols) {
        g.strokeStyle = MUTED;
        g.beginPath();
        g.moveTo(hover.x + 0.5, p.top);
        g.lineTo(hover.x + 0.5, p.bottom);
        g.stroke();
        const text = `-${(((cols - c) / cols) * SPAN / 1000).toFixed(1)} s  ` + p.data.map((s) => `${s.label} ${fmt(s.values[c] * p.scale)}`).join("  ");
        g.fillStyle = SURFACE;
        g.fillRect(PAD, p.top, g.measureText(text).width + 6, 13);
        g.fillStyle = INK;
        g.fillText(text, PAD + 3, p.top + 10);
      }
    }
    const s = metrics.summary(w),
      fps = w.t.length > 1 ? ((w.t.length - 1) * 1000) / (w.t[w.t.length - 1] - w.t[0]) : 0;
    head.textContent =
      `${fps.toFixed(0)} FPS · frame p50 ${s.frameMs.p50 ?? "–"} p95 ${s.frameMs.p95 ?? "–"} max ${s.frameMs.max ?? "–"} ms · ` +
      `map render p95 ${s.mapRenderMs.p95 ?? "–"} ms · ${s.slowFrames} frames > 20 ms`;
    const recent = metrics.events.filter((e) => e.name !== "slow").slice(-6).reverse();
    events.textContent = recent.length
      ? "Spikes:\n" + recent.map((e) => `${(e.t / 1000).toFixed(1)} s  ${e.layer}.${e.name} ${e.ms ?? ""} ms ${e.name === "long-frame" ? `(tasks ${e.tasks} raf ${e.raf} render ${e.layout}) ` : ""}${e.scripts?.map((x) => x.what + " " + x.ms).join(", ") ?? e.key ?? ""}`).join("\n")
      : "";
  }
  const fmt = (v) => (Number.isNaN(v) ? "–" : v >= 100 ? Math.round(v).toString() : v >= 10 ? v.toFixed(1) : v.toFixed(2));

  let timer = 0;
  const hud = {
    get visible() {
      return !!timer;
    },
    show() {
      metrics.enable();
      root.hidden = false;
      if (!timer) timer = setInterval(draw, 250);
      draw();
    },
    hide() {
      clearInterval(timer);
      timer = 0;
      root.hidden = true;
      // recording stops with the HUD unless the page asked for a trace from the start
      if (!new URLSearchParams(location.search).has("profile3d")) metrics.disable();
    },
    toggle() {
      if (timer) hud.hide();
      else hud.show();
    },
    destroy() {
      hud.hide();
      root.remove();
    },
  };
  return hud;
}

let instance = null;
/**
 * The page's HUD: "h" toggles it, ?hud opens it at load. target: { toggle(),
 * show() } that holds the HUD (Explore's info panel), else a panel of its own.
 */
export function installHud(target = null) {
  const own = () => (instance ??= createHud()),
    open = target ?? { toggle: () => own().toggle(), show: () => own().show() };
  const key = (e) => {
    if (e.key !== "h" || e.metaKey || e.ctrlKey || e.altKey || e.target.closest?.("input,textarea,select,dialog,[contenteditable]")) return;
    open.toggle();
  };
  window.addEventListener("keydown", key);
  if (new URLSearchParams(location.search).has("hud")) open.show();
  return {
    toggle() {
      open.toggle();
    },
    destroy() {
      window.removeEventListener("keydown", key);
      instance?.destroy();
      instance = null;
    },
  };
}
