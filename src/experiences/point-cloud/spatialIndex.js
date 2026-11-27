// Stable-order broad phase. Exact geometry tests remain with the caller.
export function spatialIndex(items, boundsOf, { cell = 16, padding = 0 } = {}) {
  const bins = new Map(),
    boxes = items.map(boundsOf);
  for (let i = 0; i < items.length; i++) {
    const b = boxes[i];
    if (!b || !b.every(Number.isFinite)) continue;
    for (let x = Math.floor((b[0] - padding) / cell); x <= Math.floor((b[2] + padding) / cell); x++)
      for (
        let y = Math.floor((b[1] - padding) / cell);
        y <= Math.floor((b[3] + padding) / cell);
        y++
      ) {
        const key = x + "/" + y;
        let list = bins.get(key);
        if (!list) bins.set(key, (list = []));
        list.push(i);
      }
  }
  return (box) => {
    const ids = new Set();
    for (let x = Math.floor(box[0] / cell); x <= Math.floor(box[2] / cell); x++)
      for (let y = Math.floor(box[1] / cell); y <= Math.floor(box[3] / cell); y++)
        for (const i of bins.get(x + "/" + y) ?? []) {
          const b = boxes[i];
          if (
            b[0] - padding <= box[2] &&
            b[2] + padding >= box[0] &&
            b[1] - padding <= box[3] &&
            b[3] + padding >= box[1]
          )
            ids.add(i);
        }
    return [...ids].sort((a, b) => a - b).map((i) => items[i]);
  };
}
// Conservative rejection: retain everything touching the disk, plus any eave.
export function outsideDisk(box, radius, padding = 0) {
  return (
    radius > 0 &&
    Math.hypot(Math.max(box[0], 0, -box[2]), Math.max(box[1], 0, -box[3])) > radius + padding
  );
}
