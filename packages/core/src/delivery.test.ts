import { describe, expect, test } from "vitest";
import { canonicalizeJson } from "./request-definition.js";
import type { RequestDefinition } from "./request-definition.js";
import { sha256Hash } from "./hash.js";
import { createRequestVersionHashes, type PublishedRequestVersion } from "./request-version.js";
import {
  createFetchDeliveryClient,
  InMemoryDeliveryCircuitBreaker,
  InMemoryDeliveryConcurrencyLimiter,
  deliverAcceptedSubmission,
  type AcceptedSubmission,
  type DeliveryClient,
  type DeliveryLogEvent,
  type DeliveryLedger,
  type DeliveryRequest,
  type SubmissionEnvelope
} from "./delivery.js";

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
  trust_profile: "public_capability"
};

const encryptedPayload = {
  protected: "base64url-protected",
  iv: "base64url-iv",
  ciphertext: "base64url-ciphertext",
  tag: "base64url-tag"
};

function createPublished(overrides: Partial<RequestDefinition> = {}): PublishedRequestVersion {
  const definition = {
    ...structuredClone(baseDefinition),
    ...overrides
  };

  return {
    request_id: "event-attendee-intake",
    request_version: "v1",
    definition,
    hashes: createRequestVersionHashes(definition),
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

function createAcceptedSubmission(): AcceptedSubmission {
  return {
    request_id: "event-attendee-intake",
    request_version: "v1",
    idempotency_key: "submit-001",
    submitted_at: "2026-06-14T11:59:00.000Z",
    accepted_at: "2026-06-14T12:00:00.000Z",
    capability_hash: sha256Hash("https://example.com/.well-known/watasu/cap/abc")
  };
}

function createLedger(): DeliveryLedger & { rows: unknown[] } {
  const rows: unknown[] = [];

  return {
    rows,
    writeDeliveryAttempt(row) {
      rows.push(row);
    }
  };
}

function createClient(responseStatus: number): DeliveryClient & { requests: DeliveryRequest[] } {
  const requests: DeliveryRequest[] = [];

  return {
    requests,
    async post(request) {
      requests.push(request);
      return {
        status: responseStatus
      };
    }
  };
}

describe("webhook delivery and metadata-only ledger", () => {
  test("test_delivery_uses_https_for_hosted_mode", async () => {
    const published = createPublished({
      destination: {
        type: "webhook",
        url: "http://receiver.example.com/watasu/intake"
      }
    });
    const ledger = createLedger();
    const client = createClient(200);

    const result = await deliverAcceptedSubmission({
      mode: "hosted",
      published,
      envelope: createEnvelope(published),
      submission: createAcceptedSubmission(),
      client,
      ledger,
      clock: () => now,
      signingSecret: "test-signing-secret"
    });

    expect(result).toMatchObject({
      ok: false,
      status: "rejected",
      error: {
        code: "unsafe_delivery_url"
      }
    });
    expect(client.requests).toHaveLength(0);
    expect(ledger.rows).toHaveLength(0);
  });

  test("test_hosted_delivery_rejects_private_ip_and_metadata_service_targets", async () => {
    const published = createPublished({
      destination: {
        type: "webhook",
        url: "https://169.254.169.254/latest/meta-data"
      }
    });
    const ledger = createLedger();
    const client = createClient(200);

    const result = await deliverAcceptedSubmission({
      mode: "hosted",
      published,
      envelope: createEnvelope(published),
      submission: createAcceptedSubmission(),
      client,
      ledger,
      clock: () => now,
      signingSecret: "test-signing-secret"
    });

    expect(result).toMatchObject({
      ok: false,
      status: "rejected",
      error: {
        code: "unsafe_delivery_url"
      }
    });
    expect(client.requests).toHaveLength(0);
    expect(ledger.rows).toHaveLength(0);
  });

  test("test_hosted_delivery_rejects_ipv6_loopback_targets", async () => {
    const published = createPublished({
      destination: {
        type: "webhook",
        url: "https://[::1]/watasu/intake"
      }
    });
    const ledger = createLedger();
    const client = createClient(200);

    const result = await deliverAcceptedSubmission({
      mode: "hosted",
      published,
      envelope: createEnvelope(published),
      submission: createAcceptedSubmission(),
      client,
      ledger,
      clock: () => now,
      signingSecret: "test-signing-secret"
    });

    expect(result).toMatchObject({
      ok: false,
      status: "rejected",
      error: {
        code: "unsafe_delivery_url"
      }
    });
    expect(client.requests).toHaveLength(0);
    expect(ledger.rows).toHaveLength(0);
  });

  test("test_delivery_signature_covers_timestamp_body_digest_and_ids", async () => {
    const published = createPublished();
    const envelope = createEnvelope(published);
    const ledger = createLedger();
    const client = createClient(200);

    await deliverAcceptedSubmission({
      mode: "hosted",
      published,
      envelope,
      submission: createAcceptedSubmission(),
      client,
      ledger,
      clock: () => now,
      signingSecret: "test-signing-secret"
    });

    expect(client.requests[0]).toMatchObject({
      url: "https://receiver.example.com/watasu/intake",
      headers: {
        "content-type": "application/json",
        "x-watasu-request-id": "event-attendee-intake",
        "x-watasu-request-version": "v1",
        "x-watasu-idempotency-key": "submit-001",
        "x-watasu-timestamp": "2026-06-14T12:00:00.000Z",
        "x-watasu-body-digest": sha256Hash(client.requests[0]?.body ?? "")
      }
    });
    expect(client.requests[0]?.headers["x-watasu-signature"]).toMatch(/^sha256=/);
  });

  test("test_webhook_2xx_returns_delivered", async () => {
    const published = createPublished();
    const ledger = createLedger();
    const client = createClient(204);

    const result = await deliverAcceptedSubmission({
      mode: "hosted",
      published,
      envelope: createEnvelope(published),
      submission: createAcceptedSubmission(),
      client,
      ledger,
      clock: () => now,
      signingSecret: "test-signing-secret"
    });

    expect(result).toMatchObject({
      ok: true,
      status: "delivered"
    });
    expect(ledger.rows).toMatchObject([
      {
        delivery_status: "delivered",
        webhook_status: 204
      }
    ]);
  });

  test("test_webhook_5xx_returns_resubmit_later", async () => {
    const published = createPublished();
    const ledger = createLedger();
    const client = createClient(503);

    const result = await deliverAcceptedSubmission({
      mode: "hosted",
      published,
      envelope: createEnvelope(published),
      submission: createAcceptedSubmission(),
      client,
      ledger,
      clock: () => now,
      signingSecret: "test-signing-secret"
    });

    expect(result).toMatchObject({
      ok: false,
      status: "resubmit_later",
      error: {
        code: "webhook_delivery_failed"
      }
    });
    expect(ledger.rows).toMatchObject([
      {
        delivery_status: "resubmit_later",
        webhook_status: 503
      }
    ]);
  });

  test("test_timeout_returns_resubmit_later", async () => {
    const published = createPublished();
    const ledger = createLedger();
    const client: DeliveryClient = {
      async post() {
        throw new Error("timeout");
      }
    };

    const result = await deliverAcceptedSubmission({
      mode: "hosted",
      published,
      envelope: createEnvelope(published),
      submission: createAcceptedSubmission(),
      client,
      ledger,
      clock: () => now,
      signingSecret: "test-signing-secret"
    });

    expect(result).toMatchObject({
      ok: false,
      status: "resubmit_later",
      error: {
        code: "webhook_delivery_failed"
      }
    });
    expect(ledger.rows).toMatchObject([
      {
        delivery_status: "resubmit_later",
        webhook_status: undefined
      }
    ]);
  });

  test("test_fetch_timeout_returns_resubmit_later_without_payload_body_retention", async () => {
    const published = createPublished();
    const envelope = createEnvelope(published);
    const ledger = createLedger();
    const logs: DeliveryLogEvent[] = [];
    const client = createFetchDeliveryClient({
      timeoutMs: 1,
      fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      })
    });

    const result = await deliverAcceptedSubmission({
      mode: "hosted",
      published,
      envelope,
      submission: createAcceptedSubmission(),
      client,
      ledger,
      logger: {
        write(event) {
          logs.push(event);
        }
      },
      clock: () => now,
      signingSecret: "test-signing-secret"
    });
    const retainedJson = canonicalizeJson({
      result,
      ledger: ledger.rows,
      logs
    });

    expect(result).toMatchObject({
      ok: false,
      status: "resubmit_later",
      error: {
        code: "webhook_delivery_timeout"
      }
    });
    expect(ledger.rows).toMatchObject([
      {
        delivery_status: "resubmit_later",
        error_code: "webhook_delivery_timeout",
        encrypted_payload_hash: envelope.encrypted_payload_hash
      }
    ]);
    expect(logs).toMatchObject([
      {
        delivery_status: "resubmit_later",
        error_code: "webhook_delivery_timeout",
        encrypted_payload_hash: envelope.encrypted_payload_hash
      }
    ]);
    expect(retainedJson).not.toContain("base64url-ciphertext");
    expect(retainedJson).not.toContain("\"encrypted_payload\"");
    expect(retainedJson).not.toContain("\"protected\"");
    expect(retainedJson).not.toContain("\"tag\"");
  });

  test("test_circuit_breaker_fails_fast_after_repeated_webhook_failures_without_payload_body", async () => {
    const published = createPublished();
    const envelope = createEnvelope(published);
    const ledger = createLedger();
    const logs: DeliveryLogEvent[] = [];
    const client = createClient(503);
    const circuitBreaker = new InMemoryDeliveryCircuitBreaker({
      failureThreshold: 2,
      cooldownMs: 60_000,
      clock: () => now
    });

    await deliverAcceptedSubmission({
      mode: "hosted",
      published,
      envelope,
      submission: createAcceptedSubmission(),
      client,
      ledger,
      logger: {
        write(event) {
          logs.push(event);
        }
      },
      circuitBreaker,
      clock: () => now,
      signingSecret: "test-signing-secret"
    });
    await deliverAcceptedSubmission({
      mode: "hosted",
      published,
      envelope,
      submission: {
        ...createAcceptedSubmission(),
        idempotency_key: "submit-002"
      },
      client,
      ledger,
      logger: {
        write(event) {
          logs.push(event);
        }
      },
      circuitBreaker,
      clock: () => now,
      signingSecret: "test-signing-secret"
    });
    const failFastResult = await deliverAcceptedSubmission({
      mode: "hosted",
      published,
      envelope,
      submission: {
        ...createAcceptedSubmission(),
        idempotency_key: "submit-003"
      },
      client,
      ledger,
      logger: {
        write(event) {
          logs.push(event);
        }
      },
      circuitBreaker,
      clock: () => now,
      signingSecret: "test-signing-secret"
    });
    const retainedJson = canonicalizeJson({
      failFastResult,
      ledger: ledger.rows,
      logs
    });

    expect(client.requests).toHaveLength(2);
    expect(failFastResult).toMatchObject({
      ok: false,
      status: "resubmit_later",
      error: {
        code: "webhook_circuit_open"
      }
    });
    expect(ledger.rows).toMatchObject([
      {
        delivery_status: "resubmit_later",
        error_code: "webhook_delivery_failed"
      },
      {
        delivery_status: "resubmit_later",
        error_code: "webhook_delivery_failed"
      },
      {
        delivery_status: "resubmit_later",
        error_code: "webhook_circuit_open"
      }
    ]);
    expect(retainedJson).not.toContain("base64url-ciphertext");
    expect(retainedJson).not.toContain("\"encrypted_payload\"");
  });

  test("test_request_concurrency_cap_fails_fast_without_payload_body", async () => {
    const published = createPublished();
    const envelope = createEnvelope(published);
    const ledger = createLedger();
    const client = createClient(204);
    const limiter = new InMemoryDeliveryConcurrencyLimiter({
      maxPerRequest: 0,
      maxPerTenant: 10
    });

    const result = await deliverAcceptedSubmission({
      mode: "hosted",
      published,
      envelope,
      submission: createAcceptedSubmission(),
      client,
      ledger,
      concurrencyLimiter: limiter,
      tenantId: "tenant-a",
      clock: () => now,
      signingSecret: "test-signing-secret"
    });
    const retainedJson = canonicalizeJson({
      result,
      ledger: ledger.rows
    });

    expect(client.requests).toHaveLength(0);
    expect(result).toMatchObject({
      ok: false,
      status: "resubmit_later",
      error: {
        code: "delivery_concurrency_limited"
      }
    });
    expect(ledger.rows).toMatchObject([
      {
        delivery_status: "resubmit_later",
        error_code: "delivery_concurrency_limited"
      }
    ]);
    expect(retainedJson).not.toContain("base64url-ciphertext");
    expect(retainedJson).not.toContain("\"encrypted_payload\"");
  });

  test("test_tenant_concurrency_cap_fails_fast_before_webhook_delivery", async () => {
    const published = createPublished();
    const ledger = createLedger();
    const client = createClient(204);
    const limiter = new InMemoryDeliveryConcurrencyLimiter({
      maxPerRequest: 10,
      maxPerTenant: 0
    });

    const result = await deliverAcceptedSubmission({
      mode: "hosted",
      published,
      envelope: createEnvelope(published),
      submission: createAcceptedSubmission(),
      client,
      ledger,
      concurrencyLimiter: limiter,
      tenantId: "tenant-a",
      clock: () => now,
      signingSecret: "test-signing-secret"
    });

    expect(client.requests).toHaveLength(0);
    expect(result).toMatchObject({
      ok: false,
      status: "resubmit_later",
      error: {
        code: "delivery_concurrency_limited"
      }
    });
  });

  test("test_ledger_row_does_not_store_plaintext_or_encrypted_payload_body", async () => {
    const published = createPublished();
    const ledger = createLedger();
    const client = createClient(200);

    await deliverAcceptedSubmission({
      mode: "hosted",
      published,
      envelope: createEnvelope(published),
      submission: createAcceptedSubmission(),
      client,
      ledger,
      clock: () => now,
      signingSecret: "test-signing-secret"
    });

    const ledgerJson = canonicalizeJson(ledger.rows);
    expect(ledgerJson).toContain("encrypted_payload_hash");
    expect(ledgerJson).not.toContain("base64url-ciphertext");
    expect(ledgerJson).not.toContain("\"encrypted_payload\"");
    expect(ledgerJson).not.toContain("full_name");
  });

  test("test_debug_logs_do_not_include_payload_bodies", async () => {
    const published = createPublished();
    const envelope = createEnvelope(published);
    const logs: DeliveryLogEvent[] = [];
    const logger = {
      write(event: DeliveryLogEvent) {
        logs.push(event);
      }
    };

    await deliverAcceptedSubmission({
      mode: "hosted",
      published,
      envelope,
      submission: createAcceptedSubmission(),
      client: createClient(204),
      ledger: createLedger(),
      logger,
      clock: () => now,
      signingSecret: "test-signing-secret"
    });
    await deliverAcceptedSubmission({
      mode: "hosted",
      published,
      envelope,
      submission: createAcceptedSubmission(),
      client: createClient(503),
      ledger: createLedger(),
      logger,
      clock: () => now,
      signingSecret: "test-signing-secret"
    });
    await deliverAcceptedSubmission({
      mode: "hosted",
      published,
      envelope,
      submission: createAcceptedSubmission(),
      client: {
        async post() {
          throw new Error("timeout");
        }
      },
      ledger: createLedger(),
      logger,
      clock: () => now,
      signingSecret: "test-signing-secret"
    });

    const logsJson = canonicalizeJson(logs);
    expect(logs).toMatchObject([
      {
        event: "watasu.delivery_attempt",
        delivery_status: "delivered",
        webhook_status: 204,
        encrypted_payload_hash: envelope.encrypted_payload_hash
      },
      {
        event: "watasu.delivery_attempt",
        delivery_status: "resubmit_later",
        webhook_status: 503,
        error_code: "webhook_delivery_failed"
      },
      {
        event: "watasu.delivery_attempt",
        delivery_status: "resubmit_later",
        error_code: "webhook_delivery_failed"
      }
    ]);
    expect(logsJson).not.toContain("base64url-ciphertext");
    expect(logsJson).not.toContain("\"encrypted_payload\"");
    expect(logsJson).not.toContain("\"protected\"");
    expect(logsJson).not.toContain("\"tag\"");
    expect(logsJson).not.toContain("receiver.example.com");
  });
});

