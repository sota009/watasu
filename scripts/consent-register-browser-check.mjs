#!/usr/bin/env node
// Manual end-to-end smoke harness for the passkey consent gate.
//
// What it does: stands up a real HTTP server serving the hosted consent app
// (the same `createHostedConsentApp` used in production), mints a consent
// token for a demo payload, and prints the consent URL with the plaintext
// payload carried only in the URL fragment (never sent to the server).
//
// How to run:
//   node scripts/consent-register-browser-check.mjs
// then open the printed URL in a WebAuthn-capable browser. The first tap of
// "Approve with passkey" registers a new platform passkey and approves the
// consent in one gesture; later taps (or a second run against the same
// origin) authenticate with the already-registered passkey instead.
//
// This is a manual smoke check only — it requires an actual user gesture in
// a real browser and cannot be exercised headlessly end-to-end. The
// automated test suite verifies the WebAuthn ceremony logic via the
// committed deterministic fixtures in packages/core/src/webauthn.fixtures.ts;
// this script is just for eyeballing the real browser flow.

import { createHash } from "node:crypto";
import {
  createHostedConsentApp,
  createHostedProductionServer
} from "../packages/http/dist/index.js";
import {
  mintConsentToken,
  InMemoryIdempotencyStore,
  InMemoryConsentApprovalStore,
  InMemoryCredentialStore
} from "../packages/core/dist/index.js";

const port = 8792;
const publicBaseUrl = "http://127.0.0.1:8792";
const rpID = "127.0.0.1";
const secret = "consent-register-browser-check";

function sha256Base64Url(value) {
  return createHash("sha256").update(value).digest("base64url");
}

// Demo payload — this rides ONLY in the URL fragment, never in a
// server-visible field. The server only ever sees its hash.
const payload = {
  name: "Ada Lovelace",
  email: "ada@example.com",
  note: "Demo submission for the consent-register browser check."
};
const payloadJson = JSON.stringify(payload, null, 2);
const envelopeHash = `sha256:${sha256Base64Url(payloadJson)}`;

const requestId = "browser-check-request";
const requestVersion = "v1";
const idempotencyKey = "browser-check-idempotency-key";

const consentTextHash = `sha256:${sha256Base64Url("consent text: browser check")}`;
const fieldPurposesHash = `sha256:${sha256Base64Url("field purposes: browser check")}`;
const destinationPolicyHash = `sha256:${sha256Base64Url("destination policy: browser check")}`;

const minted = await mintConsentToken(
  {
    tenant_id: "browser-check-tenant",
    request_id: requestId,
    request_version: requestVersion,
    idempotency_key: idempotencyKey,
    envelope_hash: envelopeHash,
    consent_text_hash: consentTextHash,
    field_purposes_hash: fieldPurposesHash,
    destination_policy_hash: destinationPolicyHash,
    issued_at: new Date(),
    ttl_seconds: 3600
  },
  secret
);

const consentApp = createHostedConsentApp({
  publicBaseUrl,
  signingSecret: secret,
  clock: () => new Date(),
  allowedOrigins: [publicBaseUrl],
  idempotencyStore: new InMemoryIdempotencyStore(),
  approvalStore: new InMemoryConsentApprovalStore(),
  credentialStore: new InMemoryCredentialStore(),
  rpID
});

const consentRoutePattern = /^\/requests\/[^/]+\/consent\/[^/]+(\/approve|\/status)?$/;

/** @type {import("../packages/http/dist/hosted-production.js").HostedProductionApp} */
const app = {
  async handle(request) {
    if (consentRoutePattern.test(request.path)) {
      return consentApp.handle(request);
    }

    return {
      status: 404,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: `${JSON.stringify({ ok: false, error: { code: "not_found", message: "Not found." } })}\n`
    };
  }
};

const server = createHostedProductionServer(app);

server.listen(port, "127.0.0.1", () => {
  const consentUrl =
    `${publicBaseUrl}/requests/${requestId}/consent/${minted.token}` +
    `#${encodeURIComponent(payloadJson)}`;

  process.stdout.write("READY\n");
  process.stdout.write(`${consentUrl}\n`);
});
