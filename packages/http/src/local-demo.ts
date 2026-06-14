import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server } from "node:http";
import {
  buildAgentCard,
  gateA2aSubmissionProtocol,
  generateEncryptedEnvelopeSchema,
  generatePlaintextPayloadSchema,
  InMemoryRequestVersionRepository,
  watasuA2aHttpJsonContentType,
  type PublishedRequestVersion,
  type RequestDefinition
} from "@watasu/core";

export const localDemoRequestId = "event-attendee-intake";
export const localDemoSubmitPath = "/submit";

export interface LocalDemoRequest {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  body: string;
}

export interface LocalDemoResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface LocalDemoApp {
  readonly published: PublishedRequestVersion;
  handle(request: LocalDemoRequest): Promise<LocalDemoResponse>;
}

export function createLocalDemoApp(input: { baseUrl: string }): LocalDemoApp {
  const published = publishFixtureRequest();

  return {
    published,
    async handle(request) {
      if (request.method === "GET" && request.path === "/.well-known/agent-card.json") {
        return jsonResponse(200, buildAgentCard({
          published,
          endpointUrl: `${input.baseUrl}${localDemoSubmitPath}`
        }));
      }

      if (request.method === "GET" && request.path === "/schemas/plaintext.json") {
        return jsonResponse(200, generatePlaintextPayloadSchema(published.definition));
      }

      if (request.method === "GET" && request.path === "/schemas/envelope.json") {
        return jsonResponse(
          200,
          generateEncryptedEnvelopeSchema(published.definition, published.hashes)
        );
      }

      if (request.method === "POST" && request.path === localDemoSubmitPath) {
        return handleSubmit(request);
      }

      return jsonResponse(404, {
        ok: false,
        error: {
          code: "not_found",
          message: "Local demo route was not found."
        }
      });
    }
  };
}

export function createLocalDemoServer(app: LocalDemoApp): Server {
  return createServer(async (request, response) => {
    const handled = await app.handle({
      method: request.method ?? "GET",
      path: request.url === undefined ? "/" : new URL(request.url, "http://localhost").pathname,
      headers: normalizeHeaders(request.headers),
      body: await readRequestBody(request)
    });

    response.writeHead(handled.status, handled.headers);
    response.end(handled.body);
  });
}

async function handleSubmit(request: LocalDemoRequest): Promise<LocalDemoResponse> {
  const headerGateResult = gateA2aSubmissionProtocol({
    headers: request.headers,
    body: {}
  });

  if (!headerGateResult.ok && headerGateResult.error.path.startsWith("headers.")) {
    return protocolErrorResponse(headerGateResult.error);
  }

  const parsedBody = parseJsonBody(request.body);
  if (!parsedBody.ok) {
    return jsonResponse(400, {
      ok: false,
      error: {
        code: "invalid_json",
        message: "Request body must be valid JSON.",
        path: "body"
      }
    });
  }

  const gateResult = gateA2aSubmissionProtocol({
    headers: request.headers,
    body: parsedBody.value
  });

  if (!gateResult.ok) {
    return protocolErrorResponse(gateResult.error);
  }

  return jsonResponse(202, {
    ok: true,
    status: "protocol_accepted"
  });
}

function protocolErrorResponse(error: {
  status: number;
  code: string;
  message: string;
  path: string;
}): LocalDemoResponse {
  return jsonResponse(error.status, {
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      path: error.path
    }
  });
}

function publishFixtureRequest(): PublishedRequestVersion {
  const repository = new InMemoryRequestVersionRepository();

  return repository.publish(localDemoRequestId, localDemoDefinition);
}

const localDemoDefinition: RequestDefinition = {
  name: "event-attendee-intake",
  schema_version: "2026-06-14",
  description: "Collect attendee details for ExampleConf.",
  fields: [
    {
      id: "full_name",
      type: "string",
      required: true,
      purpose: "Confirm attendees at reception.",
      sensitivity: "low"
    },
    {
      id: "email",
      type: "string",
      format: "email",
      required: true,
      purpose: "Send event updates.",
      sensitivity: "low"
    }
  ],
  consent: {
    text: "ExampleConf uses this information only for event operations."
  },
  destination: {
    type: "webhook",
    url: "http://localhost:8787/watasu/intake"
  },
  retention: {
    destination_policy: "Delete within 30 days after the event."
  },
  encryption: {
    mode: "required",
    algorithm: "JWE",
    key_management: "ECDH-ES+A256KW",
    content_encryption: "A256GCM",
    service_key_id: "jwk-thumbprint:sha256:local-demo",
    public_key_jwk: {
      kty: "EC",
      crv: "P-256",
      x: "base64url-x",
      y: "base64url-y"
    }
  },
  metadata_retention: {
    days: 90
  },
  trust_profile: "local_demo"
};

function parseJsonBody(body: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: body.length === 0 ? {} : JSON.parse(body) };
  } catch {
    return { ok: false };
  }
}

function normalizeHeaders(headers: IncomingHttpHeaders): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      Array.isArray(value) ? value.join(", ") : value
    ])
  );
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
}

function jsonResponse(status: number, value: unknown): LocalDemoResponse {
  return {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8"
    },
    body: `${JSON.stringify(value)}\n`
  };
}

export { watasuA2aHttpJsonContentType };