describe("fetch delivery client adapter", () => {
  test("test_fetch_delivery_client_posts_signed_request_without_rewriting_body", async () => {
    const calls: Array<{
      url: string;
      init: RequestInit;
    }> = [];
    const client = createFetchDeliveryClient({
      fetch: async (url, init) => {
        calls.push({
          url: String(url),
          init: init ?? {}
        });
        return new Response(null, {
          status: 204
        });
      }
    });

    const response = await client.post({
      url: "https://receiver.example.com/watasu/intake",
      headers: {
        "content-type": "application/json",
        "x-watasu-request-id": "event-attendee-intake"
      },
      body: "{\"envelope\":{\"encrypted_payload_hash\":\"sha256:test\"}}"
    });

    expect(response).toEqual({
      status: 204
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: "https://receiver.example.com/watasu/intake",
      init: {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-watasu-request-id": "event-attendee-intake"
        },
        body: "{\"envelope\":{\"encrypted_payload_hash\":\"sha256:test\"}}"
      }
    });
  });

  test("test_fetch_delivery_client_returns_non_2xx_status_to_delivery_layer", async () => {
    const client = createFetchDeliveryClient({
      fetch: async () => new Response(null, {
        status: 503
      })
    });

    await expect(client.post({
      url: "https://receiver.example.com/watasu/intake",
      headers: {},
      body: "{}"
    })).resolves.toEqual({
      status: 503
    });
  });

  test("test_fetch_delivery_client_aborts_after_timeout", async () => {
    const signals: AbortSignal[] = [];
    const client = createFetchDeliveryClient({
      timeoutMs: 1,
      fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => {
        if (init?.signal instanceof AbortSignal) {
          signals.push(init.signal);
          init.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }
      })
    });

    await expect(client.post({
      url: "https://receiver.example.com/watasu/intake",
      headers: {},
      body: "{}"
    })).rejects.toThrow("aborted");
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
  });
});
