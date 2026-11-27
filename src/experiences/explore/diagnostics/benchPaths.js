// Camera paths replayed by ?bench=<name> (benchRun.js, sdk/docs/perf.md).
// Positions are absolute so that a replay is the same on every machine and
// every version. Changing a path breaks the comparison with its earlier
// results: add a path under a new name instead.
//
// params: URL parameters the path needs (the page reloads with them).
// steps: one camera move each, then the bench waits for the network to go
// quiet. duration 0 jumps; otherwise easeTo for that many milliseconds.
export const BENCH_PATHS = {
  france: {
    description: "Météo : France entière, zoom sur Paris, translation vers Lyon, zoom, retour.",
    params: {},
    steps: [
      { center: [2.4, 46.6], zoom: 5.25, duration: 0 },
      { center: [2.35, 48.86], zoom: 8, duration: 2500 },
      { center: [4.83, 45.76], zoom: 8, duration: 2500 },
      { center: [4.83, 45.76], zoom: 10, duration: 1500 },
      { center: [2.4, 46.6], zoom: 5.25, duration: 2500 },
    ],
  },
  realestate: {
    description: "DVF 2020 : France, Bordeaux, Paris en descendant jusqu’au quartier, retour.",
    params: { data: "realestate" },
    steps: [
      { center: [2.4, 46.6], zoom: 5.25, duration: 0 },
      { center: [-0.58, 44.84], zoom: 9, duration: 2500 },
      { center: [2.35, 48.86], zoom: 9, duration: 3000 },
      { center: [2.35, 48.86], zoom: 12, duration: 2000 },
      { center: [2.33, 48.87], zoom: 14, duration: 1500 },
      { center: [2.4, 46.6], zoom: 5.25, duration: 3000 },
    ],
  },
  anglet: {
    description: "3D Anglet : vue de la scène, approche, recul, rotation, translation.",
    params: { scene: "anglet" },
    steps: [
      { center: [-1.520707, 43.484986], zoom: 17.2, pitch: 50, bearing: -20, duration: 0 },
      { center: [-1.520707, 43.484986], zoom: 18.2, pitch: 50, bearing: -20, duration: 1500 },
      { center: [-1.520707, 43.484986], zoom: 16.2, pitch: 45, bearing: -20, duration: 1500 },
      { center: [-1.520707, 43.484986], zoom: 16.2, pitch: 45, bearing: 40, duration: 2000 },
      { center: [-1.5185, 43.4862], zoom: 17, pitch: 55, bearing: 40, duration: 2000 },
      { center: [-1.520707, 43.484986], zoom: 17.2, pitch: 50, bearing: -20, duration: 2000 },
    ],
  },
};
