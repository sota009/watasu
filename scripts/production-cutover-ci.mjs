#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const usage = "Usage: pnpm --silent cutover:ci [--dir <evidence-dir>] [--source <gh-run-list-json>]";
const inputs = parseArgs(process.argv.slice(2));
const evidenceDir = resolve(inputs.dir);
const headPath = resolve(evidenceDir, "cutover-head.txt");
const ciPath = resolve(evidenceDir, "ci.json");

try {
  mkdirSync(evidenceDir, { recursive: true });
  const expectedHead = readFileSync(headPath, "utf8").trim();
  if (!/^[0-9a-f]{40}$/i.test(expectedHead)) {
    throw new Error(`${headPath} must contain a 40-character commit SHA.`);
  }

  const runs = inputs.source === undefined
    ? runGhCiList()
    : JSON.parse(readFileSync(resolve(inputs.source), "utf8"));
  const run = findSuccessfulCiRun(runs, expectedHead);
  if (run === undefined) {
    throw new Error("No completed successful ci run matched cutover-evidence/cutover-head.txt.");
  }

  writeFileSync(ciPath, `${JSON.stringify(run)}\n`);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    checked_at: new Date().toISOString(),
    evidence_dir: evidenceDir,
    checked_head_sha: expectedHead,
    wrote: ciPath
  })}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Production cutover CI evidence failed."}\n`);
  process.exit(1);
}

function parseArgs(args) {
  const parsed = {
    dir: "cutover-evidence",
    source: undefined
  };
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (value === undefined || value.length === 0) {
      throw new Error(usage);
    }
    if (name === "--dir") {
      parsed.dir = value;
    } else if (name === "--source") {
      parsed.source = value;
    } else {
      throw new Error(usage);
    }
  }
  return parsed;
}

function runGhCiList() {
  const result = spawnSync("gh", [
    "run",
    "list",
    "--workflow",
    "ci",
    "--branch",
    "main",
    "--limit",
    "10",
    "--json",
    "workflowName,status,conclusion,headSha,url,createdAt"
  ], {
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error("gh run list failed. Confirm GitHub authentication and network access, then retry.");
  }
  return JSON.parse(result.stdout);
}

function findSuccessfulCiRun(value, expectedHead) {
  const runs = Array.isArray(value) ? value : [value];
  return runs.find((run) =>
    run?.workflowName === "ci" &&
    run?.status === "completed" &&
    run?.conclusion === "success" &&
    typeof run?.headSha === "string" &&
    run.headSha.toLowerCase() === expectedHead.toLowerCase()
  );
}
