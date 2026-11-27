// One scheduler for every read and every heavy step of the scene's layers.
//
// Network: at most `concurrency` reads in flight for all layers together; each
// layer gets a fair share (the layer with the fewest reads in flight relative
// to its weight goes next); inside a layer the highest priority goes first
// (layers give screen size x visibility, centre of the view first). Token
// buckets hold the bytes per second near `bytesPerSecond` and the reads per
// second under `requestsPerSecond`. A failed read is
// asked again after 0.25, 0.5, 1, 2 s (with jitter), then given up.
// What left the view is dropped: a layer calls `pass(layer)` when it walks its
// tree again; queued reads it did not ask for again in that pass are
// cancelled (reads already on the wire finish: their bytes are paid).
//
// Main thread: `work(layer, fn)` runs `fn` (synchronous: a decode, an upload
// preparation) once the frame's callbacks have run (the map's frame first),
// highest priority first, within what is left of the frame's shared budget
// (`budget`, frameBudget.js: the scene's layers spend it first); the rest
// waits for the next frame.
import { metrics } from "../rendering/metrics.js";
import { FrameBudget } from "./frameBudget.js";

const cancelled = () => Object.assign(new Error("Read left the view"), { name: "AbortError", cancelled: true });
// animation frames in the page; a timer elsewhere (tests, workers)
const nextFrame = (fn) => (globalThis.requestAnimationFrame ? requestAnimationFrame(fn) : setTimeout(fn, 0));
// a task after the current one: in a page, after the frame's other callbacks (the map's render among them)
const afterTasks = [];
let channel = null;
const afterFrame = (fn) => {
  if (!globalThis.document || !globalThis.MessageChannel) return void setTimeout(fn, 0);
  if (!channel) {
    channel = new MessageChannel();
    channel.port1.onmessage = () => afterTasks.shift()?.();
  }
  afterTasks.push(fn);
  channel.port2.postMessage(0);
};
// AbortError (fetch, ours) or the SDK transport's CanceledError (ERR_CANCELED)
export const isCancelled = (error) =>
  error?.name === "AbortError" || error?.name === "CanceledError" || error?.code === "ERR_CANCELED" || error?.cancelled;

