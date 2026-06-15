#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const usage = "Usage: pnpm --silent cutover:prepare [--dir <evidence-dir>]";
const evidenceDir = resolve(parseArgs(process.argv.slice(2)));
const evidencePaths = {
  head: resolve(evidenceDir, "cutover-head.txt"),
  preflight: resolve(evidenceDir, "preflight.json"),
  smoke: resolve(evidenceDir, "smoke.json")
};

try {
  mkdirSync(evidenceDir, { recursive: true });
  const headSha = runText("git", ["rev-parse", "HEAD"]).trim();
  if (!/^[0-9a-f]{40}$/i.test(headSha)) {
    throw new Error("git rev-parse HEAD did not return a 40-character commit SHA.");
  }
  const preflight = runJson(process.execPath, ["scripts/render-deploy-preflight.mjs"]);
  const smoke = runJson(process.execPath, ["scripts/hosted-start-smoke.mjs"]);

  writeFileSync(evidencePaths.head, `${headSha}\n`);
  writeFileSync(evidencePaths.preflight, `${JSON.stringify(preflight)}\n`);
  writeFileSync(evidencePaths.smoke, `${JSON.stringify(smoke)}\n`);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    checked_at: new Date().toISOString(),
    evidence_dir: evidenceDir,
    checked_head_sha: headSha,
    wrote: [
      evidencePaths.head,
      evidencePaths.preflight,
      evidencePaths.smoke
    ]
  })}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Production cutover prepare failed."}\n`);
  process.exit(1);
}

function parseArgs(args) {
  if (args.length === 0) {
    return "cutover-evidence";
  }
  if (args.length === 2 && args[0] === "--dir" && args[1].length > 0) {
    return args[1];
  }
  throw new Error(usage);
}

function runText(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  assertSecretSafe(result.stdout);
  assertSecretSafe(result.stderr);
  return result.stdout;
}

function runJson(command, args) {
  const raw = runText(command, args);
  return JSON.parse(raw);
}

function assertSecretSafe(value) {
  if (value.includes("WATASU_POSTGRES_URL=") || value.includes("WATASU_SERVICE_IDENTITY_SIGNING_SECRET=") || value.includes("WATASU_MCP_BEARER_TOKEN=")) {
    throw new Error("cutover prepare refused to persist secret-like assignment output.");
  }
}
