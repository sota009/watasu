import { createHmac } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { sha256Hash, type Sha256Hash } from "./hash.js";
import { canonicalizeJson } from "./request-definition.js";
import type { PublishMode } from "./publish.js";
import type { PublishedRequestVersion } from "./request-version.js";
import type {
  AcceptedSubmission,
  SubmissionEnvelope
} from "./submission.js";

export type { AcceptedSubmission, SubmissionEnvelope } from "./submission.js";

export interface DeliveryRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface DeliveryResponse {
  status: number;
  headers?: Record<string, string | undefined> | undefined;
}

export interface DeliveryClient {
  post(request: DeliveryRequest): Promise<DeliveryResponse>;
}

export type DeliveryHostResolver = (hostname: string) => Promise<string[]>;

export type FetchDeliveryClientFetch = (
  input: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
    redirect: "manual";
    signal: AbortSignal;
  }
) => Promise<{
  status: number;
  headers?: {
    get(name: string): string | null;
  } | undefined;
}>;

export interface DeliveryLedger {
  writeDeliveryAttempt(row: DeliveryLedgerRow): void | Promise<void>;
}

export interface DeliveryLogger {
  write(event: DeliveryLogEvent): void;
}

export interface DeliveryCircuitBreaker {
  isOpen(key: string): boolean;
  recordSuccess(key: string): void;
  recordFailure(key: string): void;
}

export interface DeliveryConcurrencyClaim {
  release(): void;
}

export interface DeliveryConcurrencyLimiter {
  tryAcquire(input: {
    requestKey: string;
    tenantKey?: string | undefined;
  }): DeliveryConcurrencyClaim | undefined;
}

export class InMemoryDeliveryConcurrencyLimiter implements DeliveryConcurrencyLimiter {
  readonly #activeByKey = new Map<string, number>();
  readonly #maxPerRequest: number;
  readonly #maxPerTenant: number;

  constructor(input: {
    maxPerRequest: number;
    maxPerTenant: number;
  }) {
    this.#maxPerRequest = input.maxPerRequest;
    this.#maxPerTenant = input.maxPerTenant;
  }

  tryAcquire(input: {
    requestKey: string;
    tenantKey?: string | undefined;
  }): DeliveryConcurrencyClaim | undefined {
    const keys = [
      `request:${input.requestKey}`,
      ...(input.tenantKey === undefined ? [] : [`tenant:${input.tenantKey}`])
    ];
    const requestCount = this.#activeByKey.get(keys[0] ?? "") ?? 0;
    const tenantCount = input.tenantKey === undefined
      ? 0
      : this.#activeByKey.get(`tenant:${input.tenantKey}`) ?? 0;

    if (requestCount >= this.#maxPerRequest || tenantCount >= this.#maxPerTenant) {
      return undefined;
    }

    for (const key of keys) {
      this.#activeByKey.set(key, (this.#activeByKey.get(key) ?? 0) + 1);
    }

    return {
      release: () => {
        for (const key of keys) {
          const nextCount = Math.max(0, (this.#activeByKey.get(key) ?? 0) - 1);
          if (nextCount === 0) {
            this.#activeByKey.delete(key);
          } else {
            this.#activeByKey.set(key, nextCount);
          }
        }
      }
    };
  }
}

export class InMemoryDeliveryCircuitBreaker implements DeliveryCircuitBreaker {
  readonly #statesByKey = new Map<string, {
    failures: number;
    openUntilMs: number | undefined;
  }>();
  readonly #failureThreshold: number;
  readonly #cooldownMs: number;
  readonly #clock: () => Date;

  constructor(input: {
    failureThreshold: number;
    cooldownMs: number;
    clock: () => Date;
  }) {
    this.#failureThreshold = input.failureThreshold;
    this.#cooldownMs = input.cooldownMs;
    this.#clock = input.clock;
  }

  isOpen(key: string): boolean {
    const state = this.#statesByKey.get(key);
    if (state?.openUntilMs === undefined) {
      return false;
    }

    if (state.openUntilMs <= this.#clock().getTime()) {
      this.#statesByKey.set(key, {
        failures: 0,
        openUntilMs: undefined
      });
      return false;
    }

