#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const usage = "Usage: pnpm --silent cutover:repo [--dir <evidence-dir>] [--ci-source <gh-run-list-json>]";
const inputs = parseArgs(process.argv.slice(2));
const evidenceDir = resolve(inputs.dir);

try {
  runJson("pnpm", ["--silent", "cutover:prepare", "--dir", evidenceDir]);
  const ciArgs = ["--silent", "cutover:ci", "--dir", evidenceDir];
  if (inputs.ciSource !== undefined) {
    ciArgs.push("--source", resolve(inputs.ciSource));
  }
  runJson("pnpm", ciArgs);

  const headSha = readFileSync(resolve(evidenceDir, "cutover-head.txt"), "utf8").trim();
  process.stdout.write(`${JSON.stringify({
    ok: true,
    checked_at: new Date().toISOString(),
    evidence_dir: evidenceDir,
    checked_head_sha: headSha,
    wrote: [
      resolve(evidenceDir, "cutover-head.txt"),
      resolve(evidenceDir, "preflight.json"),
      resolve(evidenceDir, "smoke.json"),
      resolve(evidenceDir, "ci.json")
    ],
    next_commands: [
      "pnpm --silent cutover:canary",
      "pnpm --silent cutover:retention"
    ]
  })}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Production cutover repo evidence failed."}\n`);
  process.exit(1);
}

function parseArgs(args) {
  const parsed = {
    dir: "cutover-evidence",
    ciSource: undefined
  };
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (value === undefined || value.length === 0) {
      throw new Error(usage);
    }
    if (name === "--dir") {
      parsed.dir = value;
    } else if (name === "--ci-source") {
      parsed.ciSource = value;
    } else {
      throw new Error(usage);
    }
  }
  return parsed;
}

function runJson(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8"
  });
  assertSecretSafe(result.stdout);
  assertSecretSafe(result.stderr);
  if (result.status !== 0) {
    throw new Error(`${command} ${args.slice(0, 2).join(" ")} failed.`);
  }
  return JSON.parse(result.stdout);
}

function assertSecretSafe(value) {
  if (value.includes("WATASU_POSTGRES_URL=") || value.includes("WATASU_SERVICE_IDENTITY_SIGNING_SECRET=") || value.includes("WATASU_MCP_BEARER_TOKEN=")) {
    throw new Error("cutover repo refused to persist secret-like assignment output.");
  }
  if (value.includes("\"encrypted_payload\"") || value.includes("\"payload_body\"") || value.includes("\"plaintext_payload\"")) {
    throw new Error("cutover repo refused to persist payload body evidence.");
  }
}