export class Scheduler {
  /** budget: the frame's FrameBudget, shared with the scene's layers (one of frameBudgetMs by default). */
  constructor({ concurrency = 6, bytesPerSecond = 8e6, requestsPerSecond = 80, frameBudgetMs = 4, budget = null, maxQueued = 256 } = {}) {
    Object.assign(this, { concurrency, bytesPerSecond, requestsPerSecond, maxQueued });
    this.budget = budget ?? new FrameBudget({ ms: frameBudgetMs });
    this.calls = requestsPerSecond / 2; // a bucket of reads: half a second of burst
    this.layers = new Map(); // name -> { weight, pass, queue: Map(key -> entry), inflight, average }
    this.inflight = 0;
    this.tokens = bytesPerSecond * 0.5;
    this.refilled = performance.now();
    this.timer = 0;
    this.jobs = [];
    this.frame = 0;
    this.nextFrame = nextFrame; // how the work waits for the next frame (a lab in a hidden tab replaces it)
  }
  layer(name, weight = 1) {
    let l = this.layers.get(name);
    if (!l) this.layers.set(name, (l = { name, weight, pass: 0, queue: new Map(), running: new Map(), inflight: 0, average: 32768 }));
    return l;
  }
  /** A layer starts a new walk: what it does not ask for again in it is dropped from the queue. */
  pass(name) {
    const l = this.layer(name);
    l.pass++;
    // the previous pass's leftovers go once this pass has had a chance to ask for them (next pass)
    for (const [key, e] of l.queue)
      if (e.pass < l.pass - 1 && !e.sticky && !e.waiters) {
        l.queue.delete(key);
        e.reject(cancelled());
        metrics.count(name, "dropped");
      }
  }
  /**
   * Read `key` for `layer` with run(signal) -> Promise. Asking again for a
   * queued or running key returns the same promise and updates its priority.
   * options: priority (higher first), size(result) -> bytes, retries (4),
   * signal (an outside cancel, e.g. MapLibre's), sticky (never dropped by pass).
   */
  request(layer, key, run, { priority = 0, size = null, retries = 4, signal = null, sticky = false } = {}) {
    const l = this.layer(layer);
    let entry = l.queue.get(key) ?? l.running.get(key);
    if (!entry && !run) return null; // joining a read that has just finished
    if (entry) {
      entry.priority = Math.max(priority, entry.pass === l.pass ? entry.priority : -Infinity);
      entry.pass = l.pass;
    } else {
      let resolve, reject;
      const promise = new Promise((yes, no) => ((resolve = yes), (reject = no)));
      entry = { key, run, priority, size, retries, tries: 0, notBefore: 0, pass: l.pass, sticky, waiters: 0, held: false, resolve, reject, promise, queuedAt: performance.now() };
      l.queue.set(key, entry);
      if (l.queue.size > this.maxQueued) this.dropLowest(l);
      // the reads asked in the same task are ordered together before any starts
      if (!this.soon) {
        this.soon = true;
        queueMicrotask(() => {
          this.soon = false;
          this.pump();
        });
      }
    }
    // a caller with a signal (MapLibre's tile requests) holds the read until it aborts;
    // when every holder has aborted, the read is cancelled: queued, it is dropped; running, aborted
    if (signal) {
      if (!signal.aborted) {
        entry.waiters++;
        signal.addEventListener("abort", () => --entry.waiters === 0 && !entry.held && this.cancel(l, entry), { once: true });
      }
    } else entry.held = true;
    return entry.promise;
  }
  cancel(l, entry) {
    if (l.queue.get(entry.key) === entry) {
      l.queue.delete(entry.key);
      entry.reject(cancelled());
      metrics.count(l.name, "dropped");
    } else entry.controller?.abort();
  }
  dropLowest(l) {
    let low = null;
    for (const e of l.queue.values()) if (!e.sticky && !e.waiters && (!low || e.priority < low.priority)) low = e;
    if (!low) return;
    l.queue.delete(low.key);
    low.reject(cancelled());
    metrics.count(l.name, "dropped");
  }
  refill() {
    const t = performance.now();
    const seconds = (t - this.refilled) / 1000;
    this.tokens = Math.min(this.bytesPerSecond * 0.5, this.tokens + seconds * this.bytesPerSecond);
    this.calls = Math.min(this.requestsPerSecond / 2, this.calls + seconds * this.requestsPerSecond);
    this.refilled = t;
  }
  /** Next entry: the layer with the fewest reads in flight for its weight, then its highest priority. */
  next(t) {
    let best = null,
      bestLayer = null,
      bestShare = Infinity;
    for (const l of this.layers.values()) {
      if (!l.queue.size) continue;
      let top = null;
      for (const e of l.queue.values()) if (e.notBefore <= t && (!top || e.priority > top.priority)) top = e;
      if (!top) continue;
      const share = l.inflight / l.weight;
      if (share < bestShare || (share === bestShare && top.priority > best.priority)) {
        best = top;
        bestLayer = l;
        bestShare = share;
      }
    }
    return best ? [bestLayer, best] : null;
  }
  pump() {
    clearTimeout(this.timer);
    this.timer = 0;
    this.refill();
    const t = performance.now();
    while (this.inflight < this.concurrency && this.tokens > 0 && this.calls >= 1) {
      const picked = this.next(t);
      if (!picked) break;
      const [l, e] = picked;
      l.queue.delete(e.key);
      this.start(l, e);
    }
    this.report();
    // wake up for retries waiting their turn, or for the bucket to refill
    let wake = Infinity;
    for (const l of this.layers.values()) for (const e of l.queue.values()) wake = Math.min(wake, e.notBefore);
    if (this.tokens <= 0) wake = Math.min(wake, t + (-this.tokens / this.bytesPerSecond) * 1000 + 5);
    if (this.calls < 1) wake = Math.min(wake, t + ((1 - this.calls) / this.requestsPerSecond) * 1000 + 1);
    if (wake < Infinity && this.inflight < this.concurrency) this.timer = setTimeout(() => this.pump(), Math.max(5, wake - t));
  }
  start(l, e) {
    this.inflight++;
    l.inflight++;
    l.running.set(e.key, e);
    e.tries++;
    this.tokens -= l.average; // charged now with the layer's usual size, settled at the end
    this.calls -= 1;
    e.controller = new AbortController();
    const begun = performance.now();
    metrics.count(l.name, "requests");
    if (e.tries === 1) metrics.count(l.name, "queueMs", begun - e.queuedAt);
    Promise.resolve()
      .then(() => e.run(e.controller.signal))
      .then(
        (value) => {
          const bytes = e.size ? e.size(value) : 0;
          this.tokens += l.average - bytes;
          if (bytes > 0) l.average = l.average * 0.8 + bytes * 0.2;
          metrics.count(l.name, "bytes", bytes);
          metrics.count(l.name, "readMs", performance.now() - begun);
          e.resolve(value);
        },
        (error) => {
          this.tokens += l.average;
          // a refused answer (wrong bytes, bad request) is not asked again here
          if (isCancelled(error) || error?.fatal || e.controller.signal.aborted || e.tries > e.retries) {
            if (!isCancelled(error)) metrics.event(l.name, "read-failed", { key: e.key, error: String(error?.message ?? error) });
            e.reject(error);
            return;
          }
          // asked again after a pause that doubles, with jitter
          metrics.count(l.name, "retries");
          e.notBefore = performance.now() + Math.min(250 * 2 ** (e.tries - 1), 4000) * (0.75 + Math.random() * 0.5);
          e.sticky = true; // a retry is not dropped by a pass: its caller waits for it
          l.queue.set(e.key, e);
        },
      )
      .finally(() => {
        this.inflight--;
        l.inflight--;
        if (l.running.get(e.key) === e) l.running.delete(e.key);
        this.pump();
      });
  }
  report() {
    if (!metrics.on) return;
    let queued = 0;
    for (const l of this.layers.values()) {
      metrics.gauge(l.name, "inflight", l.inflight);
      metrics.gauge(l.name, "queued", l.queue.size);
      queued += l.queue.size;
    }
    metrics.gauge("net", "inflight", this.inflight);
    metrics.gauge("net", "queued", queued);
  }
  /** Reads waiting or running for a layer. */
  pending(layer) {
    const l = this.layers.get(layer);
    return l ? l.queue.size + l.inflight : 0;
  }

