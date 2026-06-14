#!/usr/bin/env node
const baseUrl = process.env.WATASU_CANARY_BASE_URL;

if (baseUrl === undefined || baseUrl.trim() === "") {
  console.error("WATASU_CANARY_BASE_URL is required.");
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
  status: response.status
}));
