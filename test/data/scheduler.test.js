import test from "node:test";
import assert from "node:assert/strict";
import { Scheduler, isCancelled } from "../../src/data/scheduler.js";
import { FrameBudget } from "../../src/data/frameBudget.js";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
/** A read that resolves when told: { run, release(value), started } */
function gate() {
  const reads = [];
  return {
    reads,
    run: (name) => (signal) =>
      new Promise((resolve, reject) => {
        reads.push({ name, resolve, signal });
        signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      }),
  };
}

test("never more reads in flight than the cap, whatever is asked", async () => {
  const s = new Scheduler({ concurrency: 4, bytesPerSecond: 1e12 }),
    g = gate(),
    all = [];
  for (let i = 0; i < 300; i++) all.push(s.request("buildings", "z" + i, g.run(i), { priority: i }).catch(() => {}));
  await tick();
  assert.equal(g.reads.length, 4);
  assert.equal(s.inflight, 4);
  // the highest priorities went first
  assert.deepEqual(g.reads.map((r) => r.name).sort((a, b) => b - a), [299, 298, 297, 296]);
  g.reads.splice(0).forEach((r) => r.resolve());
  await tick();
  assert.equal(s.inflight, 4);
});

test("layers share the cap fairly", async () => {
  const s = new Scheduler({ concurrency: 4, bytesPerSecond: 1e12 }),
    g = gate();
  for (let i = 0; i < 20; i++) s.request("buildings", "b" + i, g.run("b"), { priority: 100 }).catch(() => {});
  for (let i = 0; i < 20; i++) s.request("vegetation", "v" + i, g.run("v"), { priority: 1 }).catch(() => {});
  await tick();
  assert.deepEqual(g.reads.map((r) => r.name).sort(), ["b", "b", "v", "v"]);
});

test("what a walk does not ask for again is dropped from the queue", async () => {
  const s = new Scheduler({ concurrency: 1, bytesPerSecond: 1e12 }),
    g = gate(),
    first = s.request("buildings", "a", g.run("a")),
    stale = s.request("buildings", "b", g.run("b"));
  await tick(); // "a" is on the wire, "b" waits
  s.pass("buildings");
  s.request("buildings", "c", g.run("c"));
  s.pass("buildings");
  await assert.rejects(stale, (e) => isCancelled(e));
  g.reads[0].resolve("A");
  assert.equal(await first, "A");
});

test("a read held by signals stops when every holder has aborted", async () => {
  const s = new Scheduler({ concurrency: 1, bytesPerSecond: 1e12 }),
    g = gate(),
    one = new AbortController(),
    two = new AbortController();
  s.request("ortho", "busy", g.run("busy"));
  const p = s.request("ortho", "t", g.run("t"), { signal: one.signal });
  s.request("ortho", "t", null, { signal: two.signal });
  one.abort();
  await tick();
  assert.equal(s.layers.get("ortho").queue.size, 1, "still held by the second tile");
  two.abort();
  await assert.rejects(p, (e) => isCancelled(e));
});

test("a failed read is asked again with a growing pause, then given up", async () => {
  const s = new Scheduler({ concurrency: 2, bytesPerSecond: 1e12 });
  let calls = 0;
  const p = s.request(
    "terrain",
    "x",
    async () => {
      calls++;
      if (calls < 3) throw Error("No peer for content record read");
      return 42;
    },
    { retries: 4 },
  );
  assert.equal(await p, 42);
  assert.equal(calls, 3);
  let fails = 0;
  await assert.rejects(
    s.request("terrain", "y", async () => {
      fails++;
      throw Error("down");
    }, { retries: 1 }),
  );
  assert.equal(fails, 2);
});

test("main-thread work runs in frames within its budget", async () => {
  // a fake clock: each job takes 3 ms; frames are the scheduler's own (nextFrame)
  let t = 0,
    frame = 0;
  const budget = new FrameBudget({ ms: 4, now: () => t, frame: () => frame }),
    s = new Scheduler({ budget }),
    frames = [];
  s.nextFrame = (fn) => setTimeout(() => (frame++, fn()), 0);
  const all = [];
  for (let i = 0; i < 6; i++)
    all.push(
      s.work("buildings", () => {
        t += 3;
        (frames[frame] ??= []).push(i);
      }),
    );
  await Promise.all(all);
  // one job of 3 ms per frame in a budget of 4: never two in a frame, none lost
  assert.deepEqual(frames.filter(Boolean), [[0], [1], [2], [3], [4], [5]]);
  assert.ok(budget.spent <= 4);
});

