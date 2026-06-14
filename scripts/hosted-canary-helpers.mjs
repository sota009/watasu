export const hostedCanaryRequiredHeaders = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff"
};

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

  if (url.protocol === "https:") {
    return url;
  }

  if (url.protocol === "http:" && isLoopbackHostname(url.hostname)) {
    return url;
  }

  throw new Error("WATASU_CANARY_BASE_URL must use https outside local loopback targets.");
}

function isLoopbackHostname(hostname) {
  return hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]";
}
