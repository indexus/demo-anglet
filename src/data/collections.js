// Every collection Explore reads is named here, and nowhere else:
//   - the scene list, SceneExplo2026v1; each scene's own collections are
//     named in its catalogue entry (`collections`: ortho, terrain, buildings,
//     fine, vegetation), checked by sceneCollections and passed down from
//     there (no reader has a default name);
//   - the real estate, DvFMV2020idx0001 (data/dvf.js);
//   - the weather run, one collection per variable (data/weather.js
//     collectionName: TempeAROME0128v2, RainfAROME0128v2, CloudAROME0128v2,
//     SolarAROME0128v2, WindUAROME0128v2, WindVAROME0128v2, TownsAROME0128v2).
import { collectionName } from "./weather.js";

export const SCENES_COLLECTION = "SceneExplo2026v1";
export const DVF_COLLECTION_NAME = "DvFMV2020idx0001";
/** What a scene's catalogue entry names, and what each is (the readers). */
export const SCENE_ROLES = Object.freeze(["ortho", "terrain", "buildings", "fine", "vegetation"]);
/** The variables of the run Explore reads (weather/main.js: Tempe, Towns; weather/atmosphere.js: the rest). */
export const WEATHER_KINDS = Object.freeze(["Tempe", "Rainf", "Cloud", "Solar", "WindU", "WindV", "Towns"]);

/** The weather's collections, by variable. */
export const weatherCollections = () => Object.fromEntries(WEATHER_KINDS.map((kind) => [kind, collectionName(kind)]));

/** A scene's collections, by role, from its catalogue entry; refused when one is missing. */
export function sceneCollections(entry) {
  const named = entry?.collections ?? {};
  for (const role of SCENE_ROLES)
    if (typeof named[role] !== "string" || !/^[A-Za-z0-9_-]{16}$/.test(named[role]))
      throw Error(`Scène ${entry?.id ?? "?"} : collection « ${role} » absente ou mal nommée du catalogue`);
  return Object.fromEntries(SCENE_ROLES.map((role) => [role, named[role]]));
}

/**
 * The vegetation's Space of a scene: the 2 km cube of the scene (east, north,
 * up in [-1024, 1024], 5 characters: AngVegetation001) or, for a commune, the
 * catalogue's `vegetationSpace` { min, side, depth }: a cube of 2048 * 4^top
 * metres whose cells of depth `top` are 2 km squares of the scene's frame
 * ([-1024, 1024] + 2048 k): the same 2 m voxels, `top` characters more.
 * Returns { top }; refused when the cube is not of that kind.
 */
export function vegetationSpace(entry) {
  const space = entry?.vegetationSpace;
  if (!space) return { top: 0 };
  const top = space.depth - 5,
    aligned = (v) => Number.isInteger((v + 1024) / 2048);
  if (
    !(top >= 0 && top <= 3) ||
    space.side !== 2048 * 4 ** top ||
    !Array.isArray(space.min) ||
    space.min.length !== 3 ||
    !space.min.every(aligned) ||
    space.min[2] !== -1024
  )
    throw Error(`Scène ${entry.id ?? "?"} : espace de la végétation inconnu`);
  return { top };
}

/** Every collection Explore reads with this catalogue, once each, sorted. */
export function exploreCollections(catalogue = []) {
  const names = new Set([SCENES_COLLECTION, DVF_COLLECTION_NAME, ...Object.values(weatherCollections())]);
  for (const entry of catalogue) for (const name of Object.values(sceneCollections(entry))) names.add(name);
  return [...names].sort();
}

export async function createCollection(name) {
  const response = await fetch("/api/collections", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const value = await response.json();
  if (!response.ok) throw Error(value.error || `HTTP ${response.status}`);
  return value;
}
