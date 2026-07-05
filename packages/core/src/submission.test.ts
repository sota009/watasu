import { describe, expect, test } from "vitest";
import { createPrivateKey, generateKeyPairSync, sign, type JsonWebKey } from "node:crypto";
import type { RequestDefinition, TrustProfile } from "./request-definition.js";
import type { PublishedRequestVersion } from "./request-version.js";
import { createRequestVersionHashes } from "./request-version.js";
import { canonicalizeJson } from "./request-definition.js";
import { sha256Hash } from "./hash.js";
import {
  InMemoryCapabilityRegistry,
  InMemoryIdempotencyStore,
  InMemorySubmissionRateLimiter,
  buildSenderSignaturePayload,
  validateSubmissionEnvelope,
  validateSubmissionEnvelopeAsync,
  type AsyncSubmissionValidationContext,
  type SubmissionEnvelope,
  type SubmissionValidationContext
} from "./submission.js";

const now = new Date("2026-06-14T12:00:00.000Z");

const baseDefinition: RequestDefinition = {
  name: "event-attendee-intake",
  schema_version: "2026-06-14",
  description: "Collect attendee details for ExampleConf.",
  fields: [
    {
      id: "full_name",
      type: "string",
      required: true,
      purpose: "Confirm attendees at reception.",
      sensitivity: "moderate"
    }
  ],
  consent: {
    text: "ExampleConf uses this information only for event operations."
  },
  destination: {
    type: "webhook",
    url: "https://example.com/watasu/intake"
  },
  retention: {
    destination_policy: "Delete within 30 days after the event."
  },
  encryption: {
    mode: "required",
    algorithm: "JWE",
    key_management: "ECDH-ES+A256KW",
    content_encryption: "A256GCM",
    service_key_id: "jwk-thumbprint:sha256:service",
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
  trust_profile: "public_capability"
};

const encryptedPayload = {
  protected: "eyJhbGciOiJFQ0RILUVTK0EyNTZLVyJ9",
  iv: "base64url-iv",
  ciphertext: "base64url-ciphertext",
  tag: "base64url-tag"
};

function createPublished(trustProfile: TrustProfile = "public_capability"): PublishedRequestVersion {
  const definition = {
    ...structuredClone(baseDefinition),
    trust_profile: trustProfile
  };

  return {
    request_id: "event-attendee-intake",
    request_version: "v1",
    definition,
    hashes: createRequestVersionHashes(definition),
    published_at: "2026-06-14T11:00:00.000Z"
  };
}

function createEnvelope(
  published: PublishedRequestVersion,
  overrides: Partial<SubmissionEnvelope> = {}
): SubmissionEnvelope {
  return {
    request_id: published.request_id,
    request_version: published.request_version,
    schema_hash: published.hashes.schema_hash,
    consent_receipt_hash: published.hashes.consent_text_hash,
    idempotency_key: "submit-001",
    submitted_at: "2026-06-14T11:59:00.000Z",
    service_key_id: published.definition.encryption.service_key_id,
    encrypted_payload: encryptedPayload,
    encrypted_payload_hash: sha256Hash(canonicalizeJson(encryptedPayload)),
    ...overrides
  };
}

function createContext(
  published: PublishedRequestVersion,
  overrides: Partial<SubmissionValidationContext> = {}
): SubmissionValidationContext {
  return {
    published,
    capability: {
      url: "https://example.com/.well-known/watasu/cap/abc",
      revoked: false
    },
    idempotencyStore: new InMemoryIdempotencyStore(),
    rateLimiter: new InMemorySubmissionRateLimiter({
      limit: 10,
      windowMs: 60_000,
      clock: () => now
    }),
    clock: () => now,
    ...overrides
  };
}

function createSenderKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256"
  });

  return {
    privateJwk: privateKey.export({ format: "jwk" }),
    publicJwk: publicKey.export({ format: "jwk" })
  };
}

function createEd25519SenderKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");

  return {
    privateJwk: privateKey.export({ format: "jwk" }),
    publicJwk: publicKey.export({ format: "jwk" })
  };
}

