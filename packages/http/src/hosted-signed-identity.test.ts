import { describe, expect, test } from "vitest";
import {
  InMemoryRequestVersionRepository,
  createMetadataLedgerReader,
  type PublishOwnershipVerification,
  type RequestDefinition
} from "@watasu/core";
import { createHostedProductionBootstrapApp } from "./hosted-bootstrap.js";
import {
  createSignedServiceIdentityHeaders,
  createSignedServiceIdentityPrincipalResolver
} from "./hosted-signed-identity.js";
import type { HostedProductionRequest } from "./hosted-production.js";

const signingSecret = "test-deployment-identity-secret-with-enough-entropy";
const now = new Date("2026-06-15T00:00:00.000Z");

const definition: RequestDefinition = {
  name: "event-attendee-intake",
  schema_version: "2026-06-14",
  description: "Collect attendee details for ExampleConf.",
  fields: [
    {
      id: "email",
      type: "string",
      format: "email",
      required: true,
      purpose: "Send event updates.",
      sensitivity: "moderate"
    }
  ],
  consent: {
    text: "ExampleConf uses this information only for event operations."
  },
  destination: {
    type: "webhook",
    url: "https://receiver.example.com/watasu/intake"
  },
  retention: {
    destination_policy: "Delete within 30 days after the event."
  },
  encryption: {
    mode: "required",
    algorithm: "JWE",
    key_management: "ECDH-ES+A256KW",
    content_encryption: "A256GCM",
    service_key_id: "jwk-thumbprint:sha256:example",
    public_key_jwk: {
      kty: "EC",
      crv: "P-256",
      x: "base64url-x",
      y: "base64url-y"
    }
  },
  metadata_retention: {
    days: 90
  },
  trust_profile: "human_consent"
};

function createRequest(headers: Record<string, string | undefined>): HostedProductionRequest {
  return {
    method: "POST",
    path: "/requests/event-attendee-intake/publish",
    headers,
    body: JSON.stringify({
      tenant_id: "body-tenant-must-not-be-trusted",
      roles: ["publisher"]
    })
  };
}

function createOwnership(): PublishOwnershipVerification {
  return {
    verifiedServiceKeyIds: ["jwk-thumbprint:sha256:example"],
    verifiedWebhookOrigins: ["https://receiver.example.com"]
  };
}

describe("hosted signed service identity resolver", () => {
  test("test_resolver_accepts_valid_signed_identity_headers", () => {
    // Arrange
    const headers = createSignedServiceIdentityHeaders({
      tenantId: "tenant-a",
      roles: ["publisher", "ledger_viewer"],
      issuedAt: now,
      signingSecret
    });
    const resolver = createSignedServiceIdentityPrincipalResolver({
      signingSecret,
      now: () => now,
      maxSkewSeconds: 60
    });

    // Act
    const principal = resolver(createRequest(headers));

    // Assert
    expect(principal).toEqual({
      tenant_id: "tenant-a",
      roles: ["publisher", "ledger_viewer"]
    });
  });

  test("test_resolver_rejects_tampered_signature", () => {
    // Arrange
    const headers = createSignedServiceIdentityHeaders({
      tenantId: "tenant-a",
      roles: ["publisher"],
      issuedAt: now,
      signingSecret
    });
    const resolver = createSignedServiceIdentityPrincipalResolver({
      signingSecret,
      now: () => now,
      maxSkewSeconds: 60
    });

    // Act
    const principal = resolver(createRequest({
      ...headers,
      "x-watasu-service-signature": "sha256=invalid"
    }));

    // Assert
    expect(principal).toBeUndefined();
  });

  test("test_resolver_rejects_stale_identity_headers", () => {
    // Arrange
    const headers = createSignedServiceIdentityHeaders({
      tenantId: "tenant-a",
      roles: ["publisher"],
      issuedAt: new Date("2026-06-14T23:58:00.000Z"),
      signingSecret
    });
    const resolver = createSignedServiceIdentityPrincipalResolver({
      signingSecret,
      now: () => now,
      maxSkewSeconds: 60
    });

    // Act
    const principal = resolver(createRequest(headers));

    // Assert
    expect(principal).toBeUndefined();
  });

  test("test_bootstrap_uses_signed_identity_headers_for_publish", async () => {
    // Arrange
    const repository = new InMemoryRequestVersionRepository();
    const resolvePrincipal = createSignedServiceIdentityPrincipalResolver({
      signingSecret,
      now: () => now,
      maxSkewSeconds: 60
    });
    const app = createHostedProductionBootstrapApp({
      repository,
      publicBaseUrl: "https://api.watasu.ai",
      deliverySigningSecret: "test-deployment-signing-secret-with-enough-entropy",
      ledgerReader: createMetadataLedgerReader({
        rows: [],
        requestTenants: {},
        auditLog: {
          write() {}
        }
      }),
      resolvePrincipal,
      resolveOwnershipVerification: () => createOwnership()
    });

    // Act
    const response = await app.handle({
      ...createRequest(createSignedServiceIdentityHeaders({
        tenantId: "tenant-a",
        roles: ["publisher"],
        issuedAt: now,
        signingSecret
      })),
      body: JSON.stringify({
        definition,
        confirmed: true,
        tenant_id: "attacker-tenant"
      })
    });

    // Assert
    expect(response.status).toBe(201);
    expect(repository.list("event-attendee-intake")).toHaveLength(1);
  });
});
