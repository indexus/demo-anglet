// Small shared strokes: no images, icon font or extra rendering dependency.
const paths = {
  weather:
    "M12 3v2M5.6 5.6 7 7M3 12h2M19 12h2M17 7l1.4-1.4M12 7a5 5 0 0 1 4.7 6.7M7.2 16a4 4 0 1 1 7.6-2H17a3 3 0 0 1 0 6H8a3 3 0 0 1-.8-5.9",
  estate: "M3 10l9-7 9 7M5 9v12h14V9M9 21v-7h6v7",
  lidar: "M12 3 3 8v8l9 5 9-5V8ZM3 8l9 5 9-5M12 13v8",
  points: "M5 5h.01M12 4h.01M19 6h.01M4 12h.01M11 11h.01M19 13h.01M6 19h.01M13 18h.01M20 20h.01",
  rain: "M7 4 4 10M14 4l-3 6M21 4l-3 6M8 14l-3 6M15 14l-3 6M22 14l-3 6",
  cloud: "M6 18a4 4 0 0 1-.8-7.9A6 6 0 0 1 17 9h1a4.5 4.5 0 0 1 0 9Z",
  temperature: "M9 14.5V5a3 3 0 0 1 6 0v9.5a5 5 0 1 1-6 0ZM12 8v9",
  map: "m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3ZM9 3v15M15 6v15",
  satellite: "m8 4 4 4-4 4-4-4ZM16 12l4 4-4 4-4-4ZM10 10l4 4M16 4a4 4 0 0 1 4 4",
  target: "M12 2v4M12 18v4M2 12h4M18 12h4M12 6a6 6 0 1 0 0 12 6 6 0 0 0 0-12",
  play: "m8 4 12 8-12 8Z",
  previous: "m14 5-7 7 7 7M4 5v14",
  next: "m10 5 7 7-7 7M20 5v14",
  camera: "M3 8h5l2-3h4l2 3h5v12H3ZM12 10a4 4 0 1 0 0 8 4 4 0 0 0 0-8",
  place: "M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 0 1 14 0ZM12 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6",
  boundaries: "M3 21V7M9 21V4M15 21V7M21 21V4M3 10h18M3 17h18",
};
const defaults = {
  Données: "lidar",
  Représentation: "lidar",
  "Sol 3D": "map",
  "Détails 3D": "boundaries",
  Lieux: "place",
  Caméra: "camera",
  Lecture: "play",
  "Relevé local": "target",
};
export function cockpitIcon(command) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${command.icon === "points" ? 4 : 1.6}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[command.icon ?? defaults[command.group]] ?? paths.weather}"/></svg>`;
}