    return true;
  }

  recordSuccess(key: string): void {
    this.#statesByKey.set(key, {
      failures: 0,
      openUntilMs: undefined
    });
  }

  recordFailure(key: string): void {
    const state = this.#statesByKey.get(key) ?? {
      failures: 0,
      openUntilMs: undefined
    };
    const failures = state.failures + 1;

    this.#statesByKey.set(key, {
      failures,
      openUntilMs: failures >= this.#failureThreshold
        ? this.#clock().getTime() + this.#cooldownMs
        : state.openUntilMs
    });
  }
}

export interface DeliveryLedgerRow {
  request_id: string;
  request_version: string;
  idempotency_key: string;
  submitted_at: string;
  delivered_at: string;
  delivery_status: "delivered" | "resubmit_later";
  destination_url_hash: Sha256Hash;
  encrypted_payload_hash: Sha256Hash;
  webhook_status?: number | undefined;
  error_code?: string | undefined;
}

export interface DeliveryLogEvent {
  event: "watasu.delivery_attempt";
  request_id: string;
  request_version: string;
  idempotency_key: string;
  delivery_status: DeliveryLedgerRow["delivery_status"];
  destination_url_hash: Sha256Hash;
  encrypted_payload_hash: Sha256Hash;
  webhook_status?: number | undefined;
  error_code?: string | undefined;
}

export type ResubmissionRetryAfterSource =
  | "webhook_failure"
  | "webhook_timeout"
  | "circuit_breaker"
  | "concurrency_limit";

export interface ResubmissionGuidance {
  action: "resubmit_later";
  retry_after_seconds: number;
  retry_after_source: ResubmissionRetryAfterSource;
  idempotency_key_policy: "reuse_for_same_payload";
  payload_policy: "sender_resubmits_payload";
  refresh_fields: ["submitted_at", "expires_at", "sender_signature"];
}

export type DeliveryResult =
  | {
      ok: true;
      status: "delivered";
      ledger: DeliveryLedgerRow;
    }
  | {
      ok: false;
      status: "rejected" | "resubmit_later";
      error: {
        code: string;
        message: string;
      };
      resubmission?: ResubmissionGuidance | undefined;
      ledger?: DeliveryLedgerRow | undefined;
    };

export function createFetchDeliveryClient(input: {
  fetch?: FetchDeliveryClientFetch | undefined;
  timeoutMs?: number | undefined;
} = {}): DeliveryClient {
  const fetchImplementation = input.fetch ?? fetch;
  const timeoutMs = input.timeoutMs ?? 5_000;

  return {
    async post(request) {
      const abortController = new AbortController();
      const timeout = setTimeout(() => abortController.abort(), timeoutMs);

      try {
        const response = await fetchImplementation(request.url, {
          method: "POST",
          headers: request.headers,
          body: request.body,
          redirect: "manual",
          signal: abortController.signal
        });

        const location = response.headers?.get("location") ?? undefined;
        return {
          status: response.status,
          ...(location === undefined
            ? {}
            : {
                headers: {
                  location
                }
              })
        };
      } finally {
        clearTimeout(timeout);
      }
    }
  };
}

