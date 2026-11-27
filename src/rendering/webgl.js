// The WebGL program of the scene renderer's composite (rendering/gpu/composite.js), the
// only one of Explore. No global GL state or cache.
export function createProgram(
  gl,
  vertex,
  fragment,
  attributes = {},
  { transformFeedbackVaryings } = {},
) {
  const program = gl.createProgram(),
    shaders = [];
  try {
    for (const [type, source] of [
      [gl.VERTEX_SHADER, vertex],
      [gl.FRAGMENT_SHADER, fragment],
    ]) {
      const shader = gl.createShader(type);
      shaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw Error(gl.getShaderInfoLog(shader));
      gl.attachShader(program, shader);
    }
    for (const [name, location] of Object.entries(attributes))
      gl.bindAttribLocation(program, location, name);
    if (transformFeedbackVaryings)
      gl.transformFeedbackVaryings(program, transformFeedbackVaryings, gl.INTERLEAVED_ATTRIBS);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw Error(gl.getProgramInfoLog(program));
    return program;
  } catch (error) {
    gl.deleteProgram(program);
    throw error;
  } finally {
    for (const shader of shaders) gl.deleteShader(shader);
  }
}
