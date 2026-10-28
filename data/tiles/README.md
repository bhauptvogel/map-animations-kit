# Optional local tiles

The shipped style uses hosted OpenFreeMap tiles, so this folder is empty and
the kit renders without a tile download.

For deterministic, offline production renders, build or download a PMTiles
extract and put it here:

```
data/tiles/<area>-<date>.pmtiles
```

Then change the style source in `style/style.json`:

```json
"sources": {
  "ofm": { "type": "vector", "url": "pmtiles:///tiles.pmtiles" }
}
```

The renderer serves the first `.pmtiles` file it finds in this folder. The
PMTiles protocol is already registered in the render page.

Attribution for OpenStreetMap-derived tiles: `© OpenStreetMap contributors`
(ODbL) and `© OpenMapTiles` (CC-BY 4.0). The renderer never draws attribution;
composite it in your editor for published video.
