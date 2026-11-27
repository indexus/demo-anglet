import { cameraOptionsFromLocal } from "../point-cloud/cameraPose.js";
import * as maplibregl from "maplibre-gl";
import { floorZoom } from "./cameraFloor.js";
const { MercatorCoordinate } = maplibregl;

// Local metres are the same coordinates used by the displayed scene mesh.
// radius: the scene's disc (metres, 0: none), or its zone (data/sceneZone.js): a step stays inside.
export function groundStep(nav, position, dx, dy, radius = 0) {
  const q = [position[0] + dx, position[1] + dy],
    b = nav.bounds;
  if (
    (b && (q[0] < b[0] || q[1] < b[1] || q[0] > b[2] || q[1] > b[3])) ||
    (typeof radius === "number" ? radius && Math.hypot(...q) > radius : !radius.contains(q[0], q[1]))
  )
    return position;
  const z = nav.height(q),
    old = nav.height(position);
  if (
    !Number.isFinite(z) ||
    Math.abs(z - old) > Math.max(0.5, Math.hypot(dx, dy) * 0.8) ||
    nav.surface(q) > z + 2
  )
    return position;
  return [...q, z + 1.8];
}
const GLIDE_DECAY = 2.5, // 1/s: a glide forward slows down as exp(-GLIDE_DECAY t)
  BACK_TO_MAP = 120; // px of wheel back (within WHEEL_MS) going up to the map: a trackpad's drift does not
const WHEEL_MS = 180; // wheel events closer than this are one quick scroll: it goes further each time
/**
 * The speed (m/s) a wheel event forward adds to the glide: a notch of 100 px is about a metre and a
 * half; a quick scroll (events closer than WHEEL_MS) adds more at each event, up to 8 times, so a
 * fast scroll goes far. Returns { speed, streak }.
 */
export function wheelImpulse(deltaY, sinceLast, streak = 0) {
  const quick = sinceLast < WHEEL_MS,
    next = quick ? Math.min(streak + 1, 14) : 0,
    boost = 1 + next * 0.5;
  return { speed: Math.min(4, Math.max(0, -deltaY) / 25) * boost, streak: next };
}
const REARM = 0.3, // zoom below the floor before zooming down to it enters first person again
  WALK_PITCH = 82, // a walker's eye: the horizon a little above the screen's middle (the map's view looked down)
  GESTURE_MS = 700; // a zoom this long after a wheel or a touch is the hand's
