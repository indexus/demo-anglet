// ?bench=<path> replays a fixed camera path (benchPaths.js) and reports
// indexus-perf/1 metrics (sdk/docs/perf.md). Without the parameter this
// module does nothing and the runner, benchRun.js, is never fetched. Explore
// imports it first so that the worker probe is in place before any worker starts.
const bench =
  typeof location !== "undefined" ? new URLSearchParams(location.search).get("bench") : null;
if (bench !== null) {
  const workerEntries = [];
  const channel = new BroadcastChannel("indexus-bench");
  channel.onmessage = (event) => workerEntries.push(event.data);
  probeWorkers();
  import("./benchRun.js")
    .then((module) => module.runBench(bench, { workerEntries }))
    .catch((error) => console.error("Bench", error));
}

// Resource Timing is per realm: a worker's fetches never reach the page's
// timeline. Each worker starts through a bootstrap that forwards its resource
// entries on a BroadcastChannel, keeps its own URL as `location`, then runs
// the real script. Workers built from blob: or data: URLs (MapLibre's own)
// start as they are: their URL may be revoked before a bootstrap could load it.
function probeWorkers() {
  const Native = globalThis.Worker;
  if (!Native) return;
  globalThis.Worker = class extends Native {
    constructor(url, options = {}) {
      const href = new URL(url, location.href).href;
      if (/^(blob|data):/.test(href)) {
        super(url, options);
        return;
      }
      const target = JSON.stringify(href);
      const probe = `const channel=new BroadcastChannel('indexus-bench');performance.setResourceTimingBufferSize?.(100000);
new PerformanceObserver(list=>channel.postMessage({origin:performance.timeOrigin,entries:list.getEntries().map(e=>({name:e.name,transferSize:e.transferSize,encodedBodySize:e.encodedBodySize,responseEnd:e.responseEnd}))})).observe({type:'resource',buffered:true});
Object.defineProperty(self,'location',{value:new URL(${target}),configurable:true});\n`;
      const run =
        options.type === "module" ? `await import(${target});` : `importScripts(${target});`;
      super(URL.createObjectURL(new Blob([probe + run], { type: "text/javascript" })), options);
    }
  };
}
