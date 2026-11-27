import { createGuideBridge } from "./guideBridge.js";
// A click changes the view and the existing collection switches together.
// No query, synthetic grid or alternate renderer is introduced by the guide.
export const GUIDE_ROLES = ["terrain", "ortho", "buildings", "vegetation", "weather", "dvf"];
const place = ["terrain", "ortho", "buildings", "vegetation"];
export const EXPERIENCE_STEPS = [
  { title: "Explore place and time", text: "Start with weather across France. Move the timeline to read another hour from the archive.", next: "Zoom to Anglet", view: "overview", layers: ["weather"] },
  { title: "See the whole place", text: "Terrain, imagery, buildings and vegetation make one scene. Let's take it apart, then put it back together.", next: "Start with the photo", view: "local", layers: place },
  { title: "Start with an image", text: "Back to the ground and its aerial photo. Now add the other collections, one by one.", next: "Add buildings", view: "local", layers: ["terrain", "ortho"] },
  { title: "Give the place its buildings", text: "Building geometry adds roofs and height. The photo and the ground remain separate collections.", next: "Add vegetation", view: "local", layers: ["terrain", "ortho", "buildings"] },
  { title: "A place made of collections", text: "Vegetation adds native X, Y and Z data. Each layer contributes something; no single collection contains the whole scene.", next: "Bring weather here", view: "local", layers: place },
  { title: "Read weather in this place", text: "The same archived weather can be read over the 3D scene. Use the timeline to explore another hour.", next: "See historical sales", view: "local", layers: [...place, "weather"] },
  { title: "Another question, the same place", text: "Weather gives way to local sales from 2020. Prices are approximately associated with roofs, not current valuations or cadastral matches.", next: "Reveal the storage", view: "local", layers: [...place, "dvf"] },
  { title: "Look behind the scene", text: "These are real loaded vegetation cells. Colours and Base64 addresses identify their storage nodes and collection.", next: "Start again", view: "local", layers: place, grids: ["vegetation"] },
];

// Public view names are also used by the layer menu and links from indexus.io.
export const GUIDE_VIEWS = [
  { name: "weather", label: "Weather", step: 0 },
  { name: "3d", label: "3D place", step: 4 },
  { name: "dvf", label: "Sales · 2020", step: 6 },
  { name: "storage", label: "Storage", step: 7 },
];

export function applyExperienceStep(index, previous, actions) {
  const step = EXPERIENCE_STEPS[index];
  if (!step) throw new RangeError("Unknown experience step");
  // Hide old grids first; no invisible collection may keep a diagnostic overlay.
  for (const role of GUIDE_ROLES) actions.grid(role, false);
  for (const role of GUIDE_ROLES) actions.layer(role, step.layers.includes(role));
  if (!previous || previous.view !== step.view) actions.view(step.view);
  for (const role of step.grids ?? []) actions.grid(role, true);
  return step;
}

