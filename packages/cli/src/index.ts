import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  buildSenderFixtureSubmission,
  type SenderFixtureEncryptedPayload
} from "@watasu/fixtures";
import {
  buildAgentCard,
  canonicalizeJson,
  createRequestVersionHashes,
  deliverAcceptedSubmission,
  generateEncryptedEnvelopeSchema,
  generatePlaintextPayloadSchema,
  InMemoryRequestVersionRepository,
  publishRequestVersion,
  sha256Hash,
  validateRequestDefinitionInput,
  type DeliveryClient,
  type DeliveryLedger,
  type DeliveryLedgerRow,
  type RequestDefinition,
  type RequestDefinitionError
} from "@watasu/core";

export const cliPackageName = "@watasu/cli";

export interface CliResult {
  exitCode: 0 | 1;
  stdout: string;
  stderr: string;
}

type CommandName =
  | "validate"
  | "publish"
  | "agent-card"
  | "schema"
  | "ledger"
  | "inspect-delivery"
  | "submit-fixture";

interface ParsedArgs {
  command: CommandName;
  file: string;
  confirm: boolean;
  payloadFile?: string | undefined;
}

export async function runCli(argv: string[]): Promise<CliResult> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    return errorResult(undefined, parsed.error);
  }

  const loaded = await loadValidatedDefinition(parsed.value.file);
  if (!loaded.ok) {
    return errorResult(parsed.value.command, loaded.error);
  }

  switch (parsed.value.command) {
    case "validate":
      return okResult({
        ok: true,
        command: "validate",
        request: summarizeDefinition(loaded.definition),
        warnings: loaded.warnings
      });
    case "publish":
      return publishFileDefinition(loaded.definition, parsed.value.confirm);
    case "agent-card":
      return agentCardForFileDefinition(loaded.definition, parsed.value.confirm);
    case "schema":
      return schemaForFileDefinition(loaded.definition);
    case "ledger":
      return ledgerForFileDefinition(loaded.definition, parsed.value.confirm);
    case "inspect-delivery":
      return inspectDeliveryForFileDefinition(loaded.definition, parsed.value.confirm);
    case "submit-fixture":
      return submitFixtureForFileDefinition(
        loaded.definition,
        parsed.value.confirm,
        parsed.value.payloadFile
      );
  }
}

function parseArgs(
  argv: string[]
): { ok: true; value: ParsedArgs } | { ok: false; error: RequestDefinitionError } {
  const [command, ...args] = argv;

  if (!isCommand(command)) {
    return {
      ok: false,
      error: {
        code: command === undefined ? "missing_command" : "unknown_command",
        path: "$.command",
        message:
          "Command must be one of validate, publish, agent-card, schema, ledger, inspect-delivery, or submit-fixture."
      }
    };
  }

  const files: string[] = [];
  let confirm = false;
  let payloadFile: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--confirm") {
      confirm = true;
      continue;
    }

    if (arg === "--payload") {
      if (payloadFile !== undefined) {
        return {
          ok: false,
          error: {
            code: "duplicate_payload_file",
            path: "$.payload",
            message: "--payload may be provided only once."
          }
        };
      }

      const nextArg = args[index + 1];
      if (nextArg === undefined || nextArg.startsWith("--")) {
        return {
          ok: false,
          error: {
            code: "missing_payload_file",
            path: "$.payload",
            message: "--payload requires a JSON payload file."
          }
        };
      }

      payloadFile = nextArg;
      index += 1;
      continue;
    }

    if (arg?.startsWith("--")) {
      return {
        ok: false,
        error: {
          code: "unknown_flag",
          path: "$.flags",
          message: `Unknown flag: ${arg}`
        }
      };
    }

    if (arg !== undefined) {
      files.push(arg);
    }
  }

  const [file, extraFile] = files;

  if (file === undefined) {
    return {
      ok: false,
      error: {
        code: "missing_file",
        path: "$.file",
        message: "Command requires a request definition file."
      }
    };
  }

  if (extraFile !== undefined) {
    return {
      ok: false,
      error: {
        code: "too_many_files",
        path: "$.file",
        message: "Command accepts exactly one request definition file."
      }
    };
  }

  if (payloadFile !== undefined && command !== "submit-fixture") {
    return {
      ok: false,
      error: {
        code: "unknown_flag",
        path: "$.flags",
        message: "--payload is only supported for submit-fixture."
      }
    };
  }

  return {
    ok: true,
    value: {
      command,
      file,
      confirm,
      payloadFile
    }
  };
}

