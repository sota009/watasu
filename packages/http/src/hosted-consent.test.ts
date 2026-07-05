import { describe, expect, test } from "vitest";
import {
  buildConsentChallenge,
  InMemoryConsentApprovalStore,
  InMemoryCredentialStore,
  InMemoryIdempotencyStore,
  mintConsentToken,
  verifyConsentReceipt,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON
} from "@watasu/core";
import { createHostedConsentApp, type HostedConsentRequest } from "./hosted-consent.js";

// Copied from packages/core/src/webauthn.fixtures.ts (not part of @watasu/core's
// public export surface — only "." is exported from that package). These are
// AUTO-GENERATED deterministic WebAuthn fixtures (software authenticator, ES256,
// synced-passkey flags BE|BS), self-verified against @simplewebauthn/server at
// generation time. Regenerate both copies via scratchpad/gen-webauthn-fixtures.mjs.
const FIXTURE_ORIGIN = "http://127.0.0.1:8791";
const FIXTURE_RPID = "127.0.0.1";
const FIXTURE_CLAIMS = {
  envelope_hash: "sha256:fixture-envelope",
  consent_text_hash: "sha256:fixture-consent-text",
  field_purposes_hash: "sha256:fixture-field-purposes",
  destination_policy_hash: "sha256:fixture-destination-policy",
  nonce: "fixture-nonce-0001"
} as const;
const FIXTURE_USER_HANDLE = "d2F0YXN1LWZpeHR1cmUtdXNlci1oYW5kbGUtMDAwMQ";

const REG_FIXTURE = {
  id: "d2F0YXN1LWZpeHR1cmUtY3JlZGVudGlhbC1pZC0wMQ",
  rawId: "d2F0YXN1LWZpeHR1cmUtY3JlZGVudGlhbC1pZC0wMQ",
  type: "public-key",
  response: {
    clientDataJSON:
      "eyJ0eXBlIjoid2ViYXV0aG4uY3JlYXRlIiwiY2hhbGxlbmdlIjoiQUpUVmcwUVhQbGRodmNrekJfUDkxU25jOXdMMjBDbFE5X3dWS0Nkeml0RSIsIm9yaWdpbiI6Imh0dHA6Ly8xMjcuMC4wLjE6ODc5MSIsImNyb3NzT3JpZ2luIjpmYWxzZX0",
    attestationObject:
      "o2NmbXRkbm9uZWdhdHRTdG10oGhhdXRoRGF0YVijEsoXtJryKJQ28wPgFmAwoh5SXSZuIJJnQzgBqP1AcaBdAAAAAAAAAAAAAAAAAAAAAAAAAAAAH3dhdGFzdS1maXh0dXJlLWNyZWRlbnRpYWwtaWQtMDGlAQIDJiABIVgg-YgFUoTU4q_i6mmaqJQVYyFU8hzflcrjZgiWt0x2aukiWCAUh8B6m1imZ6ecToIaAfqUQyGRPfhn6DciWXoJI7AR6g",
    transports: ["internal", "hybrid"]
  },
  clientExtensionResults: {},
  authenticatorAttachment: "platform"
} as unknown as RegistrationResponseJSON;

const AUTH_FIXTURE = {
  id: "d2F0YXN1LWZpeHR1cmUtY3JlZGVudGlhbC1pZC0wMQ",
  rawId: "d2F0YXN1LWZpeHR1cmUtY3JlZGVudGlhbC1pZC0wMQ",
  type: "public-key",
  response: {
    clientDataJSON:
      "eyJ0eXBlIjoid2ViYXV0aG4uZ2V0IiwiY2hhbGxlbmdlIjoiQUpUVmcwUVhQbGRodmNrekJfUDkxU25jOXdMMjBDbFE5X3dWS0Nkeml0RSIsIm9yaWdpbiI6Imh0dHA6Ly8xMjcuMC4wLjE6ODc5MSIsImNyb3NzT3JpZ2luIjpmYWxzZX0",
    authenticatorData: "EsoXtJryKJQ28wPgFmAwoh5SXSZuIJJnQzgBqP1AcaAdAAAAAA",
    signature:
      "MEYCIQDLYzacFInivUjiWlx30rLl5qn_Omh7RQy_tjnJr7MeWgIhAMvdqG7_CSmZAdOS8Sb3Ao-os65VST6PnqExXRq0575z",
    userHandle: "d2F0YXN1LWZpeHR1cmUtdXNlci1oYW5kbGUtMDAwMQ"
  },
  clientExtensionResults: {}
} as unknown as AuthenticationResponseJSON;

const signingSecret = "consent-app-signing-secret-with-enough-entropy-0000";
const clock = () => new Date("2026-07-05T00:00:01.000Z");

const tokenParams = {
  tenant_id: "tenant-a",
  request_id: "consent-gated-intake",
  request_version: "v1",
  idempotency_key: "submit-consent-001",
  ...FIXTURE_CLAIMS,
  issued_at: new Date("2026-07-05T00:00:00.000Z"),
  ttl_seconds: 600
};

function createApp(credentialStore: InMemoryCredentialStore = new InMemoryCredentialStore()) {
  return {
    app: createHostedConsentApp({
      publicBaseUrl: FIXTURE_ORIGIN,
      signingSecret,
      clock,
      allowedOrigins: [FIXTURE_ORIGIN],
      rpID: FIXTURE_RPID,
      idempotencyStore: new InMemoryIdempotencyStore(),
      approvalStore: new InMemoryConsentApprovalStore(),
      credentialStore
    }),
    credentialStore
  };
}

