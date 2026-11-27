// Display-only lamps inferred from the loaded road ribbons, not surveyed assets.
// A fixed metric grid keeps density independent of zoom and avoids duplicates.
export function streetLightAnchors(roads, height, surface, options = {}) {
  const lamps = lampCells(height, surface, options);
  lamps.add(roads);
  return lamps.positions();
}
/**
 * The same, fed in parts: add(roads) as many times as needed (each a step of
 * a frame budget), then positions().
 */
/** zone (data/sceneZone.js): lamps inside it only (the scene's contour), instead of the disc of `radius`. */
export function lampCells(height, surface, { spacing = 24, limit = 1024, radius = Infinity, zone = null } = {}) {
  const cells = new Map(),
    reach = (radius + 4) ** 2;
  return {
    add(roads, from = 0, to = roads.length) {
      for (let i = from; i < to; i++) {
        const { q, bearing } = roads[i];
        if (!q?.every(Number.isFinite) || !Number.isFinite(bearing)) continue;
        if (zone ? zone.beyond(q[0], q[1], 8) > 4 : q[0] * q[0] + q[1] * q[1] > reach) continue; // outside the scene: no ground there
        const ix = Math.floor(q[0] / spacing),
          iy = Math.floor(q[1] / spacing),
          key = ix + "/" + iy;
        const score = (q[0] - (ix + 0.5) * spacing) ** 2 + (q[1] - (iy + 0.5) * spacing) ** 2;
        if (score >= (cells.get(key)?.score ?? Infinity)) continue;
        const a = (bearing * Math.PI) / 180,
          x = q[0] + Math.cos(a) * 3.5,
          y = q[1] - Math.sin(a) * 3.5,
          z = height([x, y]);
        if (!Number.isFinite(z) || (zone ? !zone.contains(x, y) : x * x + y * y > radius * radius) || surface([x, y]) > z + 2) continue;
        cells.set(key, { score, distance: x * x + y * y, position: [x, y, z + 0.12] });
      }
    },
    positions() {
      return new Float32Array(
        [...cells.entries()]
          .sort((a, b) => a[1].distance - b[1].distance || a[0].localeCompare(b[0]))
          .slice(0, limit)
          .sort(([a], [b]) => a.localeCompare(b))
          .flatMap(([, v]) => v.position),
      );
    },
  };
}
/**
 * Road samples ({q, bearing} every `step` metres, local frame) from the basemap
 * road lines already loaded by MapLibre: lamps need no data of their own.
 */
/** Ids of the basemap's road line layers (no casing, outline or path). */
export function roadLayers(map) {
  // layer ids, then each layer: getStyle() would serialise the whole style
  return map.getLayersOrder().filter((id) => {
    const layer = map.getLayer(id);
    return layer?.type === "line" && /road/i.test(id) && !/casing|outline|path/i.test(id) && !id.startsWith("scene-");
  });
}
/** `ids`: the layers to read (roadLayers by default); `seen`: lines already sampled, shared between calls. */
/** zone (data/sceneZone.js): the segments near the scene's contour only, instead of its disc of `radius`. */
export function basemapRoads(map, origin, unit, { step = 6, radius = Infinity, zone = null, ids = roadLayers(map), seen = new Set() } = {}) {
  const roads = [],
    local = ([lng, lat]) => {
      const m = 1 / unit,
        x = (lng + 180) / 360,
        s = Math.sin((lat * Math.PI) / 180),
        y = 0.5 - (0.25 * Math.log((1 + s) / (1 - s))) / Math.PI;
      return [(x - origin.x) * m, (origin.y - y) * m];
    };
  for (const id of ids) {
    const layer = map.getLayer(id);
    if (!layer) continue;
    const features = map.querySourceFeatures(layer.source, { sourceLayer: layer.sourceLayer, filter: layer.filter });
    for (const feature of features) {
      const g = feature.geometry,
        lines = g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : [];
      for (const line of lines) {
        const key = line.length + "/" + line[0].join("/");
        if (seen.has(key)) continue; // a line repeated in tiles or layers
        seen.add(key);
        for (let i = 1; i < line.length; i++) {
          const a = local(line[i - 1]),
            b = local(line[i]),
            dx = b[0] - a[0],
            dy = b[1] - a[1],
            length = Math.hypot(dx, dy),
            bearing = (Math.atan2(dx, dy) * 180) / Math.PI;
          // a segment that stays outside the scene's disc gives no lamp: not sampled
          if (zone) {
            if (!zone.touches(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1]), step)) continue;
          } else {
            const u = length ? Math.max(0, Math.min(1, -(a[0] * dx + a[1] * dy) / (length * length))) : 0;
            if (Math.hypot(a[0] + u * dx, a[1] + u * dy) > radius + step) continue;
          }
          for (let t = 0; t < length; t += step) roads.push({ q: [a[0] + (dx * t) / length, a[1] + (dy * t) / length], bearing });
        }
      }
    }
  }
  return roads;
}
