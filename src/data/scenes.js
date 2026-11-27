// Explore's scene list: one record per scene in SceneExplo2026v1 (core
// tools/prep/scenes), at the 16-character location of its origin, its
// catalogue entry (frame, photo, collections) as the payload. Read as the
// records of a zone: the root for every scene.
import { Collection, Space } from "js-indexus-sdk";
import { GPS } from "./weather.js";
import { SCENES_COLLECTION, sceneCollections } from "./collections.js";

export { SCENES_COLLECTION };
const MAX_SCENES = 256;

const collection = new Collection(SCENES_COLLECTION, GPS);
const space = new Space(collection.dimensions(), collection.mask(), collection.offset());

/** Location of a scene's record: Space.encode of its origin [lng, lat]. */
export function sceneLocation([lng, lat]) {
  return space.encode(space.newPoint([[lat, lng]]), 16);
}

/** Catalogue entries of the scenes under `zone`, by id; a record not at its origin is refused. */
export async function readScenes(network, { zone = "@", signal } = {}) {
  const rows = await network.getContentRecords(SCENES_COLLECTION, zone, MAX_SCENES, { signal });
  return rows
    .map((row) => {
      const entry = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
      if (
        !entry?.id ||
        !Array.isArray(entry.origin) ||
        sceneLocation(entry.origin) !== row.location
      )
        throw Error(`Scène ${row.id} : enregistrement hors de son origine`);
      // its collections, every one named (collections.js)
      return { ...entry, collections: sceneCollections(entry) };
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
