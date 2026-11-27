// The vegetation's settings from the page's URL and the device:
//   ?veg=prod|dither|crowns|additive|canopy   how the cells are drawn (default prod: exactly Explore
//                                        before; the others with the settings that pass the guard
//                                        against prod, scripts/gpu-smoke/veg-guard.js)
//   ?vegFade=pixel|cell                  fades worked out per pixel (default but prod) or per cell
//   ?vegMinDraw=N                        levels coarser than N not drawn (default but prod 3: from
//                                        the 32 m cells; the ortho alone before them)
//   ?vegMaxDepth=N                       levels used at most, from the 2 km cube: 1..5 cells
//                                        of 512, 128, 32, 8, 2 m, 6 the returns too (all);
//                                        0, -1, ... the commune's levels above
//   ?vegDelay=ms                         simulated latency before each read
//   ?vegFadeMs=ms                        fades in time (fades per cell): data arriving, a dezoom,
//                                        a jump of the LOD band fade over ms (smoothstep, the
//                                        same dither: never both levels at a pixel; default 400,
//                                        passes veg-guard short and long against 0); 0: at once
//   ?vegPrefetch=N                       levels read at once for the scene at start (zones listed;
//                                        off: reads 1.2 to 1.8 x prod's bytes when zooming in)
//   ?vegMovingDepth=N, ?vegMovingLoads=N while zooming or flying: reads only the children of cells
//                                        coarser than N, N reads at most (off: too few returns near
//                                        on the move)
//   ?vegProfile=auto|desktop|mobile      budgets by screen, pixel ratio and memory (default desktop;
//                                        mobile: up to 1.7 x prod's requests, its smaller batches)

const MODES = ["dither", "prod", "crowns", "additive", "canopy"];
/** ms of the fades in time by default (?vegFadeMs). */
export const FADE_MS = 400;
const int = (value, fallback, min, max) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
};

/**
 * The device's budget weights: { name, budget (x the item budget), maxCells,
 * maxReturns, batch, maxLoads, floor (CSS px) }. Mobile: a small screen
 * (shorter side < 600 CSS px, or < 900 at a pixel ratio of 2.5 and more) or
 * little memory (navigator.deviceMemory <= 4):
 * the item budget scaled with the screen's area against a 1440 x 900 one (at
 * least a third), half the memory caps, smaller /sets batches (an answer
 * arrives sooner on a slow link), fewer reads at once, cells refined from 5 px.
 */
export function deviceProfile({ width = 1440, height = 900, memory = 8, ratio = 1 } = {}, name = "auto") {
  // a phone: short side under 600 CSS px, or a dense screen (ratio 2.5 and more) under 900, or 4 GB and less
  const short = Math.min(width, height),
    small = short < 600 || (ratio >= 2.5 && short < 900) || memory <= 4,
    kind = name === "auto" ? (small ? "mobile" : "desktop") : name;
  if (kind !== "mobile") return { name: "desktop", budget: 1, maxCells: 160000, maxReturns: 400000, batch: 96, maxLoads: 24, floor: 4 };
  const area = Math.min(1, Math.max(1 / 3, (width * height) / (1440 * 900)));
  return {
    name: "mobile",
    budget: area * (memory <= 2 ? 0.7 : 1),
    maxCells: 80000,
    maxReturns: 200000,
    batch: 96, // as desktop: smaller batches made up to 1.7 x the requests (veg-guard)
    maxLoads: 12,
    floor: 5,
  };
}

/**
 * The vegetation's settings from URL parameters and the screen: { mode, fade, minDraw, maxDepth,
 * delay, prefetch, movingLoads, movingDepth, profile }. ?veg=dither (and crowns, additive,
 * canopy) brings the settings that pass the guard against prod (scripts/gpu-smoke/veg-guard.js):
 * fades per pixel, nothing above 32 m. The start read (?vegPrefetch), the mobile profile
 * (?vegProfile) and the limits while moving (?vegMovingDepth) read, hold or draw worse than prod
 * there: asked for only.
 */
export function vegetationSettings(parameters = new URLSearchParams(), screen = {}) {
  const asked = MODES.includes(parameters.get("veg")) ? parameters.get("veg") : "prod",
    before = asked === "prod",
    mode = before ? "dither" : asked,
    fade = ["cell", "pixel"].includes(parameters.get("vegFade")) ? parameters.get("vegFade") : before ? "cell" : "pixel",
    profile = ["desktop", "mobile", "auto"].includes(parameters.get("vegProfile")) ? parameters.get("vegProfile") : "desktop",
    prefetch = int(parameters.get("vegPrefetch"), 0, 0, 4);
  return {
    mode,
    fade,
    minDraw: parameters.has("vegMinDraw") ? int(parameters.get("vegMinDraw"), 3, -3, 5) : before ? -Infinity : 3,
    maxDepth: int(parameters.get("vegMaxDepth"), 6, -3, 6),
    delay: int(parameters.get("vegDelay"), 0, 0, 60000),
    fadeMs: int(parameters.get("vegFadeMs"), FADE_MS, 0, 5000),
    prefetch,
    // while the camera zooms or flies: reads at most, and only the children of cells coarser than
    // movingDepth; asked for only (the long guard: near, a moving camera then draws too few returns)
    movingLoads: parameters.has("vegMovingLoads") ? int(parameters.get("vegMovingLoads"), 6, 1, 64) : Infinity,
    movingDepth: parameters.has("vegMovingDepth") ? (int(parameters.get("vegMovingDepth"), 2, -3, 99) >= 6 ? Infinity : int(parameters.get("vegMovingDepth"), 2, -3, 6)) : Infinity,
    profile: deviceProfile(screen, profile),
  };
}
