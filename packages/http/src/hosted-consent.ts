import {
  buildConsentChallenge,
  mintConsentReceipt,
  verifyConsentAuthentication,
  verifyConsentRegistration,
  verifyConsentToken,
  type AsyncIdempotencyStore,
  type AuthenticationResponseJSON,
  type ConsentApprovalStore,
  type ConsentTokenClaims,
  type CredentialStore,
  type RegistrationResponseJSON
} from "@watasu/core";
import { randomBytes } from "node:crypto";
import { decodeHostedRequestIdSegment } from "./hosted-route.js";

export interface HostedConsentRequest {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  body: string;
}

export interface HostedConsentResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface HostedConsentApp {
  handle(request: HostedConsentRequest): Promise<HostedConsentResponse>;
}

export interface CreateHostedConsentAppInput {
  publicBaseUrl: string;
  /** Reuses the delivery signing secret to verify tokens and mint receipts. */
  signingSecret: string;
  clock: () => Date;
  /** Origins the WebAuthn ceremony may have been produced under. */
  allowedOrigins: readonly string[];
  /** Relying Party ID the WebAuthn ceremony was scoped to. */
  rpID: string;
  idempotencyStore: AsyncIdempotencyStore;
  approvalStore: ConsentApprovalStore;
  /** Registered-credential storage, shared across registration and authentication approvals. */
  credentialStore: CredentialStore;
  receiptTtlSeconds?: number | undefined;
}

type ApproveBody =
  | { type: "registration"; user_handle: string; response: RegistrationResponseJSON }
  | { type: "authentication"; response: AuthenticationResponseJSON };

const defaultReceiptTtlSeconds = 60 * 60;

export function createHostedConsentApp(input: CreateHostedConsentAppInput): HostedConsentApp {
  return {
    async handle(request) {
      const route = matchConsentRoute(request.path);
      if (route === undefined) {
        return notFound();
      }

      const verification = await verifyConsentToken(route.token, input.signingSecret, input.clock());
      if (!verification.ok) {
        return jsonResponse(route.action === "page" ? 410 : 401, {
          ok: false,
          status: "rejected",
          error: verification.error
        });
      }

      const claims = verification.claims;
      if (claims.request_id !== route.requestId) {
        return jsonResponse(400, {
          ok: false,
          status: "rejected",
          error: {
            code: "consent_request_mismatch",
            message: "Consent token does not match the request in the URL."
          }
        });
      }

      if (route.action === "page") {
        if (request.method !== "GET") {
          return notFound();
        }

        return renderConsentPage(claims, input.publicBaseUrl, route.token, input.rpID);
      }

      if (route.action === "status") {
        if (request.method !== "GET") {
          return notFound();
        }

        const receipt = input.approvalStore.getApproved(claims.nonce);
        return jsonResponse(
          200,
          receipt === undefined
            ? { ok: true, status: "pending" }
            : { ok: true, status: "approved", receipt }
        );
      }

      // route.action === "approve"
      if (request.method !== "POST") {
        return notFound();
      }

      return approveConsent(input, claims, request.body);
    }
  };
}

