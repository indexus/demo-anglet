# Data behind Explore Anglet

| Layer | What the viewer reads | Where it comes from |
|---|---|---|
| Terrain, buildings and vegetation | Zone summaries, nearby meshes and voxel records | Prepared Anglet sample based on IGN LiDAR HD |
| Aerial imagery | Tiles returned for visible zones | Prepared IGN BD ORTHO imagery |
| Property sales | Historic 2020 DVF records around the Anglet scene | DGFiP / Etalab DVF |
| Weather | Archived AROME fields for January 2025 | Météo-France fields accessed through Open-Meteo archives |
| Basemap | External tiles, fonts and sprites | OpenFreeMap, OpenMapTiles and OpenStreetMap contributors, with [notices](public/basemap-notices.txt) |
| Weather clipping geometry | A GeoJSON multipolygon bundled here | Natural Earth, public domain |

The gateway serves the prepared scientific and geographic collections. To inspect a small sample, run `npm run read:dvf`. To see the collections available on the public gateway, open its [mesh inventory](https://demo.indexus.io/api/demo/mesh). The source licences for records and imagery remain their own. This repository includes no node snapshot, town-label corpus or sale extracts.

## Weather clipping geometry

[public/france.geojson](public/france.geojson) is a derivative of [Natural Earth 1:50m Admin 0 Countries, version 5.1.2](https://github.com/nvkelso/natural-earth-vector/blob/f1890d9f152c896d250a77557a5751a93d494776/geojson/ne_50m_admin_0_countries.geojson). The published source file has SHA-256 `3e458fc036ad0a66411f2c1e6cac49c5d7bfb81cb1123bc513b22511a2b7fdeb`. We selected the feature with `ADM0_A3=FRA` and retained the three polygon components fully inside 6°W–10°E, 41°N–52°N, preserving their rings. The resulting file has SHA-256 `5bdfba2ba0e2dba18cb46129affb238d3815d2be79e68e859b1ae7b5d241a4a4`. Natural Earth publishes these data in the [public domain](https://www.naturalearthdata.com/about/terms-of-use/).
