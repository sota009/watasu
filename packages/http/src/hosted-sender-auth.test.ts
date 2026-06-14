import { describe, expect, test } from "vitest";
import { sha256Hash } from "@watasu/core";
import {
  InMemoryHostedSenderKeyRegistry,
  createHostedSenderTrustResolver
} from "./hosted-sender-auth.js";

const now = new Date("2026-06-14T12:00:00.000Z");
const capabilityHash = sha256Hash("capability-token");
const senderPublicJwk = {
  kty: "EC",
  crv: "P-256",
  x: "base64url-x",
  y: "base64url-y"
};

describe("hosted sender trust resolver", () => {
  test("test_resolver_returns_only_active_sender_keys_for_request_scope", () => {
    // Arrange
    const resolver = createHostedSenderTrustResolver({
      senderKeys: [
        {
          tenant_id: "tenant-a",
          request_id: "request-a",
          request_version: "v1",
          sender_key_id: "sender-key-active",
          alg: "ES256",
          public_jwk: senderPublicJwk,
          status: "active",
          not_before: "2026-06-14T00:00:00.000Z",
          expires_at: "2026-06-15T00:00:00.000Z"
        },
        {
          tenant_id: "tenant-a",
          request_id: "request-a",
          request_version: "v1",
          sender_key_id: "sender-key-revoked",
          alg: "ES256",
          public_jwk: senderPublicJwk,
          status: "revoked",
          not_before: "2026-06-14T00:00:00.000Z",
          expires_at: "2026-06-15T00:00:00.000Z",
          revoked_at: "2026-06-14T11:00:00.000Z"
        },
        {
          tenant_id: "tenant-b",
          request_id: "request-a",
          request_version: "v1",
          sender_key_id: "sender-key-tenant-b",
          alg: "ES256",
          public_jwk: senderPublicJwk,
          status: "active",
          not_before: "2026-06-14T00:00:00.000Z",
          expires_at: "2026-06-15T00:00:00.000Z"
        },
        {
          tenant_id: "tenant-a",
          request_id: "request-a",
          request_version: "v2",
          sender_key_id: "sender-key-wrong-version",
          alg: "ES256",
          public_jwk: senderPublicJwk,
          status: "active",
          not_before: "2026-06-14T00:00:00.000Z",
          expires_at: "2026-06-15T00:00:00.000Z"
        },
        {
          tenant_id: "tenant-a",
          request_id: "request-a",
          request_version: "v1",
          sender_key_id: "sender-key-expired",
          alg: "ES256",
          public_jwk: senderPublicJwk,
          status: "active",
          not_before: "2026-06-13T00:00:00.000Z",
          expires_at: "2026-06-14T11:00:00.000Z"
        }
      ],
      privateInvites: []
    });

    // Act
    const trust = resolver({
      tenantId: "tenant-a",
      requestId: "request-a",
      requestVersion: "v1",
      capabilityHash,
      now
    });

    // Assert
    expect(trust).toEqual({
      trustedSenderKeyIds: ["sender-key-active"],
      trustedSenderPublicKeys: [
        {
          sender_key_id: "sender-key-active",
          alg: "ES256",
          public_jwk: senderPublicJwk
        }
      ],
      trustedInvites: []
    });
  });

  test("test_resolver_filters_sender_key_by_requested_sender_key_id", () => {
    // Arrange
    const resolver = createHostedSenderTrustResolver({
      senderKeys: [
        {
          tenant_id: "tenant-a",
          request_id: "request-a",
          request_version: "v1",
          sender_key_id: "sender-key-active",
          alg: "ES256",
          public_jwk: senderPublicJwk,
          status: "active",
          not_before: "2026-06-14T00:00:00.000Z",
          expires_at: "2026-06-15T00:00:00.000Z"
        }
      ],
      privateInvites: []
    });

    // Act
    const trust = resolver({
      tenantId: "tenant-a",
      requestId: "request-a",
      requestVersion: "v1",
      capabilityHash,
      senderKeyId: "unknown-sender-key",
      now
    });

    // Assert
    expect(trust.trustedSenderKeyIds).toEqual([]);
  });

  test("test_resolver_returns_private_invite_only_when_key_invite_and_capability_match", () => {
    // Arrange
    const resolver = createHostedSenderTrustResolver({
      senderKeys: [
        {
          tenant_id: "tenant-a",
          request_id: "request-a",
          request_version: "v1",
          sender_key_id: "sender-key-active",
          alg: "ES256",
          public_jwk: senderPublicJwk,
          status: "active",
          not_before: "2026-06-14T00:00:00.000Z",
          expires_at: "2026-06-15T00:00:00.000Z"
        }
      ],
      privateInvites: [
        {
          tenant_id: "tenant-a",
          request_id: "request-a",
          request_version: "v1",
          invite_id: "invite-active",
          sender_key_id: "sender-key-active",
          capability_hash: capabilityHash,
          status: "active",
          expires_at: "2026-06-15T00:00:00.000Z"
        },
        {
          tenant_id: "tenant-a",
          request_id: "request-a",
          request_version: "v1",
          invite_id: "invite-capability-mismatch",
          sender_key_id: "sender-key-active",
          capability_hash: sha256Hash("other-capability-token"),
          status: "active",
          expires_at: "2026-06-15T00:00:00.000Z"
        },
        {
          tenant_id: "tenant-a",
          request_id: "request-a",
          request_version: "v1",
          invite_id: "invite-revoked",
          sender_key_id: "sender-key-active",
          capability_hash: capabilityHash,
          status: "revoked",
          expires_at: "2026-06-15T00:00:00.000Z",
          revoked_at: "2026-06-14T11:00:00.000Z"
        }
      ]
    });

    // Act
    const trust = resolver({
      tenantId: "tenant-a",
      requestId: "request-a",
      requestVersion: "v1",
      capabilityHash,
      senderKeyId: "sender-key-active",
      inviteId: "invite-active",
      now
    });

    // Assert
    expect(trust).toEqual({
      trustedSenderKeyIds: ["sender-key-active"],
      trustedSenderPublicKeys: [
        {
          sender_key_id: "sender-key-active",
          alg: "ES256",
          public_jwk: senderPublicJwk
        }
      ],
      trustedInvites: [
        {
          invite_id: "invite-active",
          sender_key_id: "sender-key-active"
        }
      ]
    });
  });

  test("test_resolver_does_not_return_private_invite_without_active_sender_key", () => {
    // Arrange
    const resolver = createHostedSenderTrustResolver({
      senderKeys: [],
      privateInvites: [
        {
          tenant_id: "tenant-a",
          request_id: "request-a",
          request_version: "v1",
          invite_id: "invite-active",
          sender_key_id: "sender-key-missing",
          capability_hash: capabilityHash,
          status: "active",
          expires_at: "2026-06-15T00:00:00.000Z"
        }
      ]
    });

    // Act
    const trust = resolver({
      tenantId: "tenant-a",
      requestId: "request-a",
      requestVersion: "v1",
      capabilityHash,
      senderKeyId: "sender-key-missing",
      inviteId: "invite-active",
      now
    });

    // Assert
    expect(trust).toEqual({
      trustedSenderKeyIds: [],
      trustedSenderPublicKeys: [],
      trustedInvites: []
    });
  });

  test("test_resolver_output_does_not_include_raw_capability_token_or_private_key_material", () => {
    // Arrange
    const resolver = createHostedSenderTrustResolver({
      senderKeys: [
        {
          tenant_id: "tenant-a",
          request_id: "request-a",
          request_version: "v1",
          sender_key_id: "sender-key-active",
          alg: "ES256",
          public_jwk: senderPublicJwk,
          status: "active",
          not_before: "2026-06-14T00:00:00.000Z",
          expires_at: "2026-06-15T00:00:00.000Z"
        }
      ],
      privateInvites: []
    });

    // Act
    const trustJson = JSON.stringify(resolver({
      tenantId: "tenant-a",
      requestId: "request-a",
      requestVersion: "v1",
      capabilityHash,
      senderKeyId: "sender-key-active",
      now
    }));

    // Assert
    expect(trustJson).not.toContain("capability-token");
    expect(trustJson).not.toContain("private_key");
  });
});

