import { describe, expect, test } from "vitest";
import {
  buildAgentCard,
  canonicalizeJson,
  generatePlaintextPayloadSchema,
  sha256Hash,
  watasuEncryptedIntakeExtensionUri,
  type AgentCard,
  type PublishedRequestVersion,
  type RequestDefinition
} from "@watasu/core";
import {
  buildSenderFixtureSubmission,
  extractPlaintextSchemaFields,
  type SenderFixtureEncryptedPayload
} from "./sender-fixture.js";

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

const published: PublishedRequestVersion = {
  request_id: "event-attendee-intake",
  request_version: "v1",
  definition: requestDefinition,
  hashes: {
    request_version_hash: "sha256:request",
    schema_hash: "sha256:schema",
    consent_text_hash: "sha256:consent",
    field_purposes_hash: "sha256:purposes",
    destination_policy_hash: "sha256:destination",
    public_key_fingerprint: "sha256:public-key"
  },
  published_at: "2026-06-14T12:00:00.000Z"
};

const payload = {
  full_name: "Alice Example",
  email: "alice@example.com"
};

function createAgentCard(): AgentCard {
  return buildAgentCard({
    published,
    endpointUrl: "https://service.example.com/a2a/requests/event-attendee-intake/v1"
  });
}

function createEncryptedPayload(): SenderFixtureEncryptedPayload {
  return {
    protected: "base64url-protected",
    iv: "base64url-iv",
    ciphertext: "base64url-ciphertext",
    tag: "base64url-tag"
  };
}

describe("A2A sender fixture", () => {
  test("test_sender_fixture_reads_agent_card_and_schema", () => {
    // Arrange
    const schema = generatePlaintextPayloadSchema(requestDefinition);

    // Act
    const fields = extractPlaintextSchemaFields(schema);

    // Assert
    expect(fields).toEqual(["full_name", "email"]);
  });

  test("test_sender_fixture_encrypts_payload_before_submission", () => {
    // Arrange
    const encryptedPayload = createEncryptedPayload();
    const encryptionCalls: unknown[] = [];

    // Act
    const submission = buildSenderFixtureSubmission({
      agentCard: createAgentCard(),
      plaintextSchema: generatePlaintextPayloadSchema(requestDefinition),
      payload,
      idempotencyKey: "submit-001",
      submittedAt: "2026-06-14T12:01:00.000Z",
      encryptPayload(input) {
        encryptionCalls.push(input);
        return encryptedPayload;
      }
    });

    // Assert
    expect(encryptionCalls).toEqual([
      {
        payload,
        encryption: createAgentCard().capabilities.extensions[0]?.params.encryption
      }
    ]);
    expect(canonicalizeJson(submission.body)).not.toContain("Alice Example");
    expect(canonicalizeJson(submission.body)).toContain("base64url-ciphertext");
  });

  test("test_sender_fixture_uses_part_data_and_application_json_media_type", () => {
    // Arrange
    const encryptedPayload = createEncryptedPayload();

    // Act
    const submission = buildSenderFixtureSubmission({
      agentCard: createAgentCard(),
      plaintextSchema: generatePlaintextPayloadSchema(requestDefinition),
      payload,
      idempotencyKey: "submit-001",
      submittedAt: "2026-06-14T12:01:00.000Z",
      encryptPayload() {
        return encryptedPayload;
      }
    });

    // Assert
    expect(submission).toMatchObject({
      url: "https://service.example.com/a2a/requests/event-attendee-intake/v1",
      headers: {
        "content-type": "application/a2a+json",
        "a2a-version": "1.0",
        "a2a-extensions": watasuEncryptedIntakeExtensionUri
      },
      body: {
        message: {
          role: "ROLE_USER",
          parts: [
            {
              type: "data",
              mediaType: "application/json",
              data: {
                request_id: "event-attendee-intake",
                request_version: "v1",
                schema_hash: "sha256:schema",
                consent_receipt_hash: "sha256:consent",
                idempotency_key: "submit-001",
                submitted_at: "2026-06-14T12:01:00.000Z",
                service_key_id: "jwk-thumbprint:sha256:service",
                encrypted_payload: encryptedPayload,
                encrypted_payload_hash: sha256Hash(canonicalizeJson(encryptedPayload))
              }
            }
          ]
        }
      }
    });
  });
});
