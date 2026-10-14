"""Run a generated scene script in Blender and compare what it built with
the dge-scene JSON: every object's world bounding box (from its mesh
vertices) and z rotation must match to 1e-4. Prints one JSON line.

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

print(json.dumps({"objects": len(data["objects"]), "problems": problems}))
