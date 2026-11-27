import { DVF_INTERPOLATION, DVF_NORMALIZER } from "./priceRamp.js";
const priceFormat = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 });
export const saleColor = (price) => DVF_INTERPOLATION(Math.max(0, Math.min(1, price / DVF_NORMALIZER)));
/** [r, g, b] in 0..1 of a CSS "rgb(r, g, b)" or "#rrggbb" colour (what the ramp gives). */
export function colorUnit(css) {
  const text = String(css).trim();
  if (text[0] === "#") {
    const n = parseInt(text.length === 4 ? [...text.slice(1)].map((c) => c + c).join("") : text.slice(1, 7), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  return text
    .slice(text.indexOf("(") + 1, text.indexOf(")"))
    .split(",")
    .slice(0, 3)
    .map((v) => +v / 255);
}
// Several transactions may share the same geocoded position. Do not stack
// indistinguishable labels or present their average as an individual sale.
export function saleReadings(points, metrics = [], keys = []) {
  const groups = new Map();
  for (let i = 0; i + 2 < points.length; i += 3) {
    const [lng, lat, price] = points.subarray(i, i + 3);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(lng) || !Number.isFinite(lat))
      continue;
    const key = lng.toFixed(6) + "/" + lat.toFixed(6),
      entry = groups.get(key);
    const m = metrics[i / 3] ?? [],
      total = Number.isFinite(m[0]) && m[0] > 0 ? m[0] : null,
      area = Number.isFinite(m[1]) && m[1] > 0 ? m[1] : null,
      transaction = { key: keys[i / 3], total, area, price };
    if (entry) {
      entry.sum += price;
      entry.count++;
      entry.transactions.push(transaction);
    } else
      groups.set(key, {
        coordinates: [lng, lat],
        sum: price,
        count: 1,
        transactions: [transaction],
      });
  }
  return [...groups.values()].map((g) => ({ ...g, price: g.sum / g.count }));
}
const LINE_ENDS = ["x1", "y1", "x2", "y2"];
/**
 * The sale cards over the map. project(coordinates, width, height) -> { x, y,
 * target?, building? } in the container's pixels (width x height), or null;
 * project.changed() (optional): whether what it projects moved since its last call.
 */
export function addSaleLabels(map, project, highlight = () => {}) {
  const root = document.createElement("div");
  root.className = "sale-labels";
  root.setAttribute("aria-label", "Ventes DVF 2020");
  map.getContainer().append(root);
  // a card keeps its hover (roof highlight, title) but never takes the map's
  // gestures: the wheel, a drag and a double click go on to the map
  const forward = (event) => {
    const target = map.getCanvasContainer?.() ?? map.getCanvas?.();
    if (!target || !event.target?.closest?.(".sale-label")) return;
    if (event.cancelable) event.preventDefault();
    target.dispatchEvent(new event.constructor(event.type, event));
  };
  for (const type of ["wheel", "mousedown", "dblclick"]) root.addEventListener?.(type, forward, { passive: false });
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("sale-leaders");
  root.append(svg);
  let rows = [],
    visible = false,
    lastReading = null;
  function update(points, metrics, keys) {
    const next = saleReadings(points, metrics, keys).slice(0, MAX_SALES),
      signature = JSON.stringify(next);
    if (signature === lastReading) return;
    lastReading = signature;
    highlight(null);
    svg.replaceChildren();
    rows = next.map((sale) => {
      const node = document.createElement("button");
      node.type = "button";
      node.className = "sale-label";
      const dot = document.createElement("i");
      dot.style.background = saleColor(sale.price);
      dot.setAttribute("aria-hidden", "true");
      const value = document.createElement("span"),
        amount = document.createElement("strong"),
        unit = document.createElement("small");
      const total = sale.count === 1 ? sale.transactions[0].total : null;
      amount.textContent =
        sale.count > 1
          ? sale.count + " ventes"
          : total
            ? priceFormat.format(total) + " €"
            : "Vente";
      unit.textContent = priceFormat.format(sale.price) + " €/m²";
      value.append(amount, unit);
      node.append(dot, value);
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("stroke", "#111");
      svg.append(line);
      const row = { ...sale, node, line };
      const select = () => {
        highlight(row.building, colorUnit(saleColor(sale.price)));
        node.classList.add("is-hovered");
      };
      node.addEventListener("mouseenter", select);
      node.addEventListener("focus", select);
      node.addEventListener("mouseleave", () => {
        highlight(null);
        node.classList.remove("is-hovered");
      });
      node.addEventListener("blur", () => {
        highlight(null);
        node.classList.remove("is-hovered");
      });
      node.title = `DVF 2020 · ${sale.count > 1 ? sale.count + " ventes à cette position · prix moyen" : "vente"} · position géocodée DVF`;
      row.title = row.shownTitle = node.title;
      return row;
    });
    root.replaceChildren(svg, ...rows.map((r) => r.node));
    dirty = true;
    layout();
  }
  // the container's size, read once and again on resize: never between the writes of a pass
  let width = 0,
    height = 0,
    dirty = true, // the label set, the visibility or the size changed: the next pass lays out
    lastZoom = NaN;
  const measure = () => {
    const container = map.getContainer();
    width = container.clientWidth;
    height = container.clientHeight;
    dirty = true;
  };
  measure();
  /**
   * One pass per rendered frame: every position is computed first (no DOM
   * read), then only what changed is written. Skipped when the camera
   * (project.changed(), when the caller has it), the zoom and the labels are
   * as in the last pass.
   */
  function layout() {
    if (root.hidden !== !visible) root.hidden = !visible;
    if (!visible) return;
    const zoom = map.getZoom(),
      moved = project?.changed ? project.changed() : true;
    if (!dirty && !moved && zoom === lastZoom) return;
    dirty = false;
    lastZoom = zoom;
    const occupied = [],
      scale = labelScale(zoom);
    let shown = 0;
    // reads and computations: every sale on screen gets its card; a card that
    // would cover another is lifted (and nudged sideways) along its black line
    for (const row of rows) {
      row.next = null;
      if (shown >= MAX_SHOWN) continue;
      const p = project?.(row.coordinates, width, height);
      if (!p || p.x < 0 || p.x > width || p.y < 0 || p.y > height) continue;
      const place = placeLabel(p, scale, occupied, width, height);
      if (!place) continue;
      occupied.push(place.box);
      row.next = place.at;
      shown++;
    }
    // writes, only of what changed; a card and its line fade in and out (style.css: their
    // transitions, from the hidden attribute and the is-hidden class), no frame asked for
    for (const row of rows) {
      const p = row.next;
      row.next = null;
      if (!p) {
        if (row.shown !== false) {
          row.node.hidden = true;
          row.line.classList.add("is-hidden");
          row.shown = false;
          row.lineShown = false;
        }
        continue;
      }
      row.building = p.building ?? null;
      const title =
        row.title +
        (p.building?.approximate ? " · rapprochement de proximité (" + p.building.distance.toFixed(1) + " m)" : "");
      if (title !== row.shownTitle) row.node.title = row.shownTitle = title;
      if (p.target) {
        if (row.lineShown !== true) row.line.classList.remove("is-hidden");
        row.lineShown = true;
        const ends = row.ends ?? (row.ends = [NaN, NaN, NaN, NaN]),
          next = [p.target.x, p.target.y, p.x, p.y];
        for (let k = 0; k < 4; k++)
          if (ends[k] !== next[k]) {
            ends[k] = next[k];
            row.line.setAttribute(LINE_ENDS[k], next[k]);
          }
      } else if (row.lineShown !== false) {
        row.line.classList.add("is-hidden");
        row.lineShown = false;
      }
      if (row.shown !== true) row.node.hidden = false;
      row.shown = true;
      const transform = `translate(${p.x}px,${p.y}px) translate(-50%,-100%) scale(${scale})`;
      if (transform !== row.transform) row.node.style.transform = row.transform = transform;
    }
    const count = String(shown);
    if (root.dataset.count !== count) root.dataset.count = count;
  }
  const resize = () => {
    measure();
    layout();
  };
  map.on("resize", resize);
  map.on("render", layout);
  return {
    update,
    setVisible(value) {
      if (value !== visible) dirty = true;
      visible = value;
      if (!value) highlight(null);
      layout();
    },
    destroy() {
      highlight(null);
      map.off("render", layout);
      map.off("resize", resize);
      root.remove();
      rows = [];
    },
  };
}

/**
 * changed() for map.project(): whether the 2D camera moved since the last
 * call (always, with a terrain: its relief may load under a still camera).
 */
export function mapCameraWatch(map) {
  let last = [];
  return () => {
    if (map.getTerrain?.()) return true;
    const c = map.getCenter(),
      next = [c.lng, c.lat, map.getZoom(), map.getBearing(), map.getPitch(), map.getRoll?.() ?? 0];
    const changed = next.some((v, i) => v !== last[i]);
    last = next;
    return changed;
  };
}

const MAX_SALES = 1000, // the readings kept, about every sale of a view
  MAX_SHOWN = 400; // cards on screen at once
const CARD_W = 110,
  CARD_H = 44,
  GAP = 4;
// the lifts tried, in card heights: straight up first, then up and to either side
const LIFTS = [
  [0, 0],
  [0, 1],
  [-0.6, 1],
  [0.6, 1],
  [0, 2],
  [-0.6, 2],
  [0.6, 2],
  [0, 3],
  [-1.1, 2],
  [1.1, 2],
  [0, 4],
  [-1.1, 3],
  [1.1, 3],
  [0, 5],
];
/**
 * Where the card of a sale projected at p goes: the first lift whose box
 * (x0, y0, x1, y1, the card's bottom centre at the tip) stays on screen and
 * covers no card already placed; its black line keeps pointing at the roof
 * (p.target when the 3D gives one, else the sale's own point). null when every
 * lift is taken.
 */
export function placeLabel(p, scale, occupied, width, height) {
  const w = CARD_W * scale,
    h = CARD_H * scale + GAP;
  for (const [dx, dy] of LIFTS) {
    const x = p.x + dx * w,
      y = p.y - dy * h,
      box = [x - w / 2, y - h + GAP, x + w / 2, y + 2];
    if (box[0] < 4 || box[2] > width - 4 || box[1] < 40 || box[3] > height - 60) continue;
    if (occupied.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue;
    const lifted = dx !== 0 || dy !== 0;
    return {
      box,
      at: { ...p, x, y, target: p.target ?? (lifted ? { x: p.x, y: p.y } : undefined) },
    };
  }
  return null;
}
/** The cards shrink as the map zooms out: full size from zoom 17, 55 % at zoom 14 and below. */
export function labelScale(zoom) {
  return Math.min(1, Math.max(0.55, 0.55 + (zoom - 14) * 0.15));
}
