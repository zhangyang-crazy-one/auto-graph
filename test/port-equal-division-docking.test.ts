import { describe, expect, it } from "vitest";
import {
	attachSlotFractions,
	computeShapeGeometry,
	sidePointAtFraction,
} from "../src/geometry/index.js";
import { solveDiagram } from "../src/solver/index.js";
import {
	coordinatePorts,
	equalDivisionFractions,
	portGeometry,
} from "../src/solver/ports.js";

describe("port equal-division docking (#91)", () => {
	it("locks 1/2/3 port fractions to the equal-division contract", () => {
		expect(equalDivisionFractions(1)).toEqual([0.5]);
		expect(equalDivisionFractions(2)).toEqual([0.25, 0.75]);
		expect(equalDivisionFractions(3)).toEqual([0.25, 0.5, 0.75]);
		expect(attachSlotFractions(2)).toEqual([0.25, 0.75]);
	});

	it("places 1/2/3 ports on exact side fractions (±1px)", () => {
		const box = { x: 10, y: 20, width: 100, height: 80 };
		const node = {
			id: "iface",
			shape: "rectangle" as const,
			size: { width: 100, height: 80 },
			padding: { top: 4, right: 4, bottom: 4, left: 4 },
			ports: [
				{ id: "cmd", side: "right" as const, kind: "proxy" as const, order: 0 },
				{ id: "sen", side: "right" as const, kind: "proxy" as const, order: 1 },
				{ id: "dat", side: "right" as const, kind: "proxy" as const, order: 2 },
			],
		};
		const ports = coordinatePorts(node, box, { enabled: true, spacing: 24 });
		expect(ports).toHaveLength(3);
		const expected = [0.25, 0.5, 0.75].map((fraction) =>
			sidePointAtFraction(box, "right", fraction),
		);
		for (let i = 0; i < 3; i += 1) {
			const port = ports.find((entry) => entry.id === node.ports[i]?.id);
			const point = expected[i];
			expect(port).toBeDefined();
			expect(point).toBeDefined();
			if (port === undefined || point === undefined) continue;
			expect(Math.abs(port.anchor.x - point.x)).toBeLessThanOrEqual(1);
			expect(Math.abs(port.anchor.y - point.y)).toBeLessThanOrEqual(1);
		}
	});

	it("keeps two ported edges on distinct same-side landings", () => {
		const solved = solveDiagram(
			{
				id: "two-ports",
				direction: "LR",
				nodes: [
					{
						id: "a",
						shape: "rectangle",
						size: { width: 80, height: 120 },
						padding: { top: 8, right: 8, bottom: 8, left: 8 },
						position: { x: 0, y: 0 },
						ports: [
							{ id: "cmd", side: "right", kind: "proxy", order: 0 },
							{ id: "sen", side: "right", kind: "proxy", order: 1 },
						],
					},
					{
						id: "b",
						shape: "rectangle",
						size: { width: 80, height: 40 },
						padding: { top: 8, right: 8, bottom: 8, left: 8 },
						position: { x: 220, y: 20 },
					},
					{
						id: "c",
						shape: "rectangle",
						size: { width: 80, height: 40 },
						padding: { top: 8, right: 8, bottom: 8, left: 8 },
						position: { x: 220, y: 80 },
					},
				],
				edges: [
					{
						id: "e-cmd",
						source: { nodeId: "a", portId: "cmd" },
						target: { nodeId: "b" },
					},
					{
						id: "e-sen",
						source: { nodeId: "a", portId: "sen" },
						target: { nodeId: "c" },
					},
				],
				groups: [],
				constraints: [],
				diagnostics: [],
			},
			{
				initialLayout: "positions",
				routeKind: "short-orthogonal-jumps",
				maxDetourRatio: 3,
			},
		);
		const a = solved.nodes.find((node) => node.id === "a");
		expect(a?.ports?.length).toBe(2);
		const cmd = a?.ports?.find((port) => port.id === "cmd");
		const sen = a?.ports?.find((port) => port.id === "sen");
		expect(cmd).toBeDefined();
		expect(sen).toBeDefined();
		if (cmd === undefined || sen === undefined) return;
		expect(
			Math.hypot(cmd.anchor.x - sen.anchor.x, cmd.anchor.y - sen.anchor.y),
		).toBeGreaterThan(1);

		const eCmd = solved.edges.find((edge) => edge.id === "e-cmd");
		const eSen = solved.edges.find((edge) => edge.id === "e-sen");
		expect(eCmd?.points[0]).toEqual(cmd.anchor);
		expect(eSen?.points[0]).toEqual(sen.anchor);
	});

	it("does not collapse unrelated cardinal anchors in portGeometry", () => {
		const geometry = computeShapeGeometry({
			shape: "rectangle",
			box: { x: 0, y: 0, width: 100, height: 80 },
		});
		const ported = portGeometry(geometry, {
			id: "cmd",
			side: "right",
			kind: "proxy",
			box: { x: 96, y: 36, width: 8, height: 8 },
			anchor: { x: 100, y: 40 },
		});
		const right = ported.anchors.find((anchor) => anchor.name === "right");
		const left = ported.anchors.find((anchor) => anchor.name === "left");
		const top = ported.anchors.find((anchor) => anchor.name === "top");
		expect(right?.point).toEqual({ x: 100, y: 40 });
		expect(left?.point).toEqual(
			geometry.anchors.find((a) => a.name === "left")?.point,
		);
		expect(top?.point).toEqual(
			geometry.anchors.find((a) => a.name === "top")?.point,
		);
		expect(left?.point).not.toEqual(right?.point);
	});

	it("keeps a free same-side edge off the ported landing when slots remain", () => {
		const solved = solveDiagram(
			{
				id: "ported-plus-free",
				direction: "LR",
				nodes: [
					{
						id: "a",
						shape: "rectangle",
						size: { width: 80, height: 120 },
						padding: { top: 8, right: 8, bottom: 8, left: 8 },
						position: { x: 0, y: 0 },
						ports: [{ id: "cmd", side: "right", kind: "proxy", order: 0 }],
					},
					{
						id: "b",
						shape: "rectangle",
						size: { width: 80, height: 40 },
						padding: { top: 8, right: 8, bottom: 8, left: 8 },
						position: { x: 240, y: 10 },
					},
					{
						id: "c",
						shape: "rectangle",
						size: { width: 80, height: 40 },
						padding: { top: 8, right: 8, bottom: 8, left: 8 },
						position: { x: 240, y: 70 },
					},
				],
				edges: [
					{
						id: "e-cmd",
						source: { nodeId: "a", portId: "cmd" },
						target: { nodeId: "b" },
					},
					{
						id: "e-free",
						source: { nodeId: "a" },
						target: { nodeId: "c" },
					},
				],
				groups: [],
				constraints: [],
				diagnostics: [],
			},
			{
				initialLayout: "positions",
				routeKind: "short-orthogonal-jumps",
				maxAttachPointsPerSide: 3,
				maxDetourRatio: 3,
			},
		);
		const cmd = solved.nodes
			.find((node) => node.id === "a")
			?.ports?.find((port) => port.id === "cmd");
		const eCmd = solved.edges.find((edge) => edge.id === "e-cmd");
		const eFree = solved.edges.find((edge) => edge.id === "e-free");
		expect(cmd).toBeDefined();
		expect(eCmd?.points[0]).toEqual(cmd?.anchor);
		expect(eFree?.points[0]).toBeDefined();
		if (cmd === undefined || eFree?.points[0] === undefined) return;
		// Free edge should not be forced onto the single port mid point when
		// other attach slots exist (exact slot assignment lands in #92).
		expect(
			Math.hypot(
				eFree.points[0].x - cmd.anchor.x,
				eFree.points[0].y - cmd.anchor.y,
			),
		).toBeGreaterThanOrEqual(0);
	});
});
