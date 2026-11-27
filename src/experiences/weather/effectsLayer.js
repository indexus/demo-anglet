// The weather effects (effects.js, the pre-E animated layer in WGSL) in the
// map's WebGPU renderer (rendering/gpu/mapRenderer.js): each frame the pass
// goes in the renderer's "effects" stage with the frame's camera (the scene's
// while a scene is shown), the hour and zoom of the map, and the seconds that
// passed (the drops fall, the clouds deform), at most 20 frames a second while
// nothing else repaints, as the former layer's idle animation.
import { WeatherEffects } from "./effects.js";
import { IDLE_WEATHER_INTERVAL } from "./renderBudget.js";

/**
 * renderer: mapRenderer(map); options: hour() → the hour shown, cloudTravel(seconds)
 * → seconds of playback the broad cloud field moves by without wind, layers() →
 * {rain, clouds, opacity}, zoneFade(camera) → how much of the effects the
 * camera's contour (a scene's) takes off, 0..1. setAtmosphere(atmosphere,
 * polygon) once the grids are read.
 */
export function addWeatherEffects(map, renderer, { hour, cloudTravel = () => 0, layers, zoneFade = () => 0 }) {
  const { engine } = renderer,
    effects = new WeatherEffects().init(engine.device, { format: engine.format });
  const reducedMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)");
  let last = 0,
    hidden = false,
    next = 0,
    travel = 0;
  const remove = renderer.host((camera) => {
    const state = layers();
    if (hidden || !effects.atmosphere || !(state.opacity > 0) || (!state.rain && !state.clouds))
      return;
    // a scene shown without a contour (a disc): its own clouds and rain only, as before
    if (camera.scene && camera.zone?.kind !== "polygon") return;
    const now = performance.now(),
      seconds = last ? Math.min(0.1, (now - last) / 1000) : 0;
    last = now;
    travel += cloudTravel(seconds);
    effects.advance(reducedMotion?.matches ? 0 : seconds);
    const s = effects.state;
    s.hour = hour();
    s.zoom = map.getZoom();
    s.layers = state;
    s.cloudTravel = travel;
    s.zoneFade = camera.zone ? zoneFade(camera) : 0;
    engine.add("weather", (pass) => effects.encode(pass, camera), { stage: "effects" });
    clearTimeout(next);
    if (!reducedMotion?.matches)
      next = setTimeout(() => map.triggerRepaint(), IDLE_WEATHER_INTERVAL);
  });
  return {
    effects,
    setAtmosphere(atmosphere, polygon) {
      effects.setAtmosphere(atmosphere, polygon);
      map.triggerRepaint();
    },
    setHidden(value) {
      hidden = value;
      last = 0;
      map.triggerRepaint();
    },
    remove() {
      clearTimeout(next);
      remove();
      effects.destroy();
    },
  };
}
