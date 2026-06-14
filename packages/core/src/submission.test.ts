import { describe, expect, test } from "vitest";
import type { RequestDefinition, TrustProfile } from "./request-definition.js";
import type { PublishedRequestVersion } from "./request-version.js";
import { createRequestVersionHashes } from "./request-version.js";
import { canonicalizeJson } from "./request-definition.js";
import { sha256Hash } from "./hash.js";
import {
  InMemoryIdempotencyStore,
  InMemorySubmissionRateLimiter,
  validateSubmissionEnvelope,
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

  test("test_verified_sender_without_signature_returns_auth_required", () => {
    const published = createPublished("verified_sender");
    const envelope = createEnvelope(published);
    const context = createContext(published);

    const result = validateSubmissionEnvelope(envelope, context);

    expect(result).toMatchObject({
      ok: false,
      status: "auth_required",
      error: {
        code: "sender_signature_required"
      }
    });
  });

  test("test_verified_sender_with_trusted_signature_is_accepted", () => {
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
      ok: true,
      status: "accepted",
      submission: {
        sender_key_id: "sender-key-001"
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
