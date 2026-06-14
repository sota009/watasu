import { sha256Hash, type Sha256Hash } from "./hash.js";
import { canonicalizeJson } from "./request-definition.js";
import type { TrustProfile } from "./request-definition.js";
import type { PublishedRequestVersion } from "./request-version.js";

const defaultMaxSubmissionAgeMs = 15 * 60 * 1000;

export interface SubmissionEnvelope {
  request_id: string;
  request_version: string;
  schema_hash: string;
  consent_receipt_hash: string;
  idempotency_key: string;
  submitted_at: string;
  service_key_id: string;
  encrypted_payload: Record<string, unknown>;
  encrypted_payload_hash: string;
  sender_key_id?: string | undefined;
  sender_signature?: string | undefined;
  invite_id?: string | undefined;
}

export interface SubmissionCapability {
  url: string;
  revoked: boolean;
}

export interface TrustedInviteBinding {
  invite_id: string;
  sender_key_id: string;
}

export interface IdempotencyStore {
  claim(recordKey: string, record: IdempotencyRecord): boolean;
}

export interface SubmissionRateLimiter {
  consume(key: string): boolean;
}

export interface IdempotencyRecord {
  request_id: string;
  request_version: string;
  idempotency_key: string;
  submitted_at: string;
  accepted_at: string;
}

export interface SubmissionValidationContext {
  published: PublishedRequestVersion;
  capability: SubmissionCapability;
  idempotencyStore: IdempotencyStore;
  rateLimiter: SubmissionRateLimiter;
  clock: () => Date;
  maxSubmissionAgeMs?: number | undefined;
  trustedSenderKeyIds?: string[] | undefined;
  trustedInvites?: TrustedInviteBinding[] | undefined;
}

export type SubmissionValidationResult =
  | {
      ok: true;
      status: "accepted";
      submission: AcceptedSubmission;
    }
  | {
      ok: false;
      status: "rejected" | "auth_required";
      error: SubmissionValidationError;
    };

export interface AcceptedSubmission {
  request_id: string;
  request_version: string;
  idempotency_key: string;
  submitted_at: string;
  accepted_at: string;
  capability_url: string;
  sender_key_id?: string | undefined;
  invite_id?: string | undefined;
}

export interface SubmissionValidationError {
  code: string;
  message: string;
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  readonly #records = new Map<string, IdempotencyRecord>();

  claim(recordKey: string, record: IdempotencyRecord): boolean {
    if (this.#records.has(recordKey)) {
      return false;
    }

    this.#records.set(recordKey, structuredClone(record));
    return true;
  }

  has(recordKey: string): boolean {
    return this.#records.has(recordKey);
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

export function validateSubmissionEnvelope(
  envelope: SubmissionEnvelope,
  context: SubmissionValidationContext
): SubmissionValidationResult {
  const staticError = validateEnvelopeMetadata(envelope, context.published);
  if (staticError !== undefined) {
    return rejected(staticError.code, staticError.message);
  }

  if (context.capability.revoked) {
    return rejected("capability_revoked", "Capability URL has been revoked.");
  }

  const trustError = validateSenderTrust(envelope, context);
  if (trustError !== undefined) {
    return authRequired(trustError.code, trustError.message);
  }

  const submittedAt = new Date(envelope.submitted_at);
  if (Number.isNaN(submittedAt.getTime())) {
    return rejected("invalid_submitted_at", "submitted_at must be a valid date-time.");
  }

  const now = context.clock();
  const maxSubmissionAgeMs = context.maxSubmissionAgeMs ?? defaultMaxSubmissionAgeMs;
  if (now.getTime() - submittedAt.getTime() > maxSubmissionAgeMs) {
    return rejected("submission_expired", "Submission is outside the accepted time window.");
  }

  if (!context.rateLimiter.consume(rateLimitKey(context))) {
    return rejected("rate_limited", "Submission rate limit was exceeded.");
  }

  const idempotencyRecordKey = createIdempotencyRecordKey(envelope);
  const acceptedAt = now.toISOString();
  const claimed = context.idempotencyStore.claim(idempotencyRecordKey, {
    request_id: envelope.request_id,
    request_version: envelope.request_version,
    idempotency_key: envelope.idempotency_key,
    submitted_at: envelope.submitted_at,
    accepted_at: acceptedAt
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
      capability_url: context.capability.url,
      sender_key_id: envelope.sender_key_id,
      invite_id: envelope.invite_id
    }
  };
}

export function createIdempotencyRecordKey(envelope: Pick<
  SubmissionEnvelope,
  "request_id" | "request_version" | "idempotency_key"
>): string {
  return `${envelope.request_id}:${envelope.request_version}:${envelope.idempotency_key}`;
}

function validateEnvelopeMetadata(
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

function validateSenderTrust(
  envelope: SubmissionEnvelope,
  context: SubmissionValidationContext
): SubmissionValidationError | undefined {
  const trustProfile = context.published.definition.trust_profile;

  if (trustProfile === "public_capability" || trustProfile === "local_demo") {
    return undefined;
  }

  if (trustProfile === "verified_sender") {
    if (envelope.sender_signature === undefined) {
      return {
        code: "sender_signature_required",
        message: "verified_sender submissions require a sender signature."
      };
    }

    return validateTrustedSenderKey(envelope, context, trustProfile);
  }

  if (envelope.sender_key_id === undefined) {
    return {
      code: "sender_key_required",
      message: "private_invite submissions require a sender key."
    };
  }

  if (envelope.invite_id === undefined) {
    return {
      code: "invite_binding_required",
      message: "private_invite submissions require an invite binding."
    };
  }

  const trustedInvite = (context.trustedInvites ?? []).find(
    (invite) =>
      invite.invite_id === envelope.invite_id && invite.sender_key_id === envelope.sender_key_id
  );
  if (trustedInvite === undefined) {
    return {
      code: "invite_binding_mismatch",
      message: "private_invite sender key is not bound to the invite."
    };
  }

  return undefined;
}

function validateTrustedSenderKey(
  envelope: SubmissionEnvelope,
  context: SubmissionValidationContext,
  trustProfile: TrustProfile
): SubmissionValidationError | undefined {
  if (envelope.sender_key_id === undefined) {
    return {
      code: "sender_key_required",
      message: `${trustProfile} submissions require a sender key.`
    };
  }

  const trustedSenderKeyIds = context.trustedSenderKeyIds;
  if (trustedSenderKeyIds === undefined || !trustedSenderKeyIds.includes(envelope.sender_key_id)) {
    return {
      code: "sender_key_untrusted",
      message: "Sender key is not trusted for this request."
    };
  }

  return undefined;
}

function hashEncryptedPayload(encryptedPayload: Record<string, unknown>): Sha256Hash {
  return sha256Hash(canonicalizeJson(encryptedPayload));
}

function rateLimitKey(context: SubmissionValidationContext): string {
  return `${context.published.request_id}:${context.published.request_version}:${context.capability.url}`;
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

function authRequired(code: string, message: string): SubmissionValidationResult {
  return {
    ok: false,
    status: "auth_required",
    error: {
      code,
      message
    }
  };
}
