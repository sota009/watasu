import { watasuEncryptedIntakeExtensionUri } from "./agent-card.js";

export const watasuA2aProtocolVersion = "1.0";
const jsonContentType = "application/json";
const sendMessageMethod = "message/send";

export interface A2aSubmissionRequest {
  headers: Record<string, string | undefined>;
  body: unknown;
}

export interface A2aProtocolGateOptions {
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
  const contentType = getHeader(request.headers, "content-type");
  if (contentType === undefined) {
    return reject(
      "missing_content_type",
      415,
      "A2A submissions require Content-Type: application/json.",
      "headers.content-type"
    );
  }

  if (!isJsonContentType(contentType)) {
    return reject(
      "unsupported_content_type",
      415,
      "A2A submissions only support Content-Type: application/json.",
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

  if (body.method !== sendMessageMethod) {
    return reject(
      "invalid_send_message_method",
      400,
      "A2A submission body must use method message/send.",
      "body.method"
    );
  }

  const params = body.params;
  if (!isRecord(params)) {
    return reject(
      "invalid_send_message_params",
      400,
      "A2A SendMessage params must be a JSON object.",
      "body.params"
    );
  }

  if (Object.hasOwn(params, "kind")) {
    return reject(
      "legacy_kind_discriminator",
      400,
      "Legacy kind discriminators are not accepted by this A2A protocol gate.",
      "body.params.kind"
    );
  }

  const message = params.message;
  if (!isRecord(message)) {
    return reject(
      "invalid_send_message",
      400,
      "A2A SendMessage params.message must be a JSON object.",
      "body.params.message"
    );
  }

  if (Object.hasOwn(message, "kind")) {
    return reject(
      "legacy_kind_discriminator",
      400,
      "Legacy kind discriminators are not accepted by this A2A protocol gate.",
      "body.params.message.kind"
    );
  }

  const parts = message.parts;
  if (!Array.isArray(parts) || parts.length === 0) {
    return reject(
      "missing_message_parts",
      400,
      "A2A SendMessage must contain at least one message part.",
      "body.params.message.parts"
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
    const partPath = `body.params.message.parts[${index}]`;
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

    if (part.mediaType !== jsonContentType) {
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
    "body.params.message.parts"
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

function isJsonContentType(contentType: string): boolean {
  const mediaType = contentType.split(";", 1)[0] ?? "";
  return mediaType.trim().toLowerCase() === jsonContentType;
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
