/**
 * Scene IR: a room and the objects in it, described by relations, before
 * any position is solved.
 *
 * Frame: x points east, y north, z up; the origin is the room's south-west
 * floor corner, and every length is in meters (the DSL's `units` are
 * converted on the way in). Objects turn only about the vertical axis.
 */

export type ScenePath = Array<string | number>;

/** An object's front, in its own frame before it is turned. */
export type SceneAxis = "+x" | "-x" | "+y" | "-y";

export type SceneUnits = "m" | "cm" | "mm";

export type WallSide = "north" | "south" | "east" | "west";

export type CornerSide = "ne" | "nw" | "se" | "sw";

/**
 * A side of a reference object. Left and right are as seen by someone
 * standing in front of the reference and looking at it: with the default
 * front `-y`, front is south, back north, left west and right east.
 */
export type SceneSide = "front" | "back" | "left" | "right";

/** Where an object sits on top of its support. */
export type SupportSpot =
	| "center"
	| "front"
	| "back"
	| "left"
	| "right"
	| "front-left"
	| "front-right"
	| "back-left"
	| "back-right";

export interface SceneBounds {
	width: number;
	depth: number;
	/** Absent: the room has no ceiling to check against. */
	height?: number;
}

export interface SceneObject {
	id: string;
	/** Width (x), depth (y) and height (z) before the object is turned. */
	size: [number, number, number];
	front: SceneAxis;
	label?: string;
	/** Asset name an exporter may place instead of a box. */
	asset?: string;
	/** Pinned footprint center [x, y] (not for `count` groups). */
	position?: [number, number];
	/** Pinned turn in degrees, counter-clockwise seen from above. */
	yaw?: number;
	/** The `count` group this object was expanded from. */
	group?: string;
	path: ScenePath;
}

interface RelationBase {
	/** The relation string this came from. */
	path: ScenePath;
}

export type SceneRelation =
	| (RelationBase & {
			kind: "beside";
			subject: string;
			side: SceneSide;
			reference: string;
			/** Clearance between the facing sides. */
			gap?: number;
			/** Distance between the centers. */
			distance?: number;
	  })
	| (RelationBase & {
			kind: "against-wall";
			subject: string;
			wall: WallSide;
			gap: number;
	  })
	| (RelationBase & {
			kind: "corner";
			subject: string;
			corner: CornerSide;
			gap: number;
	  })
	| (RelationBase & {
			kind: "center-of";
			subject: string;
			/** `room`, or an object whose footprint center is shared. */
			reference: string;
	  })
	| (RelationBase & {
			kind: "on";
			subject: string;
			support: string;
			at: SupportSpot;
	  })
	| (RelationBase & {
			kind: "facing";
			subject: string;
			target: { object: string } | { direction: WallSide };
	  })
	| (RelationBase & {
			kind: "rotate";
			subject: string;
			/** Counter-clockwise, seen from above. */
			degrees: number;
	  })
	| (RelationBase & {
			kind: "align";
			subjects: string[];
			axis: "x" | "y";
			reference: string;
	  })
	| (RelationBase & {
			kind: "distribute";
			subjects: string[];
			along: "x" | "y" | WallSide;
			gap?: number;
	  })
	| (RelationBase & {
			kind: "grid";
			subjects: string[];
			rows: number;
			columns: number;
			gap: number;
	  })
	| (RelationBase & {
			kind: "around";
			subjects: string[];
			center: string;
			/** Center-to-center distance. */
			radius: number;
			/** Angle of the first subject, counter-clockwise from east. */
			start: number;
			/** Turn each subject to face the center (unless told otherwise). */
			faceCenter: boolean;
	  })
	| (RelationBase & {
			kind: "symmetric";
			subjects: [string, string];
			about: string;
			axis?: "x" | "y";
	  })
	| (RelationBase & {
			kind: "keep-clear";
			between: [string, string];
			clearance: number;
	  });

export type SceneRelationKind = SceneRelation["kind"];

/** A gap in a wall: where paths enter and leave the room. */
export interface SceneOpening {
	id: string;
	wall: WallSide;
	/** Center of the gap along the wall, from its west (or south) end. */
	at: number;
	width: number;
	path: ScenePath;
}

