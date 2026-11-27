// View geometry shared by the scene's layers.

/**
 * The six planes of a column-major view-projection matrix (OpenGL clip),
 * pointing inward and normalised: Float64Array(24), a, b, c, d per plane, in
 * the order left, right, bottom, top, near, far. A point p is inside a plane
 * when a p.x + b p.y + c p.z + d >= 0.
 */
export function frustumPlanes(m, out = new Float64Array(24)) {
  for (let k = 0; k < 6; k++) {
    const i = k >> 1,
      a = k & 1 ? m[3] - m[i] : m[3] + m[i],
      b = k & 1 ? m[7] - m[4 + i] : m[7] + m[4 + i],
      c = k & 1 ? m[11] - m[8 + i] : m[11] + m[8 + i],
      d = k & 1 ? m[15] - m[12 + i] : m[15] + m[12 + i],
      l = Math.hypot(a, b, c) || 1;
    out[k * 4] = a / l;
    out[k * 4 + 1] = b / l;
    out[k * 4 + 2] = c / l;
    out[k * 4 + 3] = d / l;
  }
  return out;
}
