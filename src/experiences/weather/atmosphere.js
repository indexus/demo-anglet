// The atmosphere of the AROME run as the pre-E animated layer had it: rain,
// cloud cover and solar radiation on the regional 128 x 128 Web Mercator grid
// (WEATHER_RUN.atmosphere), and the 10 m wind on the same grid, now rebuilt
// from the records of their native collections (core tools/prep/weather: one
// record per grid cell over land and one cell around it, ID m<size>-<row>-<column>,
// metrics [area, v·area per hour]). From there everything is the former
// layer's (experiences 6526f24 animatedWeather.js loadAtmosphere): the grid of
// an hour packed as RGBA8 (R rain / 3 mm/h, G cloud %, B rain / 12 mm/h, A
// solar / 800 W/m²) with its three coarser levels (16 to 64 texels, 2 x 2
// means), the GPU's bilinear sampling and level blend repeated on the CPU for
// a point (conditionsAt), land-weighted region means (regionalConditions), and
// the wind integrated over the run into the offsets that carry the clouds.
//
// Cells the collections do not hold (the open sea, away from land) take the
// value of the nearest cells held, so that the coarser levels, which average
// 2 x 2 cells, do not darken the coast; the land mask hides the sea anyway.
import { WEATHER_RUN } from "../../data/weather.js";

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
/** Channel scales of the packed grid: rain (particles), cloud cover, rain (cloud shading), solar. */
const SCALES = [1 / 3, 1 / 100, 1 / 12, 1 / 800];
/** Collection of each channel of the grids. */
export const ATMOSPHERE_KINDS = {
  rain: "Rainf",
  cloud: "Cloud",
  solar: "Solar",
  windU: "WindU",
  windV: "WindV",
};

export const mercatorX = (lng) => (lng + 180) / 360;
export const mercatorY = (lat) =>
  (1 - Math.log(Math.tan(Math.PI / 4 + (clamp(lat, -85.05, 85.05) * Math.PI) / 360)) / Math.PI) / 2;

/**
 * The grids from the rows of each collection ({kind: [{id, metrics}]}, kind
 * as ATMOSPHERE_KINDS): values (hours x size² x 4: rain, cloud, unused, solar)
 * and wind (hours x size² x 2: east, north), the former atmosphere.f32 and
 * wind.f32. Rows whose ID is not a cell of the grid are ignored.
 */
export function atmosphereGrids(rows, { size, hours }) {
  const cells = size * size;
  const values = new Float32Array(hours * cells * 4);
  const wind = new Float32Array(hours * cells * 2);
  const held = { values: new Uint8Array(cells), wind: new Uint8Array(cells) };
  const place = (list, target, stride, channel, mask) => {
    for (const row of list ?? []) {
      const match = /^m(\d+)-(\d+)-(\d+)$/.exec(row.id ?? "");
      if (!match || Number(match[1]) !== size) continue;
      const cell = Number(match[2]) * size + Number(match[3]);
      const area = row.metrics[0];
      if (!(area > 0) || cell >= cells) continue;
      for (let h = 0; h < hours; h++) {
        const v = row.metrics[1 + h] / area;
        target[(h * cells + cell) * stride + channel] = Number.isFinite(v) ? v : 0;
      }
      mask[cell] = 1;
    }
  };
  place(rows.rain, values, 4, 0, held.values);
  place(rows.cloud, values, 4, 1, held.values);
  place(rows.solar, values, 4, 3, held.values);
  place(rows.windU, wind, 2, 0, held.wind);
  place(rows.windV, wind, 2, 1, held.wind);
  fillUnheld(values, held.values, size, hours, 4);
  fillUnheld(wind, held.wind, size, hours, 2);
  return { values, wind, size, hours, held };
}

/** Each cell not held takes the mean of its held neighbours, ring after ring (the nearest cells). */
export function fillUnheld(data, held, size, hours, stride) {
  const cells = size * size;
  if (!held.some(Boolean)) return;
  let known = Uint8Array.from(held);
  for (let pass = 0; pass < 2 * size && known.some((k) => !k); pass++) {
    const next = known.slice();
    for (let cell = 0; cell < cells; cell++) {
      if (known[cell]) continue;
      const r = Math.floor(cell / size),
        c = cell % size;
      const around = [];
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr,
            cc = c + dc;
          if ((dr || dc) && rr >= 0 && rr < size && cc >= 0 && cc < size && known[rr * size + cc])
            around.push(rr * size + cc);
        }
      if (!around.length) continue;
      for (let h = 0; h < hours; h++)
        for (let k = 0; k < stride; k++) {
          let sum = 0;
          for (const a of around) sum += data[(h * cells + a) * stride + k];
          data[(h * cells + cell) * stride + k] = sum / around.length;
        }
      next[cell] = 1;
    }
    known = next;
  }
}

