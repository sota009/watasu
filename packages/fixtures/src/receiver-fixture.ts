import { createHmac, timingSafeEqual } from "node:crypto";
import {
  canonicalizeJson,
  sha256Hash,
  type DeliveryRequest,
  type JsonSchemaObject
} from "@watasu/core";

const defaultMaxDeliveryAgeMs = 5 * 60 * 1000;

export interface ReceiverFixtureDecryptionInput {
  encryptedPayload: Record<string, unknown>;
}

export interface ReceiverFixtureVerificationInput {
  request: DeliveryRequest;
  signingSecret: string;
  plaintextSchema: JsonSchemaObject;
  now: Date;
  maxDeliveryAgeMs?: number | undefined;
  decryptPayload: (input: ReceiverFixtureDecryptionInput) => Record<string, unknown>;
}

export type ReceiverFixtureVerificationResult =
  | {
      ok: true;
      payload: Record<string, unknown>;
      metadata: {
        request_id: string;
        request_version: string;
        idempotency_key: string;
      };
    }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
      };
    };

type ReceiverFixtureEnvelopeParseResult =
  | { ok: true; envelope: { encrypted_payload: Record<string, unknown> } }
  | Extract<ReceiverFixtureVerificationResult, { ok: false }>;

export function verifyReceiverFixtureDelivery(
  input: ReceiverFixtureVerificationInput
): ReceiverFixtureVerificationResult {
  const headers = normalizeHeaders(input.request.headers);
  const timestamp = headers["x-watasu-timestamp"];
  const bodyDigest = headers["x-watasu-body-digest"];
  const signature = headers["x-watasu-signature"];
  const requestId = headers["x-watasu-request-id"];
  const requestVersion = headers["x-watasu-request-version"];
  const idempotencyKey = headers["x-watasu-idempotency-key"];

  if (
    timestamp === undefined ||
    bodyDigest === undefined ||
    signature === undefined ||
    requestId === undefined ||
    requestVersion === undefined ||
    idempotencyKey === undefined
  ) {
    return rejected("missing_delivery_header", "Delivery request is missing required watasu headers.");
  }

  if (bodyDigest !== sha256Hash(input.request.body)) {
    return rejected("body_digest_mismatch", "Delivery body digest does not match the request body.");
  }

  const deliveredAt = new Date(timestamp);
  if (Number.isNaN(deliveredAt.getTime())) {
    return rejected("invalid_delivery_timestamp", "Delivery timestamp must be a valid date-time.");
  }

  const maxDeliveryAgeMs = input.maxDeliveryAgeMs ?? defaultMaxDeliveryAgeMs;
  if (Math.abs(input.now.getTime() - deliveredAt.getTime()) > maxDeliveryAgeMs) {
    return rejected("stale_delivery_timestamp", "Delivery timestamp is outside the accepted window.");
  }

  const expectedSignature = signDelivery({
    timestamp,
    bodyDigest,
    requestId,
    requestVersion,
    idempotencyKey,
    signingSecret: input.signingSecret
  });
  if (!safeEqual(signature, expectedSignature)) {
    return rejected("delivery_signature_mismatch", "Delivery signature does not match the request.");
  }

  const envelopeResult = parseDeliveryEnvelope(input.request.body);
  if (!envelopeResult.ok) {
    return envelopeResult;
  }

  const payload = input.decryptPayload({
    encryptedPayload: envelopeResult.envelope.encrypted_payload
  });
  const payloadError = validatePlaintextPayload(payload, input.plaintextSchema);
  if (payloadError !== undefined) {
    return rejected("invalid_plaintext_payload", payloadError);
  }

  return {
    ok: true,
    payload,
    metadata: {
      request_id: requestId,
      request_version: requestVersion,
      idempotency_key: idempotencyKey
    }
  };
}

function normalizeHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])
  );
}

function signDelivery(input: {
  timestamp: string;
  bodyDigest: string;
  requestId: string;
  requestVersion: string;
  idempotencyKey: string;
  signingSecret: string;
}): string {
  const signaturePayload = [
    input.timestamp,
    input.bodyDigest,
    input.requestId,
    input.requestVersion,
    input.idempotencyKey
  ].join("\n");
  const signature = createHmac("sha256", input.signingSecret)
    .update(signaturePayload)
    .digest("base64url");

  return `sha256=${signature}`;
}

function safeEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.byteLength === expectedBuffer.byteLength &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function parseDeliveryEnvelope(
  body: string
): ReceiverFixtureEnvelopeParseResult {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.envelope)) {
      return rejected("invalid_delivery_body", "Delivery body must contain an envelope object.");
    }

    const encryptedPayload = parsed.envelope["encrypted_payload"];
    if (!isRecord(encryptedPayload)) {
      return rejected("invalid_delivery_body", "Delivery envelope must contain encrypted_payload.");
    }

    return {
      ok: true,
      envelope: {
        encrypted_payload: encryptedPayload
      }
    };
  } catch {
    return rejected("invalid_delivery_body", "Delivery body must be valid JSON.");
  }
}

function validatePlaintextPayload(
  payload: Record<string, unknown>,
  schema: JsonSchemaObject
): string | undefined {
  for (const field of schema.required) {
    if (!Object.hasOwn(payload, field)) {
      return `Decrypted payload is missing required field: ${field}.`;
    }
  }

  for (const [field, property] of Object.entries(schema.properties)) {
    if (!Object.hasOwn(payload, field)) {
      continue;
    }

    if (!matchesJsonSchemaType(payload[field], property.type)) {
      return `Decrypted payload field ${field} does not match schema type ${property.type}.`;
    }
  }

  return undefined;
}

function matchesJsonSchemaType(value: unknown, type: string): boolean {
  if (type === "integer") {
    return Number.isInteger(value);
  }

  if (type === "number") {
    return typeof value === "number";
  }

  if (type === "boolean") {
    return typeof value === "boolean";
  }

  if (type === "array") {
    return Array.isArray(value);
  }

  if (type === "object") {
    return isRecord(value);
  }

  return typeof value === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejected(
  code: string,
  message: string
): Extract<ReceiverFixtureVerificationResult, { ok: false }> {
  return {
    ok: false,
    error: {
      code,
      message
    }
  };
}
