import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  canonicalizeJson,
  encryptJsonPayload,
  sha256Hash,
  watasuA2aHttpJsonContentType,
  watasuA2aProtocolVersion,
  watasuEncryptedIntakeExtensionUri,
  type AgentCard,
  type JsonSchemaObject
} from "@watasu/core";

export const personalInfoAdapterPackageName = "@watasu/personal-info-adapter";

export interface PersonalInfoReader {
  getPersonalInfo(field: string): Promise<string | undefined>;
}

export type FieldMapping = Record<string, string>;

export interface PersonalInfoAdapterDryRunInput {
  agentCard: AgentCard | unknown;
  plaintextSchema: JsonSchemaObject | unknown;
  fieldMapping: FieldMapping;
  personalInfo: PersonalInfoReader;
}

export interface PersonalInfoAdapterSubmitInput extends PersonalInfoAdapterDryRunInput {
  idempotencyKey: string;
  submittedAt: string;
  expectedRequestVersion?: string | undefined;
  expectedSchemaHash?: string | undefined;
  encryptPayload: (
    payload: Record<string, unknown>,
    context: {
      encryption: AgentCard["capabilities"]["extensions"][number]["params"]["encryption"];
    }
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
}

export interface PersonalInfoAdapterDryRunSummary {
  dry_run: true;
  service_name: string;
  request_id: string;
  request_version: string;
  schema_hash: string;
  destination_policy_hash: string;
  destination_origin: string;
  fields: Array<{
    watasu_field: string;
    personal_info_field: string;
    value: "[REDACTED]";
  }>;
}

export type PersonalInfoAdapterDryRunResult =
  | {
      ok: true;
      summary: PersonalInfoAdapterDryRunSummary;
    }
  | {
      ok: false;
      error: PersonalInfoAdapterError;
    };

export type PersonalInfoAdapterSubmitResult =
  | {
      ok: true;
      status: string;
      summary: {
        request_id: string;
        request_version: string;
        schema_hash: string;
        destination_origin: string;
        encrypted_payload_hash: string;
        plaintext_values_sent_to_watasu: false;
        response_contains_plaintext_payload: boolean;
        ledger_contains_payload_body: boolean;
      };
    }
  | {
      ok: false;
      error: PersonalInfoAdapterError;
    };

export interface PersonalInfoAdapterError {
  code:
    | "invalid_agent_card"
    | "missing_watasu_extension"
    | "missing_schema_hash"
    | "missing_request_id"
    | "missing_request_version"
    | "missing_destination_policy_hash"
    | "missing_submission_endpoint"
    | "invalid_submission_endpoint"
    | "invalid_plaintext_schema"
    | "missing_required_mapping"
    | "missing_personal_info_value"
    | "request_version_mismatch"
    | "schema_hash_mismatch"
    | "public_key_fingerprint_mismatch"
    | "submit_failed"
    | "invalid_submit_response"
    | "file_unreadable"
    | "invalid_json"
    | "unknown_command"
    | "missing_argument"
    | "unknown_flag";
  message: string;
  path: string;
}

export async function createPersonalInfoAdapterDryRun(
  input: PersonalInfoAdapterDryRunInput
): Promise<PersonalInfoAdapterDryRunResult> {
  const contract = validateAdapterContract(input.agentCard, input.plaintextSchema);
  if (!contract.ok) {
    return contract;
  }

  const payloadResult = await buildPlaintextPayload({
    schema: contract.schema,
    fieldMapping: input.fieldMapping,
    personalInfo: input.personalInfo
  });
  if (!payloadResult.ok) {
    return payloadResult;
  }

  const fields = contract.schema.required.map((watasuField) => ({
    watasu_field: watasuField,
    personal_info_field: input.fieldMapping[watasuField] ?? "",
    value: "[REDACTED]" as const
  }));

  return {
    ok: true,
    summary: {
      dry_run: true,
      service_name: contract.card.name,
      request_id: contract.extension.params.request_id,
      request_version: contract.extension.params.request_version,
      schema_hash: contract.extension.params.schema_hash,
      destination_policy_hash: contract.extension.params.destination_policy_hash,
      destination_origin: new URL(contract.submissionEndpoint).origin,
      fields
    }
  };
}

export async function createPersonalInfoAdapterSubmit(
  input: PersonalInfoAdapterSubmitInput
): Promise<PersonalInfoAdapterSubmitResult> {
  const contract = validateAdapterContract(input.agentCard, input.plaintextSchema);
  if (!contract.ok) {
    return contract;
  }

  if (
    input.expectedRequestVersion !== undefined &&
    input.expectedRequestVersion !== contract.extension.params.request_version
  ) {
    return {
      ok: false,
      error: {
        code: "request_version_mismatch",
        path: "$.expected_request_version",
        message: "Expected request version does not match the Agent Card request version."
      }
    };
  }

  if (
    input.expectedSchemaHash !== undefined &&
    input.expectedSchemaHash !== contract.extension.params.schema_hash
  ) {
    return {
      ok: false,
      error: {
        code: "schema_hash_mismatch",
        path: "$.expected_schema_hash",
        message: "Expected schema hash does not match the Agent Card schema hash."
      }
    };
  }

  const payloadResult = await buildPlaintextPayload({
    schema: contract.schema,
    fieldMapping: input.fieldMapping,
    personalInfo: input.personalInfo
  });
  if (!payloadResult.ok) {
    return payloadResult;
  }

  const encryptedPayload = await input.encryptPayload(payloadResult.payload, {
    encryption: contract.extension.params.encryption
  });
  const encryptedPayloadHash = sha256Hash(canonicalizeJson(encryptedPayload));
  const envelope = {
    request_id: contract.extension.params.request_id,
    request_version: contract.extension.params.request_version,
    schema_hash: contract.extension.params.schema_hash,
    consent_receipt_hash: contract.extension.params.consent_text_hash,
    idempotency_key: input.idempotencyKey,
    submitted_at: input.submittedAt,
    service_key_id: contract.extension.params.encryption.service_key_id,
    encrypted_payload: encryptedPayload,
    encrypted_payload_hash: encryptedPayloadHash
  };
  const body = {
    message: {
      role: "ROLE_USER",
      messageId: input.idempotencyKey,
      parts: [
        {
          type: "data",
          mediaType: "application/json",
          data: envelope
        }
      ]
    }
  };

  const response = await input.fetch(contract.submissionEndpoint, {
    method: "POST",
    headers: {
      "content-type": watasuA2aHttpJsonContentType,
      "a2a-version": watasuA2aProtocolVersion,
      "a2a-extensions": watasuEncryptedIntakeExtensionUri
    },
    body: JSON.stringify(body)
  });
  const responseText = await response.text();
  if (!response.ok) {
    return {
      ok: false,
      error: {
        code: "submit_failed",
        path: "$.submit",
        message: `watasu submit endpoint rejected the encrypted envelope with HTTP ${response.status}.`
      }
    };
  }

  const responseJson = parseJsonValue(responseText);
  if (
    !responseJson.ok ||
    !isRecord(responseJson.value) ||
    typeof responseJson.value.status !== "string"
  ) {
    return {
      ok: false,
      error: {
        code: "invalid_submit_response",
        path: "$.submit.response",
        message: "watasu submit endpoint must return a JSON object with status."
      }
    };
  }

  return {
    ok: true,
    status: responseJson.value.status,
    summary: {
      request_id: contract.extension.params.request_id,
      request_version: contract.extension.params.request_version,
      schema_hash: contract.extension.params.schema_hash,
      destination_origin: new URL(contract.submissionEndpoint).origin,
      encrypted_payload_hash: encryptedPayloadHash,
      plaintext_values_sent_to_watasu: false,
      response_contains_plaintext_payload: containsAnyValue(responseText, payloadResult.values),
      ledger_contains_payload_body: containsAnyValue(
        JSON.stringify(responseJson.value.ledger ?? ""),
        payloadResult.values
      )
    }
  };
}

export async function runPersonalInfoAdapterCli(argv: string[]): Promise<{
  exitCode: 0 | 1;
  stdout: string;
  stderr: string;
}>;
export async function runPersonalInfoAdapterCli(argv: string[], dependencies: {
  fetch?: ((url: string, init: RequestInit) => Promise<Response>) | undefined;
  now?: (() => Date) | undefined;
}): Promise<{
  exitCode: 0 | 1;
  stdout: string;
  stderr: string;
}>;
export async function runPersonalInfoAdapterCli(argv: string[], dependencies: {
  fetch?: ((url: string, init: RequestInit) => Promise<Response>) | undefined;
  now?: (() => Date) | undefined;
} = {}): Promise<{
  exitCode: 0 | 1;
  stdout: string;
  stderr: string;
}> {
  const parsed = parseCliArgs(argv);
  if (!parsed.ok) {
    return errorResult(parsed.error, "personal-info-adapter");
  }

  const inputReads = [
    readJsonInput(parsed.value.agentCard),
    readJsonInput(parsed.value.schema),
    readJsonInput(parsed.value.mapping),
    readJsonInput(parsed.value.personalInfoValues)
  ];
  if (parsed.value.command === "submit") {
    inputReads.push(readJsonInput(parsed.value.publicJwk));
  }

  const loadedInputs = await Promise.all(inputReads);

  const [agentCard, plaintextSchema, fieldMapping, personalInfoValues, publicJwk] = loadedInputs;
  if (
    agentCard === undefined ||
    plaintextSchema === undefined ||
    fieldMapping === undefined ||
    personalInfoValues === undefined
  ) {
    return errorResult(
      {
        code: "missing_argument",
        path: "$.inputs",
        message: "All dry-run inputs are required."
      },
      parsed.value.command
    );
  }

  if (!agentCard.ok) {
    return errorResult(agentCard.error, parsed.value.command);
  }

  if (!plaintextSchema.ok) {
    return errorResult(plaintextSchema.error, parsed.value.command);
  }

  if (!fieldMapping.ok) {
    return errorResult(fieldMapping.error, parsed.value.command);
  }

  if (!personalInfoValues.ok) {
    return errorResult(personalInfoValues.error, parsed.value.command);
  }

  if (parsed.value.command === "dry-run") {
    const result = await createPersonalInfoAdapterDryRun({
      agentCard: agentCard.value,
      plaintextSchema: plaintextSchema.value,
      fieldMapping: asRecord(fieldMapping.value),
      personalInfo: personalInfoValueReader(asRecord(personalInfoValues.value))
    });

    if (!result.ok) {
      return errorResult(result.error, parsed.value.command);
    }

    return {
      exitCode: 0,
      stdout: `${JSON.stringify({ ok: true, command: "dry-run", summary: result.summary })}\n`,
      stderr: ""
    };
  }

  if (publicJwk === undefined || !publicJwk.ok) {
    return errorResult(
      publicJwk?.error ?? {
        code: "missing_argument",
        path: "$.public-jwk",
        message: "--public-jwk is required for submit."
      },
      parsed.value.command
    );
  }

  const publicKeyFingerprint = validatePublicKeyFingerprint(agentCard.value, publicJwk.value);
  if (!publicKeyFingerprint.ok) {
    return errorResult(publicKeyFingerprint.error, parsed.value.command);
  }

  const now = (dependencies.now ?? (() => new Date()))();
  const result = await createPersonalInfoAdapterSubmit({
    agentCard: agentCard.value,
    plaintextSchema: plaintextSchema.value,
    fieldMapping: asRecord(fieldMapping.value),
    personalInfo: personalInfoValueReader(asRecord(personalInfoValues.value)),
    idempotencyKey: parsed.value.idempotencyKey ?? `adapter-${now.getTime()}`,
    submittedAt: parsed.value.submittedAt ?? now.toISOString(),
    expectedRequestVersion: parsed.value.expectedRequestVersion,
    expectedSchemaHash: parsed.value.expectedSchemaHash,
    encryptPayload: async (payload, context) => ({
      ...(await encryptJsonPayload({
        payload,
        publicJwk: publicJwk.value as Parameters<typeof encryptJsonPayload>[0]["publicJwk"],
        serviceKeyId: context.encryption.service_key_id,
        alg: context.encryption.key_management,
        enc: context.encryption.content_encryption
      }))
    }),
    fetch: dependencies.fetch ?? fetch
  });

  if (!result.ok) {
    return errorResult(result.error, parsed.value.command);
  }

  return {
    exitCode: 0,
    stdout: `${JSON.stringify({
      ok: true,
      command: "submit",
      status: result.status,
      summary: result.summary
    })}\n`,
    stderr: ""
  };
}

function validateAdapterContract(
  agentCard: unknown,
  plaintextSchema: unknown
):
  | {
      ok: true;
      card: AgentCard;
      extension: AgentCard["capabilities"]["extensions"][number];
      schema: JsonSchemaObject;
      submissionEndpoint: string;
    }
  | { ok: false; error: PersonalInfoAdapterError } {
  if (!isAgentCardLike(agentCard)) {
    return {
      ok: false,
      error: {
        code: "invalid_agent_card",
        path: "$.agent_card",
        message: "Agent Card must be an A2A HTTP+JSON watasu Agent Card."
      }
    };
  }

  const extension = agentCard.capabilities.extensions.find(
    (candidate) => candidate.uri === watasuEncryptedIntakeExtensionUri && candidate.required
  );
  if (extension === undefined) {
    return {
      ok: false,
      error: {
        code: "missing_watasu_extension",
        path: "$.capabilities.extensions",
        message: "Agent Card must include the required watasu encrypted-intake extension."
      }
    };
  }

  const requiredParam = requireExtensionParams(extension);
  if (!requiredParam.ok) {
    return requiredParam;
  }

  const endpoint = agentCard.supportedInterfaces.find(
    (candidate) =>
      candidate.protocolBinding === "HTTP+JSON" && candidate.protocolVersion === "1.0"
  )?.url;
  if (endpoint === undefined || endpoint.length === 0) {
    return {
      ok: false,
      error: {
        code: "missing_submission_endpoint",
        path: "$.supportedInterfaces",
        message: "Agent Card must advertise an HTTP+JSON submission endpoint."
      }
    };
  }

  try {
    new URL(endpoint);
  } catch {
    return {
      ok: false,
      error: {
        code: "invalid_submission_endpoint",
        path: "$.supportedInterfaces[].url",
        message: "Agent Card submission endpoint must be an absolute URL."
      }
    };
  }

  if (!isJsonSchemaObject(plaintextSchema)) {
    return {
      ok: false,
      error: {
        code: "invalid_plaintext_schema",
        path: "$.plaintext_schema",
        message: "Plaintext schema must be a JSON object schema with a required field list."
      }
    };
  }

  return {
    ok: true,
    card: agentCard,
    extension,
    schema: plaintextSchema,
    submissionEndpoint: endpoint
  };
}

function validatePublicKeyFingerprint(
  agentCard: unknown,
  publicJwk: unknown
): { ok: true } | { ok: false; error: PersonalInfoAdapterError } {
  if (!isAgentCardLike(agentCard)) {
    return {
      ok: false,
      error: {
        code: "invalid_agent_card",
        path: "$.agent_card",
        message: "Agent Card must be an A2A HTTP+JSON watasu Agent Card."
      }
    };
  }

  const extension = agentCard.capabilities.extensions.find(
    (candidate) => candidate.uri === watasuEncryptedIntakeExtensionUri && candidate.required
  );
  if (extension === undefined) {
    return {
      ok: false,
      error: {
        code: "missing_watasu_extension",
        path: "$.capabilities.extensions",
        message: "Agent Card must include the required watasu encrypted-intake extension."
      }
    };
  }

  const actual = sha256Hash(canonicalizeJson(publicJwk));
  if (actual !== extension.params.encryption.public_key_fingerprint) {
    return {
      ok: false,
      error: {
        code: "public_key_fingerprint_mismatch",
        path: "$.public-jwk",
        message: "Supplied public JWK does not match the Agent Card public key fingerprint."
      }
    };
  }

  return { ok: true };
}

async function buildPlaintextPayload(input: {
  schema: JsonSchemaObject;
  fieldMapping: FieldMapping;
  personalInfo: PersonalInfoReader;
}): Promise<
  | {
      ok: true;
      payload: Record<string, unknown>;
      values: string[];
    }
  | {
      ok: false;
      error: PersonalInfoAdapterError;
    }
> {
  for (const watasuField of input.schema.required) {
    if (input.fieldMapping[watasuField] === undefined) {
      return {
        ok: false,
        error: {
          code: "missing_required_mapping",
          path: `$.field_mapping.${watasuField}`,
          message: `Required watasu field ${watasuField} is not mapped to a personal-info-mcp field.`
        }
      };
    }
  }

  const payload: Record<string, unknown> = {};
  const values: string[] = [];
  for (const watasuField of input.schema.required) {
    const personalInfoField = input.fieldMapping[watasuField];
    if (personalInfoField === undefined) {
      continue;
    }

    const value = await input.personalInfo.getPersonalInfo(personalInfoField);
    if (value === undefined || value.length === 0) {
      return {
        ok: false,
        error: {
          code: "missing_personal_info_value",
          path: `$.personal_info.${personalInfoField}`,
          message: `personal-info-mcp field ${personalInfoField} is missing a value for required watasu field ${watasuField}.`
        }
      };
    }

    payload[watasuField] = value;
    values.push(value);
  }

  return {
    ok: true,
    payload,
    values
  };
}

function requireExtensionParams(
  extension: AgentCard["capabilities"]["extensions"][number]
): { ok: true } | { ok: false; error: PersonalInfoAdapterError } {
  const checks: Array<{
    code: PersonalInfoAdapterError["code"];
    path: string;
    value: string;
    message: string;
  }> = [
    {
      code: "missing_request_id",
      path: "$.capabilities.extensions[].params.request_id",
      value: extension.params.request_id,
      message: "Agent Card extension must include request_id."
    },
    {
      code: "missing_request_version",
      path: "$.capabilities.extensions[].params.request_version",
      value: extension.params.request_version,
      message: "Agent Card extension must include request_version."
    },
    {
      code: "missing_schema_hash",
      path: "$.capabilities.extensions[].params.schema_hash",
      value: extension.params.schema_hash,
      message: "Agent Card extension must include schema_hash."
    },
    {
      code: "missing_destination_policy_hash",
      path: "$.capabilities.extensions[].params.destination_policy_hash",
      value: extension.params.destination_policy_hash,
      message: "Agent Card extension must include destination_policy_hash."
    }
  ];

  const failed = checks.find((check) => check.value.length === 0);
  if (failed !== undefined) {
    return {
      ok: false,
      error: {
        code: failed.code,
        path: failed.path,
        message: failed.message
      }
    };
  }

  return { ok: true };
}

function isAgentCardLike(value: unknown): value is AgentCard {
  if (!isRecord(value)) {
    return false;
  }

  const capabilities = value.capabilities;
  return (
    value.protocolVersion === "1.0" &&
    isRecord(capabilities) &&
    Array.isArray(capabilities.extensions) &&
    Array.isArray(value.supportedInterfaces) &&
    typeof value.name === "string"
  );
}

function isJsonSchemaObject(value: unknown): value is JsonSchemaObject {
  if (!isRecord(value)) {
    return false;
  }

  return value.type === "object" && Array.isArray(value.required) && isRecord(value.properties);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}

function parseJsonValue(value: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return {
      ok: true,
      value: JSON.parse(value)
    };
  } catch {
    return { ok: false };
  }
}

