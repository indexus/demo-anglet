// The info panel's two settings, kept per viewer (localStorage, never required):
//   refreshRate  1–20 Hz: how often the 3D level walks (buildings, vegetation)
//                start again while the camera moves; fades and data that
//                arrive are not held back
//   resolution   1–6: the 3D detail, a weight on the triangle budget of the
//                buildings and the item budget of the vegetation (3 = the
//                layers' own budgets)
// As the sliders of the performance panel before 0e3f66b ("Actualisation max.",
// "Résolution 3D"), with the same ranges and weights.

export const SETTINGS_KEY = "indexus.explore.settings";
export const DEFAULTS = Object.freeze({ refreshRate: 20, resolution: 3 });
const WEIGHTS = [0.25, 0.5, 1, 2, 3, 4];
// the layers' own budgets (BuildingsTree budget, VegetationTree budget)
export const BASE_BUDGETS = Object.freeze({ triangles: 200000, vegetation: 40000 });

const integer = (value, min, max, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? Math.round(n) : fallback;
};
export const parseRefreshRate = (value) => integer(value, 1, 20, DEFAULTS.refreshRate);
export const parseResolution = (value) => integer(value, 1, 6, DEFAULTS.resolution);

/** Minimum time between two level walks started by camera moves (ms). */
export const refreshInterval = (rate) => 1000 / parseRefreshRate(rate);

/** Budgets of one resolution level: { triangles, vegetation }. */
export function resolutionBudgets(level, base = BASE_BUDGETS) {
  const w = WEIGHTS[parseResolution(level) - 1];
  return { triangles: Math.round(base.triangles * w), vegetation: Math.round(base.vegetation * w) };
}

const defaultStorage = () => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // storage refused (privacy settings, sandboxed frame)
  }
};

export function readSettings(storage = defaultStorage()) {
  let saved = {};
  try {
    saved = JSON.parse(storage?.getItem(SETTINGS_KEY) ?? "{}") ?? {};
  } catch {
    saved = {};
  }
  return { refreshRate: parseRefreshRate(saved.refreshRate), resolution: parseResolution(saved.resolution) };
}

export function saveSettings(settings, storage = defaultStorage()) {
  try {
    storage?.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // full or refused: the setting holds for this page only
  }
}

export const formatSetting = {
  refreshRate: (v) => `${v} Hz`,
  resolution: (v) => `${v} / 6`,
};

/**
 * Wire the sliders: { refreshRate: { input, output }, resolution: { input, output } }.
 * The inputs show the saved values; a move updates its output at once, is
 * saved and handed to onChange(key, value, settings) (the refresh rate when
 * released, as before: a walk restarted per pixel of drag helps nobody).
 * Returns { settings, set(key, value) }.
 */
export function wireSettings(controls, { onChange = () => {}, storage = defaultStorage() } = {}) {
  const settings = readSettings(storage),
    parse = { refreshRate: parseRefreshRate, resolution: parseResolution };
  const show = (key) => {
    const c = controls[key];
    if (!c) return;
    c.input.value = String(settings[key]);
    if (c.output) c.output.textContent = formatSetting[key](settings[key]);
  };
  const set = (key, value) => {
    const next = parse[key](value);
    if (next === settings[key]) return show(key);
    settings[key] = next;
    show(key);
    saveSettings(settings, storage);
    onChange(key, next, { ...settings });
  };
  for (const key of Object.keys(parse)) {
    const c = controls[key];
    if (!c) continue;
    show(key);
    const event = key === "refreshRate" ? "onchange" : "oninput";
    if (key === "refreshRate")
      c.input.oninput = () => {
        if (c.output) c.output.textContent = formatSetting[key](parse[key](c.input.value));
      };
    c.input[event] = () => set(key, c.input.value);
  }
  return { settings, set };
}
