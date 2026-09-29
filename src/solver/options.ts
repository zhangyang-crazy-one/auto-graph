/** Extracted from solve.ts — behavior-preserving #77 split. */

import type {
	DeliverabilityMode,
	PagePolicyOption,
	RemediationPolicy,
} from "../ir/diagram.js";
import type { Insets, Point, PreviousLayout } from "../ir/geometry.js";
import type { RouteKind } from "../routing/index.js";
import type { TextMeasurer } from "../text/types.js";

/**
 * `auto` picks `global` for swimlane diagrams, groups, long flows and
 * solves given a `previousLayout` (unless geometry is pinned) and `dagre`
 * otherwise.
 */
export type InitialLayoutMode = "dagre" | "positions" | "global" | "auto";

export interface SolveDiagramOptions {
	/** Selects the seed coordinates before constraints, routing, and export. */
	initialLayout?: InitialLayoutMode;
	/** When true, use recursive bottom-up layout for container groups (Issue #54, 方案 A). */
	recursiveLayout?: boolean;
	/**
	 * Global layout only: fold flows that run much longer than
	 * `targetAspectRatio` (default 1.6) into bands (default true).
	 */
	foldLayout?: boolean;
	/**
	 * The previous solved version of this diagram (node boxes and edge
	 * routes), e.g. `previousLayoutOf(diagram)` or read back from the
	 * geometry export with `previousLayoutFromGeometry`. The global layout
	 * keeps the relative order of surviving nodes and edges unless changing
	 * it removes more crossings than it reorders, so a small edit stays a
	 * small change in the picture. `auto` layout picks `global` when set.
	 */
	previousLayout?: PreviousLayout;
	/**
	 * With `previousLayout`: how many edge crossings keeping one pair of
	 * surviving nodes in their previous order is worth (default 1). Raise it
	 * to keep more of the previous picture; 0 only seeds from it.
	 */
	stabilityWeight?: number;
	routeKind?: RouteKind;
	obstacleMargin?: number | Insets;
	/** When true, compute quality score after solving (Issue #54, 方案 E). */
	qualityScore?: boolean;
	/** Extra horizontal/vertical clearance reserved around nodes for edge corridors. */
	routingGutter?: number;
	overlapSpacing?: number;
	minLaneGutter?: number;
	/**
	 * Expand node sizes to fit Pretext-measured labels (#84 §A).
	 * Defaults to true when `deliverabilityMode` is set; set `false` to opt out.
	 */
	prefitLabelSize?: boolean;
	minSiblingGap?: number;
	distributeContainedChildren?: boolean | "spread";
	/** When "spread", distribute children within non-contract swimlane
	 * lanes (Issue #60). Opt-in: no redistribution occurs unless explicitly set. */
	distributeSwimlaneChildren?: boolean | "spread";
	pageBounds?: { width: number; height: number };
	maxStackDepth?: number;
	preferredAspectRatio?: number;
	/** Target aspect ratio (width/height). When bounds exceed
	 * target*3, nodes are rewrapped (Issue #60). */
	targetAspectRatio?: number;
	/** Max nodes per row for TB/BT horizontal-rewrap (Issue #60). */
	maxRowDepth?: number;
	portShifting?: PortShiftingOptions;
	cjkFontFamily?: string | false;
	/**
	 * @internal Routes the global layout computed (edge id → points). Used
	 * for every edge whose route is still valid when edges are coordinated.
	 */
	layeredRoutes?: ReadonlyMap<string, readonly Point[]>;
	minCjkFontSize?: number | false;
	textMeasurer?: TextMeasurer;
	/** When true, promote deliverability-breaking diagnostics to errors. */
	strict?: boolean;
	/** Dense deliverability gate. `strict` is equivalent to `strict: true`; `degraded-ok` preserves advisory degraded output. */
	deliverabilityMode?: DeliverabilityMode;
	/** Controls which structured remediation plans are suggested or executed. Execution is staged by later remediation phases. */
	remediationPolicy?: RemediationPolicy;
	/** Maximum greedy rerouting iterations per edge (default 5). */
	maxRoutingAttempts?: number;
	/** Edge label placement mode: "beside" offsets away from the edge, "on-path" (default) places at the midpoint. */
	labelPlacement?: "beside" | "on-path";
	/** Pixels to offset edge labels from the edge path when labelPlacement is "beside". */
	labelOffset?: number;
	/** Pixel tolerance for route/text clearance diagnostics (default 2). */
	textIntersectionTolerance?: number;
	/** Use tighter text boxes for routing/clearance without changing rendered annotations. */
	compactTextObstacles?: boolean | "labels-only";
	/** Re-route edges against actual edge labels after first placement. */
	edgeLabelRerouting?: boolean | { maxIterations?: number };
	/** Add extra text-surface routing vertices when supported by the router. */
	textObstacleVertices?: boolean;
	/** Preserve authored swimlane/lane geometry when present. */
	fixedSwimlaneGeometry?: boolean | "diagnose-overflow";
	/** Grow or diagnose nodes whose sides cannot fit requested anchors. */
	anchorCapacity?: boolean | { minSpacing?: number; grow?: boolean };
	/** Dense dependency rail routing policy. */
	railRouting?: false | "auto" | "dependency";
	/**
	 * Page-level dense routing policy. Explicit concrete values override
	 * heuristic classification; `"auto"` classifies from diagram structure.
	 */
	pagePolicy?: PagePolicyOption;
	/** Mark congested edge labels as external-callout-required instead of silently accepting local collisions. */
	externalLabels?: boolean | { edgeLabels?: boolean };
	/** Corridor expansion margin for corner-graph prefilter.
	 * - number: fixed px margin
	 * - "auto" (default): max(200, contentDiagonal * 0.3)
	 * Larger margins include more obstacles in the local routing window,
	 * improving path quality on dense diagrams at the cost of more vertices. */
	corridorMargin?: number | "auto";
	/** Maximum corner-graph vertices before falling back.
	 * - number: caller-specified cap
	 * - "auto" or undefined: scale with corridor margin and obstacle count */
	maxCorners?: number | "auto";
	/** Maximum grid A* nodes before falling back.
	 * - number: caller-specified cap
	 * - "auto" or undefined: scale with corridor margin and obstacle count */
	maxNodes?: number | "auto";
	/** Route-length / direct-distance ratio above which a backtracking
	 * warning is emitted (default 20). */
	maxBacktrackingRatio?: number;
	/**
	 * Maximum accepted routeLength/direct among clearance-feasible routes (#76).
	 * Dense deliverable pages typically use 3; `degraded-ok` may omit or raise.
	 */
	maxDetourRatio?: number;
	/** Attach-point tournament size per preferred side (default 3, max 5). */
	maxAttachPointsPerSide?: number;
	/**
	 * Spread collinear, overlapping interior segments of different edges into
	 * evenly spaced parallel tracks after routing (default on for orthogonal
	 * route kinds). `false` disables; `spacing` sets the track gap (default 12).
	 */
	edgeSeparation?: boolean | { spacing?: number };
	/**
	 * RSOP (#86/#88) orthogonal nudge pitch between parallel channel tracks.
	 * Also used as soft-text micro-clear pitch. Default 10.
	 */
	idealNudgingDistance?: number;
	/**
	 * With `short-orthogonal-jumps`, also run the greedy Left-Edge channel
	 * track assignment + nudge after routing (#88). Off by default: edge
	 * separation (`edgeSeparation`) already spreads parallel segments for
	 * every orthogonal route kind, before labels are placed.
	 */
	rsopChannelNudge?: boolean;
}

export interface PortShiftingOptions {
	enabled?: boolean;
	spacing?: number;
}

export function resolveRemediationPolicy(
	policy: RemediationPolicy | undefined,
): Required<RemediationPolicy> {
	return {
		externalLabels: policy?.externalLabels ?? "suggest",
		routeRails: policy?.routeRails ?? "suggest",
		growFixedGeometry: policy?.growFixedGeometry ?? "suggest",
		pageSplit: policy?.pageSplit ?? "suggest",
	};
}
