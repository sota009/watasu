import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "vitest";
import type { JsonWebKey } from "node:crypto";
import {
  InMemoryServiceKeyRegistry,
  buildServiceKeyOwnershipVerification
} from "./service-key.js";

function createServiceKeyPair(): {
  privateJwk: JsonWebKey;
  publicJwk: JsonWebKey;
} {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256"
  });

  return {
    privateJwk: privateKey.export({ format: "jwk" }),
    publicJwk: publicKey.export({ format: "jwk" })
  };
}

describe("service-owned public key registry", () => {
  test("test_verified_service_key_can_be_registered_without_private_material", () => {
    // Arrange
    const keys = createServiceKeyPair();
    const registry = new InMemoryServiceKeyRegistry();

    // Act
    const result = registry.registerServiceKey({
      tenant_id: "tenant-a",
      service_key_id: "jwk-thumbprint:sha256:service",
      public_jwk: keys.publicJwk,
      ownership: {
        ok: true,
        tenant_id: "tenant-a",
        service_key_id: "jwk-thumbprint:sha256:service"
      },
      not_before: "2026-06-14T12:00:00.000Z",
      expires_at: "2026-09-14T12:00:00.000Z",
      created_at: "2026-06-14T12:00:00.000Z"
    });
    const recordsJson = JSON.stringify(registry.listServiceKeys());

    // Assert
    expect(result).toMatchObject({
      ok: true,
      record: {
        status: "active",
        tenant_id: "tenant-a",
        service_key_id: "jwk-thumbprint:sha256:service",
        public_jwk: keys.publicJwk
      }
    });
    expect(recordsJson).not.toContain("\"d\"");
  });

  test("test_service_key_registration_rejects_unverified_ownership", () => {
    // Arrange
    const keys = createServiceKeyPair();
    const registry = new InMemoryServiceKeyRegistry();

    // Act
    const result = registry.registerServiceKey({
      tenant_id: "tenant-a",
      service_key_id: "jwk-thumbprint:sha256:service",
      public_jwk: keys.publicJwk,
      ownership: {
        ok: false,
        error: {
          code: "challenge_signature_invalid",
          message: "Ownership challenge signature is invalid."
        }
      },
      not_before: "2026-06-14T12:00:00.000Z",
      expires_at: "2026-09-14T12:00:00.000Z",
      created_at: "2026-06-14T12:00:00.000Z"
    });

    // Assert
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "service_key_ownership_required"
      }
    });
    expect(registry.listServiceKeys()).toEqual([]);
  });

  test("test_service_key_registration_rejects_ownership_mismatch", () => {
    // Arrange
    const keys = createServiceKeyPair();
    const registry = new InMemoryServiceKeyRegistry();

    // Act
    const result = registry.registerServiceKey({
      tenant_id: "tenant-a",
      service_key_id: "jwk-thumbprint:sha256:service",
      public_jwk: keys.publicJwk,
      ownership: {
        ok: true,
        tenant_id: "tenant-b",
        service_key_id: "jwk-thumbprint:sha256:service"
      },
      not_before: "2026-06-14T12:00:00.000Z",
      expires_at: "2026-09-14T12:00:00.000Z",
      created_at: "2026-06-14T12:00:00.000Z"
    });

    // Assert
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "service_key_ownership_mismatch"
      }
    });
  });

  test("test_publish_ownership_uses_only_active_verified_service_keys", () => {
    // Arrange
    const activeKeys = createServiceKeyPair();
    const expiredKeys = createServiceKeyPair();
    const registry = new InMemoryServiceKeyRegistry();
    registry.registerServiceKey({
      tenant_id: "tenant-a",
      service_key_id: "jwk-thumbprint:sha256:active",
      public_jwk: activeKeys.publicJwk,
      ownership: {
        ok: true,
        tenant_id: "tenant-a",
        service_key_id: "jwk-thumbprint:sha256:active"
      },
      not_before: "2026-06-14T12:00:00.000Z",
      expires_at: "2026-09-14T12:00:00.000Z",
      created_at: "2026-06-14T12:00:00.000Z"
    });
    registry.registerServiceKey({
      tenant_id: "tenant-a",
      service_key_id: "jwk-thumbprint:sha256:expired",
      public_jwk: expiredKeys.publicJwk,
      ownership: {
        ok: true,
        tenant_id: "tenant-a",
        service_key_id: "jwk-thumbprint:sha256:expired"
      },
      not_before: "2026-01-14T12:00:00.000Z",
      expires_at: "2026-02-14T12:00:00.000Z",
      created_at: "2026-01-14T12:00:00.000Z"
    });

    // Act
    const ownership = buildServiceKeyOwnershipVerification({
      tenant_id: "tenant-a",
      registry,
      now: new Date("2026-06-14T12:00:00.000Z")
    });

    // Assert
    expect(ownership).toEqual({
      verifiedServiceKeyIds: ["jwk-thumbprint:sha256:active"]
    });
  });

  test("test_rotate_service_key_marks_old_key_rotated_and_new_key_active", () => {
    // Arrange
    const oldKeys = createServiceKeyPair();
    const nextKeys = createServiceKeyPair();
    const registry = new InMemoryServiceKeyRegistry();
    registry.registerServiceKey({
      tenant_id: "tenant-a",
      service_key_id: "jwk-thumbprint:sha256:old",
      public_jwk: oldKeys.publicJwk,
      ownership: {
        ok: true,
        tenant_id: "tenant-a",
        service_key_id: "jwk-thumbprint:sha256:old"
      },
      not_before: "2026-06-14T12:00:00.000Z",
      expires_at: "2026-09-14T12:00:00.000Z",
      created_at: "2026-06-14T12:00:00.000Z"
    });

    // Act
    const result = registry.rotateServiceKey({
      tenant_id: "tenant-a",
      previous_service_key_id: "jwk-thumbprint:sha256:old",
      next_service_key_id: "jwk-thumbprint:sha256:next",
      public_jwk: nextKeys.publicJwk,
      ownership: {
        ok: true,
        tenant_id: "tenant-a",
        service_key_id: "jwk-thumbprint:sha256:next"
      },
      not_before: "2026-06-15T12:00:00.000Z",
      expires_at: "2026-09-15T12:00:00.000Z",
      rotated_at: "2026-06-15T12:00:00.000Z"
    });

    // Assert
    expect(result).toMatchObject({
      ok: true,
      record: {
        service_key_id: "jwk-thumbprint:sha256:next",
        status: "active",
        rotated_from_service_key_id: "jwk-thumbprint:sha256:old"
      }
    });
    expect(registry.listServiceKeys()).toMatchObject([
      {
        service_key_id: "jwk-thumbprint:sha256:old",
        status: "rotated"
      },
      {
        service_key_id: "jwk-thumbprint:sha256:next",
        status: "active"
      }
    ]);
  });

  test("test_revoked_service_key_is_removed_from_publish_ownership", () => {
    // Arrange
    const keys = createServiceKeyPair();
    const registry = new InMemoryServiceKeyRegistry();
    registry.registerServiceKey({
      tenant_id: "tenant-a",
      service_key_id: "jwk-thumbprint:sha256:service",
      public_jwk: keys.publicJwk,
      ownership: {
        ok: true,
        tenant_id: "tenant-a",
        service_key_id: "jwk-thumbprint:sha256:service"
      },
      not_before: "2026-06-14T12:00:00.000Z",
      expires_at: "2026-09-14T12:00:00.000Z",
      created_at: "2026-06-14T12:00:00.000Z"
    });

    // Act
    registry.revokeServiceKey({
      tenant_id: "tenant-a",
      service_key_id: "jwk-thumbprint:sha256:service",
      revoked_at: "2026-06-15T12:00:00.000Z"
    });
    const ownership = buildServiceKeyOwnershipVerification({
      tenant_id: "tenant-a",
      registry,
      now: new Date("2026-06-16T12:00:00.000Z")
    });

    // Assert
    expect(ownership).toEqual({
      verifiedServiceKeyIds: []
    });
  });
});
