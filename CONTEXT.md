# Context and vocabulary

The domain language of the kit. Use these words consistently in scenes, code
and docs.

**Scene**: one declarative JSON unit describing a clip. The canonical term.

**Recipe**: a named motion or styling law referenced by scenes. The recipe
book is `recipes/recipes.json`.

**Window**: the `[start, end]` timecode pair scheduling one element inside a
scene. All time is frame-exact at 24 fps.

**Station**: a point in the optional geo database, identified by a stable slug.
Used for labels, rides, and station-to-station pin moves.

**Line**: one transit or route line as a feature with an official color and an
ordered station list.

**Playfield**: the optional boundary of the story area. Everything outside it
can be striped; segments and circles are clipped to it.

**Exclusion**: a hand-authored area removed from the playfield. Additive only:
nothing un-excludes an area mid-scene.

**Possible stations**: the stations still reachable given the current
exclusions. A scene usually shows them as dots.

**Ride**: the highlighted segment of a Line showing where a group is
traveling. It keeps the line's official color and is striped white.

**Seeker**: the group pin, photo plus "Seeker" label. Seekers always move
together as one entity.

**Hider**: the optional second pin, photo plus "Hider" label. Visually distinct
from the Seeker pin.

**Line entrance**: a full Line fading in mid-clip. At most one per Line.

**Free point**: a hand-authored dot plus scene-carried text, not a station.

**Segment**: a straight two-point line between hand-authored coordinates.

**Context circle**: a thin rim at a great-circle radius, before an area becomes
a striped Exclusion.

**Walking trace**: a cumulative dashed path of ground actually walked. One
path object with `append`, so the dash phase stays continuous across scenes.

**Framing**: `full`, `half`, `half-right`, or `half-bottom`. One scene equals
one framing.

**Data is truth**: stations and lines are referenced by slug, never by copied
coordinates. Raw coordinates are allowed only for hand-authored elements
(camera centers, exclusion geometry, free points, segments, circles, paths,
pin coordinates).
