#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const targetOrigin = "https://api.watasu.ai";
const usage = "Usage: pnpm --silent cutover:verify [--dir <evidence-dir>] [--head <40-char-sha> --preflight <json> --smoke <json> --canary <json> --retention <json> --ci <json>]";
const requiredForbiddenFragments = [
  "tenant",
  "ledger",
  "postgres",
  "payload",
  "secret",
  "WATASU_POSTGRES_URL"
];
const requiredCanaryHeaders = [
  "cache-control",
  "content-security-policy",
  "referrer-policy",
  "x-content-type-options"
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
    retention: readJsonEvidence(inputs.retention),
    ci: readJsonEvidence(inputs.ci)
  };
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Cutover evidence could not be read."}\n`);
  process.exit(1);
}

const failures = [
  ...validateExpectedHead(inputs.head),
  ...validatePreflight(evidence.preflight),
  ...validateSmoke(evidence.smoke),
  ...validateCanary(evidence.canary),
  ...validateRetention(evidence.retention),
  ...validateCi(evidence.ci, inputs.head)
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
  checked_head_sha: inputs.head,
  checked_evidence: ["preflight", "smoke", "canary", "retention", "ci"]
})}\n`);

function parseArgs(args) {
  if (args.length === 0) {
    return inputsFromEvidenceDir("cutover-evidence");
  }

  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (value === undefined) {
      throw new Error(usage);
    }
    if (name === "--dir") {
      return inputsFromEvidenceDir(value);
    } else if (name === "--head") {
      parsed.head = value;
    } else if (name === "--preflight") {
      parsed.preflight = value;
    } else if (name === "--smoke") {
      parsed.smoke = value;
    } else if (name === "--canary") {
      parsed.canary = value;
    } else if (name === "--retention") {
      parsed.retention = value;
    } else if (name === "--ci") {
      parsed.ci = value;
    } else {
      throw new Error(usage);
    }
  }

  if (
    parsed.head === undefined ||
    parsed.preflight === undefined ||
    parsed.smoke === undefined ||
    parsed.canary === undefined ||
    parsed.retention === undefined ||
    parsed.ci === undefined
  ) {
    throw new Error(usage);
  }

  return parsed;
}

function inputsFromEvidenceDir(path) {
  const evidenceDir = resolve(path);
  return {
    head: readFileSync(resolve(evidenceDir, "cutover-head.txt"), "utf8").trim(),
    preflight: resolve(evidenceDir, "preflight.json"),
    smoke: resolve(evidenceDir, "smoke.json"),
    canary: resolve(evidenceDir, "canary.json"),
    retention: resolve(evidenceDir, "retention.json"),
    ci: resolve(evidenceDir, "ci.json")
  };
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
  if (!Array.isArray(value?.checked_not_found_routes) || value.checked_not_found_routes.length === 0) {
    failures.push("hosted canary must record low-information not-found route evidence.");
  }
  const methodBoundaries = Array.isArray(value?.checked_method_boundaries) ? value.checked_method_boundaries : [];
  const protectedResourceBoundary = methodBoundaries.find((boundary) =>
    Array.isArray(boundary?.allowed_methods) &&
    boundary.allowed_methods.includes("GET") &&
    Array.isArray(boundary?.rejected_methods) &&
    boundary.rejected_methods.includes("POST")
  );
  if (protectedResourceBoundary === undefined) {
    failures.push("hosted canary must record protected-resource method boundary evidence.");
  }
  for (const header of requiredCanaryHeaders) {
    if (!Array.isArray(value?.checked_headers) || !value.checked_headers.includes(header)) {
      failures.push(`hosted canary must record security header ${header}.`);
    }
  }
  if (!Number.isInteger(value?.checked_timeout_ms) || value.checked_timeout_ms <= 0 || value.checked_timeout_ms > 60_000) {
    failures.push("hosted canary must record checked_timeout_ms between 1 and 60000.");
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
  if (typeof value?.checked_at !== "string" || Number.isNaN(Date.parse(value.checked_at))) {
    failures.push("retention evidence must include checked_at.");
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
  for (const countName of ["scanned", "deleted", "retained"]) {
    if (!Number.isInteger(value?.[countName]) || value[countName] < 0) {
      failures.push(`retention evidence must include non-negative ${countName}.`);
    }
  }
  return failures;
}

function validateExpectedHead(value) {
  const failures = [];
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/i.test(value)) {
    failures.push("Expected head must be a 40-character commit SHA.");
  }
  return failures;
}

function validateCi(value, expectedHeadSha) {
  const failures = [];
  const runs = Array.isArray(value) ? value : [value];
  const successfulCiRun = runs.find((run) =>
    run?.workflowName === "ci" &&
    run?.status === "completed" &&
    run?.conclusion === "success" &&
    typeof run?.headSha === "string" &&
    run.headSha.toLowerCase() === expectedHeadSha.toLowerCase()
  );
  if (successfulCiRun === undefined) {
    failures.push("CI evidence must include a completed successful ci run for the expected head.");
  }
  return failures;
}
