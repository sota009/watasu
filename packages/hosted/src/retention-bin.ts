#!/usr/bin/env node
import {
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

const result = await runHostedPostgresRetentionJobFromEnv({
  dryRun: args.dryRun,
  env: process.env,
  now: () => new Date()
});

process.stdout.write(`${JSON.stringify(result)}\n`);