/** The grid of an hour and its coarser levels (2 x 2 means), finest last: [{size, data}]. */
export function weatherLevels(fine) {
  const levels = [fine];
  let previous = fine;
  for (let k = 0; k < 3; k++) {
    const size = previous.size / 2;
    const data = new Uint8Array(size * size * 4);
    const row = previous.size * 4;
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const a = (2 * y * previous.size + 2 * x) * 4;
        for (let channel = 0; channel < 4; channel++) {
          const j = a + channel;
          const d = previous.data;
          data[(y * size + x) * 4 + channel] = Math.round(
            (d[j] + d[j + 4] + d[j + row] + d[j + row + 4]) / 4,
          );
        }
      }
    previous = { size, data };
    levels.unshift(previous);
  }
  return levels;
}

/**
 * The atmosphere of the run from its grids: tilesAt(hour) → the four levels
 * (coarse to fine) of that hour, conditionsAt([lng, lat], hour, zoom) → {rain,
 * clouds} as the map shows them there, regionalConditions(bounds, polygon) →
 * [{rain, clouds}] per hour, land-weighted, and `advection` (the wind offsets).
 */
export function createAtmosphere(grids, { bounds = WEATHER_RUN.atmosphere.bounds } = {}) {
  const { values, wind, size, hours } = grids;
  const stride = size * size * 4;
  const tileCache = new Map();
  function tilesAt(hour) {
    hour = Math.round(clamp(hour, 0, hours - 1) * 16) / 16;
    if (tileCache.has(hour)) return tileCache.get(hour);
    const data = new Uint8Array(stride);
    const from = Math.floor(hour);
    const to = Math.min(from + 1, hours - 1);
    const t = hour - from;
    for (let i = 0; i < stride; i++) {
      const channel = i % 4;
      const source = channel === 2 ? i - 2 : i;
      const a = values[from * stride + source],
        b = values[to * stride + source];
      data[i] = Math.round(clamp((a + (b - a) * t) * SCALES[channel], 0, 1) * 255);
    }
    const tiles = weatherLevels({ size, data });
    tileCache.set(hour, tiles);
    if (tileCache.size > 3) tileCache.delete(tileCache.keys().next().value);
    return tiles;
  }
  const [west, south, east, north] = bounds;
  const northwest = { x: mercatorX(west), y: mercatorY(north) };
  const southeast = { x: mercatorX(east), y: mercatorY(south) };
  /** Grid units (0..1) of a place. */
  const unit = ([lng, lat]) => [
    (mercatorX(lng) - northwest.x) / (southeast.x - northwest.x),
    (mercatorY(lat) - northwest.y) / (southeast.y - northwest.y),
  ];

  function conditionsAt(coordinates, hour, zoom = 5) {
    const [x, y] = unit(coordinates);
    if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return undefined;
    hour = clamp(hour, 0, hours - 1);
    const start = Math.floor(hour);
    const tiles = tilesAt(start);
    const nextTiles = tilesAt(Math.min(start + 1, hours - 1));
    const timeBlend = hour - start;
    const detail = clamp(zoom - 5, 0, tiles.length - 1);
    const level = Math.floor(detail);
    const fraction = detail - level;
    const blend = fraction * fraction * (3 - 2 * fraction);
    // the GPU's bilinear sampling at texel centres, and its blend across levels
    function sample({ size: s, data }, channel) {
      const column = clamp(x * s - 0.5, 0, s - 1);
      const row = clamp(y * s - 0.5, 0, s - 1);
      const left = Math.floor(column),
        right = Math.ceil(column);
      const top = Math.floor(row),
        bottom = Math.ceil(row);
      const upper =
        data[(top * s + left) * 4 + channel] * (1 - column + left) +
        data[(top * s + right) * 4 + channel] * (column - left);
      const lower =
        data[(bottom * s + left) * 4 + channel] * (1 - column + left) +
        data[(bottom * s + right) * 4 + channel] * (column - left);
      return upper + (lower - upper) * (row - top);
    }
    function sampleLevel(channel) {
      const atLevel = (fields) => {
        const coarse = sample(fields[level], channel);
        return blend === 0
          ? coarse
          : coarse + (sample(fields[level + 1], channel) - coarse) * blend;
      };
      const current = atLevel(tiles);
      return current + (atLevel(nextTiles) - current) * timeBlend;
    }
    return { rain: (sampleLevel(0) * 3) / 255, clouds: (sampleLevel(1) * 100) / 255 };
  }

  const regions = new Map();
  let regionPolygon = null,
    regionalMask = null;
  function regionalConditions([w, s, e, n], polygon) {
    if (polygon !== regionPolygon) {
      regions.clear();
      regionalMask = null;
      regionPolygon = polygon;
    }
    const key = [w, s, e, n].join("/");
    if (regions.has(key)) return regions.get(key);
    regionalMask ??= landMask(polygon, bounds, size);
    const [minX, minY] = unit([w, n]).map((v) => v * size);
    const [maxX, maxY] = unit([e, s]).map((v) => v * size);
    // sin(latitude) is tanh of the Mercator ordinate: the surface between the clipped row edges
    const sineLatitude = (y) =>
      Math.tanh(Math.PI * (1 - 2 * (northwest.y + (y / size) * (southeast.y - northwest.y))));
    const cells = [];
    let total = 0;
    for (let y = Math.max(0, Math.floor(minY)); y < Math.min(size, maxY); y++) {
      const height = sineLatitude(Math.max(y, minY)) - sineLatitude(Math.min(y + 1, maxY));
      for (let x = Math.max(0, Math.floor(minX)); x < Math.min(size, maxX); x++) {
        const cell = y * size + x;
        const width = Math.min(x + 1, maxX) - Math.max(x, minX);
        const weight = regionalMask[cell] * width * height;
        if (weight <= 0) continue;
        cells.push([cell * 4, weight]);
        total += weight;
      }
    }
    const result = !total
      ? []
      : Array.from({ length: hours }, (_, hour) => {
          let rain = 0,
            clouds = 0;
          for (const [at, weight] of cells) {
            rain += values[hour * stride + at] * weight;
            clouds += values[hour * stride + at + 1] * weight;
          }
          return { rain: rain / total, clouds: clouds / total };
        });
    regions.set(key, result);
    if (regions.size > 8) regions.delete(regions.keys().next().value);
    return result;
  }

  return {
    bounds,
    size,
    hours,
    northwest,
    southeast,
    tilesAt,
    conditionsAt,
    regionalConditions,
    advection: cloudAdvection(wind, size, hours),
  };
}

