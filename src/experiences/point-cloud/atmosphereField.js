// Tiny disposable field built from the currently displayed terrain/roof mesh.
// Two linearly filterable 16-bit heights in RG/BA of an rgba8unorm texture
// (AirGPU decodes them after filtering, as fog stands on the ground).
export function buildAtmosphereField(surface, options = {}) {
  const field = atmosphereField(surface, options);
  field.fill(0, field.size);
  return field;
}
/** The same field, filled row by row with fill(from, to): a scene spreads it over frames. */
export function atmosphereField(surface, { size = 64, range = [-32, 512] } = {}) {
  const bounds = surface.bounds ?? [-256, -256, 256, 256],
    pixels = new Uint8Array(size * size * 4),
    span = Math.max(1, range[1] - range[0]);
  const encode = (z) => Math.round(Math.max(0, Math.min(1, (z - range[0]) / span)) * 65535);
  const fill = (from, to) => {
    for (let y = from; y < to; y++)
      for (let x = 0; x < size; x++) {
        const q = [
            bounds[0] + ((x + 0.5) / size) * (bounds[2] - bounds[0]),
            bounds[1] + ((y + 0.5) / size) * (bounds[3] - bounds[1]),
          ],
          heights = surface.heights?.(q),
          ground = heights ? heights[0] : surface.height(q),
          top = heights ? heights[1] : (surface.surface?.(q) ?? ground),
          i = (y * size + x) * 4,
          a = encode(ground),
          b = encode(Math.max(ground, top));
        pixels[i] = a >> 8;
        pixels[i + 1] = a & 255;
        pixels[i + 2] = b >> 8;
        pixels[i + 3] = b & 255;
      }
  };
  const field = { pixels, size, bounds, range: [range[0], range[0] + span] };
  return Object.defineProperty(field, "fill", { value: fill }); // not a property of the field's data
}
