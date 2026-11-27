// The session trace is opt-in: ?trace in the URL. Without it nothing is
// journalled and sessionTrace.js (IndexedDB journal, camera hooks) is never
// fetched. With it, the module arrives in its own chunk shortly after the page
// starts and callers attach through onSessionTrace; what ends before that is
// not recorded.
const requested =
  typeof location !== "undefined" && new URLSearchParams(location.search).has("trace");
const loading = requested
  ? import("./sessionTrace.js").catch((error) => {
      console.warn("Trace de session indisponible", error);
      return null;
    })
  : null;

export function traceRequested() {
  return requested;
}

// attach(trace, module) runs once the module is loaded, never without ?trace.
export function onSessionTrace(attach) {
  loading?.then((module) => {
    const trace = module?.getSessionTrace();
    if (trace) attach(trace, module);
  });
}
