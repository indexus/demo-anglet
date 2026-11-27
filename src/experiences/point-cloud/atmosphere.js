// Sky, clouds, fog and rain of the scene, in its local frame (SceneFrame),
// drawn by AirGPU (atmosphereGPU.js) in the effects stage of the scene
// renderer. Rain lands on the scene surface (ground and building boxes).
import { buildAtmosphereField } from "./atmosphereField.js";
import { rainClouds, cloudGeometry } from "./rainClouds.js";
import { CloudVisibility } from "./cloudVisibility.js";
import { buildRainContactsAsync, rainContactSize } from "./rainContacts.js";
import { AirGPU, CLOUD_FADE } from "./atmosphereGPU.js";
import { gpuMatrix, frameSize } from "../../rendering/gpu/engine.js";
import { Fade } from "../../rendering/fade.js";
/** ms of the cloud cover's ease when the conditions change (a new hour, the data arriving). */
export const COVER_FADE = 600;
export class SceneAtmosphere {
  id = "scene-weather";
  type = "custom";
  renderingMode = "3d";
  /**
   * engine: the scene's WebGPU renderer (rendering/gpu); bounds: the weather's
   * rectangle (scene.js weatherBounds); zone: the scene's contour (data/sceneZone.js)
   * or null: the cloud banks and the rain contacts are kept to it.
   */
  constructor(getFrame, { bounds = [-130, -130, 130, 130], range = [-32, 512], cloudOpacity = 0.55, profile = false, engine, zone = null } = {}) {
    this.profile = profile;
    this.engine = engine;
    this.cloudOpacity = cloudOpacity;
    this.getFrame = getFrame;
    this.domain = bounds;
    this.range = range;
    this.cloudAltitude = range[1] + 18;
    this.sunAltitude = range[1] + 430;
    this.mood = "sun";
    this.zone = zone;
    this.cover = null; // the cloud cover (0..1) of the conditions, eased (setConditions)
    this.clouds = rainClouds(bounds, range[1] + 18, { zone });
    this.cloudVisibility = new CloudVisibility(this.clouds);
    this.visibility = () => {
      if (document.hidden) {
        this.pause();
        this.contactAbort?.abort();
      } else {
        if (this.mood === "rain") this.updateContacts();
        this.schedule();
      }
    };
    document.addEventListener("visibilitychange", this.visibility);
  }
  onAdd(map) {
    this.map = map;
    this.gpu = new AirGPU(this.engine, cloudGeometry(), this.clouds.instances.byteLength);
    if (this.surface) this.uploadField();
    this.schedule();
  }
  /** The scene surface (sceneSurface): fog and sky heights, where rain lands. */
  updateTerrain(surface, field = null) {
    // a live surface is built again when it has grown (its version); `field`: already built (atmosphereField)
    if (surface === this.surface && surface.version === this.surfaceVersion && !field) return;
    this.surface = surface;
    this.surfaceVersion = surface.version;
    this.field = field ?? buildAtmosphereField(surface, { range: this.range });
    this.fogCentres = Float32Array.from(
      Array.from({ length: 25 }, (_, i) => [
        this.domain[0] + (((i % 5) + 0.5) / 5) * (this.domain[2] - this.domain[0]),
        this.domain[1] + ((Math.floor(i / 5) + 0.5) / 5) * (this.domain[3] - this.domain[1]),
      ]).flat(),
    );
    this.contactKey = null;
    if (this.gpu) this.uploadField();
    if (this.mood === "rain") this.updateContacts();
  }
  uploadField() {
    this.gpu.setField(this.field);
    this.fieldReady = true;
  }
  async updateContacts() {
    const surface = this.surface;
    if (!this.gpu || this.enabled === false || !surface || this.mood !== "rain" || this.contactKey === surface) return;
    this.contactAbort?.abort();
    const controller = (this.contactAbort = new AbortController()),
      gpu = this.gpu;
    this.contactKey = surface;
    this.contacts = null;
    try {
      const contacts = await buildRainContactsAsync(surface, this.domain, {
        signal: controller.signal,
        clouds: this.clouds,
        radius: this.getFrame()?.cropRadius,
        zone: this.getFrame()?.zone?.kind === "polygon" ? this.getFrame().zone : null,
        size: rainContactSize(this.domain),
      });
      if (controller.signal.aborted || this.gpu !== gpu || this.mood !== "rain") return;
      this.contacts = contacts;
      gpu.setContacts(contacts.data);
      this.map?.triggerRepaint();
    } catch (error) {
      if (this.contactKey === surface) this.contactKey = null;
      if (error.name !== "AbortError") console.warn("Rain contacts unavailable:", error.message);
    }
  }

