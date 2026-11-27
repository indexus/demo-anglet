// A scene's contour (data/sceneZone.js) as a mask texture for the map's
// full-screen passes (the heat drapes, the weather effects): r8unorm, 255
// inside, rows from the south, made once per contour (zoneMask: about 36 m a
// texel over Anglet), and where it lies in the frame's world (the camera's
// metres: the scene's own while it is shown, the map centre's otherwise),
// written into a uniform without allocating:
//
//   const mask = new ZoneMask(device);
//   mask.set(camera.zone);                        // a new texture when the contour changes
//   mask.place(camera.toMercator, data, offset);  // [x0, y0, 1 / width, 1 / height], zeros without one
//   mask.texture                                  // what to bind (a 1 x 1 empty one without a contour)
import { zoneMask, mercatorX, mercatorY } from "../../data/sceneZone.js";

// the masks made, by contour and size: the drapes and the effects share one (a few ms each)
const made = new WeakMap();
function maskOf(zone, size) {
  let bySize = made.get(zone);
  if (!bySize) made.set(zone, (bySize = new Map()));
  if (!bySize.has(size)) bySize.set(size, zoneMask(zone, size));
  return bySize.get(size);
}

/** An r8unorm texture of width x height bytes (rows from the south). */
export function maskTexture(device, width, height, data) {
  const texture = device.createTexture({
    size: [width, height],
    format: "r8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  const row = Math.ceil(width / 256) * 256,
    padded = row === width ? data : new Uint8Array(row * height);
  if (padded !== data) for (let j = 0; j < height; j++) padded.set(data.subarray(j * width, (j + 1) * width), j * row);
  device.queue.writeTexture({ texture }, padded, { bytesPerRow: row }, [width, height]);
  return texture;
}

/**
 * The mask rectangle [x0, y0, x1, y1] (metres of the scene's frame, y north)
 * in a camera's world: Mercator rectangle `mercator` [west x, south y, east x,
 * north y] through toMercator [x0, y0, sx, sy] (world → Mercator x0 + x sx,
 * y0 + y sy). Writes [world x0, world y0 (south), 1 / width, 1 / height] at `offset`.
 */
export function placeRect(mercator, toMercator, out, offset = 0) {
  const [t0, t1, sx, sy] = toMercator,
    x0 = (mercator[0] - t0) / sx,
    x1 = (mercator[2] - t0) / sx,
    y0 = (mercator[1] - t1) / sy,
    y1 = (mercator[3] - t1) / sy;
  out[offset] = Math.min(x0, x1);
  out[offset + 1] = Math.min(y0, y1);
  out[offset + 2] = 1 / Math.abs(x1 - x0);
  out[offset + 3] = 1 / Math.abs(y1 - y0);
  return out;
}

export class ZoneMask {
  constructor(device, size = 256) {
    this.device = device;
    this.size = size;
    this.zone = null;
    this.mask = null; // { texture, rect (scene metres), mercator: [west, south, east, north] }
    this.empty = maskTexture(device, 1, 1, new Uint8Array(1));
  }
  /** The contour (a polygon zone) or null; true when the texture changed (bind groups to make again). */
  set(zone) {
    const contour = zone?.kind === "polygon" ? zone : null;
    if (contour === this.zone) return false;
    this.zone = contour;
    this.mask?.texture.destroy();
    this.mask = null;
    if (contour) {
      const m = maskOf(contour, this.size),
        [x0, y0, x1, y1] = m.rect,
        // a contour without its frame (tests): the camera's world is the scene's own
        sw = contour.frame?.toLngLat(x0, y0),
        ne = contour.frame?.toLngLat(x1, y1);
      this.mask = {
        texture: maskTexture(this.device, m.width, m.height, m.data),
        rect: m.rect,
        mercator: sw ? [mercatorX(sw[0]), mercatorY(sw[1]), mercatorX(ne[0]), mercatorY(ne[1])] : null,
      };
    }
    return true;
  }
  get texture() {
    return this.mask?.texture ?? this.empty;
  }
  /** [x0, y0, 1 / width, 1 / height] of the mask in the camera's world at `offset` of `out`; zeros without a contour. */
  place(toMercator, out, offset = 0) {
    if (!this.mask || !toMercator) {
      out[offset] = out[offset + 1] = out[offset + 2] = out[offset + 3] = 0;
      return out;
    }
    if (!this.mask.mercator) {
      const [x0, y0, x1, y1] = this.mask.rect;
      out[offset] = x0;
      out[offset + 1] = y0;
      out[offset + 2] = 1 / (x1 - x0);
      out[offset + 3] = 1 / (y1 - y0);
      return out;
    }
    return placeRect(this.mask.mercator, toMercator, out, offset);
  }
  destroy() {
    this.mask?.texture.destroy();
    this.empty.destroy();
    this.mask = null;
  }
}
