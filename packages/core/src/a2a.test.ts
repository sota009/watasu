import { describe, expect, test } from "vitest";
import {
  gateA2aSubmissionProtocol,
  watasuA2aProtocolVersion
} from "./a2a.js";
import { watasuEncryptedIntakeExtensionUri } from "./agent-card.js";

const validBody = {
  jsonrpc: "2.0",
  id: "submission-1",
  method: "message/send",
  params: {
    message: {
      role: "user",
      parts: [
        {
          type: "data",
          mediaType: "application/json",
          data: {
            request_id: "event-attendee-intake",
            request_version: "v1",
            schema_hash: "sha256-example",
            consent_receipt_hash: "sha256-consent",
            idempotency_key: "idem-1",
            submitted_at: "2026-06-14T00:00:00.000Z",
            service_key_id: "jwk-thumbprint:sha256:example",
            encrypted_payload: { protected: "example" },
            encrypted_payload_hash: "sha256-payload"
          }
        }
      ]
    }
  }
};

function validRequest(overrides?: {
  headers?: Record<string, string | undefined>;
  body?: unknown;
}) {
  return {
    headers: {
      "content-type": "application/json",
      "a2a-version": watasuA2aProtocolVersion,
      "a2a-extensions": watasuEncryptedIntakeExtensionUri,
      ...overrides?.headers
    },
    body: overrides?.body ?? validBody
  };
}

describe("A2A submission protocol gate", () => {
  test("test_missing_content_type_is_rejected_before_envelope_validation", () => {
    // Arrange
    let envelopeValidationCalls = 0;
    const request = validRequest({
      headers: {
        "content-type": undefined
      },
      body: {
        kind: "legacy-envelope"
      }
    });

    // Act
    const result = gateA2aSubmissionProtocol(request, {
      onEnvelopeValidationReady: () => {
        envelopeValidationCalls += 1;
      }
    });

    // Assert
    expect(result).toEqual({
      ok: false,
      error: {
        code: "missing_content_type",
        status: 415,
        message: "A2A submissions require Content-Type: application/json.",
        path: "headers.content-type"
      }
    });
    expect(envelopeValidationCalls).toBe(0);
  });

  test("test_wrong_content_type_is_rejected_before_envelope_validation", () => {
    // Arrange
    let envelopeValidationCalls = 0;
    const request = validRequest({
      headers: {
        "content-type": "text/plain"
      },
      body: {
        kind: "legacy-envelope"
      }
    });

    // Act
    const result = gateA2aSubmissionProtocol(request, {
      onEnvelopeValidationReady: () => {
        envelopeValidationCalls += 1;
      }
    });

    // Assert
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "unsupported_content_type",
        status: 415,
        path: "headers.content-type"
      }
    });
    expect(envelopeValidationCalls).toBe(0);
  });

  test("test_missing_a2a_version_is_rejected", () => {
    // Arrange
    const request = validRequest({
      headers: {
        "a2a-version": undefined
      }
    });

    // Act
    const result = gateA2aSubmissionProtocol(request);

    // Assert
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "missing_a2a_version",
        status: 400,
        path: "headers.a2a-version"
      }
    });
  });

  test("test_unsupported_a2a_version_is_rejected", () => {
    // Arrange
    const request = validRequest({
      headers: {
        "a2a-version": "0.2"
      }
    });

    // Act
    const result = gateA2aSubmissionProtocol(request);

    // Assert
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "unsupported_a2a_version",
        status: 400,
        path: "headers.a2a-version"
      }
    });
  });

  test("test_missing_required_extension_is_rejected", () => {
    // Arrange
    const request = validRequest({
      headers: {
        "a2a-extensions": "https://example.com/extensions/other"
      }
    });

    // Act
    const result = gateA2aSubmissionProtocol(request);

    // Assert
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "missing_required_extension",
        status: 400,
        path: "headers.a2a-extensions"
      }
    });
  });

  test("test_legacy_kind_discriminator_is_rejected", () => {
    // Arrange
    const request = validRequest({
      body: {
        ...validBody,
        params: {
          message: {
            role: "user",
            parts: [
              {
                kind: "data",
                mediaType: "application/json",
                data: {}
              }
            ]
          }
        }
      }
    });

    // Act
    const result = gateA2aSubmissionProtocol(request);

    // Assert
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "legacy_kind_discriminator",
        status: 400,
        path: "body.params.message.parts[0].kind"
      }
    });
  });

  test("test_invalid_part_media_type_is_rejected", () => {
    // Arrange
    const request = validRequest({
      body: {
        ...validBody,
        params: {
          message: {
            role: "user",
            parts: [
              {
                type: "data",
                mediaType: "text/plain",
                data: {}
              }
            ]
          }
        }
      }
    });

    // Act
    const result = gateA2aSubmissionProtocol(request);

    // Assert
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "unsupported_part_media_type",
        status: 415,
        path: "body.params.message.parts[0].mediaType"
      }
    });
  });

  test("test_protocol_rejection_does_not_create_ledger_or_idempotency_record", () => {
    // Arrange
    const sideEffects = {
      ledgerRows: 0,
      idempotencyRecords: 0
    };
    const request = validRequest({
      headers: {
        "a2a-version": "2.0"
      }
    });

    // Act
    const result = gateA2aSubmissionProtocol(request, {
      onEnvelopeValidationReady: () => {
        sideEffects.ledgerRows += 1;
        sideEffects.idempotencyRecords += 1;
      }
    });

    // Assert
    expect(result.ok).toBe(false);
    expect(sideEffects).toEqual({
      ledgerRows: 0,
      idempotencyRecords: 0
    });
  });
});
