// ?profile3d: counts the page's drawing contexts and GPU devices, for the
// checks of the scene renderer (one WebGL context, MapLibre's; one WebGPU
// device). Imported before the map is made. Read: globalThis.__indexusContexts().
if (typeof location !== "undefined" && new URLSearchParams(location.search).has("profile3d")) {
  const seen = new WeakMap(),
    counts = { webgl: 0, webgpu: 0, devices: 0 };
  for (const Canvas of [globalThis.HTMLCanvasElement, globalThis.OffscreenCanvas].filter(Boolean)) {
    const getContext = Canvas.prototype.getContext;
    Canvas.prototype.getContext = function (type, ...rest) {
      const context = getContext.call(this, type, ...rest),
        kind = /webgl/.test(type) ? "webgl" : type === "webgpu" ? "webgpu" : null;
      if (context && kind && seen.get(this) !== kind) {
        seen.set(this, kind);
        counts[kind]++;
      }
      return context;
    };
  }
  const adapter = globalThis.GPUAdapter?.prototype;
  if (adapter) {
    const requestDevice = adapter.requestDevice;
    adapter.requestDevice = function (...args) {
      counts.devices++;
      return requestDevice.apply(this, args);
    };
  }
  globalThis.__indexusContexts = () => ({ ...counts });
}
