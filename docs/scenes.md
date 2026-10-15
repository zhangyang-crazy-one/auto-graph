# 3D scenes

[中文](./scenes.zh-CN.md)

A scene document describes a room, the objects in it and how they relate. auto-graph solves where every object stands and which way it faces, then checks the result. It is plain math with no 3D application in the loop, so an agent gets exact numbers it can hand to Blender, a game engine or a robot planner.

Phase 1 covers rooms: a floor plan plus stacking (2.5D), with objects turning about the vertical axis only. Geographic anchoring (WGS84 → local ENU), terrain and trajectories are planned in #120–#122 and the follow-up issues.

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

## Output

`renderSceneDsl(source, { format })`, or `agh --input room.yaml --format …`:

- **`scene-json`** (default) is the `dge-scene` v1 document, described by [`schema/dge-scene.v1.schema.json`](../schema/dge-scene.v1.schema.json). Numbers are rounded to 4 decimals. Per object it gives:
  - `position`: the footprint center and the bottom height `[x, y, z]`;
  - `yaw` and the same turn as a `quaternion` `[x, y, z, w]`;
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
- **`svg`** is a plan view for checking by eye:
  - north up, on a 0.5 m grid;
  - a triangle on each front;
  - stacked objects tinted by level;
  - failed objects outlined in red, with the diagnostics listed underneath.

The CLI writes the output even when the scene is invalid (`valid: false`, exit code 1), so the problem can be seen. A document that does not validate writes nothing. Diagram-only options such as `--page` are rejected.

## Diagnostics

| Code | |
| --- | --- |
| `validate.scene.*` | the document (also openings that overlap on a wall): unknown object or verb (with "did you mean"), a clause the verb does not take, a bad value, a reserved id, a group used where one object is needed |
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
| `scene.path.single-file` (info) | two paths meet head-on where the way is too narrow to pass |
| `scene.path.head-on` (info) | two paths still share a run head-on: stepping aside would break the length budget, both have `comfort 0`, or the round limit ran out |
| `scene.path.detour` (info) | a path more than twice the straight line between its places |
| `scene.path.made-way` (info) | two things held apart so a blocked path gets through |
| `scene.path.meet` (warning) | two scheduled agents would touch on the way: when, where, and a later start that avoids it |

## Checking in Blender

`test/support/blender_check.py` runs a generated script in Blender and compares it with the JSON:
- every object's world box (from its mesh vertices) and turn, to 1e-4;
- every opening strip's place on its wall and every path curve's points, to 1e-4;
- where each agent stands at each corner's time (its animation evaluated at that frame), to 1e-3.

It is run at milestones (a change to the Blender export, the end of a phase, a release), not on every change:

```bash
pip install bpy        # in a Python 3.11 environment
DGE_BLENDER_PYTHON=$(which python) npx vitest run test/scene-export.test.ts
DGE_BLENDER_PYTHON=$(which python) npm run docs:scene-renders   # the README renders
```

## Limits (phase 1)

- Objects turn about the vertical axis only. Footprints are oriented rectangles, and an object's height is an interval.
- Floor-plan relations apply between objects on the floor. Objects on a support are placed with `at`.
- Beside relations snap the reference's side to the nearest world axis. A turned object is separated and walled by its world-axis bounding box (conservative); interpenetration is still tested on the turned shape.
- The solver finds a layout that satisfies the relations, not one that is comfortable. Say what matters (`keep clear` for room to pull out a chair).
