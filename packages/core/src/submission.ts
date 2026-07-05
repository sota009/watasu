import { sha256Hash, type Sha256Hash } from "./hash.js";
import { canonicalizeJson } from "./request-definition.js";
import type { PublishedRequestVersion } from "./request-version.js";

const defaultMaxSubmissionAgeMs = 15 * 60 * 1000;
const defaultMaxSubmissionClockSkewMs = 5 * 60 * 1000;

export interface SubmissionEnvelope {
  request_id: string;
  request_version: string;
  schema_hash: string;
  /**
   * Minimal terms echo: must equal the published `consent_text_hash`. This
   * only pins the envelope to the current consent text — it is NOT consent
   * evidence. Enforceable, human-attributed consent for personal data lives
   * solely in `consent_receipt_token` (the signed runtime gate, §13).
   */
  consent_receipt_hash: string;
  idempotency_key: string;
  submitted_at: string;
  service_key_id: string;
  encrypted_payload: Record<string, unknown>;
  encrypted_payload_hash: string;
  /**
   * Compact JWS consent receipt token presented on resume for the
   * `human_consent` runtime gate. This is the SOLE consent mechanism (§13):
   * the passkey signature it records binds the payload to the exact
   * consent-text / field-purposes / destination-policy hashes, proving both
   * "a human consented" and "consent was to the exact terms." Absent on the
   * first (pausing) submission.
   */
  consent_receipt_token?: string | undefined;
}

export interface SubmissionCapability {
  url: string;
  revoked: boolean;
}

export type CapabilityStatus = "active" | "revoked";

export interface CapabilityRecord {
  request_id: string;
  request_version: string;
  capability_hash: Sha256Hash;
  status: CapabilityStatus;
  issued_at: string;
  revoked_at?: string | undefined;
}

export interface IdempotencyStore {
  claimValidation(recordKey: string, claim: IdempotencyValidationClaim): boolean;
  releaseValidation(recordKey: string): void;
}

export interface SubmissionRateLimiter {
  consume(key: string): boolean;
}

type MaybePromise<T> = T | Promise<T>;

export interface AsyncIdempotencyStore {
  claimValidation(recordKey: string, claim: IdempotencyValidationClaim): MaybePromise<boolean>;
  releaseValidation(recordKey: string): MaybePromise<void>;
}

export interface AsyncSubmissionRateLimiter {
  consume(key: string): MaybePromise<boolean>;
}

export interface IdempotencyValidationClaim {
  request_id: string;
  request_version: string;
  idempotency_key: string;
  submitted_at: string;
  claimed_at: string;
  status: "validation_accepted";
}

export interface SubmissionValidationContext {
  published: PublishedRequestVersion;
  capability: SubmissionCapability;
  idempotencyStore: IdempotencyStore;
  rateLimiter: SubmissionRateLimiter;
  clock: () => Date;
  maxSubmissionAgeMs?: number | undefined;
}

export interface AsyncSubmissionValidationContext extends Omit<
  SubmissionValidationContext,
  "idempotencyStore" | "rateLimiter"
> {
  idempotencyStore: AsyncIdempotencyStore;
  rateLimiter: AsyncSubmissionRateLimiter;
}

export type SubmissionValidationResult =
  | {
      ok: true;
      status: "accepted";
      submission: AcceptedSubmission;
    }
  | {
      ok: false;
      status: "rejected";
      error: SubmissionValidationError;
    };

export interface AcceptedSubmission {
  request_id: string;
  request_version: string;
  idempotency_key: string;
  submitted_at: string;
  accepted_at: string;
  capability_hash: Sha256Hash;
}

export interface SubmissionValidationError {
  code: string;
  message: string;
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  readonly #validationClaims = new Map<string, IdempotencyValidationClaim>();

  claimValidation(recordKey: string, claim: IdempotencyValidationClaim): boolean {
    if (this.#validationClaims.has(recordKey)) {
      return false;
    }

    this.#validationClaims.set(recordKey, structuredClone(claim));
    return true;
  }

  releaseValidation(recordKey: string): void {
    this.#validationClaims.delete(recordKey);
  }

  has(recordKey: string): boolean {
    return this.#validationClaims.has(recordKey);
  }

  getValidationClaim(recordKey: string): IdempotencyValidationClaim | undefined {
    const claim = this.#validationClaims.get(recordKey);
    return claim === undefined ? undefined : structuredClone(claim);
  }
}

export class InMemorySubmissionRateLimiter implements SubmissionRateLimiter {
  readonly #hitsByKey = new Map<string, number[]>();
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #clock: () => Date;

