#!/usr/bin/env node

import { runCli } from "./index.js";

const result = await runCli(process.argv.slice(2));

process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.exitCode;