async function approveConsent(
  input: CreateHostedConsentAppInput,
  claims: ConsentTokenClaims,
  rawBody: string
): Promise<HostedConsentResponse> {
  // Idempotent: a completed approval always returns the same receipt.
  const existingReceipt = input.approvalStore.getApproved(claims.nonce);
  if (existingReceipt !== undefined) {
    return jsonResponse(200, { ok: true, status: "approved", receipt: existingReceipt });
  }

  const body = parseApproveBody(rawBody);
  if (body === undefined) {
    return jsonResponse(400, {
      ok: false,
      status: "rejected",
      error: {
        code: "invalid_assertion_body",
        message: "Approve body must be a registration or authentication WebAuthn response."
      }
    });
  }

  const expectedChallenge = buildConsentChallenge({
    envelope_hash: claims.envelope_hash,
    consent_text_hash: claims.consent_text_hash,
    field_purposes_hash: claims.field_purposes_hash,
    destination_policy_hash: claims.destination_policy_hash,
    nonce: claims.nonce
  });

  let credentialId: string;
  let assurance: { backupEligible: boolean; backupState: boolean };

  if (body.type === "registration") {
    const reg = await verifyConsentRegistration({
      response: body.response,
      expectedChallenge,
      expectedOrigins: input.allowedOrigins,
      expectedRPID: input.rpID
    });
    if (!reg.ok) {
      return jsonResponse(401, { ok: false, status: "rejected", error: reg.error });
    }

    credentialId = reg.credential.credentialId;
    assurance = {
      backupEligible: reg.credential.backupEligible,
      backupState: reg.credential.backupState
    };
    await input.credentialStore.save({
      credentialId,
      publicKey: reg.credential.publicKey as Uint8Array,
      signCount: reg.credential.signCount,
      backupEligible: reg.credential.backupEligible,
      backupState: reg.credential.backupState,
      userHandle: body.user_handle,
      ...(reg.credential.transports !== undefined ? { transports: reg.credential.transports } : {}),
      ...(reg.credential.aaguid !== undefined ? { aaguid: reg.credential.aaguid } : {}),
      createdAt: input.clock().toISOString()
    });
  } else {
    const stored = await input.credentialStore.findByCredentialId(body.response.id);
    if (stored === undefined) {
      return jsonResponse(401, {
        ok: false,
        status: "rejected",
        error: {
          code: "credential_unknown",
          message: "Credential is not registered for this consent."
        }
      });
    }

    const auth = await verifyConsentAuthentication({
      response: body.response,
      expectedChallenge,
      expectedOrigins: input.allowedOrigins,
      expectedRPID: input.rpID,
      credential: {
        id: stored.credentialId,
        publicKey: stored.publicKey,
        counter: stored.signCount,
        ...(stored.transports !== undefined ? { transports: stored.transports } : {})
      }
    });
    if (!auth.ok) {
      return jsonResponse(401, { ok: false, status: "rejected", error: auth.error });
    }

    credentialId = stored.credentialId;
    assurance = {
      backupEligible: auth.credential.backupEligible,
      backupState: auth.credential.backupState
    };
    await input.credentialStore.updateSignCount(stored.credentialId, auth.credential.signCount);
  }

  // Single-use / replay protection rides the existing IdempotencyStore.
  const now = input.clock();
  const claimKey = `consent-approve:${claims.nonce}`;
  const claimed = await input.idempotencyStore.claimValidation(claimKey, {
    request_id: claims.request_id,
    request_version: claims.request_version,
    idempotency_key: claims.idempotency_key,
    submitted_at: new Date(claims.exp * 1000).toISOString(),
    claimed_at: now.toISOString(),
    status: "validation_accepted"
  });
  if (!claimed) {
    const raced = input.approvalStore.getApproved(claims.nonce);
    if (raced !== undefined) {
      return jsonResponse(200, { ok: true, status: "approved", receipt: raced });
    }

    return jsonResponse(409, {
      ok: false,
      status: "rejected",
      error: {
        code: "consent_already_spent",
        message: "This consent token has already been used."
      }
    });
  }

  const receipt = await mintConsentReceipt(
    {
      envelope_hash: claims.envelope_hash,
      consent_text_hash: claims.consent_text_hash,
      field_purposes_hash: claims.field_purposes_hash,
      destination_policy_hash: claims.destination_policy_hash,
      credential_id: credentialId,
      approved_at: now,
      nonce: claims.nonce,
      ttl_seconds: input.receiptTtlSeconds ?? defaultReceiptTtlSeconds,
      backup_eligible: assurance.backupEligible,
      backup_state: assurance.backupState
    },
    input.signingSecret
  );
  input.approvalStore.markApproved(claims.nonce, receipt);

  return jsonResponse(200, { ok: true, status: "approved", receipt });
}

function parseApproveBody(rawBody: string): ApproveBody | undefined {
  let parsed: unknown;
  try {
    parsed = rawBody.length === 0 ? {} : JSON.parse(rawBody);
  } catch {
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }

  const record = parsed as Record<string, unknown>;
  if (record.response === undefined || typeof record.response !== "object" || record.response === null) {
    return undefined;
  }

  if (record.type === "registration") {
    if (typeof record.user_handle !== "string") {
      return undefined;
    }

    return {
      type: "registration",
      user_handle: record.user_handle,
      response: record.response as RegistrationResponseJSON
    };
  }

  if (record.type === "authentication") {
    return {
      type: "authentication",
      response: record.response as AuthenticationResponseJSON
    };
  }

  return undefined;
}

