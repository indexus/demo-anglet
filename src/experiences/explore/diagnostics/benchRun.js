// Runner of ?bench=<path> (bench.js): one page load is one run. It waits for
// the first view to settle, replays the path, measures, stores the run in
// sessionStorage and reloads until &runs=N (default 3) are done, then shows
// the indexus-perf/1 result with every run as a sample (sdk/docs/perf.md).
import { weatherView } from "../../weather/main.js";
import { BENCH_PATHS } from "./benchPaths.js";

const QUIET_MS = 1000,
  SETTLE_LIMIT_MS = 30000;
const query = new URLSearchParams(location.search);

// Same summary as sdk/scripts/perf/result.mjs, which defines the format.
function median(values) {
  const s = [...values].sort((a, b) => a - b),
    m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function quantile(sorted, q) {
  const at = (sorted.length - 1) * q,
    low = Math.floor(at);
  return sorted[low] + (sorted[Math.min(low + 1, sorted.length - 1)] - sorted[low]) * (at - low);
}
function dispersion(values) {
  if (values.length < 3) return 0;
  const c = median(values);
  if (!c) return 0;
  const s = [...values].sort((a, b) => a - b);
  return (
    (100 *
      Math.max(
        1.4826 * median(values.map((v) => Math.abs(v - c))),
        (quantile(s, 0.75) - quantile(s, 0.25)) / 1.349,
      )) /
    Math.abs(c)
  );
}
const round = (value) => (Number.isFinite(value) ? Number(value.toPrecision(6)) : value);
function percentile(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))];
}

// Every resource of the page and of its workers, on the page clock.
function resources(workerEntries) {
  const own = performance.getEntriesByType("resource").map((e) => ({
    name: e.name,
    transferSize: e.transferSize,
    encodedBodySize: e.encodedBodySize,
    responseEnd: e.responseEnd,
  }));
  const fromWorkers = workerEntries.flatMap((batch) =>
    batch.entries.map((e) => ({
      ...e,
      responseEnd: e.responseEnd + batch.origin - performance.timeOrigin,
    })),
  );
  return [...own, ...fromWorkers];
}

function frames() {
  const stamps = [];
  let moving = false,
    intervals = [],
    last = 0;
  const tick = (at) => {
    stamps.push(at);
    if (moving && last) intervals.push(at - last);
    last = at;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return {
    stamps,
    get intervals() {
      return intervals;
    },
    move(value) {
      moving = value;
    },
  };
}

async function settle(map, workerEntries) {
  const start = performance.now();
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const now = performance.now(),
      list = resources(workerEntries),
      lastEnd = Math.max(0, ...list.map((e) => e.responseEnd));
    if (!map.isMoving() && now - lastEnd >= QUIET_MS && map.loaded())
      return { at: now, timedOut: false };
    if (now - start > SETTLE_LIMIT_MS) return { at: now, timedOut: true };
  }
}

function move(map, step) {
  const { duration, ...camera } = step;
  return new Promise((resolve) => {
    if (!duration) {
      map.jumpTo(camera);
      resolve();
      return;
    }
    map.once("moveend", () => resolve());
    map.easeTo({ ...camera, duration, essential: true });
  });
}

async function measureRun(path, workerEntries) {
  const clock = frames(),
    map = weatherView.map;
  performance.setResourceTimingBufferSize?.(100000);
  await weatherView.initialized;
  if (!map.loaded()) await new Promise((resolve) => map.once("load", resolve));
  const first = await settle(map, workerEntries);
  const sets = () =>
    resources(workerEntries).filter((e) =>
      new URL(e.name, location.href).pathname.endsWith("/sets"),
    );
  const firstSets = Math.min(...sets().map((e) => e.responseEnd));
  // Lower bound of the first displayed data: the frame after the first /sets
  // response (or the response itself if it came before this runner); decoding
  // and upload of that response come later.
  let firstData = null;
  if (Number.isFinite(firstSets))
    firstData =
      clock.stamps[0] > firstSets
        ? firstSets
        : (clock.stamps.find((at) => at >= firstSets) ?? firstSets);
  const started = performance.now();
  let timedOut = first.timedOut;
  for (const step of path.steps) {
    clock.move(true);
    await move(map, step);
    clock.move(false);
    timedOut = (await settle(map, workerEntries)).timedOut || timedOut;
  }
  const ended = performance.now(),
    all = resources(workerEntries),
    read = sets(),
    intervals = clock.intervals;
  const sum = (list, key) => list.reduce((total, e) => total + (e[key] || 0), 0);
  return {
    timedOut,
    values: {
      "first-data": ["ms", firstData],
      "first-settled": ["ms", first.at],
      path: ["ms", ended - started],
      "frame.p50": ["ms", percentile(intervals, 0.5)],
      "frame.p95": ["ms", percentile(intervals, 0.95)],
      "frame.p99": ["ms", percentile(intervals, 0.99)],
      "frame.over50ms": ["frames", intervals.filter((ms) => ms > 50).length],
      "sets.requests": ["requests", read.length],
      "sets.transfer": ["B", sum(read, "transferSize")],
      "sets.body": ["B", sum(read, "encodedBodySize")],
      "network.requests": ["requests", all.length],
      "network.transfer": ["B", sum(all, "transferSize")],
      "js.heap": ["MiB", performance.memory ? performance.memory.usedJSHeapSize / 2 ** 20 : null],
    },
  };
}

