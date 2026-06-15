#!/usr/bin/env node

const requiredInputs = [
  "WATASU_HOSTED_SUBMIT_AGENT_CARD_URL",
  "WATASU_HOSTED_SUBMIT_SCHEMA_URL",
  "WATASU_HOSTED_SUBMIT_PUBLIC_JWK",
  "WATASU_HOSTED_SUBMIT_VALUES"
];

const optionalInputs = [
  "WATASU_HOSTED_SUBMIT_MAPPING",
  "WATASU_HOSTED_SUBMIT_MCP_COMMAND"
];

const missingInputs = requiredInputs.filter((name) => !hasValue(process.env[name]));
const ready = missingInputs.length === 0;
const configuredOptionalInputs = optionalInputs.filter((name) => hasValue(process.env[name]));

process.stdout.write(`${JSON.stringify({
  ok: true,
  checked_at: new Date().toISOString(),
  target_origin: "https://api.watasu.ai",
  ready,
  missing_inputs: missingInputs,
  configured_optional_inputs: configuredOptionalInputs,
  required_inputs: requiredInputs,
  next_command: ready
    ? "pnpm --filter @watasu/personal-info-adapter submit --confirm"
    : "pnpm --silent hosted-submit:status",
  notes: [
    "Set WATASU_HOSTED_SUBMIT_AGENT_CARD_URL and WATASU_HOSTED_SUBMIT_SCHEMA_URL to the published private-alpha request URLs.",
    "Set WATASU_HOSTED_SUBMIT_PUBLIC_JWK and WATASU_HOSTED_SUBMIT_VALUES to local test-only file paths.",
    "Do not put private-alpha tokens, personal-info values, JWK bodies, or payload bodies in command output."
  ]
})}\n`);

function hasValue(value) {
  return typeof value === "string" && value.trim().length > 0;
}
