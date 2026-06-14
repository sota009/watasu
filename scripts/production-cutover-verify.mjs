#!/usr/bin/env node
import { readFileSync } from "node:fs";

const targetOrigin = "https://api.watasu.ai";
const requiredForbiddenFragments = [
  "tenant",
  "ledger",
  "postgres",
  "payload",
  "secret",
  "WATASU_POSTGRES_URL"
];

let inputs;
try {
  inputs = parseArgs(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Invalid cutover verify arguments."}\n`);
  process.exit(1);
}

let evidence;
try {
  evidence = {
    preflight: readJsonEvidence(inputs.preflight),
    smoke: readJsonEvidence(inputs.smoke),
    canary: readJsonEvidence(inputs.canary),
    retention: readJsonEvidence(inputs.retention)
  };
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Cutover evidence could not be read."}\n`);
  process.exit(1);
}

const failures = [
  ...validatePreflight(evidence.preflight),
  ...validateSmoke(evidence.smoke),
  ...validateCanary(evidence.canary),
  ...validateRetention(evidence.retention)
];

if (failures.length > 0) {
  process.stderr.write(`Production cutover evidence verification failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}\n`);
  process.exit(1);
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  decision: "go",
  checked_at: new Date().toISOString(),
  checked_origin: targetOrigin,
  checked_evidence: ["preflight", "smoke", "canary", "retention"]
})}\n`);

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (value === undefined) {
      throw new Error("Usage: pnpm --silent cutover:verify --preflight <json> --smoke <json> --canary <json> --retention <json>");
    }
    if (name === "--preflight") {
      parsed.preflight = value;
    } else if (name === "--smoke") {
      parsed.smoke = value;
    } else if (name === "--canary") {
      parsed.canary = value;
    } else if (name === "--retention") {
      parsed.retention = value;
    } else {
      throw new Error("Usage: pnpm --silent cutover:verify --preflight <json> --smoke <json> --canary <json> --retention <json>");
    }
  }

  if (
    parsed.preflight === undefined ||
    parsed.smoke === undefined ||
    parsed.canary === undefined ||
    parsed.retention === undefined
  ) {
    throw new Error("Usage: pnpm --silent cutover:verify --preflight <json> --smoke <json> --canary <json> --retention <json>");
  }

  return parsed;
}

function readJsonEvidence(path) {
  const raw = readFileSync(path, "utf8");
  if (raw.includes("WATASU_POSTGRES_URL=") || raw.includes("WATASU_SERVICE_IDENTITY_SIGNING_SECRET=")) {
    throw new Error(`${path} contains secret-like assignment output.`);
  }
  if (raw.includes("\"encrypted_payload\"") || raw.includes("\"payload_body\"") || raw.includes("\"plaintext_payload\"")) {
    throw new Error(`${path} contains payload body evidence.`);
  }
  return JSON.parse(raw);
}

function validatePreflight(value) {
  const failures = [];
  if (value?.ok !== true) {
    failures.push("deploy preflight must report ok=true.");
  }
  if (value?.checked_domain !== "api.watasu.ai") {
    failures.push("deploy preflight must check api.watasu.ai.");
  }
  if (value?.checked_secret_command !== "pnpm --silent secret:identity --plain") {
    failures.push("deploy preflight must use the plain identity secret command.");
  }
  return failures;
}

function validateSmoke(value) {
  const failures = [];
  if (value?.ok !== true) {
    failures.push("hosted smoke must report ok=true.");
  }
  if (value?.checked_command !== "pnpm --filter @watasu/hosted start") {
    failures.push("hosted smoke must check the hosted start command.");
  }
  if (value?.checked_status !== 200) {
    failures.push("hosted smoke must check a 200 health response.");
  }
  return failures;
}

function validateCanary(value) {
  const failures = [];
  if (value?.ok !== true) {
    failures.push("hosted canary must report ok=true.");
  }
  if (value?.checked_origin !== targetOrigin) {
    failures.push(`hosted canary must check ${targetOrigin}.`);
  }
  for (const fragment of requiredForbiddenFragments) {
    if (!Array.isArray(value?.checked_forbidden_fragments) || !value.checked_forbidden_fragments.includes(fragment)) {
      failures.push(`hosted canary must record forbidden fragment ${fragment}.`);
    }
  }
  if (value?.go_no_go?.decision !== "go") {
    failures.push("hosted canary go_no_go decision must be go.");
  }
  return failures;
}

function validateRetention(value) {
  const failures = [];
  if (value?.ok !== true) {
    failures.push("retention dry run must report ok=true.");
  }
  if (value?.dry_run !== true) {
    failures.push("retention evidence must be a dry run.");
  }
  if (!Number.isInteger(value?.retention_days) || value.retention_days <= 0) {
    failures.push("retention evidence must include positive retention_days.");
  }
  if (typeof value?.tenant_id !== "string" || value.tenant_id.length === 0) {
    failures.push("retention evidence must include tenant_id.");
  }
  if (!Number.isInteger(value?.would_delete) || value.would_delete < 0) {
    failures.push("retention evidence must include non-negative would_delete.");
  }
  return failures;
}
