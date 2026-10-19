"""Import a scene's .usda into an empty Blender scene (Blender's own USD
importer) and compare it with the dge-scene JSON: every object (an empty
carrying the `dge_id` custom property) must have the document's location
and rotation, and its `box` child mesh the document's world box, to 1e-4
plus single precision's relative 2.5e-7. Prints one JSON line.

    python usd_blender_check.py scene.usda scene.json   (python with bpy)
"""
import json
import os
import sys

import bpy
from mathutils import Quaternion

usda, document = sys.argv[1], sys.argv[2]
with open(document, encoding="utf-8") as handle:
    data = json.load(handle)

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.wm.usd_import(filepath=usda)


def close(a, b, eps=1e-4):
    return abs(a - b) <= eps + 2.5e-7 * max(abs(a), abs(b))


problems = []
by_id = {obj["dge_id"]: obj for obj in bpy.data.objects if "dge_id" in obj}
for item in data["objects"]:
    obj = by_id.get(item["id"])
    if obj is None:
        problems.append(item["id"] + ": missing")
        continue
    world = obj.matrix_world
    if not all(close(world.translation[k], item["position"][k]) for k in range(3)):
        problems.append("%s: at %s, JSON %s" % (item["id"], tuple(world.translation), item["position"]))
    qx, qy, qz, qw = item["quaternion"]
    if abs(abs(world.to_quaternion().dot(Quaternion((qw, qx, qy, qz)).normalized())) - 1) > 1e-5:
        problems.append("%s: rotation %s, JSON %s" % (item["id"], tuple(world.to_quaternion()), item["quaternion"]))
    box = next((child for child in obj.children if child.name.split(".")[0] == "box"), None)
    if box is None:
        problems.append(item["id"] + ": no box")
        continue
    corners = [box.matrix_world @ v.co for v in box.data.vertices]
    for k in range(3):
        low = min(c[k] for c in corners)
        high = max(c[k] for c in corners)
        if not close(low, item["aabb"]["min"][k]) or not close(high, item["aabb"]["max"][k]):
            problems.append("%s: axis %d spans %.6f..%.6f, JSON %s..%s" % (
                item["id"], k, low, high, item["aabb"]["min"][k], item["aabb"]["max"][k]))

print(json.dumps({"objects": len(by_id), "problems": problems[:20]}))
sys.stdout.flush()
# bpy can crash while tearing down after a factory reset; the result is out.
os._exit(0)
