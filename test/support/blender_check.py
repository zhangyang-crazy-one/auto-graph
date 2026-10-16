"""Run a generated scene script in Blender and compare what it built with
the dge-scene JSON: every object's world bounding box (from its mesh
vertices) and rotation must match to 1e-4 (z rotation, or for an object
leaning with the slope its quaternion and up axis); every opening strip
must sit on its wall; every path curve must run through the path's points
in order; and every agent must stand on each corner at the time the JSON
gives (its animation evaluated at that frame, which must lie in the
scene's frame range), to 1e-3.

With terrain, the ground is evaluated here on its own (bilinear in the
document's grid): every terrain mesh vertex must lie on it, every object
on the ground must stand on it at its center to 1 cm, every path point and
agent corner must be on it, and every landmark must have its pin. Prints
one JSON line.

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

terrain = data.get("terrain")


def ground(x, y):
    ox, oy = terrain["origin"]
    dx, dy = terrain["spacing"]
    rows = terrain["heights"]
    i = max(0, min(len(rows[0]) - 2, math.floor((x - ox) / dx)))
    j = max(0, min(len(rows) - 2, math.floor((y - oy) / dy)))
    u, v = (x - ox) / dx - i, (y - oy) / dy - j
    a, b = rows[j][i], rows[j][i + 1]
    c, d = rows[j + 1][i], rows[j + 1][i + 1]
    return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v - terrain["base"]


problems = []
grounded = 0
if terrain is not None:
    mesh = bpy.data.objects.get("terrain")
    if mesh is None:
        problems.append("terrain: missing")
    else:
        worst = max(abs(v.co.z - ground(v.co.x, v.co.y)) for v in mesh.data.vertices)
        if worst > 1e-4:
            problems.append(f"terrain: a mesh vertex is {worst} m off the ground")
for landmark in data.get("landmarks", []):
    pin = bpy.data.objects.get("landmark." + landmark["id"])
    x, y = landmark["position"]
    if pin is None or abs(pin.location.x - x) > 1e-4 or abs(pin.location.y - y) > 1e-4:
        problems.append(f"landmark {landmark['id']}: no pin at {x},{y}")
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
    if item.get("up"):
        q = obj.matrix_world.to_quaternion()
        want = item["quaternion"]
        dot = abs(q.x * want[0] + q.y * want[1] + q.z * want[2] + q.w * want[3])
        up = obj.matrix_world.to_3x3() @ Vector((0.0, 0.0, 1.0))
        if dot < 1 - 1e-8 or (up - Vector(item["up"])).length > 1e-4:
            problems.append(f"{item['id']}: rotation {tuple(q)} / up {tuple(up)} != {want} / {item['up']}")
    else:
        yaw = math.degrees(obj.rotation_euler[2])
        if abs((yaw - item["yaw"] + 180) % 360 - 180) > 1e-4:
            problems.append(f"{item['id']}: yaw {yaw} != {item['yaw']}")
    if terrain is not None and not item.get("supportedBy"):
        grounded += 1
        x, y, z = obj.matrix_world.translation
        if abs(z - ground(x, y)) > 0.01:
            problems.append(f"{item['id']}: stands at z {z}, the ground is at {ground(x, y)}")

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

scene = bpy.context.scene
origin = float(scene.get("dge_time_origin", 0.0))
rate = float(scene.get("dge_fps", scene.render.fps))
corners = 0
for path in data.get("paths", []):
    line = bpy.data.objects.get("path." + path["id"])
    if line is None:
        problems.append(f"path {path['id']}: missing")
        continue
    built = [tuple(point.co)[:3] for point in line.data.splines[0].points]
    want = [tuple(point[:2]) for point in path["points"]]
    # Every corner on the curve, in order (on terrain, points between them
    # follow the ground).
    at = 0
    for corner in want:
        while at < len(built) and (abs(built[at][0] - corner[0]) > 1e-4 or abs(built[at][1] - corner[1]) > 1e-4):
            at += 1
        if at == len(built):
            problems.append(f"path {path['id']}: corner {corner} is not on its curve")
            break
    if terrain is not None:
        lift = line.data.bevel_depth / 2
        worst = max(abs(z - lift - ground(x, y)) for x, y, z in built)
        if worst > 1e-3:
            problems.append(f"path {path['id']}: the curve is {worst} m off the ground")
    body = bpy.data.objects.get("agent." + path["id"])
    if body is None:
        problems.append(f"agent {path['id']}: missing")
        continue
    for (x, y, _), t in zip(path["points"], path["times"]):
        corners += 1
        # Evaluate the animation at that moment (whole frame + subframe),
        # as Blender plays it.
        frame = (t - origin) * rate
        if frame < scene.frame_start - 1e-6 or frame > scene.frame_end + 1e-6:
            problems.append(f"agent {path['id']}: {t} s is frame {frame}, outside {scene.frame_start}..{scene.frame_end}")
        scene.frame_set(int(math.floor(frame)), subframe=frame - math.floor(frame))
        at = tuple(body.matrix_world.translation)
        if abs(at[0] - x) > 1e-3 or abs(at[1] - y) > 1e-3:
            problems.append(f"agent {path['id']}: at {at[:2]} at {t} s, not {x},{y}")
        floor = ground(x, y) if terrain is not None else 0.0
        if abs(at[2] - floor) > 1e-3:
            problems.append(f"agent {path['id']}: at height {at[2]} at {t} s, the ground is at {floor}")

print(json.dumps({
    "objects": len(data["objects"]),
    "openings": len(data.get("openings", [])),
    "paths": len(data.get("paths", [])),
    "corners": corners,
    "grounded": grounded,
    "problems": problems,
}))
