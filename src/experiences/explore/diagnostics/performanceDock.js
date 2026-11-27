// The info panel, bottom right (the "i" button, or the "h" key): the resource
// curves of the last 30 s (hud.js, drawn only while the panel is open), the
// two settings of the viewer (viewerSettings.js: refresh rate and 3D
// resolution, kept in localStorage), what the 3D scene shows, and the credits
// of the map's sources (MapLibre's attribution, whose own button is hidden).
import { createHud } from "./hud.js";
import { wireSettings } from "./viewerSettings.js";

const number = new Intl.NumberFormat("fr-FR", { notation: "compact", maximumFractionDigits: 1 });
const HUD_WIDTH = 360;
const full = new Intl.NumberFormat("fr-FR");

/**
 * What the scene shows, and what it stands for: an aggregate on screen (a vegetation cell, a far
 * patch of roofs) holds every item under it, each one drawn if one zoomed in.
 */
export function workLines(shown, bytes) {
  const pointsShown = shown.points ?? shown.vegetation ?? 0,
    pointsCovered = Math.max(shown.pointsCovered ?? 0, pointsShown),
    buildingsCovered = Math.max(shown.buildingsCovered ?? 0, shown.buildings ?? 0),
    ratio = pointsShown ? pointsCovered / pointsShown : 0;
  return (
    '<table class="performance-items"><thead><tr><th></th><th>À l’écran</th><th>Représentés</th></tr></thead><tbody>' +
    `<tr><th>Points LiDAR</th><td>${full.format(pointsShown)}</td><td>${full.format(pointsCovered)}</td></tr>` +
    `<tr><th>Bâtiments</th><td>${full.format(shown.buildings ?? 0)}</td><td>${full.format(buildingsCovered)}</td></tr>` +
    "</tbody></table>" +
    `<p>${ratio >= 1.05 ? `1 élément affiché pour ${number.format(ratio)} points · ` : ""}${number.format(shown.triangles ?? 0)} triangles · ${number.format(bytes)} octets lus</p>`
  );
}

export function createPerformanceDock(parent, onToggle) {
  const dock = document.createElement("div");
  dock.className = "performance-dock";
  dock.innerHTML =
    '<button type="button" class="performance-trigger" aria-label="Informations et ressources" title="Informations et ressources (h)" aria-expanded="false" aria-controls="performance-content">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><circle cx="12" cy="7.6" r="0.6" fill="currentColor"/></svg><i></i></button>' +
    '<section id="performance-content" class="performance-content" aria-label="Informations et ressources" hidden>' +
    '<header><strong>Ressources</strong><button type="button" aria-label="Fermer">×</button></header>' +
    '<div class="performance-work" aria-label="Affiché"></div>' +
    '<div class="performance-activity"></div>' +
    '<div class="performance-charts"></div>' +
    '<div class="performance-settings">' +
    '<label>Actualisation max. <output></output><input type="range" min="1" max="20" step="1" data-setting="refreshRate" aria-label="Fréquence des calculs 3D"></label>' +
    '<label>Résolution 3D <output></output><input type="range" min="1" max="6" step="1" data-setting="resolution" aria-label="Résolution 3D"></label>' +
    "</div>" +
    '<footer class="performance-credits"></footer>' +
    "</section>";
  parent.append(dock);
  const trigger = dock.querySelector(".performance-trigger"),
    content = dock.querySelector("section"),
    work = dock.querySelector(".performance-work"),
    credits = dock.querySelector(".performance-credits"),
    control = (key) => {
      const input = dock.querySelector(`[data-setting="${key}"]`);
      return { input, output: input.parentElement.querySelector("output") };
    };
  let options = {},
    hud = null;
  const refresh = control("refreshRate"),
    resolution = control("resolution");
  refresh.input.title = "Cadence maximale des nouveaux calculs 3D pendant les mouvements. Les fondus et les données prêtes restent indépendants.";
  resolution.input.title = "Augmente le budget de triangles des bâtiments et le nombre d'éléments de végétation.";
  const settings = wireSettings(
    { refreshRate: refresh, resolution },
    { onChange: (key, value, all) => options.onSettings?.(key, value, all) },
  );
  // the map's credits, as MapLibre's attribution writes them (it fills in as sources load)
  const showCredits = () => {
    const inner = document.querySelector(".maplibregl-ctrl-attrib-inner");
    credits.innerHTML = inner?.innerHTML ?? "";
    for (const a of credits.querySelectorAll("a")) {
      a.target = "_blank";
      a.rel = "noreferrer";
    }
  };
  const toggle = (open) => {
    content.hidden = !open;
    trigger.setAttribute("aria-expanded", String(open));
    if (open) {
      hud ??= createHud(dock.querySelector(".performance-charts"), { embedded: true, width: HUD_WIDTH });
      hud.show();
      showCredits();
    } else hud?.hide();
    onToggle();
  };
  trigger.onclick = () => toggle(content.hidden);
  content.querySelector("header button").onclick = () => {
    toggle(false);
    trigger.focus();
  };
  dock.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !content.hidden) {
      toggle(false);
      trigger.focus();
    }
  });
  return {
    element: dock.querySelector(".performance-activity"),
    /** The viewer's settings: { refreshRate, resolution } (live object). */
    settings: settings.settings,
    get opened() {
      return !content.hidden;
    },
    show: () => toggle(true),
    toggle: () => toggle(content.hidden),
    configure(value) {
      options = { ...options, ...value };
    },
    update(phase, pending = 0, background = null) {
      dock.dataset.phase = phase;
      const s = options.getWork?.() ?? {},
        shown = s.displayed;
      if (content.hidden) return;
      if (!shown) work.textContent = "En attente de données";
      else work.innerHTML = workLines(shown, s.bytes ?? 0);
      if (!credits.childNodes.length) showCredits();
    },
    destroy() {
      hud?.destroy();
      dock.remove();
    },
  };
}
