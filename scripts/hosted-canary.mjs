#!/usr/bin/env node
import {
  buildHostedCanaryCheckUrls,
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

const urls = buildHostedCanaryCheckUrls(baseUrl);
const response = await fetch(urls.health, {
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

assertRequiredHeaders(response, "Health check");

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

await assertUnpublishedRoute({
  label: "Agent Card route",
  url: urls.unpublishedAgentCard,
  init: {
    method: "GET",
    headers: {
      accept: "application/json"
    },
    redirect: "manual"
  }
});

await assertUnpublishedRoute({
  label: "Submit route",
  url: urls.unpublishedSubmit,
  init: {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/a2a+json",
      "a2a-version": "1.0",
      "a2a-extensions": "https://watasu.dev/extensions/encrypted-intake/v1"
    },
    body: "{}",
    redirect: "manual"
  }
});

console.log(JSON.stringify({
  ok: true,
  checked_url: urls.health,
  checked_public_routes: [
    urls.unpublishedAgentCard,
    urls.unpublishedSubmit
  ],
  checked_headers: Object.keys(hostedCanaryRequiredHeaders),
  status: response.status
}));

function assertRequiredHeaders(checkedResponse, label) {
  for (const [name, expected] of Object.entries(hostedCanaryRequiredHeaders)) {
    const actual = checkedResponse.headers.get(name);
    if (actual !== expected) {
      console.error(`${label} header ${name} expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}.`);
      process.exit(1);
    }
  }
}

async function assertUnpublishedRoute(input) {
  const checkedResponse = await fetch(input.url, input.init);
  const checkedBody = await checkedResponse.text();

  if (checkedResponse.status !== 404) {
    console.error(`${input.label} expected unpublished request status 404 but got ${checkedResponse.status}.`);
    process.exit(1);
  }
  assertRequiredHeaders(checkedResponse, input.label);

  let checkedJson;
  try {
    checkedJson = JSON.parse(checkedBody);
  } catch {
    console.error(`${input.label} did not return JSON.`);
    process.exit(1);
  }

  if (checkedJson?.ok !== false || checkedJson?.error?.code !== "request_version_not_found") {
    console.error(`${input.label} returned an unexpected unpublished request body.`);
    process.exit(1);
  }

  const routeLeak = forbiddenFragments.find((fragment) => checkedBody.includes(fragment));
  if (routeLeak !== undefined) {
    console.error(`${input.label} leaked forbidden fragment: ${routeLeak}`);
    process.exit(1);
  }
}
