import { createPublicKey, verify, type JsonWebKey } from "node:crypto";
import { sha256Hash, type Sha256Hash } from "./hash.js";
import { canonicalizeJson } from "./request-definition.js";
import type { TrustProfile } from "./request-definition.js";
import type { PublishedRequestVersion } from "./request-version.js";

const defaultMaxSubmissionAgeMs = 15 * 60 * 1000;
const defaultMaxSubmissionClockSkewMs = 5 * 60 * 1000;

export interface SubmissionEnvelope {
  request_id: string;
  request_version: string;
  schema_hash: string;
  consent_receipt_hash: string;
  consent_receipt?: ConsentReceiptMetadata | undefined;
  idempotency_key: string;
  submitted_at: string;
  service_key_id: string;
  encrypted_payload: Record<string, unknown>;
  encrypted_payload_hash: string;
  sender_key_id?: string | undefined;
  sender_signature?: string | undefined;
  invite_id?: string | undefined;
  /**
   * Compact JWS consent receipt token presented on resume for the
   * `human_consent` runtime gate. Distinct from `consent_receipt`
   * (the static `ConsentReceiptMetadata` attestation). Absent on the first
   * (pausing) submission.
   */
  consent_receipt_token?: string | undefined;
}

export interface ConsentReceiptMetadata {
  request_version: string;
  consent_text_hash: string;
  field_purposes_hash: string;
  destination_policy_hash: string;
  confirmed_at: string;
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

export interface TrustedInviteBinding {
  invite_id: string;
  sender_key_id: string;
}

export interface TrustedSenderPublicKey {
  sender_key_id: string;
  alg: "ES256" | "EdDSA";
  public_jwk: JsonWebKey;
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
  trustedSenderKeyIds?: string[] | undefined;
  trustedSenderPublicKeys?: TrustedSenderPublicKey[] | undefined;
  trustedInvites?: TrustedInviteBinding[] | undefined;
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
      status: "rejected" | "auth_required";
      error: SubmissionValidationError;
    };

export interface AcceptedSubmission {
  request_id: string;
  request_version: string;
  idempotency_key: string;
  submitted_at: string;
  accepted_at: string;
  capability_hash: Sha256Hash;
  sender_key_id?: string | undefined;
  invite_id?: string | undefined;
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
      capability_hash: sha256Hash(context.capability.url),
      sender_key_id: envelope.sender_key_id,
      invite_id: envelope.invite_id
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
      capability_hash: sha256Hash(context.capability.url),
      sender_key_id: envelope.sender_key_id,
      invite_id: envelope.invite_id
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

