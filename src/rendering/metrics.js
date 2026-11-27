// One registry of resource measurements for every layer of Explore.
//
//   metrics.count(layer, name, value)   added up per frame (bytes, requests, decodes)
//   metrics.gauge(layer, name, value)   last value (items drawn, buffer bytes, in flight)
//   metrics.time(layer, name, start)    main-thread ms since `start` (metrics.start())
//   metrics.event(layer, name, detail)  a moment worth naming in the trace
//   GPU ms per pass: gauges gpu.<pass>, from the scene renderer's timestamp queries
//
// Off by default and free when off: every call returns at its first line, no
// observer, no frame loop. On (`?hud`, the HUD key, or `?profile3d`), a frame
// loop writes one row per browser frame into fixed rings (FRAMES rows, about
// a minute at 60 Hz): memory does not grow with the session.
// window.indexusTrace() returns the rings and the events as JSON.

const FRAMES = 8192,
  EVENTS = 2000,
  SPIKE_MS = 8; // a timed call longer than this is an event, with its layer and name

const now = () => performance.now();

class Registry {
  on = false;
  frames = new Float64Array(FRAMES); // time of each row
  rows = 0; // rows written since start
  series = new Map(); // "layer.name" -> { kind, layer, name, ring: Float32Array, value }
  events = [];
  frameLoop = 0;
  observers = [];
  listeners = new Set();