async function loadValidatedDefinition(file: string): Promise<
  | {
      ok: true;
      definition: RequestDefinition;
      warnings: RequestDefinitionError[];
    }
  | {
      ok: false;
      error: RequestDefinitionError;
    }
> {
  const fileContents = await readRequestFile(file);
  if (!fileContents.ok) {
    return fileContents;
  }

  const validation = validateRequestDefinitionInput(fileContents.contents);
  if (!validation.ok) {
    return {
      ok: false,
      error: validation.errors[0] ?? {
        code: "invalid_request_definition",
        path: "$",
        message: "Request definition is invalid."
      }
    };
  }

  return {
    ok: true,
    definition: validation.definition,
    warnings: validation.warnings
  };
}

async function readRequestFile(
  file: string
): Promise<{ ok: true; contents: string } | { ok: false; error: RequestDefinitionError }> {
  let lastError: unknown;

  for (const candidate of requestFileCandidates(file)) {
    try {
      return {
        ok: true,
        contents: await readFile(candidate, "utf8")
      };
    } catch (error) {
      lastError = error;
    }
  }

  return {
    ok: false,
    error: {
      code: "request_file_unreadable",
      path: "$.file",
      message:
        lastError instanceof Error ? lastError.message : "Request definition file is unreadable."
    }
  };
}

function requestFileCandidates(file: string): string[] {
  if (isAbsolute(file)) {
    return [file];
  }

  const candidates = [resolve(file)];
  const initialCwd = process.env.INIT_CWD;
  if (initialCwd !== undefined && initialCwd !== process.cwd()) {
    candidates.push(resolve(initialCwd, file));
  }

  return candidates;
}

function publishFileDefinition(definition: RequestDefinition, confirmed: boolean): CliResult {
  const repository = new InMemoryRequestVersionRepository();
  const result = publishRequestVersion({
    requestId: definition.name,
    definition,
    confirmed,
    mode: "local_demo",
    repository
  });

  if (!result.ok) {
    return errorResult("publish", result.error);
  }

  return okResult({
    ok: true,
    command: "publish",
    storage: "in_memory",
    published: summarizePublishedRequest(result.published)
  });
}

function agentCardForFileDefinition(definition: RequestDefinition, confirmed: boolean): CliResult {
  const repository = new InMemoryRequestVersionRepository();
  const publishResult = publishRequestVersion({
    requestId: definition.name,
    definition,
    confirmed,
    mode: "local_demo",
    repository
  });

  if (!publishResult.ok) {
    return errorResult("agent-card", publishResult.error);
  }

  const requestIdPathSegment = encodeURIComponent(publishResult.published.request_id);
  const requestVersionPathSegment = encodeURIComponent(publishResult.published.request_version);
  const endpointUrl = `https://api.watasu.dev/a2a/requests/${requestIdPathSegment}/${requestVersionPathSegment}`;

  return okResult({
    ok: true,
    command: "agent-card",
    mode: "file_based_phase_4_wrapper",
    agent_card: buildAgentCard({
      published: publishResult.published,
      endpointUrl
    })
  });
}

function schemaForFileDefinition(definition: RequestDefinition): CliResult {
  const hashes = createRequestVersionHashes(definition);

  return okResult({
    ok: true,
    command: "schema",
    request: summarizeDefinition(definition),
    schemas: {
      plaintext: generatePlaintextPayloadSchema(definition),
      envelope: generateEncryptedEnvelopeSchema(definition, hashes)
    }
  });
}

function summarizeDefinition(definition: RequestDefinition) {
  return {
    name: definition.name,
    schema_version: definition.schema_version,
    trust_profile: definition.trust_profile,
    field_count: definition.fields.length
  };
}

function summarizePublishedRequest(published: {
  request_id: string;
  request_version: string;
  hashes: {
    request_version_hash: string;
    schema_hash: string;
    consent_text_hash: string;
    destination_policy_hash: string;
    public_key_fingerprint: string;
  };
}) {
  return {
    request_id: published.request_id,
    request_version: published.request_version,
    hashes: published.hashes
  };
}

