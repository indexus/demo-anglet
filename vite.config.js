import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = path.dirname(fileURLToPath(import.meta.url));
const sdk = path.resolve(root, "../sdk-js");
const { exports: subpaths } = JSON.parse(readFileSync(path.join(sdk, "package.json"), "utf8"));
const aliases = Object.entries(subpaths).map(([subpath, target]) => ({
  find: new RegExp("^js-indexus-sdk" + subpath.slice(1) + "(?=$|\\?)"),
  replacement: path.join(sdk, typeof target === "string" ? target : target.import),
}));
const earcut = path.join(sdk, "node_modules/earcut");
if (existsSync(earcut)) aliases.push({ find: /^earcut$/, replacement: earcut });

export default defineConfig({
  define: {
    "import.meta.env.VITE_DEMO_MODE": JSON.stringify("1"),
    "import.meta.env.VITE_DEFAULT_DATASET": JSON.stringify("weather"),
  },
  resolve: { alias: aliases, dedupe: ["maplibre-gl", "react", "react-dom"] },
  worker: { format: "es" },
  server: {
    fs: { allow: [root, sdk] },
    proxy: {
      "/api": {
        target: process.env.INDEXUS_API_GATEWAY || "https://demo.indexus.io",
        changeOrigin: true,
        timeout: 120000,
        proxyTimeout: 120000,
      },
    },
  },
});
