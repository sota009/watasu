#!/usr/bin/env node
import { runHostedPostgresRetentionJobFromEnv } from "./index.js";

const result = await runHostedPostgresRetentionJobFromEnv({
  env: process.env,
  now: () => new Date()
});

process.stdout.write(`${JSON.stringify(result)}\n`);