function get(path: string): HostedConsentRequest {
  return { method: "GET", path, headers: {}, body: "" };
}

describe("hosted consent app", () => {
  test("test_consent_page_renders_challenge_and_approve_url", async () => {
    const { app } = createApp();
    const minted = await mintConsentToken(tokenParams, signingSecret);
    const challenge = buildConsentChallenge(tokenParams);

    const response = await app.handle(
      get(`/requests/consent-gated-intake/consent/${minted.token}`)
    );

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain(challenge);
    expect(response.body).toContain("navigator.credentials.get");
  });

  test("test_consent_page_rejects_expired_token_with_410", async () => {
    const minted = await mintConsentToken(tokenParams, signingSecret);

    const expiredApp = createHostedConsentApp({
      publicBaseUrl: FIXTURE_ORIGIN,
      signingSecret,
      clock: () => new Date("2026-07-05T01:00:00.000Z"),
      allowedOrigins: [FIXTURE_ORIGIN],
      rpID: FIXTURE_RPID,
      idempotencyStore: new InMemoryIdempotencyStore(),
      approvalStore: new InMemoryConsentApprovalStore(),
      credentialStore: new InMemoryCredentialStore()
    });

    const response = await expiredApp.handle(
      get(`/requests/consent-gated-intake/consent/${minted.token}`)
    );

    expect(response.status).toBe(410);
    expect(JSON.parse(response.body).error.code).toBe("consent_token_expired");
  });

  test("test_approve_registration_creates_credential_and_status_returns_receipt", async () => {
    const { app, credentialStore } = createApp();
    const minted = await mintConsentToken(tokenParams, signingSecret);
    const base = `/requests/consent-gated-intake/consent/${minted.token}`;

    // Before approval, status is pending.
    const pending = await app.handle(get(`${base}/status`));
    expect(JSON.parse(pending.body)).toEqual({ ok: true, status: "pending" });

    const approve = await app.handle({
      method: "POST",
      path: `${base}/approve`,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "registration",
        user_handle: FIXTURE_USER_HANDLE,
        response: REG_FIXTURE
      })
    });

    expect(approve.status).toBe(200);
    const approveBody = JSON.parse(approve.body);
    expect(approveBody.status).toBe("approved");
    expect(typeof approveBody.receipt).toBe("string");

    // Registration must persist a credential record with the fixture's BE/BS.
    const stored = await credentialStore.findByCredentialId(REG_FIXTURE.id);
    expect(stored).toBeDefined();
    expect(stored?.backupEligible).toBe(true);
    expect(stored?.backupState).toBe(true);
    expect(stored?.userHandle).toBe(FIXTURE_USER_HANDLE);

    // The minted receipt carries the same assurance signals.
    const decoded = await verifyConsentReceipt(approveBody.receipt, signingSecret, clock());
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.receipt.backup_eligible).toBe(true);
      expect(decoded.receipt.backup_state).toBe(true);
      expect(decoded.receipt.credential_id).toBe(REG_FIXTURE.id);
    }

    // After approval, the agent's poll returns the same receipt.
    const status = await app.handle(get(`${base}/status`));
    const statusBody = JSON.parse(status.body);
    expect(statusBody.status).toBe("approved");
    expect(statusBody.receipt).toBe(approveBody.receipt);
  });

  test("test_approve_authentication_verifies_against_stored_credential", async () => {
    // Pre-seed the store by registering first, exactly as a real device would
    // do once before subsequent authentication ceremonies.
    const { app: registerApp, credentialStore } = createApp();
    const registerMinted = await mintConsentToken(tokenParams, signingSecret);
    const registerBase = `/requests/consent-gated-intake/consent/${registerMinted.token}`;
    const registerApprove = await registerApp.handle({
      method: "POST",
      path: `${registerBase}/approve`,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "registration",
        user_handle: FIXTURE_USER_HANDLE,
        response: REG_FIXTURE
      })
    });
    expect(registerApprove.status).toBe(200);

    // A fresh app (its own approval/idempotency stores) reusing the same
    // credential store and the same token params — the nonce is only
    // scoped within an app's in-memory approval store, and the fixture's
    // embedded challenge is bound to FIXTURE_CLAIMS's exact nonce, so it
    // cannot change here.
    const { app } = createApp(credentialStore);
    const minted = await mintConsentToken(tokenParams, signingSecret);
    const base = `/requests/consent-gated-intake/consent/${minted.token}`;

    const approve = await app.handle({
      method: "POST",
      path: `${base}/approve`,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "authentication", response: AUTH_FIXTURE })
    });

    expect(approve.status).toBe(200);
    const approveBody = JSON.parse(approve.body);
    expect(approveBody.status).toBe("approved");
    expect(typeof approveBody.receipt).toBe("string");
  });

  test("test_approve_rejects_authentication_for_unknown_credential", async () => {
    const { app } = createApp();
    const minted = await mintConsentToken(tokenParams, signingSecret);
    const base = `/requests/consent-gated-intake/consent/${minted.token}`;

    const approve = await app.handle({
      method: "POST",
      path: `${base}/approve`,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "authentication", response: AUTH_FIXTURE })
    });

    expect(approve.status).toBe(401);
    expect(JSON.parse(approve.body).error.code).toBe("credential_unknown");

    // A rejected approval leaves status pending.
    const status = await app.handle(get(`${base}/status`));
    expect(JSON.parse(status.body).status).toBe("pending");
  });
});
