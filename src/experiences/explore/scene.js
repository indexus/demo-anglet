import { CellGridLayer } from "../point-cloud/cellGridLayer.js";
import { nearbyGeometryDetails, nearbyRoofColors, pickNearbyRoof } from "./nearbyBuildings.js";
// The 3D scene of Explore: the LiDAR ground (MapLibre's terrain, the
// orthophoto draped on it: sceneBackdrop.js), buildings, vegetation, street
// lights, sky and weather, in one rendering frame (metres from the scene
// origin), drawn by the map's WebGPU renderer (rendering/gpu/mapRenderer.js)
// over a depth-only copy of the same ground (groundLayer.js). Without WebGPU there is no 3D, and the map
// says why. Every
// collection is read through Indexus and named in the catalogue: the ground,
// the orthophoto and the buildings in the shared `gps` Space, the vegetation.
// No heat map inside the scene's disc (heatDrape.js): with the sales, each
// building's roof takes the colour of the mean €/m² of the sales attributed
// to it (roofPrices), as the 2D map's ramp; with the weather, rain and
// clouds only.
import * as maplibregl from "maplibre-gl";
import { SCENE_ZOOM } from "../weather/renderBudget.js";
import { getExperienceNetwork } from "../../data/network.js";
import { SceneBackdrop } from "./sceneBackdrop.js";
import { NavigationControls } from "./navigationControls.js";
import { sceneForView } from "./policy.js";
import { SceneFrame } from "../point-cloud/sceneFrame.js";
import { BuildingsLayer } from "../point-cloud/buildingsLayer.js";
import { networkSource, boxCorners } from "../point-cloud/buildingsTree.js";
import { localFrame } from "../point-cloud/geoSpace.js";
import { VegetationLayer } from "../point-cloud/vegetationLayer.js";
import { StreetLights } from "../point-cloud/streetLights.js";
import { lampCells, basemapRoads, roadLayers } from "../point-cloud/streetLightAnchors.js";
import { SceneAtmosphere } from "../point-cloud/atmosphere.js";
import { atmosphereField } from "../point-cloud/atmosphereField.js";
import { CelestialSky } from "../point-cloud/celestialSky.js";
import { celestialState, interpolateCelestial } from "../point-cloud/celestial.js";
import { liveSurface, gridHeight } from "../point-cloud/sceneSurface.js";
import { pickBuilding, ringBounds } from "../point-cloud/buildingAnchors.js";
import { metrics } from "../../rendering/metrics.js";
import { mapRenderer } from "../../rendering/gpu/mapRenderer.js";
import { GroundLayer } from "./groundLayer.js";
import { scheduler } from "../../data/scheduler.js";
import { roofPrices } from "./priceRamp.js";
import { refreshInterval, resolutionBudgets, DEFAULTS } from "./diagnostics/viewerSettings.js";
import { vegetationSpace } from "../../data/collections.js";
import { vegetationSettings } from "../point-cloud/vegetationProfile.js";

// the ground under camera, weather and lamps before any tile is read: the scene's rows of sums (64 m),
// over the 2 km square of a disc, or the rectangle of a contour (at most 256 x 256 rows)
const GROUND = { bounds: [-1024, -1024, 1024, 1024], size: 32, cell: 64 };
/** The rows of sums of a scene: GROUND for a disc, its contour's rectangle (on the 64 m grid) otherwise. */
export function groundRows(zone) {
  if (zone?.kind !== "polygon") return GROUND;
  const c = GROUND.cell,
    [x0, y0, x1, y1] = zone.bounds,
    bounds = [Math.floor(x0 / c) * c - c, Math.floor(y0 / c) * c - c, Math.ceil(x1 / c) * c + c, Math.ceil(y1 / c) * c + c],
    size = Math.min(256, Math.ceil(Math.max(bounds[2] - bounds[0], bounds[3] - bounds[1]) / c));
  return { bounds, size, cell: c };
}
/**
 * The weather's domain (rain, clouds, the height field): the disc's square as
 * before; with a contour, its rectangle (the scene's clouds and rain over the
 * whole commune, kept to the contour: atmosphere.js).
 */
