// Weather and sales remain separate. The scene mode needs neither dataset;
// it is used by the small, standalone 3D quickstart.
export const DATASETS = Object.freeze(["weather", "realestate", "scene"]);
export function parseDataset(value) {
  if (value === "both") return "realestate";
  return DATASETS.includes(value) ? value : "weather";
}
export function datasetLayers(dataset, weatherEnabled = true) {
  const realestate = dataset === "realestate",
    weather = dataset === "weather" && weatherEnabled;
  return { weather, realestate, temporal: weather, period: realestate ? "2020" : null };
}
