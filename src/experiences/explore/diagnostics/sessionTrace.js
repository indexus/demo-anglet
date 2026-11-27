import { TraceReferences } from "./traceReferences.js";
// Compact session events are journalled to disk; only the recent window stays
// in RAM. Geometry, buffers, credentials and source payloads never enter it.
export function openTraceStore(indexedDB) {
  if (!indexedDB) return null;
  const ready = new Promise((resolve, reject) => {
    const r = indexedDB.open("indexus-session-traces", 1);
    r.onupgradeneeded = () =>
      r.result.createObjectStore("chunks", { keyPath: ["session", "part"] });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return {
    async append(session, part, events) {
      const db = await ready;
      return new Promise((resolve, reject) => {
        const t = db.transaction("chunks", "readwrite");
        t.objectStore("chunks").put({ session, part, events, created: Date.now() });
        t.oncomplete = resolve;
        t.onerror = () => reject(t.error);
      });
    },
    async read(session) {
      const db = await ready;
      return new Promise((resolve, reject) => {
        const r = db
          .transaction("chunks")
          .objectStore("chunks")
          .getAll(IDBKeyRange.bound([session, 0], [session, Number.MAX_SAFE_INTEGER]));
        r.onsuccess = () => resolve(r.result.flatMap((c) => c.events));
        r.onerror = () => reject(r.error);
      });
    },
    async prune() {
      const db = await ready;
      return new Promise((resolve, reject) => {
        const t = db.transaction("chunks", "readwrite"),
          r = t.objectStore("chunks").openCursor();
        r.onsuccess = () => {
          const c = r.result;
          if (!c) return;
          if (c.value.created < Date.now() - 86400000) c.delete();
          c.continue();
        };
        t.oncomplete = resolve;
        t.onerror = () => reject(t.error);
      });
    },
  };
}
export class SessionTrace {
  constructor({
    now = () => performance.now(),
    origin = performance.timeOrigin,
    store = null,
    recentLimit = 1500,
    id = crypto.randomUUID(),
    context = {},
  } = {}) {
    this.references = new TraceReferences();
    this.context = context;
    this.now = now;
    this.origin = origin;
    this.started = now();
    this.id = id;
    this.store = store;
    this.recentLimit = recentLimit;
    this.events = [];
    this.pending = [];
    this.tasks = new Map();
    this.sequence = 0;
    this.part = 0;
    this.camera = 0;
    this.cameraTimes = [{ at: 0, id: 0 }];
    this.lost = 0;
    this.listeners = new Set();
    this.writing = Promise.resolve();
    this.storageError = null;
    this.store?.prune?.().catch(() => {});
  }
  event(lane, name, detail = {}, options = {}) {
    if (typeof detail.key === "string")
      detail = { ...detail, key: this.references.get(detail.key) };
    const row = {
      seq: ++this.sequence,
      at: options.at ?? this.now() - this.started,
      lane,
      name,
      camera: options.camera ?? this.camera,
      ...(options.ms !== undefined ? { ms: Math.max(0, options.ms) } : {}),
      ...detail,
    };
    if (lane === "caméra" && name === "Mouvement" && detail.status === "running")
      this.cameraTimes.push({ at: row.at, id: this.camera });
    this.events.push(row);
    this.pending.push(row);
    if (this.store && !this.storageError && this.events.length > this.recentLimit)
      this.events.splice(0, this.events.length - this.recentLimit);
    else if ((!this.store || this.storageError) && this.events.length > 20000) {
      this.events.shift();
      this.lost++;
    }
    for (const listener of this.listeners) listener();
    return row;
  }
  start(lane, id, name, detail = {}) {
    if (this.tasks.has(id)) return;
    const row = this.event(lane, name, { id, status: "running", ...detail });
    this.tasks.set(id, row);
  }
  end(id, status = "complete", detail = {}) {
    const start = this.tasks.get(id);
    if (!start) return;
    this.tasks.delete(id);
    this.event(
      start.lane,
      start.name,
      { id, status, ...detail },
      { at: start.at, ms: this.now() - this.started - start.at, camera: start.camera },
    );
  }
  absoluteSpan(lane, name, start, ms, detail = {}) {
    const raw = start - this.origin - this.started;
    if (raw + ms < 0) return;
    const at = Math.max(0, raw);
    ms = Math.max(0, ms + Math.min(0, raw));
    let lo = 0,
      hi = this.cameraTimes.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (this.cameraTimes[mid].at <= at) lo = mid;
      else hi = mid - 1;
    }
    return this.event(lane, name, detail, { at, ms, camera: this.cameraTimes[lo].id });
  }
  network(lane, event, end = performance.timeOrigin + performance.now()) {
    if (event.phase !== "end") return;
    this.absoluteSpan(lane, event.method ?? "SDK", end - (event.ms ?? 0), event.ms ?? 0, {
      status: event.ok === false ? "error" : "complete",
      collection: event.collection,
      locations: event.locations?.length,
      bytes: event.bytes,
      wireBytes: event.wireBytes,
    });
  }
  tree(lane, tree, request) {
    for (const s of tree.timeline ?? [])
      this.absoluteSpan(lane, s.path, s.start, s.ms, { request, status: s.status });
    this.event(lane, "Mesures détaillées", { request, tree: { ...tree, timeline: undefined } });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.event("session", "Fin");
    return this.flush();
  }
  flush() {
    const events = this.pending.splice(0);
    if (!events.length) return this.writing;
    if (!this.store || this.storageError) return Promise.resolve();
    const part = this.part++;
    this.writing = this.writing
      .then(() => this.store.append(this.id, part, events))
      .catch((error) => {
        this.storageError = String(error?.message ?? error);
        this.pending.unshift(...events);
      });
    return this.writing;
  }
  async snapshot() {
    const cutoff = this.sequence,
      end = this.now() - this.started,
      active = [...this.tasks.values()].map((e) => ({ ...e, ms: end - e.at }));
    await this.flush();
    let stored = [];
    try {
      if (this.store) stored = await this.store.read(this.id);
    } catch (error) {
      this.storageError = String(error?.message ?? error);
    }
    const events = [
      ...new Map(
        [...stored, ...this.events, ...this.pending]
          .filter((e) => e.seq <= cutoff)
          .map((e) => [e.seq, e]),
      ).values(),
    ];
    return {
      schema: "indexus-session-trace-v1",
      context: this.context,
      session: this.id,
      startedAt: new Date(this.origin + this.started).toISOString(),
      durationMs: end,
      storage: {
        mode: this.store ? "disk" : "memory",
        error: this.storageError,
        lost: this.lost,
        complete: !this.storageError && !this.lost,
      },
      clock:
        "milliseconds since session start; parallel spans overlap; SDK time includes transport/queue; aggregate trees are inclusive, not positioned spans",
      events: events.sort((a, b) => a.at - b.at || a.seq - b.seq),
      active,
      summary: {
        events: cutoff,
        cameraMovements: this.camera,
        cancelled: events.filter((e) => e.status === "cancelled").length,
      },
    };
  }
}
let current;
// Only reached through trace.js, i.e. when the page was opened with ?trace.
export function getSessionTrace() {
  if (typeof document === "undefined") return null;
  if (!current || current.closed) {
    current = new SessionTrace({
      store: openTraceStore(globalThis.indexedDB),
      context: {
        page: location.pathname,
        parameters: Object.fromEntries(
          ["scene", "view", "resolution"].map((key) => [
            key,
            new URLSearchParams(location.search).get(key),
          ]),
        ),
        modules: [...document.scripts]
          .filter((s) => s.type === "module" && s.src)
          .map((s) => new URL(s.src).pathname),
        browser: navigator.userAgent,
        cores: navigator.hardwareConcurrency,
        devicePixelRatio: devicePixelRatio,
        viewport: [innerWidth, innerHeight],
      },
    });
    current.timer = setInterval(() => current.flush(), 1000);
    current.event("session", "Début");
  }
  return current;
}
// Keep the tail of short gestures: most touch pans last less than one second.
export class MotionCadence {
  constructor(at) {
    this.start = at;
    this.last = at;
    this.intervals = [];
  }
  frame(at) {
    const ms = at - this.last;
    this.last = at;
    if (ms > 0 && this.intervals.length < 480) this.intervals.push(ms);
  }
  flush(at) {
    if (!this.intervals.length) return null;
    const values = this.intervals.sort((a, b) => a - b),
      q = (p) => values[Math.min(values.length - 1, Math.floor((values.length - 1) * p))],
      result = {
        start: this.start,
        ms: at - this.start,
        frames: values.length,
        p50FrameMs: q(0.5),
        p95FrameMs: q(0.95),
        p99FrameMs: q(0.99),
        maxFrameMs: values.at(-1),
        over32ms: values.filter((n) => n > 32).length,
        over50ms: values.filter((n) => n > 50).length,
      };
    this.start = at;
    this.intervals = [];
    return result;
  }
}
export function traceCamera(map, trace) {
  if (!trace) return () => {};
  let last = 0,
    cadence;
  const flushFrames = (now) => {
    const result = cadence?.flush(now);
    if (result) {
      const { start, ms, ...detail } = result;
      trace.absoluteSpan(
        "affichage",
        "Cadence pendant le mouvement",
        performance.timeOrigin + start,
        ms,
        { ...detail, camera: cadence.camera },
      );
    }
  };
  const position = () => {
    const c = map.getCenter();
    return {
      center: [+c.lng.toFixed(6), +c.lat.toFixed(6)],
      zoom: +map.getZoom().toFixed(4),
      bearing: +map.getBearing().toFixed(2),
      pitch: +map.getPitch().toFixed(2),
    };
  };
  const start = (e) => {
    if (cadence) {
      flushFrames(performance.now());
      trace.end("camera/" + trace.camera, "cancelled", { reason: "camera movement replaced" });
    }
    trace.camera++;
    trace.start("caméra", "camera/" + trace.camera, "Mouvement", {
      ...position(),
      input: e?.originalEvent?.type ?? "camera API",
      action: e?.traceAction ?? null,
    });
    cadence = new MotionCadence(performance.now());
    cadence.camera = trace.camera;
  };
  const move = () => {
    const now = performance.now();
    if (now - last < 150) return;
    last = now;
    trace.event("caméra", "Position", position());
  };
  const end = () => {
    flushFrames(performance.now());
    cadence = null;
    trace.end("camera/" + trace.camera, "complete", position());
  };
  const handlers = {
    movestart: start,
    move,
    moveend: end,
    resize: () =>
      trace.event("affichage", "Viewport", {
        size: [map.getContainer().clientWidth, map.getContainer().clientHeight],
        pixelRatio: map.getPixelRatio(),
      }),
  };
  for (const name of [
    "dragstart",
    "dragend",
    "zoomstart",
    "zoomend",
    "rotatestart",
    "rotateend",
    "pitchstart",
    "pitchend",
  ])
    handlers[name] = () => trace.event("caméra", name, position());
  handlers.render = () => {
    if (!map.isMoving() || !cadence) return;
    const now = performance.now();
    cadence.frame(now);
    if (now - cadence.start >= 1000) flushFrames(now);
  };
  for (const [name, handler] of Object.entries(handlers)) map.on(name, handler);
  let observer;
  if (globalThis.PerformanceObserver?.supportedEntryTypes?.includes("longtask")) {
    observer = new PerformanceObserver((list) => {
      for (const e of list.getEntries())
        trace.absoluteSpan(
          "CPU principal",
          "Tâche longue",
          performance.timeOrigin + e.startTime,
          e.duration,
        );
    });
    observer.observe({ type: "longtask", buffered: true });
  }
  return () => {
    for (const [name, handler] of Object.entries(handlers)) map.off(name, handler);
    observer?.disconnect();
    trace.flush();
  };
}