function containsAnyValue(haystack: string, values: string[]): boolean {
  return values.some((value) => value.length > 0 && haystack.includes(value));
}

function personalInfoValueReader(values: Record<string, string>): PersonalInfoReader {
  return {
    async getPersonalInfo(field: string): Promise<string | undefined> {
      return values[field];
    }
  };
}

type ParsedCliArgs =
  | {
      ok: true;
      value: {
        command: "dry-run";
        agentCard: string;
        schema: string;
        mapping: string;
        personalInfoValues: string;
      };
    }
  | {
      ok: true;
      value: {
        command: "submit";
        agentCard: string;
        schema: string;
        mapping: string;
        personalInfoValues: string;
        publicJwk: string;
        idempotencyKey?: string | undefined;
        submittedAt?: string | undefined;
        expectedRequestVersion?: string | undefined;
        expectedSchemaHash?: string | undefined;
      };
    }
  | { ok: false; error: PersonalInfoAdapterError };

function parseCliArgs(argv: string[]): ParsedCliArgs {
  const [command, ...args] = argv;
  if (command !== "dry-run" && command !== "submit") {
    return {
      ok: false,
      error: {
        code: "unknown_command",
        path: "$.command",
        message: "Command must be dry-run or submit."
      }
    };
  }

  const values: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (
      arg === "--agent-card" ||
      arg === "--schema" ||
      arg === "--mapping" ||
      arg === "--personal-info-values" ||
      arg === "--public-jwk" ||
      arg === "--idempotency-key" ||
      arg === "--submitted-at" ||
      arg === "--expect-request-version" ||
      arg === "--expect-schema-hash"
    ) {
      const next = args[index + 1];
      if (next === undefined || next.startsWith("--")) {
        return {
          ok: false,
          error: {
            code: "missing_argument",
            path: `$.${arg.slice(2)}`,
            message: `${arg} requires a file path or URL.`
          }
        };
      }

      values[arg] = next;
      index += 1;
      continue;
    }

    return {
      ok: false,
      error: {
        code: "unknown_flag",
        path: "$.flags",
        message: `Unknown flag: ${arg ?? ""}`
      }
    };
  }

  const required = ["--agent-card", "--schema", "--mapping", "--personal-info-values"];
  const missing = required.find((flag) => values[flag] === undefined);
  if (missing !== undefined) {
    return {
      ok: false,
      error: {
        code: "missing_argument",
        path: `$.${missing.slice(2)}`,
        message: `${missing} is required.`
      }
    };
  }

  if (command === "submit") {
    for (const flag of ["--public-jwk"]) {
      if (values[flag] === undefined) {
        return {
          ok: false,
          error: {
            code: "missing_argument",
            path: `$.${flag.slice(2)}`,
            message: `${flag} is required for submit.`
          }
        };
      }
    }

    return {
      ok: true,
      value: {
        command,
        agentCard: values["--agent-card"] ?? "",
        schema: values["--schema"] ?? "",
        mapping: values["--mapping"] ?? "",
        personalInfoValues: values["--personal-info-values"] ?? "",
        publicJwk: values["--public-jwk"] ?? "",
        idempotencyKey: values["--idempotency-key"],
        submittedAt: values["--submitted-at"],
        expectedRequestVersion: values["--expect-request-version"],
        expectedSchemaHash: values["--expect-schema-hash"]
      }
    };
  }

  return {
    ok: true,
    value: {
      command,
      agentCard: values["--agent-card"] ?? "",
      schema: values["--schema"] ?? "",
      mapping: values["--mapping"] ?? "",
      personalInfoValues: values["--personal-info-values"] ?? ""
    }
  };
}

