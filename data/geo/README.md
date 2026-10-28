# Geo database (optional)

The kit renders without any geo data. Scenes can use hand-authored
coordinates only. Add this database when you want station and line slugs
instead of raw coordinates.

The demo scenes ship with no geo data on purpose. They show the hand-authored
element vocabulary: exclusions, circles, segments, paths, free points, pins.

## Layout

```
data/geo/
  README.md                   this file
  SOURCES.md                  provenance table (add a row per file)
  stations/
    stations.geojson          one FeatureCollection, all stations
  lines/
    <mode>/
      <line>.geojson          one file per line
  boundaries/
    playfield.geojson         optional single-feature playfield boundary
  context/                    optional ad-hoc scene data
```

`lines/<mode>/` can use any mode folder name: `u-bahn`, `s-bahn`, `tram`,
`regional`, `ferry`, or your own. The folder name is metadata; it does not
change rendering.

## Storage format

- GeoJSON everywhere (RFC 7946), WGS84.
- Coordinates rounded to 6 decimal places.
- Polygon exterior rings counterclockwise, holes clockwise.
- `kebab-case` filenames, UTF-8, no BOM.
- No build step inside `data/geo/`. The renderer and MapLibre read the files
  verbatim.

## Station feature

```json
{
  "type": "Feature",
  "properties": {
    "id": "central-station",
    "name": "Central Station",
    "lines": ["line-a", "line-b"]
  },
  "geometry": { "type": "Point", "coordinates": [13.400000, 52.520000] }
}
```

- `id` is the stable slug used by scenes. Lowercase kebab-case.
- `name` is the display name. It is the only on-screen text a station label
  can render.
- `lines` lists every line serving the station.
- `gtfs_id` is optional provenance and is never referenced by scenes.

## Line feature

```json
{
  "type": "Feature",
  "properties": {
    "id": "line-a",
    "mode": "metro",
    "color": "#274F7C",
    "stations": ["central-station", "next-station"]
  },
  "geometry": { "type": "LineString", "coordinates": [] }
}
```

- `id` matches the filename and the station `lines` entries.
- `mode` matches the folder name.
- `color` is the official line color, `#RRGGBB`. It is the single source of
  truth for line and label color.
- `stations` is the ordered station list. It drives rides and progress moves.
- Geometry is the real alignment, simplified for hand editing. Use
  `MultiLineString` for real branches and a closed `LineString` for ring lines.

## Playfield boundary (optional)

`boundaries/playfield.geojson` is a single `Feature` (or a one-feature
`FeatureCollection`) with a `Polygon` or `MultiPolygon`. When present, the
renderer draws the dashed playfield outline, stripes everything outside it,
and clips segments and circles to it. When absent, all three are skipped.

The boundary is the visual limit of the game or story area. It is not a
political statement and it is not computed.

## Validation

```sh
node scripts/validate-geo.mjs
```

The validator checks:

- RFC 7946 structure and WGS84 bounds;
- unique ids across stations and lines;
- two-way station and line referential integrity;
- `#RRGGBB` line colors;
- polygon winding;
- 6-decimal rounding;
- kebab-case filenames and the layout tree.

An empty `data/geo/` is valid and produces zero errors and zero warnings.

## Provenance

Every file gets one row in `data/geo/SOURCES.md` with source URL, license and
fetch date. That table is the single attribution lookup for published work.