  // ---- main-thread work within the frame's budget ------------------------------------
  /** Run fn() in a frame within the shared budget; resolves with its result. */
  work(layer, fn, priority = 0) {
    return new Promise((resolve, reject) => {
      this.jobs.push({ layer, fn, priority, resolve, reject });
      this.schedule();
    });
  }
  schedule() {
    if (!this.frame) this.frame = this.nextFrame(() => afterFrame(() => this.drain()));
  }
  /** fn(from, to) over rows [0, rows) in slices of `step` rows, each slice one job of the budget. */
  async rows(layer, rows, step, fn, priority = 0) {
    for (let from = 0; from < rows; from += step) await this.work(layer, () => fn(from, Math.min(rows, from + step)), priority);
  }
  /** The jobs that fit in what is left of this frame's budget, highest priority first (a stable order otherwise). */
  drain() {
    this.frame = 0;
    const budget = this.budget.open(),
      jobs = this.jobs,
      t0 = metrics.start();
    jobs.sort((a, b) => b.priority - a.priority);
    let done = 0;
    while (done < jobs.length) {
      const job = jobs[done],
        name = "work." + job.layer;
      if (!budget.fits(name)) {
        budget.refuse(name);
        break;
      }
      done++;
      const start = metrics.start(),
        t = budget.now();
      try {
        job.resolve(job.fn());
      } catch (error) {
        job.reject(error);
      }
      budget.charge(name, budget.now() - t);
      metrics.time(job.layer, "work", start);
    }
    jobs.splice(0, done);
    // the main thread's scene work of the frame: the map's render (measureMap) and these jobs
    if (t0) metrics.count("main", "ms", performance.now() - t0);
    metrics.gauge("main", "jobs", jobs.length);
    if (jobs.length) this.schedule();
  }
}

/** The scheduler shared by the scene's layers. The ground and its photo come first: twice the share. */
export const scheduler = new Scheduler();
scheduler.layer("terrain", 2);
scheduler.layer("ortho", 2);
