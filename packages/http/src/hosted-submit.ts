import {
  createIdempotencyClaimKey,
  deliverAcceptedSubmission,
  gateA2aSubmissionProtocol,
  mintConsentToken,
  sha256Hash,
  validateSubmissionEnvelopeAsync,
  validateSubmissionEnvelopeMetadata,
  verifyConsentReceipt,
  type AsyncIdempotencyStore,
  type AsyncSubmissionRateLimiter,
  type DeliveryCircuitBreaker,
  type DeliveryClient,
  type DeliveryConcurrencyLimiter,
  type DeliveryLedger,
  type PublishedRequestVersion,
  type Sha256Hash,
  type SubmissionCapability,
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

export interface HostedRequestVersionReader {
  list(requestId: string): PublishedRequestVersion[] | Promise<PublishedRequestVersion[]>;
}

export interface CreateHostedSubmitAppInput {
  publicBaseUrl: string;
  requestVersions: HostedRequestVersionReader;
  deliveryClient: DeliveryClient;
  ledger: DeliveryLedger;
  idempotencyStore: AsyncIdempotencyStore;
  rateLimiter: AsyncSubmissionRateLimiter;
  resolveDeliveryHost?: ((hostname: string) => Promise<string[]>) | undefined;
  clock: () => Date;
  signingSecret: string;
  deliveryCircuitBreaker?: DeliveryCircuitBreaker | undefined;
  deliveryConcurrencyLimiter?: DeliveryConcurrencyLimiter | undefined;
  resolveSenderTrust?: HostedSenderTrustResolver | undefined;
  resolveCapability?: ((input: {
    capabilityUrl: string;
    published: PublishedRequestVersion;
    tenantId?: string | undefined;
  }) => SubmissionCapability | Promise<SubmissionCapability>) | undefined;
  tenantId?: string | undefined;
  resolveTenantId?: ((input: {
    request: HostedSubmitRequest;
    published: PublishedRequestVersion;
  }) => string | undefined) | undefined;
  /** TTL for a minted consent token (human_consent trust profile). */
  consentTtlSeconds?: number | undefined;
}

const defaultConsentTtlSeconds = 10 * 60;

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

      const published = latestPublishedRequest(await input.requestVersions.list(requestId));
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

      const tenantId = input.tenantId ?? input.resolveTenantId?.({
        request,
        published
      });
      const senderTrust = resolveSenderTrust({
        resolver: input.resolveSenderTrust,
        tenantId,
        published,
        capabilityHash: hashCapabilityUrl(capabilityUrl),
        envelope: gateResult.envelopeCandidate,
        now: input.clock()
      });
      const capability = await resolveCapability({
        resolver: input.resolveCapability,
        capabilityUrl,
        published,
        tenantId
      });
      const validationResult = await validateSubmissionEnvelopeAsync(gateResult.envelopeCandidate, {
        published,
        capability,
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

      if (published.definition.trust_profile === "human_consent") {
        const consentGate = await evaluateConsentGate({
          envelope: gateResult.envelopeCandidate,
          published,
          tenantId,
          secret: input.signingSecret,
          idempotencyStore: input.idempotencyStore,
          now: input.clock(),
          publicBaseUrl: input.publicBaseUrl,
          consentTtlSeconds: input.consentTtlSeconds ?? defaultConsentTtlSeconds
        });
        if (!consentGate.ok) {
          // Release the submission validation claim so the resume (same
          // idempotency_key) is not rejected as a replay after the human approves.
          await input.idempotencyStore.releaseValidation(createIdempotencyClaimKey(validationResult.submission));
          return consentGate.response;
        }
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
        tenantId
      });
      if (!deliveryResult.ok) {
        if (deliveryResult.status === "resubmit_later") {
          await input.idempotencyStore.releaseValidation(
            createIdempotencyClaimKey(validationResult.submission)
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
  };
}

async function resolveCapability(input: {
  resolver: CreateHostedSubmitAppInput["resolveCapability"];
  capabilityUrl: string;
  published: PublishedRequestVersion;
  tenantId?: string | undefined;
}): Promise<SubmissionCapability> {
  const resolved = await input.resolver?.({
    capabilityUrl: input.capabilityUrl,
    published: input.published,
    tenantId: input.tenantId
  });

  return resolved ?? {
    url: input.capabilityUrl,
    revoked: false
  };
}

async function evaluateConsentGate(input: {
  envelope: SubmissionEnvelope;
  published: PublishedRequestVersion;
  tenantId: string | undefined;
  secret: string;
  idempotencyStore: AsyncIdempotencyStore;
  now: Date;
  publicBaseUrl: string;
  consentTtlSeconds: number;
}): Promise<{ ok: true } | { ok: false; response: HostedSubmitResponse }> {
  const envelopeHash = input.envelope.encrypted_payload_hash;
  const consentTextHash = input.published.hashes.consent_text_hash;
  const receiptToken = input.envelope.consent_receipt_token;

  if (receiptToken !== undefined) {
    const verified = await verifyConsentReceipt(receiptToken, input.secret, input.now);
    if (
      verified.ok &&
      verified.receipt.envelope_hash === envelopeHash &&
      verified.receipt.consent_text_hash === consentTextHash
    ) {
      const claimed = await input.idempotencyStore.claimValidation(
        `consent-receipt:${verified.receipt.nonce}`,
        {
          request_id: input.envelope.request_id,
          request_version: input.envelope.request_version,
          idempotency_key: input.envelope.idempotency_key,
          submitted_at: input.envelope.submitted_at,
          claimed_at: input.now.toISOString(),
          status: "validation_accepted"
        }
      );
      if (claimed) {
        // Valid, payload-bound, unspent receipt: fall through to delivery.
        return { ok: true };
      }
    }
  }

  // No valid receipt: pause the agent with a fresh consent token.
  const minted = await mintConsentToken(
    {
      tenant_id: input.tenantId ?? "",
      request_id: input.published.request_id,
      request_version: input.published.request_version,
      idempotency_key: input.envelope.idempotency_key,
      envelope_hash: envelopeHash,
      consent_text_hash: consentTextHash,
      issued_at: input.now,
      ttl_seconds: input.consentTtlSeconds
    },
    input.secret
  );

  const requestIdSegment = encodeURIComponent(input.published.request_id);
  const consentBase = `${input.publicBaseUrl}/requests/${requestIdSegment}/consent/${minted.token}`;
  return {
    ok: false,
    response: jsonResponse(401, {
      ok: false,
      status: "auth_required",
      consent: {
        consent_url: consentBase,
        poll_url: `${consentBase}/status`,
        expires_in: minted.expires_in_seconds
      }
    })
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
    typeof value.encrypted_payload_hash === "string" &&
    (value.consent_receipt_token === undefined || typeof value.consent_receipt_token === "string")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