const icons = {
  compass: '<path d="m12 3-5 15 5-3 5 3Z"/><path d="M12 3v12"/>',
  person: '<circle cx="12" cy="5" r="2"/><path d="M8 20v-7l-2 3m10 4v-7l2 3M8 13V9h8v4m-4 0v7"/>',
  up: '<path d="m6 14 6-6 6 6"/>',
  down: '<path d="m6 10 6 6 6-6"/>',
};
export class NavigationControls {
  constructor(map) {
    this.map = map;
    this.active = false;
    this.armed = true; // zooming down to the floor enters first person (zoomed)
    this.keys = new Set();
    this.frame = 0;
    this.element = document.createElement("div");
    this.element.className = "scene-navigation";
    const button = (name, label) => {
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("aria-label", label);
      b.title = label;
      b.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${icons[name]}</svg>`;
      this.element.append(b);
      return b;
    };
    this.compass = button("compass", "Retrouver le nord");
    this.person = button("person", "Première personne");
    this.person.disabled = true;
    this.person.setAttribute("aria-pressed", "false");
    this.up = button("up", "Avancer au sol");
    this.down = button("down", "Reculer au sol");
    this.up.hidden = this.down.hidden = true;
    this.help = document.createElement("small");
    this.help.textContent = "Glisser pour regarder · molette pour avancer (vite : loin) · molette arrière pour remonter · flèches · Échap";
    this.help.hidden = true;
    this.element.append(this.help);
    map.getContainer().append(this.element);
    this.compass.onclick = () => {
      if (this.active) {
        this.pose.bearing = 0;
        this.apply();
      } else map.easeTo({ bearing: 0, duration: 250 });
    };
    this.person.onclick = () => (this.active ? this.exit() : this.enter());
    this.rotate = () => {
      this.compass.firstElementChild.style.transform = `rotate(${-map.getBearing()}deg)`;
    };
    map.on("rotate", this.rotate);
    this.rotate();
    this.keydown = (e) => {
      if (!this.active || e.target.closest("input,textarea,select,dialog")) return;
      if (e.key === "Escape") {
        this.exit();
        return;
      }
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "w", "a", "s", "d"].includes(e.key)) {
        e.preventDefault();
        if (!e.repeat && !this.keys.has(e.key) && !this.entering)
          this.step(
            ["ArrowDown", "s"].includes(e.key) ? -1 : ["ArrowUp", "w"].includes(e.key) ? 1 : 0,
            ["ArrowLeft", "a"].includes(e.key) ? -1 : ["ArrowRight", "d"].includes(e.key) ? 1 : 0,
            0.6,
          );
        this.keys.add(e.key);
        this.wake();
      }
    };
    this.keyup = (e) => this.keys.delete(e.key);
    this.blur = () => {
      this.keys.clear();
      this.drag = null;
    };
    window.addEventListener("keydown", this.keydown);
    window.addEventListener("keyup", this.keyup);
    window.addEventListener("blur", this.blur);
    this.canvas = map.getCanvas();
    // a drag looks around (the camera turns with the hand); the wheel walks
    this.pointerdown = (e) => {
      if (!this.active || (e.button !== 0 && e.button !== 2)) return;
      e.preventDefault();
      map.stop();
      this.entering = false;
      this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
      this.canvas.setPointerCapture(e.pointerId);
    };
    this.pointermove = (e) => {
      if (!this.active || this.drag?.id !== e.pointerId) return;
      const dx = e.clientX - this.drag.x,
        dy = e.clientY - this.drag.y;
      this.drag.x = e.clientX;
      this.drag.y = e.clientY;
      this.pose.bearing -= dx * 0.2;
      this.pose.pitch = Math.max(35, Math.min(85, this.pose.pitch - dy * 0.16));
      this.apply();
    };
    this.contextmenu = (e) => this.active && e.preventDefault();
    // the wheel: forward glides on (a quick scroll goes far), back goes up to the map
    this.wheel = (e) => {
      // a zoom by the hand (the map's wheel zoom fires its zoom events without the wheel event)
      this.gestureAt = performance.now();
      if (!this.active) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (this.entering) return;
      const now = performance.now(),
        since = now - (this.wheelAt ?? -Infinity);
      this.wheelAt = now;
      if (e.deltaY > 0) {
        this.back = (since < WHEEL_MS ? this.back : 0) + e.deltaY;
        this.glide = 0;
        if (this.back >= BACK_TO_MAP) this.exit();
        return;
      }
      this.back = 0;
      const { speed, streak } = wheelImpulse(e.deltaY * (e.deltaMode === 1 ? 33 : 1), since, this.streak);
      this.streak = streak;
      this.glide = Math.min(60, (this.glide ?? 0) + speed);
      this.wake();
    };
    this.canvas.addEventListener("contextmenu", this.contextmenu);
    map.getCanvasContainer().addEventListener("wheel", this.wheel, { passive: false, capture: true });
    this.touched = () => (this.gestureAt = performance.now());
    map.getCanvasContainer().addEventListener("touchmove", this.touched, { passive: true, capture: true });
    // down to the camera's floor (cameraFloor.js) while zooming in: first person from where the camera is
    this.zoomed = (e) => this.onZoom(e);
    map.on("zoom", this.zoomed);
    this.pointerup = (e) => {
      if (this.drag?.id === e.pointerId) this.drag = null;
    };
    this.canvas.addEventListener("pointerdown", this.pointerdown);
    this.canvas.addEventListener("pointermove", this.pointermove);
    this.canvas.addEventListener("pointerup", this.pointerup);
    this.canvas.addEventListener("pointercancel", this.pointerup);
    for (const [b, key] of [
      [this.up, "ArrowUp"],
      [this.down, "ArrowDown"],
    ]) {
      b.onpointerdown = (e) => {
        e.preventDefault();
        b.setPointerCapture(e.pointerId);
        if (!this.entering) this.step(key === "ArrowUp" ? 1 : -1, 0, 0.6);
        this.keys.add(key);
        this.wake();
      };
      b.onpointerup = b.onpointercancel = b.onlostpointercapture = () => this.keys.delete(key);
    }
  }
  setVisible(value) {
    if (!value) this.exit(false);
    this.person.disabled = !value || !this.nav;
  }
  setScene(scene, nav) {
    if (this.scene !== scene && this.active) this.exit(false);
    this.scene = scene;
    this.nav = nav;
    this.person.disabled = !nav;
  }
  /** A zoom by the user (e.originalEvent): down to the floor, first person from here. */
  onZoom(e) {
    const zoom = this.map.getZoom(),
      last = this.lastZoom ?? zoom;
    this.lastZoom = zoom;
    const byHand = e?.originalEvent || performance.now() - (this.gestureAt ?? -Infinity) < GESTURE_MS;
    if (this.active || !this.nav || this.person.disabled || !byHand) return;
    const floor = this.floor();
    if (zoom < floor - REARM) this.armed = true;
    if (this.armed && zoom > last && zoom >= floor - 0.02) this.enter({ here: true });
  }
  /** The zoom at which the camera stands at its floor, here (cameraFloor.js). */
  floor() {
    const map = this.map;
    return floorZoom({
      height: map.getCanvas().clientHeight || 800,
      fov: map.getVerticalFieldOfView?.() ?? 36.87,
      pitch: map.getPitch(),
      lat: map.getCenter().lat,
    });
  }
  /**
   * The camera's place in the scene's metres (on the ground under it): the map's centre, back
   * along the bearing by the camera's distance across the ground.
   */
  cameraGround() {
    const map = this.map,
      origin = MercatorCoordinate.fromLngLat(this.scene.origin),
      centre = MercatorCoordinate.fromLngLat(map.getCenter()),
      unit = this.scene.unit,
      lat = (map.getCenter().lat * Math.PI) / 180,
      height = map.getCanvas().clientHeight || 800,
      toCentre = (0.5 * height) / Math.tan(((map.getVerticalFieldOfView?.() ?? 36.87) * Math.PI) / 360),
      metresPerPixel = (40075016.68557849 * Math.cos(lat)) / (512 * 2 ** map.getZoom()),
      back = toCentre * metresPerPixel * Math.sin((map.getPitch() * Math.PI) / 180),
      r = (map.getBearing() * Math.PI) / 180,
      x = (centre.x - origin.x) / unit - Math.sin(r) * back,
      y = (origin.y - centre.y) / unit - Math.cos(r) * back;
    return [x, y];
  }
  /** here: from where the camera is (zooming down to its floor), else the scene's start. */
  enter({ here = false } = {}) {
    if (!this.nav) return;
    const map = this.map;
    const centre = map.getCenter();
    this.armed = false;
    this.saved = {
      center: [centre.lng, centre.lat],
      // back up a little above the floor, out of reach of the next zoom in
      zoom: here ? map.getZoom() - REARM - 0.4 : map.getZoom(),
      bearing: map.getBearing(),
      pitch: map.getPitch(),
      elevation: map.getCenterElevation(),
      clamped: map.getCenterClampedToGround?.() ?? false,
    };
    this.maxPitch = map.getMaxPitch();
    map.setMaxPitch(Math.max(85, this.maxPitch));
    this.handlers = [
      "dragPan",
      "dragRotate",
      "keyboard",
      "scrollZoom",
      "touchZoomRotate",
      "touchPitch",
      "doubleClickZoom",
    ].filter((k) => map[k]?.isEnabled());
    for (const k of this.handlers) map[k].disable();
    const start = this.nav.start.position,
      ground = here ? this.cameraGround() : null,
      at = ground && Number.isFinite(this.nav.height(ground)) ? ground : start;
    this.pose = here
      ? { position: [at[0], at[1], this.nav.height(at) + 1.8], bearing: map.getBearing(), pitch: WALK_PITCH }
      : { position: [start[0], start[1], this.nav.height(start) + 1.8], bearing: this.nav.start.bearing ?? map.getBearing(), pitch: 82 };
    this.active = true;
    this.entering = true;
    this.person.setAttribute("aria-pressed", "true");
    this.person.title = "Quitter la première personne";
    this.up.hidden = this.down.hidden = this.help.hidden = false;
    document.body.dataset.firstPerson = "true";
    // easeTo animates pose but does not apply CameraOptions.elevation.
    const camera = this.camera();
    // first person sets its own height: the centre no longer follows the ground (cameraFloor.js)
    map.setCenterClampedToGround?.(false);
    map.setCenterElevation(camera.elevation);
    this.enterEnd = () => {
      this.entering = false;
    };
    map.once("moveend", this.enterEnd);
    map.easeTo({ ...camera, duration: here ? 450 : 650 }, { firstPerson: true });
    this.helpTimer = setTimeout(() => {
      this.help.hidden = true;
    }, 5000);
  }
  camera() {
    return cameraOptionsFromLocal(
      this.map,
      this.scene,
      this.pose.position,
      this.pose.bearing,
      this.pose.pitch,
    );
  }

  step(forward, side, distance) {
    const r = (this.pose.bearing * Math.PI) / 180;
    this.pose.position = groundStep(
      this.nav,
      this.pose.position,
      (Math.sin(r) * forward + Math.cos(r) * side) * distance,
      (Math.cos(r) * forward - Math.sin(r) * side) * distance,
      this.scene.zone ?? this.scene.radius,
    );
    this.apply();
  }
  apply() {
    if (this.active) this.map.jumpTo(this.camera(), { firstPerson: true });
  }
  wake() {
    if (!this.frame) {
      this.last = performance.now();
      this.heldAt = this.last;
      this.frame = requestAnimationFrame((now) => this.tick(now));
    }
  }
  tick(now) {
    this.frame = 0;
    if (!this.active || (!this.keys.size && !(this.glide > 0.05))) {
      this.glide = 0;
      return;
    }
    if (!this.entering && this.glide > 0.05) {
      // the glide forward, slowing down; stopped by what the ground does not let through
      const dt = Math.min(0.04, (now - this.last) / 1000),
        r = (this.pose.bearing * Math.PI) / 180,
        d = this.glide * dt,
        next = groundStep(this.nav, this.pose.position, Math.sin(r) * d, Math.cos(r) * d, this.scene.zone ?? this.scene.radius);
      if (next === this.pose.position) this.glide = 0;
      else {
        this.pose.position = next;
        this.apply();
      }
      this.glide *= Math.exp(-GLIDE_DECAY * dt);
    }
    if (!this.entering && this.keys.size) {
      const dt = Math.min(0.04, (now - this.last) / 1000),
        speed = 5 + Math.min(3, (now - this.heldAt) / 600),
        k = this.keys,
        forward = Number(k.has("ArrowUp") || k.has("w")) - Number(k.has("ArrowDown") || k.has("s")),
        side = Number(k.has("ArrowRight") || k.has("d")) - Number(k.has("ArrowLeft") || k.has("a")),
        r = (this.pose.bearing * Math.PI) / 180,
        n = Math.max(1, Math.hypot(forward, side));
      const dx = ((Math.sin(r) * forward + Math.cos(r) * side) * speed * dt) / n,
        dy = ((Math.cos(r) * forward - Math.sin(r) * side) * speed * dt) / n;
      const next = groundStep(
        this.nav,
        this.pose.position,
        dx,
        dy,
        this.scene.zone ?? this.scene.radius,
      );
      if (next !== this.pose.position) {
        this.pose.position = next;
        this.apply();
      }
    }
    this.last = now;
    this.frame = requestAnimationFrame((t) => this.tick(t));
  }
  exit(restore = true) {
    if (!this.active) return;
    this.active = false;
    clearTimeout(this.helpTimer);
    this.keys.clear();
    this.drag = null;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.map.off("moveend", this.enterEnd);
    this.map.stop();
    for (const k of this.handlers) this.map[k].enable();
    this.map.setMaxPitch(this.maxPitch);
    this.person.setAttribute("aria-pressed", "false");
    this.person.title = "Première personne";
    this.up.hidden = this.down.hidden = this.help.hidden = true;
    delete document.body.dataset.firstPerson;
    if (this.saved.clamped) this.map.setCenterClampedToGround?.(true);
    if (restore) {
      if (!this.saved.clamped) this.map.setCenterElevation(this.saved.elevation);
      this.map.easeTo({ ...this.saved, duration: 550 });
    }
  }
  destroy() {
    this.exit(false);
    this.map.off("rotate", this.rotate);
    this.map.off("zoom", this.zoomed);
    this.map.getCanvasContainer().removeEventListener("wheel", this.wheel, { capture: true });
    this.map.getCanvasContainer().removeEventListener("touchmove", this.touched, { capture: true });
    this.canvas.removeEventListener("contextmenu", this.contextmenu);
    window.removeEventListener("keydown", this.keydown);
    window.removeEventListener("keyup", this.keyup);
    window.removeEventListener("blur", this.blur);
    for (const [name, fn] of [
      ["pointerdown", this.pointerdown],
      ["pointermove", this.pointermove],
      ["pointerup", this.pointerup],
      ["pointercancel", this.pointerup],
    ])
      this.canvas.removeEventListener(name, fn);
    this.element.remove();
  }
}
