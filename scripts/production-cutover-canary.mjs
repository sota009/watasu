#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const targetOrigin = "https://api.watasu.ai";
const usage = "Usage: pnpm --silent cutover:canary [--dir <evidence-dir>] [--source <canary-json>]";
const inputs = parseArgs(process.argv.slice(2));
const evidenceDir = resolve(inputs.dir);
const canaryPath = resolve(evidenceDir, "canary.json");

try {
  mkdirSync(evidenceDir, { recursive: true });
  const raw = inputs.source === undefined
    ? runHostedCanary()
    : readFileSync(resolve(inputs.source), "utf8");
  assertSecretSafeEvidence(raw, inputs.source ?? "hosted canary output");
  const canary = JSON.parse(raw);
  if (canary?.ok !== true || canary?.checked_origin !== targetOrigin || canary?.go_no_go?.decision !== "go") {
    throw new Error(`Hosted canary evidence must report ok=true, checked_origin=${targetOrigin}, and go_no_go.decision=go.`);
  }

  writeFileSync(canaryPath, `${JSON.stringify(canary)}\n`);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    checked_at: new Date().toISOString(),
    checked_origin: targetOrigin,
    evidence_dir: evidenceDir,
    wrote: canaryPath
  })}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Production cutover canary evidence failed."}\n`);
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

function runHostedCanary() {
  const result = spawnSync("pnpm", [
    "--silent",
    "canary:hosted",
    "--",
    targetOrigin
  ], {
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error("hosted canary failed. Confirm api.watasu.ai DNS/TLS and the hosted deployment, then retry.");
  }
  return result.stdout;
}

function assertSecretSafeEvidence(raw, label) {
  if (raw.includes("WATASU_POSTGRES_URL=") || raw.includes("WATASU_SERVICE_IDENTITY_SIGNING_SECRET=")) {
    throw new Error(`${label} contains secret-like assignment output.`);
  }
  if (raw.includes("\"encrypted_payload\"") || raw.includes("\"payload_body\"") || raw.includes("\"plaintext_payload\"")) {
    throw new Error(`${label} contains payload body evidence.`);
  }
}
