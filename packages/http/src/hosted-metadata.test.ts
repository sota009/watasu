import { describe, expect, test } from "vitest";
import {
  canonicalizeJson,
  createMetadataLedgerReader,
  sha256Hash,
  type DeliveryLedgerRow
} from "@watasu/core";
import {
  createHostedMetadataApp,
  type HostedMetadataRequest
} from "./hosted-metadata.js";

const now = "2026-06-14T12:00:00.000Z";

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
      delivered_at: now,
      delivery_status: "delivered",
      destination_url_hash: sha256Hash("https://receiver.example.com/watasu/intake"),
      encrypted_payload_hash: sha256Hash("base64url-ciphertext")
    }
  ];
}

function parseJson(body: string): unknown {
  return JSON.parse(body) as unknown;
}

describe("hosted metadata HTTP app", () => {
  test("test_get_ledger_without_service_identity_returns_auth_required_without_reader_call", async () => {
    // Arrange
    let readCount = 0;
    const app = createHostedMetadataApp({
      ledgerReader: {
        readDeliveryMetadata() {
          readCount += 1;
          return {
            ok: true,
            rows: []
          };
        }
      },
      resolveServiceIdentity: () => undefined
    });

    // Act
    const response = await app.handle(createRequest());

    // Assert
    expect(response.status).toBe(401);
    expect(parseJson(response.body)).toEqual({
      ok: false,
      status: "auth_required",
      error: {
        code: "service_identity_required",
        message: "Hosted metadata ledger reads require an authenticated service identity."
      }
    });
    expect(readCount).toBe(0);
  });

  test("test_get_ledger_as_ledger_viewer_returns_metadata_without_payload_body", async () => {
    // Arrange
    const auditEvents: unknown[] = [];
    const app = createHostedMetadataApp({
      ledgerReader: createMetadataLedgerReader({
        rows: createRows(),
        requestTenants: {
          "request-a": "tenant-a"
        },
        auditLog: {
          write(event) {
            auditEvents.push(event);
          }
        }
      }),
      resolveServiceIdentity: () => ({
        tenant_id: "tenant-a",
        roles: ["ledger_viewer"]
      })
    });

    // Act
    const response = await app.handle(createRequest());
    const responseJson = canonicalizeJson(parseJson(response.body));

    // Assert
    expect(response.status).toBe(200);
    expect(parseJson(response.body)).toMatchObject({
      ok: true,
      rows: [
        {
          request_id: "request-a",
          delivery_status: "delivered",
          encrypted_payload_hash: expect.any(String)
        }
      ]
    });
    expect(auditEvents).toMatchObject([
      {
        event: "watasu.metadata_ledger_read",
        tenant_id: "tenant-a",
        request_id: "request-a",
        role: "ledger_viewer",
        row_count: 1
      }
    ]);
    expect(responseJson).not.toContain("base64url-ciphertext");
    expect(responseJson).not.toContain("\"encrypted_payload\"");
  });

  test("test_get_ledger_as_publisher_only_returns_forbidden", async () => {
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
      resolveServiceIdentity: () => ({
        tenant_id: "tenant-a",
        roles: ["publisher"]
      })
    });

    // Act
    const response = await app.handle(createRequest());

    // Assert
    expect(response.status).toBe(403);
    expect(parseJson(response.body)).toMatchObject({
      ok: false,
      status: "forbidden",
      error: {
        code: "ledger_role_required"
      }
    });
  });

  test("test_get_ledger_for_another_tenant_returns_not_found_without_existence_leak", async () => {
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
      resolveServiceIdentity: () => ({
        tenant_id: "tenant-b",
        roles: ["ledger_viewer"]
      })
    });

    // Act
    const response = await app.handle(createRequest());

    // Assert
    expect(response.status).toBe(404);
    expect(parseJson(response.body)).toEqual({
      ok: false,
      status: "not_found",
      error: {
        code: "request_not_found",
        message: "Request was not found."
      }
    });
  });

  test("test_get_ledger_with_malformed_request_id_encoding_returns_not_found", async () => {
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
      resolveServiceIdentity: () => ({
        tenant_id: "tenant-a",
        roles: ["ledger_viewer"]
      })
    });

    // Act
    const response = await app.handle({
      method: "GET",
      path: "/requests/%/ledger",
      headers: {},
      body: ""
    });

    // Assert
    expect(response.status).toBe(404);
    expect(parseJson(response.body)).toMatchObject({
      ok: false,
      error: {
        code: "not_found"
      }
    });
  });
});
