import { describe, expect, test } from "vitest";
import {
  buildMcpProtectedResourceMetadata,
  buildMcpUnauthorizedChallenge
} from "./deployment.js";

describe("hosted MCP deployment metadata", () => {
  test("test_protected_resource_metadata_includes_authorization_server_and_scopes", () => {
    // Arrange
    const metadata = buildMcpProtectedResourceMetadata({
      resource: "https://mcp.example.com/mcp",
      authorizationServers: ["https://auth.example.com"],
      scopesSupported: ["watasu:publish", "watasu:ledger:read"]
    });

    // Act / Assert
    expect(metadata).toEqual({
      resource: "https://mcp.example.com/mcp",
      authorization_servers: ["https://auth.example.com"],
      scopes_supported: ["watasu:publish", "watasu:ledger:read"],
      bearer_methods_supported: ["header"]
    });
  });

  test("test_unauthorized_challenge_points_to_resource_metadata", () => {
    // Arrange
    const challenge = buildMcpUnauthorizedChallenge({
      resourceMetadataUrl: "https://mcp.example.com/.well-known/oauth-protected-resource",
      scopes: ["watasu:publish"]
    });

    // Act / Assert
    expect(challenge).toBe(
      "Bearer resource_metadata=\"https://mcp.example.com/.well-known/oauth-protected-resource\", scope=\"watasu:publish\""
    );
  });

  test("test_unauthorized_challenge_allows_local_loopback_metadata_url", () => {
    // Arrange
    const challenge = buildMcpUnauthorizedChallenge({
      resourceMetadataUrl: "http://127.0.0.1:8799/.well-known/oauth-protected-resource",
      scopes: ["watasu:publish"]
    });

    // Act / Assert
    expect(challenge).toBe(
      "Bearer resource_metadata=\"http://127.0.0.1:8799/.well-known/oauth-protected-resource\", scope=\"watasu:publish\""
    );
  });

  test("test_unauthorized_challenge_rejects_query_string_metadata_url", () => {
    expect(() =>
      buildMcpUnauthorizedChallenge({
        resourceMetadataUrl: "https://mcp.example.com/.well-known/oauth-protected-resource?token=leaky",
        scopes: ["watasu:publish"]
      })
    ).toThrow("MCP resource metadata URL must not include query string or fragment.");
  });
});
