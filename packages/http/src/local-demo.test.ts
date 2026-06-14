import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { watasuEncryptedIntakeExtensionUri } from "@watasu/core";
import {
  createLocalDemoApp,
  createLocalDemoServer,
  localDemoRequestId,
  localDemoSubmitPath
} from "./local-demo.js";

function parseJson(body: string): unknown {
  return JSON.parse(body) as unknown;
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
    const app = createLocalDemoApp({ baseUrl: "http://127.0.0.1:8787" });
    const envelope = {
      request_id: localDemoRequestId,
      request_version: "v1",
      schema_hash: "sha256:demo",
      consent_receipt_hash: "sha256:demo-consent",
      idempotency_key: "submit-001",
      submitted_at: "2026-06-14T12:00:00.000Z",
      service_key_id: "jwk-thumbprint:sha256:local-demo",
      encrypted_payload: { ciphertext: "not-logged" },
      encrypted_payload_hash: createHash("sha256").update("{}").digest("hex")
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
      body: JSON.stringify({
        message: {
          role: "ROLE_USER",
          messageId: "submission-1",
          parts: [{ type: "data", mediaType: "application/json", data: envelope }]
        }
      })
    });

    // Assert
    expect(parseJson(response.body)).toMatchObject({
      ok: true,
      status: "protocol_accepted"
    });
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
