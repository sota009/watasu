import { describe, expect, test } from "vitest";
import {
  canonicalizeJson,
  sha256Hash,
  watasuEncryptedIntakeExtensionUri,
  type DeliveryClient,
  type DeliveryRequest
} from "@watasu/core";
import {
  createLocalDemoApp,
  createLocalDemoServer,
  localDemoRequestId,
  localDemoSubmitPath
} from "./local-demo.js";

function parseJson(body: string): unknown {
  return JSON.parse(body) as unknown;
}

function createValidEnvelope(app: ReturnType<typeof createLocalDemoApp>) {
  const encryptedPayload = {
    protected: "base64url-protected",
    iv: "base64url-iv",
    ciphertext: "base64url-ciphertext",
    tag: "base64url-tag"
  };

  return {
    request_id: localDemoRequestId,
    request_version: app.published.request_version,
    schema_hash: app.published.hashes.schema_hash,
    consent_receipt_hash: app.published.hashes.consent_text_hash,
    idempotency_key: "submit-001",
    submitted_at: "2026-06-14T11:59:00.000Z",
    service_key_id: app.published.definition.encryption.service_key_id,
    encrypted_payload: encryptedPayload,
    encrypted_payload_hash: sha256Hash(canonicalizeJson(encryptedPayload))
  };
}

function createA2aSubmitBody(envelope: unknown): string {
  return JSON.stringify({
    message: {
      role: "ROLE_USER",
      messageId: "submission-1",
      parts: [{ type: "data", mediaType: "application/json", data: envelope }]
    }
  });
}

function createDeliveryClient(status: number): DeliveryClient & { requests: DeliveryRequest[] } {
  const requests: DeliveryRequest[] = [];

  return {
    requests,
    async post(request) {
      requests.push(request);
      return {
        status
      };
    }
  };
}

