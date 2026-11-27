// One main-thread deadline per browser frame for the scene's work: `ms` in
// all (4 by default), handed out in the order the work asks for it, which is
// the order of the frame: the ground's selection (the first scene layer),
// the buildings' walk, the vegetation's walk, the buildings' uploads (at the
// end of the map's frame, the composite) and the scheduler's jobs (a task
// after the frame's callbacks). What does not fit waits for the next frame.
//
// A step starts only when it fits: its consumer's last step time added to
// what the frame has spent stays within `ms`. A consumer turned away is owed
// the next frame: its estimate is kept aside from the consumers before it
// (no work waits for ever behind cheaper work), and a step longer than the
// whole budget runs there when nothing but forced work came before it. A
// consumer's first step is guessed at a quarter of the budget.
// `forced` work (the ground's selection, needed by every frame) runs always
// and is charged.
//
// The frame is the browser's: document.timeline.currentTime is the same for
// every callback and task of one frame. Without a document (tests, workers)
// each open() is a frame of its own unless `frame` says otherwise.
import { metrics } from "../rendering/metrics.js";

const browserFrame = () => globalThis.document?.timeline?.currentTime ?? undefined;

export class FrameBudget {
  constructor({ ms = 4, now = () => performance.now(), frame = browserFrame } = {}) {
    Object.assign(this, { ms, now, frame });
    this.key = null;
    this.spent = 0; // ms charged in the current frame
    this.forcedSpent = 0; // ... by forced steps
    this.cost = new Map(); // consumer -> its last step's ms (the estimate of its next)
    this.owed = new Set(); // consumers turned away in the last frame
    this.refused = new Set(); // ... in this one
    this.ran = new Set(); // consumers that ran a step in this frame
    this.reserve = 0; // ms kept aside for the owed consumers
    this.frames = 0;
  }
  /** Enter the current frame's accounting; a new frame starts it again. */
  open() {
    const key = this.frame();
    if (key !== undefined && key === this.key) return this;
    this.key = key;
    this.frames++;
    this.spent = this.forcedSpent = 0;
    this.owed = this.refused;
    this.refused = new Set();
    this.ran.clear();
    this.reserve = this.owedCost();
    return this;
  }
  estimate(name) {
    return this.cost.get(name) ?? this.ms / 4;
  }
  owedCost() {
    let reserve = 0;
    for (const name of this.owed) reserve += this.estimate(name);
    return Math.min(reserve, this.ms);
  }
  /** ms left in this frame for `name`. */
  left(name) {
    return (this.owed.has(name) ? this.ms : this.ms - this.reserve) - this.spent;
  }
  /** Whether a step of `name` may start now. */
  fits(name) {
    const cost = this.estimate(name);
    if (this.owed.has(name) && !this.ran.has(name) && this.spent === this.forcedSpent) return true;
    return cost <= this.left(name) && this.spent < this.ms;
  }
  /** Charge `ms` of `name` to this frame (and keep it as its estimate). */
  charge(name, ms) {
    metrics.count("main", "budget", ms);
    this.spent += ms;
    this.cost.set(name, ms);
    this.ran.add(name);
    if (this.owed.delete(name)) this.reserve = this.owedCost();
  }
  /** `name` could not start a step in this frame: it is owed the next one. */
  refuse(name) {
    this.refused.add(name);
  }
  /**
   * Run step() while it fits, until it returns true (done); charged to `name`.
   * forced: one step runs whatever the budget (then the rule again).
   * Returns true when step() said done.
   */
  run(name, step, { forced = false } = {}) {
    this.open();
    for (let first = true; ; first = false) {
      if (!(forced && first) && !this.fits(name)) {
        this.refuse(name);
        return false;
      }
      const t = this.now(),
        done = step(),
        ms = this.now() - t;
      if (forced && first) this.forcedSpent += ms;
      this.charge(name, ms);
      if (done) return true;
    }
  }
}
