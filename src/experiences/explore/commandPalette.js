import { cockpitIcon } from "./cockpitIcons.js";
export const normalizeSearch = (value) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
export function searchCommands(commands, query) {
  const tokens = normalizeSearch(query).split(/\s+/).filter(Boolean);
  return commands.filter((command) => {
    const text = normalizeSearch(
      `${command.group} ${command.title ?? ""} ${command.label()} ${command.keywords ?? ""}`,
    );
    return tokens.every((token) => text.includes(token));
  });
}
export function cockpitCommands(commands, query) {
  return searchCommands(commands, query).filter(
    (command) => normalizeSearch(query) || command.visible?.() !== false,
  );
}

export function createCommandPalette({ commands, status, context = () => "" }) {
  const dialog = document.createElement("dialog");
  dialog.id = "explore-menu";
  dialog.className = "explore-palette";
  dialog.setAttribute("aria-label", "Explore");
  dialog.innerHTML = `<header><span class="explore-wordmark">indexus <span>explore</span></span><button type="button" class="palette-close" aria-label="Fermer Explore">Échap</button></header>
 <div class="palette-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg><input type="search" placeholder="Chercher un mode, une couche, un lieu…" aria-label="Rechercher dans Explore" role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="explore-results" autocomplete="off" spellcheck="false"></div>
 <div id="explore-results" class="palette-results" role="listbox" aria-label="Actions Explore"></div>
 <p class="palette-empty" hidden>Aucun résultat. Essayer « pluie », « 3D » ou « Lyon ».</p>
 <footer><span>← ↑ ↓ → naviguer <span class="palette-enter">↵ choisir</span></span><kbd>⌘ K</kbd></footer>`;
  document.body.append(dialog);
  dialog.querySelector("footer").prepend(status);
  status.className = "palette-status";
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "explore-menu-trigger";
  trigger.setAttribute("aria-label", "Ouvrir le menu Explore");
  trigger.setAttribute("aria-haspopup", "dialog");
  trigger.setAttribute("aria-controls", dialog.id);
  trigger.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M5 6h14M5 12h14M5 18h14"/></svg>';
  trigger.onclick = () => open();
  document.body.append(trigger);
  const input = dialog.querySelector("input"),
    results = dialog.querySelector("#explore-results"),
    empty = dialog.querySelector(".palette-empty");
  let matches = [],
    active = 0,
    previousFocus;
  const close = () => dialog.close();
  function highlight() {
    for (const button of results.querySelectorAll("[role=option]"))
      button.setAttribute("aria-selected", String(Number(button.dataset.index) === active));
    const selected = results.querySelector(`[data-index="${active}"]`);
    if (selected) {
      input.setAttribute("aria-activedescendant", selected.id);
      selected.scrollIntoView({ block: "nearest" });
    } else input.removeAttribute("aria-activedescendant");
  }
  function refresh() {
    if (!dialog.open) return;
    const scroll = results.scrollTop;
    matches = cockpitCommands(commands(), input.value);
    active = Math.min(active, Math.max(0, matches.length - 1));
    results.replaceChildren();
    const sections = new Map();
    matches.forEach((command, index) => {
      if (!sections.has(command.group)) {
        const section = document.createElement("section");
        section.className = "cockpit-section";
        section.dataset.group = command.group;
        const heading = document.createElement("h2");
        heading.className = "palette-group";
        heading.textContent = command.group === "Données" ? "Explorer les données" : command.group;
        section.append(heading);
        if (command.group === "Données") {
          const subtitle = document.createElement("p");
          subtitle.className = "cockpit-context";
          subtitle.textContent = context();
          section.append(subtitle);
        }
        const grid = document.createElement("div");
        grid.className = "cockpit-grid";
        grid.setAttribute("role", "group");
        grid.setAttribute("aria-label", command.group);
        section.append(grid);
        results.append(section);
        sections.set(command.group, grid);
      }
      const button = document.createElement("button");
      button.type = "button";
      button.tabIndex = -1;
      button.id = `explore-command-${index}`;
      button.dataset.index = index;
      button.setAttribute("role", "option");
      button.setAttribute("aria-disabled", String(!!command.disabled?.()));
      const checked = command.checked?.();
      if (checked !== undefined) {
        button.dataset.checked = String(checked);
        button.setAttribute("aria-checked", String(checked));
      }
      button.setAttribute("aria-label", command.label());
      const icon = document.createElement("span");
      icon.className = "cockpit-icon";
      icon.innerHTML = cockpitIcon(command);
      const label = document.createElement("span");
      label.className = "cockpit-label";
      label.textContent = command.title ?? command.label();
      const check = document.createElement("span");
      check.className = "palette-check";
      check.textContent = checked ? "✓" : checked === false ? "○" : "↗";
      check.setAttribute("aria-hidden", "true");
      button.append(icon, label, check);
      if (command.description) {
        const description = document.createElement("small");
        description.textContent = command.description;
        button.append(description);
      }
      button.onmousedown = (event) => event.preventDefault();
      button.onclick = () => invoke(index);
      sections.get(command.group).append(button);
    });
    empty.hidden = matches.length > 0;
    highlight();
    results.scrollTop = scroll;
  }
  function open() {
    if (dialog.open) {
      refresh();
      input.focus();
      return;
    }
    previousFocus = document.activeElement;
    input.value = "";
    active = 0;
    dialog.showModal();
    refresh();
    input.focus();
  }
  async function invoke(index) {
    const command = matches[index];
    if (!command || command.disabled?.()) return;
    active = index;
    const keepOpen = command.keepOpen ?? !["Lieux", "Caméra", "Lecture"].includes(command.group);
    if (!keepOpen) close();
    try {
      await command.run();
      if (keepOpen) {
        refresh();
        input.focus();
      }
    } catch (error) {
      status.textContent = error.message;
      open();
    }
  }
  input.oninput = () => {
    active = 0;
    refresh();
  };
  function move(direction) {
    const buttons = [...results.querySelectorAll("[role=option]")];
    if (!buttons.length) return;
    const origin = results.querySelector(`[data-index="${active}"]`).getBoundingClientRect(),
      vertical = direction === "ArrowDown" || direction === "ArrowUp",
      sign = direction === "ArrowDown" || direction === "ArrowRight" ? 1 : -1;
    let candidate = -1,
      best = Infinity;
    buttons.forEach((button) => {
      const index = Number(button.dataset.index);
      if (index === active || button.getAttribute("aria-disabled") === "true") return;
      const rect = button.getBoundingClientRect();
      const dx = rect.x + rect.width / 2 - origin.x - origin.width / 2,
        dy = rect.y + rect.height / 2 - origin.y - origin.height / 2;
      const forward = (vertical ? dy : dx) * sign,
        across = Math.abs(vertical ? dx : dy),
        score = forward + across * 3;
      if (forward > 1 && score < best) {
        candidate = index;
        best = score;
      }
    });
    if (candidate >= 0) active = candidate;
    highlight();
  }
  input.onkeydown = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (
      ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(event.key) &&
      (!input.value || event.key === "ArrowDown" || event.key === "ArrowUp")
    ) {
      event.preventDefault();
      move(event.key);
    }
    if (event.key === "Enter") {
      event.preventDefault();
      invoke(active);
    }
  };
  dialog.querySelector(".palette-close").onclick = close;
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    if (
      event.clientX < r.left ||
      event.clientX > r.right ||
      event.clientY < r.top ||
      event.clientY > r.bottom
    )
      close();
  });
  dialog.addEventListener("close", () => {
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
  });
  const shortcut = (event) => {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "k") {
      event.preventDefault();
      if (!event.repeat) {
        if (dialog.open) close();
        else open();
      }
    }
  };
  window.addEventListener("keydown", shortcut, { capture: true });
  return {
    refresh,
    destroy() {
      window.removeEventListener("keydown", shortcut, { capture: true });
      if (dialog.open) close();
      trigger.remove();
      dialog.remove();
    },
  };
}