describe("local HTTP demo app", () => {
  test("test_agent_card_endpoint_returns_published_fixture_card", async () => {
    // Arrange
    const app = createLocalDemoApp({ baseUrl: "http://127.0.0.1:8787" });

    // Act
    const response = await app.handle({
      method: "GET",
      path: "/.well-known/agent-card.json",
      headers: {},
      body: ""
    });

    // Assert
    expect(parseJson(response.body)).toMatchObject({
      protocolVersion: "1.0",
      supportedInterfaces: [
        {
          url: `http://127.0.0.1:8787${localDemoSubmitPath}`,
          protocolBinding: "HTTP+JSON"
        }
      ],
      capabilities: {
        extensions: [
          expect.objectContaining({
            uri: watasuEncryptedIntakeExtensionUri,
            required: true
          })
        ]
      }
    });
  });

  test("test_plaintext_schema_endpoint_returns_fixture_fields", async () => {
    // Arrange
    const app = createLocalDemoApp({ baseUrl: "http://127.0.0.1:8787" });

    // Act
    const response = await app.handle({
      method: "GET",
      path: "/schemas/plaintext.json",
      headers: {},
      body: ""
    });

    // Assert
    expect(parseJson(response.body)).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["full_name", "email"],
      properties: {
        full_name: { type: "string" },
        email: { type: "string", format: "email" }
      }
    });
  });

  test("test_envelope_schema_endpoint_returns_fixture_binding", async () => {
    // Arrange
    const app = createLocalDemoApp({ baseUrl: "http://127.0.0.1:8787" });

    // Act
    const response = await app.handle({
      method: "GET",
      path: "/schemas/envelope.json",
      headers: {},
      body: ""
    });

    // Assert
    expect(parseJson(response.body)).toMatchObject({
      required: expect.arrayContaining(["request_id", "request_version", "encrypted_payload"]),
      properties: {
        request_id: { type: "string" },
        request_version: { type: "string" },
        encrypted_payload: { type: "object" }
      }
    });
  });

  test("test_post_submit_missing_content_type_returns_structured_rejection_without_body", async () => {
    // Arrange
    const app = createLocalDemoApp({ baseUrl: "http://127.0.0.1:8787" });
    const sensitiveBody = "super-secret-body-value";

    // Act
    const response = await app.handle({
      method: "POST",
      path: localDemoSubmitPath,
      headers: {
        "a2a-version": "1.0",
        "a2a-extensions": watasuEncryptedIntakeExtensionUri
      },
      body: sensitiveBody
    });

    // Assert
    expect(response.status).toBe(415);
    expect(parseJson(response.body)).toEqual({
      ok: false,
      error: {
        code: "missing_content_type",
        message: "A2A submissions require Content-Type: application/a2a+json.",
        path: "headers.content-type"
      }
    });
    expect(response.body).not.toContain(sensitiveBody);
  });

  test("test_post_submit_valid_a2a_shape_passes_protocol_gate", async () => {
    // Arrange
    const app = createLocalDemoApp({
      baseUrl: "http://127.0.0.1:8787",
      clock: () => new Date("2026-06-14T12:00:00.000Z")
    });
    const envelope = createValidEnvelope(app);

    // Act
    const response = await app.handle({
      method: "POST",
      path: localDemoSubmitPath,
      headers: {
        "content-type": "application/a2a+json",
        "a2a-version": "1.0",
        "a2a-extensions": watasuEncryptedIntakeExtensionUri
      },
      body: createA2aSubmitBody(envelope)
    });

    // Assert
    expect(parseJson(response.body)).toMatchObject({
      ok: true,
      status: "delivered"
    });
  });

  test("test_post_submit_delivers_to_receiver_fixture_and_records_metadata", async () => {
    // Arrange
    const client = createDeliveryClient(204);
    const app = createLocalDemoApp({
      baseUrl: "http://127.0.0.1:8787",
      deliveryClient: client,
      clock: () => new Date("2026-06-14T12:00:00.000Z")
    });
    const envelope = createValidEnvelope(app);

    // Act
    const response = await app.handle({
      method: "POST",
      path: localDemoSubmitPath,
      headers: {
        "content-type": "application/a2a+json",
        "a2a-version": "1.0",
        "a2a-extensions": watasuEncryptedIntakeExtensionUri
      },
      body: createA2aSubmitBody(envelope)
    });

    // Assert
    expect(response.status).toBe(202);
    expect(parseJson(response.body)).toMatchObject({
      ok: true,
      status: "delivered",
      ledger: {
        request_id: localDemoRequestId,
        request_version: "v1",
        idempotency_key: "submit-001",
        delivery_status: "delivered",
        encrypted_payload_hash: envelope.encrypted_payload_hash
      }
    });
    expect(client.requests).toHaveLength(1);
    expect(client.requests[0]).toMatchObject({
      url: "http://localhost:8787/watasu/intake",
      headers: {
        "x-watasu-request-id": localDemoRequestId,
        "x-watasu-request-version": "v1",
        "x-watasu-idempotency-key": "submit-001"
      }
    });
  });

  test("test_post_submit_delivery_failure_returns_resubmit_later", async () => {
    // Arrange
    const app = createLocalDemoApp({
      baseUrl: "http://127.0.0.1:8787",
      deliveryClient: createDeliveryClient(503),
      clock: () => new Date("2026-06-14T12:00:00.000Z")
    });

    // Act
    const response = await app.handle({
      method: "POST",
      path: localDemoSubmitPath,
      headers: {
        "content-type": "application/a2a+json",
        "a2a-version": "1.0",
        "a2a-extensions": watasuEncryptedIntakeExtensionUri
      },
      body: createA2aSubmitBody(createValidEnvelope(app))
    });

    // Assert
    expect(response.status).toBe(503);
    expect(parseJson(response.body)).toMatchObject({
      ok: false,
      status: "resubmit_later",
      error: {
        code: "webhook_delivery_failed"
      }
    });
  });

  test("test_post_submit_schema_hash_mismatch_returns_structured_rejection", async () => {
    // Arrange
    const client = createDeliveryClient(204);
    const app = createLocalDemoApp({
      baseUrl: "http://127.0.0.1:8787",
      deliveryClient: client,
      clock: () => new Date("2026-06-14T12:00:00.000Z")
    });
    const envelope = {
      ...createValidEnvelope(app),
      schema_hash: "sha256:wrong"
    };

    // Act
    const response = await app.handle({
      method: "POST",
      path: localDemoSubmitPath,
      headers: {
        "content-type": "application/a2a+json",
        "a2a-version": "1.0",
        "a2a-extensions": watasuEncryptedIntakeExtensionUri
      },
      body: createA2aSubmitBody(envelope)
    });

    // Assert
    expect(response.status).toBe(400);
    expect(parseJson(response.body)).toMatchObject({
      ok: false,
      status: "rejected",
      error: {
        code: "schema_hash_mismatch"
      }
    });
    expect(client.requests).toHaveLength(0);
  });

  test("test_post_submit_delivery_failure_allows_same_idempotency_key_retry", async () => {
    // Arrange
    const requests: DeliveryRequest[] = [];
    const client: DeliveryClient = {
      async post(request) {
        requests.push(request);
        return {
          status: requests.length === 1 ? 503 : 204
        };
      }
    };
    const app = createLocalDemoApp({
      baseUrl: "http://127.0.0.1:8787",
      deliveryClient: client,
      clock: () => new Date("2026-06-14T12:00:00.000Z")
    });
    const request = {
      method: "POST",
      path: localDemoSubmitPath,
      headers: {
        "content-type": "application/a2a+json",
        "a2a-version": "1.0",
        "a2a-extensions": watasuEncryptedIntakeExtensionUri
      },
      body: createA2aSubmitBody(createValidEnvelope(app))
    };

    // Act
    const firstResponse = await app.handle(request);
    const secondResponse = await app.handle(request);

    // Assert
    expect(firstResponse.status).toBe(503);
    expect(secondResponse.status).toBe(202);
    expect(parseJson(secondResponse.body)).toMatchObject({
      ok: true,
      status: "delivered"
    });
  });

  test("test_get_ledger_returns_metadata_without_payload_body", async () => {
    // Arrange
    const app = createLocalDemoApp({
      baseUrl: "http://127.0.0.1:8787",
      deliveryClient: createDeliveryClient(204),
      clock: () => new Date("2026-06-14T12:00:00.000Z")
    });

    await app.handle({
      method: "POST",
      path: localDemoSubmitPath,
      headers: {
        "content-type": "application/a2a+json",
        "a2a-version": "1.0",
        "a2a-extensions": watasuEncryptedIntakeExtensionUri
      },
      body: createA2aSubmitBody(createValidEnvelope(app))
    });

    // Act
    const response = await app.handle({
      method: "GET",
      path: "/ledger",
      headers: {},
      body: ""
    });

    // Assert
    expect(parseJson(response.body)).toMatchObject({
      ok: true,
      ledger: [
        {
          request_id: localDemoRequestId,
          delivery_status: "delivered",
          encrypted_payload_hash: expect.any(String)
        }
      ]
    });
    expect(response.body).not.toContain("base64url-ciphertext");
    expect(response.body).not.toContain("\"encrypted_payload\"");
    expect(response.body).not.toContain("\"protected\"");
    expect(response.body).not.toContain("\"tag\"");
  });

  test("test_default_demo_mode_does_not_persist_delivery_metadata", async () => {
    // Arrange
    const persistentRows: unknown[] = [];
    const app = createLocalDemoApp({
      baseUrl: "http://127.0.0.1:8787",
      deliveryClient: createDeliveryClient(204),
      clock: () => new Date("2026-06-14T12:00:00.000Z"),
      persistentLedgerStore: {
        writeDeliveryAttempt(row) {
          persistentRows.push(row);
        }
      }
    });

    // Act
    await app.handle({
      method: "POST",
      path: localDemoSubmitPath,
      headers: {
        "content-type": "application/a2a+json",
        "a2a-version": "1.0",
        "a2a-extensions": watasuEncryptedIntakeExtensionUri
      },
      body: createA2aSubmitBody(createValidEnvelope(app))
    });

    // Assert
    expect(persistentRows).toHaveLength(0);
  });
});

describe("local HTTP demo server", () => {
  test("test_create_local_demo_server_returns_node_http_server", () => {
    // Arrange
    const app = createLocalDemoApp({ baseUrl: "http://127.0.0.1:8787" });

    // Act
    const server = createLocalDemoServer(app);

    // Assert
    expect(server.listening).toBe(false);
    server.close();
  });
});
