import { createHash, randomBytes } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";

// ---------------------------------------------------------------------------
// Consent token (stateless pending-consent state). §6 of the design note: the
// pending consent is a signed, opaque token — NOT a database row. watasu holds
// nothing between pause and approval; the token *is* the row.
// ---------------------------------------------------------------------------

export interface ConsentTokenClaims {
  tenant_id: string;
  request_id: string;
  request_version: string;
  idempotency_key: string;
  envelope_hash: string;
  consent_text_hash: string;
  field_purposes_hash: string;
  destination_policy_hash: string;
  nonce: string;
  exp: number;
}

export interface MintConsentTokenParams {
  tenant_id: string;
  request_id: string;
  request_version: string;
  idempotency_key: string;
  envelope_hash: string;
  consent_text_hash: string;
  field_purposes_hash: string;
  destination_policy_hash: string;
  nonce?: string | undefined;
  issued_at: Date;
  ttl_seconds: number;
}

export interface MintedConsentToken {
  token: string;
  claims: ConsentTokenClaims;
  expires_in_seconds: number;
}

export interface ConsentTokenError {
  code: "consent_token_expired" | "consent_token_invalid";
  message: string;
}

export type ConsentTokenVerification =
  | { ok: true; claims: ConsentTokenClaims }
  | { ok: false; error: ConsentTokenError };

const consentTokenType = "watasu-consent+jwt";

export function generateConsentNonce(): string {
  return randomBytes(16).toString("base64url");
}

export async function mintConsentToken(
  params: MintConsentTokenParams,
  secret: string
): Promise<MintedConsentToken> {
  const nonce = params.nonce ?? generateConsentNonce();
  const issuedAtSeconds = Math.floor(params.issued_at.getTime() / 1000);
  const exp = issuedAtSeconds + params.ttl_seconds;
  const claims: ConsentTokenClaims = {
    tenant_id: params.tenant_id,
    request_id: params.request_id,
    request_version: params.request_version,
    idempotency_key: params.idempotency_key,
    envelope_hash: params.envelope_hash,
    consent_text_hash: params.consent_text_hash,
    field_purposes_hash: params.field_purposes_hash,
    destination_policy_hash: params.destination_policy_hash,
    nonce,
    exp
  };

  const token = await new SignJWT({
    tenant_id: claims.tenant_id,
    request_id: claims.request_id,
    request_version: claims.request_version,
    idempotency_key: claims.idempotency_key,
    envelope_hash: claims.envelope_hash,
    consent_text_hash: claims.consent_text_hash,
    field_purposes_hash: claims.field_purposes_hash,
    destination_policy_hash: claims.destination_policy_hash,
    nonce: claims.nonce
  })
    .setProtectedHeader({ alg: "HS256", typ: consentTokenType })
    .setIssuedAt(issuedAtSeconds)
    .setExpirationTime(exp)
    .sign(encodeSecret(secret));

  return {
    token,
    claims,
    expires_in_seconds: params.ttl_seconds
  };
}

export async function verifyConsentToken(
  token: string,
  secret: string,
  now: Date
): Promise<ConsentTokenVerification> {
  try {
    const { payload } = await jwtVerify(token, encodeSecret(secret), {
      algorithms: ["HS256"],
      typ: consentTokenType,
      currentDate: now
    });

    const claims = extractConsentTokenClaims(payload);
    if (claims === undefined) {
      return invalidConsentToken("Consent token claims are malformed.");
    }

    return { ok: true, claims };
  } catch (error) {
    if (isJoseErrorCode(error, "ERR_JWT_EXPIRED")) {
      return {
        ok: false,
        error: {
          code: "consent_token_expired",
          message: "Consent token has expired."
        }
      };
    }

    return invalidConsentToken("Consent token signature or structure is invalid.");
  }
}

// ---------------------------------------------------------------------------
// WebAuthn challenge. §7 + §13: the biometric signs over *what the user saw*,
// not a bare random challenge. The single signed receipt is the SOLE consent
// mechanism, so the challenge binds all three published term-hashes (consent
// text, field purposes, destination policy) alongside the payload — proving
// both "a human consented" AND "consent was to the exact terms" — challenge =
// base64url(SHA-256(envelope_hash ‖ consent_text_hash ‖ field_purposes_hash ‖
// destination_policy_hash ‖ nonce)).
// ---------------------------------------------------------------------------

