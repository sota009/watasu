#!/usr/bin/env node
import {
  hostedCanaryRequiredHeaders,
  resolveHostedCanaryBaseUrl
} from "./hosted-canary-helpers.mjs";

let baseUrl;
try {
  baseUrl = resolveHostedCanaryBaseUrl({
    env: process.env,
    argv: process.argv
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : "WATASU_CANARY_BASE_URL is invalid.");
  process.exit(1);
}

const healthUrl = new URL("/health", baseUrl);
const response = await fetch(healthUrl, {
  method: "GET",
  headers: {
    accept: "application/json"
  },
  redirect: "manual"
});
const body = await response.text();

if (response.status !== 200) {
  console.error(`Health check failed with status ${response.status}.`);
  process.exit(1);
}

for (const [name, expected] of Object.entries(hostedCanaryRequiredHeaders)) {
  const actual = response.headers.get(name);
  if (actual !== expected) {
    console.error(`Health check header ${name} expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}.`);
    process.exit(1);
  }
}

let parsed;
try {
  parsed = JSON.parse(body);
} catch {
  console.error("Health check did not return JSON.");
  process.exit(1);
}

if (parsed?.ok !== true || parsed?.service !== "watasu-hosted") {
  console.error("Health check returned an unexpected body.");
  process.exit(1);
}

const forbiddenFragments = [
  "tenant",
  "ledger",
  "postgres",
  "payload",
  "secret",
  "WATASU_POSTGRES_URL"
];
const leakedFragment = forbiddenFragments.find((fragment) => body.includes(fragment));
if (leakedFragment !== undefined) {
  console.error(`Health check leaked forbidden fragment: ${leakedFragment}`);
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  checked_url: healthUrl.toString(),
  checked_headers: Object.keys(hostedCanaryRequiredHeaders),
  status: response.status
}));