async function readJsonInput(
  input: string
): Promise<{ ok: true; value: unknown } | { ok: false; error: PersonalInfoAdapterError }> {
  const loaded = await readTextInput(input);
  if (!loaded.ok) {
    return loaded;
  }

  try {
    return {
      ok: true,
      value: JSON.parse(loaded.contents)
    };
  } catch {
    return {
      ok: false,
      error: {
        code: "invalid_json",
        path: input,
        message: "Input must contain valid JSON."
      }
    };
  }
}

async function readTextInput(
  input: string
): Promise<{ ok: true; contents: string } | { ok: false; error: PersonalInfoAdapterError }> {
  try {
    if (input.startsWith("http://") || input.startsWith("https://")) {
      const response = await fetch(input);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      return {
        ok: true,
        contents: await response.text()
      };
    }

    return {
      ok: true,
      contents: await readFile(resolveInputPath(input), "utf8")
    };
  } catch {
    return {
      ok: false,
      error: {
        code: "file_unreadable",
        path: input,
        message: `Could not read input: ${input}`
      }
    };
  }
}

function resolveInputPath(file: string): string {
  if (isAbsolute(file)) {
    return file;
  }

  return resolve(process.env.INIT_CWD ?? process.cwd(), file);
}

function errorResult(error: PersonalInfoAdapterError, command: string): {
  exitCode: 1;
  stdout: string;
  stderr: string;
} {
  return {
    exitCode: 1,
    stdout: "",
    stderr: `${JSON.stringify({ ok: false, command, error })}\n`
  };
}