export interface ConsentChallengeInput {
  envelope_hash: string;
  consent_text_hash: string;
  field_purposes_hash: string;
  destination_policy_hash: string;
  nonce: string;
}

export function buildConsentChallenge(input: ConsentChallengeInput): string {
  const material = [
    input.envelope_hash,
    input.consent_text_hash,
    input.field_purposes_hash,
    input.destination_policy_hash,
    input.nonce
  ].join("\n");
  return createHash("sha256").update(material, "utf8").digest("base64url");
}

// ---------------------------------------------------------------------------
// Consent receipt. INTERIM: a JWS signed with the service secret. The claim
// shape and mint/verify helpers are stable for callers; only the *format*
// behind them is provisional.
//
// TODO(credential-receipt): the deferred upgrade is a credential-grade receipt
// (SD-JWT-VC / KB-JWT, OID4VP `transaction_data` per RFC 9901) that watasu mints
// and signs itself. This was previously planned via tap's @tap/schema + sealed
// signing-worker; tap is retired (2026-07-05), so watasu owns this tier — the
// impl source (vendor @tap/schema's TS vs generic libs) is an open decision
// (design §9, §11). Callers of mintConsentReceipt / verifyConsentReceipt must not
// need to change when this seam is replaced.
// ---------------------------------------------------------------------------

export interface ConsentReceipt {
  envelope_hash: string;
  consent_text_hash: string;
  field_purposes_hash: string;
  destination_policy_hash: string;
  credential_id: string;
  approved_at: string;
  nonce: string;
  exp: number;
  backup_eligible: boolean;
  backup_state: boolean;
}

export interface MintConsentReceiptParams {
  envelope_hash: string;
  consent_text_hash: string;
  field_purposes_hash: string;
  destination_policy_hash: string;
  credential_id: string;
  approved_at: Date;
  nonce: string;
  ttl_seconds: number;
  backup_eligible: boolean;
  backup_state: boolean;
}

export interface ConsentReceiptError {
  code: "consent_receipt_expired" | "consent_receipt_invalid";
  message: string;
}

export type ConsentReceiptVerification =
  | { ok: true; receipt: ConsentReceipt }
  | { ok: false; error: ConsentReceiptError };

const consentReceiptType = "watasu-consent-receipt+jwt";

export async function mintConsentReceipt(
  params: MintConsentReceiptParams,
  secret: string
): Promise<string> {
  const approvedAtSeconds = Math.floor(params.approved_at.getTime() / 1000);
  const exp = approvedAtSeconds + params.ttl_seconds;

  // TODO(credential-receipt): replace this JWS body with a watasu-owned KB-JWT
  // credential receipt object (design §9).
  return new SignJWT({
    envelope_hash: params.envelope_hash,
    consent_text_hash: params.consent_text_hash,
    field_purposes_hash: params.field_purposes_hash,
    destination_policy_hash: params.destination_policy_hash,
    credential_id: params.credential_id,
    approved_at: params.approved_at.toISOString(),
    nonce: params.nonce,
    backup_eligible: params.backup_eligible,
    backup_state: params.backup_state
  })
    .setProtectedHeader({ alg: "HS256", typ: consentReceiptType })
    .setIssuedAt(approvedAtSeconds)
    .setExpirationTime(exp)
    .sign(encodeSecret(secret));
}

export async function verifyConsentReceipt(
  token: string,
  secret: string,
  now: Date
): Promise<ConsentReceiptVerification> {
  try {
    const { payload } = await jwtVerify(token, encodeSecret(secret), {
      algorithms: ["HS256"],
      typ: consentReceiptType,
      currentDate: now
    });

    const receipt = extractConsentReceipt(payload);
    if (receipt === undefined) {
      return {
        ok: false,
        error: {
          code: "consent_receipt_invalid",
          message: "Consent receipt claims are malformed."
        }
      };
    }

    return { ok: true, receipt };
  } catch (error) {
    if (isJoseErrorCode(error, "ERR_JWT_EXPIRED")) {
      return {
        ok: false,
        error: {
          code: "consent_receipt_expired",
          message: "Consent receipt has expired."
        }
      };
    }

    return {
      ok: false,
      error: {
        code: "consent_receipt_invalid",
        message: "Consent receipt signature or structure is invalid."
      }
    };
  }
}

