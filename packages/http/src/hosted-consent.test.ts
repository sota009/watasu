import {
  createHash,
  generateKeyPairSync,
  sign as cryptoSign,
  type JsonWebKey
} from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  buildConsentChallenge,
  InMemoryConsentApprovalStore,
  InMemoryIdempotencyStore,
  mintConsentToken
} from "@watasu/core";
import { createHostedConsentApp, type HostedConsentRequest } from "./hosted-consent.js";

const signingSecret = "consent-app-signing-secret-with-enough-entropy-0000";
const origin = "https://api.watasu.ai";
const clock = () => new Date("2026-07-05T00:00:01.000Z");

const tokenParams = {
  tenant_id: "tenant-a",
  request_id: "consent-gated-intake",
  request_version: "v1",
  idempotency_key: "submit-consent-001",
  envelope_hash: "sha256:envelope-hash",
  consent_text_hash: "sha256:consent-hash",
  nonce: "nonce-approved",
  issued_at: new Date("2026-07-05T00:00:00.000Z"),
  ttl_seconds: 600
};

function buildAssertion(challenge: string): {
  body: string;
  credentialPublicKey: JsonWebKey;
} {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const clientDataBytes = Buffer.from(
    JSON.stringify({ type: "webauthn.get", challenge, origin }),
    "utf8"
  );
  const authenticatorData = Buffer.concat([
    createHash("sha256").update("rp-id").digest(),
    Buffer.from([0x05, 0, 0, 0, 1])
  ]);
  const clientDataHash = createHash("sha256").update(clientDataBytes).digest();
  const signature = cryptoSign(
    "sha256",
    Buffer.concat([authenticatorData, clientDataHash]),
    { key: privateKey, dsaEncoding: "der" }
  );

  return {
    body: JSON.stringify({
      credential_id: "credential-xyz",
      client_data_json: clientDataBytes.toString("base64url"),
      authenticator_data: authenticatorData.toString("base64url"),
      signature: signature.toString("base64url")
    }),
    credentialPublicKey: publicKey.export({ format: "jwk" }) as JsonWebKey
  };
}

function createApp(credentialPublicKey: JsonWebKey | undefined) {
  return createHostedConsentApp({
    publicBaseUrl: origin,
    signingSecret,
    clock,
    allowedOrigins: [origin],
    idempotencyStore: new InMemoryIdempotencyStore(),
    approvalStore: new InMemoryConsentApprovalStore(),
    resolveCredentialPublicKey: () => credentialPublicKey
  });
}

function get(path: string): HostedConsentRequest {
  return { method: "GET", path, headers: {}, body: "" };
}

describe("hosted consent app", () => {
  test("test_consent_page_renders_challenge_and_approve_url", async () => {
    const app = createApp(undefined);
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
      publicBaseUrl: origin,
      signingSecret,
      clock: () => new Date("2026-07-05T01:00:00.000Z"),
      allowedOrigins: [origin],
      idempotencyStore: new InMemoryIdempotencyStore(),
      approvalStore: new InMemoryConsentApprovalStore(),
      resolveCredentialPublicKey: () => undefined
    });

    const response = await expiredApp.handle(
      get(`/requests/consent-gated-intake/consent/${minted.token}`)
    );

    expect(response.status).toBe(410);
    expect(JSON.parse(response.body).error.code).toBe("consent_token_expired");
  });

  test("test_approve_verifies_assertion_and_status_returns_receipt", async () => {
    const challenge = buildConsentChallenge(tokenParams);
    const assertion = buildAssertion(challenge);
    const app = createApp(assertion.credentialPublicKey);
    const minted = await mintConsentToken(tokenParams, signingSecret);
    const base = `/requests/consent-gated-intake/consent/${minted.token}`;

    // Before approval, status is pending.
    const pending = await app.handle(get(`${base}/status`));
    expect(JSON.parse(pending.body)).toEqual({ ok: true, status: "pending" });

    const approve = await app.handle({
      method: "POST",
      path: `${base}/approve`,
      headers: { "content-type": "application/json" },
      body: assertion.body
    });

    expect(approve.status).toBe(200);
    const approveBody = JSON.parse(approve.body);
    expect(approveBody.status).toBe("approved");
    expect(typeof approveBody.receipt).toBe("string");

    // After approval, the agent's poll returns the same receipt.
    const status = await app.handle(get(`${base}/status`));
    const statusBody = JSON.parse(status.body);
    expect(statusBody.status).toBe("approved");
    expect(statusBody.receipt).toBe(approveBody.receipt);
  });

  test("test_approve_rejects_forged_assertion", async () => {
    const challenge = buildConsentChallenge(tokenParams);
    const assertion = buildAssertion(challenge);
    // Resolver returns a different key than the one that signed.
    const otherKey = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const app = createApp(otherKey.publicKey.export({ format: "jwk" }) as JsonWebKey);
    const minted = await mintConsentToken(tokenParams, signingSecret);
    const base = `/requests/consent-gated-intake/consent/${minted.token}`;

    const approve = await app.handle({
      method: "POST",
      path: `${base}/approve`,
      headers: { "content-type": "application/json" },
      body: assertion.body
    });

    expect(approve.status).toBe(401);
    expect(JSON.parse(approve.body).error.code).toBe("webauthn_signature_invalid");

    // A rejected approval leaves status pending.
    const status = await app.handle(get(`${base}/status`));
    expect(JSON.parse(status.body).status).toBe("pending");
  });
});
