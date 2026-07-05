import { describe, expect, test } from "vitest";
import {
  canonicalizeJson,
  InMemoryPublishedRequestRegistry,
  InMemoryPublishInviteStore,
  InMemoryRequestVersionRepository,
  createMetadataLedgerReader,
  sha256Hash,
  type DeliveryLedgerRow,
  type PublishOwnershipVerification,
  type RequestDefinition
} from "@watasu/core";
import { createHostedProductionBootstrapApp } from "./hosted-bootstrap.js";
import type { HostedProductionRequest } from "./hosted-production.js";

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
  trust_profile: "human_consent",
  metadata_retention: {
    days: 90
  }
};

function createRequest(input: {
  method: string;
  path: string;
  body?: unknown;
  headers?: Record<string, string | undefined>;
}): HostedProductionRequest {
  return {
    method: input.method,
    path: input.path,
    headers: input.headers ?? {},
    body: input.body === undefined ? "" : JSON.stringify(input.body)
  };
}

function createOwnership(): PublishOwnershipVerification {
  return {
    verifiedServiceKeyIds: ["jwk-thumbprint:sha256:example"],
    verifiedWebhookOrigins: ["https://receiver.example.com"]
  };
}

function createRows(): DeliveryLedgerRow[] {
  return [
    {
      request_id: "event-attendee-intake",
      request_version: "v1",
      idempotency_key: "submit-001",
      submitted_at: "2026-06-14T11:59:00.000Z",
      delivered_at: "2026-06-14T12:00:00.000Z",
      delivery_status: "delivered",
      destination_url_hash: sha256Hash("https://receiver.example.com/watasu/intake"),
      encrypted_payload_hash: sha256Hash("encrypted-payload")
    }
  ];
}

function parseJson(body: string): unknown {
  return JSON.parse(body) as unknown;
}

function createA2aSubmissionBody(input: {
  published: ReturnType<InMemoryRequestVersionRepository["publish"]>;
}) {
  const encryptedPayload = {
    protected: "base64url-protected",
    iv: "base64url-iv",
    ciphertext: "base64url-ciphertext",
    tag: "base64url-tag"
  };

  return {
    message: {
      role: "ROLE_USER",
      messageId: "submit-001",
      parts: [
        {
          type: "data",
          mediaType: "application/json",
          data: {
            request_id: input.published.request_id,
            request_version: input.published.request_version,
            schema_hash: input.published.hashes.schema_hash,
            consent_receipt_hash: input.published.hashes.consent_text_hash,
            idempotency_key: "submit-001",
            submitted_at: "2026-06-15T00:00:00.000Z",
            service_key_id: input.published.definition.encryption.service_key_id,
            encrypted_payload: encryptedPayload,
            encrypted_payload_hash: sha256Hash(canonicalizeJson(encryptedPayload))
          }
        }
      ]
    }
  };
}

