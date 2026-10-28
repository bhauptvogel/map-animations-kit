# Attribution

The kit itself is MIT-licensed. The data and tiles you render with are not
covered by that license. Keep the obligations below when you publish a video.

## Demo basemap: OpenFreeMap

The shipped style uses the public OpenFreeMap instance. OpenFreeMap asks for
this attribution for video and other non-MapLibre clients:

> OpenFreeMap, © OpenMapTiles, Data from OpenStreetMap

You do not need to display the OpenFreeMap part, but it is nice to do so.
Source: https://openfreemap.org/

OpenFreeMap has no SLA. For production work, consider a local PMTiles extract.

## OpenMapTiles

The style targets the OpenMapTiles schema. The OpenMapTiles design is
CC-BY 4.0 and requires `© OpenMapTiles` in published maps.

## OpenStreetMap

Map data is © OpenStreetMap contributors, ODbL 1.0. Published video should
credit `© OpenStreetMap contributors`.

## Your own data

If you add geo data, add one row per file to `data/geo/SOURCES.md` with source,
license and fetch date. If you add local tiles, record the build provenance in
`data/tiles/README.md`.

The renderer never draws attribution. Composite it in your editor.
