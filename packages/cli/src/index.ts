import { readFile } from "node:fs/promises";
import {
  buildAgentCard,
  createRequestVersionHashes,
  generateEncryptedEnvelopeSchema,
  generatePlaintextPayloadSchema,
  InMemoryRequestVersionRepository,
  publishRequestVersion,
  validateRequestDefinitionInput,
  type RequestDefinition,
  type RequestDefinitionError
} from "@watasu/core";

export const cliPackageName = "@watasu/cli";

export interface CliResult {
  exitCode: 0 | 1;
  stdout: string;
  stderr: string;
}

type CommandName = "validate" | "publish" | "agent-card" | "schema";

interface ParsedArgs {
  command: CommandName;
  file: string;
  confirm: boolean;
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
  }
}

function parseArgs(
  argv: string[]
): { ok: true; value: ParsedArgs } | { ok: false; error: RequestDefinitionError } {
  const [command, file, ...flags] = argv;

  if (!isCommand(command)) {
    return {
      ok: false,
      error: {
        code: command === undefined ? "missing_command" : "unknown_command",
        path: "$.command",
        message: "Command must be one of validate, publish, agent-card, or schema."
      }
    };
  }

  if (file === undefined || file.startsWith("--")) {
    return {
      ok: false,
      error: {
        code: "missing_file",
        path: "$.file",
        message: "Command requires a request definition file."
      }
    };
  }

  const unknownFlag = flags.find((flag) => flag !== "--confirm");
  if (unknownFlag !== undefined) {
    return {
      ok: false,
      error: {
        code: "unknown_flag",
        path: "$.flags",
        message: `Unknown flag: ${unknownFlag}`
      }
    };
  }

  return {
    ok: true,
    value: {
      command,
      file,
      confirm: flags.includes("--confirm")
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
  try {
    return {
      ok: true,
      contents: await readFile(file, "utf8")
    };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "request_file_unreadable",
        path: "$.file",
        message: error instanceof Error ? error.message : "Request definition file is unreadable."
      }
    };
  }
}

function publishFileDefinition(definition: RequestDefinition, confirmed: boolean): CliResult {
  const repository = new InMemoryRequestVersionRepository();
  const result = publishRequestVersion({
    requestId: definition.name,
    definition,
    confirmed,
    mode: "hosted",
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
    mode: "hosted",
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
    command === "schema"
  );
}
