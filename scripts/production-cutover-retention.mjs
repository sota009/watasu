#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const usage = "Usage: pnpm --silent cutover:retention [--dir <evidence-dir>] [--source <retention-json>]";
const inputs = parseArgs(process.argv.slice(2));
const evidenceDir = resolve(inputs.dir);
const retentionPath = resolve(evidenceDir, "retention.json");

try {
  mkdirSync(evidenceDir, { recursive: true });
  const raw = inputs.source === undefined
    ? runHostedRetentionDryRun()
    : readFileSync(resolve(inputs.source), "utf8");
  assertSecretSafeEvidence(raw, inputs.source ?? "hosted retention output");
  const retention = JSON.parse(raw);
  const failures = validateRetention(retention);
  if (failures.length > 0) {
    throw new Error(`Retention evidence is incomplete: ${failures.join(", ")}.`);
  }

  writeFileSync(retentionPath, `${JSON.stringify(retention)}\n`);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    checked_at: new Date().toISOString(),
    dry_run: true,
    evidence_dir: evidenceDir,
    wrote: retentionPath
  })}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Production cutover retention evidence failed."}\n`);
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

function runHostedRetentionDryRun() {
  const result = spawnSync("pnpm", [
    "--silent",
    "--filter",
    "@watasu/hosted",
    "retention",
    "--",
    "--dry-run"
  ], {
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error("hosted retention dry run failed. Confirm the deployed metadata database environment, then retry.");
  }
  return result.stdout;
}

function validateRetention(value) {
  const failures = [];
  if (value?.ok !== true) {
    failures.push("ok=true");
  }
  if (value?.dry_run !== true) {
    failures.push("dry_run=true");
  }
  if (typeof value?.checked_at !== "string" || Number.isNaN(Date.parse(value.checked_at))) {
    failures.push("checked_at");
  }
  if (typeof value?.tenant_id !== "string" || value.tenant_id.length === 0) {
    failures.push("tenant_id");
  }
  for (const countName of ["scanned", "deleted", "retained", "would_delete"]) {
    if (!Number.isInteger(value?.[countName]) || value[countName] < 0) {
      failures.push(countName);
    }
  }
  return failures;
}

function assertSecretSafeEvidence(raw, label) {
  if (raw.includes("WATASU_POSTGRES_URL=") || raw.includes("WATASU_SERVICE_IDENTITY_SIGNING_SECRET=") || raw.includes("WATASU_MCP_BEARER_TOKEN=")) {
    throw new Error(`${label} contains secret-like assignment output.`);
  }
  if (raw.includes("\"encrypted_payload\"") || raw.includes("\"payload_body\"") || raw.includes("\"plaintext_payload\"")) {
    throw new Error(`${label} contains payload body evidence.`);
  }
}
