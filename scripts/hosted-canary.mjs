#!/usr/bin/env node
import {
  buildHostedCanaryCheckUrls,
  buildHostedCanarySuccessReport,
  formatHostedCanaryRequestError,
  formatHostedCanaryResponseReadError,
  hostedCanaryRequiredHeaders,
  resolveHostedCanaryBaseUrl,
  resolveHostedCanaryTimeoutMs,
  withHostedCanaryTimeout
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
const timeoutMs = resolveHostedCanaryTimeoutMs(process.env);
const response = await fetchHostedCanary("Health check", urls.health, {
  method: "GET",
  headers: {
    accept: "application/json"
  },
  redirect: "manual"
});
const body = await readHostedCanaryResponseBody("Health check", response);

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
  label: "Plaintext schema route",
  url: urls.unpublishedPlaintextSchema,
  init: {
    method: "GET",
    headers: {
      accept: "application/json"
    },
    redirect: "manual"
  }
});

await assertUnpublishedRoute({
  label: "Envelope schema route",
  url: urls.unpublishedEnvelopeSchema,
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

await assertNotFoundRoute({
  label: "Unsafe encoded request id route",
  url: urls.unsafeEncodedRequestId,
  init: {
    method: "GET",
    headers: {
      accept: "application/json"
    },
    redirect: "manual"
  }
});

await assertMcpEndpoint({
  label: "MCP endpoint",
  url: urls.mcpEndpoint
});

await assertMcpProtectedResourceMetadata({
  label: "MCP protected resource metadata",
  url: urls.mcpProtectedResourceMetadata
});

console.log(JSON.stringify(buildHostedCanarySuccessReport({
  status: response.status,
  timeoutMs,
  urls
})));

function assertRequiredHeaders(checkedResponse, label) {
  for (const [name, expected] of Object.entries(hostedCanaryRequiredHeaders)) {
    const actual = checkedResponse.headers.get(name);
    if (actual !== expected) {
      console.error(`${label} header ${name} expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}.`);
      process.exit(1);
    }
  }
}

async function fetchHostedCanary(label, url, init) {
  try {
    return await fetch(url, withHostedCanaryTimeout(init, timeoutMs));
  } catch (error) {
    console.error(formatHostedCanaryRequestError(label, error));
    process.exit(1);
  }
}

async function readHostedCanaryResponseBody(label, responseToRead) {
  try {
    return await responseToRead.text();
  } catch (error) {
    console.error(formatHostedCanaryResponseReadError(label, error));
    process.exit(1);
  }
}

async function assertMcpProtectedResourceMetadata(input) {
  const checkedResponse = await fetchHostedCanary(input.label, input.url, {
    method: "GET",
    headers: {
      accept: "application/json"
    },
    redirect: "manual"
  });
  const checkedBody = await readHostedCanaryResponseBody(input.label, checkedResponse);

  if (checkedResponse.status !== 200) {
    console.error(`${input.label} expected status 200 but got ${checkedResponse.status}.`);
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

  if (
    checkedJson?.resource !== urls.mcpEndpoint ||
    !Array.isArray(checkedJson?.authorization_servers) ||
    !checkedJson.authorization_servers.includes(new URL(input.url).origin) ||
    !Array.isArray(checkedJson?.scopes_supported) ||
    !checkedJson.scopes_supported.includes("watasu:publish") ||
    !Array.isArray(checkedJson?.bearer_methods_supported) ||
    !checkedJson.bearer_methods_supported.includes("header")
  ) {
    console.error(`${input.label} returned an unexpected metadata body.`);
    process.exit(1);
  }

  const routeLeak = mcpForbiddenFragments().find((fragment) => checkedBody.includes(fragment));
  if (routeLeak !== undefined) {
    console.error(`${input.label} leaked forbidden fragment: ${routeLeak}`);
    process.exit(1);
  }
}

async function assertMcpEndpoint(input) {
  const checkedResponse = await fetchHostedCanary(input.label, input.url, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-11-25"
    },
    redirect: "manual"
  });
  const checkedBody = await readHostedCanaryResponseBody(input.label, checkedResponse);

  if (checkedResponse.status !== 401) {
    console.error(`${input.label} expected unauthenticated status 401 but got ${checkedResponse.status}.`);
    process.exit(1);
  }
  assertRequiredHeaders(checkedResponse, input.label);

  const challenge = checkedResponse.headers.get("www-authenticate");
  const expectedChallengeMetadata = `resource_metadata="${urls.mcpProtectedResourceMetadata}"`;
  if (
    challenge === null ||
    !challenge.startsWith("Bearer resource_metadata=") ||
    !challenge.includes(expectedChallengeMetadata) ||
    !challenge.includes("watasu:publish")
  ) {
    console.error(`${input.label} did not return the expected authentication challenge.`);
    process.exit(1);
  }

  let checkedJson;
  try {
    checkedJson = JSON.parse(checkedBody);
  } catch {
    console.error(`${input.label} did not return JSON.`);
    process.exit(1);
  }

  if (checkedJson?.ok !== false || checkedJson?.error?.code !== "mcp_transport_auth_required") {
    console.error(`${input.label} returned an unexpected authentication body.`);
    process.exit(1);
  }

  const routeLeak = mcpForbiddenFragments().find((fragment) => checkedBody.includes(fragment) || challenge.includes(fragment));
  if (routeLeak !== undefined) {
    console.error(`${input.label} leaked forbidden fragment: ${routeLeak}`);
    process.exit(1);
  }
}

function mcpForbiddenFragments() {
  return forbiddenFragments.filter((fragment) => fragment !== "ledger");
}

async function assertUnpublishedRoute(input) {
  const checkedResponse = await fetchHostedCanary(input.label, input.url, input.init);
  const checkedBody = await readHostedCanaryResponseBody(input.label, checkedResponse);

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

async function assertNotFoundRoute(input) {
  const checkedResponse = await fetchHostedCanary(input.label, input.url, input.init);
  const checkedBody = await readHostedCanaryResponseBody(input.label, checkedResponse);

  if (checkedResponse.status !== 404) {
    console.error(`${input.label} expected not found status 404 but got ${checkedResponse.status}.`);
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

  if (checkedJson?.ok !== false || checkedJson?.error?.code !== "not_found") {
    console.error(`${input.label} returned an unexpected not found body.`);
    process.exit(1);
  }

  const routeLeak = forbiddenFragments.find((fragment) => checkedBody.includes(fragment));
  if (routeLeak !== undefined) {
    console.error(`${input.label} leaked forbidden fragment: ${routeLeak}`);
    process.exit(1);
  }
}
