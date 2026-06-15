import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { spawn } from "node:child_process";
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

export interface PersonalInfoMcpStdioConfig {
  command: string;
  args?: string[] | undefined;
  env?: Record<string, string | undefined> | undefined;
  timeoutMs?: number | undefined;
}

export type FieldMapping = Record<string, string>;

export interface PersonalInfoAdapterDryRunInput {
  agentCard: AgentCard | unknown;
  plaintextSchema: JsonSchemaObject | unknown;
  fieldMapping: FieldMapping;
  personalInfo: PersonalInfoReader;
}

export interface PersonalInfoAdapterSubmitInput extends PersonalInfoAdapterDryRunInput {
  confirmation?: PersonalInfoAdapterConfirmation | undefined;
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

export interface PersonalInfoAdapterConfirmation {
  request_version: string;
  consent_text_hash: string;
  field_purposes_hash: string;
  destination_policy_hash: string;
  confirmed_at: string;
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
    | "missing_field_purposes_hash"
    | "missing_request_id"
    | "missing_request_version"
    | "missing_destination_policy_hash"
    | "missing_submission_endpoint"
    | "invalid_submission_endpoint"
    | "invalid_plaintext_schema"
    | "missing_required_mapping"
    | "missing_personal_info_value"
    | "personal_info_mcp_failed"
    | "personal_info_source_required"
    | "missing_confirmation"
    | "confirmation_request_version_mismatch"
    | "confirmation_consent_text_mismatch"
    | "confirmation_field_purposes_mismatch"
    | "confirmation_destination_policy_mismatch"
    | "request_version_mismatch"
    | "schema_hash_mismatch"
    | "public_key_fingerprint_mismatch"
    | "submit_auth_required"
    | "submit_resubmit_later"
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

type JsonInputResult = Awaited<ReturnType<typeof readJsonInput>>;

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

