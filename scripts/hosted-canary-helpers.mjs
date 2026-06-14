export const hostedCanaryRequiredHeaders = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff"
};

export const hostedCanaryUnpublishedRequestId = "__watasu_canary_missing__";

export function buildHostedCanaryCheckUrls(baseUrl) {
  return {
    health: new URL("/health", baseUrl).toString(),
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
    ).toString()
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

function isLoopbackHostname(hostname) {
  return hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]";
}
