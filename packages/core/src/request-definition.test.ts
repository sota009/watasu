import { describe, expect, test } from "vitest";
import {
  canonicalizeJson,
  validateRequestDefinitionInput
} from "./request-definition.js";

const publicKeyJwk = {
  kty: "EC",
  crv: "P-256",
  x: "base64url-x",
  y: "base64url-y"
};

function validRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
      service_key_id: "jwk-thumbprint:sha256:example",
      public_key_jwk: publicKeyJwk
    },
    metadata_retention: {
      days: 90
    },
    trust_profile: "public_capability",
    ...overrides
  };
}

describe("request definition validation", () => {
  test("test_valid_event_request_returns_normalized_definition", () => {
    const yaml = `
name: event-attendee-intake
schema_version: "2026-06-14"
description: Collect attendee details for ExampleConf.
fields:
  - id: full_name
    type: string
    required: true
    purpose: Confirm attendees at reception.
    sensitivity: low
  - id: email
    type: string
    format: email
    required: true
    purpose: Send event updates.
    sensitivity: low
consent:
  text: ExampleConf uses this information only for event operations.
destination:
  type: webhook
  url: https://example.com/watasu/intake
retention:
  destination_policy: Delete within 30 days after the event.
encryption:
  mode: required
  algorithm: JWE
  key_management: ECDH-ES+A256KW
  content_encryption: A256GCM
  service_key_id: jwk-thumbprint:sha256:example
  public_key_jwk:
    kty: EC
    crv: P-256
    x: base64url-x
    y: base64url-y
metadata_retention:
  days: 90
trust_profile: public_capability
`;

    const result = validateRequestDefinitionInput(yaml);

    expect(result.ok).toBe(true);
    expect(result.ok && result.definition.fields.map((field) => field.sensitivity)).toEqual([
      "moderate",
      "moderate"
    ]);
  });

  test("test_missing_required_fields_returns_invalid_request_definition", () => {
    const request = validRequest({ consent: undefined });

    const result = validateRequestDefinitionInput(JSON.stringify(request));

    expect(result).toMatchObject({
      ok: false,
      errors: [
        {
          code: "invalid_request_definition",
          path: "consent",
          message: "consent is required."
        }
      ]
    });
  });

  test("test_unknown_trust_profile_is_rejected", () => {
    const request = validRequest({ trust_profile: "anonymous_public" });

    const result = validateRequestDefinitionInput(JSON.stringify(request));

    expect(result).toMatchObject({
      ok: false,
      errors: [
        {
          code: "invalid_trust_profile",
          path: "trust_profile"
        }
      ]
    });
  });

  test("test_public_capability_with_high_sensitivity_field_is_rejected", () => {
    const request = validRequest({
      fields: [
        {
          id: "allergies",
          type: "string",
          required: false,
          purpose: "Coordinate safe meal options.",
          sensitivity: "high"
        }
      ],
      trust_profile: "public_capability"
    });

    const result = validateRequestDefinitionInput(JSON.stringify(request));

    expect(result).toMatchObject({
      ok: false,
      errors: [
        {
          code: "public_capability_high_sensitivity",
          path: "trust_profile"
        }
      ]
    });
  });

  test("test_authentication_secret_field_is_prohibited", () => {
    const request = validRequest({
      fields: [
        {
          id: "api_key",
          type: "string",
          required: true,
          purpose: "Connect to the customer integration.",
          sensitivity: "low"
        }
      ]
    });

    const result = validateRequestDefinitionInput(JSON.stringify(request));

    expect(result).toMatchObject({
      ok: false,
      errors: [
        {
          code: "prohibited_field",
          path: "fields[0]"
        }
      ]
    });
  });

  test("test_special_category_metadata_fields_are_prohibited", () => {
    const request = validRequest({
      fields: ["political_affiliation", "anonymous_source"].map((id) => ({
        id,
        type: "string",
        required: true,
        purpose: `Collect ${id}.`,
        sensitivity: "low"
      }))
    });

    const result = validateRequestDefinitionInput(JSON.stringify(request));

    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors).toEqual([
      expect.objectContaining({
        code: "prohibited_field",
        path: "fields[0]"
      }),
      expect.objectContaining({
        code: "prohibited_field",
        path: "fields[1]"
      })
    ]);
  });

  test("test_sensitivity_inference_upgrades_allergies_address_tax_id_minor_age", () => {
    const request = validRequest({
      fields: ["allergies", "address", "tax_id", "minor_age"].map((id) => ({
        id,
        type: "string",
        required: true,
        purpose: `Collect ${id}.`,
        sensitivity: "low"
      })),
      trust_profile: "verified_sender"
    });

    const result = validateRequestDefinitionInput(JSON.stringify(request));

    expect(result.ok && result.definition.fields.map((field) => field.sensitivity)).toEqual([
      "high",
      "high",
      "high",
      "high"
    ]);
  });

  test("test_human_override_cannot_downgrade_to_public_capability", () => {
    const request = validRequest({
      fields: [
        {
          id: "allergies",
          type: "string",
          required: false,
          purpose: "Coordinate safe meal options.",
          sensitivity: "low"
        }
      ],
      human_overrides: [
        {
          field_id: "allergies",
          sensitivity: "low",
          reason: "The organizer says this is not sensitive."
        }
      ],
      trust_profile: "public_capability"
    });

    const result = validateRequestDefinitionInput(JSON.stringify(request));

    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors).toContainEqual(
      expect.objectContaining({
        code: "human_override_cannot_downgrade_public_capability",
        path: "human_overrides[0]"
      })
    );
  });

  test("test_canonical_json_sorts_object_keys_and_preserves_field_order", () => {
    const request = {
      z: 1,
      fields: [{ id: "b" }, { id: "a" }],
      a: { y: 2, x: 1 }
    };

    const canonicalJson = canonicalizeJson(request);

    expect(canonicalJson).toBe('{"a":{"x":1,"y":2},"fields":[{"id":"b"},{"id":"a"}],"z":1}');
  });
});
