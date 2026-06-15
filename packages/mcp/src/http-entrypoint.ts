import type {
  IncomingMessage,
  ServerResponse
} from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildMcpUnauthorizedChallenge } from "./deployment.js";

export interface HostedMcpHttpTransport {
  handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void>;
}

export interface CreateHostedMcpHttpEntrypointInput {
  endpointPath: string;
  allowedOrigins: readonly string[];
  resourceMetadataUrl: string;
  scopes: readonly string[];
  authorizeBearerToken(input: {
    token: string;
    requiredScopes: readonly string[];
  }): HostedMcpBearerAuthorizationResult | Promise<HostedMcpBearerAuthorizationResult>;
  transport?: HostedMcpHttpTransport | undefined;
}

export type HostedMcpHttpEntrypoint = (
  request: IncomingMessage,
  response: ServerResponse
) => Promise<void>;

export type HostedMcpBearerAuthorizationResult =
  | {
      ok: true;
      scopes: readonly string[];
    }
  | {
      ok: false;
    };

const supportedProtocolVersion = "2025-11-25";

export function createHostedMcpHttpEntrypoint(
  input: CreateHostedMcpHttpEntrypointInput
): HostedMcpHttpEntrypoint {
  const transport = input.transport ?? new StreamableHTTPServerTransport();

  return async (request, response) => {
    const path = request.url === undefined ? "/" : new URL(request.url, "http://localhost").pathname;
    if (path !== input.endpointPath) {
      writeJson(response, 404, {
        ok: false,
        error: {
          code: "not_found",
          message: "Hosted MCP endpoint was not found."
        }
      });
      return;
    }

    if (!["GET", "POST", "DELETE"].includes(request.method ?? "")) {
      writeJson(response, 405, {
        ok: false,
        error: {
          code: "method_not_allowed",
          message: "Hosted MCP endpoint supports GET, POST, and DELETE."
        }
      });
      return;
    }

    const origin = headerValue(request, "origin");
    if (origin !== undefined && !input.allowedOrigins.includes(origin)) {
      writeJson(response, 403, {
        ok: false,
        error: {
          code: "origin_not_allowed",
          message: "Origin is not allowed for hosted MCP transport."
        }
      });
      return;
    }

    const authorization = headerValue(request, "authorization");
    if (authorization === undefined || !authorization.startsWith("Bearer ")) {
      response.setHeader(
        "WWW-Authenticate",
        buildMcpUnauthorizedChallenge({
          resourceMetadataUrl: input.resourceMetadataUrl,
          scopes: input.scopes
        })
      );
      writeJson(response, 401, {
        ok: false,
        error: {
          code: "mcp_transport_auth_required",
          message: "Hosted MCP HTTP transport requires Authorization: Bearer credentials."
        }
      });
      return;
    }

    const token = authorization.slice("Bearer ".length).trim();
    if (token.length === 0) {
      response.setHeader(
        "WWW-Authenticate",
        buildMcpUnauthorizedChallenge({
          resourceMetadataUrl: input.resourceMetadataUrl,
          scopes: input.scopes
        })
      );
      writeJson(response, 401, {
        ok: false,
        error: {
          code: "mcp_transport_auth_invalid",
          message: "Hosted MCP HTTP transport requires a valid Bearer token."
        }
      });
      return;
    }

    const authorizationResult = await input.authorizeBearerToken({
      token,
      requiredScopes: input.scopes
    });
    if (!authorizationResult.ok) {
      response.setHeader(
        "WWW-Authenticate",
        buildMcpUnauthorizedChallenge({
          resourceMetadataUrl: input.resourceMetadataUrl,
          scopes: input.scopes
        })
      );
      writeJson(response, 401, {
        ok: false,
        error: {
          code: "mcp_transport_auth_invalid",
          message: "Hosted MCP HTTP transport requires a valid Bearer token."
        }
      });
      return;
    }

    const authorizedScopes = new Set(authorizationResult.scopes);
    const missingScope = input.scopes.find((scope) => !authorizedScopes.has(scope));
    if (missingScope !== undefined) {
      writeJson(response, 403, {
        ok: false,
        error: {
          code: "mcp_transport_scope_required",
          message: "Hosted MCP HTTP transport Bearer token is missing a required scope."
        }
      });
      return;
    }

    const protocolVersion = headerValue(request, "mcp-protocol-version");
    if (protocolVersion !== undefined && protocolVersion !== supportedProtocolVersion) {
      writeJson(response, 400, {
        ok: false,
        error: {
          code: "unsupported_mcp_protocol_version",
          message: "Hosted MCP HTTP transport supports MCP-Protocol-Version 2025-11-25."
        }
      });
      return;
    }

    await transport.handleRequest(request, response);
  };
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  if (Array.isArray(value)) {
    return value.join(", ");
  }

  return value;
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8"
  });
  response.end(`${JSON.stringify(body)}\n`);
}
