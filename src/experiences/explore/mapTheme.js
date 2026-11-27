// Recolour the existing vector basemap in place. No setStyle(), source reload,
// custom-layer removal or loss of the loaded 3D / DVF buffers on theme changes.
export function lightPaint(layer) {
  const id = layer.id.toLowerCase(),
    paint = layer.paint ?? {};
  switch (layer.type) {
    case "background":
      return { "background-color": "#f7f8fa" };
    case "fill": {
      const fill = /water|ocean|lake|river/.test(id)
        ? "#dce5ec"
        : /building/.test(id)
          ? "#e0e4e8"
          : /park|forest|wood|grass|vegetation/.test(id)
            ? "#e9efe5"
            : "#f4f5f2";
      return {
        "fill-color": fill,
        ...("fill-outline-color" in paint ? { "fill-outline-color": "#ccd3da" } : {}),
      };
    }
    case "fill-extrusion":
      return { "fill-extrusion-color": "#dfe4e9" };
    case "line":
      return {
        "line-color": /water|river/.test(id)
          ? "#b5cbdc"
          : /boundary|admin|border/.test(id)
            ? "#77838e"
            : /casing|outline|rail/.test(id)
              ? "#c3cbd2"
              : "#ffffff",
      };
    case "symbol":
      return layer.layout?.["text-field"]
        ? { "text-color": "#26313b", "text-halo-color": "#ffffff", "text-halo-width": 1 }
        : {};
    default:
      return {};
  }
}
export class MapTheme {
  constructor(map) {
    this.map = map;
    this.theme = null;
    this.layers = map
      .getStyle()
      .layers.filter((l) => l.type !== "custom" && !/^(weather-|scene-|explore-)/.test(l.id))
      .map((layer) => ({ layer, light: lightPaint(layer) }));
  }
  set(theme) {
    theme = theme === "dark" ? "dark" : "light";
    if (this.theme === theme) return;
    this.theme = theme;
    for (const { layer, light } of this.layers)
      if (this.map.getLayer(layer.id))
        for (const [property, value] of Object.entries(light))
          this.map.setPaintProperty(
            layer.id,
            property,
            theme === "light" ? value : (layer.paint?.[property] ?? null),
          );
    this.map.triggerRepaint();
  }
}