export function createGuidedExperience({ container, layer, grid, view, networkLegend, resizeView = () => {} }) {
  const host = document.createElement("section");
  host.className = "scene-guide";
  host.setAttribute("aria-label", "Guided Indexus experience");
  host.innerHTML = `<header><button type="button" class="scene-guide-move" aria-label="Move guide. Use arrow keys to move, Home to reset." title="Drag to move"><span aria-hidden="true">⠿</span><span class="scene-guide-progress"></span></button><span class="scene-guide-mobile-progress" aria-live="polite"></span><button type="button" class="scene-guide-close" aria-label="Explore without the guide">×</button></header>
    <h2></h2><p id="scene-guide-explanation" class="scene-guide-text" aria-live="polite"></p><div class="scene-guide-storage"></div>
    <footer><button type="button" class="scene-guide-back" aria-label="Previous experience step">←</button><button type="button" class="scene-guide-info" aria-expanded="false" aria-controls="scene-guide-explanation">Details</button><button type="button" class="scene-guide-next"></button></footer>`;
  container.append(host);
  const handle = host.querySelector(".scene-guide-move");
  let drag = null, positioned = false;
  const mobile = () => matchMedia("(max-width: 700px)").matches;
  function syncLayout() {
    if (mobile()) {
      for (const edge of ["left", "top", "right", "bottom"]) host.style.removeProperty(edge);
      positioned = false;
    } else if (!positioned && !host.hidden) {
      host.style.left = `${Math.max(12, container.clientWidth - host.offsetWidth - 18)}px`;
      host.style.top = `${Math.max(12, Math.min(container.clientHeight * .66 - host.offsetHeight / 2, container.clientHeight - host.offsetHeight - 12))}px`;
    }
    const height = `${mobile() && !host.hidden ? host.getBoundingClientRect().height : 0}px`;
    if (document.documentElement.style.getPropertyValue("--scene-guide-height") !== height) {
      document.documentElement.style.setProperty("--scene-guide-height", height);
      resizeView();
    }
  }
  function move(left, top) {
    const margin = 12;
    host.style.right = "auto";
    host.style.bottom = "auto";
    host.style.left = `${Math.max(margin, Math.min(left, container.clientWidth - host.offsetWidth - margin))}px`;
    host.style.top = `${Math.max(margin, Math.min(top, container.clientHeight - host.offsetHeight - margin))}px`;
    positioned = true;
  }
  handle.onpointerdown = (event) => {
    if (mobile() || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    handle.focus({ preventScroll: true });
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: host.offsetLeft, top: host.offsetTop };
    handle.setPointerCapture(event.pointerId);
    handle.classList.add("is-dragging");
  };
  handle.onpointermove = (event) => {
    if (drag?.id !== event.pointerId) return;
    event.stopPropagation();
    move(drag.left + event.clientX - drag.x, drag.top + event.clientY - drag.y);
  };
  const endDrag = (event) => {
    if (drag?.id !== event.pointerId) return;
    drag = null;
    handle.classList.remove("is-dragging");
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
  };
  handle.onpointerup = handle.onpointercancel = handle.onlostpointercapture = endDrag;
  handle.onkeydown = (event) => {
    if (mobile()) return;
    const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (!direction && event.key !== "Home") return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Home") {
      for (const edge of ["left", "top", "right", "bottom"]) host.style.removeProperty(edge);
      positioned = false;
      syncLayout();
    } else {
      const distance = event.shiftKey ? 24 : 8;
      move(host.offsetLeft + direction[0] * distance, host.offsetTop + direction[1] * distance);
    }
  };
  // Keep the guide reachable when the viewport or current step changes.
  const resize = new ResizeObserver(() => {
    syncLayout();
    if (positioned && !host.hidden) move(host.offsetLeft, host.offsetTop);
  });
  resize.observe(container);
  resize.observe(host);
  const next = host.querySelector(".scene-guide-next"), back = host.querySelector(".scene-guide-back");
  let index = 0, previous = null, bridge = null, visible = true;
  function select(value, { reframe = false } = {}) {
    visible = true;
    host.hidden = bridge?.active() ?? false;
    index = value;
    previous = applyExperienceStep(index, reframe ? null : previous, { layer, grid, view });
    host.querySelector("h2").textContent = previous.title;
    host.querySelector(".scene-guide-text").textContent = previous.text;
    host.querySelector(".scene-guide-progress").textContent = `${index + 1} / ${EXPERIENCE_STEPS.length}`;
    host.querySelector(".scene-guide-mobile-progress").textContent = `${index + 1} / ${EXPERIENCE_STEPS.length}`;
    next.textContent = previous.next;
    back.disabled = index === 0;
    networkLegend(index === EXPERIENCE_STEPS.length - 1 ? host.querySelector(".scene-guide-storage") : null);
    syncLayout();
    bridge?.publish();
  }
  next.onclick = () => select((index + 1) % EXPERIENCE_STEPS.length);
  back.onclick = () => select(Math.max(0, index - 1));
  const info = host.querySelector(".scene-guide-info");
  info.onclick = () => {
    const expanded = info.getAttribute("aria-expanded") !== "true";
    info.setAttribute("aria-expanded", String(expanded));
    host.classList.toggle("show-explanation", expanded);
    syncLayout();
  };
  const close = () => { visible = false; host.hidden = true; networkLegend(null); syncLayout(); bridge?.publish(); };
  host.querySelector(".scene-guide-close").onclick = close;
  bridge = createGuideBridge({
    getState: () => previous && ({ visible, index, total: EXPERIENCE_STEPS.length, title: previous.title, text: previous.text, next: previous.next,
      storage: index === EXPERIENCE_STEPS.length - 1,
      nodes: [...host.querySelectorAll(".scene-map-node")].map(node => ({ label: node.querySelector("strong").textContent, address: node.querySelector("code").textContent, color: node.style.getPropertyValue("--node-color") })),
    }),
    command(value) {
      if (value === "connect") { host.hidden = true; syncLayout(); }
      if (value === "next") select((index + 1) % EXPERIENCE_STEPS.length);
      if (value === "back") select(Math.max(0, index - 1));
      if (value === "close") close();
    },
  });
  const legendChanges = new MutationObserver(() => { if (index === EXPERIENCE_STEPS.length - 1) bridge.publish(); });
  legendChanges.observe(host.querySelector(".scene-guide-storage"), { childList: true, subtree: true, characterData: true });
  return { select, destroy() { bridge.destroy(); legendChanges.disconnect(); resize.disconnect(); networkLegend(null); host.remove(); document.documentElement.style.removeProperty("--scene-guide-height"); resizeView(); } };
}