/** Something that moves: a person, a robot, a cart. */
export interface SceneAgent {
	id: string;
	/** Half its width: paths keep this far (plus `clearance`) from things. */
	radius: number;
	/** Objects lower than this are in its way; higher ones it passes under. */
	height: number;
	/** Top speed on a straight, m/s. */
	speed: number;
	/** Acceleration and braking, m/s². */
	accel: number;
	path: ScenePath;
}

/** A route an agent must be able to take. */
export interface ScenePathSpec {
	id: string;
	agent: string;
	/** An object (approached from its front if it can be) or an opening. */
	from: string;
	to: string;
	/** Places to pass on the way, in order. */
	via: string[];
	/** Extra distance kept from everything, beyond the agent's radius. */
	clearance: number;
	/** Turn only at right angles (aisles, rails) instead of any angle. */
	orthogonal: boolean;
	/**
	 * Room the path tries to keep beyond `clearance`, walking mid-aisle
	 * instead of skimming corners; 0 keeps the shortest route.
	 */
	comfort: number;
	/**
	 * When the agent sets off, in seconds. Paths given a start are checked
	 * against each other for agents meeting on the way.
	 */
	start?: number;
	path: ScenePath;
}

export interface SceneSpec {
	name: string;
	units: SceneUnits;
	bounds: SceneBounds;
	/** Smallest clearance between any two objects on the same surface. */
	minGap: number;
	/** Move objects apart where a path is blocked (default true). */
	makeWay: boolean;
	objects: SceneObject[];
	relations: SceneRelation[];
	/** `count` groups and the objects they expanded to. */
	groups: Record<string, string[]>;
	openings: SceneOpening[];
	agents: SceneAgent[];
	paths: ScenePathSpec[];
}

/** An object placed in the room. */
export interface PlacedSceneObject {
	id: string;
	/** Footprint center on the floor plan and bottom height: [x, y, z]. */
	position: [number, number, number];
	/** Degrees, counter-clockwise seen from above, in (-180, 180]. */
	yaw: number;
	/** The turn about z as a unit quaternion [x, y, z, w]. */
	quaternion: [number, number, number, number];
	size: [number, number, number];
	front: SceneAxis;
	/** The object it stands on; absent on the floor. */
	supportedBy?: string;
	/** World-axis bounding box. */
	aabb: { min: [number, number, number]; max: [number, number, number] };
	label?: string;
	asset?: string;
	group?: string;
}

export interface SceneDiagnostic {
	severity: "info" | "warning" | "error";
	code: string;
	message: string;
	/** Objects involved. */
	objects?: string[];
	/** Document path of the object or relation at fault. */
	path?: ScenePath;
	hint?: string;
	detail?: Record<string, number | string>;
}

/** A planned route: a polyline on the floor. */
export interface PlannedScenePath {
	id: string;
	agent: string;
	from: string;
	to: string;
	/** Corners from start to end, [x, y, z] (z = 0, on the floor). */
	points: [number, number, number][];
	length: number;
	/** The agent's width (twice its radius). */
	width: number;
	/** Least distance from the agent's edge to anything along the way. */
	clearance: number;
	/** When the agent sets off, seconds (0 unless the path gives a start). */
	start: number;
	/** When it reaches each point, seconds from the scene's time 0. */
	times: number[];
	/** Seconds from setting off to arriving. */
	duration: number;
}

export interface SolvedScene {
	name: string;
	bounds: SceneBounds;
	objects: PlacedSceneObject[];
	/** Gaps in the walls. */
	openings: { id: string; wall: WallSide; at: number; width: number }[];
	/** Agents that paths are planned for. */
	agents: {
		id: string;
		radius: number;
		height: number;
		speed: number;
		accel: number;
	}[];
	/** Planned routes, in declaration order (only those that were found). */
	paths: PlannedScenePath[];
	/** Objects that have no position yet, in declaration order. */
	unplaced: string[];
	/** No interpenetration, floating object, overhang past the edge or wall. */
	valid: boolean;
	diagnostics: SceneDiagnostic[];
}
