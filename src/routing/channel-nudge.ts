import type { CoordinatedEdge } from "../ir/elements.js";
import type { Box } from "../ir/geometry.js";
import {
	type AssignChannelTracksResult,
	applyChannelTrackAssignments,
	assignChannelTracks,
} from "./channel-tracks.js";

export interface NudgeOrthogonalRoutesOptions {
	idealNudgingDistance?: number;
	maxTracks?: number;
	hardObstacles?: readonly Box[];
}

export interface NudgeOrthogonalRoutesResult {
	edges: CoordinatedEdge[];
	tracks: AssignChannelTracksResult;
}

/**
 * RSOP Phase-3/4: channel track assignment + greedy orthogonal nudge (#88/#92).
 * Reorders overlapping gutter spans onto distinct tracks without entering
 * hard node boxes. v1 is Left-Edge / interval coloring only — MLCM LP is
 * explicitly deferred.
 */
export function nudgeOrthogonalRoutes(
	edges: readonly CoordinatedEdge[],
	options: NudgeOrthogonalRoutesOptions = {},
): NudgeOrthogonalRoutesResult {
	const tracks = assignChannelTracks(edges, {
		idealNudgingDistance: options.idealNudgingDistance ?? 10,
		...(options.maxTracks === undefined
			? {}
			: { maxTracks: options.maxTracks }),
		...(options.hardObstacles === undefined
			? {}
			: { hardObstacles: options.hardObstacles }),
	});
	const nudged = applyChannelTrackAssignments(
		edges,
		tracks.assignments,
		options.hardObstacles ?? [],
	);
	return { edges: nudged, tracks };
}
