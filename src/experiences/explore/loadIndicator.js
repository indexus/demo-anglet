import { createPerformanceDock } from "./diagnostics/performanceDock.js";
import { onSessionTrace } from "./diagnostics/trace.js";
const names = {
  network: "réseau",
  prepare: "préparation",
  compute: "calcul",
  gpu: "GPU",
  transition: "transition",
};
export function loadBreakdown(totals) {
  const total = Object.values(totals).reduce((sum, n) => sum + Math.max(0, n), 0);
  return {
    total,
    segments: Object.keys(names)
      .filter((key) => totals[key] > 0)
      .map((phase) => ({ phase, ms: totals[phase], share: totals[phase] / total })),
  };
}
const formatDuration = (ms) =>
  ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1).replace(".", ",")} s`;
function mergeTask(target, source) {
  target.ms = (target.ms ?? 0) + (source.ms ?? 0);
  target.count = (target.count ?? 0) + (source.count ?? 1);
  target.parallel = true;
  if (source.hits) target.hits = (target.hits ?? 0) + source.hits;
  for (const child of source.children ?? []) {
    target.children ??= [];
    let prior = target.children.find(
      (n) =>
        n.label === child.label &&
        !!n.cached === !!child.cached &&
        !!n.cancelled === !!child.cancelled,
    );
    if (!prior) {
      prior = {
        label: child.label,
        ms: 0,
        count: 0,
        cached: child.cached,
        cancelled: child.cancelled,
        children: [],
      };
      target.children.push(prior);
    }
    mergeTask(prior, child);
  }
}
export class LoadActivity {
  constructor(now = () => performance.now()) {
    this.now = now;
    this.network = new Map();
    this.backgroundTasks = new Map();
    this.active = false;
    this.busy = false;
    this.phase = "read";
    this.totals = {};
    this.lastPass = null;
    this.cycle = 0;
    this.details = [];
    this.older = null;
    this.requests = new Map();
    this.at = now();
    this.since = this.at;
  }
  code() {
    return this.phase === "read" ? (this.pending() > 0 ? "network" : "prepare") : this.phase;
  }
  pending() {
    return [...this.network.values()].reduce((n, v) => n + v, 0);
  }
  accrue() {
    const time = this.now();
    if (this.busy) {
      const code = this.code();
      this.totals[code] = (this.totals[code] ?? 0) + time - this.at;
    }
    this.at = time;
  }
  begin(phase = "read", detail = "") {
    if (!this.busy) {
      this.cycle++;
      this.details = [];
      this.older = null;
      this.totals = {};
      this.at = this.now();
      this.since = this.at;
    }
    this.error = null;
    this.active = true;
    this.busy = true;
    this.setPhase(phase, detail);
  }
  setPhase(phase, detail = "") {
    if (this.phase === phase && this.detail === detail) return;
    this.accrue();
    this.phase = phase;
    this.detail = detail;
    this.since = this.now();
  }
  setNetwork(owner, pending) {
    const before = this.code();
    this.accrue();
    this.network.set(owner, Math.max(0, pending));
    if (this.code() !== before) this.since = this.now();
  }
  background(phase = null, owner = "worker") {
    if (phase) this.backgroundTasks.set(owner, phase);
    else this.backgroundTasks.delete(owner);
  }
  get backgroundPhase() {
    return this.backgroundTasks.get("gpu") ?? this.backgroundTasks.get("worker");
  }
  track(id) {
    this.requests.set(id, this.cycle);
    while (this.requests.size > 64) this.requests.delete(this.requests.keys().next().value);
  }
  recordRequest(id, tree) {
    const cycle = this.requests.get(id);
    this.requests.delete(id);
    if (cycle === this.cycle) this.record(tree);
  }
  record(tree) {
    if (!this.active) return;
    this.details.push(tree);
    if (this.details.length > 24) {
      const old = this.details.shift();
      this.older ??= {
        label: "Opérations antérieures regroupées",
        ms: 0,
        count: 0,
        parallel: true,
        children: [],
      };
      mergeTask(this.older, { ms: old.ms, count: 1, children: [old] });
    }
    if (!this.busy && this.lastPass?.cycle === this.cycle)
      this.lastPass = {
        ...this.lastPass,
        details: [...(this.older ? [this.older] : []), ...this.details],
      };
  }
  complete() {
    if (!this.busy) return;
    this.accrue();
    if (Object.values(this.totals).some((n) => n > 0))
      this.lastPass = {
        ...loadBreakdown({ ...this.totals }),
        cycle: this.cycle,
        details: [...(this.older ? [this.older] : []), ...this.details],
      };
    this.busy = false;
    this.since = this.now();
  }
  fail(message) {
    this.accrue();
    this.busy = false;
    this.active = true;
    this.error = message;
    this.backgroundTasks.clear();
  }
  hide() {
    this.error = null;
    this.accrue();
    this.active = false;
    this.busy = false;
    this.backgroundTasks.clear();
  }
  snapshot() {
    if (this.error)
      return { phase: "error", text: "Chargement interrompu", elapsed: "", title: this.error };
    const totals = { ...this.totals },
      code = this.code();
    if (this.busy) totals[code] = (totals[code] ?? 0) + this.now() - this.at;
    const title = Object.entries(totals)
      .filter(([, ms]) => ms > 0)
      .map(([key, ms]) => `${names[key] ?? key} : ${formatDuration(ms)}`)
      .join(" · ");
    if (!this.busy) {
      if (this.backgroundPhase)
        return {
          phase: "background",
          text: `À jour · ${{ read: "prélecture", compute: "pré-calcul", gpu: "préparation GPU" }[this.backgroundPhase] ?? "anticipation"}`,
          elapsed: "",
          title,
        };
      const largest = Object.entries(totals).sort((a, b) => b[1] - a[1])[0];
      return {
        phase: "ready",
        text:
          largest && largest[1] >= 100
            ? `À jour · ${names[largest[0]] ?? largest[0]} ${formatDuration(largest[1])}`
            : "À jour",
        elapsed: "",
        title,
      };
    }
    const labels = {
      network: "Réseau · lecture Indexus",
      prepare: this.detail || "Préparation des données",
      compute: this.detail || "Calcul des volumes",
      gpu: "GPU · préparation de l’affichage",
      transition: "Transition · rattrapage",
    };
    return {
      phase: code,
      text: labels[code] ?? "Préparation",
      elapsed: this.now() - this.since >= 300 ? formatDuration(this.now() - this.since) : "",
      title,
    };
  }
}
// The two session buttons are part of the indicator; the timeline and copy code behind them
// is fetched on the first click so it stays out of the main bundle.
export function createSessionButtons(parent, trace) {
  if (!trace) return { destroy() {} };
  const button = (name, icon) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "session-trace-button";
    b.setAttribute("aria-label", name);
    b.title = name;
    b.textContent = icon;
    parent.querySelector(".scene-load-line").append(b);
    return b;
  };
  const copy = button("Copier les traces de la session", "⧉"),
    open = button("Chronologie de la session", "≋");
  let panel,
    destroyed = false;
  const mountThen = (target) => async () => {
    panel ??= import("./diagnostics/sessionPanel.js").then((diagnostics) =>
      diagnostics.mountSessionPanel(trace, copy, open),
    );
    await panel;
    // Mounting replaced both onclick handlers: replay this click on the real one.
    if (!destroyed) target.onclick();
  };
  copy.onclick = mountThen(copy);
  open.onclick = mountThen(open);
  return {
    destroy() {
      destroyed = true;
      panel?.then((mounted) => mounted.destroy());
      copy.remove();
      open.remove();
    },
  };
}
export function createLoadIndicator(parent = document.body) {
  let trace = null,
    tracedPhase = "",
    tracedCycle = 0;
  const model = new LoadActivity(),
    element = document.createElement("div");
  element.className = "scene-load-indicator";
  element.hidden = true;
  element.innerHTML =
    '<div class="scene-load-line"><i aria-hidden="true"></i><span role="status" aria-live="polite" aria-atomic="true"></span><small aria-hidden="true"></small></div>';
  const dock = createPerformanceDock(parent, () => render());
  dock.element.append(element);
  let sessionPanel = createSessionButtons(element, null);
  const label = element.querySelector("span"),
    elapsed = element.querySelector("small");
  let timer = 0,
    queued = 0,
    destroyed = false;
  const render = () => {
    if (destroyed) return;
    queued = 0;
    dock.update(
      model.active ? model.snapshot().phase : "ready",
      model.pending(),
      model.backgroundPhase,
    );
    if (dock.opened && !timer) timer = setInterval(render, 250);
    else if (!dock.opened) {
      clearInterval(timer);
      timer = 0;
    }
    element.hidden = !model.active && !trace;
    if (!dock.opened) return;
    if (!model.active) {
      if (trace) {
        label.textContent = "Session";
        elapsed.textContent = "";
        element.dataset.phase = "ready";
      }
      return;
    }
    const state = model.snapshot(),
      text = "3D · " + state.text;
    element.dataset.phase = state.phase;
    if (label.textContent !== text) label.textContent = text;
    elapsed.textContent = state.elapsed;
    element.title = "";
    label.setAttribute("aria-description", state.title);
  };
  const update = () => {
    if (trace) {
      const phase = model.busy ? model.code() + "/" + (model.detail ?? "") : "";
      if (model.cycle !== tracedCycle) {
        trace.end("3d-cycle", "superseded");
        tracedCycle = model.cycle;
        trace.start("3D · affichage", "3d-cycle", "Cycle " + tracedCycle);
      }
      if (phase !== tracedPhase) {
        trace.end("3d-phase");
        tracedPhase = phase;
        if (phase) trace.start("3D · étapes", "3d-phase", phase, { cycle: tracedCycle });
      }
      if (!model.busy) trace.end("3d-cycle", model.error ? "error" : "complete");
    }
    if (!destroyed && !queued) queued = setTimeout(render, 60);
  };
  onSessionTrace((value) => {
    if (destroyed) return;
    trace = value;
    sessionPanel = createSessionButtons(element, value);
    update();
  });
  return {
    /** The info panel (the "i" button): the "h" key and ?hud open it too (hud.js installHud). */
    info: { show: () => dock.show(), toggle: () => dock.toggle() },
    /** The viewer's settings of the info panel (viewerSettings.js). */
    settings: dock.settings,
    configure(options) {
      dock.configure(options);
      update();
    },
    track(...args) {
      model.track(...args);
    },
    recordRequest(...args) {
      model.recordRequest(...args);
      update();
    },
    record(...args) {
      model.record(...args);
      update();
    },
    begin(...args) {
      model.begin(...args);
      update();
    },
    phase(...args) {
      model.setPhase(...args);
      update();
    },
    network(...args) {
      model.setNetwork(...args);
      update();
    },
    background(phase = null, owner = "worker") {
      const id = "anticipation/" + owner,
        prior = trace?.tasks.get(id);
      if (prior?.phase !== phase) {
        trace?.end(id, "stopped");
        if (phase)
          trace?.start(phase === "gpu" ? "3D · GPU" : "pré-calcul", id, "Anticipation · " + phase, {
            phase,
            owner,
          });
      }
      model.background(phase, owner);
      update();
    },
    complete() {
      model.complete();
      update();
    },
    hide() {
      trace?.end("anticipation/worker", "stopped");
      trace?.end("anticipation/gpu", "stopped");
      model.hide();
      update();
    },
    fail(message) {
      trace?.end("anticipation/worker", "stopped");
      trace?.end("anticipation/gpu", "stopped");
      model.fail(message);
      update();
    },
    destroy() {
      destroyed = true;
      clearInterval(timer);
      clearTimeout(queued);
      sessionPanel.destroy();
      dock.destroy();
    },
  };
}
