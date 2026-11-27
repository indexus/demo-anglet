import { closeZoomOpacity } from "./renderBudget.js";
import { Marker } from "maplibre-gl";

const cloudPath = "M5 12a3 3 0 0 1 0-6h1a4 4 0 0 1 7.5 1A2.5 2.5 0 0 1 13 12Z";
export const weatherIcons = {
  clear: [
    "Ciel dégagé",
    "M8 1v2m0 10v2M1 8h2m10 0h2M3 3l1.4 1.4m7.2 7.2L13 13M13 3l-1.4 1.4m-7.2 7.2L3 13M11 8a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z",
  ],
  partlyCloudy: ["Éclaircies", "M1 5h1m1-3 1 1m2-2v1m-4 6a3 3 0 0 1 4-4" + cloudPath],
  cloudy: ["Nuageux", cloudPath],
  rain: ["Pluie", cloudPath + "M6 14l-1 1m5-1-1 1m5-1-1 1"],
};

export function weatherKind(conditions) {
  if (!conditions) return "";
  if (conditions.rain >= 0.1) return "rain";
  if (conditions.clouds >= 60) return "cloudy";
  return conditions.clouds >= 20 ? "partlyCloudy" : "clear";
}

/** Labels of `records` [{name, coordinates, minZoom, temperatures}] (data/weather.js townSeries). */
export function addCityTemperatures(map, records) {
  const cities = records.map((city) => {
    const label = document.createElement("div");
    label.className = "city-temperature";
    label.style.visibility = "hidden";
    const name = document.createElement("span");
    name.textContent = city.name;
    const value = document.createElement("strong");
    const reading = document.createElement("div");
    reading.className = "city-reading";
    const icon = document.createElement("span");
    icon.hidden = true;
    reading.append(icon, value);
    label.append(name, reading);
    return { ...city, label, value, marker: null, icon };
  });

  let hour,
    enabled = true;
  let conditionsAt;

  function layout() {
    if (!enabled || hour === undefined) return;
    const { clientWidth: width, clientHeight: height } = map.getContainer();
    const zoom = map.getZoom();
    // Fade city readings out before the close LiDAR / building view.
    const opacity = closeZoomOpacity(zoom);
    if (opacity === 0) {
      for (const city of cities)
        if (city.marker) {
          city.marker.remove();
          city.marker = null;
          city.label.style.visibility = "hidden";
        }
      return;
    }
    const horizon =
      map.getPitch() > 60
        ? height * 0.5 -
          (height / (2 * Math.tan((map.getVerticalFieldOfView() * Math.PI) / 360))) *
            Math.tan(((90 - map.getPitch()) * Math.PI) / 180)
        : -Infinity;
    const candidates = [];
    const centre = map.getCenter();
    const start = Math.floor(hour);
    for (const city of cities) {
      const a = city.temperatures[start],
        b = city.temperatures[Math.ceil(hour)];
      const nearby =
        map.getPitch() < 60 ||
        zoom < 14 ||
        Math.hypot(
          (city.coordinates[0] - centre.lng) * Math.cos((centre.lat * Math.PI) / 180),
          city.coordinates[1] - centre.lat,
        ) < 0.18;
      if (nearby && zoom >= (city.minZoom ?? 0) && a != null && b != null) {
        const point = map.project(city.coordinates);
        if (
          point.x >= 0 &&
          point.x <= width &&
          point.y >= Math.max(0, horizon + 6) &&
          point.y <= height
        ) {
          const text = `${Math.round(a + (b - a) * (hour - start))} °C`;
          if (city.value.textContent !== text) city.value.textContent = text;
          updateIcon(city.icon, weatherKind(conditionsAt?.(city.coordinates, hour, zoom)));
          city.label.style.opacity = String(opacity);
          city.marker ??= new Marker({ element: city.label })
            .setLngLat(city.coordinates)
            .addTo(map);
          candidates.push({ city, point });
          continue;
        }
      }
      if (city.marker) {
        city.marker.remove();
        city.marker = null;
        city.label.style.visibility = "hidden";
      }
    }
    // Read dimensions before changing visibility to avoid repeated browser layouts.
    const dimensions = candidates.map(({ city }) => [
      city.label.offsetWidth / 2 + 4,
      city.label.offsetHeight / 2 + 4,
    ]);
    const occupied = [];
    for (const [
      i,
      {
        city,
        point: { x, y },
      },
    ] of candidates.entries()) {
      const [halfWidth, halfHeight] = dimensions[i];
      const box = [x - halfWidth, y - halfHeight, x + halfWidth, y + halfHeight];
      const overlaps = occupied.some(
        ([l, t, r, b]) => box[0] < r && box[2] > l && box[1] < b && box[3] > t,
      );
      const visible =
        x >= halfWidth &&
        x <= width - halfWidth &&
        y >= halfHeight &&
        y <= height - halfHeight &&
        !overlaps;
      if (visible) occupied.push(box);
      const visibility = visible ? "visible" : "hidden";
      if (city.label.style.visibility !== visibility) city.label.style.visibility = visibility;
    }
  }

  function updateIcon(icon, kind) {
    if ((icon.dataset.weather ?? "") === kind) return;
    icon.dataset.weather = kind;
    icon.hidden = !kind;
    if (kind) {
      const [description, path] = weatherIcons[kind];
      icon.innerHTML = `<svg role="img" aria-label="${description}" viewBox="0 0 16 16"
        fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"
        stroke-linejoin="round"><path d="${path}"/></svg>`;
    } else {
      icon.replaceChildren();
    }
  }

  let pending = 0;
  function queueLayout() {
    if (pending) return;
    pending = requestAnimationFrame(() => {
      pending = 0;
      layout();
    });
  }
  map.on("move", queueLayout);
  map.on("resize", queueLayout);
  return {
    setVisible(value) {
      enabled = value;
      if (value) queueLayout();
      else
        for (const city of cities)
          if (city.marker) {
            city.marker.remove();
            city.marker = null;
            city.label.style.visibility = "hidden";
          }
    },
    remove() {
      cancelAnimationFrame(pending);
      map.off("move", queueLayout);
      map.off("resize", queueLayout);
      for (const { marker } of cities) marker?.remove();
    },
    /** `force`: the conditions changed for the same hour (their sums arrived). */
    update(nextHour, nextConditionsAt, force = false) {
      if (!force && hour === nextHour && conditionsAt === nextConditionsAt) return;
      hour = nextHour;
      conditionsAt = nextConditionsAt;
      queueLayout();
    },
  };
}