  const trustError = validateSenderTrust(envelope, context);
  if (trustError !== undefined) {
    return {
      ok: false,
      result: authRequired(trustError.code, trustError.message)
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

  const consentReceiptError = validateConsentReceiptMetadata(envelope, published);
  if (consentReceiptError !== undefined) {
    return consentReceiptError;
  }

  if (hashEncryptedPayload(envelope.encrypted_payload) !== envelope.encrypted_payload_hash) {
    return {
      code: "encrypted_payload_hash_mismatch",
      message: "Envelope encrypted_payload_hash does not match encrypted_payload."
    };
  }

  return undefined;
}

function validateConsentReceiptMetadata(
  envelope: SubmissionEnvelope,
  published: PublishedRequestVersion
): SubmissionValidationError | undefined {
  const receipt = envelope.consent_receipt;

  if (receipt === undefined) {
    if (envelope.consent_receipt_hash !== published.hashes.consent_text_hash) {
      return {
        code: "consent_receipt_hash_mismatch",
        message: "Envelope consent_receipt_hash does not match the published consent text."
      };
    }

    return undefined;
  }

  if (receipt.request_version !== published.request_version) {
    return {
      code: "consent_receipt_request_version_mismatch",
      message: "Envelope consent_receipt request_version does not match the published request."
    };
  }

  if (receipt.consent_text_hash !== published.hashes.consent_text_hash) {
    return {
      code: "consent_receipt_consent_text_mismatch",
      message: "Envelope consent_receipt consent_text_hash does not match the published request."
    };
  }

  if (receipt.field_purposes_hash !== published.hashes.field_purposes_hash) {
    return {
      code: "consent_receipt_field_purposes_mismatch",
      message: "Envelope consent_receipt field_purposes_hash does not match the published request."
    };
  }

  if (receipt.destination_policy_hash !== published.hashes.destination_policy_hash) {
    return {
      code: "consent_receipt_destination_policy_mismatch",
      message: "Envelope consent_receipt destination_policy_hash does not match the published request."
    };
  }

  if (sha256Hash(canonicalizeJson(receipt)) !== envelope.consent_receipt_hash) {
    return {
      code: "consent_receipt_hash_mismatch",
      message: "Envelope consent_receipt_hash does not match consent_receipt metadata."
    };
  }

  return undefined;
}

function validateSenderTrust(
  envelope: SubmissionEnvelope,
  context: Omit<SubmissionValidationContext, "idempotencyStore" | "rateLimiter">
): SubmissionValidationError | undefined {
  const trustProfile = context.published.definition.trust_profile;

  if (
    trustProfile === "public_capability" ||
    trustProfile === "local_demo" ||
    trustProfile === "human_consent"
  ) {
    // human_consent short-circuits sender-trust here; the runtime consent gate
    // (packages/http/src/hosted-submit.ts) enforces the human approval instead.
    return undefined;
  }

  if (trustProfile === "verified_sender") {
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

  return validateTrustedSenderKey(envelope, context, trustProfile);
}

function validateTrustedSenderKey(
  envelope: SubmissionEnvelope,
  context: Omit<SubmissionValidationContext, "idempotencyStore" | "rateLimiter">,
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

  if (envelope.sender_signature === undefined) {
    return {
      code: "sender_signature_required",
      message: `${trustProfile} submissions require a sender signature.`
    };
  }

  const trustedSenderPublicKey = context.trustedSenderPublicKeys?.find(
    (key) => key.sender_key_id === envelope.sender_key_id
  );
  if (trustedSenderPublicKey === undefined) {
    return {
      code: "sender_public_key_required",
      message: "Sender public key is required to verify the sender signature."
    };
  }

  if (!verifySenderSignature({
    envelope,
    publicKey: trustedSenderPublicKey
  })) {
    return {
      code: "sender_signature_invalid",
      message: "Sender signature could not be verified."
    };
  }

  return undefined;
}

export function buildSenderSignaturePayload(envelope: SubmissionEnvelope): Record<string, string> {
  return {
    request_id: envelope.request_id,
    request_version: envelope.request_version,
    schema_hash: envelope.schema_hash,
    idempotency_key: envelope.idempotency_key,
    encrypted_payload_hash: envelope.encrypted_payload_hash,
    service_key_id: envelope.service_key_id,
    consent_receipt_hash: envelope.consent_receipt_hash,
    submitted_at: envelope.submitted_at
  };
}

function verifySenderSignature(input: {
  envelope: SubmissionEnvelope;
  publicKey: TrustedSenderPublicKey;
}): boolean {
  if (input.envelope.sender_signature === undefined) {
    return false;
  }

  const parts = input.envelope.sender_signature.split(".");
  if (parts.length !== 3 || parts[1] !== "") {
    return false;
  }

  const [encodedProtected, , encodedSignature] = parts;
  if (encodedProtected === undefined || encodedSignature === undefined) {
    return false;
  }

  const protectedHeader = parseProtectedHeader(encodedProtected);
  if (protectedHeader?.alg !== input.publicKey.alg) {
    return false;
  }

  const payload = Buffer.from(canonicalizeJson(buildSenderSignaturePayload(input.envelope)))
    .toString("base64url");
  const signingInput = Buffer.from(`${encodedProtected}.${payload}`, "ascii");

  try {
    const key = createPublicKey({ key: input.publicKey.public_jwk, format: "jwk" });
    const signature = Buffer.from(encodedSignature, "base64url");
    if (input.publicKey.alg === "ES256") {
      return verify("sha256", signingInput, {
        key,
        dsaEncoding: "ieee-p1363"
      }, signature);
    }

    return verify(null, signingInput, key, signature);
  } catch {
    return false;
  }
}

function parseProtectedHeader(encodedProtected: string): { alg?: unknown } | undefined {
  try {
    const value = JSON.parse(Buffer.from(encodedProtected, "base64url").toString("utf8")) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return undefined;
    }

    return value;
  } catch {
    return undefined;
  }
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
