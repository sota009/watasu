import {
  canonicalizeJson,
  sha256Hash,
  watasuA2aHttpJsonContentType,
  watasuA2aProtocolVersion,
  watasuEncryptedIntakeExtensionUri,
  type AgentCard,
  type JsonSchemaObject
} from "@watasu/core";

export type SenderFixtureEncryptedPayload = Record<string, unknown>;

export interface SenderFixtureEncryptionInput {
  payload: Record<string, unknown>;
  encryption: AgentCard["capabilities"]["extensions"][number]["params"]["encryption"];
}

export interface SenderFixtureSubmissionInput {
  agentCard: AgentCard;
  plaintextSchema: JsonSchemaObject;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  submittedAt: string;
  encryptPayload: (input: SenderFixtureEncryptionInput) => SenderFixtureEncryptedPayload;
}

export interface SenderFixtureSubmission {
  url: string;
  headers: Record<string, string>;
  body: {
    message: {
      role: "ROLE_USER";
      messageId: string;
      parts: [
        {
          type: "data";
          mediaType: "application/json";
          data: {
            request_id: string;
            request_version: string;
            schema_hash: string;
            consent_receipt_hash: string;
            idempotency_key: string;
            submitted_at: string;
            service_key_id: string;
            encrypted_payload: SenderFixtureEncryptedPayload;
            encrypted_payload_hash: string;
          };
        }
      ];
    };
  };
}

export function extractPlaintextSchemaFields(schema: JsonSchemaObject): string[] {
  return Object.keys(schema.properties);
}

export function buildSenderFixtureSubmission(
  input: SenderFixtureSubmissionInput
): SenderFixtureSubmission {
  assertPayloadSatisfiesRequiredFields(input.payload, input.plaintextSchema);

  const extension = findRequiredWatasuExtension(input.agentCard);
  const targetInterface = input.agentCard.supportedInterfaces.find(
    (candidate) => candidate.protocolBinding === "HTTP+JSON"
  );
  if (targetInterface === undefined) {
    throw new Error("Agent Card does not declare an HTTP+JSON supported interface.");
  }

  const encryptedPayload = input.encryptPayload({
    payload: input.payload,
    encryption: extension.params.encryption
  });

  return {
    url: targetInterface.url,
    headers: {
      "content-type": watasuA2aHttpJsonContentType,
      "a2a-version": watasuA2aProtocolVersion,
      "a2a-extensions": watasuEncryptedIntakeExtensionUri
    },
    body: {
      message: {
        role: "ROLE_USER",
        messageId: input.idempotencyKey,
        parts: [
          {
            type: "data",
            mediaType: "application/json",
            data: {
              request_id: extension.params.request_id,
              request_version: extension.params.request_version,
              schema_hash: extension.params.schema_hash,
              consent_receipt_hash: extension.params.consent_text_hash,
              idempotency_key: input.idempotencyKey,
              submitted_at: input.submittedAt,
              service_key_id: extension.params.encryption.service_key_id,
              encrypted_payload: encryptedPayload,
              encrypted_payload_hash: sha256Hash(canonicalizeJson(encryptedPayload))
            }
          }
        ]
      }
    }
  };
}

function findRequiredWatasuExtension(
  agentCard: AgentCard
): AgentCard["capabilities"]["extensions"][number] {
  const extension = agentCard.capabilities.extensions.find(
    (candidate) => candidate.uri === watasuEncryptedIntakeExtensionUri && candidate.required
  );
  if (extension === undefined) {
    throw new Error("Agent Card does not declare the required watasu encrypted intake extension.");
  }

  return extension;
}

function assertPayloadSatisfiesRequiredFields(
  payload: Record<string, unknown>,
  schema: JsonSchemaObject
): void {
  const missingField = schema.required.find((field) => !Object.hasOwn(payload, field));
  if (missingField !== undefined) {
    throw new Error(`Payload is missing required field: ${missingField}`);
  }
}