/**
 * The wind integrated over the run (the former loadCloudAdvection): per hour
 * the offset of each cell's air since hour 0, packed in 16 bits a component
 * (frame), and the east wind as a tilt of the rain (eastward); range: the
 * largest offset, in grid units.
 */
export function cloudAdvection(wind, size, hours) {
  const stride = size * size * 2;
  const offsets = new Float32Array(wind.length);
  // a visual speed factor for timeline playback
  const visualScale = 0.00022;
  let range = 0.001;
  for (let i = stride; i < wind.length; i++) {
    const direction = i % 2 === 0 ? 1 : -1; // texture rows go south
    offsets[i] = offsets[i - stride] + (wind[i - stride] + wind[i]) * 0.5 * visualScale * direction;
    range = Math.max(range, Math.abs(offsets[i]));
  }
  const at = (hour) => Math.max(0, Math.min(hours - 1, hour));
  return {
    size,
    range,
    hours,
    frame: (hour) => packWindFrame(offsets, at(hour), size, range),
    eastward: (hour) => packEastwardFrame(wind, at(hour), size),
  };
}

export function packWindFrame(offsets, hour, size, range) {
  const stride = size * size * 2;
  const packed = new Uint8Array(size * size * 4);
  const from = hour * stride;
  for (let i = 0; i < stride; i++) {
    const encoded = Math.round((0.5 + (0.5 * offsets[from + i]) / range) * 65535);
    packed[i * 2] = encoded >> 8;
    packed[i * 2 + 1] = encoded & 255;
  }
  return packed;
}

export function packEastwardFrame(wind, hour, size) {
  const cells = size * size;
  const rgba = new Uint8Array(cells * 4);
  const base = hour * cells * 2;
  for (let cell = 0; cell < cells; cell++) {
    rgba[cell * 4] = 128 + Math.round(127 * clamp(wind[base + cell * 2] / 15, -1, 1));
    rgba[cell * 4 + 3] = 255;
  }
  return rgba;
}

/**
 * Land share (0..1) of each cell of the grid: the polygon rasterized at 16
 * texels a cell, as the former mask canvas of the grid's size. Without a
 * canvas (Node), every cell counts.
 */
export function landMask(polygon, bounds, size) {
  const mask = new Float32Array(size * size).fill(1);
  const Canvas = globalThis.OffscreenCanvas;
  if (!polygon || !Canvas) return mask;
  const canvas = landCanvas(polygon, bounds, size);
  const data = canvas.getContext("2d").getImageData(0, 0, size, size).data;
  for (let i = 0; i < size * size; i++) mask[i] = data[i * 4 + 3] / 255;
  return mask;
}

/** The polygon rasterized over the grid's rectangle (white, alpha = land), `pixels` a side. */
export function landCanvas(polygon, [west, south, east, north], pixels = 2048) {
  const canvas = new OffscreenCanvas(pixels, pixels);
  const ctx = canvas.getContext("2d");
  const x0 = mercatorX(west),
    y0 = mercatorY(north),
    x1 = mercatorX(east),
    y1 = mercatorY(south);
  ctx.fillStyle = "#fff";
  for (const { geometry } of polygon.features) {
    const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
    for (const rings of polygons) {
      ctx.beginPath();
      for (const ring of rings) {
        ring.forEach(([lng, lat], index) => {
          const px = ((mercatorX(lng) - x0) / (x1 - x0)) * pixels;
          const py = ((mercatorY(lat) - y0) / (y1 - y0)) * pixels;
          if (index === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
        ctx.closePath();
      }
      ctx.fill("evenodd");
    }
  }
  return canvas;
}
