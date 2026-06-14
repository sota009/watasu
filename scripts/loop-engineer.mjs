#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { buildLoopCommandPlan } from "./workflow-helpers.mjs";

const includeAudit = process.argv.includes("--full") || process.argv.includes("--audit");
const commandPlan = buildLoopCommandPlan({ includeAudit });

console.log("watasu loop engineering gate");
console.log(`mode: ${includeAudit ? "full" : "fast"}`);
console.log("");

for (const step of commandPlan) {
  console.log(`> ${step.command}`);
  const result = spawnSync(step.command, {
    cwd: process.cwd(),
    encoding: "utf8",
    shell: true,
    stdio: "inherit"
  });

  if (result.status !== 0) {
    console.error("");
    console.error(`Loop stopped at ${step.label}. Fix the cause, then rerun the same command.`);
    process.exit(result.status ?? 1);
  }
}

console.log("");
console.log("Loop gate passed.");
