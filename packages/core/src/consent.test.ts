import {
  createHash,
  generateKeyPairSync,
  sign as cryptoSign,
  type JsonWebKey
} from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  buildConsentChallenge,
  mintConsentReceipt,
  mintConsentToken,
  verifyConsentReceipt,
  verifyConsentToken,
  verifyWebAuthnAssertion
} from "./consent.js";

const tokenSecret = "consent-signing-secret-with-enough-entropy-1234567890";

const baseTokenParams = {
  tenant_id: "tenant-a",
  request_id: "event-attendee-intake",
  request_version: "v1",
  idempotency_key: "submit-001",
  envelope_hash: "sha256:envelope-hash",
  consent_text_hash: "sha256:consent-hash",
  field_purposes_hash: "sha256:field-purposes-hash",
  destination_policy_hash: "sha256:destination-policy-hash",
  nonce: "nonce-abc",
  ttl_seconds: 600
};

describe("consent token", () => {
  test("test_consent_token_round_trips_and_recovers_claims", async () => {
    const issuedAt = new Date("2026-07-05T00:00:00.000Z");
    const minted = await mintConsentToken({ ...baseTokenParams, issued_at: issuedAt }, tokenSecret);

    const verified = await verifyConsentToken(
      minted.token,
      tokenSecret,
      new Date("2026-07-05T00:05:00.000Z")
    );

    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.claims).toMatchObject({
        tenant_id: "tenant-a",
        request_id: "event-attendee-intake",
        request_version: "v1",
        idempotency_key: "submit-001",
        envelope_hash: "sha256:envelope-hash",
        consent_text_hash: "sha256:consent-hash",
        field_purposes_hash: "sha256:field-purposes-hash",
        destination_policy_hash: "sha256:destination-policy-hash",
        nonce: "nonce-abc"
      });
      expect(verified.claims.exp).toBe(Math.floor(issuedAt.getTime() / 1000) + 600);
    }
    expect(minted.expires_in_seconds).toBe(600);
  });

  test("test_consent_token_rejected_after_expiry", async () => {
    const minted = await mintConsentToken(
      { ...baseTokenParams, issued_at: new Date("2026-07-05T00:00:00.000Z") },
      tokenSecret
    );

    const verified = await verifyConsentToken(
      minted.token,
      tokenSecret,
      new Date("2026-07-05T00:20:00.000Z")
    );

    expect(verified).toEqual({
      ok: false,
      error: {
        code: "consent_token_expired",
        message: "Consent token has expired."
      }
    });
  });

  test("test_consent_token_rejected_with_wrong_secret", async () => {
    const minted = await mintConsentToken(
      { ...baseTokenParams, issued_at: new Date("2026-07-05T00:00:00.000Z") },
      tokenSecret
    );

    const verified = await verifyConsentToken(
      minted.token,
      "a-different-secret-value-of-sufficient-length-000",
      new Date("2026-07-05T00:05:00.000Z")
    );

    expect(verified.ok).toBe(false);
    if (!verified.ok) {
      expect(verified.error.code).toBe("consent_token_invalid");
    }
  });
});

describe("consent challenge", () => {
  test("test_consent_challenge_is_deterministic", () => {
    const input = {
      envelope_hash: "sha256:envelope-hash",
      consent_text_hash: "sha256:consent-hash",
      field_purposes_hash: "sha256:field-purposes-hash",
      destination_policy_hash: "sha256:destination-policy-hash",
      nonce: "nonce-abc"
    };

    expect(buildConsentChallenge(input)).toBe(buildConsentChallenge(input));
  });

  test("test_consent_challenge_changes_with_nonce", () => {
    const first = buildConsentChallenge({
      envelope_hash: "sha256:envelope-hash",
      consent_text_hash: "sha256:consent-hash",
      field_purposes_hash: "sha256:field-purposes-hash",
      destination_policy_hash: "sha256:destination-policy-hash",
      nonce: "nonce-abc"
    });
    const second = buildConsentChallenge({
      envelope_hash: "sha256:envelope-hash",
      consent_text_hash: "sha256:consent-hash",
      field_purposes_hash: "sha256:field-purposes-hash",
      destination_policy_hash: "sha256:destination-policy-hash",
      nonce: "nonce-def"
    });

    expect(first).not.toBe(second);
  });

  test("test_consent_challenge_changes_with_field_purposes_hash", () => {
    const base = {
      envelope_hash: "sha256:envelope-hash",
      consent_text_hash: "sha256:consent-hash",
      field_purposes_hash: "sha256:field-purposes-hash",
      destination_policy_hash: "sha256:destination-policy-hash",
      nonce: "nonce-abc"
    };

    expect(buildConsentChallenge(base)).not.toBe(
      buildConsentChallenge({ ...base, field_purposes_hash: "sha256:other-purposes" })
    );
  });

  test("test_consent_challenge_changes_with_destination_policy_hash", () => {
    const base = {
      envelope_hash: "sha256:envelope-hash",
      consent_text_hash: "sha256:consent-hash",
      field_purposes_hash: "sha256:field-purposes-hash",
      destination_policy_hash: "sha256:destination-policy-hash",
      nonce: "nonce-abc"
    };

    expect(buildConsentChallenge(base)).not.toBe(
      buildConsentChallenge({ ...base, destination_policy_hash: "sha256:other-policy" })
    );
  });
});

