import { describe, expect, test } from "vitest";
import { verifyConsentRegistration, verifyConsentAuthentication } from "./webauthn.js";
import {
  AUTH_FIXTURE,
  FIXTURE_CHALLENGE,
  FIXTURE_CREDENTIAL_ID,
  FIXTURE_ORIGIN,
  FIXTURE_RPID,
  REG_FIXTURE
} from "./webauthn.fixtures.js";

describe("verifyConsentRegistration", () => {
  test("test_valid_registration_returns_credential_with_be_bs", async () => {
    const result = await verifyConsentRegistration({
      response: REG_FIXTURE,
      expectedChallenge: FIXTURE_CHALLENGE,
      expectedOrigins: [FIXTURE_ORIGIN],
      expectedRPID: FIXTURE_RPID
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(typeof result.credential.credentialId).toBe("string");
      expect(result.credential.publicKey).toBeInstanceOf(Uint8Array);
      expect(typeof result.credential.backupEligible).toBe("boolean");
      expect(typeof result.credential.backupState).toBe("boolean");
    }
  });

  test("test_wrong_challenge_is_rejected", async () => {
    const result = await verifyConsentRegistration({
      response: REG_FIXTURE,
      expectedChallenge: "sha256:not-the-challenge",
      expectedOrigins: [FIXTURE_ORIGIN],
      expectedRPID: FIXTURE_RPID
    });
    expect(result.ok).toBe(false);
  });
});

describe("verifyConsentAuthentication", () => {
  test("test_valid_authentication_succeeds_against_registered_credential", async () => {
    const registration = await verifyConsentRegistration({
      response: REG_FIXTURE,
      expectedChallenge: FIXTURE_CHALLENGE,
      expectedOrigins: [FIXTURE_ORIGIN],
      expectedRPID: FIXTURE_RPID
    });
    expect(registration.ok).toBe(true);
    if (!registration.ok) {
      return;
    }

    const result = await verifyConsentAuthentication({
      response: AUTH_FIXTURE,
      expectedChallenge: FIXTURE_CHALLENGE,
      expectedOrigins: [FIXTURE_ORIGIN],
      expectedRPID: FIXTURE_RPID,
      credential: {
        id: FIXTURE_CREDENTIAL_ID,
        publicKey: registration.credential.publicKey as Uint8Array,
        counter: 0
      }
    });

    expect(result.ok).toBe(true);
  });
});