function renderConsentPage(
  claims: ConsentTokenClaims,
  publicBaseUrl: string,
  token: string,
  rpId: string
): HostedConsentResponse {
  const challenge = buildConsentChallenge({
    envelope_hash: claims.envelope_hash,
    consent_text_hash: claims.consent_text_hash,
    field_purposes_hash: claims.field_purposes_hash,
    destination_policy_hash: claims.destination_policy_hash,
    nonce: claims.nonce
  });
  const approveUrl = `${publicBaseUrl}/requests/${encodeURIComponent(claims.request_id)}/consent/${token}/approve`;
  const userHandle = randomBytes(16).toString("base64url");
  const pubKeyCredParams = [
    { type: "public-key", alg: -7 },
    { type: "public-key", alg: -257 },
    { type: "public-key", alg: -8 }
  ];
  const bootstrap = JSON.stringify({
    requestId: claims.request_id,
    requestVersion: claims.request_version,
    envelopeHash: claims.envelope_hash,
    consentTextHash: claims.consent_text_hash,
    fieldPurposesHash: claims.field_purposes_hash,
    destinationPolicyHash: claims.destination_policy_hash,
    challenge,
    approveUrl,
    userHandle,
    rpId,
    pubKeyCredParams
  }).replace(/</g, "\\u003c");

  // The global hosted CSP is `default-src 'none'`, which would block this page's
  // own inline style + passkey script. Scope a tight per-page CSP bound to a
  // fresh nonce: only this page's inline blocks run, approval posts same-origin,
  // nothing else loads. The server preserves a route-set CSP (see hosted-server).
  const nonce = randomBytes(16).toString("base64");
  return {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "content-security-policy":
        `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; ` +
        `connect-src 'self'; img-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`
    },
    body: consentPageHtml(bootstrap, nonce)
  };
}