export async function deliverAcceptedSubmission(input: {
  mode: PublishMode;
  published: PublishedRequestVersion;
  envelope: SubmissionEnvelope;
  submission: AcceptedSubmission;
  client: DeliveryClient;
  ledger: DeliveryLedger;
  logger?: DeliveryLogger | undefined;
  circuitBreaker?: DeliveryCircuitBreaker | undefined;
  concurrencyLimiter?: DeliveryConcurrencyLimiter | undefined;
  resolveDeliveryHost?: DeliveryHostResolver | undefined;
  tenantId?: string | undefined;
  clock: () => Date;
  signingSecret: string;
}): Promise<DeliveryResult> {
  const destinationUrl = new URL(input.published.definition.destination.url);
  const urlError = await validateDeliveryUrl({
    destinationUrl,
    mode: input.mode,
    resolveDeliveryHost: input.resolveDeliveryHost
  });
  if (urlError !== undefined) {
    return {
      ok: false,
      status: "rejected",
      error: urlError
    };
  }

  const deliveredAt = input.clock().toISOString();
  const circuitBreakerKey = deliveryCircuitBreakerKey(input.published);
  const concurrencyClaim = input.concurrencyLimiter?.tryAcquire({
    requestKey: circuitBreakerKey,
    tenantKey: input.tenantId
  });
  if (input.concurrencyLimiter !== undefined && concurrencyClaim === undefined) {
    const ledgerRow = createLedgerRow(
      input,
      deliveredAt,
      "resubmit_later",
      undefined,
      "delivery_concurrency_limited"
    );
    await input.ledger.writeDeliveryAttempt(ledgerRow);
    writeDeliveryLog(input.logger, ledgerRow);
    return resubmitLater(
      "delivery_concurrency_limited",
      "Delivery concurrency limit was reached.",
      ledgerRow
    );
  }

  if (input.circuitBreaker?.isOpen(circuitBreakerKey)) {
    const ledgerRow = createLedgerRow(
      input,
      deliveredAt,
      "resubmit_later",
      undefined,
      "webhook_circuit_open"
    );
    await input.ledger.writeDeliveryAttempt(ledgerRow);
    writeDeliveryLog(input.logger, ledgerRow);
    concurrencyClaim?.release();
    return resubmitLater("webhook_circuit_open", "Webhook delivery circuit is open.", ledgerRow);
  }

  const body = buildDeliveryBody(input.envelope);
  const headers = buildDeliveryHeaders({
    body,
    deliveredAt,
    signingSecret: input.signingSecret,
    submission: input.submission
  });

  try {
    let response = await input.client.post({
      url: destinationUrl.toString(),
      headers,
      body
    });

    const redirectResult = await resolveDeliveryRedirect({
      mode: input.mode,
      originalUrl: destinationUrl,
      response,
      resolveDeliveryHost: input.resolveDeliveryHost
    });
    if (!redirectResult.ok) {
      concurrencyClaim?.release();
      return {
        ok: false,
        status: "rejected",
        error: redirectResult.error
      };
    }
    if (redirectResult.redirectUrl !== undefined) {
      response = await input.client.post({
        url: redirectResult.redirectUrl.toString(),
        headers,
        body
      });
    }

    if (response.status >= 200 && response.status < 300) {
      const ledgerRow = createLedgerRow(input, deliveredAt, "delivered", response.status);
      await input.ledger.writeDeliveryAttempt(ledgerRow);
      writeDeliveryLog(input.logger, ledgerRow);
      input.circuitBreaker?.recordSuccess(circuitBreakerKey);
      concurrencyClaim?.release();
      return {
        ok: true,
        status: "delivered",
        ledger: ledgerRow
      };
    }

    const ledgerRow = createLedgerRow(
      input,
      deliveredAt,
      "resubmit_later",
      response.status,
      "webhook_delivery_failed"
    );
    await input.ledger.writeDeliveryAttempt(ledgerRow);
    writeDeliveryLog(input.logger, ledgerRow);
    input.circuitBreaker?.recordFailure(circuitBreakerKey);
    concurrencyClaim?.release();
    return resubmitLater("webhook_delivery_failed", "Webhook delivery did not return 2xx.", ledgerRow);
  } catch (error) {
    const errorCode = isAbortError(error)
      ? "webhook_delivery_timeout"
      : "webhook_delivery_failed";
    const message = isAbortError(error)
      ? "Webhook delivery timed out."
      : "Webhook delivery could not be completed.";
    const ledgerRow = createLedgerRow(
      input,
      deliveredAt,
      "resubmit_later",
      undefined,
      errorCode
    );
    await input.ledger.writeDeliveryAttempt(ledgerRow);
    writeDeliveryLog(input.logger, ledgerRow);
    input.circuitBreaker?.recordFailure(circuitBreakerKey);
    concurrencyClaim?.release();
    return resubmitLater(errorCode, message, ledgerRow);
  }
}

