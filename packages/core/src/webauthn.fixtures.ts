// AUTO-GENERATED deterministic WebAuthn fixtures (software authenticator, ES256,
// synced-passkey flags BE|BS). Self-verified against @simplewebauthn/server at
// generation time. Regenerate via scratchpad/gen-webauthn-fixtures.mjs.
import type { RegistrationResponseJSON, AuthenticationResponseJSON } from "@simplewebauthn/server";

export const FIXTURE_ORIGIN = "http://127.0.0.1:8791";
export const FIXTURE_RPID = "127.0.0.1";
export const FIXTURE_CLAIMS = {
  "envelope_hash": "sha256:fixture-envelope",
  "consent_text_hash": "sha256:fixture-consent-text",
  "field_purposes_hash": "sha256:fixture-field-purposes",
  "destination_policy_hash": "sha256:fixture-destination-policy",
  "nonce": "fixture-nonce-0001"
} as const;
/** buildConsentChallenge(FIXTURE_CLAIMS) — the payload-bound challenge the fixtures were signed over. */
export const FIXTURE_CHALLENGE = "AJTVg0QXPldhvckzB_P91Snc9wL20ClQ9_wVKCdzitE";
export const FIXTURE_CREDENTIAL_ID = "d2F0YXN1LWZpeHR1cmUtY3JlZGVudGlhbC1pZC0wMQ";
export const FIXTURE_USER_HANDLE = "d2F0YXN1LWZpeHR1cmUtdXNlci1oYW5kbGUtMDAwMQ";

export const REG_FIXTURE: RegistrationResponseJSON = {
  "id": "d2F0YXN1LWZpeHR1cmUtY3JlZGVudGlhbC1pZC0wMQ",
  "rawId": "d2F0YXN1LWZpeHR1cmUtY3JlZGVudGlhbC1pZC0wMQ",
  "type": "public-key",
  "response": {
    "clientDataJSON": "eyJ0eXBlIjoid2ViYXV0aG4uY3JlYXRlIiwiY2hhbGxlbmdlIjoiQUpUVmcwUVhQbGRodmNrekJfUDkxU25jOXdMMjBDbFE5X3dWS0Nkeml0RSIsIm9yaWdpbiI6Imh0dHA6Ly8xMjcuMC4wLjE6ODc5MSIsImNyb3NzT3JpZ2luIjpmYWxzZX0",
    "attestationObject": "o2NmbXRkbm9uZWdhdHRTdG10oGhhdXRoRGF0YVijEsoXtJryKJQ28wPgFmAwoh5SXSZuIJJnQzgBqP1AcaBdAAAAAAAAAAAAAAAAAAAAAAAAAAAAH3dhdGFzdS1maXh0dXJlLWNyZWRlbnRpYWwtaWQtMDGlAQIDJiABIVgg-YgFUoTU4q_i6mmaqJQVYyFU8hzflcrjZgiWt0x2aukiWCAUh8B6m1imZ6ecToIaAfqUQyGRPfhn6DciWXoJI7AR6g",
    "transports": [
      "internal",
      "hybrid"
    ]
  },
  "clientExtensionResults": {},
  "authenticatorAttachment": "platform"
} as unknown as RegistrationResponseJSON;

export const AUTH_FIXTURE: AuthenticationResponseJSON = {
  "id": "d2F0YXN1LWZpeHR1cmUtY3JlZGVudGlhbC1pZC0wMQ",
  "rawId": "d2F0YXN1LWZpeHR1cmUtY3JlZGVudGlhbC1pZC0wMQ",
  "type": "public-key",
  "response": {
    "clientDataJSON": "eyJ0eXBlIjoid2ViYXV0aG4uZ2V0IiwiY2hhbGxlbmdlIjoiQUpUVmcwUVhQbGRodmNrekJfUDkxU25jOXdMMjBDbFE5X3dWS0Nkeml0RSIsIm9yaWdpbiI6Imh0dHA6Ly8xMjcuMC4wLjE6ODc5MSIsImNyb3NzT3JpZ2luIjpmYWxzZX0",
    "authenticatorData": "EsoXtJryKJQ28wPgFmAwoh5SXSZuIJJnQzgBqP1AcaAdAAAAAA",
    "signature": "MEYCIQDLYzacFInivUjiWlx30rLl5qn_Omh7RQy_tjnJr7MeWgIhAMvdqG7_CSmZAdOS8Sb3Ao-os65VST6PnqExXRq0575z",
    "userHandle": "d2F0YXN1LWZpeHR1cmUtdXNlci1oYW5kbGUtMDAwMQ"
  },
  "clientExtensionResults": {}
} as unknown as AuthenticationResponseJSON;
