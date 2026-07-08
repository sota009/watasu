import { describe, expect, test } from "vitest";
import {
  InMemoryPublishInviteStore,
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
  trust_profile: "human_consent"
};

function createRequest(body: unknown): HostedPublishRequest {
  return {
    method: "POST",
    path: "/requests/event-attendee-intake/publish",
    headers: {},
    body: JSON.stringify(body)
  };
}

function createRequestWithBearer(body: unknown, token: string): HostedPublishRequest {
  return {
    ...createRequest(body),
    headers: {
      authorization: `Bearer ${token}`
    }
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
  test("test_post_publish_with_invalid_invite_token_returns_auth_required_without_publishing", async () => {
    // Arrange
    const repository = new InMemoryRequestVersionRepository();
    const inviteStore = new InMemoryPublishInviteStore();
    let inviteFailure: { status: 401 | 403; code: string; message: string } | undefined;
    const app = createHostedPublishApp({
      repository,
      resolveServiceIdentity(request) {
        const bearerCredential = request.headers.authorization?.replace(/^Bearer /, "");
        const result = bearerCredential === undefined ? undefined : inviteStore.resolveToken(bearerCredential);
        if (result?.ok) {
          return result.identity;
        }
        inviteFailure = result === undefined
          ? undefined
          : {
              status: result.status === "auth_required" ? 401 : 403,
              code: result.error.code,
              message: result.error.message
            };
        return undefined;
      },
      resolveServiceIdentityFailure: () => inviteFailure,
      resolveOwnershipVerification: () => createOwnership()
    });

    // Act
    const response = await app.handle(createRequestWithBearer(createPublishBody(), "invite_secret_token"));

    // Assert
    expect(response.status).toBe(401);
    expect(parseJson(response.body)).toMatchObject({
      ok: false,
      status: "auth_required",
      error: {
        code: "invalid_invite_token"
      }
    });
    expect(response.body).not.toContain("invite_secret_token");
    expect(repository.list("event-attendee-intake")).toHaveLength(0);
  });

  test("test_post_publish_with_expired_invite_token_returns_forbidden_without_publishing", async () => {
    // Arrange
    const repository = new InMemoryRequestVersionRepository();
    const inviteStore = new InMemoryPublishInviteStore();
    inviteStore.issueInvite({
      token: "expired_invite_token",
      ownerId: "owner-a",
      tenantId: "tenant-a",
      roles: ["publisher"],
      expiresAt: "2026-06-15T00:00:00.000Z",
      maxPublishCount: 1
    });
    let inviteFailure: { status: 401 | 403; code: string; message: string } | undefined;
    const app = createHostedPublishApp({
      repository,
      resolveServiceIdentity(request) {
        const bearerCredential = request.headers.authorization?.replace(/^Bearer /, "");
        const result = bearerCredential === undefined
          ? undefined
          : inviteStore.resolveToken(bearerCredential, new Date("2026-06-16T00:00:00.000Z"));
        if (result?.ok) {
          return result.identity;
        }
        inviteFailure = result === undefined
          ? undefined
          : {
              status: result.status === "auth_required" ? 401 : 403,
              code: result.error.code,
              message: result.error.message
            };
        return undefined;
      },
      resolveServiceIdentityFailure: () => inviteFailure,
      resolveOwnershipVerification: () => createOwnership()
    });

    // Act
    const response = await app.handle(createRequestWithBearer(createPublishBody(), "expired_invite_token"));

    // Assert
    expect(response.status).toBe(403);
    expect(parseJson(response.body)).toMatchObject({
      ok: false,
      status: "forbidden",
      error: {
        code: "invite_expired"
      }
    });
    expect(repository.list("event-attendee-intake")).toHaveLength(0);
  });

  test("test_post_publish_with_revoked_invite_token_returns_forbidden_without_publishing", async () => {
    // Arrange
    const repository = new InMemoryRequestVersionRepository();
    const inviteStore = new InMemoryPublishInviteStore();
    inviteStore.issueInvite({
      token: "revoked_invite_token",
      ownerId: "owner-a",
      tenantId: "tenant-a",
      roles: ["publisher"],
      expiresAt: "2026-06-17T00:00:00.000Z",
      maxPublishCount: 1
    });
    inviteStore.revokeToken("revoked_invite_token", "2026-06-16T00:00:00.000Z");
    let inviteFailure: { status: 401 | 403; code: string; message: string } | undefined;
    const app = createHostedPublishApp({
      repository,
      resolveServiceIdentity(request) {
        const bearerCredential = request.headers.authorization?.replace(/^Bearer /, "");
        const result = bearerCredential === undefined
          ? undefined
          : inviteStore.resolveToken(bearerCredential, new Date("2026-06-16T00:00:00.000Z"));
        if (result?.ok) {
          return result.identity;
        }
        inviteFailure = result === undefined
          ? undefined
          : {
              status: result.status === "auth_required" ? 401 : 403,
              code: result.error.code,
              message: result.error.message
            };
        return undefined;
      },
      resolveServiceIdentityFailure: () => inviteFailure,
      resolveOwnershipVerification: () => createOwnership()
    });

    // Act
    const response = await app.handle(createRequestWithBearer(createPublishBody(), "revoked_invite_token"));

    // Assert
    expect(response.status).toBe(403);
    expect(parseJson(response.body)).toMatchObject({
      ok: false,
      status: "forbidden",
      error: {
        code: "invite_revoked"
      }
    });
    expect(repository.list("event-attendee-intake")).toHaveLength(0);
  });

  test("test_post_publish_with_invite_without_publisher_role_returns_forbidden", async () => {
    // Arrange
    const repository = new InMemoryRequestVersionRepository();
    const inviteStore = new InMemoryPublishInviteStore();
    inviteStore.issueInvite({
      token: "viewer_invite_token",
      ownerId: "owner-a",
      tenantId: "tenant-a",
      roles: ["ledger_viewer"],
      expiresAt: "2026-06-17T00:00:00.000Z",
      maxPublishCount: 1
    });
    const app = createHostedPublishApp({
      repository,
      resolveServiceIdentity(request) {
        const bearerCredential = request.headers.authorization?.replace(/^Bearer /, "");
        const result = bearerCredential === undefined
          ? undefined
          : inviteStore.resolveToken(bearerCredential, new Date("2026-06-16T00:00:00.000Z"));
        return result?.ok ? result.identity : undefined;
      },
      resolveOwnershipVerification: () => createOwnership()
    });

    // Act
    const response = await app.handle(createRequestWithBearer(createPublishBody(), "viewer_invite_token"));

    // Assert
    expect(response.status).toBe(403);
    expect(parseJson(response.body)).toMatchObject({
      ok: false,
      status: "forbidden",
      error: {
        code: "publisher_role_required"
      }
    });
    expect(repository.list("event-attendee-intake")).toHaveLength(0);
  });


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

  test("test_post_publish_with_valid_invite_records_owner_and_increments_quota_after_success", async () => {
    // Arrange
    const repository = new InMemoryRequestVersionRepository();
    const inviteStore = new InMemoryPublishInviteStore();
    inviteStore.issueInvite({
      token: "valid_invite_token",
      ownerId: "owner-a",
      tenantId: "tenant-a",
      roles: ["publisher"],
      expiresAt: "2026-06-17T00:00:00.000Z",
      maxPublishCount: 1
    });
    const ownerRecords: unknown[] = [];
    const app = createHostedPublishApp({
      repository,
      resolveServiceIdentity(request) {
        const bearerCredential = request.headers.authorization?.replace(/^Bearer /, "");
        const result = bearerCredential === undefined
          ? undefined
          : inviteStore.resolveToken(bearerCredential, new Date("2026-06-16T00:00:00.000Z"));
        return result?.ok ? result.identity : undefined;
      },
      resolveOwnershipVerification: () => createOwnership(),
      afterSuccessfulPublish({ serviceIdentity, published }) {
        inviteStore.incrementPublishCount("valid_invite_token");
        ownerRecords.push({
          tenant_id: serviceIdentity.tenant_id,
          owner_id: serviceIdentity.owner_id,
          request_id: published.request_id,
          request_version: published.request_version,
          retired_at: null
        });
      }
    });

    // Act
    const response = await app.handle(createRequestWithBearer(createPublishBody(), "valid_invite_token"));

    // Assert
    expect(response.status).toBe(201);
    expect(ownerRecords).toEqual([
      {
        tenant_id: "tenant-a",
        owner_id: "owner-a",
        request_id: "event-attendee-intake",
        request_version: "v1",
        retired_at: null
      }
    ]);
    expect(inviteStore.listRecords()[0]?.used_count).toBe(1);
  });

  test("test_post_publish_does_not_increment_invite_quota_after_failed_publish", async () => {
    // Arrange
    const repository = new InMemoryRequestVersionRepository();
    const inviteStore = new InMemoryPublishInviteStore();
    inviteStore.issueInvite({
      token: "valid_invite_token",
      ownerId: "owner-a",
      tenantId: "tenant-a",
      roles: ["publisher"],
      expiresAt: "2026-06-17T00:00:00.000Z",
      maxPublishCount: 1
    });
    const app = createHostedPublishApp({
      repository,
      resolveServiceIdentity(request) {
        const bearerCredential = request.headers.authorization?.replace(/^Bearer /, "");
        const result = bearerCredential === undefined
          ? undefined
          : inviteStore.resolveToken(bearerCredential, new Date("2026-06-16T00:00:00.000Z"));
        return result?.ok ? result.identity : undefined;
      },
      resolveOwnershipVerification: () => ({
        verifiedServiceKeyIds: [],
        verifiedWebhookOrigins: ["https://receiver.example.com"]
      }),
      afterSuccessfulPublish() {
        inviteStore.incrementPublishCount("valid_invite_token");
      }
    });

    // Act
    const response = await app.handle(createRequestWithBearer(createPublishBody(), "valid_invite_token"));

    // Assert
    expect(response.status).toBe(400);
    expect(inviteStore.listRecords()[0]?.used_count).toBe(0);
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