function okResult(value: unknown): CliResult {
  return {
    exitCode: 0,
    stdout: `${JSON.stringify(value)}\n`,
    stderr: ""
  };
}

function errorResult(command: CommandName | undefined, error: RequestDefinitionError): CliResult {
  return {
    exitCode: 1,
    stdout: "",
    stderr: `${JSON.stringify({
      ok: false,
      ...(command === undefined ? {} : { command }),
      error
    })}\n`
  };
}

function isCommand(command: string | undefined): command is CommandName {
  return (
    command === "validate" ||
    command === "publish" ||
    command === "agent-card" ||
    command === "schema" ||
    command === "ledger" ||
    command === "inspect-delivery" ||
    command === "submit-fixture"
  );
}

async function ledgerForFileDefinition(
  definition: RequestDefinition,
  confirmed: boolean
): Promise<CliResult> {
  const delivery = await runFixtureDelivery(definition, confirmed);
  if (!delivery.ok) {
    return errorResult("ledger", delivery.error);
  }

  return okResult({
    ok: true,
    command: "ledger",
    mode: "file_based_phase_8_wrapper",
    ledger: delivery.rows
  });
}

async function inspectDeliveryForFileDefinition(
  definition: RequestDefinition,
  confirmed: boolean
): Promise<CliResult> {
  const delivery = await runFixtureDelivery(definition, confirmed);
  if (!delivery.ok) {
    return errorResult("inspect-delivery", delivery.error);
  }

  return okResult({
    ok: true,
    command: "inspect-delivery",
    mode: "file_based_phase_8_wrapper",
    delivery: delivery.rows[0]
  });
}

async function runFixtureDelivery(
  definition: RequestDefinition,
  confirmed: boolean
): Promise<
  | {
      ok: true;
      rows: DeliveryLedgerRow[];
    }
  | {
      ok: false;
      error: RequestDefinitionError;
    }
> {
  const repository = new InMemoryRequestVersionRepository();
  const publishResult = publishRequestVersion({
    requestId: definition.name,
    definition,
    confirmed,
    mode: "local_demo",
    repository
  });

  if (!publishResult.ok) {
    return {
      ok: false,
      error: publishResult.error
    };
  }

  const rows: DeliveryLedgerRow[] = [];
  const ledger: DeliveryLedger = {
    writeDeliveryAttempt(row) {
      rows.push(row);
    }
  };
  const client: DeliveryClient = {
    async post() {
      return {
        status: 204
      };
    }
  };
  const encryptedPayload = {
    protected: "base64url-protected",
    iv: "base64url-iv",
    ciphertext: "base64url-ciphertext",
    tag: "base64url-tag"
  };
  const submittedAt = "2026-06-14T11:59:00.000Z";

  const result = await deliverAcceptedSubmission({
    mode: "hosted",
    published: publishResult.published,
    envelope: {
      request_id: publishResult.published.request_id,
      request_version: publishResult.published.request_version,
      schema_hash: publishResult.published.hashes.schema_hash,
      consent_receipt_hash: publishResult.published.hashes.consent_text_hash,
      idempotency_key: "fixture-submit-001",
      submitted_at: submittedAt,
      service_key_id: definition.encryption.service_key_id,
      encrypted_payload: encryptedPayload,
      encrypted_payload_hash: sha256Hash(canonicalizeJson(encryptedPayload)),
      sender_key_id: "fixture-sender-key",
      sender_signature: "fixture-sender-signature"
    },
    submission: {
      request_id: publishResult.published.request_id,
      request_version: publishResult.published.request_version,
      idempotency_key: "fixture-submit-001",
      submitted_at: submittedAt,
      accepted_at: "2026-06-14T12:00:00.000Z",
      capability_hash: sha256Hash("https://api.watasu.dev/capabilities/fixture")
    },
    client,
    ledger,
    clock: () => new Date("2026-06-14T12:00:01.000Z"),
    signingSecret: "fixture-signing-secret"
  });

  if (!result.ok && result.status === "rejected") {
    return {
      ok: false,
      error: {
        code: result.error.code,
        path: "$.destination.url",
        message: result.error.message
      }
    };
  }

  return {
    ok: true,
    rows
  };
}

