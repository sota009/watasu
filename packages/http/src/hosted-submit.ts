import {
  createIdempotencyClaimKey,
  deliverAcceptedSubmission,
  gateA2aSubmissionProtocol,
  sha256Hash,
  validateSubmissionEnvelope,
  validateSubmissionEnvelopeMetadata,
  type DeliveryCircuitBreaker,
  type DeliveryClient,
  type DeliveryConcurrencyLimiter,
  type DeliveryLedger,
  type IdempotencyStore,
  type PublishedRequestVersion,
  type Sha256Hash,
  type SubmissionRateLimiter,
  type SubmissionEnvelope
} from "@watasu/core";
import type {
  HostedSenderTrustResolver,
  HostedSenderTrustResult
} from "./hosted-sender-auth.js";
import { decodeHostedRequestIdSegment } from "./hosted-route.js";

export interface HostedSubmitRequest {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  body: string;
}

export interface HostedSubmitResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface HostedSubmitApp {
  handle(request: HostedSubmitRequest): Promise<HostedSubmitResponse>;
}

export interface CreateHostedSubmitAppInput {
  publicBaseUrl: string;
  requestVersions: {
    list(requestId: string): PublishedRequestVersion[];
  };
  deliveryClient: DeliveryClient;
  ledger: DeliveryLedger;
  idempotencyStore: IdempotencyStore;
  rateLimiter: SubmissionRateLimiter;
  resolveDeliveryHost?: ((hostname: string) => Promise<string[]>) | undefined;
  clock: () => Date;
  signingSecret: string;
  deliveryCircuitBreaker?: DeliveryCircuitBreaker | undefined;
  deliveryConcurrencyLimiter?: DeliveryConcurrencyLimiter | undefined;
  resolveSenderTrust?: HostedSenderTrustResolver | undefined;
  tenantId?: string | undefined;
}

export function createHostedSubmitApp(input: CreateHostedSubmitAppInput): HostedSubmitApp {
  return {
    async handle(request) {
      if (request.method !== "POST") {
        return jsonResponse(404, {
          ok: false,
          error: {
            code: "not_found",
            message: "Hosted submit route was not found."
          }
        });
      }

      const requestId = matchSubmitPath(request.path);
      if (requestId === undefined) {
        return jsonResponse(404, {
          ok: false,
          error: {
            code: "not_found",
            message: "Hosted submit route was not found."
          }
        });
      }

      const published = latestPublishedRequest(input.requestVersions.list(requestId));
      if (published === undefined) {
        return jsonResponse(404, {
          ok: false,
          error: {
            code: "request_version_not_found",
            message: "Published request was not found."
          }
        });
      }

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

      const capabilityUrl = `${input.publicBaseUrl}/requests/${encodeURIComponent(published.request_id)}/submit`;
      const metadataError = validateSubmissionEnvelopeMetadata(gateResult.envelopeCandidate, published);
      if (metadataError !== undefined) {
        return jsonResponse(400, {
          ok: false,
          status: "rejected",
          error: metadataError
        });
      }

      const senderTrust = resolveSenderTrust({
        resolver: input.resolveSenderTrust,
        tenantId: input.tenantId,
        published,
        capabilityHash: hashCapabilityUrl(capabilityUrl),
        envelope: gateResult.envelopeCandidate,
        now: input.clock()
      });
      const validationResult = validateSubmissionEnvelope(gateResult.envelopeCandidate, {
        published,
        capability: {
          url: capabilityUrl,
          revoked: false
        },
        idempotencyStore: input.idempotencyStore,
        rateLimiter: input.rateLimiter,
        clock: input.clock,
        trustedSenderKeyIds: senderTrust.trustedSenderKeyIds,
        trustedSenderPublicKeys: senderTrust.trustedSenderPublicKeys,
        trustedInvites: senderTrust.trustedInvites
      });
      if (!validationResult.ok) {
        return jsonResponse(validationResult.status === "auth_required" ? 401 : 400, {
          ok: false,
          status: validationResult.status,
          error: validationResult.error
        });
      }

      const deliveryResult = await deliverAcceptedSubmission({
        mode: "hosted",
        published,
        envelope: gateResult.envelopeCandidate,
        submission: validationResult.submission,
        client: input.deliveryClient,
        ledger: input.ledger,
        clock: input.clock,
        signingSecret: input.signingSecret,
        resolveDeliveryHost: input.resolveDeliveryHost,
        circuitBreaker: input.deliveryCircuitBreaker,
        concurrencyLimiter: input.deliveryConcurrencyLimiter,
        tenantId: input.tenantId
      });
      if (!deliveryResult.ok) {
        if (deliveryResult.status === "resubmit_later") {
          input.idempotencyStore.releaseValidation(createIdempotencyClaimKey(validationResult.submission));
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
  };
}

function resolveSenderTrust(input: {
  resolver: HostedSenderTrustResolver | undefined;
  tenantId: string | undefined;
  published: PublishedRequestVersion;
  capabilityHash: Sha256Hash;
  envelope: SubmissionEnvelope;
  now: Date;
}): HostedSenderTrustResult {
  if (
    input.resolver === undefined ||
    input.tenantId === undefined ||
    input.published.definition.trust_profile === "public_capability" ||
    input.published.definition.trust_profile === "local_demo"
  ) {
    return {
      trustedSenderKeyIds: [],
      trustedSenderPublicKeys: [],
      trustedInvites: []
    };
  }

  return input.resolver({
    tenantId: input.tenantId,
    requestId: input.published.request_id,
    requestVersion: input.published.request_version,
    capabilityHash: input.capabilityHash,
    senderKeyId: input.envelope.sender_key_id,
    inviteId: input.envelope.invite_id,
    now: input.now
  });
}

function hashCapabilityUrl(capabilityUrl: string): Sha256Hash {
  return sha256Hash(capabilityUrl);
}

function protocolErrorResponse(error: {
  status: number;
  code: string;
  message: string;
  path: string;
}): HostedSubmitResponse {
  return jsonResponse(error.status, {
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      path: error.path
    }
  });
}

function matchSubmitPath(path: string): string | undefined {
  const match = /^\/requests\/([^/]+)\/submit$/.exec(path);
  if (match === null) {
    return undefined;
  }

  return decodeHostedRequestIdSegment(match[1]);
}

function latestPublishedRequest(versions: PublishedRequestVersion[]): PublishedRequestVersion | undefined {
  return versions.at(-1);
}

function parseJsonBody(body: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: body.length === 0 ? {} : JSON.parse(body) };
  } catch {
    return { ok: false };
  }
}

function jsonResponse(
  status: number,
  value: unknown,
  headers: Record<string, string> = {}
): HostedSubmitResponse {
  return {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers
    },
    body: `${JSON.stringify(value)}\n`
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
