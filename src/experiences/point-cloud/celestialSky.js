// The celestial sky behind the scene (SkyGPU, atmosphereGPU.js): sun, moon,
// stars and twilight from the scene's celestial state, in the opaque stage
// of the scene renderer, where nothing else was drawn.
import { SkyGPU } from "./atmosphereGPU.js";

export class CelestialSky {
  id = "scene-celestial-sky";
  type = "custom";
  renderingMode = "3d";
  /** engine: the scene's WebGPU renderer (rendering/gpu). */
  constructor(getLayer, { engine }) {
    this.getLayer = getLayer;
    this.engine = engine;
  }
  onAdd() {
    this.gpu = new SkyGPU(this.engine);
  }
  render() {
    if (this.enabled === false) return;
    const layer = this.getLayer(),
      state = layer?.celestial;
    if (!layer?.viewMatrix || !state) return;
    const view = { matrix: layer.viewMatrix, camera: layer.cameraLocal, celestial: state };
    this.engine.add("sky", (pass) => this.gpu.draw(pass, view));
  }
  onRemove() {
    this.gpu?.destroy();
    this.gpu = null;
  }
}
