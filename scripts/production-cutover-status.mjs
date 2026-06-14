#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const targetOrigin = "https://api.watasu.ai";
const usage = "Usage: pnpm --silent cutover:status [--dir <evidence-dir>] [--head <40-char-sha>]";
const evidenceFiles = [
  ["cutover-head", "cutover-head.txt"],
  ["preflight", "preflight.json"],
  ["smoke", "smoke.json"],
  ["ci", "ci.json"],
  ["canary", "canary.json"],
  ["retention", "retention.json"]
];
const commandByEvidence = new Map([
  ["cutover-head", "pnpm --silent cutover:prepare"],
  ["preflight", "pnpm --silent cutover:prepare"],
  ["smoke", "pnpm --silent cutover:prepare"],
  ["ci", "pnpm --silent cutover:ci"],
  ["canary", "pnpm --silent cutover:canary"],
  ["retention", "pnpm --silent cutover:retention"]
]);
const externalActionsByEvidence = new Map([
  ["ci", "GitHub Actions CI green on the cutover head."],
  ["canary", "Verify api.watasu.ai DNS and TLS in Render."],
  ["retention", "Confirm the deployed metadata database environment is ready."]
]);

let inputs;
try {
  inputs = parseArgs(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Invalid cutover status arguments."}\n`);
  process.exit(1);
}

const evidenceDir = resolve(inputs.dir);
const currentHeadSha = inputs.head ?? readCurrentHeadSha();
const presentEvidence = [];
const missingEvidence = [];
let checkedHeadSha;

for (const [name, filename] of evidenceFiles) {
  const path = resolve(evidenceDir, filename);
  if (existsSync(path)) {
    assertSecretSafeEvidence(path, name);
    if (name === "cutover-head") {
      checkedHeadSha = readFileSync(path, "utf8").trim();
    }
    presentEvidence.push(name);
  } else {
    missingEvidence.push(name);
  }
}

const headMatchesCurrent = checkedHeadSha === undefined ? false : checkedHeadSha.toLowerCase() === currentHeadSha.toLowerCase();
const staleEvidence = checkedHeadSha !== undefined && !headMatchesCurrent ? presentEvidence : [];
const nextCommands = staleEvidence.length > 0
  ? ["pnpm --silent cutover:prepare"]
  : nextCommandsForMissingEvidence(missingEvidence);
const remainingExternalActions = missingEvidence
  .map((name) => externalActionsByEvidence.get(name))
  .filter((action) => action !== undefined);
const readyForVerify = missingEvidence.length === 0 && staleEvidence.length === 0;

process.stdout.write(`${JSON.stringify({
  ok: true,
  checked_at: new Date().toISOString(),
  target_origin: targetOrigin,
  evidence_dir: evidenceDir,
  checked_head_sha: checkedHeadSha,
  current_head_sha: currentHeadSha,
  head_matches_current: headMatchesCurrent,
  ready_for_verify: readyForVerify,
  present_evidence: presentEvidence,
  missing_evidence: missingEvidence,
  stale_evidence: staleEvidence,
  next_commands: readyForVerify ? ["pnpm --silent cutover:verify"] : nextCommands,
  remaining_external_actions: remainingExternalActions
})}\n`);

function parseArgs(args) {
  const parsed = {
    dir: "cutover-evidence",
    head: undefined
  };
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (name === undefined) {
      return parsed;
    }
    if (value === undefined || value.length === 0) {
      throw new Error(usage);
    }
    if (name === "--dir") {
      parsed.dir = value;
    } else if (name === "--head") {
      if (!/^[0-9a-f]{40}$/i.test(value)) {
        throw new Error(usage);
      }
      parsed.head = value;
    } else {
      throw new Error(usage);
    }
  }
  return parsed;
}

function nextCommandsForMissingEvidence(missingEvidence) {
  if (
    missingEvidence.includes("cutover-head") ||
    missingEvidence.includes("preflight") ||
    missingEvidence.includes("smoke")
  ) {
    return ["pnpm --silent cutover:prepare"];
  }

  const commands = [];
  for (const name of missingEvidence) {
    const command = commandByEvidence.get(name);
    if (command !== undefined && !commands.includes(command)) {
      commands.push(command);
    }
  }
  return commands;
}

function assertSecretSafeEvidence(path, name) {
  const raw = readFileSync(path, "utf8");
  if (raw.includes("WATASU_POSTGRES_URL=") || raw.includes("WATASU_SERVICE_IDENTITY_SIGNING_SECRET=")) {
    throw new Error(`${name} evidence contains secret-like assignment output.`);
  }
  if (raw.includes("\"encrypted_payload\"") || raw.includes("\"payload_body\"") || raw.includes("\"plaintext_payload\"")) {
    throw new Error(`${name} evidence contains payload body evidence.`);
  }
}

function readCurrentHeadSha() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error("git rev-parse HEAD failed.");
  }
  return result.stdout.trim();
}
