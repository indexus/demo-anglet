// Bound animated weather and close 3D independently of display density.
export const ATMOSPHERE_PIXELS = 350000;
export const TEMPERATURE_PIXELS = 350000;
export const PLAYBACK_INTERVAL = 1000 / 30;
export const IDLE_WEATHER_INTERVAL = 1000 / 20;

export function boundedRenderScale(width, height, maxPixels, maxScale = 1) {
  return Math.min(maxScale, Math.sqrt(maxPixels / Math.max(1, width * height)));
}

export const CLOSE_SCENE_ZOOM = 14;

// The zooms of a scene's place (its contour: Anglet, the commune) while the map
// comes down to it, each a step of half a zoom (renderBudget.test.js):
//   11.5 → 12  the temperature, the clouds and the rain of the 2D map fade out
//              over the contour, and the orthophoto fades in there (its
//              collection holds levels 12 to 18);
//   12         the photo covers the contour (the basemap's geometry hidden
//              when the view is inside it); MapLibre's terrain from 12.5;
//   13         the 3D (buildings, vegetation, the scene's clouds and rain);
//   13.5 → 14  outside the contour the weather leaves as before (CLOSE_SCENE_ZOOM).
export const ZONE_FADE_ZOOM = 11.5;
export const ORTHO_ZOOM = 12;
export const SCENE_ZOOM = 13;
/** How much of the 2D weather (temperature, clouds, rain) is taken off a scene's contour: 0 → 1 from 11.5 to 12. */
export function zoneWeatherFade(zoom) {
  return Math.max(0, Math.min(1, (zoom - ZONE_FADE_ZOOM) / (ORTHO_ZOOM - ZONE_FADE_ZOOM)));
}
/** The orthophoto's raster-opacity over the zoom (a MapLibre expression): 0 at 11.5, 1 from 12. */
export const ORTHO_OPACITY = ["interpolate", ["linear"], ["zoom"], ZONE_FADE_ZOOM, 0, ORTHO_ZOOM, 1];

// Shared handoff to the uncoloured terrain / close building view.
export function closeZoomOpacity(zoom, endZoom = 16) {
  return Math.max(0, Math.min(1, (endZoom - zoom) / 0.5));
}

// Native vector/cartographic definition in the overview; keep the close 3D
// renderer at its established single-pixel budget.
export function overviewPixelRatio(deviceRatio = 1) {
  return Math.max(1, Math.min(2, Number(deviceRatio) || 1));
}
export const DVF_PIXELS = 8000000;
export function dvfRenderScale(width, height, pixelRatio = 1) {
  return boundedRenderScale(width * pixelRatio, height * pixelRatio, DVF_PIXELS);
}
/**
 * The DVF heat's opacity over the whole map (as before the single renderer):
 * none from CLOSE_SCENE_ZOOM while the 3D scene is shown (its roofs carry the
 * prices); from SCENE_ZOOM to there the scene is shown and the heat stays
 * outside its contour (heatDrape.js keeps out of it). On the 2D map it gives
 * way to the sale labels at labelZoom.
 */
export function dvfHeatOpacity(zoom, { scene = false, points = false, labelZoom = CLOSE_SCENE_ZOOM } = {}) {
  if (scene) return zoom >= CLOSE_SCENE_ZOOM ? 0 : 1;
  return points && zoom >= labelZoom ? 0 : 1;
}
