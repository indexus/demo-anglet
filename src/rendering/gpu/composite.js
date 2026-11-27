// The MapLibre side of the scene renderer: a custom layer, placed under the
// labels, that runs the frame's WebGPU passes (engine.js) and draws the
// canvas into MapLibre's framebuffer (premultiplied alpha). The only WebGL
// program of the scene.
//
// The canvas is premultiplied (alphaMode "premultiplied", every pass blends
// one, 1 - alpha) and is read as it is: UNPACK_PREMULTIPLY_ALPHA_WEBGL true.
// With false, WebGL un-premultiplies a premultiplied source on upload: a
// cloud of alpha 0.06 then came as full white, drawn with ONE over the map,
// and the ground under the scene's clouds turned white (only opaque pixels,
// roofs and trees, were right); the temperature was as opaque as its colour.
// The canvas may be smaller than the drawable (engine.scale: the 3D's single
// pixel while MapLibre draws at the screen's ratio): sampled linearly.
import { createProgram } from "../webgl.js";
import { metrics } from "../metrics.js";

const VS = `#version 300 es
in vec2 p;
out vec2 uv;
void main() { uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`;
const FS = `#version 300 es
precision mediump float;
in vec2 uv;
uniform sampler2D frame;
out vec4 color;
void main() { color = texture(frame, uv); }`;

export class SceneComposite {
  constructor(engine, id = "scene-gpu") {
    Object.assign(this, { engine, id, type: "custom", renderingMode: "3d" });
  }
  onAdd(map, gl) {
    this.map = map;
    this.program = createProgram(gl, VS, FS, { p: 0 });
    this.texture = gl.createTexture();
    this.triangle = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.triangle);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  }
  render(gl, args) {
    const t0 = metrics.start();
    this.beforeRender?.(gl, args);
    const [width, height] = this.engine.frameSize(gl);
    if (!this.engine.render(width, height)) return;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    // the WebGPU canvas has its origin top-left
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.engine.canvas);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    // the same size: each pixel's centre on a texel's; smaller: stretched
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.useProgram(this.program);
    gl.uniform1i(gl.getUniformLocation(this.program, "frame"), 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.triangle);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disableVertexAttribArray(0);
    metrics.time("map", "composite", t0);
  }
  onRemove(map, gl) {
    gl.deleteProgram(this.program);
    gl.deleteTexture(this.texture);
    gl.deleteBuffer(this.triangle);
  }
}
