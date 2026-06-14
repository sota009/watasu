import { describe, expect, test } from "vitest";
import type { RequestDefinition } from "./request-definition.js";
import { createRequestVersionHashes } from "./request-version.js";
import {
  generateEncryptedEnvelopeSchema,
  generatePlaintextPayloadSchema
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
});
