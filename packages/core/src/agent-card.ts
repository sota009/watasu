import type { PublishedRequestVersion } from "./request-version.js";

export const watasuEncryptedIntakeExtensionUri =
  "https://watasu.dev/extensions/encrypted-intake/v1";

export interface AgentCard {
  protocolVersion: "1.0";
  name: string;
  description: string;
  provider: {
    organization: "watasu";
    url: "https://watasu.dev";
  };
  version: string;
  defaultInputModes: ["application/json"];
  defaultOutputModes: ["application/json"];
  supportedInterfaces: Array<{
    url: string;
    protocolBinding: "HTTP+JSON";
    protocolVersion: "1.0";
  }>;
  capabilities: {
    streaming: false;
    pushNotifications: false;
    extendedAgentCard: false;
    extensions: Array<{
      uri: typeof watasuEncryptedIntakeExtensionUri;
      required: true;
      params: {
        request_id: string;
        request_version: string;
        schema_hash: string;
        consent_text_hash: string;
        destination_policy_hash: string;
        encryption: {
          required: true;
          algorithm: "JWE";
          key_management: string;
          content_encryption: string;
          service_key_id: string;
          public_key_fingerprint: string;
        };
        submission: {
          max_payload_bytes: number;
          expires_in_seconds: number;
          idempotency_required: true;
        };
      };
    }>;
  };
  skills: Array<{
    id: "encrypted_personal_data_intake";
    name: "Encrypted personal data intake";
    description: string;
    inputModes: ["application/json"];
    outputModes: ["application/json"];
    tags: ["personal-data", "encrypted-intake", "watasu"];
  }>;
}

export function buildAgentCard(input: {
  published: PublishedRequestVersion;
  endpointUrl: string;
}): AgentCard {
  const { published } = input;

  return {
    protocolVersion: "1.0",
    name: `watasu encrypted intake for ${published.definition.name}`,
    description:
      "Accepts encrypted personal data submissions bound to a published watasu request version.",
    provider: {
      organization: "watasu",
      url: "https://watasu.dev"
    },
    version: "1.0.0",
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    supportedInterfaces: [
      {
        url: input.endpointUrl,
        protocolBinding: "HTTP+JSON",
        protocolVersion: "1.0"
      }
    ],
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extendedAgentCard: false,
      extensions: [
        {
          uri: watasuEncryptedIntakeExtensionUri,
          required: true,
          params: {
            request_id: published.request_id,
            request_version: published.request_version,
            schema_hash: published.hashes.schema_hash,
            consent_text_hash: published.hashes.consent_text_hash,
            destination_policy_hash: published.hashes.destination_policy_hash,
            encryption: {
              required: true,
              algorithm: "JWE",
              key_management: published.definition.encryption.key_management,
              content_encryption: published.definition.encryption.content_encryption,
              service_key_id: published.definition.encryption.service_key_id,
              public_key_fingerprint: published.hashes.public_key_fingerprint
            },
            submission: {
              max_payload_bytes: 262_144,
              expires_in_seconds: 900,
              idempotency_required: true
            }
          }
        }
      ]
    },
    skills: [
      {
        id: "encrypted_personal_data_intake",
        name: "Encrypted personal data intake",
        description:
          "Accepts encrypted personal data submissions bound to a published request version.",
        inputModes: ["application/json"],
        outputModes: ["application/json"],
        tags: ["personal-data", "encrypted-intake", "watasu"]
      }
    ]
  };
}