function signSenderEnvelope(
  envelope: SubmissionEnvelope,
  privateJwk: JsonWebKey,
  protectedHeaderOverrides: Record<string, unknown> = {}
): string {
  const protectedHeader = Buffer.from(JSON.stringify({
    alg: "ES256",
    typ: "watasu-sender-signature+jws",
    ...protectedHeaderOverrides
  })).toString("base64url");
  const payload = Buffer.from(canonicalizeJson(buildSenderSignaturePayload(envelope)))
    .toString("base64url");
  const signingInput = `${protectedHeader}.${payload}`;
  const signature = sign("sha256", Buffer.from(signingInput, "ascii"), {
    key: createPrivateKey({ key: privateJwk, format: "jwk" }),
    dsaEncoding: "ieee-p1363"
  }).toString("base64url");

  return `${protectedHeader}..${signature}`;
}

function signEdDsaSenderEnvelope(
  envelope: SubmissionEnvelope,
  privateJwk: JsonWebKey,
  protectedHeaderOverrides: Record<string, unknown> = {}
): string {
  const protectedHeader = Buffer.from(JSON.stringify({
    alg: "EdDSA",
    typ: "watasu-sender-signature+jws",
    ...protectedHeaderOverrides
  })).toString("base64url");
  const payload = Buffer.from(canonicalizeJson(buildSenderSignaturePayload(envelope)))
    .toString("base64url");
  const signingInput = `${protectedHeader}.${payload}`;
  const signature = sign(null, Buffer.from(signingInput, "ascii"), {
    key: createPrivateKey({ key: privateJwk, format: "jwk" })
  }).toString("base64url");

  return `${protectedHeader}..${signature}`;
}