async function environment(name, runs) {
  let gpu = null;
  try {
    const info = (await navigator.gpu?.requestAdapter())?.info;
    if (info)
      gpu = [info.vendor, info.architecture, info.description].filter(Boolean).join(" ") || null;
  } catch {}
  return {
    machine: query.get("machine"),
    browser: navigator.userAgent,
    gpu,
    cores: navigator.hardwareConcurrency,
    devicePixelRatio,
    viewport: [innerWidth, innerHeight],
    path: name,
    runs,
    page: location.pathname,
    parameters: Object.fromEntries(
      [...query].filter(([key]) => !["bench", "runs", "machine", "commit", "branch"].includes(key)),
    ),
  };
}

function show(result) {
  const text = JSON.stringify(result, null, 2),
    panel = document.createElement("section");
  panel.style.cssText =
    "position:fixed;inset:5% 10%;z-index:10000;background:#fff;color:#111;padding:1em;overflow:auto;font:12px monospace;box-shadow:0 0 0 100vmax #0008";
  const button = document.createElement("button"),
    pre = document.createElement("pre");
  button.type = "button";
  button.textContent = "Copier";
  pre.id = "result";
  pre.textContent = text;
  const copy = () =>
    navigator.clipboard.writeText(text).then(
      () => {
        button.textContent = "Copié";
      },
      () => {
        getSelection().selectAllChildren(pre);
        button.textContent = "Sélectionné : Ctrl/Cmd+C";
      },
    );
  button.onclick = copy;
  panel.append(button, pre);
  document.body.append(panel);
  window.__INDEXUS_BENCH__ = result;
  console.log(text);
  copy();
  document.title = "DONE · " + document.title;
}

export async function runBench(name, { workerEntries }) {
  const path = BENCH_PATHS[name];
  if (!path) {
    show({ error: `unknown bench path "${name}"`, paths: Object.keys(BENCH_PATHS) });
    return;
  }
  const url = new URL(location.href);
  let missing = false;
  for (const [key, value] of Object.entries(path.params))
    if (url.searchParams.get(key) !== value) {
      url.searchParams.set(key, value);
      missing = true;
    }
  if (missing) {
    location.replace(url);
    return;
  }
  const runs = Math.max(1, Number(query.get("runs")) || 3),
    key = "indexus-bench:" + name;
  let state = JSON.parse(sessionStorage.getItem(key) ?? "null");
  if (!state || state.done || state.runs !== runs) state = { runs, done: false, results: [] };
  const run = await measureRun(path, workerEntries);
  state.results.push(run);
  if (state.results.length < runs) {
    sessionStorage.setItem(key, JSON.stringify(state));
    location.reload();
    return;
  }
  sessionStorage.setItem(key, JSON.stringify({ ...state, done: true }));
  const metrics = Object.entries(state.results[0].values).flatMap(([metric, [unit]]) => {
    const samples = state.results.map((r) => r.values[metric][1]).filter((v) => v !== null);
    if (!samples.length) return [];
    const entry = {
      name: `explore.${name}.${metric}`,
      unit,
      value: round(median(samples)),
      better: "lower",
    };
    if (samples.length > 1) {
      entry.samples = samples.map(round);
      entry.noise = round(dispersion(samples));
    }
    return [entry];
  });
  show({
    schema: "indexus-perf/1",
    suite: "experiences/explore-bench",
    commit: query.get("commit"),
    branch: query.get("branch"),
    date: new Date().toISOString(),
    env: {
      ...(await environment(name, runs)),
      settleTimedOut: state.results.some((r) => r.timedOut),
    },
    metrics,
  });
}
