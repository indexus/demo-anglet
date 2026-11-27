import { datasetLayers } from "./datasets.js";
const groupOrder = ["Données", "Carte", "Couches météo", "Lecture", "Lieux"];
const weatherLayers = [
  ["weather-temperature", "Température", "temperature"],
  ["weather-clouds", "Nuages", "cloud"],
  ["weather-rain", "Pluie", "rain"],
];

// A declarative catalogue; rendering and data ownership stay in the explorer.
export function createExploreCommands({ state, actions, control }) {
  return () => {
    const s = state();
    const commands = [
      ...[
        ["weather", "Météo", "Température, pluie et nuages", "weather", "Météo", "climat météo"],
        [
          "realestate",
          "Immobilier",
          "Ventes immobilières · 2020",
          "estate",
          "Immobilier · DVF 2020",
          "DVF real estate prix ventes",
        ],
      ].filter(([id]) => !s.localOnly || id !== "realestate").map(([id, title, description, icon, label, keywords]) => ({
        group: "Données",
        title,
        description,
        icon,
        label: () => label,
        keywords: "données " + keywords,
        checked: () => s.dataset === id,
        disabled: () => !s.ready,
        run: () => actions.chooseData(id),
      })),
      {
        group: "Données",
        title: "LiDAR · 3D",
        description: "Sol, bâtiments et végétation des lieux",
        icon: "lidar",
        label: () => "Explorer les données LiDAR 3D",
        checked: () => s.active3d,
        disabled: () => !s.geometry || !s.scenes.length,
        run: actions.openScene,
        keepOpen: false,
      },
      ...[
        ["light", "Clair"],
        ["dark", "Sombre"],
      ].map(([id, title]) => ({
        group: "Carte",
        title,
        description: "Fond de carte " + title.toLowerCase(),
        icon: "map",
        label: () => `Carte ${title.toLowerCase()}`,
        keywords: "thème theme light dark blanc noir",
        checked: () => s.mapTheme === id,
        disabled: () => !s.ready,
        run: () => actions.setMapTheme(id),
      })),
      ...weatherLayers.map(([id, title, icon]) => ({
        group: "Couches météo",
        title,
        icon,
        label: () => `${control(id).checked ? "Masquer" : "Afficher"} ${title.toLowerCase()}`,
        keywords:
          "météo " +
          (icon === "rain"
            ? "précipitations rain contours"
            : icon === "cloud"
              ? "cloud couverture nuageuse"
              : "couleur chaleur"),
        checked: () => control(id).checked,
        disabled: () => control(id).disabled,
        run: () => actions.toggleWeather(id),
      })),
      {
        group: "Couches météo",
        title: "Cible locale",
        icon: "target",
        label: () =>
          `${control("pointer-toggle").getAttribute("aria-pressed") === "true" ? "Masquer" : "Afficher"} la cible de température`,
        keywords: "pointeur location position croix",
        checked: () => control("pointer-toggle").getAttribute("aria-pressed") === "true",
        run: actions.toggleTarget,
      },
      {
        group: "Données",
        title: "Carte seule",
        icon: "map",
        label: () => "Carte seule · désactiver la 3D",
        checked: () => !s.enabled3d,
        disabled: () => !s.geometry,
        run: actions.hideScene,
      },
      {
        group: "Lecture",
        label: () =>
          control("play").hasAttribute("data-playing")
            ? "Mettre en pause"
            : "Lire l’évolution météo",
        disabled: () => control("play").disabled,
        run: () => control("play").click(),
      },
      ...[
        ["previous-day", "−1 jour"],
        ["next-day", "+1 jour"],
      ].map(([id, title]) => ({
        group: "Lecture",
        title,
        icon: id === "previous-day" ? "previous" : "next",
        label: () => title,
        disabled: () => control(id).disabled,
        run: () => control(id).click(),
      })),
      ...s.scenes.map((scene) => ({
        group: "Lieux",
        label: () => scene.label,
        keywords: `${scene.id} ${scene.address ?? ""}`,
        checked: () => s.selectedPlace === scene.id,
        run: () => actions.visitScene(scene),
      })),
    ];
    return commands
      .map((command) => ({
        ...command,
        disabled: command.disabled ?? (() => false),
        visible: () =>
          ["Couches météo", "Lecture"].includes(command.group) ? datasetLayers(s.dataset).weather : true,
      }))
      .sort((a, b) => groupOrder.indexOf(a.group) - groupOrder.indexOf(b.group));
  };
}