describe("submission envelope validation", () => {
  test("test_valid_public_capability_envelope_is_accepted", () => {
    const published = createPublished();
    const envelope = createEnvelope(published);
    const context = createContext(published);

    const result = validateSubmissionEnvelope(envelope, context);

    expect(result).toMatchObject({
      ok: true,
      status: "accepted",
      submission: {
        request_id: "event-attendee-intake",
        request_version: "v1",
        idempotency_key: "submit-001",
        capability_hash: sha256Hash("https://example.com/.well-known/watasu/cap/abc")
      }
    });
  });

  test("test_accepted_submission_does_not_expose_raw_capability_url", () => {
    const published = createPublished();
    const capabilityUrl =
      "https://example.com/.well-known/watasu/cap/high-entropy-secret-token";
    const envelope = createEnvelope(published);
    const context = createContext(published, {
      capability: {
        url: capabilityUrl,
        revoked: false
      }
    });

    const result = validateSubmissionEnvelope(envelope, context);

    expect(canonicalizeJson(result)).not.toContain("high-entropy-secret-token");
  });

  test("test_schema_hash_mismatch_is_rejected", () => {
    const published = createPublished();
    const envelope = createEnvelope(published, {
      schema_hash: "sha256:wrong"
    });
    const context = createContext(published);

    const result = validateSubmissionEnvelope(envelope, context);

    expect(result).toMatchObject({
      ok: false,
      status: "rejected",
      error: {
        code: "schema_hash_mismatch"
      }
    });
  });

  test("test_service_key_id_mismatch_is_rejected", () => {
    const published = createPublished();
    const envelope = createEnvelope(published, {
      service_key_id: "jwk-thumbprint:sha256:wrong"
    });
    const context = createContext(published);

    const result = validateSubmissionEnvelope(envelope, context);

    expect(result).toMatchObject({
      ok: false,
      status: "rejected",
      error: {
        code: "service_key_id_mismatch"
      }
    });
  });

  test("test_encrypted_payload_hash_mismatch_is_rejected", () => {
    const published = createPublished();
    const envelope = createEnvelope(published, {
      encrypted_payload_hash: "sha256:wrong"
    });
    const context = createContext(published);

    const result = validateSubmissionEnvelope(envelope, context);

    expect(result).toMatchObject({
      ok: false,
      status: "rejected",
      error: {
        code: "encrypted_payload_hash_mismatch"
      }
    });
  });

  test("test_consent_receipt_hash_mismatch_is_rejected", () => {
    const published = createPublished();
    const envelope = createEnvelope(published, {
      consent_receipt_hash: "sha256:wrong"
    });
    const context = createContext(published);

    const result = validateSubmissionEnvelope(envelope, context);

    expect(result).toMatchObject({
      ok: false,
      status: "rejected",
      error: {
        code: "consent_receipt_hash_mismatch"
      }
    });
  });

  test("test_expired_submission_is_rejected", () => {
    const published = createPublished();
    const envelope = createEnvelope(published, {
      submitted_at: "2026-06-14T11:44:59.999Z"
    });
    const context = createContext(published);

    const result = validateSubmissionEnvelope(envelope, context);

    expect(result).toMatchObject({
      ok: false,
      status: "rejected",
      error: {
        code: "submission_expired"
      }
    });
  });

  test("test_future_submission_outside_clock_skew_is_rejected", () => {
    const published = createPublished();
    const envelope = createEnvelope(published, {
      submitted_at: "2026-06-14T12:05:00.001Z"
    });
    const context = createContext(published);

    const result = validateSubmissionEnvelope(envelope, context);

    expect(result).toMatchObject({
      ok: false,
      status: "rejected",
      error: {
        code: "submitted_at_in_future"
      }
    });
  });

  test("test_replayed_idempotency_key_is_rejected", () => {
    const published = createPublished();
    const envelope = createEnvelope(published);
    const idempotencyStore = new InMemoryIdempotencyStore();
    const context = createContext(published, { idempotencyStore });

    validateSubmissionEnvelope(envelope, context);
    const result = validateSubmissionEnvelope(envelope, context);

    expect(result).toMatchObject({
      ok: false,
      status: "rejected",
      error: {
        code: "idempotency_key_replayed"
      }
    });
  });

  test("test_idempotency_validation_claim_is_not_terminal_delivery_success", () => {
    const published = createPublished();
    const envelope = createEnvelope(published);
    const idempotencyStore = new InMemoryIdempotencyStore();
    const context = createContext(published, { idempotencyStore });

    validateSubmissionEnvelope(envelope, context);
    const claim = idempotencyStore.getValidationClaim("event-attendee-intake:v1:submit-001");

    expect(claim).toEqual({
      request_id: "event-attendee-intake",
      request_version: "v1",
      idempotency_key: "submit-001",
      submitted_at: "2026-06-14T11:59:00.000Z",
      claimed_at: "2026-06-14T12:00:00.000Z",
      status: "validation_accepted"
    });
  });

  test("test_released_validation_claim_allows_retry_after_delivery_failure", () => {
    const published = createPublished();
    const envelope = createEnvelope(published);
    const idempotencyStore = new InMemoryIdempotencyStore();
    const context = createContext(published, { idempotencyStore });

    validateSubmissionEnvelope(envelope, context);
    idempotencyStore.releaseValidation("event-attendee-intake:v1:submit-001");
    const result = validateSubmissionEnvelope(envelope, context);

    expect(result).toMatchObject({
      ok: true,
      status: "accepted"
    });
  });

  test("test_async_validation_awaits_rate_limit_and_idempotency_store", async () => {
    const published = createPublished();
    const envelope = createEnvelope(published);
    const events: string[] = [];
    const context: AsyncSubmissionValidationContext = {
      ...createContext(published),
      rateLimiter: {
        async consume(key) {
          await Promise.resolve();
          events.push(`rate:${key}`);
          return true;
        }
      },
      idempotencyStore: {
        async claimValidation(recordKey, claim) {
          await Promise.resolve();
          events.push(`claim:${recordKey}:${claim.status}`);
          return true;
        },
        async releaseValidation(recordKey) {
          await Promise.resolve();
          events.push(`release:${recordKey}`);
        }
      }
    };

    const result = await validateSubmissionEnvelopeAsync(envelope, context);

    expect(result).toMatchObject({
      ok: true,
      status: "accepted"
    });
    expect(events).toEqual([
      `rate:event-attendee-intake:v1:${sha256Hash("https://example.com/.well-known/watasu/cap/abc")}`,
      "claim:event-attendee-intake:v1:submit-001:validation_accepted"
    ]);
  });

  test("test_revoked_capability_url_is_rejected", () => {
    const published = createPublished();
    const envelope = createEnvelope(published);
    const context = createContext(published, {
      capability: {
        url: "https://example.com/.well-known/watasu/cap/abc",
        revoked: true
      }
    });

    const result = validateSubmissionEnvelope(envelope, context);

    expect(result).toMatchObject({
      ok: false,
      status: "rejected",
      error: {
        code: "capability_revoked"
      }
    });
  });

  test("test_capability_registry_revokes_without_mutating_request_version", () => {
    const published = createPublished();
    const registry = new InMemoryCapabilityRegistry();
    const capability = registry.issueCapability({
      published,
      url: "https://example.com/.well-known/watasu/cap/old"
    });

    registry.revokeCapability(capability);
    const resolved = registry.resolveCapability(capability.url);

    expect(resolved).toMatchObject({
      url: capability.url,
      revoked: true
    });
    expect(published.request_version).toBe("v1");
  });

  test("test_capability_registry_records_hash_without_full_url_token", () => {
    const published = createPublished();
    const registry = new InMemoryCapabilityRegistry();

    registry.issueCapability({
      published,
      url: "https://example.com/.well-known/watasu/cap/high-entropy-secret-token"
    });
    const recordsJson = canonicalizeJson(registry.listRecords());

    expect(recordsJson).toContain("capability_hash");
    expect(recordsJson).not.toContain("high-entropy-secret-token");
    expect(recordsJson).not.toContain(".well-known/watasu/cap");
  });

  test("test_rotated_capability_accepts_new_url_and_rejects_old_url", () => {
    const published = createPublished();
    const envelope = createEnvelope(published);
    const registry = new InMemoryCapabilityRegistry();
    const oldCapability = registry.issueCapability({
      published,
      url: "https://example.com/.well-known/watasu/cap/old"
    });
    const newCapability = registry.rotateCapability({
      published,
      previous: oldCapability,
      url: "https://example.com/.well-known/watasu/cap/new"
    });

    const oldResult = validateSubmissionEnvelope(envelope, createContext(published, {
      capability: registry.resolveCapability(oldCapability.url)
    }));
    const newResult = validateSubmissionEnvelope(envelope, createContext(published, {
      capability: registry.resolveCapability(newCapability.url)
    }));

    expect(oldResult).toMatchObject({
      ok: false,
      status: "rejected",
      error: {
        code: "capability_revoked"
      }
    });
    expect(newResult).toMatchObject({
      ok: true,
      status: "accepted",
      submission: {
        request_version: "v1"
      }
    });
  });

  test("test_verified_sender_without_signature_returns_auth_required", () => {
    const published = createPublished("verified_sender");
    const envelope = createEnvelope(published, {
      sender_key_id: "sender-key-001"
    });
    const context = createContext(published, {
      trustedSenderKeyIds: ["sender-key-001"]
    });

    const result = validateSubmissionEnvelope(envelope, context);

    expect(result).toMatchObject({
      ok: false,
      status: "auth_required",
      error: {
        code: "sender_signature_required"
      }
    });
  });

  test("test_verified_sender_without_resolved_public_key_returns_auth_required", () => {
    const published = createPublished("verified_sender");
    const envelope = createEnvelope(published, {
      sender_key_id: "sender-key-001",
      sender_signature: "base64url-signature"
    });
    const context = createContext(published, {
      trustedSenderKeyIds: ["sender-key-001"]
    });

    const result = validateSubmissionEnvelope(envelope, context);

    expect(result).toMatchObject({
      ok: false,
      status: "auth_required",
      error: {
        code: "sender_public_key_required"
      }
    });
  });

  test("test_verified_sender_with_valid_es256_detached_signature_is_accepted", () => {
    const published = createPublished("verified_sender");
    const senderKeys = createSenderKeyPair();
    const envelopeWithoutSignature = createEnvelope(published, {
      sender_key_id: "sender-key-001"
    });
    const envelope = {
      ...envelopeWithoutSignature,
      sender_signature: signSenderEnvelope(envelopeWithoutSignature, senderKeys.privateJwk)
    };
    const context = createContext(published, {
      trustedSenderKeyIds: ["sender-key-001"],
      trustedSenderPublicKeys: [
        {
          sender_key_id: "sender-key-001",
          alg: "ES256",
          public_jwk: senderKeys.publicJwk
        }
      ]
    });

    const result = validateSubmissionEnvelope(envelope, context);

    expect(result).toMatchObject({
      ok: true,
      status: "accepted",
      submission: {
        sender_key_id: "sender-key-001"
      }
    });
  });

  test("test_verified_sender_with_valid_eddsa_detached_signature_is_accepted", () => {
    const published = createPublished("verified_sender");
    const senderKeys = createEd25519SenderKeyPair();
    const envelopeWithoutSignature = createEnvelope(published, {
      sender_key_id: "sender-key-eddsa-001"
    });
    const envelope = {
      ...envelopeWithoutSignature,
      sender_signature: signEdDsaSenderEnvelope(envelopeWithoutSignature, senderKeys.privateJwk)
    };
    const context = createContext(published, {
      trustedSenderKeyIds: ["sender-key-eddsa-001"],
      trustedSenderPublicKeys: [
        {
          sender_key_id: "sender-key-eddsa-001",
          alg: "EdDSA",
          public_jwk: senderKeys.publicJwk
        }
      ]
    });

    const result = validateSubmissionEnvelope(envelope, context);

    expect(result).toMatchObject({
      ok: true,
      status: "accepted",
      submission: {
        sender_key_id: "sender-key-eddsa-001"
      }
    });
  });

  test("test_verified_sender_rejects_eddsa_header_for_es256_key", () => {
    const published = createPublished("verified_sender");
    const senderKeys = createEd25519SenderKeyPair();
    const envelopeWithoutSignature = createEnvelope(published, {
      sender_key_id: "sender-key-001"
    });
    const envelope = {
      ...envelopeWithoutSignature,
      sender_signature: signEdDsaSenderEnvelope(envelopeWithoutSignature, senderKeys.privateJwk)
    };
    const context = createContext(published, {
      trustedSenderKeyIds: ["sender-key-001"],
      trustedSenderPublicKeys: [
        {
          sender_key_id: "sender-key-001",
          alg: "ES256",
          public_jwk: senderKeys.publicJwk
        }
      ]
    });

    const result = validateSubmissionEnvelope(envelope, context);

    expect(result).toMatchObject({
      ok: false,
      status: "auth_required",
      error: {
        code: "sender_signature_invalid"
      }
    });
  });

  test("test_verified_sender_with_tampered_detached_signature_returns_auth_required", () => {
    const published = createPublished("verified_sender");
    const senderKeys = createSenderKeyPair();
    const envelopeWithoutSignature = createEnvelope(published, {
      sender_key_id: "sender-key-001"
    });
    const envelope = {
      ...envelopeWithoutSignature,
      idempotency_key: "submit-tampered",
      sender_signature: signSenderEnvelope(envelopeWithoutSignature, senderKeys.privateJwk)
    };
    const context = createContext(published, {
      trustedSenderKeyIds: ["sender-key-001"],
      trustedSenderPublicKeys: [
        {
          sender_key_id: "sender-key-001",
          alg: "ES256",
          public_jwk: senderKeys.publicJwk
        }
      ]
    });

    const result = validateSubmissionEnvelope(envelope, context);

    expect(result).toMatchObject({
      ok: false,
      status: "auth_required",
      error: {
        code: "sender_signature_invalid"
      }
    });
  });

  test("test_verified_sender_with_unsupported_jws_alg_returns_auth_required", () => {
    const published = createPublished("verified_sender");
    const senderKeys = createSenderKeyPair();
    const envelopeWithoutSignature = createEnvelope(published, {
      sender_key_id: "sender-key-001"
    });
    const envelope = {
      ...envelopeWithoutSignature,
      sender_signature: signSenderEnvelope(envelopeWithoutSignature, senderKeys.privateJwk, {
        alg: "HS256"
      })
    };
    const context = createContext(published, {
      trustedSenderKeyIds: ["sender-key-001"],
      trustedSenderPublicKeys: [
        {
          sender_key_id: "sender-key-001",
          alg: "ES256",
          public_jwk: senderKeys.publicJwk
        }
      ]
    });

    const result = validateSubmissionEnvelope(envelope, context);

    expect(result).toMatchObject({
      ok: false,
      status: "auth_required",
      error: {
        code: "sender_signature_invalid"
      }
    });
  });

  test("test_private_invite_requires_sender_key_and_invite_binding", () => {
    const published = createPublished("private_invite");
    const envelope = createEnvelope(published, {
      sender_key_id: "sender-key-001"
    });
    const context = createContext(published, {
      trustedInvites: [
        {
          invite_id: "invite-001",
          sender_key_id: "sender-key-001"
        }
      ]
    });

    const result = validateSubmissionEnvelope(envelope, context);

    expect(result).toMatchObject({
      ok: false,
      status: "auth_required",
      error: {
        code: "invite_binding_required"
      }
    });
  });

  test("test_private_invite_without_signature_returns_auth_required", () => {
    const published = createPublished("private_invite");
    const envelope = createEnvelope(published, {
      sender_key_id: "sender-key-001",
      invite_id: "invite-001"
    });
    const context = createContext(published, {
      trustedSenderKeyIds: ["sender-key-001"],
      trustedInvites: [
        {
          invite_id: "invite-001",
          sender_key_id: "sender-key-001"
        }
      ]
    });

    const result = validateSubmissionEnvelope(envelope, context);

    expect(result).toMatchObject({
      ok: false,
      status: "auth_required",
      error: {
        code: "sender_signature_required"
      }
    });
  });

  test("test_private_invite_with_valid_signature_and_invite_binding_is_accepted", () => {
    const published = createPublished("private_invite");
    const senderKeys = createSenderKeyPair();
    const envelopeWithoutSignature = createEnvelope(published, {
      sender_key_id: "sender-key-001",
      invite_id: "invite-001"
    });
    const envelope = {
      ...envelopeWithoutSignature,
      sender_signature: signSenderEnvelope(envelopeWithoutSignature, senderKeys.privateJwk)
    };
    const context = createContext(published, {
      trustedSenderKeyIds: ["sender-key-001"],
      trustedSenderPublicKeys: [
        {
          sender_key_id: "sender-key-001",
          alg: "ES256",
          public_jwk: senderKeys.publicJwk
        }
      ],
      trustedInvites: [
        {
          invite_id: "invite-001",
          sender_key_id: "sender-key-001"
        }
      ]
    });

    const result = validateSubmissionEnvelope(envelope, context);

    expect(result).toMatchObject({
      ok: true,
      status: "accepted",
      submission: {
        sender_key_id: "sender-key-001",
        invite_id: "invite-001"
      }
    });
  });

  test("test_rate_limited_submission_is_rejected_before_webhook_delivery", () => {
    const published = createPublished();
    const envelope = createEnvelope(published);
    const rateLimiter = new InMemorySubmissionRateLimiter({
      limit: 0,
      windowMs: 60_000,
      clock: () => now
    });
    const idempotencyStore = new InMemoryIdempotencyStore();
    const context = createContext(published, {
      idempotencyStore,
      rateLimiter
    });

    const result = validateSubmissionEnvelope(envelope, context);

    expect(result).toMatchObject({
      ok: false,
      status: "rejected",
      error: {
        code: "rate_limited"
      }
    });
    expect(idempotencyStore.has("event-attendee-intake:v1:submit-001")).toBe(false);
  });
});
