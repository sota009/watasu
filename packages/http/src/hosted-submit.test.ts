import { describe, expect, test } from "vitest";
import {
  canonicalizeJson,
  InMemoryIdempotencyStore,
  InMemoryRequestVersionRepository,
  InMemorySubmissionRateLimiter,
  mintConsentReceipt,
  sha256Hash,
  type DeliveryLedgerRow,
  type DeliveryRequest,
  type PublishedRequestVersion,
  type RequestDefinition
} from "@watasu/core";
import { createHostedSubmitApp, type HostedSubmitRequest } from "./hosted-submit.js";

const signingSecret = "test-deployment-signing-secret-with-enough-entropy";

const encryptedPayload = {
  protected: "base64url-protected",
  iv: "base64url-iv",
  ciphertext: "base64url-ciphertext",
  tag: "base64url-tag"
};
const encryptedPayloadHash = sha256Hash(canonicalizeJson(encryptedPayload));

/** Mints a payload-bound human-consent receipt so a submit reaches delivery. */
function mintBoundReceipt(published: PublishedRequestVersion): Promise<string> {
  return mintConsentReceipt(
    {
      envelope_hash: encryptedPayloadHash,
      consent_text_hash: published.hashes.consent_text_hash,
      field_purposes_hash: published.hashes.field_purposes_hash,
      destination_policy_hash: published.hashes.destination_policy_hash,
      credential_id: "credential-xyz",
      approved_at: new Date("2026-06-15T00:00:00.500Z"),
      nonce: "nonce-approved",
      ttl_seconds: 3600,
      backup_eligible: true,
      backup_state: false
    },
    signingSecret
  );
}

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

function createRequest(input: {
  path?: string | undefined;
  body?: unknown;
  headers?: Record<string, string | undefined>;
} = {}): HostedSubmitRequest {
  return {
    method: "POST",
    path: input.path ?? "/requests/event-attendee-intake/submit",
    headers: input.headers ?? {
      "content-type": "application/a2a+json",
      "a2a-version": "1.0",
      "a2a-extensions": "https://watasu.dev/extensions/encrypted-intake/v1"
    },
    body: JSON.stringify(input.body)
  };
}

function createRepository() {
  const repository = new InMemoryRequestVersionRepository();
  const published = repository.publish("event-attendee-intake", definition);

  return {
    repository,
    published
  };
}

function createA2aBody(input: {
  published: ReturnType<typeof createRepository>["published"];
  idempotencyKey?: string | undefined;
  consentReceiptToken?: string | undefined;
}) {
  return {
    message: {
      role: "ROLE_USER",
      messageId: input.idempotencyKey ?? "submit-001",
      parts: [
        {
          type: "data",
          mediaType: "application/json",
          data: {
            request_id: input.published.request_id,
            request_version: input.published.request_version,
            schema_hash: input.published.hashes.schema_hash,
            consent_receipt_hash: input.published.hashes.consent_text_hash,
            idempotency_key: input.idempotencyKey ?? "submit-001",
            submitted_at: "2026-06-15T00:00:00.000Z",
            service_key_id: input.published.definition.encryption.service_key_id,
            encrypted_payload: encryptedPayload,
            encrypted_payload_hash: encryptedPayloadHash,
            consent_receipt_token: input.consentReceiptToken
          }
        }
      ]
    }
  };
}