  /** Start recording (idempotent). */
  enable() {
    if (this.on) return;
    this.on = true;
    this.startedAt = now();
    this.last = now();
    const frame = (t) => {
      this.frameLoop = requestAnimationFrame(frame);
      this.closeFrame(t);
    };
    this.frameLoop = requestAnimationFrame(frame);
    this.observe();
    for (const listener of this.listeners) listener(true);
  }
  disable() {
    if (!this.on) return;
    this.on = false;
    cancelAnimationFrame(this.frameLoop);
    for (const o of this.observers) o.disconnect();
    this.observers = [];
    for (const listener of this.listeners) listener(false);
  }
  onToggle(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  entry(kind, layer, name) {
    const key = layer + "." + name;
    let s = this.series.get(key);
    if (!s) this.series.set(key, (s = { kind, layer, name, ring: new Float32Array(FRAMES), value: 0 }));
    return s;
  }
  count(layer, name, value = 1) {
    if (!this.on) return;
    this.entry("count", layer, name).value += value;
  }
  gauge(layer, name, value) {
    if (!this.on) return;
    this.entry("gauge", layer, name).value = value;
  }
  /** performance.now() when on, 0 when off: pass it back to time(). */
  start() {
    return this.on ? now() : 0;
  }
  time(layer, name, start) {
    if (!this.on || !start) return 0;
    const ms = now() - start;
    this.entry("time", layer, name).value += ms;
    if (ms > SPIKE_MS) this.event(layer, name, { ms: +ms.toFixed(1) });
    return ms;
  }
  event(layer, name, detail = {}) {
    if (!this.on) return;
    if (this.events.length >= EVENTS) this.events.splice(0, EVENTS / 4);
    this.events.push({ t: +(now() - this.startedAt).toFixed(1), layer, name, ...detail });
  }
  /** One row per browser frame: frame time, then every series. */
  closeFrame(t) {
    const dt = t - this.last;
    this.last = t;
    const row = this.rows++ % FRAMES;
    this.frames[row] = t;
    this.entry("gauge", "frame", "ms").value = dt;
    if (performance.memory) this.entry("gauge", "memory", "jsHeap").value = performance.memory.usedJSHeapSize;
    for (const s of this.series.values()) {
      s.ring[row] = s.value;
      if (s.kind !== "gauge") s.value = 0;
    }
    if (dt > 50) this.event("frame", "slow", { ms: +dt.toFixed(1) });
  }
  observe() {
    // long animation frames name the scripts that held the main thread
    const types = PerformanceObserver.supportedEntryTypes ?? [];
    if (types.includes("long-animation-frame")) {
      const o = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          const scripts = (e.scripts ?? [])
            .filter((s) => s.duration >= 5)
            .sort((a, b) => b.duration - a.duration)
            .slice(0, 4)
            .map((s) => ({
              ms: Math.round(s.duration),
              what: `${s.invoker || s.invokerType} ${shortSource(s.sourceURL)}${s.sourceFunctionName ? " " + s.sourceFunctionName : ""}`,
            }));
          this.entry("count", "main", "blockingMs").value += e.blockingDuration ?? 0;
          // where the frame went: tasks before rendering, animation-frame callbacks,
          // then style, layout and paint (no script there: rendering or a GPU wait)
          const render = e.renderStart || e.startTime + e.duration,
            style = e.styleAndLayoutStart || render;
          this.event("main", "long-frame", {
            ms: Math.round(e.duration),
            blocking: Math.round(e.blockingDuration ?? 0),
            tasks: Math.round(render - e.startTime),
            raf: Math.round(style - render),
            layout: Math.round(e.startTime + e.duration - style),
            scripts,
          });
        }
      });
      o.observe({ type: "long-animation-frame" });
      this.observers.push(o);
    } else if (types.includes("longtask")) {
      const o = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          this.entry("count", "main", "blockingMs").value += Math.max(0, e.duration - 50);
          this.event("main", "long-task", { ms: Math.round(e.duration) });
        }
      });
      o.observe({ type: "longtask" });
      this.observers.push(o);
    }
    // what crossed the network from this page (the gateway's /api/p2p reads among them)
    performance.setResourceTimingBufferSize?.(100000);
    const resources = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const s = this.entry("count", "net", "bytes");
        s.value += e.transferSize || e.encodedBodySize || 0;
        this.entry("count", "net", "responses").value++;
      }
    });
    resources.observe({ type: "resource", buffered: true });
    this.observers.push(resources);
  }

  // ---- reading ---------------------------------------------------------------------
  /** Rows of the last `ms` milliseconds: { t: Float64Array, get(key) -> Float32Array } oldest first. */
  window(ms = 30000) {
    const n = Math.min(this.rows, FRAMES),
      end = this.rows,
      latest = this.frames[(end - 1 + FRAMES) % FRAMES];
    let k = 0;
    while (k < n && latest - this.frames[(end - 1 - k + FRAMES * 2) % FRAMES] <= ms) k++;
    const index = (i) => (end - k + i + FRAMES * 2) % FRAMES,
      t = new Float64Array(k);
    for (let i = 0; i < k; i++) t[i] = this.frames[index(i)];
    return {
      t,
      get: (key) => {
        const s = this.series.get(key),
          out = new Float32Array(k);
        if (s) for (let i = 0; i < k; i++) out[i] = s.ring[index(i)];
        return out;
      },
    };
  }
  keys() {
    return [...this.series.keys()];
  }
  /** Everything recorded, for offline analysis. */
  trace(ms = 70000) {
    const w = this.window(ms),
      t0 = this.startedAt ?? 0,
      series = {};
    for (const [key, s] of this.series) series[key] = { kind: s.kind, values: Array.from(w.get(key), (v) => +v.toFixed(3)) };
    return {
      format: "indexus-trace-v1",
      startedAt: new Date(performance.timeOrigin + t0).toISOString(),
      gpuTimer: this.keys().some((key) => key.startsWith("gpu.")),
      t: Array.from(w.t, (v) => +(v - t0).toFixed(1)),
      series,
      events: this.events.slice(),
      summary: this.summary(w),
    };
  }
  summary(w = this.window(30000)) {
    const frame = [...w.get("frame.ms")].sort((a, b) => a - b),
      q = (a, p) => (a.length ? +a[Math.min(a.length - 1, Math.floor(a.length * p))].toFixed(1) : null);
    const render = [...w.get("map.renderMs")].sort((a, b) => a - b),
      main = [...w.get("main.ms")].sort((a, b) => a - b);
    return {
      frames: frame.length,
      frameMs: { p50: q(frame, 0.5), p95: q(frame, 0.95), max: q(frame, 1) },
      mapRenderMs: { p50: q(render, 0.5), p95: q(render, 0.95), max: q(render, 1) },
      // the map's render and the scheduler's jobs
      mainMs: { p50: q(main, 0.5), p95: q(main, 0.95), p99: q(main, 0.99), max: q(main, 1) },
      slowFrames: frame.filter((v) => v > 20).length,
    };
  }
}
const shortSource = (url = "") => url.replace(/^.*\/src\//, "").replace(/\?.*$/, "");

export const metrics = new Registry();

if (typeof location !== "undefined") {
  const parameters = new URLSearchParams(location.search);
  if (parameters.has("hud") || parameters.has("profile3d")) {
    metrics.enable();
    // ?hud=20: record the first 20 s only, then keep them (a trace of the load)
    const seconds = Number(parameters.get("hud"));
    if (seconds > 0) setTimeout(() => metrics.disable(), seconds * 1000);
  }
  globalThis.indexusTrace = (ms) => metrics.trace(ms);
}

/** Time MapLibre's own frame (custom layers included) while recording. */
export function measureMap(map) {
  const render = map._render;
  if (typeof render !== "function") return () => {};
  map._render = function (...args) {
    const t0 = metrics.start(),
      result = render.apply(this, args),
      ms = metrics.time("map", "renderMs", t0);
    // the main thread's scene work of the frame: this render and the scheduler's jobs (scheduler.drain)
    metrics.count("main", "ms", ms);
    metrics.count("map", "frames");
    return result;
  };
  return () => {
    map._render = render;
  };
}