describe("WebAuthn assertion (ES256)", () => {
  function buildAssertion(input: {
    challenge: string;
    origin: string;
  }): {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    credentialPublicKey: JsonWebKey;
  } {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const clientData = {
      type: "webauthn.get",
      challenge: input.challenge,
      origin: input.origin
    };
    const clientDataBytes = Buffer.from(JSON.stringify(clientData), "utf8");
    const authenticatorData = Buffer.concat([
      createHash("sha256").update("rp-id").digest(),
      Buffer.from([0x05]),
      Buffer.from([0, 0, 0, 1])
    ]);
    const clientDataHash = createHash("sha256").update(clientDataBytes).digest();
    const signedData = Buffer.concat([authenticatorData, clientDataHash]);
    const signature = cryptoSign("sha256", signedData, { key: privateKey, dsaEncoding: "der" });

    return {
      clientDataJSON: clientDataBytes.toString("base64url"),
      authenticatorData: authenticatorData.toString("base64url"),
      signature: signature.toString("base64url"),
      credentialPublicKey: publicKey.export({ format: "jwk" }) as JsonWebKey
    };
  }

  const challenge = buildConsentChallenge({
    envelope_hash: "sha256:envelope-hash",
    consent_text_hash: "sha256:consent-hash",
    field_purposes_hash: "sha256:field-purposes-hash",
    destination_policy_hash: "sha256:destination-policy-hash",
    nonce: "nonce-abc"
  });
  const origin = "https://consent.watasu.ai";

  test("test_es256_assertion_verifies_against_fresh_p256_key", () => {
    const assertion = buildAssertion({ challenge, origin });

    const result = verifyWebAuthnAssertion({
      clientDataJSON: assertion.clientDataJSON,
      authenticatorData: assertion.authenticatorData,
      signature: assertion.signature,
      expectedChallenge: challenge,
      allowedOrigins: [origin],
      credentialPublicKey: assertion.credentialPublicKey
    });

    expect(result).toEqual({ ok: true });
  });

  test("test_assertion_rejected_for_challenge_mismatch", () => {
    const assertion = buildAssertion({ challenge, origin });

    const result = verifyWebAuthnAssertion({
      clientDataJSON: assertion.clientDataJSON,
      authenticatorData: assertion.authenticatorData,
      signature: assertion.signature,
      expectedChallenge: "a-different-challenge",
      allowedOrigins: [origin],
      credentialPublicKey: assertion.credentialPublicKey
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("webauthn_challenge_mismatch");
    }
  });

  test("test_assertion_rejected_for_untrusted_origin", () => {
    const assertion = buildAssertion({ challenge, origin });

    const result = verifyWebAuthnAssertion({
      clientDataJSON: assertion.clientDataJSON,
      authenticatorData: assertion.authenticatorData,
      signature: assertion.signature,
      expectedChallenge: challenge,
      allowedOrigins: ["https://evil.example.com"],
      credentialPublicKey: assertion.credentialPublicKey
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("webauthn_origin_untrusted");
    }
  });

  test("test_assertion_rejected_when_signature_is_forged", () => {
    const assertion = buildAssertion({ challenge, origin });
    const otherKey = generateKeyPairSync("ec", { namedCurve: "P-256" });

    const result = verifyWebAuthnAssertion({
      clientDataJSON: assertion.clientDataJSON,
      authenticatorData: assertion.authenticatorData,
      signature: assertion.signature,
      expectedChallenge: challenge,
      allowedOrigins: [origin],
      credentialPublicKey: otherKey.publicKey.export({ format: "jwk" }) as JsonWebKey
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("webauthn_signature_invalid");
    }
  });
});

describe("consent receipt", () => {
  const receiptParams = {
    envelope_hash: "sha256:envelope-hash",
    consent_text_hash: "sha256:consent-hash",
    field_purposes_hash: "sha256:field-purposes-hash",
    destination_policy_hash: "sha256:destination-policy-hash",
    credential_id: "credential-xyz",
    nonce: "nonce-abc",
    ttl_seconds: 3600,
    backup_eligible: true,
    backup_state: false
  };

  test("test_consent_receipt_round_trips", async () => {
    const approvedAt = new Date("2026-07-05T00:01:00.000Z");
    const receipt = await mintConsentReceipt({ ...receiptParams, approved_at: approvedAt }, tokenSecret);

    const verified = await verifyConsentReceipt(
      receipt,
      tokenSecret,
      new Date("2026-07-05T00:10:00.000Z")
    );

    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.receipt).toMatchObject({
        envelope_hash: "sha256:envelope-hash",
        consent_text_hash: "sha256:consent-hash",
        field_purposes_hash: "sha256:field-purposes-hash",
        destination_policy_hash: "sha256:destination-policy-hash",
        credential_id: "credential-xyz",
        nonce: "nonce-abc",
        approved_at: approvedAt.toISOString()
      });
    }
  });

  test("test_consent_receipt_rejected_after_expiry", async () => {
    const receipt = await mintConsentReceipt(
      { ...receiptParams, approved_at: new Date("2026-07-05T00:01:00.000Z") },
      tokenSecret
    );

    const verified = await verifyConsentReceipt(
      receipt,
      tokenSecret,
      new Date("2026-07-05T02:00:00.000Z")
    );

    expect(verified.ok).toBe(false);
    if (!verified.ok) {
      expect(verified.error.code).toBe("consent_receipt_expired");
    }
  });

  test("test_receipt_carries_assurance_flags", async () => {
    const secret = "test-secret";
    const now = new Date("2026-07-05T00:00:00.000Z");
    const token = await mintConsentReceipt(
      {
        envelope_hash: "sha256:e", consent_text_hash: "sha256:c",
        field_purposes_hash: "sha256:f", destination_policy_hash: "sha256:d",
        credential_id: "cred-1", approved_at: now, nonce: "n1", ttl_seconds: 3600,
        backup_eligible: true, backup_state: false
      },
      secret
    );
    const verified = await verifyConsentReceipt(token, secret, now);
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.receipt.backup_eligible).toBe(true);
      expect(verified.receipt.backup_state).toBe(false);
    }
  });
});