// ---------------------------------------------------------------------------
// Approval readback store. The pending-consent state is stateless (the token),
// but the *approved* receipt must survive between the browser POST /approve and
// the agent's GET /status poll. This is the single durable seam (§6): in-memory
// is adequate for a single Render instance; swap a durable impl for multi-instance.
// ---------------------------------------------------------------------------

export interface ConsentApprovalStore {
  /** Records an approval; returns false if this nonce was already approved. */
  markApproved(nonce: string, receipt: string): boolean;
  getApproved(nonce: string): string | undefined;
}

export class InMemoryConsentApprovalStore implements ConsentApprovalStore {
  readonly #receiptsByNonce = new Map<string, string>();

  markApproved(nonce: string, receipt: string): boolean {
    if (this.#receiptsByNonce.has(nonce)) {
      return false;
    }

    this.#receiptsByNonce.set(nonce, receipt);
    return true;
  }

  getApproved(nonce: string): string | undefined {
    return this.#receiptsByNonce.get(nonce);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function encodeSecret(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

function invalidConsentToken(message: string): ConsentTokenVerification {
  return {
    ok: false,
    error: {
      code: "consent_token_invalid",
      message
    }
  };
}

function extractConsentTokenClaims(payload: Record<string, unknown>): ConsentTokenClaims | undefined {
  const tenant_id = payload.tenant_id;
  const request_id = payload.request_id;
  const request_version = payload.request_version;
  const idempotency_key = payload.idempotency_key;
  const envelope_hash = payload.envelope_hash;
  const consent_text_hash = payload.consent_text_hash;
  const field_purposes_hash = payload.field_purposes_hash;
  const destination_policy_hash = payload.destination_policy_hash;
  const nonce = payload.nonce;
  const exp = payload.exp;

  if (
    typeof tenant_id !== "string" ||
    typeof request_id !== "string" ||
    typeof request_version !== "string" ||
    typeof idempotency_key !== "string" ||
    typeof envelope_hash !== "string" ||
    typeof consent_text_hash !== "string" ||
    typeof field_purposes_hash !== "string" ||
    typeof destination_policy_hash !== "string" ||
    typeof nonce !== "string" ||
    typeof exp !== "number"
  ) {
    return undefined;
  }

  return {
    tenant_id,
    request_id,
    request_version,
    idempotency_key,
    envelope_hash,
    consent_text_hash,
    field_purposes_hash,
    destination_policy_hash,
    nonce,
    exp
  };
}

function extractConsentReceipt(payload: Record<string, unknown>): ConsentReceipt | undefined {
  const envelope_hash = payload.envelope_hash;
  const consent_text_hash = payload.consent_text_hash;
  const field_purposes_hash = payload.field_purposes_hash;
  const destination_policy_hash = payload.destination_policy_hash;
  const credential_id = payload.credential_id;
  const approved_at = payload.approved_at;
  const nonce = payload.nonce;
  const exp = payload.exp;
  const backup_eligible = payload.backup_eligible;
  const backup_state = payload.backup_state;

  if (
    typeof envelope_hash !== "string" ||
    typeof consent_text_hash !== "string" ||
    typeof field_purposes_hash !== "string" ||
    typeof destination_policy_hash !== "string" ||
    typeof credential_id !== "string" ||
    typeof approved_at !== "string" ||
    typeof nonce !== "string" ||
    typeof exp !== "number" ||
    typeof backup_eligible !== "boolean" ||
    typeof backup_state !== "boolean"
  ) {
    return undefined;
  }

  return {
    envelope_hash,
    consent_text_hash,
    field_purposes_hash,
    destination_policy_hash,
    credential_id,
    approved_at,
    nonce,
    exp,
    backup_eligible,
    backup_state
  };
}

function isJoseErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === code
  );
}
