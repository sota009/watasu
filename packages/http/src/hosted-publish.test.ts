import { describe, expect, test } from "vitest";
import {
  InMemoryRequestVersionRepository,
  type PublishOwnershipVerification,
  type RequestDefinition
} from "@watasu/core";
import { createTrustedServiceIdentityResolver } from "./hosted-identity.js";
import { createHostedPublishApp, type HostedPublishRequest } from "./hosted-publish.js";

const baseDefinition: RequestDefinition = {
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
  trust_profile: "verified_sender"
};

function createRequest(body: unknown): HostedPublishRequest {
  return {
    method: "POST",
    path: "/requests/event-attendee-intake/publish",
    headers: {},
    body: JSON.stringify(body)
  };
}

function createPublishBody(overrides: Record<string, unknown> = {}) {
  return {
    definition: baseDefinition,
    confirmed: true,
    ...overrides
  };
}

function createOwnership(): PublishOwnershipVerification {
  return {
    verifiedServiceKeyIds: ["jwk-thumbprint:sha256:example"],
    verifiedWebhookOrigins: ["https://receiver.example.com"]
  };
}

function parseJson(body: string): unknown {
  return JSON.parse(body) as unknown;
}

describe("hosted publish HTTP app", () => {
  test("test_post_publish_without_service_identity_returns_auth_required", async () => {
    // Arrange
    const repository = new InMemoryRequestVersionRepository();
    const app = createHostedPublishApp({
      repository,
      resolveServiceIdentity: () => undefined,
      resolveOwnershipVerification: () => createOwnership()
    });

    // Act
    const response = await app.handle(createRequest(createPublishBody()));

    // Assert
    expect(response.status).toBe(401);
    expect(parseJson(response.body)).toEqual({
      ok: false,
      status: "auth_required",
      error: {
        code: "service_identity_required",
        message: "Hosted publish requires an authenticated service identity."
      }
    });
    expect(repository.list("event-attendee-intake")).toHaveLength(0);
  });

  test("test_post_publish_without_publisher_role_returns_forbidden", async () => {
    // Arrange
    const repository = new InMemoryRequestVersionRepository();
    const app = createHostedPublishApp({
      repository,
      resolveServiceIdentity: () => ({
        tenant_id: "tenant-a",
        roles: ["ledger_viewer"]
      }),
      resolveOwnershipVerification: () => createOwnership()
    });

    // Act
    const response = await app.handle(createRequest(createPublishBody()));

    // Assert
    expect(response.status).toBe(403);
    expect(parseJson(response.body)).toEqual({
      ok: false,
      status: "forbidden",
      error: {
        code: "publisher_role_required",
        message: "Publishing hosted requests requires the publisher role."
      }
    });
    expect(repository.list("event-attendee-intake")).toHaveLength(0);
  });

  test("test_post_publish_without_confirmation_returns_structured_rejection", async () => {
    // Arrange
    const repository = new InMemoryRequestVersionRepository();
    const app = createHostedPublishApp({
      repository,
      resolveServiceIdentity: createTrustedServiceIdentityResolver({
        resolvePrincipal: () => ({
          tenant_id: "tenant-a",
          roles: ["publisher"]
        })
      }),
      resolveOwnershipVerification: () => createOwnership()
    });

    // Act
    const response = await app.handle(createRequest(createPublishBody({ confirmed: false })));

    // Assert
    expect(response.status).toBe(400);
    expect(parseJson(response.body)).toMatchObject({
      ok: false,
      status: "rejected",
      error: {
        code: "publish_requires_confirmation"
      }
    });
    expect(repository.list("event-attendee-intake")).toHaveLength(0);
  });

  test("test_post_publish_rejects_unverified_ownership", async () => {
    // Arrange
    const repository = new InMemoryRequestVersionRepository();
    const app = createHostedPublishApp({
      repository,
      resolveServiceIdentity: () => ({
        tenant_id: "tenant-a",
        roles: ["publisher"]
      }),
      resolveOwnershipVerification: () => ({
        verifiedServiceKeyIds: [],
        verifiedWebhookOrigins: ["https://receiver.example.com"]
      })
    });

    // Act
    const response = await app.handle(createRequest(createPublishBody()));

    // Assert
    expect(response.status).toBe(400);
    expect(parseJson(response.body)).toMatchObject({
      ok: false,
      status: "rejected",
      error: {
        code: "service_key_not_verified"
      }
    });
    expect(repository.list("event-attendee-intake")).toHaveLength(0);
  });

  test("test_post_publish_as_verified_publisher_returns_published_metadata_without_capability_token", async () => {
    // Arrange
    const repository = new InMemoryRequestVersionRepository();
    const app = createHostedPublishApp({
      repository,
      resolveServiceIdentity: () => ({
        tenant_id: "tenant-a",
        roles: ["publisher"]
      }),
      resolveOwnershipVerification: () => createOwnership(),
      generateCapabilityToken: () => "cap_secret_token"
    });

    // Act
    const response = await app.handle(createRequest(createPublishBody()));

    // Assert
    expect(response.status).toBe(201);
    expect(parseJson(response.body)).toMatchObject({
      ok: true,
      published: {
        request_id: "event-attendee-intake",
        request_version: "v1",
        capability: {
          token_hash: expect.stringMatching(/^sha256:/)
        }
      }
    });
    expect(response.body).not.toContain("cap_secret_token");
    expect(repository.list("event-attendee-intake")).toHaveLength(1);
  });

  test("test_post_publish_awaits_async_repository_before_returning_metadata", async () => {
    // Arrange
    const events: string[] = [];
    const backingRepository = new InMemoryRequestVersionRepository();
    const app = createHostedPublishApp({
      repository: {
        async publish(requestId, definition) {
          await Promise.resolve();
          events.push(`publish:${requestId}:${definition.name}`);
          return backingRepository.publish(requestId, definition);
        }
      },
      resolveServiceIdentity: () => ({
        tenant_id: "tenant-a",
        roles: ["publisher"]
      }),
      resolveOwnershipVerification: () => createOwnership()
    });

    // Act
    const response = await app.handle(createRequest(createPublishBody()));

    // Assert
    expect(response.status).toBe(201);
    expect(parseJson(response.body)).toMatchObject({
      ok: true,
      published: {
        request_id: "event-attendee-intake",
        request_version: "v1"
      }
    });
    expect(events).toEqual(["publish:event-attendee-intake:event-attendee-intake"]);
    expect(backingRepository.list("event-attendee-intake")).toHaveLength(1);
  });

  test("test_post_publish_ignores_body_request_id_and_ownership_claims", async () => {
    // Arrange
    const repository = new InMemoryRequestVersionRepository();
    const app = createHostedPublishApp({
      repository,
      resolveServiceIdentity: () => ({
        tenant_id: "tenant-a",
        roles: ["publisher"]
      }),
      resolveOwnershipVerification: () => createOwnership()
    });

    // Act
    const response = await app.handle(createRequest(createPublishBody({
      request_id: "attacker-request",
      ownership: {
        verifiedServiceKeyIds: [],
        verifiedWebhookOrigins: []
      },
      tenant_id: "tenant-b",
      roles: ["publisher"]
    })));

    // Assert
    expect(response.status).toBe(201);
    expect(parseJson(response.body)).toMatchObject({
      ok: true,
      published: {
        request_id: "event-attendee-intake"
      }
    });
    expect(repository.list("event-attendee-intake")).toHaveLength(1);
    expect(repository.list("attacker-request")).toHaveLength(0);
  });
});
