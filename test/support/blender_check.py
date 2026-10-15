"""Run a generated scene script in Blender and compare what it built with
the dge-scene JSON: every object's world bounding box (from its mesh
vertices) and z rotation must match to 1e-4; every opening strip must sit
on its wall; every path curve must run through the path's points; and
every agent must stand on each corner at the time the JSON gives (its
animation evaluated at that frame), to 1e-3. Prints one JSON line.

    python blender_check.py scene.py scene.json   (python with the bpy module)
"""
import json
import math
import sys

import bpy
from mathutils import Vector

script, document = sys.argv[1], sys.argv[2]
sys.argv = [script]
with open(script, encoding="utf-8") as handle:
    exec(compile(handle.read(), script, "exec"), {"__name__": "__main__"})

with open(document, encoding="utf-8") as handle:
    data = json.load(handle)

problems = []
for item in data["objects"]:
    obj = bpy.data.objects.get(item["id"])
    if obj is None:
        problems.append(f"{item['id']}: missing")
        continue
    bpy.context.view_layer.update()
    corners = [obj.matrix_world @ Vector(v.co) for v in obj.data.vertices]
    low = [min(c[k] for c in corners) for k in range(3)]
    high = [max(c[k] for c in corners) for k in range(3)]
    for k in range(3):
        if abs(low[k] - item["aabb"]["min"][k]) > 1e-4 or abs(high[k] - item["aabb"]["max"][k]) > 1e-4:
            problems.append(f"{item['id']}: box {low}..{high} != {item['aabb']}")
            break
    yaw = math.degrees(obj.rotation_euler[2])
    if abs((yaw - item["yaw"] + 180) % 360 - 180) > 1e-4:
        problems.append(f"{item['id']}: yaw {yaw} != {item['yaw']}")

width, depth = data["bounds"]["width"], data["bounds"]["depth"]
for opening in data.get("openings", []):
    obj = bpy.data.objects.get("opening." + opening["id"])
    if obj is None:
        problems.append(f"opening {opening['id']}: missing")
        continue
    x, y, _ = obj.location
    wall, at = opening["wall"], opening["at"]
    want = {
        "south": (at, 0.0),
        "north": (at, depth),
        "west": (0.0, at),
        "east": (width, at),
    }[wall]
    if abs(x - want[0]) > 1e-4 or abs(y - want[1]) > 1e-4:
        problems.append(f"opening {opening['id']}: at {x},{y} != {want}")

FPS = bpy.context.scene.render.fps
corners = 0
for path in data.get("paths", []):
    line = bpy.data.objects.get("path." + path["id"])
    if line is None:
        problems.append(f"path {path['id']}: missing")
        continue
    built = [tuple(point.co)[:2] for point in line.data.splines[0].points]
    want = [tuple(point[:2]) for point in path["points"]]
    if len(built) != len(want) or any(
        abs(a[0] - b[0]) > 1e-4 or abs(a[1] - b[1]) > 1e-4 for a, b in zip(built, want)
    ):
        problems.append(f"path {path['id']}: curve {built} != {want}")
    body = bpy.data.objects.get("agent." + path["id"])
    if body is None:
        problems.append(f"agent {path['id']}: missing")
        continue
    curves = {fc.array_index: fc for fc in body.animation_data.action.fcurves if fc.data_path == "location"}
    for (x, y, _), t in zip(path["points"], path["times"]):
        corners += 1
        frame = t * FPS
        at = (curves[0].evaluate(frame), curves[1].evaluate(frame))
        if abs(at[0] - x) > 1e-3 or abs(at[1] - y) > 1e-3:
            problems.append(f"agent {path['id']}: at {at} at {t} s, not {x},{y}")

print(json.dumps({
    "objects": len(data["objects"]),
    "openings": len(data.get("openings", [])),
    "paths": len(data.get("paths", [])),
    "corners": corners,
    "problems": problems,
}))