async function submitFixtureForFileDefinition(
  definition: RequestDefinition,
  confirmed: boolean,
  payloadFile: string | undefined
): Promise<CliResult> {
  if (payloadFile === undefined) {
    return errorResult("submit-fixture", {
      code: "missing_payload_file",
      path: "$.payload",
      message: "submit-fixture requires --payload <payload.json>."
    });
  }

  const loadedPayload = await readPayloadFile(payloadFile);
  if (!loadedPayload.ok) {
    return errorResult("submit-fixture", loadedPayload.error);
  }

  const repository = new InMemoryRequestVersionRepository();
  const publishResult = publishRequestVersion({
    requestId: definition.name,
    definition,
    confirmed,
    mode: "local_demo",
    repository
  });

  if (!publishResult.ok) {
    return errorResult("submit-fixture", publishResult.error);
  }

  let fixtureSubmission;
  try {
    fixtureSubmission = buildSenderFixtureSubmission({
      agentCard: buildAgentCard({
        published: publishResult.published,
        endpointUrl: "https://api.watasu.dev/a2a/fixture-submit"
      }),
      plaintextSchema: generatePlaintextPayloadSchema(definition),
      payload: loadedPayload.payload,
      idempotencyKey: "fixture-submit-001",
      submittedAt: "2026-06-14T11:59:00.000Z",
      encryptPayload: encryptFixturePayload
    });
  } catch (error) {
    return errorResult("submit-fixture", {
      code: "invalid_payload",
      path: "$.payload",
      message: error instanceof Error ? error.message : "Payload is invalid."
    });
  }

  const envelope = fixtureSubmission.body.message.parts[0].data;
  const rows: DeliveryLedgerRow[] = [];
  const ledger: DeliveryLedger = {
    writeDeliveryAttempt(row) {
      rows.push(row);
    }
  };
  const client: DeliveryClient = {
    async post() {
      return {
        status: 204
      };
    }
  };

  const delivery = await deliverAcceptedSubmission({
    mode: "hosted",
    published: publishResult.published,
    envelope,
    submission: {
      request_id: publishResult.published.request_id,
      request_version: publishResult.published.request_version,
      idempotency_key: envelope.idempotency_key,
      submitted_at: envelope.submitted_at,
      accepted_at: "2026-06-14T12:00:00.000Z",
      capability_hash: sha256Hash("https://api.watasu.dev/capabilities/fixture")
    },
    client,
    ledger,
    clock: () => new Date("2026-06-14T12:00:01.000Z"),
    signingSecret: "fixture-signing-secret"
  });

  if (!delivery.ok) {
    return errorResult("submit-fixture", {
      code: delivery.error.code,
      path: "$.delivery",
      message: delivery.error.message
    });
  }

  return okResult({
    ok: true,
    command: "submit-fixture",
    mode: "file_based_phase_8_wrapper",
    delivery: delivery.ledger
  });
}

async function readPayloadFile(
  file: string
): Promise<
  | {
      ok: true;
      payload: Record<string, unknown>;
    }
  | {
      ok: false;
      error: RequestDefinitionError;
    }
> {
  const fileContents = await readRequestFile(file);
  if (!fileContents.ok) {
    return {
      ok: false,
      error: {
        code: "payload_file_unreadable",
        path: "$.payload",
        message: fileContents.error.message
      }
    };
  }

  try {
    const payload = JSON.parse(fileContents.contents);
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      return {
        ok: false,
        error: {
          code: "invalid_payload",
          path: "$.payload",
          message: "Payload file must contain a JSON object."
        }
      };
    }

    return {
      ok: true,
      payload: payload as Record<string, unknown>
    };
  } catch {
    return {
      ok: false,
      error: {
        code: "invalid_payload_json",
        path: "$.payload",
        message: "Payload file must be valid JSON."
      }
    };
  }
}

function encryptFixturePayload(input: { payload: Record<string, unknown> }): SenderFixtureEncryptedPayload {
  const payloadHash = sha256Hash(canonicalizeJson(input.payload));

  return {
    protected: "base64url-protected",
    iv: "base64url-iv",
    ciphertext: `fixture-ciphertext-${payloadHash}`,
    tag: "base64url-tag"
  };
}
