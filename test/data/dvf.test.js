import test from "node:test";
import assert from "node:assert/strict";

import { normalizeCellPositionConfig } from "js-indexus-sdk/map";
import {
  DVF_CELL_POSITION,
  DVF_HEAT,
  DVF_METRICS,
  DVF_VALUE_METRIC_INDEX,
  DVF_VISUAL,
  summarizeDvf,
} from "../../src/data/dvf.js";

// The pack's reading of heat rules (sdk docs/heat-pipeline.md §c): the
// first rule with num > 0 and den > minDen; -1 reads the count.
function heatOf(rules, count, sums) {
  const read = (column) => (column < 0 ? count : (sums[column] ?? 0));
  for (const rule of rules) {
    const num = read(rule.num);
    const den = read(rule.den);
    if (!(num > 0 && den > (rule.minDen ?? 0))) continue;
    return rule.transform === 1 ? [Math.log1p(num), 1] : [num, den];
  }
  return [0, 0];
}

// Two sales: 200 000 € for 100 m² (2 000 €/m²) and 300 000 € for 50 m² (6 000 €/m²).
const SUMS = [500000, 150, 8000];

test("a DVF cell shows the mean €/m² of its sales", () => {
  const [num, den] = heatOf(DVF_HEAT, 2, SUMS);
  assert.equal(num / den, 4000);
});

test("a cell without prices shows its density", () => {
  assert.deepEqual(heatOf(DVF_HEAT, 3, [0, 0, 0]), [Math.log1p(3), 1]);
  assert.deepEqual(heatOf(DVF_HEAT, 0, []), [0, 0]);
});

test("the view summary averages per sale", () => {
  assert.deepEqual(summarizeDvf(2, SUMS), {
    transactions: 2,
    avgValeurFonciere: 250000,
    avgSurfaceM2: 75,
    avgEuroM2: 4000,
  });
  assert.deepEqual(summarizeDvf(0, []), {
    transactions: 0,
    avgValeurFonciere: null,
    avgSurfaceM2: null,
    avgEuroM2: null,
  });
  assert.equal(summarizeDvf(4, [0, 0, 0]).avgEuroM2, null);
});

test("the DVF settings are the SDK's former defaults (sdk e5cf8da)", () => {
  // [valeur, surface, €/m², lat, lng]
  assert.deepEqual(DVF_METRICS, { valeur: 0, surface: 1, euroM2: 2, lat: 3, lng: 4 });
  assert.deepEqual(normalizeCellPositionConfig(DVF_CELL_POSITION), {
    mode: "metrics",
    metricLatIndex: 3,
    metricLngIndex: 4,
  });
  assert.equal(DVF_VALUE_METRIC_INDEX, 2);
  assert.deepEqual(DVF_VISUAL, { multiplier: 2.5, areaMode: 0, centroidSnap: 0 });
  // the heat reads the €/m² column of the same layout
  assert.equal(DVF_HEAT[0].num, DVF_METRICS.euroM2);
});
