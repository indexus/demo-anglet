import { resolvedEvents, cameraFlow, overviewBins } from "./sessionAnalysis.js";
const ns = "http://www.w3.org/2000/svg",
  duration = (n) => (n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(2)} s`);
const bytes = (n) =>
  n >= 1048576 ? `${(n / 1048576).toFixed(2)} Mio` : `${Math.round(n / 1024)} Kio`;
const stageLabels = {
    network: "Réseau",
    worker: "Worker",
    gpu: "GPU",
    display: "Affichage / attente",
  },
  stageColors = { network: "#89c6f1", worker: "#dfa46c", gpu: "#c3a8f2", display: "#82bcb1" };
const color = (lane) =>
  lane.includes("réseau")
    ? "#89c6f1"
    : lane.includes("GPU")
      ? "#c3a8f2"
      : lane.includes("caméra")
        ? "#f0d995"
        : lane.includes("affichage")
          ? "#82bcb1"
          : lane.includes("CPU")
            ? "#ee958b"
            : "#dfa46c";
export function timelineBins(events, left, right) {
  if (events.length <= 1000) return events;
  const lanes = [...new Set(events.map((e) => e.lane))],
    bins = new Map(),
    columns = Math.max(8, Math.floor(900 / Math.max(1, lanes.length)));
  for (const e of events) {
    const column = Math.max(
        0,
        Math.min(columns - 1, Math.floor(((e.at - left) / Math.max(1, right - left)) * columns)),
      ),
      key = e.lane + "/" + column + "/" + (e.status === "cancelled" ? "cancelled" : "normal");
    let b = bins.get(key);
    if (!b) {
      bins.set(key, { ...e, grouped: 1 });
      continue;
    }
    const end = Math.max(b.at + (b.ms ?? 0), e.at + (e.ms ?? 0));
    b.at = Math.min(b.at, e.at);
    b.ms = end - b.at;
    b.grouped++;
    b.name = "Événements groupés";
  }
  return [...bins.values()];
}
// Wires the copy and timeline buttons created by loadIndicator.js, on their first click.
export function mountSessionPanel(trace, copy, open) {
  const dialog = document.createElement("dialog");
  dialog.className = "session-trace-dialog";
  dialog.innerHTML =
    '<header><strong>Chronologie de la session</strong><button type="button" aria-label="Fermer la chronologie">×</button></header><p class="session-trace-summary"></p><div class="session-trace-tools"><label>Fenêtre <select aria-label="Durée visible"><option value="15000">15 s</option><option value="60000" selected>60 s</option><option value="0">Session</option></select></label><label><input type="checkbox" checked> Suivre</label><input type="range" aria-label="Position dans la session" min="0" step="100"></div><label class="session-trace-camera-label">Corrélation <select aria-label="Mouvement de caméra"><option value="">Toute la session</option></select></label><div class="session-trace-flow" aria-label="Flux du mouvement sélectionné"></div><div class="session-trace-overview"></div><div class="session-trace-chart"></div><p>Temps écoulé depuis l’ouverture. Les pistes parallèles se recouvrent : elles ne s’additionnent pas. Cliquer un événement pour ses détails. Les vues denses regroupent les marques proches ; réduire la fenêtre pour les séparer.</p><pre class="session-trace-detail">Caméra → requête → préparation → GPU → affichage. Les annulations demandées et confirmées sont distinctes.</pre><textarea aria-label="Traces à copier manuellement" hidden readonly></textarea>';
  document.body.append(dialog);
  const summary = dialog.querySelector(".session-trace-summary"),
    chart = dialog.querySelector(".session-trace-chart"),
    detail = dialog.querySelector("pre"),
    select = dialog.querySelector('[aria-label="Durée visible"]'),
    cameraSelect = dialog.querySelector('[aria-label="Mouvement de caméra"]'),
    overview = dialog.querySelector(".session-trace-overview"),
    flow = dialog.querySelector(".session-trace-flow"),
    follow = dialog.querySelector("[type=checkbox]"),
    slider = dialog.querySelector("[type=range]");
  let timer = 0,
    copyTimer = 0,
    history = null,
    selectedCamera = null;
  const draw = () => {
    clearTimeout(timer);
    timer = 0;
    if (!dialog.open) return;
    if (history)
      history = [...new Map([...history, ...trace.events].map((e) => [e.seq, e])).values()];
    const end = trace.now() - trace.started;
    slider.max = String(end);
    if (follow.checked) slider.value = String(end);
    const right = Number(slider.value),
      span = Number(select.value) || Math.max(1000, right),
      left = Math.max(0, right - span),
      all = resolvedEvents(
        history ?? trace.events,
        [...trace.tasks.values()].map((e) => ({ ...e, ms: end - e.at })),
      ),
      events = all.filter((e) => e.at <= right && e.at + (e.ms ?? 0) >= left);
    drawFlow(all, right);
    drawOverview(
      all.filter((e) => e.at <= right),
      left,
      right,
    );
    summary.textContent = `${duration(end)} · ${trace.sequence} événements · ${trace.tasks.size} tâches actives · ${trace.camera} mouvements${trace.storageError ? " · stockage incomplet : " + trace.storageError : ""}`;
    const order = [
        "caméra",
        "3D · requêtes",
        "réseau 3D",
        "3D · worker",
        "3D · attente",
        "3D · GPU",
        "3D · affichage",
        "3D · étapes",
        "pré-calcul",
        "météo 3D",
        "météo",
        "réseau météo",
        "DVF",
        "réseau DVF",
        "CPU principal",
        "affichage",
        "réseau principal",
        "session",
      ],
      rank = (lane) => {
        const i = order.indexOf(lane);
        return i < 0 ? order.length : i;
      },
      lanes = [...new Set(events.map((e) => e.lane))].sort((a, b) => rank(a) - rank(b)),
      width = 900,
      labelWidth = 140,
      height = Math.max(90, lanes.length * 32 + 30),
      svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Pistes corrélées caméra, réseau, calcul et affichage");
    const x = (at) =>
        labelWidth + ((at - left) / Math.max(1, right - left)) * (width - labelWidth - 10),
      node = (name, attrs, text) => {
        const el = document.createElementNS(ns, name);
        for (const [key, v] of Object.entries(attrs)) el.setAttribute(key, v);
        if (text) el.textContent = text;
        svg.append(el);
        return el;
      };
    for (let i = 0; i <= 5; i++) {
      const at = left + ((right - left) * i) / 5;
      node("line", { x1: x(at), x2: x(at), y1: 20, y2: height, stroke: "#ffffff12" });
      node(
        "text",
        {
          x: x(at),
          y: 12,
          fill: "#a6b6bd",
          "font-size": 10,
          "text-anchor": i === 5 ? "end" : "start",
        },
        (at / 1000).toFixed(1) + " s",
      );
    }
    for (const [i, lane] of lanes.entries()) {
      const y = 24 + i * 32;
      node("text", { x: 0, y: y + 13, fill: color(lane), "font-size": 11 }, lane);
      node("line", { x1: labelWidth, x2: width, y1: y + 23, y2: y + 23, stroke: "#ffffff0b" });
    }
    for (const e of timelineBins(events, left, right)) {
      const y = 24 + lanes.indexOf(e.lane) * 32,
        rect = node("rect", {
          x: x(Math.max(left, e.at)),
          y: y + 2,
          width: Math.max(2, x(Math.min(right, e.at + (e.ms ?? 0))) - x(Math.max(left, e.at))),
          height: e.ms !== undefined ? 17 : 23,
          fill: color(e.lane),
          opacity:
            selectedCamera !== null && e.camera !== selectedCamera
              ? ".16"
              : e.status === "running"
                ? ".35"
                : ".8",
          stroke: e.status === "cancelled" || e.name.includes("cancel") ? "#f28c86" : "none",
          "stroke-width": 2,
          tabindex: 0,
        });
      const title = document.createElementNS(ns, "title");
      title.textContent = `${e.name}${e.grouped > 1 ? " ×" + e.grouped : ""} · ${duration(e.ms ?? 0)} · caméra ${e.camera} · ${e.status ?? ""}`;
      rect.append(title);
      rect.onclick = rect.onfocus = () => {
        selectedCamera = e.camera ?? null;
        cameraSelect.value = selectedCamera ?? "";
        detail.textContent = JSON.stringify(e, null, 2);
        draw();
      };
    }
    chart.replaceChildren(svg);
    timer = setTimeout(draw, 500);
  };
  const drawFlow = (events, right) => {
    const cameras = [
        ...new Map(
          events
            .filter((e) => e.lane === "caméra" && e.name === "Mouvement")
            .map((e) => [e.camera, e]),
        ).values(),
      ].slice(-100),
      signature = cameras.map((e) => e.camera).join(",");
    if (cameraSelect.dataset.cameras !== signature) {
      cameraSelect.dataset.cameras = signature;
      cameraSelect.replaceChildren(
        new Option("Toute la session", ""),
        ...cameras.map(
          (e) =>
            new Option(
              `#${e.camera} · ${(e.at / 1000).toFixed(1)} s · zoom ${Number(e.zoom ?? 0).toFixed(1)}`,
              String(e.camera),
            ),
        ),
      );
      cameraSelect.value = selectedCamera ?? "";
    }
    const model = cameraFlow(events, selectedCamera, right);
    flow.replaceChildren();
    for (const [stage, ms] of Object.entries(model.stages)) {
      const item = document.createElement("span");
      item.style.borderColor = stageColors[stage];
      item.textContent = `${stageLabels[stage]} ${duration(ms)}`;
      item.title =
        "Durée occupée sur la piste, intervalles imbriqués réunis. Inclut les attentes, pas du CPU/GPU pur.";
      flow.append(item);
    }
    const info = document.createElement("small"),
      last = model.last;
    info.textContent = `${model.requests} lectures · ${bytes(model.wireBytes)} reçus (3D : ${model.requests3d} / ${bytes(model.wireBytes3d)}) · ${model.cancelled} opérations annulées · ${model.adoptions} adoptions${model.catchupMs !== null ? " · rattrapage " + duration(model.catchupMs) : ""}${last?.roofPatches !== undefined ? " · " + last.roofPatches + " plans / " + last.canopyCells + " cellules" : ""}${model.budget ? " · " + model.budget.visible + " tuiles visibles / " + model.budget.requestedTiles + " demandées" : ""}`;
    info.title =
      "Le rattrapage va de la fin du mouvement à la dernière adoption liée à ce mouvement. Une requête tardive conserve la caméra qui l’a initiée.";
    flow.append(info);
  };
  const drawOverview = (events, left, right) => {
    const bins = overviewBins(events, left, right),
      width = 900,
      label = 140,
      plot = 750,
      svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 900 220");
    svg.setAttribute("role", "img");
    svg.setAttribute(
      "aria-label",
      "Graphes temporels du zoom, des transferts réseau et de la concurrence",
    );
    const node = (name, attrs, text) => {
        const el = document.createElementNS(ns, name);
        for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
        if (text) el.textContent = text;
        svg.append(el);
        return el;
      },
      x = (i) => label + (i / bins.length) * plot,
      zooms = bins.filter((b) => Number.isFinite(b.zoom)).map((b) => b.zoom),
      min = Math.min(...zooms),
      max = Math.max(min + 0.5, ...zooms),
      wire = Math.max(1, ...bins.map((b) => b.wireBytes)),
      concurrency = Math.max(1, ...bins.flatMap((b) => [b.network, b.worker, b.gpu]));
    for (const [y, text] of [
      [14, `Zoom ${Number.isFinite(min) ? min.toFixed(1) + "–" + max.toFixed(1) : "—"}`],
      [66, `Reçu / intervalle`],
      [119, `Travaux parallèles`],
      [185, `Plans / végétation`],
    ])
      node("text", { x: 0, y, fill: "#a6b6bd", "font-size": 11 }, text);
    const points = bins.flatMap((b, i) =>
      Number.isFinite(b.zoom) ? [`${x(i)},${45 - ((b.zoom - min) / (max - min)) * 32}`] : [],
    );
    node("polyline", {
      points: points.join(" "),
      fill: "none",
      stroke: "#f0d995",
      "stroke-width": 2,
    });
    for (const [i, b] of bins.entries())
      if (b.wireBytes) {
        const rect = node("rect", {
            x: x(i),
            y: 99 - (b.wireBytes / wire) * 32,
            width: Math.max(1, plot / bins.length - 1),
            height: (b.wireBytes / wire) * 32,
            fill: stageColors.network,
          }),
          title = document.createElementNS(ns, "title");
        title.textContent = `${(b.at / 1000).toFixed(1)} s · ${bytes(b.wireBytes)} reçus`;
        rect.append(title);
      }
    for (const stage of ["network", "worker", "gpu"])
      node("polyline", {
        points: bins.map((b, i) => `${x(i)},${152 - (b[stage] / concurrency) * 32}`).join(" "),
        fill: "none",
        stroke: stageColors[stage],
        "stroke-width": 1.5,
      });
    for (const [key, stroke] of [
      ["roofPatches", "#d9b69a"],
      ["canopyCells", "#9acb9a"],
    ]) {
      const maximum = Math.max(1, ...bins.map((b) => b[key] ?? 0));
      node("polyline", {
        points: bins
          .flatMap((b, i) =>
            Number.isFinite(b[key]) ? [`${x(i)},${208 - (b[key] / maximum) * 28}`] : [],
          )
          .join(" "),
        fill: "none",
        stroke,
        "stroke-width": 1.5,
      });
    }
    node(
      "text",
      { x: label, y: 218, fill: "#91a5aa", "font-size": 10 },
      "Quantités adoptées, chacune normalisée · aucune lecture GPU",
    );
    node(
      "text",
      { x: label, y: 166, fill: "#91a5aa", "font-size": 10 },
      `Réseau / worker / GPU · pic ${concurrency.toFixed(1)} tâches moyennes par intervalle · ${(Math.max(1, right - left) / bins.length / 1000).toFixed(2)} s / intervalle`,
    );
    overview.replaceChildren(svg);
  };
  const update = () => {
    if (dialog.open && !timer) timer = setTimeout(draw, 250);
  };
  trace.listeners.add(update);
  open.onclick = async () => {
    dialog.showModal();
    history = null;
    draw();
    try {
      const snapshot = await trace.snapshot();
      history = snapshot.events;
      draw();
    } catch (error) {
      detail.textContent = String(error);
    }
  };
  dialog.querySelector("header button").onclick = () => dialog.close();
  dialog.addEventListener("close", () => {
    history = null;
    clearTimeout(timer);
    timer = 0;
  });
  cameraSelect.onchange = () => {
    selectedCamera = cameraSelect.value === "" ? null : Number(cameraSelect.value);
    draw();
  };
  select.onchange = draw;
  slider.oninput = () => {
    follow.checked = false;
    draw();
  };
  follow.onchange = () => {
    history = null;
    draw();
  };
  copy.onclick = async () => {
    copy.disabled = true;
    const textarea = dialog.querySelector("textarea");
    try {
      const snapshot = await trace.snapshot();
      textarea.value = JSON.stringify(snapshot);
      await navigator.clipboard.writeText(textarea.value);
      copy.textContent = "✓";
      copy.title = `${snapshot.events.length} événements copiés depuis le début${snapshot.storage.complete ? "" : " · journal incomplet"}`;
    } catch (error) {
      if (!dialog.open) dialog.showModal();
      textarea.hidden = false;
      if (!textarea.value) textarea.value = String(error);
      textarea.select();
      copy.textContent = "!";
    } finally {
      copy.disabled = false;
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => {
        copy.textContent = "⧉";
        if (textarea.hidden) textarea.value = "";
      }, 10000);
    }
  };
  return {
    destroy() {
      trace.listeners.delete(update);
      clearTimeout(timer);
      clearTimeout(copyTimer);
      dialog.remove();
    },
  };
}