  setMood(mood) {
    this.mood = mood;
    if (mood !== "rain") {
      this.contactAbort?.abort();
      this.contactKey = null;
    } else this.updateContacts();
    this.pause();
    this.updateBackdrop();
    this.map?.triggerRepaint();
    this.schedule();
  }
  setConditions(conditions) {
    const next = conditions ?? { rain: 0, clouds: 0 },
      prior = this.dataConditions;
    const changed =
      this.weatherKnown !== !!conditions ||
      !prior ||
      ["rain", "clouds", "observedRain"].some((k) => next[k] !== prior[k]);
    this.weatherKnown = !!conditions;
    this.dataConditions = next;
    // the banks' opacity follows the cover in time, never in one frame (the first conditions: as they are)
    const cover = Math.max(0, Math.min(1, next.clouds / 100));
    if (!this.cover) this.cover = new Fade(cover, COVER_FADE);
    else this.cover.set(cover, performance.now());
    if (!changed) {
      this.schedule();
      return;
    }
    const mood = this.dataConditions.rain > 0.08 ? "rain" : "sun";
    if (mood !== this.mood) this.setMood(mood);
    this.map?.triggerRepaint();
    this.schedule();
  }
  setView(view) {
    this.view = view;
    this.updateBackdrop();
  }
  updateBackdrop() {
    if (!this.map?.getLayer("scene-background")) return;
    const color =
      this.mood === "fog"
        ? "#b4c5c5"
        : this.mood === "rain"
          ? "#8296a1"
          : this.view && this.view !== "overview"
            ? "#9fc9df"
            : "#111c25";
    this.map.setPaintProperty("scene-background", "background-color", color);
    this.map.setSky({
      "sky-color": color,
      "horizon-color": this.mood === "sun" && this.view !== "overview" ? "#e5e9df" : color,
      "sky-horizon-blend": 0.55,
      "atmosphere-blend": 0,
    });
    this.map.setPaintProperty(
      "base",
      "raster-opacity",
      this.mood === "fog" ? 0.12 : this.mood === "rain" ? 0.2 : 0.25,
    );
  }
  schedule() {
    if (
      this.enabled === false ||
      this.timer ||
      document.hidden ||
      !this.map ||
      this.mood !== "rain"
    )
      return;
    this.timer = setTimeout(() => {
      this.timer = 0;
      this.map?.triggerRepaint();
      this.schedule();
    }, 1000 / 30);
  }
  pause() {
    clearTimeout(this.timer);
    this.timer = 0;
  }
  /** One pass of the scene renderer's effects: sun and cloud billboards, fog, cloud banks, rain. */
  render(gl) {
    if (this.enabled === false) return;
    const layer = this.getFrame();
    if (!layer?.viewMatrix || layer.hidden) return;
    const mood = { sun: 0, rain: 1, fog: 2 }[this.mood] ?? 0,
      conditions = this.dataConditions,
      now = performance.now(),
      cover = !conditions ? 0 : this.cover ? this.cover.value(now) : Math.max(0, Math.min(1, conditions.clouds / 100)),
      // the banks fade out under the eye (atmosphereGPU.js cloudFade): none to draw above that
      high = (layer.cameraLocal?.[2] ?? 0) - this.cloudAltitude >= CLOUD_FADE[1],
      cloudy = !high && (conditions ? cover > 0.05 : this.mood === "rain"),
      raining = this.mood === "rain" && this.contacts?.count && this.rainVisible !== false;
    if (cloudy && this.cloudVisibility.update(layer.viewMatrix, layer.cropRadius ?? 0)) {
      this.gpu.setClouds(this.cloudVisibility.data, this.cloudVisibility.count);
      if (this.profile)
        this.map.getContainer().dataset.sceneClouds = JSON.stringify({
          ...this.cloudVisibility.stats,
          triangles: (this.cloudVisibility.count * this.gpu.sphereCount) / 3,
        });
    }
    const plan = {
      matrix: gpuMatrix(layer.viewMatrix),
      camera: layer.cameraLocal,
      scene: [this.cloudAltitude, this.sunAltitude, mood, layer.cropRadius ?? 0],
      light: [...(layer.celestial?.sunDirection ?? [-0.4, 0.2, 1]), layer.celestial?.daylight ?? 1],
      viewport: frameSize(this.engine, gl),
      time: this.rainTime ?? performance.now() * 0.001,
      cloudOpacity: conditions ? cover * this.cloudOpacity : 1,
      sun: !conditions && this.mood === "sun",
      boards: !conditions && this.mood !== "rain",
      fog: this.mood === "fog" && this.fieldReady ? this.fogCentres : null,
      clouds: cloudy ? this.cloudVisibility.count : 0,
      drops: raining
        ? Math.ceil(this.contacts.count * (conditions ? Math.min(1, Math.sqrt(Math.max(0, conditions.rain) / 3)) : 1))
        : 0,
    };
    this.skyDraws = (this.skyDraws ?? 0) + 1;
    if (raining) this.draws = (this.draws ?? 0) + 1;
    this.engine.add("atmosphere", (pass) => this.gpu.draw(pass, plan), { stage: "effects" });
    // a frame per frame while the cover eases (and the banks are drawn), none after
    if (cloudy && this.cover?.active(now)) this.map?.triggerRepaint();
    this.schedule();
  }
  onRemove() {
    this.contactAbort?.abort();
    this.pause();
    document.removeEventListener("visibilitychange", this.visibility);
    this.gpu?.destroy();
    this.map = this.gpu = null;
  }
}
