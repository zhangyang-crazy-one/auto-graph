"""Open a scene's .usda with the USD library (pip install usd-core) and
compare it with the dge-scene JSON: the layer must open with no errors and
pass every USD validator (UsdValidation); the stage must be z-up in metres; every
object (found by its `userProperties:dge_id`) must have the document's
world transform (translation to 1e-9, rotation to 1e-9) and world box
(from its `box` mesh, to 1e-4 plus single precision's relative 2.5e-7),
or with its asset variant selected, the referenced asset loaded.
Every path's agent must be at each corner at the path's time. Prints one
JSON line.

    python usd_check.py scene.usda scene.json
"""
import json
import sys

from pxr import Gf, Usd, UsdGeom, UsdValidation

usda, document = sys.argv[1], sys.argv[2]
with open(document, encoding="utf-8") as handle:
    data = json.load(handle)

problems = []
stage = Usd.Stage.Open(usda)
if UsdGeom.GetStageUpAxis(stage) != UsdGeom.Tokens.z:
    problems.append("upAxis is not Z")
if UsdGeom.GetStageMetersPerUnit(stage) != 1:
    problems.append("metersPerUnit is not 1")

validators = UsdValidation.ValidationRegistry().GetOrLoadAllValidators()
for error in UsdValidation.ValidationContext(validators).Validate(stage):
    problems.append("validation: %s %s" % (error.GetName(), error.GetMessage()[:200]))


def close(a, b, eps=1e-4):
    return abs(a - b) <= eps + 2.5e-7 * max(abs(a), abs(b))


by_id = {}
for prim in stage.Traverse():
    attr = prim.GetAttribute("userProperties:dge_id")
    if attr and attr.HasValue():
        by_id[attr.Get()] = prim

cache = UsdGeom.XformCache()
for item in data["objects"]:
    prim = by_id.get(item["id"])
    if prim is None:
        problems.append(item["id"] + ": missing")
        continue
    world = cache.GetLocalToWorldTransform(prim)
    at = world.ExtractTranslation()
    if any(abs(at[k] - item["position"][k]) > 1e-9 for k in range(3)):
        problems.append("%s: at %s, JSON %s" % (item["id"], tuple(at), item["position"]))
    qx, qy, qz, qw = item["quaternion"]
    turn = world.ExtractRotationQuat()
    want = Gf.Quatd(qw, qx, qy, qz).GetNormalized()
    dot = turn.GetReal() * want.GetReal() + Gf.Dot(turn.GetImaginary(), want.GetImaginary())
    if abs(abs(dot) - 1) > 1e-9:
        problems.append("%s: rotation %s, JSON %s" % (item["id"], turn, item["quaternion"]))
    if prim.GetVariantSets().GetVariantSelection("geometry") == "asset":
        # The asset variant: the reference must have brought the asset in.
        asset = prim.GetChild("asset")
        if not asset or not asset.GetChildren():
            problems.append(item["id"] + ": asset not loaded")
        continue
    box = UsdGeom.Mesh(prim.GetChild("box"))
    if not box:
        problems.append(item["id"] + ": no box mesh")
        continue
    to_world = cache.GetLocalToWorldTransform(box.GetPrim())
    points = [to_world.Transform(Gf.Vec3d(p)) for p in box.GetPointsAttr().Get()]
    for k in range(3):
        low = min(p[k] for p in points)
        high = max(p[k] for p in points)
        if not close(low, item["aabb"]["min"][k]) or not close(high, item["aabb"]["max"][k]):
            problems.append("%s: axis %d spans %.6f..%.6f, JSON %s..%s" % (
                item["id"], k, low, high, item["aabb"]["min"][k], item["aabb"]["max"][k]))

agents = 0
origin = stage.GetRootLayer().customLayerData.get("dge_time_origin")
for prim in stage.Traverse():
    path_attr = prim.GetAttribute("userProperties:dge_path")
    agent_attr = prim.GetAttribute("userProperties:dge_agent")
    if not (path_attr and agent_attr and agent_attr.HasValue()):
        continue
    path = next(p for p in data["paths"] if p["id"] == path_attr.Get())
    agents += 1
    translate = UsdGeom.Xformable(prim)
    for corner, time in zip(path["points"], path["times"]):
        code = (time - origin) * stage.GetTimeCodesPerSecond()
        at = translate.ComputeLocalToWorldTransform(Usd.TimeCode(code)).ExtractTranslation()
        if abs(at[0] - corner[0]) > 1e-3 or abs(at[1] - corner[1]) > 1e-3:
            problems.append("%s: at %s at t=%s, corner %s" % (path["id"], tuple(at), time, corner))

print(json.dumps({"objects": len(by_id), "agents": agents, "problems": problems[:20]}))
