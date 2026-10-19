"""Import a scene's .glb into an empty Blender scene and compare it with
the dge-scene JSON: every object (found by its `dge_id` custom property)
must have the document's world box (from its box vertices, without the
front marker) and rotation, to 1e-4 plus single precision's relative
2.5e-7, so Blender's y-up conversion gives the scene frame back. With
terrain, the terrain mesh must be there. Prints one JSON line.

    python gltf_check.py scene.glb scene.json   (python with the bpy module)
"""
import json
import os
import sys

import bpy
from mathutils import Quaternion, Vector

glb, document = sys.argv[1], sys.argv[2]
with open(document, encoding="utf-8") as handle:
    data = json.load(handle)

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=glb)


def close(a, b, eps=1e-4):
    return abs(a - b) <= eps + 2.5e-7 * max(abs(a), abs(b))


problems = []
by_id = {obj.get("dge_id"): obj for obj in bpy.data.objects if obj.get("dge_id")}
for item in data["objects"]:
    obj = by_id.get(item["id"])
    if obj is None:
        problems.append(item["id"] + ": missing")
        continue
    world = obj.matrix_world
    corners = []
    for polygon in obj.data.polygons:
        material = obj.data.materials[polygon.material_index]
        if material is not None and "front" in material.name:
            continue
        corners.extend(world @ obj.data.vertices[v].co for v in polygon.vertices)
    for k in range(3):
        low = min(c[k] for c in corners)
        high = max(c[k] for c in corners)
        if not close(low, item["aabb"]["min"][k]) or not close(high, item["aabb"]["max"][k]):
            problems.append("%s: axis %d spans %.6f..%.6f, JSON %s..%s" % (
                item["id"], k, low, high, item["aabb"]["min"][k], item["aabb"]["max"][k]))
    qx, qy, qz, qw = item["quaternion"]
    turn = world.to_quaternion()
    if abs(abs(turn.dot(Quaternion((qw, qx, qy, qz)).normalized())) - 1) > 1e-5:
        problems.append("%s: rotation %s, JSON %s" % (item["id"], tuple(turn), item["quaternion"]))
    if not all(close(world.translation[k], item["position"][k]) for k in range(3)):
        problems.append("%s: at %s, JSON %s" % (item["id"], tuple(world.translation), item["position"]))

if data.get("terrain") and bpy.data.objects.get("terrain") is None:
    problems.append("terrain: missing")

print(json.dumps({"objects": len(by_id), "problems": problems[:20]}))
sys.stdout.flush()
# bpy can crash while tearing down after a factory reset; the result is out.
os._exit(0)
