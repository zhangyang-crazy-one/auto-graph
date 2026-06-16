import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		globals: false,
		// Run test files serially. The Pretext native text-measurer races
		// across concurrent forks on some CI hosts (ubuntu), producing
		// non-deterministic label widths that flip overlap/clearance
		// assertions. Serial execution avoids the cross-file contention.
		fileParallelism: false,
		include: ["test/**/*.test.ts"],
		coverage: {
			reporter: ["text", "json"],
			reportsDirectory: "coverage",
		},
	},
});
