# 3D scenes

[中文](./scenes.zh-CN.md)

A scene document describes a room, the objects in it and how they relate. auto-graph solves where every object stands and which way it faces, then checks the result. It is plain math with no 3D application in the loop, so an agent gets exact numbers it can hand to Blender, a game engine or a robot planner.

It covers a floor plan plus stacking (2.5D), with objects turning about the vertical axis, paths for people and robots, placing a scene on the Earth by latitude and longitude (on a local frame or a map projection for large sites), uneven ground (terrain) where objects stand, lean with the slope and keep to slope and elevation limits, and lines (roads, geodesic routes) to place things along and lay drone waypoints on. Exports to glTF, USD and Cesium, and MCP tools, follow in #122.

## The frame

- x points east, y north and z up; lengths are meters.
- The origin is the room's south-west floor corner, so the floor runs from `[0, 0]` to `[width, depth]`.
- Compass words name the room's directions: `north` is +y. This is not geographic north.
- Angles are degrees, counter-clockwise seen from above, with 0 pointing east.
- An object's `size` is `[width, depth, height]` before it is turned: width along its own x, depth along its own y.
- Its `front` is the side it faces before it is turned. The default is `-y`, which faces south, toward a viewer standing south of the room and looking north.
- *Left* and *right* are as seen by someone standing in front of the reference and looking at it. With the default front, left is west (-x) and right is east (+x).

## The document

```yaml
scene: study                 # the name
units: m                     # m (default), cm or mm; every length below uses it
bounds: { width: 4, depth: 5, height: 2.8 }   # height is optional (no ceiling check)
minGap: 0.05                 # smallest clearance between objects on one surface (default 0)
makeWay: true                # move objects apart where a path is blocked (default true)
objects:
  desk:  { size: [1.4, 0.7, 0.75] }
  chair: { size: [0.5, 0.5, 0.9], front: -y, label: Chair, asset: office_chair }
  seat:  { size: [0.45, 0.45, 0.9], count: 4 }     # seat1 … seat4, also usable as the group "seat"
  plant: { size: [0.4, 0.4, 1.1], position: [0.35, 0.35], yaw: 30 }   # pinned
relations:
  - desk against wall north
  - chair in-front-of desk, facing desk, gap 0.1
```

Object fields:

| Field | |
| --- | --- |
| `size` | `[width, depth, height]`, positive |
| `front` | `-y` (default), `+y`, `-x`, `+x` |
| `count` | expands to `id1 … idN`; an id ending in a digit gets `id-1 …` |
| `position` | pins the footprint center `[x, y]` (not with `count`) |
| `yaw` | pins the turn in degrees |
| `label` | the name drawn in the top view and Blender |
| `asset` | a Blender collection to instance instead of a box |

Lengths in relations take the document's units or a suffix: `gap 10cm`, `radius 0.9m`.

## Relations

A relation is one line: a subject, a verb, then clauses after commas. The subject is an object, a `count` group, or objects joined with `and`. A single-subject relation given a group applies to each member.

| Relation | Means | Clauses |
| --- | --- | --- |
| `a in-front-of b` / `behind` / `left-of` / `right-of` | `a` beside that side of `b` (snapped to the nearest world axis), centered on `b` across it | `gap` (between the sides, default `minGap`) or `distance` (between centers) |
| `a against wall north` (also `against north wall`, `n`/`s`/`e`/`w`) | `a`'s side at the wall; its back turns to the wall unless told otherwise | `gap` |
| `a corner ne` (`nw`, `se`, `sw`) | in the corner, touching both walls | `gap` |
| `a center-of room` / `a center-of b` | centered on the room or on `b`'s footprint | |
| `a on b` | stands on top of `b` (z = top of `b`) and turns with it | `at center`, `front`, `back`, `left`, `right`, `front-left` … (`right-back` works too) |
| `a facing b` / `facing north` | turns to face the nearest point of `b`, or a compass direction | |
| `a rotate 30` | turns by an angle (also `30deg`) | |
| `a and b align x with c` | same center x as `c` (`y` likewise) | |
| `g distribute evenly along x` / `along wall south` | a row with equal gaps; along a wall it also stands against it | `gap` (fixed, row centered) |
| `g grid 2x3` | rows × columns, north row first, west to east | `gap` |
| `g around c, radius 0.9` | evenly on a circle round `c` (polar), each facing `c` | `start` (degrees, default 270 = south), `facing` / `rotate` instead of facing `c` |
| `a and b symmetric about room` / `about c` | mirrored about the room's or `c`'s center line | `axis x` / `axis y` (default: the axis they are apart on) |
| `keep clear 0.8 between a and b` | at least that far apart (an aisle) | |
| `keep clear 350 between g` | every pair in group `g` at least that far apart | |
| `a tilt 25` | leans toward its front by that many degrees, lowest corner on the ground (also a clause: `a facing south, tilt 25`) | |
| `a on terrain` / `a align to slope` | stands on the ground (every object on the floor of a scene with terrain does) / leans square to it | `align to slope` (after `on terrain`) |
| `a slope below 8` | the ground under it no steeper than that (degrees, also `<`, `<=`) | |
| `a elevation between 100 and 300` / `above 100` / `below 300` | the ground under it between those elevations | |

