import { Collection, Space, Local } from "js-indexus-sdk";
import { GPS } from "./weather.js";

/** Keep one Local walk alive: each next() continues after the previous page. */
export function createNearbySceneSearch(network, scene, { radiusMetres = scene.radius, origin = scene.origin } = {}) {
  const name = scene.collections.buildings;
  const collection = new Collection(name, GPS);
  const space = new Space(collection.dimensions(), collection.mask(), collection.offset());
  const dimension = space.dimension(0);
  let page = [];
  const local = new Local(
    { [name]: space },
    { cap: 1, step: 5,
      origins: { gps: dimension.newPoint([origin[1], origin[0]]) },
      filters: { gps: dimension.newFilter([0, radiusMetres / 1000], [0, 0]) } },
    { send: (records) => page.push(...records) }, { send() {} }, network,
  );
  return {
    async next(size = 5) {
      if (![5, 10, 20].includes(size)) throw new Error("Unsupported page size");
      page = [];
      local.options.step = size;
      local.options.signal = AbortSignal.timeout(15000);
      await local.search();
      return page.map(record => {
        const [south,north,west,east] = record.segments()[0].value();
        return { id: record.id(), location: record.hash(), metres: record.distances()[0] * 1000, collection: name,
          coordinates: [(west+east)/2,(south+north)/2] };
      });
    },
  };
}