function consentPageHtml(bootstrapJson: string, nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>watasu — approve this submission</title>
<style nonce="${nonce}">
  :root { color-scheme: light dark; font-family: system-ui, -apple-system, sans-serif; }
  body { margin: 0; padding: 1.5rem; max-width: 34rem; margin-inline: auto; line-height: 1.5; }
  h1 { font-size: 1.25rem; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: .35rem 1rem; }
  dt { font-weight: 600; }
  dd { margin: 0; word-break: break-all; font-variant-numeric: tabular-nums; }
  code, pre { background: rgba(127,127,127,.15); border-radius: .3rem; padding: .1rem .3rem; }
  pre { padding: .75rem; overflow-x: auto; }
  button { font: inherit; padding: .7rem 1.1rem; border-radius: .5rem; border: 0; background: #2563eb; color: #fff; cursor: pointer; }
  button:disabled { opacity: .5; cursor: not-allowed; }
  .status { margin-top: 1rem; padding: .75rem; border-radius: .5rem; }
  .ok { background: rgba(34,197,94,.18); }
  .err { background: rgba(239,68,68,.18); }
  .muted { opacity: .7; font-size: .85rem; }
</style>
</head>
<body>
<h1>Approve this data submission</h1>
<p class="muted">watasu never receives the plaintext below — it stays in your browser (URL fragment) and is verified against the hash the server holds.</p>
<section id="what"></section>
<div id="detail"></div>
<p><button id="approve" disabled>Face IDで承認</button></p>
<div id="status" class="status muted">Verifying payload…</div>
<script type="application/json" id="bootstrap" nonce="${nonce}">${bootstrapJson}</script>
<script nonce="${nonce}">
(function () {
  var cfg = JSON.parse(document.getElementById("bootstrap").textContent);
  var statusEl = document.getElementById("status");
  var approveBtn = document.getElementById("approve");

  function setStatus(msg, cls) {
    statusEl.textContent = msg;
    statusEl.className = "status " + (cls || "muted");
  }
  function b64urlToBytes(s) {
    s = s.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    var bin = atob(s);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function bytesToB64url(buf) {
    var bytes = new Uint8Array(buf);
    var bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
  }
  async function sha256B64url(bytes) {
    var digest = await crypto.subtle.digest("SHA-256", bytes);
    return bytesToB64url(digest);
  }
  function renderPayload(text) {
    var what = document.getElementById("what");
    var detail = document.getElementById("detail");
    var dl = document.createElement("dl");
    function row(k, v) {
      var dt = document.createElement("dt"); dt.textContent = k;
      var dd = document.createElement("dd"); dd.textContent = v;
      dl.appendChild(dt); dl.appendChild(dd);
    }
    row("Request", cfg.requestId + " (" + cfg.requestVersion + ")");
    row("Payload hash", cfg.envelopeHash);
    row("Consent hash", cfg.consentTextHash);
    row("Field purposes hash", cfg.fieldPurposesHash);
    row("Destination policy hash", cfg.destinationPolicyHash);
    what.appendChild(dl);
    var pre = document.createElement("pre");
    try { pre.textContent = JSON.stringify(JSON.parse(text), null, 2); }
    catch (e) { pre.textContent = text; }
    detail.appendChild(pre);
  }

  var fragment = window.location.hash ? decodeURIComponent(window.location.hash.slice(1)) : "";
  if (!fragment) {
    setStatus("No payload was provided in the link fragment. Cannot render for approval.", "err");
    return;
  }

  var enc = new TextEncoder();
  sha256B64url(enc.encode(fragment)).then(function (digest) {
    if ("sha256:" + digest !== cfg.envelopeHash) {
      setStatus("Payload hash does not match the request. Refusing to render.", "err");
      return;
    }
    renderPayload(fragment);
    setStatus("Payload verified. Approve with Face ID to sign.", "ok");
    approveBtn.disabled = false;
  }).catch(function () {
    setStatus("Could not hash the payload in this browser.", "err");
  });

  function regToJSON(c) {
    return {
      id: c.id,
      rawId: bytesToB64url(c.rawId),
      type: c.type,
      response: {
        clientDataJSON: bytesToB64url(c.response.clientDataJSON),
        attestationObject: bytesToB64url(c.response.attestationObject),
        transports: c.response.getTransports ? c.response.getTransports() : []
      },
      clientExtensionResults: c.getClientExtensionResults()
    };
  }
  function authToJSON(c) {
    return {
      id: c.id,
      rawId: bytesToB64url(c.rawId),
      type: c.type,
      response: {
        clientDataJSON: bytesToB64url(c.response.clientDataJSON),
        authenticatorData: bytesToB64url(c.response.authenticatorData),
        signature: bytesToB64url(c.response.signature),
        userHandle: c.response.userHandle ? bytesToB64url(c.response.userHandle) : undefined
      },
      clientExtensionResults: c.getClientExtensionResults()
    };
  }
  async function post(body) {
    var res = await fetch(cfg.approveUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    var data = await res.json();
    if (res.ok && data.status === "approved") {
      setStatus("Approved. You can return to your agent.", "ok");
    } else {
      setStatus("Approval failed: " + ((data.error && data.error.code) || res.status), "err");
      approveBtn.disabled = false;
    }
  }
  // registerMode: with discoverable credentials a failing get() cannot be told
  // apart from a user-cancelled get() — both surface as NotAllowedError. So the
  // first get() failure does NOT silently escalate into a registration prompt
  // (that would shove a returning user who merely cancelled into creating a new
  // passkey). Instead it asks for an explicit second tap, which registers.
  var registerMode = false;

  async function approve() {
    var challenge = b64urlToBytes(cfg.challenge).buffer;

    if (!registerMode) {
      // Returning user: try a discoverable get() first.
      var assertion;
      try {
        assertion = await navigator.credentials.get({
          publicKey: {
            challenge: challenge,
            userVerification: "required",
            timeout: 120000
          }
        });
      } catch (e) {
        // Could be "no passkey exists" OR "user cancelled" — indistinguishable.
        // Ask for an explicit tap to create one rather than escalating silently.
        registerMode = true;
        setStatus("No passkey approved this. Tap 承認 again to create one with Face ID.", "muted");
        approveBtn.disabled = false;
        return;
      }
      return post({ type: "authentication", response: authToJSON(assertion) });
    }

    // Explicit second tap: register a new passkey + consent in one gesture.
    var cred = await navigator.credentials.create({
      publicKey: {
        challenge: challenge,
        rp: { id: cfg.rpId, name: "watasu" },
        user: {
          id: b64urlToBytes(cfg.userHandle),
          name: "watasu user",
          displayName: "watasu user"
        },
        pubKeyCredParams: cfg.pubKeyCredParams,
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
        attestation: "none",
        timeout: 120000
      }
    });
    return post({ type: "registration", user_handle: cfg.userHandle, response: regToJSON(cred) });
  }

  approveBtn.addEventListener("click", async function () {
    approveBtn.disabled = true;
    setStatus("Waiting for Face ID…", "muted");
    try {
      await approve();
    } catch (e) {
      setStatus("Approval was cancelled or failed. Tap to try again.", "err");
      approveBtn.disabled = false;
    }
  });
})();
</script>
</body>
</html>
`;
}

function matchConsentRoute(path: string):
  | { requestId: string; token: string; action: "page" | "approve" | "status" }
  | undefined {
  const match = /^\/requests\/([^/]+)\/consent\/([^/]+)(\/approve|\/status)?$/.exec(path);
  if (match === null) {
    return undefined;
  }

  const requestId = decodeHostedRequestIdSegment(match[1]);
  const token = match[2];
  if (requestId === undefined || token === undefined || token.length === 0) {
    return undefined;
  }

  const suffix = match[3];
  const action = suffix === "/approve" ? "approve" : suffix === "/status" ? "status" : "page";
  return { requestId, token, action };
}

function notFound(): HostedConsentResponse {
  return jsonResponse(404, {
    ok: false,
    error: {
      code: "not_found",
      message: "Hosted consent route was not found."
    }
  });
}

function jsonResponse(
  status: number,
  value: unknown,
  headers: Record<string, string> = {}
): HostedConsentResponse {
  return {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers
    },
    body: `${JSON.stringify(value)}\n`
  };
}
