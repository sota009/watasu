import {
  verifyRegistrationResponse,
  verifyAuthenticationResponse,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON
} from "@simplewebauthn/server";

export type { RegistrationResponseJSON, AuthenticationResponseJSON };

export interface ConsentWebAuthnCredential {
  credentialId: string;
  publicKey?: Uint8Array;
  signCount: number;
  backupEligible: boolean;
  backupState: boolean;
  aaguid?: string;
  transports?: string[];
}

export type ConsentWebAuthnResult =
  | { ok: true; credential: ConsentWebAuthnCredential }
  | { ok: false; error: { code: string; message: string } };

// Supported COSE algs: ES256 (-7), RS256 (-257), EdDSA (-8).
const supportedAlgorithmIDs = [-7, -257, -8];

export async function verifyConsentRegistration(input: {
  response: RegistrationResponseJSON;
  expectedChallenge: string;
  expectedOrigins: readonly string[];
  expectedRPID: string;
}): Promise<ConsentWebAuthnResult> {
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: input.response,
      expectedChallenge: input.expectedChallenge,
      expectedOrigin: [...input.expectedOrigins],
      expectedRPID: input.expectedRPID,
      requireUserVerification: true,
      supportedAlgorithmIDs
    });
  } catch (error) {
    return { ok: false, error: { code: "webauthn_registration_invalid", message: messageOf(error) } };
  }
  if (!verification.verified || verification.registrationInfo === undefined) {
    return { ok: false, error: { code: "webauthn_registration_invalid", message: "Registration was not verified." } };
  }
  const info = verification.registrationInfo;
  return {
    ok: true,
    credential: {
      credentialId: info.credential.id,
      publicKey: info.credential.publicKey,
      signCount: info.credential.counter,
      backupEligible: info.credentialDeviceType === "multiDevice",
      backupState: info.credentialBackedUp,
      aaguid: info.aaguid,
      ...(info.credential.transports !== undefined ? { transports: info.credential.transports } : {})
    }
  };
}

export async function verifyConsentAuthentication(input: {
  response: AuthenticationResponseJSON;
  expectedChallenge: string;
  expectedOrigins: readonly string[];
  expectedRPID: string;
  credential: { id: string; publicKey: Uint8Array; counter: number; transports?: string[] };
}): Promise<ConsentWebAuthnResult> {
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: input.response,
      expectedChallenge: input.expectedChallenge,
      expectedOrigin: [...input.expectedOrigins],
      expectedRPID: input.expectedRPID,
      requireUserVerification: true,
      credential: {
        id: input.credential.id,
        publicKey: input.credential.publicKey as never,
        counter: input.credential.counter,
        transports: input.credential.transports as never
      }
    });
  } catch (error) {
    return { ok: false, error: { code: "webauthn_signature_invalid", message: messageOf(error) } };
  }
  if (!verification.verified) {
    return { ok: false, error: { code: "webauthn_signature_invalid", message: "Assertion was not verified." } };
  }
  const info = verification.authenticationInfo;
  return {
    ok: true,
    credential: {
      credentialId: input.credential.id,
      signCount: info.newCounter,
      backupEligible: info.credentialDeviceType === "multiDevice",
      backupState: info.credentialBackedUp
    }
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "WebAuthn verification failed.";
}
