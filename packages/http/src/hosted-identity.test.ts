import { describe, expect, test } from "vitest";
import {
  createMetadataLedgerReader,
  sha256Hash,
  type DeliveryLedgerRow
} from "@watasu/core";
import {
  createHostedMetadataApp,
  type HostedMetadataRequest
} from "./hosted-metadata.js";
import { createTrustedServiceIdentityResolver } from "./hosted-identity.js";

function createRequest(): HostedMetadataRequest {
  return {
    method: "GET",
    path: "/requests/request-a/ledger",
    headers: {},
    body: ""
  };
}

function createRows(): DeliveryLedgerRow[] {
  return [
    {
      request_id: "request-a",
      request_version: "v1",
      idempotency_key: "submit-001",
      submitted_at: "2026-06-14T11:59:00.000Z",
      delivered_at: "2026-06-14T12:00:00.000Z",
      delivery_status: "delivered",
      destination_url_hash: sha256Hash("https://receiver.example.com/watasu/intake"),
      encrypted_payload_hash: sha256Hash("base64url-ciphertext")
    }
  ];
}

function parseJson(body: string): unknown {
  return JSON.parse(body) as unknown;
}

describe("trusted service identity resolver", () => {
  test("test_resolver_normalizes_trusted_principal_roles", () => {
    // Arrange
    const resolver = createTrustedServiceIdentityResolver({
      resolvePrincipal: () => ({
        tenant_id: " tenant-a ",
        roles: ["publisher", "ledger_viewer", "ledger_viewer", "unknown"]
      })
    });

    // Act
    const identity = resolver(createRequest());

    // Assert
    expect(identity).toEqual({
      tenant_id: "tenant-a",
      roles: ["publisher", "ledger_viewer"]
    });
  });

  test("test_resolver_rejects_missing_principal", () => {
    // Arrange
    const resolver = createTrustedServiceIdentityResolver({
      resolvePrincipal: () => undefined
    });

    // Act
    const identity = resolver(createRequest());

    // Assert
    expect(identity).toBeUndefined();
  });

  test("test_resolver_rejects_empty_tenant_id", () => {
    // Arrange
    const resolver = createTrustedServiceIdentityResolver({
      resolvePrincipal: () => ({
        tenant_id: " ",
        roles: ["ledger_viewer"]
      })
    });

    // Act
    const identity = resolver(createRequest());

    // Assert
    expect(identity).toBeUndefined();
  });

  test("test_resolver_rejects_malformed_role_claims", () => {
    // Arrange
    const resolver = createTrustedServiceIdentityResolver({
      resolvePrincipal: () => ({
        tenant_id: "tenant-a",
        roles: "ledger_viewer" as unknown as string[]
      })
    });

    // Act
    const identity = resolver(createRequest());

    // Assert
    expect(identity).toBeUndefined();
  });

  test("test_metadata_app_uses_trusted_identity_resolver_for_ledger_reads", async () => {
    // Arrange
    const app = createHostedMetadataApp({
      ledgerReader: createMetadataLedgerReader({
        rows: createRows(),
        requestTenants: {
          "request-a": "tenant-a"
        },
        auditLog: {
          write() {}
        }
      }),
      resolveServiceIdentity: createTrustedServiceIdentityResolver({
        resolvePrincipal: () => ({
          tenant_id: "tenant-a",
          roles: ["unknown", "ledger_viewer"]
        })
      })
    });

    // Act
    const response = await app.handle(createRequest());

    // Assert
    expect(response.status).toBe(200);
    expect(parseJson(response.body)).toMatchObject({
      ok: true,
      rows: [
        {
          request_id: "request-a",
          delivery_status: "delivered"
        }
      ]
    });
  });
});