describe("hosted sender key registry", () => {
  test("test_register_sender_key_returns_active_record_for_trust_resolution", () => {
    // Arrange
    const registry = new InMemoryHostedSenderKeyRegistry();

    // Act
    const record = registry.registerSenderKey({
      tenant_id: "tenant-a",
      request_id: "request-a",
      request_version: "v1",
      sender_key_id: "sender-key-001",
      alg: "ES256",
      public_jwk: senderPublicJwk,
      not_before: "2026-06-14T00:00:00.000Z",
      expires_at: "2026-06-15T00:00:00.000Z",
      created_at: "2026-06-14T00:00:00.000Z"
    });
    const resolver = createHostedSenderTrustResolver({
      senderKeys: registry.listSenderKeys(),
      privateInvites: []
    });

    // Assert
    expect(record).toMatchObject({
      sender_key_id: "sender-key-001",
      status: "active"
    });
    expect(resolver({
      tenantId: "tenant-a",
      requestId: "request-a",
      requestVersion: "v1",
      capabilityHash,
      senderKeyId: "sender-key-001",
      now
    }).trustedSenderKeyIds).toEqual(["sender-key-001"]);
  });

  test("test_revoke_sender_key_removes_it_from_trust_resolution", () => {
    // Arrange
    const registry = new InMemoryHostedSenderKeyRegistry();
    registry.registerSenderKey({
      tenant_id: "tenant-a",
      request_id: "request-a",
      request_version: "v1",
      sender_key_id: "sender-key-001",
      alg: "ES256",
      public_jwk: senderPublicJwk,
      not_before: "2026-06-14T00:00:00.000Z",
      expires_at: "2026-06-15T00:00:00.000Z",
      created_at: "2026-06-14T00:00:00.000Z"
    });

    // Act
    registry.revokeSenderKey({
      tenant_id: "tenant-a",
      sender_key_id: "sender-key-001",
      revoked_at: "2026-06-14T12:00:00.000Z"
    });
    const resolver = createHostedSenderTrustResolver({
      senderKeys: registry.listSenderKeys(),
      privateInvites: []
    });

    // Assert
    expect(resolver({
      tenantId: "tenant-a",
      requestId: "request-a",
      requestVersion: "v1",
      capabilityHash,
      senderKeyId: "sender-key-001",
      now
    }).trustedSenderKeyIds).toEqual([]);
  });

  test("test_rotate_sender_key_marks_old_key_rotated_and_new_key_active", () => {
    // Arrange
    const registry = new InMemoryHostedSenderKeyRegistry();
    registry.registerSenderKey({
      tenant_id: "tenant-a",
      request_id: "request-a",
      request_version: "v1",
      sender_key_id: "sender-key-old",
      alg: "ES256",
      public_jwk: senderPublicJwk,
      not_before: "2026-06-14T00:00:00.000Z",
      expires_at: "2026-06-15T00:00:00.000Z",
      created_at: "2026-06-14T00:00:00.000Z"
    });

    // Act
    registry.rotateSenderKey({
      tenant_id: "tenant-a",
      previous_sender_key_id: "sender-key-old",
      next_sender_key_id: "sender-key-new",
      alg: "ES256",
      public_jwk: senderPublicJwk,
      not_before: "2026-06-14T12:00:00.000Z",
      expires_at: "2026-06-16T00:00:00.000Z",
      rotated_at: "2026-06-14T12:00:00.000Z"
    });
    const records = registry.listSenderKeys();
    const resolver = createHostedSenderTrustResolver({
      senderKeys: records,
      privateInvites: []
    });

    // Assert
    expect(records).toMatchObject([
      {
        sender_key_id: "sender-key-old",
        status: "rotated",
        revoked_at: "2026-06-14T12:00:00.000Z"
      },
      {
        sender_key_id: "sender-key-new",
        status: "active",
        rotated_from_sender_key_id: "sender-key-old"
      }
    ]);
    expect(resolver({
      tenantId: "tenant-a",
      requestId: "request-a",
      requestVersion: "v1",
      capabilityHash,
      now: new Date("2026-06-14T12:01:00.000Z")
    }).trustedSenderKeyIds).toEqual(["sender-key-new"]);
  });

  test("test_sender_key_records_do_not_store_raw_sender_identifier_or_private_key", () => {
    // Arrange
    const registry = new InMemoryHostedSenderKeyRegistry();

    // Act
    registry.registerSenderKey({
      tenant_id: "tenant-a",
      request_id: "request-a",
      request_version: "v1",
      sender_key_id: "sender-key-001",
      alg: "ES256",
      public_jwk: senderPublicJwk,
      not_before: "2026-06-14T00:00:00.000Z",
      expires_at: "2026-06-15T00:00:00.000Z",
      created_at: "2026-06-14T00:00:00.000Z"
    });
    const recordsJson = JSON.stringify(registry.listSenderKeys());

    // Assert
    expect(recordsJson).not.toContain("alice@example.com");
    expect(recordsJson).not.toContain("private_key");
    expect(recordsJson).not.toContain("\"d\"");
  });
});
