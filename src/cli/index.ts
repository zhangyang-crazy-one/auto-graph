#!/usr/bin/env node

import { runCli } from "./run.js";

void runCli(process.argv.slice(2))
	.then((exitCode) => {
		process.exitCode = exitCode;
	})
	.catch((error: unknown) => {
		process.stderr.write(
			error instanceof Error ? error.message : String(error),
		);
		process.stderr.write("\n");
		process.exitCode = 1;
	});