`facing` and `rotate` may also follow any other verb: `chair in-front-of desk, facing desk`.

## How it is solved

1. **Supports.** `on` relations form a forest. An object stands at the top of its support, at its `at` spot in the support's own frame; everything else stands on the floor.
2. **Turns.** These set an object's turn, in priority order:
   - a pinned `yaw`, `rotate` or `facing` (disagreeing values are an error);
   - otherwise, `around` faces the center;
   - otherwise, `against wall` turns the back to the wall;
   - otherwise, an object on a support turns with it so their fronts agree.
3. **Floor plan.** Each axis is a separation-constrained quadratic program on auto-graph's VPSC solver, with the walls as variables.
   - Most relations become equalities on one axis.
   - The beside relations also softly pull the two centers into line.
   - Every object is kept inside the room.
   - Overlaps (closer than `minGap`, or than a `keep clear` distance) are removed the way VPSC removes node overlaps. A separation goes on the axis that overlaps least, never on an axis where the pair's offset is already fixed. A pair still overlapping is moved to the other axis once.
   - Objects nothing holds start on a grid over the room.
4. **Rounds.** Facing an object needs both positions, and the spot on a support depends on the turn. So the floor plan and the supports are solved in rounds until no turn changes.
5. **Checks.** The result is checked for:
   - interpenetration (separating-axis test on the turned footprints times their height intervals);
   - objects past the walls or the ceiling;
   - objects whose center is off their support;
   - relations that do not hold;
   - `keep clear` distances;
   - non-finite numbers.

   Overhangs and `minGap` only warn.

The same input gives the same output, byte for byte.

## Paths

