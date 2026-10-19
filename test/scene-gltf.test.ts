import validator from "gltf-validator";
import {
	AnimationMixer,
	Box3,
	type Mesh,
	type Object3D,
	Quaternion,
	Vector3,
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { describe, expect, it } from "vitest";
import {
	parseSceneDsl,
	renderSceneDsl,
	type SceneDocument,
	sceneToGlb,
	sceneToGltf,
	sceneToJson,
	solveScene,
} from "../src/index.js";
import { sceneSource } from "./support/scene-files.js";

const FIXTURES = [
	"study",
	"study-pinned",
	"study-broken",
	"meeting",
	"showroom",
	"study-paths",
	"office",
	"storeroom",
	"park",
	"hillside",
	"windfarm",
	"solar",
	"streetlights",
];

function solved(name: string) {
	const parsed = parseSceneDsl(sceneSource(name));
	if (parsed.scene === undefined) throw new Error(`${name} does not parse`);
	return solveScene(parsed.scene);
}

async function load(bytes: Uint8Array) {
	const buffer = bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength,
	) as ArrayBuffer;
	return new GLTFLoader().parseAsync(buffer, "");
}

/**
 * The node whose extras carry all of `extras` (three.js strips dots and
 * other reserved characters from node names, so look nodes up by these).
 */
function byExtra(root: Object3D, extras: Record<string, string>): Object3D {
	let found: Object3D | undefined;
	root.traverse((node) => {
		const match = Object.entries(extras).every(
			([key, value]) => node.userData[key] === value,
		);
		if (found === undefined && match) found = node;
	});
	if (found === undefined) {
		throw new Error(`no node with ${JSON.stringify(extras)}`);
	}
	return found;
}

/** A y-up three.js world point back in the z-up scene frame. */
function toScene(v: Vector3): [number, number, number] {
	return [v.x, -v.z, v.y];
}

/** A y-up three.js rotation as the same turn in the scene frame. */
function turnInScene(q: Quaternion): [number, number, number, number] {
	return [q.x, -q.z, q.y, q.w];
}

describe("glTF export", () => {
	it.each(
		FIXTURES,
	)("%s passes the Khronos glTF Validator with no issues", async (name) => {
		const scene = solved(name);
		for (const bytes of [
			sceneToGlb(scene),
			new TextEncoder().encode(sceneToGltf(scene)),
		]) {
			const report = await validator.validateBytes(bytes);
			expect(report.issues.messages).toEqual([]);
			expect(report.issues.numErrors).toBe(0);
		}
	});

	it.each(
		FIXTURES,
	)("%s opens in three.js exactly as the JSON contract places it", async (name) => {
		const scene = solved(name);
		const document = JSON.parse(sceneToJson(scene)) as SceneDocument;
		const gltf = await load(sceneToGlb(scene));
		gltf.scene.updateMatrixWorld(true);
		for (const item of document.objects) {
			const node = byExtra(gltf.scene, { dge_id: item.id });
			expect(node, item.id).toBeDefined();
			expect(node.userData).toMatchObject({
				dge_id: item.id,
				dge_front: item.front,
			});
			const position = toScene(node.getWorldPosition(new Vector3()));
			position.forEach((value, k) => {
				expect(value).toBeCloseTo(item.position[k] as number, 9);
			});
			// The world turn, back in the scene frame, is the quaternion.
			const [tx, ty, tz, tw] = turnInScene(
				node.getWorldQuaternion(new Quaternion()),
			);
			const [qx, qy, qz, qw] = item.quaternion;
			const dot = Math.abs(tx * qx + ty * qy + tz * qz + tw * qw);
			expect(dot).toBeCloseTo(Math.hypot(qx, qy, qz, qw), 6);
			// The placeholder box spans the document's world box.
			const box = node.children.find(
				(child) =>
					(child as Mesh).isMesh &&
					(child as Mesh).material !== undefined &&
					!String(((child as Mesh).material as { name: string }).name).includes(
						"front",
					),
			) as Mesh;
			const bounds = new Box3().setFromObject(box, true);
			const a = toScene(bounds.min);
			const b = toScene(bounds.max);
			for (let k = 0; k < 3; k += 1) {
				const tolerance = 1e-4 + 2.5e-7 * Math.abs(item.aabb.max[k] as number);
				expect(
					Math.abs(
						Math.min(a[k] as number, b[k] as number) -
							(item.aabb.min[k] as number),
					),
				).toBeLessThan(tolerance);
				expect(
					Math.abs(
						Math.max(a[k] as number, b[k] as number) -
							(item.aabb.max[k] as number),
					),
				).toBeLessThan(tolerance);
			}
		}
	});

	it("walks each agent through its corners at the JSON times", async () => {
		const scene = solved("study-paths");
		expect(scene.paths.length).toBeGreaterThan(0);
		const gltf = await load(sceneToGlb(scene));
		const [clip] = gltf.animations;
		expect(clip?.name).toBe("agents");
		const root = gltf.scene.children[0] as Object3D;
		const origin = root.userData.dge_time_origin as number;
		const mixer = new AnimationMixer(gltf.scene);
		mixer.clipAction(clip as NonNullable<typeof clip>).play();
		for (const path of scene.paths) {
			const agent = byExtra(gltf.scene, {
				dge_path: path.id,
				dge_agent: path.agent,
			});
			path.times.forEach((time, k) => {
				mixer.setTime(time - origin);
				gltf.scene.updateMatrixWorld(true);
				const at = toScene(agent.getWorldPosition(new Vector3()));
				const corner = path.points[k] as number[];
				expect(at[0]).toBeCloseTo(corner[0] as number, 3);
				expect(at[1]).toBeCloseTo(corner[1] as number, 3);
			});
		}
	});

	it("puts the ground under objects on terrain", async () => {
		const scene = solved("hillside");
		const gltf = await load(sceneToGlb(scene));
		const terrain = gltf.scene.getObjectByName("terrain") as Mesh;
		expect(terrain.userData.dge_terrain_subdivision).toBeGreaterThan(0);
		const bounds = new Box3().setFromObject(terrain, true);
		const heights = (scene.terrain?.heights ?? []).flat();
		const base = scene.terrain?.base ?? 0;
		expect(toScene(bounds.min)[2]).toBeCloseTo(Math.min(...heights) - base, 3);
		expect(toScene(bounds.max)[2]).toBeCloseTo(Math.max(...heights) - base, 3);
	});

	it("is byte-stable, and the .gltf carries the .glb's buffer", () => {
		const scene = solved("windfarm");
		const glb = sceneToGlb(scene);
		expect(sceneToGlb(solved("windfarm"))).toEqual(glb);
		const json = JSON.parse(sceneToGltf(scene));
		const view = new DataView(glb.buffer, glb.byteOffset);
		const jsonLength = view.getUint32(12, true);
		const embedded = JSON.parse(
			new TextDecoder().decode(glb.subarray(20, 20 + jsonLength)),
		);
		const bin = glb.subarray(28 + jsonLength);
		const uri = json.buffers[0].uri as string;
		expect(Buffer.from(uri.split(",")[1] as string, "base64")).toEqual(
			Buffer.from(bin.subarray(0, json.buffers[0].byteLength)),
		);
		expect({ ...json, buffers: undefined }).toEqual({
			...embedded,
			buffers: undefined,
		});
	});

	it("returns glb as bytes from renderSceneDsl", () => {
		const result = renderSceneDsl(sceneSource("study"), { format: "glb" });
		expect(result.content).toBeUndefined();
		expect(result.bytes?.subarray(0, 4)).toEqual(
			new TextEncoder().encode("glTF"),
		);
	});
});
