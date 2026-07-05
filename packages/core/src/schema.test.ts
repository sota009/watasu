import { describe, expect, test } from "vitest";
import type { RequestDefinition } from "./request-definition.js";
import { createRequestVersionHashes } from "./request-version.js";
import {
  generateEncryptedEnvelopeSchema,
  generatePlaintextPayloadSchema,
  validateGeneratedJsonSchema
} from "./schema.js";
import { sha256Hash } from "./hash.js";
import { canonicalizeJson } from "./request-definition.js";

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
    },
    {
      id: "email",
      type: "string",
      format: "email",
      required: true,
      purpose: "Send event updates.",
      sensitivity: "moderate",
      examples: ["alice@example.com"]
    },
    {
      id: "dietary_notes",
      type: "string",
      required: false,
      purpose: "Coordinate meal options.",
      sensitivity: "low"
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
  trust_profile: "verified_sender"
};

describe("plaintext payload schema generation", () => {
  test("test_plaintext_schema_contains_requested_fields_without_examples", () => {
    const schema = generatePlaintextPayloadSchema(baseDefinition);

    expect(schema).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
      properties: {
        full_name: { type: "string" },
        email: { type: "string" },
        dietary_notes: { type: "string" }
      }
    });
    expect(canonicalizeJson(schema)).not.toContain("alice@example.com");
  });

  test("test_required_fields_are_marked_required", () => {
    const schema = generatePlaintextPayloadSchema(baseDefinition);

    expect(schema.required).toEqual(["full_name", "email"]);
  });

  test("test_email_field_uses_email_format", () => {
    const schema = generatePlaintextPayloadSchema(baseDefinition);

    expect(schema.properties.email).toEqual({
      type: "string",
      format: "email"
    });
  });

  test("test_schema_hash_matches_generated_plaintext_schema", () => {
    const schema = generatePlaintextPayloadSchema(baseDefinition);
    const hashes = createRequestVersionHashes(baseDefinition);

    expect(hashes.schema_hash).toBe(sha256Hash(canonicalizeJson(schema)));
  });
});

describe("encrypted envelope schema generation", () => {
  test("test_envelope_schema_requires_idempotency_and_consent_receipt_hash", () => {
    const hashes = createRequestVersionHashes(baseDefinition);
    const schema = generateEncryptedEnvelopeSchema(baseDefinition, hashes);

    expect(schema.required).toEqual([
      "request_id",
      "request_version",
      "schema_hash",
      "consent_receipt_hash",
      "idempotency_key",
      "submitted_at",
      "service_key_id",
      "encrypted_payload",
      "encrypted_payload_hash"
    ]);
  });

  test("test_envelope_schema_omits_static_consent_receipt", () => {
    const hashes = createRequestVersionHashes(baseDefinition);
    const schema = generateEncryptedEnvelopeSchema(baseDefinition, hashes);

    // The static ConsentReceiptMetadata attestation was retired (§13); consent
    // binding now lives solely in the signed consent_receipt_token.
    expect(schema.properties.consent_receipt).toBeUndefined();
    expect(schema.required).not.toContain("consent_receipt");
  });
});

describe("generated JSON Schema 2020-12 validation", () => {
  test("test_generated_plaintext_schema_is_valid_json_schema_2020_12", () => {
    const schema = generatePlaintextPayloadSchema(baseDefinition);

    expect(validateGeneratedJsonSchema(schema)).toEqual({
      ok: true
    });
  });

  test("test_generated_envelope_schema_is_valid_json_schema_2020_12", () => {
    const hashes = createRequestVersionHashes(baseDefinition);
    const schema = generateEncryptedEnvelopeSchema(baseDefinition, hashes);

    expect(validateGeneratedJsonSchema(schema)).toEqual({
      ok: true
    });
  });

  test("test_invalid_generated_schema_returns_machine_readable_errors", () => {
    const schema = {
      ...generatePlaintextPayloadSchema(baseDefinition),
      type: "definitely-not-a-json-schema-type"
    };

    const result = validateGeneratedJsonSchema(schema);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toEqual({
        path: expect.any(String),
        message: expect.any(String)
      });
    }
  });
});