  constructor(input: { limit: number; windowMs: number; clock: () => Date }) {
    this.#limit = input.limit;
    this.#windowMs = input.windowMs;
    this.#clock = input.clock;
  }

  consume(key: string): boolean {
    const nowMs = this.#clock().getTime();
    const windowStart = nowMs - this.#windowMs;
    const existingHits = this.#hitsByKey.get(key) ?? [];
    const activeHits = existingHits.filter((hitAtMs) => hitAtMs > windowStart);

    if (activeHits.length >= this.#limit) {
      this.#hitsByKey.set(key, activeHits);
      return false;
    }

    this.#hitsByKey.set(key, [...activeHits, nowMs]);
    return true;
  }
}

export class InMemoryCapabilityRegistry {
  readonly #recordsByHash = new Map<Sha256Hash, CapabilityRecord>();

  issueCapability(input: {
    published: PublishedRequestVersion;
    url: string;
    issuedAt?: string | undefined;
  }): SubmissionCapability {
    const capabilityHash = sha256Hash(input.url);
    this.#recordsByHash.set(capabilityHash, {
      request_id: input.published.request_id,
      request_version: input.published.request_version,
      capability_hash: capabilityHash,
      status: "active",
      issued_at: input.issuedAt ?? new Date().toISOString()
    });

    return {
      url: input.url,
      revoked: false
    };
  }

  revokeCapability(
    capability: Pick<SubmissionCapability, "url">,
    revokedAt: string = new Date().toISOString()
  ): void {
    const capabilityHash = sha256Hash(capability.url);
    const existing = this.#recordsByHash.get(capabilityHash);
    if (existing === undefined) {
      return;
    }

    this.#recordsByHash.set(capabilityHash, {
      ...existing,
      status: "revoked",
      revoked_at: revokedAt
    });
  }

  rotateCapability(input: {
    published: PublishedRequestVersion;
    previous: Pick<SubmissionCapability, "url">;
    url: string;
    rotatedAt?: string | undefined;
  }): SubmissionCapability {
    this.revokeCapability(input.previous, input.rotatedAt);
    return this.issueCapability({
      published: input.published,
      url: input.url,
      issuedAt: input.rotatedAt
    });
  }

  resolveCapability(url: string): SubmissionCapability {
    const record = this.#recordsByHash.get(sha256Hash(url));

    return {
      url,
      revoked: record === undefined || record.status === "revoked"
    };
  }

  listRecords(): CapabilityRecord[] {
    return [...this.#recordsByHash.values()].map((record) => structuredClone(record));
  }
}

export function validateSubmissionEnvelope(
  envelope: SubmissionEnvelope,
  context: SubmissionValidationContext
): SubmissionValidationResult {
  const prepared = prepareSubmissionValidation(envelope, context);
  if (!prepared.ok) {
    return prepared.result;
  }

  if (!context.rateLimiter.consume(rateLimitKey(context))) {
    return rejected("rate_limited", "Submission rate limit was exceeded.");
  }

  const idempotencyClaimKey = createIdempotencyClaimKey(envelope);
  const acceptedAt = prepared.acceptedAt;
  const claimed = context.idempotencyStore.claimValidation(idempotencyClaimKey, {
    request_id: envelope.request_id,
    request_version: envelope.request_version,
    idempotency_key: envelope.idempotency_key,
    submitted_at: envelope.submitted_at,
    claimed_at: acceptedAt,
    status: "validation_accepted"
  });

  if (!claimed) {
    return rejected("idempotency_key_replayed", "Idempotency key has already been accepted.");
  }

  return {
    ok: true,
    status: "accepted",
    submission: {
      request_id: envelope.request_id,
      request_version: envelope.request_version,
      idempotency_key: envelope.idempotency_key,
      submitted_at: envelope.submitted_at,
      accepted_at: acceptedAt,
      capability_hash: sha256Hash(context.capability.url)
    }
  };
}

