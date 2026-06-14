#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const targetOrigin = "https://api.watasu.ai";
const usage = "Usage: pnpm --silent cutover:status [--dir <evidence-dir>]";
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

let evidenceDir;
try {
  evidenceDir = resolve(parseArgs(process.argv.slice(2)));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Invalid cutover status arguments."}\n`);
  process.exit(1);
}

const presentEvidence = [];
const missingEvidence = [];

for (const [name, filename] of evidenceFiles) {
  const path = resolve(evidenceDir, filename);
  if (existsSync(path)) {
    assertSecretSafeEvidence(path, name);
    presentEvidence.push(name);
  } else {
    missingEvidence.push(name);
  }
}

const nextCommands = nextCommandsForMissingEvidence(missingEvidence);
const remainingExternalActions = missingEvidence
  .map((name) => externalActionsByEvidence.get(name))
  .filter((action) => action !== undefined);

process.stdout.write(`${JSON.stringify({
  ok: true,
  checked_at: new Date().toISOString(),
  target_origin: targetOrigin,
  evidence_dir: evidenceDir,
  ready_for_verify: missingEvidence.length === 0,
  present_evidence: presentEvidence,
  missing_evidence: missingEvidence,
  next_commands: missingEvidence.length === 0 ? ["pnpm --silent cutover:verify"] : nextCommands,
  remaining_external_actions: remainingExternalActions
})}\n`);

function parseArgs(args) {
  if (args.length === 0) {
    return "cutover-evidence";
  }
  if (args.length === 2 && args[0] === "--dir" && args[1].length > 0) {
    return args[1];
  }
  throw new Error(usage);
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
