#!/usr/bin/env node

import { runPersonalInfoAdapterCli } from "./index.js";

const result = await runPersonalInfoAdapterCli(process.argv.slice(2));

process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.exitCode;