export async function validateSubmissionEnvelopeAsync(
  envelope: SubmissionEnvelope,
  context: AsyncSubmissionValidationContext
): Promise<SubmissionValidationResult> {
  const prepared = prepareSubmissionValidation(envelope, context);
  if (!prepared.ok) {
    return prepared.result;
  }

  if (!await context.rateLimiter.consume(rateLimitKey(context))) {
    return rejected("rate_limited", "Submission rate limit was exceeded.");
  }

  const idempotencyClaimKey = createIdempotencyClaimKey(envelope);
  const acceptedAt = prepared.acceptedAt;
  const claimed = await context.idempotencyStore.claimValidation(idempotencyClaimKey, {
    request_id: envelope.request_id,
    request_version: envelope.request_version,
    idempotency_key: envelope.idempotency_key,
    submitted_at: envelope.submitted_at,
    claimed_at: acceptedAt,
    status: "validation_accepted"
  });

  if (!claimed) {
    return rejected("idempotency_key_replayed", "Idempotency key has already been accepted.");
  }

  return {
    ok: true,
    status: "accepted",
    submission: {
      request_id: envelope.request_id,
      request_version: envelope.request_version,
      idempotency_key: envelope.idempotency_key,
      submitted_at: envelope.submitted_at,
      accepted_at: acceptedAt,
      capability_hash: sha256Hash(context.capability.url)
    }
  };
}

function prepareSubmissionValidation(
  envelope: SubmissionEnvelope,
  context: Omit<SubmissionValidationContext, "idempotencyStore" | "rateLimiter">
): { ok: true; acceptedAt: string } | { ok: false; result: SubmissionValidationResult } {
  const staticError = validateSubmissionEnvelopeMetadata(envelope, context.published);
  if (staticError !== undefined) {
    return {
      ok: false,
      result: rejected(staticError.code, staticError.message)
    };
  }

  if (context.capability.revoked) {
    return {
      ok: false,
      result: rejected("capability_revoked", "Capability URL has been revoked.")
    };
  }

  const submittedAt = new Date(envelope.submitted_at);
  if (Number.isNaN(submittedAt.getTime())) {
    return {
      ok: false,
      result: rejected("invalid_submitted_at", "submitted_at must be a valid date-time.")
    };
  }

  const now = context.clock();
  const maxSubmissionAgeMs = context.maxSubmissionAgeMs ?? defaultMaxSubmissionAgeMs;
  if (submittedAt.getTime() - now.getTime() > defaultMaxSubmissionClockSkewMs) {
    return {
      ok: false,
      result: rejected("submitted_at_in_future", "submitted_at is outside the accepted clock skew.")
    };
  }

  if (now.getTime() - submittedAt.getTime() > maxSubmissionAgeMs) {
    return {
      ok: false,
      result: rejected("submission_expired", "Submission is outside the accepted time window.")
    };
  }

  return {
    ok: true,
    acceptedAt: now.toISOString()
  };
}

export function createIdempotencyClaimKey(envelope: Pick<
  SubmissionEnvelope,
  "request_id" | "request_version" | "idempotency_key"
>): string {
  return `${envelope.request_id}:${envelope.request_version}:${envelope.idempotency_key}`;
}

export function validateSubmissionEnvelopeMetadata(
  envelope: SubmissionEnvelope,
  published: PublishedRequestVersion
): SubmissionValidationError | undefined {
  if (envelope.request_id !== published.request_id) {
    return {
      code: "request_id_mismatch",
      message: "Envelope request_id does not match the published request."
    };
  }

  if (envelope.request_version !== published.request_version) {
    return {
      code: "request_version_mismatch",
      message: "Envelope request_version does not match the published request."
    };
  }

  if (envelope.schema_hash !== published.hashes.schema_hash) {
    return {
      code: "schema_hash_mismatch",
      message: "Envelope schema_hash does not match the published schema."
    };
  }

  if (envelope.service_key_id !== published.definition.encryption.service_key_id) {
    return {
      code: "service_key_id_mismatch",
      message: "Envelope service_key_id does not match the published service key."
    };
  }

  if (envelope.consent_receipt_hash !== published.hashes.consent_text_hash) {
    return {
      code: "consent_receipt_hash_mismatch",
      message: "Envelope consent_receipt_hash does not match the published consent text."
    };
  }

  if (hashEncryptedPayload(envelope.encrypted_payload) !== envelope.encrypted_payload_hash) {
    return {
      code: "encrypted_payload_hash_mismatch",
      message: "Envelope encrypted_payload_hash does not match encrypted_payload."
    };
  }

  return undefined;
}

function hashEncryptedPayload(encryptedPayload: Record<string, unknown>): Sha256Hash {
  return sha256Hash(canonicalizeJson(encryptedPayload));
}

function rateLimitKey(
  context: Pick<SubmissionValidationContext, "published" | "capability">
): string {
  return `${context.published.request_id}:${context.published.request_version}:${sha256Hash(context.capability.url)}`;
}

function rejected(code: string, message: string): SubmissionValidationResult {
  return {
    ok: false,
    status: "rejected",
    error: {
      code,
      message
    }
  };
}