Paths are routes an agent must be able to take: a person from the door to the desk, a robot vacuum to its dock. They are the scene's counterpart of a diagram's edges, planned with the same machinery (#128).

```yaml
openings:
  door: { wall: south, at: 0.6, width: 0.9 }   # center 0.6 m from the wall's west (or south) end
agents:
  robot: { radius: 0.18, height: 0.1, speed: 0.5, accel: 0.5 }   # person (0.25, 1.8, 1.2 m/s, 1 m/s²) is built in; declaring person keeps its pace unless given
paths:
  - person from door to desk
  - person from door to shelf, clearance 0.05
  - robot from door to shelf, orthogonal
  - person from chair to door, via lamp and table
  - person from desk to door, comfort 0.3
  - robot from shelf to door, start 4          # sets off 4 s in (seconds)
```

- **Configuration space.** The agent is shrunk to a point. Every object in its way grows by the agent's radius plus `clearance`, and the walls move in by the same amount. An object is in the way when its bottom is below the agent's height, so a low robot passes under a table top resting on a pedestal.
- **Ends.** An object is reached at the point in front of it. If something stands there, the agent goes to its left, right or back instead, sliding along that side when its middle is too close to a wall; each free spot is tried in turn. Something standing on a support (a lamp on a desk) is reached from the support's sides. An opening is reached just inside the room, and must be as wide as the agent plus `clearance` on both sides. A path to an object left out of the layout is reported (`scene.path.unplaced`).
- **Routing.**
  - By default the path is the shortest any-angle route through the corners of the grown footprints: a visibility graph searched with A*.
  - `orthogonal` uses auto-graph's sparse-grid router, the one that routes diagram edges, so the path turns only at right angles.
- **Refinement.** The shortest route skims every corner it turns round. Like a diagram's edges after routing, each path is then tidied with auto-graph's own passes:
  - **Mid-aisle.** Any-angle corners slide away from what they turn round, keeping up to `comfort` (default 0.15 m) beyond `clearance` where the aisle allows, and the path is pulled tight again. Right-angle paths go through the channel centring that diagram edges use: each run between two turns moves to the middle of its aisle, and runs sharing an aisle spread across it. Runs attached to an end stay on the end's line. The path never grows more than 15 % over the shortest route; `comfort 0` keeps the shortest route.
  - **Lanes.** Two paths meeting head-on on a shared run keep right: one steps to the right of its direction of travel until the two bands just touch (failing that the other, or each half way). Ends stay put; the run steps aside just after them. Paths going the same way share a lane (one walks behind the other). Stepping aside never takes a path past its 15 % length budget, and a path with `comfort 0` keeps its shortest route. Every head-on run left at the end is reported with where and why: too narrow to pass (`scene.path.single-file`), or outside the budget, a path at `comfort 0`, or not worked out within the round limit (`scene.path.head-on`).
  - **Detours.** A path more than twice as long as the straight line between its places (and over 1 m longer) is reported as information, so an agent can see that something stands in the direct way.
- **Timing.** An agent starts and stops at rest, speeds up and brakes at `accel` (default 1 m/s²) and goes no faster than `speed` (default 1 m/s; a person 1.2 m/s). At a corner it slows to `speed · (1 + cos θ) / 2`, where θ is how far it turns: full speed straight on, half speed round a right angle, a stop to turn back. Every path gets the time it reaches each corner and how long it takes. It sets off at `start` (default 0, at most 1,000,000 s).
- **Meeting.** Paths that give a `start` run on one clock. Two agents that would touch on the way are reported (`scene.path.meet`, a warning; the check is exact, not sampled: in each stretch where both agents speed up, cruise or brake, their distance is a polynomial in time) with when and where, and with how much later the second could set off to miss the first. Paths without a `start` are routes, not a schedule, and are not compared.
- **Checks.** Every path is checked on its own against the turned footprints and the walls. `clearance` in the output is the least distance from the agent's edge to anything.
- **Making way.** Paths shape the layout. When a path is blocked, the two things at its narrowest place (two objects, or an object and a wall) are held apart in the floor plan, and the plan is solved again. The gap is the path's width plus `comfort` on each side if that fits, else just the width (both plus 2 cm). When the narrowest place is something standing on a support, its support is moved. This repeats up to four times, so a path with several narrow places can pass them in turn. A new plan is taken only if no path that was clear gets blocked, it is a step forward (fewer paths blocked, less width missing, or a narrow place passed for the next) and no other check got worse: no problem that was not there before, no warning turned into an error, no measure grown (how far past a wall, how deep a collision, how far an overhang, how short a gap). One problem going away never pays for another appearing. Relations and pins still hold: only what nothing fixes moves. In the end the best plan seen is kept, the original on a tie. Each aisle that holds in it and lets a path through is reported (`scene.path.made-way`). `makeWay: false` keeps the plan the relations alone give.
- **Blocked.** When there is no way through, the agent is shrunk until one exists. The widest agent that gets through is as wide as the narrowest place on its way, and that place is reported: `"person" cannot get from "door" to "desk": the way between "cabinet" and the west wall is 0.4 m wide; it needs 0.5 m (0.1 m short).` An opening narrower than the agent is reported as such.

Planned paths appear in the `dge-scene` JSON, the top view and the Blender script:
- In the JSON, `paths` gives points, length, width, clearance, start, times and duration, and `agents` gives each agent's size, speed and acceleration. `clearance` is the least distance anywhere, ends included: an agent walks right up to what it reaches.
- The top view draws each path as a band as wide as the agent, with a tick for every second on the way.
- Openings appear in all three.

<img src="images/scene-office.top.svg" alt="examples/scene/office.yaml: people walk mid-aisle and keep right where they meet; a robot takes right-angle aisles" width="100%">

In `examples/scene/storeroom.yaml` nothing holds the racks in place. On their own they would stand 0.7 m apart, too narrow for a 0.7 m trolley with a margin. The solver moves them 1.02 m apart (0.7 m plus 0.15 m comfort on each side, plus 2 cm):

<img src="images/scene-storeroom.top.svg" alt="examples/scene/storeroom.yaml: the racks moved apart so a person and a trolley get to the bench" width="100%">

## On the Earth

A scene can be placed on the Earth. The solver still works in metres in the scene's own frame; latitude and longitude come in through `frame` and `landmarks` and go out with every object.

```yaml
frame:
  origin: { lat: 39.99, lon: 116.39, alt: 45 }   # WGS84 degrees, height in metres
  datum: WGS84          # or GCJ02 / BD09: every latitude and longitude in the document is read in it
  anchor: [0, 0]        # the scene point at the origin (default the south-west corner)
  heading: 0            # true bearing of the scene's +y axis, degrees clockwise (default 0)
  projection: auto      # enu | utm | web-mercator (default auto: enu within 10 km, else UTM)
  zone: 50              # optional UTM zone instead of the origin's
landmarks:
  gate:     { lat: 39.99009, lon: 116.39035 }      # fixed points for relations to refer to
  fountain: { lat: 39.99045, lon: 116.39070 }
objects:
  pavilion: { size: [12, 10, 6], geo: { lat: 39.99070, lon: 116.39110 } }   # pinned by latitude and longitude
relations:
  - kiosk 25m bearing 60 from gate        # true bearing, degrees clockwise from north
  - lamp 8m north-of pavilion             # also north-east-of, ne-of, south-of, …
  - info at gate, facing fountain
  - bench around fountain, radius 12
```

- **Frames.** Scene metres are tied to a local east-north-up frame at `origin`: the scene point `anchor` is at the origin and the scene's +y axis points along true bearing `heading`. The scene's floor is the level surface at the origin's height, so latitude and longitude round-trip exactly and an object's height is the origin's plus its z. With `heading: 0` the scene's north (its compass words, `against wall north`) is true north; otherwise those words stay the scene's own and the top view's arrow points to true north.
- **Landmarks** are fixed points. `at`, distance-and-bearing, `around` and `facing` accept them in place of an object. A landmark given without a height is on the ground (the origin's height).
- **Distances.** From a landmark, `<length> bearing <degrees> from` and `<length> north-of` follow the WGS84 geodesic exactly. From an object they are taken on the site's plane, whose north is true north at the origin; meridians converge by about 0.001° per 100 m east or west of it, so the bearing may differ from true north there by that much. Lengths also take `km`. Without a frame, bearings are from the scene's north.
- **Datums.** GCJ-02 and BD-09 coordinates (Chinese map services) are converted with the widely published formulas, approximations of the official transform good to a few metres; the inverses are solved to well under a millimetre of those formulas. Everything is stored and output in WGS84.
- **Reach and projections.** A local east-north-up frame (`projection: enu`) serves sites within 10 km of the origin. Left at `auto` (the default), a site reaching further (its bounds from the anchor, any point given by latitude and longitude, or a distance from a landmark) is laid out on the UTM zone of its origin instead, and `scene.geo.projection` (info) names the zone and its EPSG code. A UTM site that reaches into a neighbouring zone stays on its own zone and gets `scene.geo.zone-crossing` (a warning, with the grid scale at the far edge). On a projection, scene metres are the grid's metres from the origin, turned so +y is true bearing `heading` at the origin (grid north differs from true north by the convergence there). UTM's scale is 0.9996 on the central meridian and about 1.001 3° from it. `web-mercator` (EPSG:3857, to line up with map tiles) is scaled to true metres at the origin, east-west and north-south separately, and takes longitudes around the origin's, so a site across the 180° meridian stays in one piece. A point a frame cannot place is refused (`validate.scene.geo-extent`); so is a frame origin the chosen projection cannot hold (pointing at `frame.origin`), before any frame is built on it. This is measured on the Earth before projecting: more than 10 km from a local frame's origin (a point on the far side is never folded back near it), more than 15° from a UTM zone's central meridian or outside 80°S–84°N (polar UPS is not supported), or past Web Mercator's ±85.05°. An explicit `enu` frame reaching past 10 km gets `scene.geo.extent`.
- **Output.** Every object gets `geo` (latitude, longitude, height of its `position`), and the document gets `geo` (the frame) and `landmarks`. The Blender script records them as custom properties (`dge_geo` on objects, `dge_geo_origin` on the collection).

The geodesic and frame mathematics (`src/scene/geo`) is checked against GeographicLib (distances and bearings to 1e-6 m and degrees within 10 km), the GCJ-02/BD-09 formulas against the coordtransform package, and UTM (Krüger's series to sixth order, good to nanometres within the zone) and Web Mercator against proj4 (to 1e-6 m); frame round trips stay under 1 mm within 10 km for local frames and within 100 km for projected ones.

<img src="images/scene-park.top.svg" alt="examples/scene/park.yaml: a park placed by latitude and longitude, with landmarks" width="100%">

## On terrain

A scene can stand on uneven ground: a grid of elevations.

```yaml
terrain:
  grid:
    origin: [0, 0]      # scene x, y of the south-west sample (default [0, 0])
    spacing: 10         # metres between samples, or [x, y]
    heights:            # elevations, rows south to north, each west to east
      - [1400.1, 1400.3, 1400.9]
      - [1400.6, 1401.2, 1402.0]
  base: 1400            # elevation at scene z = 0 (default 0; in a scene with a frame, the frame origin's height)
relations:
  - panel on terrain, align to slope      # lean with the ground
  - turbine slope below 8                 # degrees from level, anywhere under it
  - turbine elevation above 1425          # also below <b>, between <a> and <b>
```

- **The ground** between samples is the bilinear surface through the four corner samples of each cell: continuous, and exact for planes. Scene z is elevation minus `base`. In a scene with a `frame`, `base` is the frame origin's height, so an object's `geo` height is the elevation of the ground it stands on.
- **Standing on it.** Every object on the floor stands on the ground at its footprint center (`on terrain` says so explicitly). Upright objects stay upright; where the ground under one rises more than 10 cm across it, `scene.terrain.uneven` (info) says how far its lowest edge floats and its highest edge is buried. `align to slope` leans the object square to the ground: its up axis is the normal of the plane fitted to the ground under it, its rotation the turn about z then that tilt (`quaternion`, plus `up` in the output). Objects on a support stand on its top as before; a support that leans is reported.
- **Limits.** `slope below` and `elevation above / below / between` hold over the whole footprint, measured exactly: the footprint is clipped to every grid cell it crosses, the steepest slope is at a corner of a clipped piece (the squared gradient of a bilinear cell is convex), and the extreme elevations are on its edges. An object whose ground breaks its limits is moved to the nearest spot that meets them, inside the bounds and clear of everything else on the ground (by `minGap` and `keep clear`), where nothing holds it: a pin or a relation that fixes it keeps it, and `scene.terrain.slope` / `scene.terrain.elevation` (errors) say what is wrong. Each move is reported (`scene.terrain.moved`). The search is greedy, nearest spot first, object by object: where good ground is scarce it may not find room for all, and the errors stay.
- **Paths** follow the ground: corners and agents are at its height. An agent passes under an object only if the object clears the agent's height above the highest ground anywhere under it (its footprint widened by the agent's radius and clearance), so a beam high over its middle but low over its uphill end blocks the way, and the ceiling (`bounds.height`) is measured from the ground under each object.
- **Data.** `terrain.parseAsciiGrid(text)` (from the package) reads an ESRI ASCII grid (`.asc`, what GIS tools export from a DEM) into `{ origin, spacing, heights }` for `terrain.grid`, in the file's own coordinates (set `origin` to place it in the scene). `terrain.sampleTerrain(fn, …)` builds a grid from a function (synthetic ground for tests).
- **Output.** The document gets `terrain` (origin, spacing, base and heights). The top view draws contour lines (every fifth darker, with its elevation). The Blender script builds the ground as a mesh on the bilinear surface (each cell cut into up to 4 × 4 quads), leans aligned objects, lays paths and agents on the ground, and marks landmarks with pins.

<img src="images/scene-hillside.top.svg" alt="examples/scene/hillside.yaml: contour lines; turbines moved onto the ridge; solar panels leaning with the slope" width="100%">

<img src="images/scene-hillside.jpg" alt="examples/scene/hillside.yaml rendered in Blender" width="100%">

## Lines and waypoints

Lines are polylines (roads, fences, flight lines); things can be spread along them, and drone waypoints laid out on them.

```yaml
lines:
  road:   { points: [[184, 22], [150, 40], [120, 62], [92, 76]] }   # scene x, y
  route:  { geo: [{ lat: 39.9, lon: 116.4 }, { lat: 31.2, lon: 121.5 }] }   # along the geodesic (great circle)
waypoints:
  scan: { line: survey, spacing: 20, height: 60, min: 30 }   # or count: 8; by default one per vertex
relations:
  - lamp along road, offset 4                 # spread evenly from start to end
  - lamp along road, spacing 25, from 5, offset -3, rotate 0
```

- **Lines** are given in scene x, y (`points`), or by latitude and longitude (`geo`, needs a `frame`). A geographic line follows the WGS84 geodesic between its points (the great circle on the sphere): each leg is densified (every 1% of the longest leg, at most 100 m) so it keeps its curve once projected. In the output every line lies on the ground (z of the ground, or 0) with its length.
- **`along`** spreads a group (or objects joined with `and`) along a line by arc length: `spacing` metres apart from `from` (default 0), or evenly from `from` to the end without a spacing. `offset` puts them to the right of the direction of travel (negative: left). Each is turned to face the line (or along it when on it) unless the relation gives `facing` or `rotate`. Spacing past the end is refused (`validate.scene.along-overflow`). The places are fixed spots of the floor plan, so a relation or pin that contradicts one is reported as a conflict, and on terrain the objects stand on the ground.
- **Waypoints** sit on a line at `height` above the ground: `spacing` metres apart along it (and at its end), `count` spread evenly, or one per vertex. The output gives their [x, y, z] (and latitude, longitude, height with a frame) and `lowest`, the lowest height above the ground anywhere along the straight legs between them (measured every eighth of a grid cell on terrain). A leg that comes lower than `min` gets `scene.waypoint.low`; one that passes through an object's box gets `scene.waypoint.collision` (both warnings).
- The top view draws lines dashed and waypoints as rings on their legs, with the height; the Blender script draws lines on the ground and waypoints as markers joined by their flight line.

## Outdoor examples

Three examples put terrain, limits, lines and arrays together:

- **[`windfarm.yaml`](../examples/scene/windfarm.yaml)**: 3 km × 2 km of uplands on a 100 m grid. Eight turbines are given only limits (`slope below 5`, `elevation above 1450`, `keep clear 350 between turbine`), and the solver puts each on a hilltop. Turbines already on good ground stay where they are while the others move. An access road carries marker posts.
- **[`solar.yaml`](../examples/scene/solar.yaml)**: four rows of eight panels (`panel grid 4x8, gap 3`) facing south and tilted 25° (`panel facing south, tilt 25`) on a field that falls gently to the south, with inverters at the end of the rows.
- **[`streetlights.yaml`](../examples/scene/streetlights.yaml)**: lamps every 30 m on both sides of a curved road, staggered by 15 m, plus benches, all placed `along` the road and facing it.

| Wind farm | Solar array | Street lights |
| --- | --- | --- |
| <img src="images/scene-windfarm.top.svg" alt="Wind farm: turbines on the hilltops inside the 1450 m contour" width="100%"> | <img src="images/scene-solar.top.svg" alt="Solar array: four rows of tilted panels" width="100%"> | <img src="images/scene-streetlights.top.svg" alt="Street lights along a curved road" width="100%"> |
| <img src="images/scene-windfarm.jpg" alt="Wind farm rendered in Blender" width="100%"> | <img src="images/scene-solar.jpg" alt="Solar array rendered in Blender" width="100%"> | <img src="images/scene-streetlights.jpg" alt="Street lights rendered in Blender" width="100%"> |

Two relations serve arrays: `tilt <degrees>` leans an object toward its front (a panel facing the sun). The object is lifted so its lowest corner is at the height it stands on, and its rotation and `up` are in the output. `tilt` and `align to slope` cannot both apply (`scene.tilt.conflict`). `keep clear <length> between <group>` keeps every pair in a group that far apart, edge to edge.

## Output

`renderSceneDsl(source, { format })`, or `agh --input room.yaml --format …`:

- **`scene-json`** (default) is the `dge-scene` v1 document, described by [`schema/dge-scene.v1.schema.json`](../schema/dge-scene.v1.schema.json). Numbers are rounded to 4 decimals. Per object it gives:
  - `position`: the footprint center and the bottom height `[x, y, z]`;
  - `yaw` and the rotation as a `quaternion` `[x, y, z, w]` (the turn, then any lean with the slope, given with `up`);
  - `size` and `front`;
  - `supportedBy`;
  - the world `aabb`.

  The document also carries `valid`, the diagnostics and `unplaced`: objects left out because their position, turn or size would not be a finite number (reported as `scene.non-finite`), so every document written is a valid v1 document.
- **`blender`** is a Python script for Blender (bpy) with the document embedded.
  - Every box has its origin at the bottom center, so its location is exactly `position` and its z rotation the `yaw`.
  - A triangle on top marks the front.
  - An `asset` naming a collection in the open file is placed as an instance of it.
  - Openings are strips across the wall line. Each path is a curve on the floor, and its agent a cylinder (its radius and height) that walks it on the path's times, at 24 frames a second.
  - Everything goes into one collection named after the scene, which is rebuilt when the script runs again.
  - Headless render (Cycles on the CPU, no GPU needed): `blender -b --python room.py -- --render room.jpg [--size 1200x900] [--samples 24] [--frame 72]`. `--frame` picks a moment of the walk: frame 0 is when the first agent sets off, at 24 frames a second (72 = 3 s later). A walk too long for Blender's frame range is slowed down to fit (`fps_base`), and the scene records `dge_time_origin` and `dge_fps`. `--animation room.mp4` renders the whole walk as a video.
- **`gltf`** and **`glb`** are glTF 2.0 (`.gltf` JSON with its buffer inlined, or one binary `.glb`; `renderSceneDsl` returns the glb as `bytes`), for Three.js, Blender, game engines and other 3D tools. Both pass the Khronos glTF Validator with no issues.
  - glTF is y-up: every point (x, y, z) is written as (x, z, -y) and every rotation [x, y, z, w] as [x, z, -y, w]. Importers that turn y-up back to z-up (Blender's does) give the document's `position` and `quaternion` again.
  - Each object is a placeholder box (origin at the bottom center, a triangle on top at the front, colored by stacking level). Its node's `extras` carry `dge_id`, `dge_front`, `dge_size` and, when set, `dge_supported_by`, `dge_asset`, `dge_group`, `dge_label` and `dge_geo` (importers keep them as custom properties), so a tool can swap the box for the named asset.
  - The floor (or the terrain mesh), openings, paths, lines, waypoints (a line strip and points) and landmark pins come along. Each path's agent is a cylinder in one animation, `agents`, keyed every 0.1 s and at every corner; its time 0 is when the first agent sets off (`dge_time_origin` on the root node).
- **`svg`** is a plan view for checking by eye:
  - north up, on a 0.5 m grid;
  - a triangle on each front;
  - stacked objects tinted by level;
  - failed objects outlined in red, with the diagnostics listed underneath.

The CLI writes the output even when the scene is invalid (`valid: false`, exit code 1), so the problem can be seen. A document that does not validate writes nothing. Diagram-only options such as `--page` are rejected.

## Diagnostics

| Code | |
| --- | --- |
| `validate.scene.*` | the document (also openings that overlap on a wall, latitude and longitude without a `frame`, unknown landmarks): unknown object or verb (with "did you mean"), a clause the verb does not take, a bad value, a reserved id, a group used where one object is needed |
| `scene.layout.conflict` | relations (or pins) that cannot hold together, with the objects involved |
| `scene.collision` | two objects pass through each other (with the depth) |
| `scene.out-of-bounds`, `scene.above-ceiling` | past a wall or the ceiling (with how far) |
| `scene.support.unstable` / `scene.support.overhang` | center off the support (it would fall) / reaching past its edge |
| `scene.keep-clear`, `scene.min-gap` | closer than an aisle / `minGap` |
| `scene.yaw.conflict` | two turns given for one object |
| `scene.support.multiple`, `scene.support.cycle` | two supports, or objects standing on each other in a loop |
| `scene.relation.off-floor` | a floor-plan relation naming an object on a support (not applied) |
| `scene.path.blocked` | no way through: the bottleneck, its width and what it needs; or the place (end or via) that is shut in |
| `scene.path.opening-narrow` | an opening narrower than the agent plus its clearance on both sides |
| `scene.path.unplaced` | a path to an object that is not in the layout |
| `scene.geo.extent` (warning) | a scene with `projection: enu` reaches more than 10 km from its origin |
| `validate.scene.geo-extent` (error) | a point given by latitude and longitude that the frame cannot place: more than 10 km from a local frame's origin, too far for UTM, or past Web Mercator's edge |
| `scene.geo.projection` (info) | a large site was put on a UTM zone (named, with its EPSG code) |
| `scene.geo.zone-crossing` (warning) | a UTM site reaches into another zone (laid out on its own; the grid scale at the far edge) |
| `scene.terrain.slope`, `scene.terrain.elevation` | the ground under an object is steeper than its `slope below`, or outside its elevation limits (with the measures) |
| `scene.terrain.outside` | an object on the ground reaches off the terrain grid |
| `scene.terrain.leaning-support` | an object stands on a support that leans with the slope |
| `scene.terrain.off-ground` (warning) | `on terrain` or `align to slope` on an object that stands on a support |
| `scene.terrain.uneven` (info) | the ground rises more than 10 cm under an upright object: how far it floats and is buried |
| `scene.terrain.moved` (info) | an object moved to the nearest ground that meets its limits |
| `validate.scene.along-overflow`, `validate.scene.unknown-line`, `validate.scene.line-points` | spacing past a line's end; an unknown line; a line with both or neither of `points` and `geo` |
| `scene.tilt.conflict` | two tilts, or a tilt and `align to slope`, on one object |
| `scene.waypoint.low`, `scene.waypoint.collision` (warnings) | a leg between waypoints comes lower above the ground than `min` / passes through an object |
| `scene.path.single-file` (info) | two paths meet head-on where the way is too narrow to pass |
| `scene.path.head-on` (info) | two paths still share a run head-on: stepping aside would break the length budget, both have `comfort 0`, or the round limit ran out |
| `scene.path.detour` (info) | a path more than twice the straight line between its places |
| `scene.path.made-way` (info) | two things held apart so a blocked path gets through |
| `scene.path.meet` (warning) | two scheduled agents would touch on the way: when, where, and a later start that avoids it |

## Checking in Blender

`test/support/blender_check.py` runs a generated script in Blender and compares it with the JSON:
- every object's world box (from its mesh vertices) and turn, to 1e-4;
- every opening strip's place on its wall and every path curve's points, to 1e-4;
- where each agent stands at each corner's time (its animation evaluated at that frame), to 1e-3;
- with terrain, the ground evaluated on its own from the document's grid: every mesh vertex on it, every object on the ground standing on it at its center (to 1 cm), every path and agent on it, a leaning object's quaternion and up axis, and a pin at every landmark.

`test/support/gltf_check.py` imports each fixture's `.glb` into Blender and compares every object's world box and turn with the JSON the same way. `test/scene-gltf.test.ts` runs on every change: the Khronos validator, and each `.glb` loaded in Three.js with every object's world position, turn and box matched to the JSON.

It is run at milestones (a change to the Blender export, the end of a phase, a release), not on every change:

```bash
pip install bpy        # in a Python 3.11 environment
DGE_BLENDER_PYTHON=$(which python) npx vitest run test/scene-export.test.ts
DGE_BLENDER_PYTHON=$(which python) npm run docs:scene-renders   # the README renders
```

## Limits (phase 1)

- Objects turn about the vertical axis; on terrain they can also lean with the slope. Footprints are oriented rectangles, and an object's height is an interval; a leaning object is checked with its upright footprint and the height range of its leaning box.
- Floor-plan relations apply between objects on the floor. Objects on a support are placed with `at`.
- Beside relations snap the reference's side to the nearest world axis. A turned object is separated and walled by its world-axis bounding box (conservative); interpenetration is still tested on the turned shape.
- The solver finds a layout that satisfies the relations, not one that is comfortable. Say what matters (`keep clear` for room to pull out a chair).
