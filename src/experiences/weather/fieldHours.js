// The hours of a weather field over its heat pipeline (variableField.js), as
// the pre-E frames of an hour and the next one did: the instances hold a pair
// (base, base + 1) blended on the GPU by the hour's fraction; the blocks hold
// the area, the pair and the hour after it (hourColumns).
//
// - A new hour whose pair the blocks hold (playback into the next hour) is a
//   rule change only, at once; the columns then move one hour on, and their
//   rules apply with the first plan of the new blocks (pipeline
//   setColumns(columns, rules)): no pack ever mixes two column sets.
// - A new hour the blocks do not hold (a jump on the timeline) waits for its
//   swap; until then the pair on screen holds at its end nearest the hour.
//
// hourState({controller, run, shift, hour}) → {columns (the first), heat,
// previousHeat, setHour(position), sync()}: create the pipeline with heat,
// previousHeat and columns, then call sync() whenever it repaints (the swap's
// plan has landed) and setHour(position) when the hour moves. `controller` may
// be given later (state.controller = pipeline.controller).
import { WEATHER_RUN, hourColumns, pairRules } from "../../data/weather.js";

export function hourState({ controller = null, run = WEATHER_RUN, shift = 0, hour = 0 }) {
  const last = run.hours - 1;
  const clamp = (h) => Math.max(0, Math.min(last, Number(h) || 0));
  let position = clamp(hour);
  // held/shown: the columns of the blocks packed and the pair base on screen;
  // asked/wanted: the swap on its way (asked === held when there is none)
  let shown = Math.floor(position);
  let held = hourColumns(shown, run);
  let asked = held;
  let wanted = shown;
  const first = pairRules(shown, held, shift, run);
  const state = {
    controller,
    columns: held,
    heat: first.heat,
    previousHeat: first.previous,
    /** The blend of the pair shown: the hour's fraction, or its nearest end while a swap is on its way. */
    sync() {
      const ctl = state.controller;
      if (!ctl) return;
      if (asked !== held && !ctl.rulesPending()) {
        held = asked;
        shown = wanted;
      }
      const base = Math.floor(position);
      const fraction = base === shown ? position - base : base > shown ? 1 : 0;
      ctl.setBlend(shown >= last ? 1 : fraction);
    },
    setHour(next) {
      position = clamp(next);
      const base = Math.floor(position);
      const ctl = state.controller;
      if (ctl && base !== wanted) {
        wanted = base;
        const now = asked === held ? pairRules(base, held, shift, run) : null;
        if (now) {
          shown = base;
          ctl.setHeat(now.heat, now.previous);
        }
        const columns = hourColumns(base, run);
        if (String(columns) !== String(asked)) {
          asked = columns;
          const rules = pairRules(base, columns, shift, run);
          ctl.setColumns(columns, { heat: rules.heat, previousHeat: rules.previous });
        }
      }
      state.sync();
    },
    /** {shown, held, asked}: what is on screen and what is on its way (tests, HUD). */
    get status() {
      return { position, shown, held, asked, waiting: asked !== held };
    },
  };
  return state;
}
