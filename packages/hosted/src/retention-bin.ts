#!/usr/bin/env node
import {
  formatHostedCommandError,
  parseHostedRetentionArgs,
  runHostedPostgresRetentionJobFromEnv
} from "./index.js";

let args;
try {
  args = parseHostedRetentionArgs(process.argv);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Invalid hosted retention arguments.");
  process.exit(1);
}

let result;
try {
  result = await runHostedPostgresRetentionJobFromEnv({
    dryRun: args.dryRun,
    env: process.env,
    now: () => new Date()
  });
} catch (error) {
  console.error(formatHostedCommandError(error, "Hosted retention command failed."));
  process.exit(1);
}

process.stdout.write(`${JSON.stringify(result)}\n`);
