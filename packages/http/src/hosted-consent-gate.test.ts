import { describe, expect, test } from "vitest";
import {
  canonicalizeJson,
  InMemoryIdempotencyStore,
  InMemoryRequestVersionRepository,
  InMemorySubmissionRateLimiter,
  mintConsentReceipt,
  sha256Hash,
  type DeliveryRequest,
  type RequestDefinition
} from "@watasu/core";
import { createHostedSubmitApp, type HostedSubmitRequest } from "./hosted-submit.js";

const signingSecret = "consent-gate-signing-secret-with-enough-entropy-000";

const definition: RequestDefinition = {
  name: "consent-gated-intake",
  schema_version: "2026-07-05",
  description: "Collect attendee details behind a human consent gate.",
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

const encryptedPayload = {
  protected: "base64url-protected",
  iv: "base64url-iv",
  ciphertext: "base64url-ciphertext",
  tag: "base64url-tag"
};
const encryptedPayloadHash = sha256Hash(canonicalizeJson(encryptedPayload));

function createRepository() {
  const repository = new InMemoryRequestVersionRepository();
  const published = repository.publish("consent-gated-intake", definition);
  return { repository, published };
}

function createA2aData(published: ReturnType<typeof createRepository>["published"], extra: Record<string, unknown> = {}) {
  return {
    request_id: published.request_id,
    request_version: published.request_version,
    schema_hash: published.hashes.schema_hash,
    consent_receipt_hash: published.hashes.consent_text_hash,
    idempotency_key: "submit-consent-001",
    submitted_at: "2026-07-05T00:00:00.000Z",
    service_key_id: published.definition.encryption.service_key_id,
    encrypted_payload: encryptedPayload,
    encrypted_payload_hash: encryptedPayloadHash,
    ...extra
  };
}

function createRequest(data: Record<string, unknown>): HostedSubmitRequest {
  return {
    method: "POST",
    path: "/requests/consent-gated-intake/submit",
    headers: {
      "content-type": "application/a2a+json",
      "a2a-version": "1.0",
      "a2a-extensions": "https://watasu.dev/extensions/encrypted-intake/v1"
    },
    body: JSON.stringify({
      message: {
        role: "ROLE_USER",
        messageId: "submit-consent-001",
        parts: [{ type: "data", mediaType: "application/json", data }]
      }
    })
  };
}

function createApp(input: {
  deliveryRequests: DeliveryRequest[];
  idempotencyStore: InMemoryIdempotencyStore;
  repository: InMemoryRequestVersionRepository;
}) {
  return createHostedSubmitApp({
    publicBaseUrl: "https://api.watasu.ai",
    requestVersions: input.repository,
    deliveryClient: {
      async post(request) {
        input.deliveryRequests.push(request);
        return { status: 204 };
      }
    },
    ledger: { writeDeliveryAttempt() {} },
    idempotencyStore: input.idempotencyStore,
    rateLimiter: new InMemorySubmissionRateLimiter({
      limit: 60,
      windowMs: 60_000,
      clock: () => new Date("2026-07-05T00:00:01.000Z")
    }),
    resolveDeliveryHost: async () => ["203.0.113.10"],
    clock: () => new Date("2026-07-05T00:00:01.000Z"),
    signingSecret,
    tenantId: "tenant-a"
  });
}

describe("hosted submit consent gate", () => {
  test("test_human_consent_first_hit_returns_auth_required_with_consent_urls", async () => {
    const { repository, published } = createRepository();
    const deliveryRequests: DeliveryRequest[] = [];
    const idempotencyStore = new InMemoryIdempotencyStore();
    const app = createApp({ deliveryRequests, idempotencyStore, repository });

    const response = await app.handle(createRequest(createA2aData(published)));

    expect(response.status).toBe(401);
    const body = JSON.parse(response.body);
    expect(body).toMatchObject({
      ok: false,
      status: "auth_required",
      consent: {
        expires_in: 600
      }
    });
    expect(body.consent.consent_url).toContain(
      "https://api.watasu.ai/requests/consent-gated-intake/consent/"
    );
    expect(body.consent.poll_url).toMatch(/\/consent\/.+\/status$/);
    expect(deliveryRequests).toHaveLength(0);

    // The validation claim must be released so the resume can re-submit.
    expect(
      idempotencyStore.has("consent-gated-intake:v1:submit-consent-001")
    ).toBe(false);
  });

  test("test_human_consent_delivers_with_valid_bound_receipt", async () => {
    const { repository, published } = createRepository();
    const deliveryRequests: DeliveryRequest[] = [];
    const idempotencyStore = new InMemoryIdempotencyStore();
    const app = createApp({ deliveryRequests, idempotencyStore, repository });

    const receipt = await mintConsentReceipt(
      {
        envelope_hash: encryptedPayloadHash,
        consent_text_hash: published.hashes.consent_text_hash,
        field_purposes_hash: published.hashes.field_purposes_hash,
        destination_policy_hash: published.hashes.destination_policy_hash,
        credential_id: "credential-xyz",
        approved_at: new Date("2026-07-05T00:00:00.500Z"),
        nonce: "nonce-approved",
        ttl_seconds: 3600
      },
      signingSecret
    );

    const response = await app.handle(
      createRequest(createA2aData(published, { consent_receipt_token: receipt }))
    );

    expect(response.status).toBe(202);
    expect(JSON.parse(response.body)).toMatchObject({
      ok: true,
      status: "delivered"
    });
    expect(deliveryRequests).toHaveLength(1);
  });

  test("test_human_consent_rejects_receipt_bound_to_a_different_payload", async () => {
    const { repository, published } = createRepository();
    const deliveryRequests: DeliveryRequest[] = [];
    const idempotencyStore = new InMemoryIdempotencyStore();
    const app = createApp({ deliveryRequests, idempotencyStore, repository });

    const receipt = await mintConsentReceipt(
      {
        envelope_hash: "sha256:some-other-payload",
        consent_text_hash: published.hashes.consent_text_hash,
        field_purposes_hash: published.hashes.field_purposes_hash,
        destination_policy_hash: published.hashes.destination_policy_hash,
        credential_id: "credential-xyz",
        approved_at: new Date("2026-07-05T00:00:00.500Z"),
        nonce: "nonce-approved",
        ttl_seconds: 3600
      },
      signingSecret
    );

    const response = await app.handle(
      createRequest(createA2aData(published, { consent_receipt_token: receipt }))
    );

    // Mismatched receipt is treated as "no valid receipt" → re-pause.
    expect(response.status).toBe(401);
    expect(JSON.parse(response.body).status).toBe("auth_required");
    expect(deliveryRequests).toHaveLength(0);
  });

  test("test_human_consent_rejects_receipt_bound_to_stale_terms", async () => {
    const { repository, published } = createRepository();
    const deliveryRequests: DeliveryRequest[] = [];
    const idempotencyStore = new InMemoryIdempotencyStore();
    const app = createApp({ deliveryRequests, idempotencyStore, repository });

    // Correct payload + consent text, but the receipt was signed against a
    // stale field-purposes hash — the gate must not accept it.
    const receipt = await mintConsentReceipt(
      {
        envelope_hash: encryptedPayloadHash,
        consent_text_hash: published.hashes.consent_text_hash,
        field_purposes_hash: "sha256:stale-field-purposes",
        destination_policy_hash: published.hashes.destination_policy_hash,
        credential_id: "credential-xyz",
        approved_at: new Date("2026-07-05T00:00:00.500Z"),
        nonce: "nonce-approved",
        ttl_seconds: 3600
      },
      signingSecret
    );

    const response = await app.handle(
      createRequest(createA2aData(published, { consent_receipt_token: receipt }))
    );

    expect(response.status).toBe(401);
    expect(JSON.parse(response.body).status).toBe("auth_required");
    expect(deliveryRequests).toHaveLength(0);
  });
});
