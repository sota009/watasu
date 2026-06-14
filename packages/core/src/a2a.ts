import { watasuEncryptedIntakeExtensionUri } from "./agent-card.js";

export const watasuA2aProtocolVersion = "1.0";
export const watasuA2aHttpJsonContentType = "application/a2a+json";
const jsonPartMediaType = "application/json";

export interface A2aSubmissionRequest {
  headers: Record<string, string | undefined>;
  body: unknown;
}

export interface A2aProtocolGateOptions {
  allowedContentTypes?: readonly string[] | undefined;
  onEnvelopeValidationReady?: (() => void) | undefined;
}

export interface A2aProtocolError {
  code: string;
  status: 400 | 415;
  message: string;
  path: string;
}

export type A2aProtocolGateResult =
  | {
      ok: true;
      envelopeCandidate: unknown;
    }
  | {
      ok: false;
      error: A2aProtocolError;
    };

export function gateA2aSubmissionProtocol(
  request: A2aSubmissionRequest,
  options: A2aProtocolGateOptions = {}
): A2aProtocolGateResult {
  const allowedContentTypes = options.allowedContentTypes ?? [watasuA2aHttpJsonContentType];
  const contentType = getHeader(request.headers, "content-type");
  if (contentType === undefined) {
    return reject(
      "missing_content_type",
      415,
      `A2A submissions require Content-Type: ${formatAllowedContentTypes(allowedContentTypes)}.`,
      "headers.content-type"
    );
  }

  if (!isAllowedContentType(contentType, allowedContentTypes)) {
    return reject(
      "unsupported_content_type",
      415,
      `A2A submissions only support Content-Type: ${formatAllowedContentTypes(
        allowedContentTypes
      )}.`,
      "headers.content-type"
    );
  }

  const a2aVersion = getHeader(request.headers, "a2a-version");
  if (a2aVersion === undefined) {
    return reject(
      "missing_a2a_version",
      400,
      "A2A submissions require the A2A-Version header.",
      "headers.a2a-version"
    );
  }

  if (a2aVersion !== watasuA2aProtocolVersion) {
    return reject(
      "unsupported_a2a_version",
      400,
      `A2A-Version must be ${watasuA2aProtocolVersion}.`,
      "headers.a2a-version"
    );
  }

  const a2aExtensions = getHeader(request.headers, "a2a-extensions");
  if (!headerListContains(a2aExtensions, watasuEncryptedIntakeExtensionUri)) {
    return reject(
      "missing_required_extension",
      400,
      `A2A submissions require extension ${watasuEncryptedIntakeExtensionUri}.`,
      "headers.a2a-extensions"
    );
  }

  const shapeResult = validateSendMessageShape(request.body);
  if (!shapeResult.ok) {
    return shapeResult;
  }

  options.onEnvelopeValidationReady?.();

  return {
    ok: true,
    envelopeCandidate: shapeResult.envelopeCandidate
  };
}

function validateSendMessageShape(body: unknown): A2aProtocolGateResult {
  if (!isRecord(body)) {
    return reject("invalid_a2a_body", 400, "A2A submission body must be a JSON object.", "body");
  }

  if (Object.hasOwn(body, "kind")) {
    return reject(
      "legacy_kind_discriminator",
      400,
      "Legacy kind discriminators are not accepted by this A2A protocol gate.",
      "body.kind"
    );
  }

  if (isJsonRpcLikeBody(body)) {
    return reject(
      "json_rpc_body_not_supported",
      400,
      "A2A HTTP+JSON submissions must use the REST SendMessageRequest body shape.",
      Object.hasOwn(body, "jsonrpc") ? "body.jsonrpc" : "body"
    );
  }

  const message = body.message;
  if (!isRecord(message)) {
    return reject(
      "invalid_send_message",
      400,
      "A2A REST SendMessageRequest body.message must be a JSON object.",
      "body.message"
    );
  }

  if (Object.hasOwn(message, "kind")) {
    return reject(
      "legacy_kind_discriminator",
      400,
      "Legacy kind discriminators are not accepted by this A2A protocol gate.",
      "body.message.kind"
    );
  }

  if (typeof message.role !== "string" || message.role.length === 0) {
    return reject(
      "missing_message_role",
      400,
      "A2A REST SendMessageRequest message.role must be present.",
      "body.message.role"
    );
  }

  const parts = message.parts;
  if (!Array.isArray(parts) || parts.length === 0) {
    return reject(
      "missing_message_parts",
      400,
      "A2A SendMessage must contain at least one message part.",
      "body.message.parts"
    );
  }

  const firstDataPart = findFirstDataPart(parts);
  if (!firstDataPart.ok) {
    return firstDataPart;
  }

  return {
    ok: true,
    envelopeCandidate: firstDataPart.part.data
  };
}

function findFirstDataPart(
  parts: unknown[]
): { ok: true; part: Record<string, unknown> } | { ok: false; error: A2aProtocolError } {
  for (const [index, part] of parts.entries()) {
    const partPath = `body.message.parts[${index}]`;
    if (!isRecord(part)) {
      return reject("invalid_message_part", 400, "A2A message parts must be objects.", partPath);
    }

    if (Object.hasOwn(part, "kind")) {
      return reject(
        "legacy_kind_discriminator",
        400,
        "Legacy kind discriminators are not accepted by this A2A protocol gate.",
        `${partPath}.kind`
      );
    }

    if (part.type !== "data") {
      continue;
    }

    if (part.mediaType !== jsonPartMediaType) {
      return reject(
        "unsupported_part_media_type",
        415,
        "A2A data parts must use mediaType application/json.",
        `${partPath}.mediaType`
      );
    }

    return {
      ok: true,
      part
    };
  }

  return reject(
    "missing_data_part",
    400,
    "A2A SendMessage must contain a data part.",
    "body.message.parts"
  );
}

function reject(
  code: string,
  status: A2aProtocolError["status"],
  message: string,
  path: string
): { ok: false; error: A2aProtocolError } {
  return {
    ok: false,
    error: {
      code,
      status,
      message,
      path
    }
  };
}

function getHeader(headers: Record<string, string | undefined>, name: string): string | undefined {
  for (const [headerName, headerValue] of Object.entries(headers)) {
    if (headerName.toLowerCase() === name && headerValue !== undefined) {
      const trimmedValue = headerValue.trim();
      return trimmedValue.length > 0 ? trimmedValue : undefined;
    }
  }

  return undefined;
}

function isAllowedContentType(contentType: string, allowedContentTypes: readonly string[]): boolean {
  const mediaType = contentType.split(";", 1)[0] ?? "";
  return allowedContentTypes.some(
    (allowedContentType) => mediaType.trim().toLowerCase() === allowedContentType.toLowerCase()
  );
}

function formatAllowedContentTypes(allowedContentTypes: readonly string[]): string {
  return allowedContentTypes.join(", ");
}

function headerListContains(value: string | undefined, expectedValue: string): boolean {
  if (value === undefined) {
    return false;
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .includes(expectedValue);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonRpcLikeBody(body: Record<string, unknown>): boolean {
  return (
    Object.hasOwn(body, "jsonrpc") ||
    Object.hasOwn(body, "method") ||
    Object.hasOwn(body, "params")
  );
}