export function weatherBounds(scene) {
  if (scene.zone?.kind !== "polygon") return [-scene.radius, -scene.radius, scene.radius, scene.radius];
  return scene.zone.bounds.slice();
}
/** The scene's contour (data/sceneZone.js), or null for a disc. */
const contour = (scene) => (scene.zone?.kind === "polygon" ? scene.zone : null);
/** Outside the scene: its contour, or its disc as before. */
const outside = (scene, x, y) => (contour(scene) ? !scene.zone.contains(x, y) : x * x + y * y > scene.radius * scene.radius);
/** Levels of the vegetation's Space above the 2 km cube of a scene (collections.js vegetationSpace). */
const vegetationTop = (scene) => vegetationSpace(scene).top;

/**
 * scenes: [{ id, label, origin, unit, altitude, radius, heights, bounds, orthoLevels, tiles, collections, zone }]
 * onActive(active, bounds, local): the scene is shown (local: close enough for local weather)
 */
export function addSceneExplorer(map, scenes, onStatus, onActive, getConditions = () => null, getDate = () => null, loading) {
  const layerVisibility = { terrain: true, buildings: true, vegetation: true, ortho: true, weather: true };
  const parameters = new URLSearchParams(location.search),
    profile = parameters.has("profile3d"),
    backdrop = new SceneBackdrop(map),
    navigation = new NavigationControls(map);
  // the map's renderer once made: told which contour the view is near (the 2D weather leaves it)
  let nearRenderer = null;
  mapRenderer(map).then((renderer) => (nearRenderer = renderer), () => {});
  let preferred = parameters.get("scene"),
    enabled = true,
    disposed = false,
    scene = null,
    s = null, // what belongs to the current scene: layers, surface, timers
    frameRequest = 0,
    nearby = { rows: [], latestCount: 0, selectedId: null },
    sales = [], // the sales of the view (saleReadings), for the roofs
    // the info panel's settings (setRefreshRate, setResolution): time between
    // level walks started by camera moves, and the budgets of buildings and vegetation
    interval = refreshInterval(DEFAULTS.refreshRate),
    budgets = resolutionBudgets(DEFAULTS.resolution);
  const walkInterval = () => interval;
  // sale cards: their anchors' keys, and the last view projectionChanged() saw
  const anchorKeys = new WeakMap(),
    projection = { state: [], matrix: new Float64Array(16).fill(NaN) };

  function stop() {
    if (!s) return;
    if (scene?.tiles) scene.tiles.onTile = null;
    s.abort.abort();
    clearInterval(s.timer);
    cancelAnimationFrame(s.solar);
    for (const layer of [s.cellGrid, s.lights, s.sky, s.atmosphere, s.vegetation, s.buildings, s.ground, s.frame])
      if (layer && map.getLayer(layer.id)) map.removeLayer(layer.id);
    s.renderer.setScene(null);
    map.off("idle", s.idle);
    if (s.moved) map.off("moveend", s.moved);
    clearTimeout(s.lampsTimer);
    navigation.setScene(null, null);
    loading?.hide();
    s = scene = null;
    onActive(false);
  }

  async function start(next) {
    scene = next;
    const abort = new AbortController(),
      frame = new SceneFrame(next, { profile }),
      network = await getExperienceNetwork();
    if (abort.signal.aborted || scene !== next || disposed) return;
    const renderer = await mapRenderer(map);
    if (!renderer) throw Error("la 3D demande WebGPU, que ce navigateur n'offre pas");
    if (abort.signal.aborted || scene !== next || disposed) return;
    const engine = renderer.engine;
    s = { abort, frame, renderer, started: performance.now() };
    loading?.begin("read", "Lecture de la scène");
    const getFrame = () => frame;
    s.buildings = new BuildingsLayer(getFrame, networkSource(network, next.collections.buildings, next.collections.fine), {
      frame: localFrame(next), // data is in degrees; metres from the scene origin are for drawing only
      origin: next.origin,
      radius: next.radius,
      zone: next.zone?.kind === "polygon" ? next.zone : null,
      budget: budgets.triangles,
      interval: walkInterval,
      engine,
    });
    // ?veg, ?vegFade, ?vegMaxDepth, ?vegDelay, ?vegPrefetch, ?vegProfile (vegetationProfile.js); none: as before
    const veg = vegetationSettings(parameters, {
        width: map.getCanvas().clientWidth,
        height: map.getCanvas().clientHeight,
        ratio: globalThis.devicePixelRatio ?? 1,
        memory: globalThis.navigator?.deviceMemory ?? 8,
      }),
      // the vegetation's Space (a commune's from its catalogue entry) and where the scene is: the start read's zones
      space = next.vegetationSpace ?? { min: [-1024, -1024, -1024], side: 2048 },
      zone = contour(next),
      r = next.radius;
    s.vegetation = new VegetationLayer(getFrame, getExperienceNetwork, {
      collection: next.collections.vegetation,
      top: vegetationTop(next),
      mode: veg.mode,
      fade: veg.fade,
      maxDepth: veg.maxDepth,
      prefetch: veg.prefetch,
      minDraw: veg.minDraw,
      movingLoads: veg.movingLoads,
      movingDepth: veg.movingDepth,
      delay: veg.delay,
      fadeMs: veg.fadeMs,
      zones: {
        min: space.min,
        side: space.side,
        bounds: zone ? zone.bounds : [-r, -r, r, r],
        contains: zone ? (x, y) => zone.contains(x, y) : (x, y) => x * x + y * y < r * r,
        heights: next.heights,
      },
      maxCells: veg.profile.maxCells,
      maxReturns: veg.profile.maxReturns,
      batch: veg.profile.batch,
      maxLoads: veg.profile.maxLoads,
      floor: veg.profile.floor,
      profile: veg.profile.name,
      budget: Math.round(budgets.vegetation * veg.profile.budget),
      interval: walkInterval,
      engine,
    });
    s.buildings.visible = layerVisibility.buildings;
    s.vegetation.visible = layerVisibility.vegetation;
    s.vegWeight = veg.profile.budget;
    s.ground = new GroundLayer(getFrame, next, engine);
    s.ground.visible = layerVisibility.terrain;
    s.lights = new StreetLights(getFrame, { engine });
    s.atmosphere = new SceneAtmosphere(getFrame, {
      bounds: weatherBounds(next),
      zone: contour(next),
      range: [next.heights[0] - 2, next.heights[1] + 2],
      cloudOpacity: 0.3, // of the cover: discreet banks over the photo (premultiplied, composite.js), fading from high above (atmosphereGPU.js)
      profile,
      engine,
    });
    s.sky = new CelestialSky(getFrame, { engine });
    s.cellGrid = new CellGridLayer(getFrame,engine);
    // the frame first: the layers after it read its matrix in the same frame; they
    // add their passes before the renderer's composite runs them
    // adding a layer compiles its programs (onAdd): each one is timed (HUD, trace)
    // the scene first: the renderer's composite moves under the labels
    renderer.setScene(frame);
    for (const layer of [frame, s.ground, s.buildings, s.vegetation, s.sky, s.atmosphere, s.lights, s.cellGrid]) {
      const t0 = metrics.start();
      map.addLayer(layer, renderer.before);
      metrics.time("scene", "add." + layer.id, t0);
    }
    if (profile) Object.assign(globalThis, { __indexusMap: map, __indexusFrame: frame });
    startClock();
    // camera, weather, lamps and sale anchors stand on a surface that fills in as the scene loads:
    // first the rows of sums of the ground (one read), then the tiles and the buildings as they arrive
    const tree = s.buildings.tree,
      current = s,
      rows = groundRows(next.zone),
      coarse = await next.tiles.grid(...rows.bounds, rows.size);
    if (abort.signal.aborted || s !== current) return;
    const surface = liveSurface(rows.bounds, gridHeight(coarse, rows.size, rows.bounds), (x, y) => next.tiles.heightAt(x, y));
    for (const zone of tree.zones.values()) for (const leaf of zone.leaves.values()) surface.addRoof(leaf);
    tree.onPlaced = (node) => surface.addRoof(node);
    next.tiles.onTile = () => surface.touch();
    Object.assign(s, { surface, surfaceVersion: -1, surfaceAt: 0, anchors: new Map() });
    s.locate = (p) => {
      const rows = surface.near(p, 12).map((r) => {
        const polygon = [boxCorners(r.box)];
        return { id: r.location, polygon, base: r.box.ground, bounds: ringBounds(polygon[0]) };
      });
      return pickBuilding(rows, p);
    };
    navigation.setScene(next, surface);
    priceRoofs();
    refreshSurface(); // the weather field and the lamps, in steps; again as the surface grows
    // "idle" comes after every rendered frame once nothing loads: lamps follow moves only
    s.moved = () => (s.movedSinceLamps = true);
    s.idle = () => placeLamps();
    map.on("moveend", s.moved);
    map.on("idle", s.idle);
  }

  /**
   * The surface grew (tiles, buildings): the weather field and the lamps follow,
   * never while the map moves, at most every 4 s, each as one step of the
   * shared main-thread budget.
   */
  function refreshSurface() {
    if (!s?.surface || s.surface.version === s.surfaceVersion || map.isMoving()) return;
    const now = performance.now();
    if (now - (s.surfaceAt ?? 0) < 4000) return;
    s.surfaceAt = now;
    s.surfaceVersion = s.surface.version;
    // the weather's height field: 64 rows, 4 per step of the frame budget, then one upload
    const current = s,
      surface = s.surface,
      field = atmosphereField(surface, { range: s.atmosphere.range });
    scheduler
      .rows(
        "scene",
        field.size,
        4,
        (from, to) => {
          const t0 = metrics.start();
          if (current === s) field.fill(from, to);
          metrics.time("scene", "field", t0);
        },
        -1,
      )
      .then(() => current === s && s.atmosphere.updateTerrain(surface, field));
    s.anchors.clear();
    s.roadCount = -1;
    placeLamps(true);
  }

  /**
   * Street lamps along the basemap roads loaded around the view, on the LiDAR
   * ground: after the map has moved (or the surface grew), at most every 2 s,
   * in steps of the frame budget (one road layer, then 2000 samples, per step),
   * only inside the scene.
   */
  function placeLamps(force = false) {
    if (!s?.surface || s.frame.hidden || s.lampsQueued) return;
    if (!force && !s.movedSinceLamps) return;
    // far views do not show lamps, and every loaded road tile would be read: placed when close again
    if (map.getZoom() < 16) return void (s.movedSinceLamps = true);
    const now = performance.now();
    if (now - (s.lampsAt ?? -Infinity) < 2000) {
      clearTimeout(s.lampsTimer);
      s.lampsTimer = setTimeout(() => placeLamps(force), 2000 - (now - s.lampsAt));
      return;
    }
    s.lampsAt = now;
    s.movedSinceLamps = false;
    s.lampsQueued = true;
    const current = s;
    // the road samples: one basemap layer per step of the frame budget
    const roads = [],
      seen = new Set();
    Promise.resolve(roadLayers(map))
      .then((ids) =>
        Promise.all(
          ids.map((id) =>
            scheduler.work(
              "scene",
              () => {
                if (current !== s) return;
                const t0 = metrics.start(),
                  part = basemapRoads(map, s.frame.origin, scene.unit, { radius: scene.radius, zone: contour(scene), ids: [id], seen });
                for (const r of part) roads.push(r);
                metrics.time("scene", "roads", t0);
              },
              -2,
            ),
          ),
        ),
      )
      .then(() => roads)
      .then(async (roads) => {
        if (current !== s || roads.length === s.roadCount) return (current.lampsQueued = false);
        // 2000 road samples per step of the frame budget
        const lamps = lampCells(current.surface.height, current.surface.surface, { radius: scene.radius, zone: contour(scene) });
        await scheduler.rows(
          "scene",
          roads.length,
          2000,
          (from, to) => {
            const t1 = metrics.start();
            if (current === s) lamps.add(roads, from, to);
            metrics.time("scene", "lamps", t1);
          },
          -2,
        );
        current.lampsQueued = false;
        if (current !== s) return;
        s.roadCount = roads.length;
        s.lights.lamps = lamps.positions();
        map.triggerRepaint();
      })
      .catch((error) => {
        current.lampsQueued = false;
        console.warn("[lamps]", error);
      });
  }

  /** Local weather, sky and sun follow the map's date and conditions. */
  function startClock() {
    onActive(true, scene.bounds, true);
    let from, target, changeAt;
    const solarTick = (now) => {
      s.solar = 0;
      s.frame.celestial = interpolateCelestial(from, target, Math.min(1, (now - changeAt) / 350));
      backdrop.setDaylight(s.frame.celestial.daylight);
      map.triggerRepaint();
      if (now - changeAt < 350) s.solar = requestAnimationFrame(solarTick);
    };
    const tick = () => {
      if (document.hidden || s.frame.hidden) return;
      const conditions = layerVisibility.weather ? getConditions(scene.origin) : null;
      s.atmosphere.setConditions(conditions);
      s.atmosphere.enabled = layerVisibility.weather;
      // reading state for the load indicator
      const busy = scheduler.inflight > 0 || (s.buildings.tree.loading ?? 0) > 0 || (s.vegetation.tree?.loading ?? 0) > 0;
      if (++s.ticks % 6 === 0) refreshSurface();
      if (s.surface && s.surface.version !== s.pricedVersion) priceRoofs();
      if (busy) loading?.begin("read", "Lecture Indexus");
      else loading?.complete();
      const date = getDate();
      if (!date) return;
      const clouds = conditions?.clouds ?? 0;
      if (+date === target?.timestamp && clouds / 100 === target.clouds) return;
      target = celestialState(+date, scene.origin, clouds);
      from = s.frame.celestial ?? target;
      changeAt = performance.now();
      cancelAnimationFrame(s.solar);
      s.solar = requestAnimationFrame(solarTick);
    };
    clearInterval(s.timer);
    s.ticks = 0;
    tick();
    s.timer = setInterval(tick, 500);
  }

  /**
   * The roofs' colours from the sales: each sale goes to the building the
   * sale cards point at (s.locate: the footprint under it, else the one
   * nearest within 12 m, none when two are as near); a building's price is
   * Σ €/m² / count of its sales (the heat cells' rule), its colour the 2D
   * map's step of the ramp. Again as the surface grows (buildings arrive).
   */
  function priceRoofs() {
    if (!s?.locate) return;
    s.pricedVersion = s.surface.version;
    const colors = roofPrices(sales, (coordinates) => {
      const [x, y] = localPoint(coordinates);
      return outside(scene, x, y) ? null : s.locate([x, y]);
    });
    for (const [location, color] of nearbyRoofColors(s.buildings.tree, nearby.rows, nearby.latestCount, nearby.selectedId)) colors.set(location, color);
    s.buildings.setPrices(colors);
  }
  function localPoint(coordinates) {
    const frame = s.frame,
      p = maplibregl.MercatorCoordinate.fromLngLat(coordinates);
    return [(p.x - frame.origin.x) / scene.unit, (frame.origin.y - p.y) / scene.unit];
  }

  function setHidden(hidden) {
    // the scene fades in or out (SceneFrame.setHidden), hidden once faded out
    if (!s || !s.frame.setHidden(hidden)) return;
    navigation.setVisible(!hidden);
    s.atmosphere.enabled = !hidden && layerVisibility.weather;
    s.sky.enabled = !hidden;
    if (hidden) {
      s.atmosphere.pause();
      loading?.hide();
      onActive(false);
    } else onActive(true, scene.bounds, true);
    map.triggerRepaint();
  }

  function refresh() {
    frameRequest = 0;
    if (disposed) return;
    const next = sceneForView(scenes, map.getBounds().toArray(), preferred);
    backdrop.update(next);
    nearRenderer?.setNearZone(next?.zone ?? null); // the photo shows there (backdrop), 3D or not
    const visible = enabled && next && map.getZoom() >= SCENE_ZOOM;
    if (!visible) {
      if (!enabled) stop();
      else setHidden(true);
      return;
    }
    if (scene !== next) {
      stop();
      start(next).catch((error) => {
        console.error("[scene]", error);
        loading?.fail(error.message);
        onStatus("3D : " + error.message);
      });
      return;
    }
    setHidden(false);
  }
  const schedule = () => {
    if (!frameRequest) frameRequest = requestAnimationFrame(refresh);
  };
  map.on("move", schedule);
  map.on("moveend", schedule);
  schedule();

  const api = {
    setGridCells(cells){s?.cellGrid.setCells(cells.filter(cell=>cell.scene===scene));},
    projectGridCell(cell) {
      const frame=s?.frame,m=frame?.viewMatrix;
      if(!m||frame.hidden||cell.scene!==scene)return null;
      const {min:lo,max:hi}=cell.volume,x=(lo[0]+hi[0])/2,y=(lo[1]+hi[1])/2,z=hi[2];
      const w=m[3]*x+m[7]*y+m[11]*z+m[15];if(w<=0)return null;
      const u=(m[0]*x+m[4]*y+m[8]*z+m[12])/w,v=(m[1]*x+m[5]*y+m[9]*z+m[13])/w;
      const d=(m[2]*x+m[6]*y+m[10]*z+m[14])/w;
      if(Math.abs(u)>1||Math.abs(v)>1||d< -1||d>1)return null;
      const container=map.getContainer();return {x:(u+1)*container.clientWidth/2,y:(1-v)*container.clientHeight/2};
    },
    loadedGrid(role) {
      if(!scene)return null;
      if(role==="terrain")return {kind:"gps-tiles",collection:scene.collections.terrain,cells:scene.tiles.loadedCells()};
      if(role==="ortho")return {kind:"gps-tiles",collection:scene.collections.ortho,cells:backdrop.tiles?.loadedCells()??[]};
      if(role==="buildings")return {kind:"gps-tree",collection:scene.collections.buildings,roots:s?.buildings.tree.root??[]};
      if(role==="vegetation")return {kind:"linear-tree",volumetric:!s?.frame.hidden,collection:scene.collections.vegetation,roots:s?.vegetation.tree?.root??[],space:scene.vegetationSpace??{min:[-1024,-1024,-1024],side:2048},scene};
      return null;
    },
    setLayerVisible(role, visible) {
      if (!(role in layerVisibility)) throw new Error("Unknown scene layer");
      layerVisibility[role] = visible;
      if (role === "ortho") backdrop.setPhotoVisible(visible);
      if (role === "terrain") { backdrop.setGroundVisible(visible); if(s) s.ground.visible = visible; }
      if (s && role === "buildings") s.buildings.visible = visible;
      if (s && role === "vegetation") s.vegetation.visible = visible;
      if (s && role === "weather") s.atmosphere.enabled = visible && !s.frame.hidden;
      map.triggerRepaint();
    },
    workState() {
      const b = s?.buildings.stats,
        v = s?.vegetation.stats;
      return {
        displayed: b
          ? {
              buildings: b.visible,
              triangles: b.triangles,
              vegetation: v?.cells ?? 0,
              // on screen, and what it stands for (an aggregate holds the items under it)
              points: (v?.cells ?? 0) + (v?.returns ?? 0),
              pointsCovered: v?.covered ?? 0,
              buildingsCovered: b.represented ?? b.visible,
            }
          : null,
        gpuResidentBytes: (s?.buildings.gpuBytes ?? 0) + (v?.gpuBytes ?? 0) + (s?.ground?.gpuBytes ?? 0),
        bytes: (s?.buildings.tree.source.bytes ?? 0) + (v?.bytes ?? 0),
      };
    },
    setPreferredScene(id) {
      preferred = id;
      schedule();
    },
    /** Info panel: at most `rate` level walks per second while the camera moves (1–20). */
    setRefreshRate(rate) {
      interval = refreshInterval(rate);
    },
    /** Info panel: the 3D resolution (1–6), a weight on the buildings' and the vegetation's budgets. */
    setResolution(level) {
      budgets = resolutionBudgets(level);
      const b = s?.buildings.tree,
        v = s?.vegetation.tree,
        vegetation = Math.round(budgets.vegetation * (s?.vegWeight ?? 1)); // the device's weight (?vegProfile)
      if (s) s.vegetation.options.budget = vegetation; // a tree not made yet
      if (b && b.budget !== budgets.triangles) {
        b.budget = budgets.triangles;
        b.onChange?.();
      }
      if (v && v.budget !== vegetation) {
        v.budget = vegetation;
        v.onChange?.();
      }
    },
    setEnabled(value) {
      enabled = value;
      refresh();
    },
    /** Screen place of a sale card above its building, or null. */
    /**
     * A sale's card and roof point in the container's pixels (width x height,
     * the container's size by default), or null.
     */
    projectLocation(coordinates, width, height) {
      const frame = s?.frame;
      if (!s?.locate || frame.hidden || !frame.viewMatrix) return null;
      const [x, y] = localPoint(coordinates);
      if (outside(scene, x, y)) return null;
      let key = anchorKeys.get(coordinates);
      if (key === undefined) anchorKeys.set(coordinates, (key = coordinates.join("/")));
      if (!s.anchors.has(key)) {
        if (s.anchors.size >= 512) s.anchors.clear();
        s.anchors.set(key, s.locate([x, y]));
      }
      const building = s.anchors.get(key);
      if (!building) return null;
      const [bx, by] = building.point,
        z = s.surface.surface(building.point);
      if (z < building.base + 1) return null;
      if (width === undefined) {
        const container = map.getContainer();
        width = container.clientWidth;
        height = container.clientHeight;
      }
      const m = frame.viewMatrix,
        project = (x, y, z) => {
          const w = m[3] * x + m[7] * y + m[11] * z + m[15];
          if (w <= 0) return null;
          const u = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w,
            v = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
          if (Math.abs(u) > 1 || Math.abs(v) > 1) return null;
          return { x: ((u + 1) * width) / 2, y: ((1 - v) * height) / 2 };
        };
      const lift = Math.max(4, 24 / (512 * 2 ** map.getZoom() * scene.unit)),
        card = project(bx, by, z + lift),
        target = project(bx, by, z + 0.15);
      return card && target ? { ...card, target, building: { ...building, roofHeight: z } } : null;
    },
    /** Whether projectLocation's answers may have changed since the last call: the view, the surface, the scene. */
    projectionChanged() {
      const frame = s?.frame,
        m = frame?.viewMatrix,
        state = [s, frame?.hidden, s?.surface?.version, !!s?.locate];
      let changed = state.some((v, i) => v !== projection.state[i]);
      projection.state = state;
      if (m)
        for (let i = 0; i < 16; i++)
          if (m[i] !== projection.matrix[i]) {
            changed = true;
            projection.matrix[i] = m[i];
          }
      return changed;
    },
    setNearby(rows, latestCount, selectedId = null) {
      nearby = { rows, latestCount, selectedId };
      priceRoofs();
    },
    pickNearby(point) {
      const frame=s?.frame;
      if(!frame?.viewMatrix || frame.hidden || !layerVisibility.buildings)return null;
      const container=map.getContainer();
      return pickNearbyRoof(s.buildings.tree,nearby.rows,point,frame.viewMatrix,container.clientWidth,container.clientHeight);
    },
    nearbyDetails(row) {
      if (!s?.surface) return null;
      const geometry = nearbyGeometryDetails(s.buildings.tree, row, s.surface, scene.altitude);
      return geometry && { ...geometry, weather: getConditions(row.coordinates), date: +getDate() };
    },
    /** The sales of the view (saleReadings: coordinates, sum and count of €/m²): their roofs. */
    setSales(readings) {
      sales = readings ?? [];
      priceRoofs();
    },
    /** Colour the roof of one building (from projectLocation), or none. */
    highlightBuilding(building, color) {
      s?.buildings.highlight(building?.id, color);
    },
    get active() {
      return !!s && !s.frame.hidden;
    },
    destroy() {
      disposed = true;
      cancelAnimationFrame(frameRequest);
      nearRenderer?.setNearZone(null);
      map.off("move", schedule);
      map.off("moveend", schedule);
      navigation.destroy();
      backdrop.destroy();
      stop();
    },
  };
  if (profile) globalThis.__indexusScene = api; // diagnostics (bench)
  return api;
}

