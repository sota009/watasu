import {
  Ajv2020,
  type AnySchema,
  type ErrorObject
} from "ajv/dist/2020.js";
import type { RequestDefinition } from "./request-definition.js";
import type { RequestVersionHashes } from "./request-version.js";

export type JsonSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema";
  type: "object";
  additionalProperties: false;
  properties: Record<string, JsonSchemaProperty>;
  required: string[];
};

export type JsonSchemaProperty =
  | {
      type: "string";
      format?: string | undefined;
      const?: string | undefined;
    }
  | {
      type: "number" | "integer" | "boolean" | "object" | "array";
    };

export type GeneratedJsonSchemaValidationResult =
  | {
      ok: true;
    }
  | {
      ok: false;
      errors: Array<{
        path: string;
        message: string;
      }>;
    };

const generatedSchemaValidator = new Ajv2020({
  allErrors: true,
  strict: true,
  validateSchema: true
});

export function generatePlaintextPayloadSchema(definition: RequestDefinition): JsonSchemaObject {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    properties: Object.fromEntries(
      definition.fields.map((field) => [field.id, toJsonSchemaProperty(field.type, field.format)])
    ),
    required: definition.fields.filter((field) => field.required).map((field) => field.id)
  };
}

export function generateEncryptedEnvelopeSchema(
  definition: RequestDefinition,
  hashes: RequestVersionHashes
): JsonSchemaObject {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    properties: {
      request_id: { type: "string" },
      request_version: { type: "string" },
      schema_hash: {
        type: "string",
        const: hashes.schema_hash
      },
      consent_receipt_hash: { type: "string" },
      idempotency_key: { type: "string" },
      submitted_at: {
        type: "string",
        format: "date-time"
      },
      service_key_id: {
        type: "string",
        const: definition.encryption.service_key_id
      },
      encrypted_payload: { type: "object" },
      encrypted_payload_hash: { type: "string" }
    },
    required: [
      "request_id",
      "request_version",
      "schema_hash",
      "consent_receipt_hash",
      "idempotency_key",
      "submitted_at",
      "service_key_id",
      "encrypted_payload",
      "encrypted_payload_hash"
    ]
  };
}

export function validateGeneratedJsonSchema(schema: unknown): GeneratedJsonSchemaValidationResult {
  const valid = generatedSchemaValidator.validateSchema(schema as AnySchema);
  if (valid) {
    return {
      ok: true
    };
  }

  return {
    ok: false,
    errors: (generatedSchemaValidator.errors ?? []).map((error: ErrorObject) => ({
      path: error.instancePath || error.schemaPath,
      message: error.message ?? "Generated JSON Schema is invalid."
    }))
  };
}

function toJsonSchemaProperty(type: string, format: string | undefined): JsonSchemaProperty {
  const schemaType = toJsonSchemaType(type);

  if (schemaType === "string" && format !== undefined) {
    return {
      type: schemaType,
      format
    };
  }

  return { type: schemaType };
}

function toJsonSchemaType(type: string): JsonSchemaProperty["type"] {
  if (
    type === "number" ||
    type === "integer" ||
    type === "boolean" ||
    type === "object" ||
    type === "array"
  ) {
    return type;
  }

  return "string";
}
