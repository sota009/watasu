export interface McpProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: ["header"];
}

export interface BuildMcpProtectedResourceMetadataInput {
  resource: string;
  authorizationServers: readonly string[];
  scopesSupported: readonly string[];
}

export interface BuildMcpUnauthorizedChallengeInput {
  resourceMetadataUrl: string;
  scopes: readonly string[];
}

export function buildMcpProtectedResourceMetadata(
  input: BuildMcpProtectedResourceMetadataInput
): McpProtectedResourceMetadata {
  assertCleanHttpsUrl(input.resource, "MCP resource URL");
  for (const authorizationServer of input.authorizationServers) {
    assertCleanHttpsUrl(authorizationServer, "MCP authorization server URL");
  }

  return {
    resource: input.resource,
    authorization_servers: [...input.authorizationServers],
    scopes_supported: [...input.scopesSupported],
    bearer_methods_supported: ["header"]
  };
}

export function buildMcpUnauthorizedChallenge(input: BuildMcpUnauthorizedChallengeInput): string {
  assertCleanHttpsUrl(input.resourceMetadataUrl, "MCP resource metadata URL");
  return `Bearer resource_metadata="${input.resourceMetadataUrl}", scope="${input.scopes.join(" ")}"`;
}

function assertCleanHttpsUrl(value: string, label: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute HTTPS URL.`);
  }

  if (url.protocol !== "https:" && !isLocalLoopbackHost(url.hostname)) {
    throw new Error(`${label} must be an absolute HTTPS URL.`);
  }

  if (url.search !== "" || url.hash !== "") {
    throw new Error(`${label} must not include query string or fragment.`);
  }
}

function isLocalLoopbackHost(hostname: string): boolean {
  const normalizedHostname = hostname.replace(/^\[|\]$/g, "");
  return normalizedHostname === "localhost" ||
    normalizedHostname === "127.0.0.1" ||
    normalizedHostname === "::1";
}
