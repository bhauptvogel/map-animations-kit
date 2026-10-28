# Shared exclusion shapes

Optional. Scenes may inline an exclusion polygon or reference a shared shape by
slug:

```json
"exclusions": [
  { "id": "zone", "shape": "my-zone", "entry": { "recipe": "present-from-start" } }
]
```

The renderer looks for `scenes/shapes/my-zone.geojson` (Polygon or
MultiPolygon, RFC 7946, exterior rings counterclockwise). Shared shapes are
useful when several scenes use the same area.
