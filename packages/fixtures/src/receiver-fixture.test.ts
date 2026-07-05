import { describe, expect, test } from "vitest";
import {
  canonicalizeJson,
  createRequestVersionHashes,
  deliverAcceptedSubmission,
  generatePlaintextPayloadSchema,
  sha256Hash,
  type DeliveryClient,
  type DeliveryRequest,
  type PublishedRequestVersion,
  type RequestDefinition,
  type SubmissionEnvelope
} from "@watasu/core";
import {
  verifyReceiverFixtureDelivery,
  type ReceiverFixtureDecryptionInput
} from "./receiver-fixture.js";

const requestDefinition: RequestDefinition = {
  name: "event-attendee-intake",
  schema_version: "2026-06-14",
  description: "Collect attendee details for ExampleConf.",
  fields: [
    {
      id: "full_name",
      type: "string",
      required: true,
      purpose: "Confirm attendees at reception.",
      sensitivity: "low"
    },
    {
      id: "email",
      type: "string",
      format: "email",
      required: true,
      purpose: "Send event updates.",
      sensitivity: "low"
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
  trust_profile: "human_consent"
};

const encryptedPayload = {
  protected: "base64url-protected",
  iv: "base64url-iv",
  ciphertext: "base64url-ciphertext",
  tag: "base64url-tag"
};

const plaintextPayload = {
  full_name: "Alice Example",
  email: "alice@example.com"
};

function createPublished(): PublishedRequestVersion {
  return {
    request_id: "event-attendee-intake",
    request_version: "v1",
    definition: requestDefinition,
    hashes: createRequestVersionHashes(requestDefinition),
    published_at: "2026-06-14T11:00:00.000Z"
  };
}

function createEnvelope(published: PublishedRequestVersion): SubmissionEnvelope {
  return {
    request_id: published.request_id,
    request_version: published.request_version,
    schema_hash: published.hashes.schema_hash,
    consent_receipt_hash: published.hashes.consent_text_hash,
    idempotency_key: "submit-001",
    submitted_at: "2026-06-14T11:59:00.000Z",
    service_key_id: published.definition.encryption.service_key_id,
    encrypted_payload: encryptedPayload,
    encrypted_payload_hash: sha256Hash(canonicalizeJson(encryptedPayload))
  };
}

async function createSignedDeliveryRequest(
  overrides: { deliveredAt?: Date | undefined } = {}
): Promise<DeliveryRequest> {
  const published = createPublished();
  const requests: DeliveryRequest[] = [];
  const client: DeliveryClient = {
    async post(request) {
      requests.push(request);
      return {
        status: 204
      };
    }
  };

  await deliverAcceptedSubmission({
    mode: "hosted",
    published,
    envelope: createEnvelope(published),
    submission: {
      request_id: published.request_id,
      request_version: published.request_version,
      idempotency_key: "submit-001",
      submitted_at: "2026-06-14T11:59:00.000Z",
      accepted_at: "2026-06-14T12:00:00.000Z",
      capability_hash: sha256Hash("https://service.example.com/capabilities/test")
    },
    client,
    ledger: {
      writeDeliveryAttempt() {}
    },
    clock: () => overrides.deliveredAt ?? new Date("2026-06-14T12:00:00.000Z"),
    signingSecret: "receiver-fixture-secret",
    resolveDeliveryHost: async () => ["203.0.113.10"]
  });

  const request = requests[0];
  if (request === undefined) {
    throw new Error("Expected delivery request to be captured.");
  }

  return request;
}

describe("A2A receiver fixture", () => {
  test("test_receiver_fixture_verifies_delivery_signature", async () => {
    // Arrange
    const request = await createSignedDeliveryRequest();

    // Act
    const result = verifyReceiverFixtureDelivery({
      request,
      signingSecret: "receiver-fixture-secret",
      plaintextSchema: generatePlaintextPayloadSchema(requestDefinition),
      now: new Date("2026-06-14T12:00:30.000Z"),
      decryptPayload() {
        return plaintextPayload;
      }
    });

    // Assert
    expect(result).toMatchObject({
      ok: true,
      payload: plaintextPayload,
      metadata: {
        request_id: "event-attendee-intake",
        request_version: "v1",
        idempotency_key: "submit-001"
      }
    });
  });

  test("test_receiver_fixture_rejects_stale_timestamp", async () => {
    // Arrange
    const request = await createSignedDeliveryRequest({
      deliveredAt: new Date("2026-06-14T11:50:00.000Z")
    });

    // Act
    const result = verifyReceiverFixtureDelivery({
      request,
      signingSecret: "receiver-fixture-secret",
      plaintextSchema: generatePlaintextPayloadSchema(requestDefinition),
      now: new Date("2026-06-14T12:00:30.000Z"),
      decryptPayload() {
        return plaintextPayload;
      }
    });

    // Assert
    expect(result).toEqual({
      ok: false,
      error: {
        code: "stale_delivery_timestamp",
        message: "Delivery timestamp is outside the accepted window."
      }
    });
  });

  test("test_receiver_fixture_rejects_body_digest_mismatch", async () => {
    // Arrange
    const request = await createSignedDeliveryRequest();

    // Act
    const result = verifyReceiverFixtureDelivery({
      request: {
        ...request,
        body: JSON.stringify({
          envelope: {
            encrypted_payload: {
              ciphertext: "tampered"
            }
          }
        })
      },
      signingSecret: "receiver-fixture-secret",
      plaintextSchema: generatePlaintextPayloadSchema(requestDefinition),
      now: new Date("2026-06-14T12:00:30.000Z"),
      decryptPayload() {
        return plaintextPayload;
      }
    });

    // Assert
    expect(result).toEqual({
      ok: false,
      error: {
        code: "body_digest_mismatch",
        message: "Delivery body digest does not match the request body."
      }
    });
  });

  test("test_receiver_fixture_decrypts_and_validates_payload", async () => {
    // Arrange
    const request = await createSignedDeliveryRequest();
    const decryptionCalls: ReceiverFixtureDecryptionInput[] = [];

    // Act
    const result = verifyReceiverFixtureDelivery({
      request,
      signingSecret: "receiver-fixture-secret",
      plaintextSchema: generatePlaintextPayloadSchema(requestDefinition),
      now: new Date("2026-06-14T12:00:30.000Z"),
      decryptPayload(input) {
        decryptionCalls.push(input);
        return plaintextPayload;
      }
    });

    // Assert
    expect(result.ok).toBe(true);
    expect(decryptionCalls).toEqual([
      {
        encryptedPayload
      }
    ]);
  });

  test("test_receiver_fixture_rejects_invalid_decrypted_payload", async () => {
    // Arrange
    const request = await createSignedDeliveryRequest();

    // Act
    const result = verifyReceiverFixtureDelivery({
      request,
      signingSecret: "receiver-fixture-secret",
      plaintextSchema: generatePlaintextPayloadSchema(requestDefinition),
      now: new Date("2026-06-14T12:00:30.000Z"),
      decryptPayload() {
        return {
          full_name: "Alice Example"
        };
      }
    });

    // Assert
    expect(result).toEqual({
      ok: false,
      error: {
        code: "invalid_plaintext_payload",
        message: "Decrypted payload is missing required field: email."
      }
    });
  });

  test("test_receiver_fixture_rejects_replayed_idempotency_key", async () => {
    // Arrange
    const request = await createSignedDeliveryRequest();
    const processedKeys = new Set<string>();
    let decryptCalls = 0;

    const verify = () =>
      verifyReceiverFixtureDelivery({
        request,
        signingSecret: "receiver-fixture-secret",
        plaintextSchema: generatePlaintextPayloadSchema(requestDefinition),
        now: new Date("2026-06-14T12:00:30.000Z"),
        idempotencyStore: {
          claim(key) {
            if (processedKeys.has(key)) {
              return false;
            }

            processedKeys.add(key);
            return true;
          }
        },
        decryptPayload() {
          decryptCalls += 1;
          return plaintextPayload;
        }
      });

    // Act
    verify();
    const result = verify();

    // Assert
    expect(result).toEqual({
      ok: false,
      error: {
        code: "idempotency_key_replayed",
        message: "Delivery idempotency key has already been processed."
      }
    });
    expect(decryptCalls).toBe(1);
  });
});
