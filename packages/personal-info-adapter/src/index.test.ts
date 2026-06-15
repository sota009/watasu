import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { watasuEncryptedIntakeExtensionUri, type AgentCard, type JsonSchemaObject } from "@watasu/core";
import {
  createPersonalInfoAdapterDryRun,
  runPersonalInfoAdapterCli,
  type PersonalInfoReader
} from "./index.js";

const baseAgentCard: AgentCard = {
  protocolVersion: "1.0",
  name: "watasu encrypted intake for event-attendee-intake",
  description: "Accepts encrypted personal data submissions.",
  provider: {
    organization: "watasu",
    url: "https://watasu.dev"
  },
  version: "1.0.0",
  defaultInputModes: ["application/json"],
  defaultOutputModes: ["application/json"],
  supportedInterfaces: [
    {
      url: "http://127.0.0.1:8787/submit",
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
          request_id: "event-attendee-intake",
          request_version: "v1",
          schema_hash: "sha256:test-schema",
          consent_text_hash: "sha256:test-consent",
          destination_policy_hash: "sha256:test-destination-policy",
          encryption: {
            required: true,
            algorithm: "JWE",
            key_management: "ECDH-ES+A256KW",
            content_encryption: "A256GCM",
            service_key_id: "svc_test_key",
            public_key_fingerprint: "sha256:test-key"
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
      description: "Accepts encrypted personal data submissions.",
      inputModes: ["application/json"],
      outputModes: ["application/json"],
      tags: ["personal-data", "encrypted-intake", "watasu"]
    }
  ]
};

const baseSchema: JsonSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  properties: {
    full_name: { type: "string" },
    email: { type: "string", format: "email" },
    company: { type: "string" }
  },
  required: ["full_name", "email"]
};

function firstExtension(): AgentCard["capabilities"]["extensions"][number] {
  const extension = baseAgentCard.capabilities.extensions[0];
  if (extension === undefined) {
    throw new Error("test fixture must include a watasu extension");
  }

  return extension;
}

function trackingReader(values: Record<string, string>): PersonalInfoReader & { reads: string[] } {
  const reads: string[] = [];

  return {
    reads,
    async getPersonalInfo(field: string): Promise<string | undefined> {
      reads.push(field);
      return values[field];
    }
  };
}

function writeJsonFixture(name: string, value: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), "watasu-personal-info-adapter-test-"));
  const file = join(directory, name);
  writeFileSync(file, JSON.stringify(value));
  return file;
}

