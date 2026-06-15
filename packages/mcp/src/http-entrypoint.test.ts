import { describe, expect, test } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHostedMcpHttpEntrypoint } from "./http-entrypoint.js";

class ResponseRecorder {
  statusCode = 200;
  headers: Record<string, string> = {};
  body = "";
  headersSent = false;

  setHeader(name: string, value: string): void {
    this.headers[name.toLowerCase()] = value;
  }

  writeHead(statusCode: number, headers: Record<string, string> = {}): void {
    this.statusCode = statusCode;
    for (const [name, value] of Object.entries(headers)) {
      this.setHeader(name, value);
    }
  }

  end(body = ""): void {
    this.headersSent = true;
    this.body += body;
  }
}

function createRequest(input: {
  method: string;
  url: string;
  headers?: Record<string, string | undefined>;
}): IncomingMessage {
  return {
    method: input.method,
    url: input.url,
    headers: input.headers ?? {}
  } as IncomingMessage;
}

function createEntrypoint(delegatedRequests: string[]) {
  return createHostedMcpHttpEntrypoint({
    endpointPath: "/mcp",
    allowedOrigins: ["https://app.example.com"],
    resourceMetadataUrl: "https://mcp.example.com/.well-known/oauth-protected-resource",
    scopes: ["watasu:publish", "watasu:ledger:read"],
    authorizeBearerToken({ token, requiredScopes }) {
      if (token === "valid-token") {
        return {
          ok: true,
          scopes: [...requiredScopes]
        };
      }

      if (token === "ledger-only-token") {
        return {
          ok: true,
          scopes: ["watasu:ledger:read"]
        };
      }

      return {
        ok: false
      };
    },
    transport: {
      async handleRequest(request) {
        delegatedRequests.push(`${request.method ?? ""} ${request.url ?? ""}`);
      }
    }
  });
}

describe("hosted MCP HTTP entrypoint", () => {
  test("test_missing_authorization_returns_401_challenge_without_delegating", async () => {
    // Arrange
    const delegatedRequests: string[] = [];
    const entrypoint = createEntrypoint(delegatedRequests);
    const response = new ResponseRecorder();

    // Act
    await entrypoint(createRequest({
      method: "POST",
      url: "/mcp",
      headers: {
        origin: "https://app.example.com",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-11-25"
      }
    }), response as unknown as ServerResponse);

    // Assert
    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toBe(
      "Bearer resource_metadata=\"https://mcp.example.com/.well-known/oauth-protected-resource\", scope=\"watasu:publish watasu:ledger:read\""
    );
    expect(delegatedRequests).toEqual([]);
  });

  test("test_invalid_origin_returns_403_without_delegating", async () => {
    // Arrange
    const delegatedRequests: string[] = [];
    const entrypoint = createEntrypoint(delegatedRequests);
    const response = new ResponseRecorder();

    // Act
    await entrypoint(createRequest({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: "Bearer token",
        origin: "https://evil.example.com",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-11-25"
      }
    }), response as unknown as ServerResponse);

    // Assert
    expect(response.statusCode).toBe(403);
    expect(delegatedRequests).toEqual([]);
  });

  test("test_authorized_streamable_http_request_delegates_to_transport", async () => {
    // Arrange
    const delegatedRequests: string[] = [];
    const entrypoint = createEntrypoint(delegatedRequests);
    const response = new ResponseRecorder();

    // Act
    await entrypoint(createRequest({
      method: "POST",
      url: "/mcp?ignored=true",
      headers: {
        authorization: "Bearer valid-token",
        origin: "https://app.example.com",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-11-25"
      }
    }), response as unknown as ServerResponse);

    // Assert
    expect(delegatedRequests).toEqual(["POST /mcp?ignored=true"]);
  });

  test("test_arbitrary_bearer_token_returns_401_without_delegating", async () => {
    // Arrange
    const delegatedRequests: string[] = [];
    const entrypoint = createEntrypoint(delegatedRequests);
    const response = new ResponseRecorder();

    // Act
    await entrypoint(createRequest({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: "Bearer arbitrary-token",
        origin: "https://app.example.com",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-11-25"
      }
    }), response as unknown as ServerResponse);

    // Assert
    expect(response.statusCode).toBe(401);
    expect(response.body).toContain("\"code\":\"mcp_transport_auth_invalid\"");
    expect(delegatedRequests).toEqual([]);
  });

  test("test_bearer_token_missing_required_scope_returns_403_without_delegating", async () => {
    // Arrange
    const delegatedRequests: string[] = [];
    const entrypoint = createEntrypoint(delegatedRequests);
    const response = new ResponseRecorder();

    // Act
    await entrypoint(createRequest({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: "Bearer ledger-only-token",
        origin: "https://app.example.com",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-11-25"
      }
    }), response as unknown as ServerResponse);

    // Assert
    expect(response.statusCode).toBe(403);
    expect(response.body).toContain("\"code\":\"mcp_transport_scope_required\"");
    expect(delegatedRequests).toEqual([]);
  });
});
