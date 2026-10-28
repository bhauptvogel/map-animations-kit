---
description: Mandatory when reading images (rendered stills, screenshots, PNGs/JPEGs) with the read tool. Raw 1920×1080 PNGs bloat the request body and make the provider fail intermittently with `failed to read request body (ref: …)`. Always downscale or convert before reading.
---

# Reading images

Render stills are 1920×1080 PNGs (~3.5MB each). Reading them raw bloats the
model request body (~60MB with 18 images) and makes the provider fail
intermittently with `failed to read request body (ref: …)`. Before reading any
image:

- **Downscale** when only checking layout/composition:
  `sips -Z 960 <still>.png --out /tmp/small.png`
- **Convert to JPEG** when full detail is needed:
  `sips -s format jpeg -s formatOptions 80 <still>.png --out /tmp/small.jpg`
- **Read at most 1–2 images per turn**; prefer a montage (`montage`, ImageMagick)
  or compare frames via pixel-diff scripts instead of eyeballing each one.