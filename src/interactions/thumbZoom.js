// One pointer capture, one animation callback; shared by weather and 3D.
// Zoom is deliberately anchored to the centre, never to the right-hand thumb.
export function attachThumbZoom(
  element,
  map,
  {
    enabled = () => true,
    pointerTypes = ["touch"],
    pixelsPerZoomLevel = 90,
    onStart = () => {},
    onEnd = () => {},
    apply,
  } = {},
) {
  const abort = new AbortController(),
    options = { signal: abort.signal };
  let drag = null,
    frame = 0;
  const update = () => {
    frame = 0;
    if (!drag || Math.abs(map.getZoom() - drag.zoom) < 0.001) return;
    if (apply) apply(drag.zoom);
    else map.easeTo({ zoom: drag.zoom, duration: 100, easeId: "thumb-zoom" });
  };
  const finish = (event) => {
    if (!drag || (event && event.pointerId !== drag.id)) return;
    if (frame) {
      cancelAnimationFrame(frame);
      frame = 0;
      if (event?.type === "pointerup") update();
    }
    const id = drag.id;
    drag = null;
    delete element.dataset.active;
    if (element.hasPointerCapture(id)) element.releasePointerCapture(id);
    onEnd();
  };
  element.addEventListener(
    "pointerdown",
    (event) => {
      if (!enabled() || !pointerTypes.includes(event.pointerType) || !event.isPrimary || drag)
        return;
      event.preventDefault();
      event.stopPropagation();
      map.stop();
      onStart();
      element.setPointerCapture(event.pointerId);
      drag = { id: event.pointerId, y: event.clientY, zoom: map.getZoom() };
      element.dataset.active = "";
    },
    options,
  );
  element.addEventListener(
    "pointermove",
    (event) => {
      if (event.pointerId !== drag?.id) return;
      event.preventDefault();
      const delta = drag.y - event.clientY;
      drag.y = event.clientY;
      drag.zoom = Math.max(
        map.getMinZoom(),
        Math.min(map.getMaxZoom(), drag.zoom + delta / pixelsPerZoomLevel),
      );
      if (!frame) frame = requestAnimationFrame(update);
    },
    options,
  );
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"])
    element.addEventListener(type, finish, options);
  return {
    cancel: () => finish(),
    destroy() {
      finish();
      abort.abort();
    },
  };
}