describe("hosted production bootstrap app", () => {
  test("test_bootstrap_uses_trusted_principal_for_publish_and_ledger_routes", async () => {
    const repository = new InMemoryRequestVersionRepository();
    const auditEvents: unknown[] = [];
    const app = createHostedProductionBootstrapApp({
      repository,
      publicBaseUrl: "https://api.watasu.ai",
      deliverySigningSecret: "test-deployment-signing-secret-with-enough-entropy",
      ledgerReader: createMetadataLedgerReader({
        rows: createRows(),
        requestTenants: {
          "event-attendee-intake": "tenant-a"
        },
        auditLog: {
          write(event) {
            auditEvents.push(event);
          }
        }
      }),
      resolvePrincipal: () => ({
        tenant_id: "tenant-a",
        roles: ["publisher", "ledger_viewer"]
      }),
      resolveOwnershipVerification: () => createOwnership()
    });

    const publishResponse = await app.handle(createRequest({
      method: "POST",
      path: "/requests/event-attendee-intake/publish",
      body: {
        definition,
        confirmed: true,
        tenant_id: "attacker-tenant",
        roles: ["publisher", "ledger_viewer"]
      }
    }));
    const ledgerResponse = await app.handle(createRequest({
      method: "GET",
      path: "/requests/event-attendee-intake/ledger"
    }));
    const agentCardResponse = await app.handle(createRequest({
      method: "GET",
      path: "/requests/event-attendee-intake/agent-card.json"
    }));

    expect(publishResponse.status).toBe(201);
    expect(parseJson(publishResponse.body)).toMatchObject({
      ok: true,
      published: {
        request_id: "event-attendee-intake"
      }
    });
    expect(repository.list("event-attendee-intake")).toHaveLength(1);
    expect(agentCardResponse.status).toBe(200);
    expect(parseJson(agentCardResponse.body)).toMatchObject({
      supportedInterfaces: [
        {
          url: "https://api.watasu.ai/requests/event-attendee-intake/submit"
        }
      ]
    });
    expect(agentCardResponse.body).not.toContain("receiver.example.com/private");
    expect(ledgerResponse.status).toBe(200);
    expect(parseJson(ledgerResponse.body)).toMatchObject({
      ok: true,
      rows: [
        {
          request_id: "event-attendee-intake"
        }
      ]
    });
    expect(auditEvents).toMatchObject([
      {
        tenant_id: "tenant-a",
        role: "ledger_viewer"
      }
    ]);
    expect(JSON.stringify(parseJson(ledgerResponse.body))).not.toContain("\"encrypted_payload\"");
    expect(JSON.stringify(parseJson(ledgerResponse.body))).not.toContain("base64url-ciphertext");
  });

  test("test_bootstrap_rejects_routes_when_trusted_principal_is_missing", async () => {
    const app = createHostedProductionBootstrapApp({
      repository: new InMemoryRequestVersionRepository(),
      publicBaseUrl: "https://api.watasu.ai",
      deliverySigningSecret: "test-deployment-signing-secret-with-enough-entropy",
      ledgerReader: createMetadataLedgerReader({
        rows: createRows(),
        requestTenants: {
          "event-attendee-intake": "tenant-a"
        },
        auditLog: {
          write() {}
        }
      }),
      resolvePrincipal: () => undefined,
      resolveOwnershipVerification: () => createOwnership()
    });

    const publishResponse = await app.handle(createRequest({
      method: "POST",
      path: "/requests/event-attendee-intake/publish",
      body: {
        definition,
        confirmed: true
      }
    }));
    const ledgerResponse = await app.handle(createRequest({
      method: "GET",
      path: "/requests/event-attendee-intake/ledger"
    }));

    expect(publishResponse.status).toBe(401);
    expect(ledgerResponse.status).toBe(401);
  });

  test("test_bootstrap_allows_invite_token_to_publish_and_records_owner", async () => {
    const repository = new InMemoryRequestVersionRepository();
    const inviteStore = new InMemoryPublishInviteStore();
    const requestRegistry = new InMemoryPublishedRequestRegistry();
    inviteStore.issueInvite({
      token: "friend_invite_token",
      ownerId: "owner-a",
      tenantId: "tenant-a",
      roles: ["publisher"],
      expiresAt: "2026-06-17T00:00:00.000Z",
      maxPublishCount: 1
    });
    const app = createHostedProductionBootstrapApp({
      repository,
      requestRegistry,
      publishInviteStore: inviteStore,
      publicBaseUrl: "https://api.watasu.ai",
      deliverySigningSecret: "test-deployment-signing-secret-with-enough-entropy",
      clock: () => new Date("2026-06-16T00:00:00.000Z"),
      ledgerReader: createMetadataLedgerReader({
        rows: [],
        requestTenants: {},
        auditLog: {
          write() {}
        }
      }),
      resolvePrincipal: () => undefined,
      resolveOwnershipVerification: () => createOwnership()
    });

    const response = await app.handle(createRequest({
      method: "POST",
      path: "/requests/event-attendee-intake/publish",
      headers: {
        authorization: "Bearer friend_invite_token"
      },
      body: {
        definition,
        confirmed: true
      }
    }));

    expect(response.status).toBe(201);
    expect(inviteStore.listRecords()[0]?.used_count).toBe(1);
    expect(await requestRegistry.listRecords()).toMatchObject([
      {
        tenant_id: "tenant-a",
        owner_id: "owner-a",
        request_id: "event-attendee-intake",
        request_version: "v1",
        retired_at: null
      }
    ]);
    expect(response.body).not.toContain("friend_invite_token");
  });

  test("test_bootstrap_rejects_invite_publish_quota_exceeded", async () => {
    const inviteStore = new InMemoryPublishInviteStore();
    inviteStore.issueInvite({
      token: "single_use_invite_token",
      ownerId: "owner-a",
      tenantId: "tenant-a",
      roles: ["publisher"],
      expiresAt: "2026-06-17T00:00:00.000Z",
      maxPublishCount: 1
    });
    inviteStore.incrementPublishCount("single_use_invite_token");
    const app = createHostedProductionBootstrapApp({
      repository: new InMemoryRequestVersionRepository(),
      publishInviteStore: inviteStore,
      publicBaseUrl: "https://api.watasu.ai",
      deliverySigningSecret: "test-deployment-signing-secret-with-enough-entropy",
      clock: () => new Date("2026-06-16T00:00:00.000Z"),
      ledgerReader: createMetadataLedgerReader({
        rows: [],
        requestTenants: {},
        auditLog: {
          write() {}
        }
      }),
      resolvePrincipal: () => undefined,
      resolveOwnershipVerification: () => createOwnership()
    });

    const response = await app.handle(createRequest({
      method: "POST",
      path: "/requests/event-attendee-intake/publish",
      headers: {
        authorization: "Bearer single_use_invite_token"
      },
      body: {
        definition,
        confirmed: true
      }
    }));

    expect(response.status).toBe(403);
    expect(parseJson(response.body)).toMatchObject({
      ok: false,
      status: "forbidden",
      error: {
        code: "invite_quota_exceeded"
      }
    });
  });

  test("test_bootstrap_owner_and_request_admin_can_retire_requests", async () => {
    const repository = new InMemoryRequestVersionRepository();
    const requestRegistry = new InMemoryPublishedRequestRegistry();
    const inviteStore = new InMemoryPublishInviteStore();
    inviteStore.issueInvite({
      token: "owner_invite_token",
      ownerId: "owner-a",
      tenantId: "tenant-a",
      roles: ["publisher"],
      expiresAt: "2026-06-17T00:00:00.000Z",
      maxPublishCount: 2
    });
    const app = createHostedProductionBootstrapApp({
      repository,
      requestRegistry,
      publishInviteStore: inviteStore,
      publicBaseUrl: "https://api.watasu.ai",
      deliverySigningSecret: "test-deployment-signing-secret-with-enough-entropy",
      clock: () => new Date("2026-06-16T00:00:00.000Z"),
      ledgerReader: createMetadataLedgerReader({
        rows: [],
        requestTenants: {},
        auditLog: {
          write() {}
        }
      }),
      resolvePrincipal: (request) => {
        if (request.headers.authorization === "Bearer admin_token") {
          return {
            tenant_id: "tenant-admin",
            roles: ["request_admin"]
          };
        }

        if (request.headers.authorization === "Bearer other_owner_token") {
          return {
            tenant_id: "tenant-a",
            owner_id: "owner-b",
            roles: ["publisher"]
          };
        }

        return undefined;
      },
      resolveOwnershipVerification: () => createOwnership()
    });

    await app.handle(createRequest({
      method: "POST",
      path: "/requests/event-attendee-intake/publish",
      headers: {
        authorization: "Bearer owner_invite_token"
      },
      body: {
        definition,
        confirmed: true
      }
    }));
    const forbiddenResponse = await app.handle(createRequest({
      method: "POST",
      path: "/requests/event-attendee-intake/retire",
      headers: {
        authorization: "Bearer other_owner_token"
      }
    }));
    const ownerResponse = await app.handle(createRequest({
      method: "POST",
      path: "/requests/event-attendee-intake/retire",
      headers: {
        authorization: "Bearer owner_invite_token"
      }
    }));

    expect(forbiddenResponse.status).toBe(403);
    expect(ownerResponse.status).toBe(200);

    const adminRegistry = new InMemoryPublishedRequestRegistry();
    adminRegistry.recordPublished({
      tenant_id: "tenant-a",
      owner_id: "owner-a",
      request_id: "admin-retired-intake",
      request_version: "v1",
      published_at: "2026-06-16T00:00:00.000Z",
      retired_at: null
    });
    const adminApp = createHostedProductionBootstrapApp({
      repository: new InMemoryRequestVersionRepository(),
      requestRegistry: adminRegistry,
      publicBaseUrl: "https://api.watasu.ai",
      deliverySigningSecret: "test-deployment-signing-secret-with-enough-entropy",
      clock: () => new Date("2026-06-16T01:00:00.000Z"),
      ledgerReader: createMetadataLedgerReader({
        rows: [],
        requestTenants: {},
        auditLog: {
          write() {}
        }
      }),
      resolvePrincipal: () => ({
        tenant_id: "tenant-admin",
        roles: ["request_admin"]
      }),
      resolveOwnershipVerification: () => createOwnership()
    });
    const adminResponse = await adminApp.handle(createRequest({
      method: "POST",
      path: "/requests/admin-retired-intake/retire"
    }));

    expect(adminResponse.status).toBe(200);
  });

  test("test_bootstrap_passes_principal_tenant_to_capability_resolver_for_submit", async () => {
    const repository = new InMemoryRequestVersionRepository();
    const capabilityInputs: unknown[] = [];
    const deliveryRequests: unknown[] = [];
    const humanConsentDefinition: RequestDefinition = {
      ...definition,
      trust_profile: "human_consent"
    };
    const app = createHostedProductionBootstrapApp({
      repository,
      publicBaseUrl: "https://api.watasu.ai",
      deliverySigningSecret: "test-deployment-signing-secret-with-enough-entropy",
      deliveryClient: {
        async post(request) {
          deliveryRequests.push(request);
          return {
            status: 204
          };
        }
      },
      ledgerReader: createMetadataLedgerReader({
        rows: [],
        requestTenants: {},
        auditLog: {
          write() {}
        }
      }),
      resolvePrincipal: () => ({
        tenant_id: "tenant-a",
        roles: ["publisher"]
      }),
      resolveOwnershipVerification: () => createOwnership(),
      resolveCapability(input) {
        capabilityInputs.push(input);
        return {
          url: input.capabilityUrl,
          revoked: true
        };
      },
      clock: () => new Date("2026-06-15T00:00:01.000Z")
    });

    const publishResponse = await app.handle(createRequest({
      method: "POST",
      path: "/requests/event-attendee-intake/publish",
      body: {
        definition: humanConsentDefinition,
        confirmed: true
      }
    }));
    const published = repository.list("event-attendee-intake")[0];
    if (published === undefined) {
      throw new Error("expected published request version");
    }
    const submitResponse = await app.handle(createRequest({
      method: "POST",
      path: "/requests/event-attendee-intake/submit",
      headers: {
        "content-type": "application/a2a+json",
        "a2a-version": "1.0",
        "a2a-extensions": "https://watasu.dev/extensions/encrypted-intake/v1"
      },
      body: createA2aSubmissionBody({
        published
      })
    }));

    expect(publishResponse.status).toBe(201);
    expect(submitResponse.status).toBe(400);
    expect(parseJson(submitResponse.body)).toMatchObject({
      ok: false,
      status: "rejected",
      error: {
        code: "capability_revoked"
      }
    });
    expect(capabilityInputs).toMatchObject([
      {
        tenantId: "tenant-a",
        capabilityUrl: "https://api.watasu.ai/requests/event-attendee-intake/submit",
        published: {
          request_id: "event-attendee-intake",
          request_version: "v1"
        }
      }
    ]);
    expect(deliveryRequests).toHaveLength(0);
  });

  test("test_bootstrap_rejects_cross_tenant_request_id_republish", async () => {
    const repository = new InMemoryRequestVersionRepository();
    let tenantId = "tenant-a";
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
      resolvePrincipal: () => ({
        tenant_id: tenantId,
        roles: ["publisher"]
      }),
      resolveOwnershipVerification: () => createOwnership()
    });

    const firstPublishResponse = await app.handle(createRequest({
      method: "POST",
      path: "/requests/event-attendee-intake/publish",
      body: {
        definition,
        confirmed: true
      }
    }));
    tenantId = "tenant-b";
    const secondPublishResponse = await app.handle(createRequest({
      method: "POST",
      path: "/requests/event-attendee-intake/publish",
      body: {
        definition,
        confirmed: true
      }
    }));

    expect(firstPublishResponse.status).toBe(201);
    expect(secondPublishResponse.status).toBe(403);
    expect(parseJson(secondPublishResponse.body)).toEqual({
      ok: false,
      status: "forbidden",
      error: {
        code: "request_id_tenant_mismatch",
        message: "Hosted request_id is owned by a different tenant."
      }
    });
    expect(repository.list("event-attendee-intake")).toHaveLength(1);
  });
});
