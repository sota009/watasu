export const hostedCanaryRequiredHeaders = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff"
};

export const hostedCanaryUnpublishedRequestId = "__watasu_canary_missing__";
export const defaultHostedCanaryTimeoutMs = 10_000;
export const maxHostedCanaryTimeoutMs = 60_000;
export const hostedCanaryForbiddenFragments = [
  "tenant",
  "ledger",
  "postgres",
  "payload",
  "secret",
  "WATASU_POSTGRES_URL"
];

export function buildHostedCanaryCheckUrls(baseUrl) {
  return {
    health: new URL("/health", baseUrl).toString(),
    root: new URL("/", baseUrl).toString(),
    unpublishedAgentCard: new URL(
      `/requests/${hostedCanaryUnpublishedRequestId}/agent-card.json`,
      baseUrl
    ).toString(),
    unpublishedPlaintextSchema: new URL(
      `/requests/${hostedCanaryUnpublishedRequestId}/schemas/plaintext.json`,
      baseUrl
    ).toString(),
    unpublishedEnvelopeSchema: new URL(
      `/requests/${hostedCanaryUnpublishedRequestId}/schemas/envelope.json`,
      baseUrl
    ).toString(),
    unpublishedSubmit: new URL(
      `/requests/${hostedCanaryUnpublishedRequestId}/submit`,
      baseUrl
    ).toString(),
    mcpEndpoint: new URL("/mcp", baseUrl).toString(),
    mcpProtectedResourceMetadata: new URL(
      "/.well-known/oauth-protected-resource",
      baseUrl
    ).toString(),
    unsafeEncodedRequestId: new URL(
      "/requests/__watasu%2Fcanary__/agent-card.json",
      baseUrl
    ).toString()
  };
}

export function buildHostedCanarySuccessReport(input) {
  return {
    ok: true,
    checked_at: input.checkedAt,
    checked_origin: new URL(input.urls.health).origin,
    checked_url: input.urls.health,
    checked_public_routes: [
      input.urls.unpublishedAgentCard,
      input.urls.unpublishedPlaintextSchema,
      input.urls.unpublishedEnvelopeSchema,
      input.urls.unpublishedSubmit,
      input.urls.mcpEndpoint,
      input.urls.mcpProtectedResourceMetadata,
      input.urls.unsafeEncodedRequestId
    ],
    checked_method_boundaries: [
      {
        url: input.urls.mcpProtectedResourceMetadata,
        allowed_methods: ["GET"],
        rejected_methods: ["POST"]
      }
    ],
    checked_not_found_routes: [
      input.urls.root,
      input.urls.unsafeEncodedRequestId
    ],
    checked_headers: Object.keys(hostedCanaryRequiredHeaders),
    checked_forbidden_fragments: hostedCanaryForbiddenFragments,
    checked_timeout_ms: input.timeoutMs,
    go_no_go: {
      decision: "go",
      required_followups: [
        "Run retention dry run on the deployed environment.",
        "Record no-payload-custody evidence before private-alpha exposure."
      ],
      evidence: [
        "health endpoint returned 200",
        "public low-information routes stayed non-successful",
        "hosted MCP endpoint required authentication",
        "protected-resource metadata allowed GET and rejected POST",
        "required security headers were present"
      ]
    },
    status: input.status
  };
}

export function parseHostedCanaryBaseUrl(rawBaseUrl) {
  if (rawBaseUrl === undefined || rawBaseUrl.trim() === "") {
    throw new Error("WATASU_CANARY_BASE_URL is required.");
  }

  let url;
  try {
    url = new URL(rawBaseUrl);
  } catch {
    throw new Error("WATASU_CANARY_BASE_URL must be a valid absolute URL.");
  }

  if (url.username !== "" || url.password !== "") {
    throw new Error("WATASU_CANARY_BASE_URL must not include username or password credentials.");
  }

  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error("WATASU_CANARY_BASE_URL must not include a path, query, or fragment.");
  }

  if (url.protocol === "https:") {
    return url;
  }

  if (url.protocol === "http:" && isLoopbackHostname(url.hostname)) {
    return url;
  }

  throw new Error("WATASU_CANARY_BASE_URL must use https outside local loopback targets.");
}

export function resolveHostedCanaryBaseUrl(input) {
  const rawEnvUrl = input.env["WATASU_CANARY_BASE_URL"];
  const rawArguments = input.argv.slice(2);
  const urlArguments = rawArguments[0] === "--" ? rawArguments.slice(1) : rawArguments;
  if (urlArguments.length > 1) {
    throw new Error("Usage: pnpm canary:hosted -- <https://host>");
  }

  const rawArgumentUrl = urlArguments[0];
  if (rawEnvUrl !== undefined && rawEnvUrl.trim() !== "" && rawArgumentUrl !== undefined) {
    throw new Error("Provide WATASU_CANARY_BASE_URL or one canary URL argument, not both.");
  }

  return parseHostedCanaryBaseUrl(rawArgumentUrl ?? rawEnvUrl);
}

export function resolveHostedCanaryTimeoutMs(env) {
  const rawTimeoutMs = env["WATASU_CANARY_TIMEOUT_MS"];
  if (rawTimeoutMs === undefined) {
    return defaultHostedCanaryTimeoutMs;
  }

  if (!/^[0-9]+$/.test(rawTimeoutMs)) {
    throw new Error("WATASU_CANARY_TIMEOUT_MS must be a positive integer.");
  }

  const timeoutMs = Number(rawTimeoutMs);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("WATASU_CANARY_TIMEOUT_MS must be a positive integer.");
  }

  if (timeoutMs > maxHostedCanaryTimeoutMs) {
    throw new Error("WATASU_CANARY_TIMEOUT_MS must be between 1 and 60000.");
  }

  return timeoutMs;
}

export function withHostedCanaryTimeout(init, timeoutMs) {
  return {
    ...init,
    signal: AbortSignal.timeout(timeoutMs)
  };
}

export function formatHostedCanaryRequestError(label, error) {
  if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return `${label} request timed out.`;
  }

  return `${label} request failed.`;
}

export function formatHostedCanaryResponseReadError(label, _error) {
  return `${label} response body could not be read.`;
}

function isLoopbackHostname(hostname) {
  return hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]";
}
