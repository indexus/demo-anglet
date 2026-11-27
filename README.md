# Explore Anglet with DPIP

Explore reads a region of the Indexus peer-to-peer index and draws it at the scale of the camera. Start above Anglet, zoom toward a roof, then switch between landscape, historical property sales and archived weather. MapLibre draws the basemap. The SDK reads zone summaries and nearby records, and WebGPU draws the scene.

[Live demo](https://demo.indexus.io/) · [Get Started](https://indexus.io/get-started/) · [DPIP papers](https://indexus.io/papers/) · [JavaScript SDK](https://github.com/indexus/sdk)

## Run it locally

Use Node.js 22 or later and a browser with WebGPU. Clone the SDK and this frontend side by side. The folder name `sdk-js` is part of the local dependency path.

```sh
git clone https://github.com/indexus/sdk.git sdk-js
git -C sdk-js checkout --detach afc25602954b362f8e15089af2b12ac2276037db
(cd sdk-js && npm ci)
git clone https://github.com/indexus/demo-anglet.git
cd demo-anglet
npm ci
npm run read:dvf
npm run dev
```

Open [Anglet in 3D](http://127.0.0.1:5174/?scene=anglet-mini&view=3d), [sales](http://127.0.0.1:5174/?scene=anglet-mini&view=dvf) or [weather](http://127.0.0.1:5174/?scene=anglet-mini&view=weather). The local server forwards API requests to the public demo. The read-only DVF example uses the same gateway from Node.js. With the November 2026 sample it returns 19 records. To use a local gateway instead, set `INDEXUS_API_GATEWAY` to its HTTP origin for both commands.

Run `npm test` for the client tests and `npm run build` to produce `dist/`. For a static deployment, serve `dist/` and reverse-proxy `/api` to a compatible gateway on the same origin. The browser also needs network access to the basemap service.

## From a view to the data

The code in [src/data](src/data) opens the gateway session and chooses the collections. [Explore](src/experiences/explore) chooses a view and requests its visible zones. The [3D renderer](src/experiences/point-cloud) reads terrain, imagery, vegetation and buildings near the camera. The [weather view](src/experiences/weather) reads archived fields. In the property view, a nearby roof is an approximate visual association with a historical sale. The price belongs to the sale record.

The public collections reside on the demo node. This repository distributes the viewer, its tests, an executable SDK example and the small Natural Earth geometry used to clip weather. See [data sources and redistribution](DATA.md).

## Relationship to the hosted demo

The viewer sources come from the Indexus Experiences release of 27 November 2026, commit `c0e97385b8a6e0fbf895d353e7edb190c56de908`. The standalone build selects Explore as its only entry point and uses the public demo gateway by default. Its coastline comes from Natural Earth. A local build can therefore clip the weather differently from the hosted version near the coast.

During the browser smoke test, both the hosted and local weather views displayed the AROME archive label (72 hours). Both returned HTTP 403 for the gateway metadata request ending in `/collection/TempeAROME0128v2`. Full weather rendering remains unverified. One local sales session also received HTTP 500 on a `/sets` request while displaying sale prices. A second sales session completed without that response.

The build uses the [MPL-2.0 SDK source](https://github.com/indexus/sdk/tree/afc25602954b362f8e15089af2b12ac2276037db). The browser distribution includes its [license](public/notices/sdk/LICENSE) and [component notices](public/notices/sdk/LICENSE-NOTICES.md).

The application code is available under the [MIT licence](LICENSE). The local basemap style carries [upstream notices](public/basemap-notices.txt).