describe("hosted submit HTTP app", () => {
  test("test_hosted_submit_delivers_valid_a2a_submission_without_retaining_payload_body", async () => {
    // Arrange
    const { repository, published } = createRepository();
    const deliveryRequests: DeliveryRequest[] = [];
    const ledgerRows: DeliveryLedgerRow[] = [];
    const app = createHostedSubmitApp({
      publicBaseUrl: "https://api.watasu.ai",
      requestVersions: repository,
      deliveryClient: {
        async post(request) {
          deliveryRequests.push(request);
          return {
            status: 204
          };
        }
      },
      ledger: {
        writeDeliveryAttempt(row) {
          ledgerRows.push(row);
        }
      },
      idempotencyStore: new InMemoryIdempotencyStore(),
      rateLimiter: new InMemorySubmissionRateLimiter({
        limit: 60,
        windowMs: 60_000,
        clock: () => new Date("2026-06-15T00:00:01.000Z")
      }),
      resolveDeliveryHost: async () => ["203.0.113.10"],
      clock: () => new Date("2026-06-15T00:00:01.000Z"),
      signingSecret,
      tenantId: "tenant-a"
    });

    // Act
    const response = await app.handle(createRequest({
      body: createA2aBody({ published, consentReceiptToken: await mintBoundReceipt(published) })
    }));

    // Assert
    expect(response.status).toBe(202);
    expect(JSON.parse(response.body)).toMatchObject({
      ok: true,
      status: "delivered",
      ledger: {
        request_id: "event-attendee-intake",
        encrypted_payload_hash: expect.stringMatching(/^sha256:/)
      }
    });
    expect(deliveryRequests).toHaveLength(1);
    expect(ledgerRows).toHaveLength(1);
    expect(JSON.stringify(ledgerRows)).not.toContain("\"encrypted_payload\"");
    expect(response.body).not.toContain("base64url-ciphertext");
  });

  test("test_hosted_submit_awaits_async_request_version_list_before_delivery", async () => {
    // Arrange
    const { repository, published } = createRepository();
    const deliveryRequests: DeliveryRequest[] = [];
    const app = createHostedSubmitApp({
      publicBaseUrl: "https://api.watasu.ai",
      requestVersions: {
        async list(requestId) {
          await Promise.resolve();

          return repository.list(requestId);
        }
      },
      deliveryClient: {
        async post(request) {
          deliveryRequests.push(request);
          return {
            status: 204
          };
        }
      },
      ledger: {
        writeDeliveryAttempt() {}
      },
      idempotencyStore: new InMemoryIdempotencyStore(),
      rateLimiter: new InMemorySubmissionRateLimiter({
        limit: 60,
        windowMs: 60_000,
        clock: () => new Date("2026-06-15T00:00:01.000Z")
      }),
      resolveDeliveryHost: async () => ["203.0.113.10"],
      clock: () => new Date("2026-06-15T00:00:01.000Z"),
      signingSecret
    });

    // Act
    const response = await app.handle(createRequest({
      body: createA2aBody({ published, consentReceiptToken: await mintBoundReceipt(published) })
    }));

    // Assert
    expect(response.status).toBe(202);
    expect(deliveryRequests).toHaveLength(1);
  });

  test("test_hosted_submit_rejects_missing_a2a_content_type_before_delivery", async () => {
    // Arrange
    const { repository, published } = createRepository();
    const deliveryRequests: DeliveryRequest[] = [];
    const app = createHostedSubmitApp({
      publicBaseUrl: "https://api.watasu.ai",
      requestVersions: repository,
      deliveryClient: {
        async post(request) {
          deliveryRequests.push(request);
          return {
            status: 204
          };
        }
      },
      ledger: {
        writeDeliveryAttempt() {}
      },
      idempotencyStore: new InMemoryIdempotencyStore(),
      rateLimiter: new InMemorySubmissionRateLimiter({
        limit: 60,
        windowMs: 60_000,
        clock: () => new Date("2026-06-15T00:00:01.000Z")
      }),
      resolveDeliveryHost: async () => ["203.0.113.10"],
      clock: () => new Date("2026-06-15T00:00:01.000Z"),
      signingSecret: "test-deployment-signing-secret-with-enough-entropy"
    });

    // Act
    const response = await app.handle(createRequest({
      body: createA2aBody({ published }),
      headers: {
        "a2a-version": "1.0",
        "a2a-extensions": "https://watasu.dev/extensions/encrypted-intake/v1"
      }
    }));

    // Assert
    expect(response.status).toBe(415);
    expect(JSON.parse(response.body)).toMatchObject({
      ok: false,
      error: {
        code: "missing_content_type"
      }
    });
    expect(deliveryRequests).toHaveLength(0);
  });

  test("test_hosted_submit_rejects_revoked_capability_before_delivery", async () => {
    // Arrange
    const { repository, published } = createRepository();
    const deliveryRequests: DeliveryRequest[] = [];
    const app = createHostedSubmitApp({
      publicBaseUrl: "https://api.watasu.ai",
      requestVersions: repository,
      deliveryClient: {
        async post(request) {
          deliveryRequests.push(request);
          return {
            status: 204
          };
        }
      },
      ledger: {
        writeDeliveryAttempt() {}
      },
      idempotencyStore: new InMemoryIdempotencyStore(),
      rateLimiter: new InMemorySubmissionRateLimiter({
        limit: 60,
        windowMs: 60_000,
        clock: () => new Date("2026-06-15T00:00:01.000Z")
      }),
      resolveDeliveryHost: async () => ["203.0.113.10"],
      async resolveCapability({ capabilityUrl, published, tenantId }) {
        expect(published.request_id).toBe("event-attendee-intake");
        expect(tenantId).toBe("tenant-a");
        return {
          url: capabilityUrl,
          revoked: true
        };
      },
      clock: () => new Date("2026-06-15T00:00:01.000Z"),
      signingSecret: "test-deployment-signing-secret-with-enough-entropy",
      tenantId: "tenant-a"
    });

    // Act
    const response = await app.handle(createRequest({
      body: createA2aBody({ published })
    }));

    // Assert
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toMatchObject({
      ok: false,
      status: "rejected",
      error: {
        code: "capability_revoked"
      }
    });
    expect(deliveryRequests).toHaveLength(0);
  });

  test("test_hosted_submit_awaits_async_idempotency_replay_rejection_before_delivery", async () => {
    // Arrange
    const { repository, published } = createRepository();
    const deliveryRequests: DeliveryRequest[] = [];
    const events: string[] = [];
    const app = createHostedSubmitApp({
      publicBaseUrl: "https://api.watasu.ai",
      requestVersions: repository,
      deliveryClient: {
        async post(request) {
          deliveryRequests.push(request);
          return {
            status: 204
          };
        }
      },
      ledger: {
        writeDeliveryAttempt() {}
      },
      idempotencyStore: {
        async claimValidation(recordKey, claim) {
          await Promise.resolve();
          events.push(`${recordKey}:${claim.status}`);
          return false;
        },
        async releaseValidation(recordKey) {
          await Promise.resolve();
          events.push(`release:${recordKey}`);
        }
      },
      rateLimiter: {
        async consume(key) {
          await Promise.resolve();
          events.push(`rate:${key}`);
          return true;
        }
      },
      resolveDeliveryHost: async () => ["203.0.113.10"],
      clock: () => new Date("2026-06-15T00:00:01.000Z"),
      signingSecret: "test-deployment-signing-secret-with-enough-entropy",
      tenantId: "tenant-a"
    });

    // Act
    const response = await app.handle(createRequest({
      body: createA2aBody({ published })
    }));

    // Assert
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toMatchObject({
      ok: false,
      status: "rejected",
      error: {
        code: "idempotency_key_replayed"
      }
    });
    expect(events).toEqual([
      `rate:event-attendee-intake:v1:${sha256Hash("https://api.watasu.ai/requests/event-attendee-intake/submit")}`,
      "event-attendee-intake:v1:submit-001:validation_accepted"
    ]);
    expect(deliveryRequests).toHaveLength(0);
  });

  test("test_hosted_submit_returns_not_found_for_unpublished_request", async () => {
    // Arrange
    const app = createHostedSubmitApp({
      publicBaseUrl: "https://api.watasu.ai",
      requestVersions: new InMemoryRequestVersionRepository(),
      deliveryClient: {
        async post() {
          throw new Error("delivery must not run for missing request");
        }
      },
      ledger: {
        writeDeliveryAttempt() {}
      },
      idempotencyStore: new InMemoryIdempotencyStore(),
      rateLimiter: new InMemorySubmissionRateLimiter({
        limit: 60,
        windowMs: 60_000,
        clock: () => new Date("2026-06-15T00:00:01.000Z")
      }),
      resolveDeliveryHost: async () => ["203.0.113.10"],
      clock: () => new Date("2026-06-15T00:00:01.000Z"),
      signingSecret: "test-deployment-signing-secret-with-enough-entropy"
    });

    // Act
    const response = await app.handle(createRequest({
      path: "/requests/missing/submit",
      body: {}
    }));

    // Assert
    expect(response.status).toBe(404);
    expect(JSON.parse(response.body)).toEqual({
      ok: false,
      error: {
        code: "request_version_not_found",
        message: "Published request was not found."
      }
    });
  });
});