type DeliveryRedirectResolution =
  | {
      ok: true;
      redirectUrl?: URL | undefined;
    }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
      };
    };

async function resolveDeliveryRedirect(input: {
  mode: PublishMode;
  originalUrl: URL;
  response: DeliveryResponse;
  resolveDeliveryHost: DeliveryHostResolver | undefined;
}): Promise<DeliveryRedirectResolution> {
  if (input.mode !== "hosted" || input.response.status < 300 || input.response.status >= 400) {
    return {
      ok: true
    };
  }

  const location = input.response.headers?.location;
  if (location === undefined || location.trim().length === 0) {
    return {
      ok: true
    };
  }

  let redirectUrl: URL;
  try {
    redirectUrl = new URL(location, input.originalUrl);
  } catch {
    return {
      ok: false,
      error: {
        code: "unsafe_delivery_redirect",
        message: "Hosted delivery redirect target was invalid."
      }
    };
  }

  const redirectUrlError = await validateDeliveryUrl({
    destinationUrl: redirectUrl,
    mode: input.mode,
    resolveDeliveryHost: input.resolveDeliveryHost
  });
  if (redirectUrlError !== undefined) {
    return {
      ok: false,
      error: {
        code: "unsafe_delivery_redirect",
        message: "Hosted delivery redirect target failed SSRF safety checks."
      }
    };
  }

  return {
    ok: true,
    redirectUrl
  };
}

function buildDeliveryBody(envelope: SubmissionEnvelope): string {
  return canonicalizeJson({
    envelope
  });
}

function buildDeliveryHeaders(input: {
  body: string;
  deliveredAt: string;
  signingSecret: string;
  submission: AcceptedSubmission;
}): Record<string, string> {
  const bodyDigest = sha256Hash(input.body);
  const signaturePayload = [
    input.deliveredAt,
    bodyDigest,
    input.submission.request_id,
    input.submission.request_version,
    input.submission.idempotency_key
  ].join("\n");
  const signature = createHmac("sha256", input.signingSecret)
    .update(signaturePayload)
    .digest("base64url");

  return {
    "content-type": "application/json",
    "x-watasu-request-id": input.submission.request_id,
    "x-watasu-request-version": input.submission.request_version,
    "x-watasu-idempotency-key": input.submission.idempotency_key,
    "x-watasu-timestamp": input.deliveredAt,
    "x-watasu-body-digest": bodyDigest,
    "x-watasu-signature": `sha256=${signature}`
  };
}

function createLedgerRow(
  input: {
    published: PublishedRequestVersion;
    envelope: SubmissionEnvelope;
    submission: AcceptedSubmission;
  },
  deliveredAt: string,
  deliveryStatus: DeliveryLedgerRow["delivery_status"],
  webhookStatus?: number | undefined,
  errorCode?: string | undefined
): DeliveryLedgerRow {
  return {
    request_id: input.submission.request_id,
    request_version: input.submission.request_version,
    idempotency_key: input.submission.idempotency_key,
    submitted_at: input.submission.submitted_at,
    delivered_at: deliveredAt,
    delivery_status: deliveryStatus,
    destination_url_hash: sha256Hash(input.published.definition.destination.url),
    encrypted_payload_hash: input.envelope.encrypted_payload_hash as Sha256Hash,
    webhook_status: webhookStatus,
    error_code: errorCode
  };
}

