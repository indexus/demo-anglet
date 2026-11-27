// Analysis is performed only while the diagnostic dialog is open. Keep source
// spans intact; elapsed lane occupancy is a union, never a sum of nested CPU work.
export const flowStages = ["network", "worker", "gpu", "display"];
export const flowStage = (lane) =>
  lane.includes("réseau")
    ? "network"
    : lane.includes("GPU")
      ? "gpu"
      : lane.includes("affichage") || lane.includes("attente") || lane.includes("étapes")
        ? "display"
        : lane.includes("worker") || lane === "pré-calcul"
          ? "worker"
          : null;
export function resolvedEvents(events, active = []) {
  const ended = new Set(events.filter((e) => e.id && e.status !== "running").map((e) => e.id)),
    seen = new Set();
  return [...events, ...active].filter((e) => {
    if (e.status !== "running" || !e.id) return true;
    if (ended.has(e.id) || seen.has(e.id)) return false;
    seen.add(e.id);
    return e.ms !== undefined;
  });
}
export function occupiedTime(events, left, right) {
  const spans = events
    .filter((e) => e.ms > 0)
    .map((e) => [Math.max(left, e.at), Math.min(right, e.at + e.ms)])
    .filter(([a, b]) => b > a)
    .sort((a, b) => a[0] - b[0]);
  let total = 0,
    end = -Infinity;
  for (const [a, b] of spans) {
    total += Math.max(0, b - Math.max(a, end));
    end = Math.max(end, b);
  }
  return total;
}
export function cameraFlow(events, camera, right) {
  const selected = events.filter((e) => e.at <= right && (camera === null || e.camera === camera)),
    movement = selected.find(
      (e) => e.lane === "caméra" && e.name === "Mouvement" && e.ms !== undefined,
    ),
    left =
      camera === null ? 0 : (movement?.at ?? selected.reduce((at, e) => Math.min(at, e.at), right));
  const stages = Object.fromEntries(
      flowStages.map((stage) => [
        stage,
        occupiedTime(
          selected.filter((e) => flowStage(e.lane) === stage),
          left,
          right,
        ),
      ]),
    ),
    network = selected.filter(
      (e) => e.lane.includes("réseau") && e.status === "complete" && e.at + (e.ms ?? 0) <= right,
    ),
    adoptions = selected.filter((e) => e.name === "Buffers adoptés"),
    last = adoptions.at(-1),
    movementEnd = movement ? movement.at + movement.ms : left;
  return {
    camera,
    stages,
    budget: selected.filter((e) => e.name === "Budget caméra").at(-1),
    requests: network.length,
    requests3d: network.filter((e) => e.lane === "réseau 3D").length,
    wireBytes3d: network
      .filter((e) => e.lane === "réseau 3D")
      .reduce((n, e) => n + (e.wireBytes ?? 0), 0),
    wireBytes: network.reduce((n, e) => n + (e.wireBytes ?? 0), 0),
    cancelled: selected.filter((e) => e.status === "cancelled").length,
    adoptions: adoptions.length,
    catchupMs: camera !== null && last ? Math.max(0, last.at - movementEnd) : null,
    last,
  };
}
export function overviewBins(events, left, right, count = 120) {
  const span = Math.max(1, right - left),
    step = span / count,
    bins = Array.from({ length: count }, (_, i) => ({
      at: left + i * step,
      wireBytes: 0,
      network: 0,
      worker: 0,
      gpu: 0,
      display: 0,
    })),
    delta = Object.fromEntries(flowStages.map((s) => [s, new Float64Array(count + 1)]));
  for (const e of events) {
    if (e.at <= right && e.lane === "caméra" && Number.isFinite(e.zoom)) {
      const i = Math.max(0, Math.min(count - 1, Math.floor((e.at - left) / step)));
      bins[i].zoom = e.zoom;
    }
    if (e.lane.includes("réseau") && e.status === "complete") {
      const i = Math.floor((e.at + (e.ms ?? 0) - left) / step);
      if (i >= 0 && i < count) bins[i].wireBytes += e.wireBytes ?? 0;
    }
    if (e.at <= right && e.name === "Buffers adoptés") {
      const i = Math.max(0, Math.min(count - 1, Math.floor((e.at - left) / step)));
      for (const key of ["roofPatches", "canopyCells", "plannedBytes"])
        if (Number.isFinite(e[key])) bins[i][key] = e[key];
    }
    const stage = flowStage(e.lane),
      a = Math.max(left, e.at),
      b = Math.min(right, e.at + (e.ms ?? 0));
    if (
      !stage ||
      b <= a ||
      (stage === "worker" && e.name && !["Worker 3D", "Préparation anticipée"].includes(e.name)) ||
      (stage === "gpu" && e.name && e.name !== "Transfert et préparation GPU")
    )
      continue;
    const first = Math.min(count - 1, Math.floor((a - left) / step)),
      last = Math.min(count - 1, Math.floor((b - left) / step));
    if (first === last) {
      bins[first][stage] += (b - a) / step;
      continue;
    }
    bins[first][stage] += (left + (first + 1) * step - a) / step;
    bins[last][stage] += (b - (left + last * step)) / step;
    delta[stage][first + 1]++;
    delta[stage][last]--;
  }
  for (const stage of flowStages) {
    let current = 0;
    for (let i = 0; i < count; i++) {
      current += delta[stage][i];
      bins[i][stage] += current;
    }
  }
  for (const key of ["zoom", "roofPatches", "canopyCells", "plannedBytes"]) {
    let value;
    for (const b of bins) {
      if (b[key] !== undefined) value = b[key];
      else if (value !== undefined) b[key] = value;
    }
  }
  return bins;
}