  const confirmationResult = validateConfirmation(contract.extension, input.confirmation);
  if (!confirmationResult.ok) {
    return confirmationResult;
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
    consent_receipt_hash: sha256Hash(canonicalizeJson(input.confirmation)),
    consent_receipt: input.confirmation,
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
    const submitError = classifySubmitError(response.status, responseText);
    return {
      ok: false,
      error: submitError
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

export function createPersonalInfoMcpStdioReader(
  config: PersonalInfoMcpStdioConfig
): PersonalInfoReader {
  return {
    async getPersonalInfo(field: string): Promise<string | undefined> {
      return callPersonalInfoMcpGetTool(config, field);
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
  env?: Record<string, string | undefined> | undefined;
  now?: (() => Date) | undefined;
}): Promise<{
  exitCode: 0 | 1;
  stdout: string;
  stderr: string;
}>;
export async function runPersonalInfoAdapterCli(argv: string[], dependencies: {
  fetch?: ((url: string, init: RequestInit) => Promise<Response>) | undefined;
  env?: Record<string, string | undefined> | undefined;
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

  if (parsed.value.command === "submit" && !parsed.value.confirm) {
    return errorResult(
      {
        code: "missing_confirmation",
        path: "$.confirm",
        message: "Submit requires --confirm before personal-info values can be read."
      },
      parsed.value.command
    );
  }

  const inputReads: Promise<JsonInputResult>[] = [
    readJsonInput(parsed.value.agentCard),
    readJsonInput(parsed.value.schema),
    readJsonInput(parsed.value.mapping)
  ];
  if (parsed.value.personalInfoValues !== undefined) {
    inputReads.push(readJsonInput(parsed.value.personalInfoValues));
  }
  if (parsed.value.command === "submit") {
    inputReads.push(readJsonInput(parsed.value.publicJwk));
  }

  const loadedInputs = await Promise.all(inputReads);

  const [agentCard, plaintextSchema, fieldMapping, maybePersonalInfoValues, maybePublicJwk] =
    loadedInputs;
  const personalInfoValues = parsed.value.personalInfoValues === undefined
    ? undefined
    : maybePersonalInfoValues;
  const publicJwk = parsed.value.command === "submit" && parsed.value.personalInfoValues === undefined
    ? maybePersonalInfoValues
    : maybePublicJwk;
  if (
    agentCard === undefined ||
    plaintextSchema === undefined ||
    fieldMapping === undefined
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

  if (personalInfoValues !== undefined && !personalInfoValues.ok) {
    return errorResult(personalInfoValues.error, parsed.value.command);
  }

  const personalInfo = createCliPersonalInfoReader(parsed.value, personalInfoValues, dependencies);
  if (!personalInfo.ok) {
    return errorResult(personalInfo.error, parsed.value.command);
  }

  if (parsed.value.command === "dry-run") {
    const result = await createPersonalInfoAdapterDryRun({
      agentCard: agentCard.value,
      plaintextSchema: plaintextSchema.value,
      fieldMapping: asRecord(fieldMapping.value),
      personalInfo: personalInfo.reader
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
    personalInfo: personalInfo.reader,
    confirmation: confirmationFromAgentCard(agentCard.value, now),
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

function validateConfirmation(
  extension: AgentCard["capabilities"]["extensions"][number],
  confirmation: PersonalInfoAdapterConfirmation | undefined
): { ok: true } | { ok: false; error: PersonalInfoAdapterError } {
  if (confirmation === undefined) {
    return {
      ok: false,
      error: {
        code: "missing_confirmation",
        path: "$.confirmation",
        message: "Submit requires explicit confirmation before personal-info values can be read."
      }
    };
  }

  const checks: Array<{
    code: PersonalInfoAdapterError["code"];
    path: string;
    actual: string;
    expected: string;
    message: string;
  }> = [
    {
      code: "confirmation_request_version_mismatch",
      path: "$.confirmation.request_version",
      actual: confirmation.request_version,
      expected: extension.params.request_version,
      message: "Confirmation request version does not match the Agent Card request version."
    },
    {
      code: "confirmation_consent_text_mismatch",
      path: "$.confirmation.consent_text_hash",
      actual: confirmation.consent_text_hash,
      expected: extension.params.consent_text_hash,
      message: "Confirmation consent text hash does not match the Agent Card consent text hash."
    },
    {
      code: "confirmation_field_purposes_mismatch",
      path: "$.confirmation.field_purposes_hash",
      actual: confirmation.field_purposes_hash,
      expected: extension.params.field_purposes_hash,
      message: "Confirmation field purposes hash does not match the Agent Card field purposes hash."
    },
    {
      code: "confirmation_destination_policy_mismatch",
      path: "$.confirmation.destination_policy_hash",
      actual: confirmation.destination_policy_hash,
      expected: extension.params.destination_policy_hash,
      message:
        "Confirmation destination policy hash does not match the Agent Card destination policy hash."
    }
  ];
  const failed = checks.find((check) => check.actual !== check.expected);
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

function confirmationFromAgentCard(
  agentCard: unknown,
  confirmedAt: Date
): PersonalInfoAdapterConfirmation {
  const extension = findRequiredWatasuExtension(agentCard);

  return {
    request_version: extension.params.request_version,
    consent_text_hash: extension.params.consent_text_hash,
    field_purposes_hash: extension.params.field_purposes_hash,
    destination_policy_hash: extension.params.destination_policy_hash,
    confirmed_at: confirmedAt.toISOString()
  };
}

function findRequiredWatasuExtension(
  agentCard: unknown
): AgentCard["capabilities"]["extensions"][number] {
  if (!isAgentCardLike(agentCard)) {
    throw new Error("Agent Card must be an A2A HTTP+JSON watasu Agent Card.");
  }

  const extension = agentCard.capabilities.extensions.find(
    (candidate) => candidate.uri === watasuEncryptedIntakeExtensionUri && candidate.required
  );
  if (extension === undefined) {
    throw new Error("Agent Card must include the required watasu encrypted-intake extension.");
  }

  return extension;
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

function classifySubmitError(status: number, responseText: string): PersonalInfoAdapterError {
  const parsed = parseJsonValue(responseText);
  const responseStatus = parsed.ok && isRecord(parsed.value) ? parsed.value.status : undefined;

  if (status === 401 && responseStatus === "auth_required") {
    return {
      code: "submit_auth_required",
      path: "$.submit",
      message: "watasu submit endpoint requires sender authentication for this request."
    };
  }

  if (status === 503 && responseStatus === "resubmit_later") {
    return {
      code: "submit_resubmit_later",
      path: "$.submit",
      message: "watasu submit endpoint asked the sender to resubmit the encrypted payload later."
    };
  }

  return {
    code: "submit_failed",
    path: "$.submit",
    message: `watasu submit endpoint rejected the encrypted envelope with HTTP ${status}.`
  };
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

    let value: string | undefined;
    try {
      value = await input.personalInfo.getPersonalInfo(personalInfoField);
    } catch {
      return {
        ok: false,
        error: {
          code: "personal_info_mcp_failed",
          path: `$.personal_info.${personalInfoField}`,
          message: `personal-info-mcp could not return required field ${personalInfoField}.`
        }
      };
    }

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
      code: "missing_field_purposes_hash",
      path: "$.capabilities.extensions[].params.field_purposes_hash",
      value: extension.params.field_purposes_hash,
      message: "Agent Card extension must include field_purposes_hash."
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

function createCliPersonalInfoReader(
  parsed: ParsedCliSuccessValue,
  personalInfoValues: JsonInputResult | undefined,
  dependencies: {
    env?: Record<string, string | undefined> | undefined;
  }
): { ok: true; reader: PersonalInfoReader } | { ok: false; error: PersonalInfoAdapterError } {
  const hasFixture = parsed.personalInfoValues !== undefined;
  const hasMcp = parsed.personalInfoMcpCommand !== undefined;

  if (hasFixture === hasMcp) {
    return {
      ok: false,
      error: {
        code: "personal_info_source_required",
        path: "$.personal_info_source",
        message:
          "Provide exactly one personal-info source: --personal-info-values or --personal-info-mcp-command."
      }
    };
  }

  if (hasFixture) {
    if (personalInfoValues === undefined || !personalInfoValues.ok) {
      return {
        ok: false,
        error: personalInfoValues?.error ?? {
          code: "missing_argument",
          path: "$.personal-info-values",
          message: "--personal-info-values is required when using fixture input."
        }
      };
    }

    return {
      ok: true,
      reader: personalInfoValueReader(asRecord(personalInfoValues.value))
    };
  }

  return {
    ok: true,
    reader: createPersonalInfoMcpStdioReader({
      command: parsed.personalInfoMcpCommand ?? "",
      args: parsed.personalInfoMcpArgs,
      env: dependencies.env
    })
  };
}

type ParsedCliSuccessValue = Extract<ParsedCliArgs, { ok: true }>["value"];

type ParsedCliArgs =
  | {
      ok: true;
      value: {
        command: "dry-run";
        agentCard: string;
        schema: string;
        mapping: string;
        personalInfoValues?: string | undefined;
        personalInfoMcpCommand?: string | undefined;
        personalInfoMcpArgs: string[];
      };
    }
  | {
      ok: true;
      value: {
        command: "submit";
        agentCard: string;
        schema: string;
        mapping: string;
        personalInfoValues?: string | undefined;
        personalInfoMcpCommand?: string | undefined;
        personalInfoMcpArgs: string[];
        publicJwk: string;
        confirm: boolean;
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
  const repeatedValues: Record<string, string[]> = {};
  let confirm = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--confirm") {
      confirm = true;
      continue;
    }

    if (
      arg === "--agent-card" ||
      arg === "--schema" ||
      arg === "--mapping" ||
      arg === "--personal-info-values" ||
      arg === "--personal-info-mcp-command" ||
      arg === "--personal-info-mcp-arg" ||
      arg === "--public-jwk" ||
      arg === "--idempotency-key" ||
      arg === "--submitted-at" ||
      arg === "--expect-request-version" ||
      arg === "--expect-schema-hash"
    ) {
      const next = args[index + 1];
      if (next === undefined || (next.startsWith("--") && arg !== "--personal-info-mcp-arg")) {
        return {
          ok: false,
          error: {
            code: "missing_argument",
            path: `$.${arg.slice(2)}`,
            message: `${arg} requires a file path or URL.`
          }
        };
      }

      if (arg === "--personal-info-mcp-arg") {
        repeatedValues[arg] = [...(repeatedValues[arg] ?? []), next];
      } else {
        values[arg] = next;
      }
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

  const required = ["--agent-card", "--schema", "--mapping"];
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

  const personalInfoSourceCount = [
    values["--personal-info-values"],
    values["--personal-info-mcp-command"]
  ].filter((value) => value !== undefined).length;
  if (personalInfoSourceCount !== 1) {
    return {
      ok: false,
      error: {
        code: "personal_info_source_required",
        path: "$.personal_info_source",
        message:
          "Provide exactly one personal-info source: --personal-info-values or --personal-info-mcp-command."
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
        personalInfoValues: values["--personal-info-values"],
        personalInfoMcpCommand: values["--personal-info-mcp-command"],
        personalInfoMcpArgs: repeatedValues["--personal-info-mcp-arg"] ?? [],
        publicJwk: values["--public-jwk"] ?? "",
        confirm,
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
      personalInfoValues: values["--personal-info-values"],
      personalInfoMcpCommand: values["--personal-info-mcp-command"],
      personalInfoMcpArgs: repeatedValues["--personal-info-mcp-arg"] ?? []
    }
  };
}

async function callPersonalInfoMcpGetTool(
  config: PersonalInfoMcpStdioConfig,
  field: string
): Promise<string | undefined> {
  const timeoutMs = config.timeoutMs ?? 5_000;
  const child = spawn(config.command, config.args ?? [], {
    env: {
      ...process.env,
      ...config.env
    },
    stdio: ["pipe", "pipe", "ignore"]
  });
  let stdout = "";
  let childError: Error | undefined;
  const responses = new Map<number, unknown>();
  let nextId = 1;

  child.on("error", (error: Error) => {
    childError = error;
  });

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    while (stdout.includes("\n")) {
      const index = stdout.indexOf("\n");
      const line = stdout.slice(0, index).trim();
      stdout = stdout.slice(index + 1);
      if (line.length === 0) {
        continue;
      }

      const parsed = parseJsonValue(line);
      if (parsed.ok && isRecord(parsed.value) && typeof parsed.value.id === "number") {
        responses.set(parsed.value.id, parsed.value);
      }
    }
  });

  const request = (method: string, params: Record<string, unknown>): number => {
    const id = nextId;
    nextId += 1;
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params
    })}\n`);
    return id;
  };

  const notify = (method: string, params: Record<string, unknown>): void => {
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      method,
      params
    })}\n`);
  };

  try {
    const initializeId = request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: {
        name: personalInfoAdapterPackageName,
        version: "0.0.0"
      }
    });
    await waitForJsonRpcResponse(responses, initializeId, timeoutMs, () => childError);
    notify("notifications/initialized", {});

    const toolCallId = request("tools/call", {
      name: "get_personal_info",
      arguments: {
        field
      }
    });
    const response = await waitForJsonRpcResponse(
      responses,
      toolCallId,
      timeoutMs,
      () => childError
    );
    return extractMcpTextResult(response);
  } finally {
    child.stdin.end();
    child.kill();
  }
}

async function waitForJsonRpcResponse(
  responses: Map<number, unknown>,
  id: number,
  timeoutMs: number,
  getTransportError: () => Error | undefined
): Promise<unknown> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const transportError = getTransportError();
    if (transportError !== undefined) {
      throw transportError;
    }

    const response = responses.get(id);
    if (response !== undefined) {
      responses.delete(id);
      if (isRecord(response) && response.error !== undefined) {
        throw new Error("personal-info-mcp returned a JSON-RPC error.");
      }

      return response;
    }

    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }

  throw new Error("personal-info-mcp did not respond before timeout.");
}

function extractMcpTextResult(response: unknown): string | undefined {
  if (!isRecord(response) || !isRecord(response.result) || !Array.isArray(response.result.content)) {
    throw new Error("personal-info-mcp response did not include text content.");
  }

  const firstText = response.result.content.find(
    (item): item is { type: "text"; text: string } =>
      isRecord(item) && item.type === "text" && typeof item.text === "string"
  );

  return firstText?.text;
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