async function validateDeliveryUrl(input: {
  destinationUrl: URL;
  mode: PublishMode;
  resolveDeliveryHost: DeliveryHostResolver | undefined;
}): Promise<{ code: string; message: string } | undefined> {
  const { destinationUrl, mode } = input;
  if (mode === "hosted" && destinationUrl.protocol !== "https:") {
    return {
      code: "unsafe_delivery_url",
      message: "Hosted delivery requires an HTTPS webhook URL."
    };
  }

  if (mode === "hosted" && isPrivateOrMetadataHost(destinationUrl.hostname)) {
    return {
      code: "unsafe_delivery_url",
      message: "Hosted delivery cannot target private network or metadata service hosts."
    };
  }

  if (mode === "hosted") {
    const resolveDeliveryHost = input.resolveDeliveryHost ?? resolvePublicDeliveryHost;
    let addresses: string[];
    try {
      addresses = await resolveDeliveryHost(destinationUrl.hostname);
    } catch {
      return {
        code: "delivery_host_resolution_failed",
        message: "Hosted delivery destination could not be resolved."
      };
    }

    if (addresses.length === 0 || addresses.some(isPrivateOrMetadataHost)) {
      return {
        code: "unsafe_delivery_host",
        message: "Hosted delivery destination resolved to a private network or metadata service address."
      };
    }
  }

  return undefined;
}

async function resolvePublicDeliveryHost(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, {
    all: true
  });
  return records.map((record) => record.address);
}

function isPrivateOrMetadataHost(hostname: string): boolean {
  const normalizedHost = hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  if (normalizedHost === "localhost") {
    return true;
  }

  const ipVersion = isIP(normalizedHost);
  if (ipVersion === 0) {
    return false;
  }

  if (ipVersion === 6) {
    return normalizedHost === "::1" ||
      normalizedHost.startsWith("fc") ||
      normalizedHost.startsWith("fd") ||
      normalizedHost.startsWith("fe80:");
  }

  const [first = 0, second = 0] = normalizedHost.split(".").map((part) => Number(part));
  return (
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    first === 0
  );
}

function resubmitLater(
  code: string,
  message: string,
  ledger: DeliveryLedgerRow
): DeliveryResult {
  return {
    ok: false,
    status: "resubmit_later",
    error: {
      code,
      message
    },
    resubmission: buildResubmissionGuidance(code),
    ledger
  };
}

function buildResubmissionGuidance(errorCode: string): ResubmissionGuidance {
  return {
    action: "resubmit_later",
    retry_after_seconds: retryAfterSeconds(errorCode),
    retry_after_source: retryAfterSource(errorCode),
    idempotency_key_policy: "reuse_for_same_payload",
    payload_policy: "sender_resubmits_payload",
    refresh_fields: ["submitted_at", "expires_at", "sender_signature"]
  };
}

function retryAfterSeconds(errorCode: string): number {
  switch (errorCode) {
    case "delivery_concurrency_limited":
      return 10;
    case "webhook_delivery_timeout":
      return 30;
    case "webhook_circuit_open":
      return 120;
    case "webhook_delivery_failed":
    default:
      return 60;
  }
}

function retryAfterSource(errorCode: string): ResubmissionRetryAfterSource {
  switch (errorCode) {
    case "delivery_concurrency_limited":
      return "concurrency_limit";
    case "webhook_delivery_timeout":
      return "webhook_timeout";
    case "webhook_circuit_open":
      return "circuit_breaker";
    case "webhook_delivery_failed":
    default:
      return "webhook_failure";
  }
}

function writeDeliveryLog(
  logger: DeliveryLogger | undefined,
  row: DeliveryLedgerRow
): void {
  logger?.write({
    event: "watasu.delivery_attempt",
    request_id: row.request_id,
    request_version: row.request_version,
    idempotency_key: row.idempotency_key,
    delivery_status: row.delivery_status,
    destination_url_hash: row.destination_url_hash,
    encrypted_payload_hash: row.encrypted_payload_hash,
    webhook_status: row.webhook_status,
    error_code: row.error_code
  });
}

function deliveryCircuitBreakerKey(published: PublishedRequestVersion): string {
  return `${published.request_id}:${published.request_version}`;
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException && error.name === "AbortError"
  ) || (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name: unknown }).name === "AbortError"
  );
}