describe("personal-info-mcp adapter dry run", () => {
  test("test_dry_run_fails_before_personal_info_reads_without_watasu_extension", async () => {
    const reader = trackingReader({
      full_name: "Ada Lovelace"
    });

    const result = await createPersonalInfoAdapterDryRun({
      agentCard: {
        ...baseAgentCard,
        capabilities: {
          ...baseAgentCard.capabilities,
          extensions: []
        }
      },
      plaintextSchema: baseSchema,
      fieldMapping: {
        full_name: "full_name",
        email: "email"
      },
      personalInfo: reader
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "missing_watasu_extension"
      }
    });
    expect(reader.reads).toEqual([]);
  });

  test("test_dry_run_fails_before_personal_info_reads_without_schema_hash", async () => {
    const reader = trackingReader({
      full_name: "Ada Lovelace"
    });

    const result = await createPersonalInfoAdapterDryRun({
      agentCard: {
        ...baseAgentCard,
        capabilities: {
          ...baseAgentCard.capabilities,
          extensions: [
            {
              ...firstExtension(),
              params: {
                ...firstExtension().params,
                schema_hash: ""
              }
            }
          ]
        }
      },
      plaintextSchema: baseSchema,
      fieldMapping: {
        full_name: "full_name",
        email: "email"
      },
      personalInfo: reader
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "missing_schema_hash"
      }
    });
    expect(reader.reads).toEqual([]);
  });

  test("test_dry_run_fails_before_personal_info_reads_with_invalid_submission_endpoint", async () => {
    const reader = trackingReader({
      full_name: "Ada Lovelace",
      email: "ada@example.test"
    });

    const result = await createPersonalInfoAdapterDryRun({
      agentCard: {
        ...baseAgentCard,
        supportedInterfaces: [
          {
            url: "not a url",
            protocolBinding: "HTTP+JSON",
            protocolVersion: "1.0"
          }
        ]
      },
      plaintextSchema: baseSchema,
      fieldMapping: {
        full_name: "full_name",
        email: "email"
      },
      personalInfo: reader
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "invalid_submission_endpoint"
      }
    });
    expect(reader.reads).toEqual([]);
  });

  test("test_dry_run_reads_only_mapped_required_fields", async () => {
    const reader = trackingReader({
      full_name: "Ada Lovelace",
      email: "ada@example.test",
      company: "Analytical Engines Ltd"
    });

    const result = await createPersonalInfoAdapterDryRun({
      agentCard: baseAgentCard,
      plaintextSchema: baseSchema,
      fieldMapping: {
        full_name: "full_name",
        email: "email",
        company: "company"
      },
      personalInfo: reader
    });

    expect(result).toMatchObject({
      ok: true,
      summary: {
        fields: [
          {
            watasu_field: "full_name",
            personal_info_field: "full_name",
            value: "[REDACTED]"
          },
          {
            watasu_field: "email",
            personal_info_field: "email",
            value: "[REDACTED]"
          }
        ]
      }
    });
    expect(reader.reads).toEqual(["full_name", "email"]);
  });

  test("test_dry_run_stops_when_required_mapping_is_missing", async () => {
    const reader = trackingReader({
      full_name: "Ada Lovelace"
    });

    const result = await createPersonalInfoAdapterDryRun({
      agentCard: baseAgentCard,
      plaintextSchema: baseSchema,
      fieldMapping: {
        full_name: "full_name"
      },
      personalInfo: reader
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "missing_required_mapping",
        message: "Required watasu field email is not mapped to a personal-info-mcp field."
      }
    });
    expect(reader.reads).toEqual([]);
  });

  test("test_dry_run_summary_never_contains_plaintext_values", async () => {
    const reader = trackingReader({
      full_name: "Plaintext Secret Name",
      email: "secret@example.test"
    });

    const result = await createPersonalInfoAdapterDryRun({
      agentCard: baseAgentCard,
      plaintextSchema: baseSchema,
      fieldMapping: {
        full_name: "full_name",
        email: "email"
      },
      personalInfo: reader
    });

    const serialized = JSON.stringify(result);

    expect(result).toMatchObject({
      ok: true
    });
    expect(serialized).not.toContain("Plaintext Secret Name");
    expect(serialized).not.toContain("secret@example.test");
  });

  test("test_cli_dry_run_outputs_redacted_summary_without_plaintext_values", async () => {
    const agentCardFile = writeJsonFixture("agent-card.json", baseAgentCard);
    const schemaFile = writeJsonFixture("schema.json", baseSchema);
    const mappingFile = writeJsonFixture("mapping.json", {
      full_name: "full_name",
      email: "email"
    });
    const valuesFile = writeJsonFixture("personal-info-values.json", {
      full_name: "CLI Secret Name",
      email: "cli.secret@example.test"
    });

    const result = await runPersonalInfoAdapterCli([
      "dry-run",
      "--agent-card",
      agentCardFile,
      "--schema",
      schemaFile,
      "--mapping",
      mappingFile,
      "--personal-info-values",
      valuesFile
    ]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      command: "dry-run",
      summary: {
        fields: [
          {
            watasu_field: "full_name",
            value: "[REDACTED]"
          },
          {
            watasu_field: "email",
            value: "[REDACTED]"
          }
        ]
      }
    });
    expect(`${result.stdout}${result.stderr}`).not.toContain("CLI Secret Name");
    expect(`${result.stdout}${result.stderr}`).not.toContain("cli.secret@example.test");
  });
});