test("one budget per frame, handed out in the frame's order, and never exceeded", () => {
  // ground (forced, 0.5 ms), buildings walk (0.3 ms steps), vegetation walk
  // (0.2 ms), uploads (1 ms), scheduler jobs (1.5 ms): what is left over carries to the next frames
  let t = 0,
    frame = 0;
  const budget = new FrameBudget({ ms: 4, now: () => t, frame: () => frame }),
    left = { buildings: 30, vegetation: 40, uploads: 5, jobs: 6 },
    cost = { buildings: 0.3, vegetation: 0.2, uploads: 1, jobs: 1.5 },
    order = [],
    spent = [];
  // the step times as earlier frames measured them (a consumer's very first step is a guess)
  for (const [name, ms] of Object.entries(cost)) budget.cost.set(name, ms);
  const step = (name) => () => {
    t += cost[name];
    order.push(name);
    return --left[name] <= 0;
  };
  for (; frame < 40 && Object.values(left).some((n) => n > 0); frame++) {
    budget.run("ground", () => ((t += 0.5), order.push("ground"), true), { forced: true });
    for (const name of ["buildings", "vegetation", "uploads", "jobs"]) if (left[name] > 0) budget.run(name, step(name));
    spent.push(budget.spent);
  }
  assert.deepEqual(left, { buildings: 0, vegetation: 0, uploads: 0, jobs: 0 });
  for (const ms of spent) assert.ok(ms <= 4 + 1e-9, `a frame spent ${ms} ms`);
  // the first frame: the ground, then the buildings' walk takes what is left
  assert.equal(order[0], "ground");
  assert.equal(order[1], "buildings");
  // every consumer got its turn within a few frames of being turned away
  assert.ok(spent.length <= 14, `${spent.length} frames`);
});

test("a consumer turned away is owed the next frame", () => {
  let t = 0,
    frame = 0;
  const budget = new FrameBudget({ ms: 4, now: () => t, frame: () => frame }),
    ran = [];
  // a walk that would take every frame, and a job of 3 ms behind it
  const walk = () => ((t += 0.25), ran.push([frame, "walk"]), false),
    job = () => ((t += 3), ran.push([frame, "job"]), true);
  budget.cost.set("job", 3);
  for (; frame < 4; frame++) {
    budget.run("walk", walk);
    budget.run("job", job);
    assert.ok(budget.spent <= 4, `frame ${frame} spent ${budget.spent}`);
  }
  // frame 0: the walk fills it; frame 1: 3 ms kept aside for the job, which runs; and again
  assert.deepEqual(
    ran.filter(([, what]) => what === "job").map(([f]) => f),
    [1, 3],
  );
  assert.equal(ran.filter(([f, what]) => f === 1 && what === "walk").length, 4);
});

test("bytes per second stay near the target", async () => {
  const s = new Scheduler({ concurrency: 8, bytesPerSecond: 100000 }),
    started = [];
  for (let i = 0; i < 40; i++)
    s.request(
      "ortho",
      "t" + i,
      async () => {
        started.push(performance.now());
        return 20000;
      },
      { size: (n) => n },
    );
  await tick(400);
  // 0.5 s of burst (50 kB) then 100 kB/s: about 6 reads of 20 kB in 0.4 s, not 40
  assert.ok(started.length < 15, `${started.length} reads started`);
});

test("reads per second stay under the cap", async () => {
  const s = new Scheduler({ concurrency: 8, bytesPerSecond: 1e12, requestsPerSecond: 20 }),
    started = [];
  for (let i = 0; i < 60; i++) s.request("terrain", "t" + i, async () => started.push(performance.now())).catch(() => {});
  await tick(500);
  // a burst of 10, then 20 a second: about 20 in 0.5 s, not 60
  assert.ok(started.length >= 12 && started.length <= 24, `${started.length} reads started`);
});
