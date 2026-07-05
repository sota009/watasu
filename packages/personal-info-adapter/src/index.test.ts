import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { watasuEncryptedIntakeExtensionUri, type AgentCard, type JsonSchemaObject } from "@watasu/core";
import {
  createPersonalInfoAdapterDryRun,
  createPersonalInfoAdapterSubmit,
  createPersonalInfoMcpStdioReader,
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
          field_purposes_hash: "sha256:test-field-purposes",
          destination_policy_hash: "sha256:test-destination-policy",
          encryption: {
            required: true,
            algorithm: "JWE",
            key_management: "ECDH-ES+A256KW",
            content_encryption: "A256GCM",
            service_key_id: "svc_test_key",
            public_key_fingerprint: "sha256:gb_X5MLJsUDoRXHNxfpfk8DYF6Jz5DpPDBqO58Jwbo4"
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

function writeMcpServerFixture(): { serverFile: string; callLogFile: string } {
  const directory = mkdtempSync(join(tmpdir(), "watasu-personal-info-mcp-test-"));
  const serverFile = join(directory, "personal-info-mcp-fixture.mjs");
  const callLogFile = join(directory, "calls.jsonl");
  writeFileSync(serverFile, `
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const values = {
  full_name: "MCP Ada Lovelace",
  email: "mcp.ada@example.test",
  company: "MCP Analytical Engines"
};
const callLogFile = process.env.WATASU_TEST_MCP_CALL_LOG;
const rl = createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "personal-info", version: "0.1.0" }
      }
    });
    return;
  }

  if (message.method === "tools/call") {
    const field = message.params.arguments.field;
    appendFileSync(callLogFile, JSON.stringify({ tool: message.params.name, field }) + "\\n");
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        content: [{ type: "text", text: values[field] ?? "" }]
      }
    });
  }
});
`);

  return {
    serverFile,
    callLogFile
  };
}

function readMcpCallLog(callLogFile: string): Array<{ tool: string; field: string }> {
  return readFileSync(callLogFile, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { tool: string; field: string });
}

function encryptedPayloadFixture(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    protected: "base64url-protected",
    iv: "base64url-iv",
    ciphertext: `encrypted-${Object.keys(payload).sort().join("-")}`,
    tag: "base64url-tag"
  };
}

function confirmationFixture(overrides: Partial<{
  request_version: string;
  consent_text_hash: string;
  field_purposes_hash: string;
  destination_policy_hash: string;
  confirmed_at: string;
}> = {}) {
  return {
    request_version: "v1",
    consent_text_hash: "sha256:test-consent",
    field_purposes_hash: "sha256:test-field-purposes",
    destination_policy_hash: "sha256:test-destination-policy",
    confirmed_at: "2026-06-15T00:00:00.000Z",
    ...overrides
  };
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

  test("test_dry_run_can_read_required_values_from_personal_info_mcp_stdio", async () => {
    const { serverFile, callLogFile } = writeMcpServerFixture();

    const result = await createPersonalInfoAdapterDryRun({
      agentCard: baseAgentCard,
      plaintextSchema: baseSchema,
      fieldMapping: {
        full_name: "full_name",
        email: "email",
        company: "company"
      },
      personalInfo: createPersonalInfoMcpStdioReader({
        command: process.execPath,
        args: [serverFile],
        env: {
          WATASU_TEST_MCP_CALL_LOG: callLogFile
        }
      })
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
    expect(readMcpCallLog(callLogFile)).toEqual([
      { tool: "get_personal_info", field: "full_name" },
      { tool: "get_personal_info", field: "email" }
    ]);
    expect(JSON.stringify(result)).not.toContain("MCP Ada Lovelace");
    expect(JSON.stringify(result)).not.toContain("mcp.ada@example.test");
  });

  test("test_dry_run_returns_structured_error_when_personal_info_mcp_fails", async () => {
    const result = await createPersonalInfoAdapterDryRun({
      agentCard: baseAgentCard,
      plaintextSchema: baseSchema,
      fieldMapping: {
        full_name: "full_name",
        email: "email"
      },
      personalInfo: createPersonalInfoMcpStdioReader({
        command: "definitely-missing-personal-info-mcp-command",
        timeoutMs: 100
      })
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "personal_info_mcp_failed",
        path: "$.personal_info.full_name"
      }
    });
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

  test("test_cli_dry_run_can_use_personal_info_mcp_stdio_without_fixture_values", async () => {
    const { serverFile, callLogFile } = writeMcpServerFixture();
    const agentCardFile = writeJsonFixture("agent-card.json", baseAgentCard);
    const schemaFile = writeJsonFixture("schema.json", baseSchema);
    const mappingFile = writeJsonFixture("mapping.json", {
      full_name: "full_name",
      email: "email"
    });

    const result = await runPersonalInfoAdapterCli([
      "dry-run",
      "--agent-card",
      agentCardFile,
      "--schema",
      schemaFile,
      "--mapping",
      mappingFile,
      "--personal-info-mcp-command",
      process.execPath,
      "--personal-info-mcp-arg",
      "--no-warnings",
      "--personal-info-mcp-arg",
      serverFile
    ], {
      env: {
        WATASU_TEST_MCP_CALL_LOG: callLogFile
      }
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      command: "dry-run"
    });
    expect(readMcpCallLog(callLogFile)).toEqual([
      { tool: "get_personal_info", field: "full_name" },
      { tool: "get_personal_info", field: "email" }
    ]);
    expect(`${result.stdout}${result.stderr}`).not.toContain("MCP Ada Lovelace");
    expect(`${result.stdout}${result.stderr}`).not.toContain("mcp.ada@example.test");
  });

  test("test_cli_submit_outputs_redacted_summary_without_plaintext_values", async () => {
    const agentCardFile = writeJsonFixture("agent-card.json", baseAgentCard);
    const schemaFile = writeJsonFixture("schema.json", baseSchema);
    const mappingFile = writeJsonFixture("mapping.json", {
      full_name: "full_name",
      email: "email"
    });
    const valuesFile = writeJsonFixture("personal-info-values.json", {
      full_name: "CLI Submit Secret Name",
      email: "cli.submit.secret@example.test"
    });
    const publicJwkFile = writeJsonFixture("public-jwk.json", {
      kty: "EC",
      x: "TiZ60tQ0Se3zeQGt6T98XN5abLKOS1fjOJu1ea-xHnU",
      y: "p7AD2mCWCUYJGBLkcA-lc3A46USGO147crX12i1lLrA",
      crv: "P-256"
    });
    const submittedBodies: unknown[] = [];

    const result = await runPersonalInfoAdapterCli([
      "submit",
      "--agent-card",
      agentCardFile,
      "--schema",
      schemaFile,
      "--mapping",
      mappingFile,
      "--personal-info-values",
      valuesFile,
      "--public-jwk",
      publicJwkFile,
      "--confirm",
      "--idempotency-key",
      "cli-submit-001",
      "--submitted-at",
      "2026-06-15T00:00:00.000Z"
    ], {
      now: () => new Date("2026-06-15T00:00:00.000Z"),
      fetch: async (_url, init) => {
        submittedBodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({
          ok: true,
          status: "delivered",
          ledger: {
            delivery_status: "delivered"
          }
        }), {
          status: 202,
          headers: {
            "content-type": "application/json"
          }
        });
      }
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      command: "submit",
      status: "delivered",
      summary: {
        plaintext_values_sent_to_watasu: false,
        response_contains_plaintext_payload: false,
        ledger_contains_payload_body: false
      }
    });
    // The static consent_receipt attestation was retired (§13); the envelope now
    // carries only the minimal consent_receipt_hash terms echo (== the published
    // consent_text_hash). Consent binding lives in the runtime consent_receipt_token.
    expect(submittedBodies[0]).toMatchObject({
      message: {
        parts: [
          {
            data: {
              consent_receipt_hash: "sha256:test-consent"
            }
          }
        ]
      }
    });
    expect(JSON.stringify(submittedBodies)).not.toContain("\"consent_receipt\":");
    expect(`${result.stdout}${result.stderr}${JSON.stringify(submittedBodies)}`).not.toContain(
      "CLI Submit Secret Name"
    );
    expect(`${result.stdout}${result.stderr}${JSON.stringify(submittedBodies)}`).not.toContain(
      "cli.submit.secret@example.test"
    );
  });

  test("test_cli_submit_requires_confirmation_before_personal_info_file_reads", async () => {
    const agentCardFile = writeJsonFixture("agent-card.json", baseAgentCard);
    const schemaFile = writeJsonFixture("schema.json", baseSchema);
    const mappingFile = writeJsonFixture("mapping.json", {
      full_name: "full_name",
      email: "email"
    });
    const missingValuesFile = join(tmpdir(), "watasu-missing-personal-info-values.json");
    const publicJwkFile = writeJsonFixture("public-jwk.json", {
      kty: "EC",
      x: "TiZ60tQ0Se3zeQGt6T98XN5abLKOS1fjOJu1ea-xHnU",
      y: "p7AD2mCWCUYJGBLkcA-lc3A46USGO147crX12i1lLrA",
      crv: "P-256"
    });
    let fetchCalls = 0;

    const result = await runPersonalInfoAdapterCli([
      "submit",
      "--agent-card",
      agentCardFile,
      "--schema",
      schemaFile,
      "--mapping",
      mappingFile,
      "--personal-info-values",
      missingValuesFile,
      "--public-jwk",
      publicJwkFile
    ], {
      fetch: async () => {
        fetchCalls += 1;
        return new Response("{}");
      }
    });

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      command: "submit",
      error: {
        code: "missing_confirmation"
      }
    });
    expect(fetchCalls).toBe(0);
  });

  test("test_cli_submit_rejects_public_jwk_fingerprint_mismatch_before_personal_info_reads", async () => {
    const agentCardFile = writeJsonFixture("agent-card.json", baseAgentCard);
    const schemaFile = writeJsonFixture("schema.json", baseSchema);
    const mappingFile = writeJsonFixture("mapping.json", {
      full_name: "full_name",
      email: "email"
    });
    const valuesFile = writeJsonFixture("personal-info-values.json", {
      full_name: "Wrong Key Secret Name",
      email: "wrong.key@example.test"
    });
    const wrongPublicJwkFile = writeJsonFixture("wrong-public-jwk.json", {
      kty: "EC",
      x: "AiZ60tQ0Se3zeQGt6T98XN5abLKOS1fjOJu1ea-xHnU",
      y: "p7AD2mCWCUYJGBLkcA-lc3A46USGO147crX12i1lLrA",
      crv: "P-256"
    });
    let fetchCalls = 0;

    const result = await runPersonalInfoAdapterCli([
      "submit",
      "--agent-card",
      agentCardFile,
      "--schema",
      schemaFile,
      "--mapping",
      mappingFile,
      "--personal-info-values",
      valuesFile,
      "--public-jwk",
      wrongPublicJwkFile,
      "--confirm"
    ], {
      fetch: async () => {
        fetchCalls += 1;
        return new Response("{}");
      }
    });

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      command: "submit",
      error: {
        code: "public_key_fingerprint_mismatch"
      }
    });
    expect(fetchCalls).toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain("Wrong Key Secret Name");
    expect(`${result.stdout}${result.stderr}`).not.toContain("wrong.key@example.test");
  });

  test("test_submit_posts_encrypted_envelope_and_returns_delivered_status", async () => {
    const reader = trackingReader({
      full_name: "Submit Secret Name",
      email: "submit.secret@example.test"
    });
    const submittedBodies: unknown[] = [];

    const result = await createPersonalInfoAdapterSubmit({
      agentCard: baseAgentCard,
      plaintextSchema: baseSchema,
      fieldMapping: {
        full_name: "full_name",
        email: "email"
      },
      personalInfo: reader,
      confirmation: confirmationFixture(),
      idempotencyKey: "submit-test-001",
      submittedAt: "2026-06-15T00:00:00.000Z",
      encryptPayload: encryptedPayloadFixture,
      fetch: async (_url, init) => {
        submittedBodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({
          ok: true,
          status: "delivered",
          ledger: {
            request_id: "event-attendee-intake",
            request_version: "v1",
            delivery_status: "delivered",
            encrypted_payload_hash: "sha256:test"
          }
        }), {
          status: 202,
          headers: {
            "content-type": "application/json"
          }
        });
      }
    });

    expect(result).toMatchObject({
      ok: true,
      status: "delivered",
      summary: {
        request_id: "event-attendee-intake",
        request_version: "v1",
        plaintext_values_sent_to_watasu: false,
        response_contains_plaintext_payload: false
      }
    });
    expect(reader.reads).toEqual(["full_name", "email"]);
    // Static consent_receipt attestation retired (§13): only the minimal terms
    // echo remains on the envelope.
    expect(submittedBodies[0]).toMatchObject({
      message: {
        parts: [
          {
            data: {
              consent_receipt_hash: "sha256:test-consent"
            }
          }
        ]
      }
    });
    expect(JSON.stringify(submittedBodies)).not.toContain("\"consent_receipt\":");
    expect(JSON.stringify(submittedBodies)).not.toContain("Submit Secret Name");
    expect(JSON.stringify(submittedBodies)).not.toContain("submit.secret@example.test");
  });

  test("test_submit_handles_auth_required_without_leaking_plaintext_values", async () => {
    const reader = trackingReader({
      full_name: "Auth Required Secret Name",
      email: "auth.required@example.test"
    });
    const submittedBodies: unknown[] = [];

    const result = await createPersonalInfoAdapterSubmit({
      agentCard: baseAgentCard,
      plaintextSchema: baseSchema,
      fieldMapping: {
        full_name: "full_name",
        email: "email"
      },
      personalInfo: reader,
      confirmation: confirmationFixture(),
      idempotencyKey: "submit-test-auth-required",
      submittedAt: "2026-06-15T00:00:00.000Z",
      encryptPayload: encryptedPayloadFixture,
      fetch: async (_url, init) => {
        submittedBodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({
          ok: false,
          status: "auth_required",
          error: {
            code: "sender_signature_required",
            message: "Auth Required Secret Name must not be echoed by the adapter."
          }
        }), {
          status: 401,
          headers: {
            "content-type": "application/json"
          }
        });
      }
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "submit_auth_required"
      }
    });
    expect(reader.reads).toEqual(["full_name", "email"]);
    expect(`${JSON.stringify(result)}${JSON.stringify(submittedBodies)}`).not.toContain(
      "Auth Required Secret Name"
    );
    expect(`${JSON.stringify(result)}${JSON.stringify(submittedBodies)}`).not.toContain(
      "auth.required@example.test"
    );
  });

  test("test_submit_handles_resubmit_later_without_retaining_payload_values", async () => {
    const reader = trackingReader({
      full_name: "Resubmit Later Secret Name",
      email: "resubmit.later@example.test"
    });
    const submittedBodies: unknown[] = [];
    let fetchCalls = 0;

    const result = await createPersonalInfoAdapterSubmit({
      agentCard: baseAgentCard,
      plaintextSchema: baseSchema,
      fieldMapping: {
        full_name: "full_name",
        email: "email"
      },
      personalInfo: reader,
      confirmation: confirmationFixture(),
      idempotencyKey: "submit-test-resubmit-later",
      submittedAt: "2026-06-15T00:00:00.000Z",
      encryptPayload: encryptedPayloadFixture,
      fetch: async (_url, init) => {
        fetchCalls += 1;
        submittedBodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({
          ok: false,
          status: "resubmit_later",
          retry_after_seconds: 30,
          payload_policy: "sender_resubmits_payload"
        }), {
          status: 503,
          headers: {
            "content-type": "application/json",
            "retry-after": "30"
          }
        });
      }
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "submit_resubmit_later"
      }
    });
    expect(fetchCalls).toBe(1);
    expect(`${JSON.stringify(result)}${JSON.stringify(submittedBodies)}`).not.toContain(
      "Resubmit Later Secret Name"
    );
    expect(`${JSON.stringify(result)}${JSON.stringify(submittedBodies)}`).not.toContain(
      "resubmit.later@example.test"
    );
  });

  test("test_submit_requires_confirmation_before_personal_info_reads", async () => {
    const reader = trackingReader({
      full_name: "No Confirmation Secret Name",
      email: "no.confirmation@example.test"
    });
    let fetchCalls = 0;

    const result = await createPersonalInfoAdapterSubmit({
      agentCard: baseAgentCard,
      plaintextSchema: baseSchema,
      fieldMapping: {
        full_name: "full_name",
        email: "email"
      },
      personalInfo: reader,
      idempotencyKey: "submit-test-no-confirmation",
      submittedAt: "2026-06-15T00:00:00.000Z",
      encryptPayload: encryptedPayloadFixture,
      fetch: async () => {
        fetchCalls += 1;
        return new Response("{}");
      }
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "missing_confirmation"
      }
    });
    expect(reader.reads).toEqual([]);
    expect(fetchCalls).toBe(0);
  });

  test("test_submit_rejects_stale_confirmation_before_personal_info_reads", async () => {
    const reader = trackingReader({
      full_name: "Stale Confirmation Secret Name",
      email: "stale.confirmation@example.test"
    });
    let fetchCalls = 0;

    const result = await createPersonalInfoAdapterSubmit({
      agentCard: baseAgentCard,
      plaintextSchema: baseSchema,
      fieldMapping: {
        full_name: "full_name",
        email: "email"
      },
      personalInfo: reader,
      confirmation: confirmationFixture({
        destination_policy_hash: "sha256:old-destination-policy"
      }),
      idempotencyKey: "submit-test-stale-confirmation",
      submittedAt: "2026-06-15T00:00:00.000Z",
      encryptPayload: encryptedPayloadFixture,
      fetch: async () => {
        fetchCalls += 1;
        return new Response("{}");
      }
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "confirmation_destination_policy_mismatch"
      }
    });
    expect(reader.reads).toEqual([]);
    expect(fetchCalls).toBe(0);
  });

  test("test_submit_rejects_request_version_mismatch_before_personal_info_reads", async () => {
    const reader = trackingReader({
      full_name: "Version Secret Name",
      email: "version.secret@example.test"
    });
    let fetchCalls = 0;

    const result = await createPersonalInfoAdapterSubmit({
      agentCard: baseAgentCard,
      plaintextSchema: baseSchema,
      fieldMapping: {
        full_name: "full_name",
        email: "email"
      },
      personalInfo: reader,
      confirmation: confirmationFixture(),
      expectedRequestVersion: "v2",
      idempotencyKey: "submit-test-002",
      submittedAt: "2026-06-15T00:00:00.000Z",
      encryptPayload: encryptedPayloadFixture,
      fetch: async () => {
        fetchCalls += 1;
        return new Response("{}");
      }
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "request_version_mismatch"
      }
    });
    expect(reader.reads).toEqual([]);
    expect(fetchCalls).toBe(0);
  });

  test("test_submit_rejects_schema_hash_mismatch_before_personal_info_reads", async () => {
    const reader = trackingReader({
      full_name: "Schema Secret Name",
      email: "schema.secret@example.test"
    });
    let fetchCalls = 0;

    const result = await createPersonalInfoAdapterSubmit({
      agentCard: baseAgentCard,
      plaintextSchema: baseSchema,
      fieldMapping: {
        full_name: "full_name",
        email: "email"
      },
      personalInfo: reader,
      confirmation: confirmationFixture(),
      expectedSchemaHash: "sha256:different-schema",
      idempotencyKey: "submit-test-003",
      submittedAt: "2026-06-15T00:00:00.000Z",
      encryptPayload: encryptedPayloadFixture,
      fetch: async () => {
        fetchCalls += 1;
        return new Response("{}");
      }
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "schema_hash_mismatch"
      }
    });
    expect(reader.reads).toEqual([]);
    expect(fetchCalls).toBe(0);
  });
});
