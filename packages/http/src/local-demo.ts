import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server } from "node:http";
import {
  buildAgentCard,
  createPolicyControlledDeliveryLedger,
  deliverAcceptedSubmission,
  gateA2aSubmissionProtocol,
  generateEncryptedEnvelopeSchema,
  generatePlaintextPayloadSchema,
  InMemoryIdempotencyStore,
  InMemoryRequestVersionRepository,
  InMemorySubmissionRateLimiter,
  validateSubmissionEnvelope,
  watasuA2aHttpJsonContentType,
  type DeliveryClient,
  type DeliveryCircuitBreaker,
  type DeliveryConcurrencyLimiter,
  type DeliveryLedger,
  type DeliveryLedgerRow,
  type PersistentDeliveryLedgerStore,
  type PublishedRequestVersion,
  type RequestDefinition,
  type StoragePolicy,
  type SubmissionEnvelope
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

export interface CreateLocalDemoAppInput {
  baseUrl: string;
  deliveryClient?: DeliveryClient | undefined;
  clock?: (() => Date) | undefined;
  signingSecret?: string | undefined;
  storagePolicy?: StoragePolicy | undefined;
  persistentLedgerStore?: PersistentDeliveryLedgerStore | undefined;
  deliveryCircuitBreaker?: DeliveryCircuitBreaker | undefined;
  deliveryConcurrencyLimiter?: DeliveryConcurrencyLimiter | undefined;
  tenantId?: string | undefined;
}

export function createLocalDemoApp(input: CreateLocalDemoAppInput): LocalDemoApp {
  const published = publishFixtureRequest();
  const clock = input.clock ?? (() => new Date());
  const deliveryClient = input.deliveryClient ?? createNoopDeliveryClient();
  const ledgerRows: DeliveryLedgerRow[] = [];
  const operationalLedger: DeliveryLedger = {
    writeDeliveryAttempt(row) {
      ledgerRows.push(row);
    }
  };
  const ledger = createPolicyControlledDeliveryLedger({
    policy: input.storagePolicy ?? {
      mode: "stateless_default"
    },
    operationalLedger,
    persistentStore: input.persistentLedgerStore
  });
  const idempotencyStore = new InMemoryIdempotencyStore();
  const rateLimiter = new InMemorySubmissionRateLimiter({
    limit: 60,
    windowMs: 60_000,
    clock
  });

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

      if (request.method === "GET" && request.path === "/ledger") {
        return jsonResponse(200, {
          ok: true,
          ledger: ledgerRows
        });
      }

      if (request.method === "POST" && request.path === localDemoSubmitPath) {
        return handleSubmit(request, {
          published,
          capabilityUrl: `${input.baseUrl}/capabilities/local-demo`,
          deliveryClient,
          ledger,
          idempotencyStore,
          rateLimiter,
          clock,
          signingSecret: input.signingSecret ?? "local-demo-signing-secret",
          deliveryCircuitBreaker: input.deliveryCircuitBreaker,
          deliveryConcurrencyLimiter: input.deliveryConcurrencyLimiter,
          tenantId: input.tenantId
        });
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

async function handleSubmit(
  request: LocalDemoRequest,
  context: {
    published: PublishedRequestVersion;
    capabilityUrl: string;
    deliveryClient: DeliveryClient;
    ledger: DeliveryLedger;
    idempotencyStore: InMemoryIdempotencyStore;
    rateLimiter: InMemorySubmissionRateLimiter;
    clock: () => Date;
    signingSecret: string;
    deliveryCircuitBreaker?: DeliveryCircuitBreaker | undefined;
    deliveryConcurrencyLimiter?: DeliveryConcurrencyLimiter | undefined;
    tenantId?: string | undefined;
  }
): Promise<LocalDemoResponse> {
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

  if (!isSubmissionEnvelope(gateResult.envelopeCandidate)) {
    return jsonResponse(400, {
      ok: false,
      error: {
        code: "invalid_envelope",
        message: "A2A data part must contain a watasu encrypted submission envelope.",
        path: "body.message.parts[0].data"
      }
    });
  }

  const validationResult = validateSubmissionEnvelope(gateResult.envelopeCandidate, {
    published: context.published,
    capability: {
      url: context.capabilityUrl,
      revoked: false
    },
    idempotencyStore: context.idempotencyStore,
    rateLimiter: context.rateLimiter,
    clock: context.clock
  });

  if (!validationResult.ok) {
    return jsonResponse(validationResult.status === "auth_required" ? 401 : 400, {
      ok: false,
      status: validationResult.status,
      error: validationResult.error
    });
  }

  const deliveryResult = await deliverAcceptedSubmission({
    mode: "local_demo",
    published: context.published,
    envelope: gateResult.envelopeCandidate,
    submission: validationResult.submission,
    client: context.deliveryClient,
    ledger: context.ledger,
    clock: context.clock,
    signingSecret: context.signingSecret,
    circuitBreaker: context.deliveryCircuitBreaker,
    concurrencyLimiter: context.deliveryConcurrencyLimiter,
    tenantId: context.tenantId
  });

  if (!deliveryResult.ok) {
    if (deliveryResult.status === "resubmit_later") {
      context.idempotencyStore.releaseValidation(
        `${validationResult.submission.request_id}:${validationResult.submission.request_version}:${validationResult.submission.idempotency_key}`
      );
    }

    return jsonResponse(
      deliveryResult.status === "resubmit_later" ? 503 : 400,
      {
        ok: false,
        status: deliveryResult.status,
        error: deliveryResult.error,
        resubmission: deliveryResult.resubmission,
        ledger: deliveryResult.ledger
      },
      deliveryResult.resubmission === undefined
        ? {}
        : {
            "retry-after": String(deliveryResult.resubmission.retry_after_seconds)
          }
    );
  }

  return jsonResponse(202, {
    ok: true,
    status: deliveryResult.status,
    ledger: deliveryResult.ledger
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
      x: "TiZ60tQ0Se3zeQGt6T98XN5abLKOS1fjOJu1ea-xHnU",
      y: "p7AD2mCWCUYJGBLkcA-lc3A46USGO147crX12i1lLrA"
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

function jsonResponse(
  status: number,
  value: unknown,
  headers: Record<string, string> = {}
): LocalDemoResponse {
  return {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers
    },
    body: `${JSON.stringify(value)}\n`
  };
}

function createNoopDeliveryClient(): DeliveryClient {
  return {
    async post() {
      return {
        status: 204
      };
    }
  };
}

function isSubmissionEnvelope(value: unknown): value is SubmissionEnvelope {
  return (
    isRecord(value) &&
    typeof value.request_id === "string" &&
    typeof value.request_version === "string" &&
    typeof value.schema_hash === "string" &&
    typeof value.consent_receipt_hash === "string" &&
    typeof value.idempotency_key === "string" &&
    typeof value.submitted_at === "string" &&
    typeof value.service_key_id === "string" &&
    isRecord(value.encrypted_payload) &&
    typeof value.encrypted_payload_hash === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export { watasuA2aHttpJsonContentType };
