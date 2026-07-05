# watasu Passkey Registration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add passkey registration to watasu's consent gate so a first-time user registers a passkey inline and approves in one gesture, and a returning user approves with one tap — while migrating verification off the hand-rolled ES256 code to `@simplewebauthn/server`.

**Architecture:** A new `CredentialStore` (in-memory now) persists `{credentialId → public key, BE/BS, userHandle}`. Discoverable credentials make the passkey the identity (no login). The registration `create()` uses the payload-bound consent challenge, so first-time registration *is* the consent signature. `approveConsent` branches on a discriminated body (`registration` vs `authentication`).

**Tech Stack:** TypeScript (TS 6), Node ≥22, pnpm workspace, Vitest 4, `@simplewebauthn/server` v13.3.2, `jose` (existing), WebAuthn Level 3.

## Global Constraints

- Node ≥22, TypeScript 6, ESM (`"type": "module"`), `.js` import specifiers in TS source.
- Green gate before every commit: `pnpm test` (runs `pnpm typecheck` then `vitest run`). Expected baseline: prior tests pass; 0 new failures.
- Stage explicit paths (never `git add -A`). Commit trailer:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` and the session line.
- Preserve invariants: §13 payload-binding (challenge = `buildConsentChallenge(...)` for both register and assert), no-custody (plaintext only in URL fragment), stateless consent token, per-page nonce CSP.
- `userVerification: "required"`, `attestation: "none"`, `residentKey: "required"`.
- OUT OF SCOPE (do not implement): OTP fallback, durable Postgres store, device-bound enforcement.
- Verify SimpleWebAuthn field names against the installed `@simplewebauthn/server` `.d.ts` when noted — do not guess if the installed types differ.

---

### Task 1: Add dependency + `CredentialStore`

**Files:**
- Modify: `packages/core/package.json` (add dependency)
- Create: `packages/core/src/credential-store.ts`
- Create: `packages/core/src/credential-store.test.ts`
- Modify: `packages/core/src/index.ts` (exports)

**Interfaces:**
- Produces: `CredentialRecord` type; `CredentialStore` interface with `save(record): Promise<void>`, `findByCredentialId(id): Promise<CredentialRecord | undefined>`, `updateSignCount(id, signCount): Promise<void>`; `InMemoryCredentialStore` class.

- [ ] **Step 1: Add the dependency**

Run: `pnpm --filter @watasu/core add @simplewebauthn/server@13.3.2`
Expected: `packages/core/package.json` gains `"@simplewebauthn/server": "13.3.2"` under `dependencies`; lockfile updates.

- [ ] **Step 2: Write the failing test** — `packages/core/src/credential-store.test.ts`

```ts
import { describe, expect, test } from "vitest";
import { InMemoryCredentialStore, type CredentialRecord } from "./credential-store.js";

function record(overrides: Partial<CredentialRecord> = {}): CredentialRecord {
  return {
    credentialId: "cred-123",
    publicKey: new Uint8Array([1, 2, 3]),
    signCount: 0,
    backupEligible: true,
    backupState: true,
    userHandle: "user-abc",
    transports: ["internal", "hybrid"],
    aaguid: "00000000-0000-0000-0000-000000000000",
    createdAt: "2026-07-05T00:00:00.000Z",
    ...overrides
  };
}

describe("InMemoryCredentialStore", () => {
  test("test_save_then_find_returns_record", async () => {
    const store = new InMemoryCredentialStore();
    await store.save(record());
    expect(await store.findByCredentialId("cred-123")).toEqual(record());
  });

  test("test_find_unknown_returns_undefined", async () => {
    const store = new InMemoryCredentialStore();
    expect(await store.findByCredentialId("nope")).toBeUndefined();
  });

  test("test_update_sign_count_persists", async () => {
    const store = new InMemoryCredentialStore();
    await store.save(record({ signCount: 0 }));
    await store.updateSignCount("cred-123", 5);
    expect((await store.findByCredentialId("cred-123"))?.signCount).toBe(5);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @watasu/core exec vitest run src/credential-store.test.ts`
Expected: FAIL — cannot find module `./credential-store.js`.

- [ ] **Step 4: Implement** — `packages/core/src/credential-store.ts`

```ts
export interface CredentialRecord {
  /** base64url credential id — primary key. */
  credentialId: string;
  /** COSE public key bytes (from SimpleWebAuthn registrationInfo). */
  publicKey: Uint8Array;
  signCount: number;
  /** BE flag — the credential is sync-eligible (multiDevice). */
  backupEligible: boolean;
  /** BS flag — the credential is currently backed up/synced. */
  backupState: boolean;
  /** watasu-minted opaque id for the discoverable credential. */
  userHandle: string;
  transports?: string[];
  /** authenticator model id (analytics only). */
  aaguid?: string;
  createdAt: string;
}

export interface CredentialStore {
  save(record: CredentialRecord): Promise<void>;
  findByCredentialId(id: string): Promise<CredentialRecord | undefined>;
  updateSignCount(id: string, signCount: number): Promise<void>;
}

export class InMemoryCredentialStore implements CredentialStore {
  readonly #byCredentialId = new Map<string, CredentialRecord>();

  async save(record: CredentialRecord): Promise<void> {
    this.#byCredentialId.set(record.credentialId, { ...record });
  }

  async findByCredentialId(id: string): Promise<CredentialRecord | undefined> {
    const found = this.#byCredentialId.get(id);
    return found === undefined ? undefined : { ...found };
  }

  async updateSignCount(id: string, signCount: number): Promise<void> {
    const found = this.#byCredentialId.get(id);
    if (found !== undefined) {
      this.#byCredentialId.set(id, { ...found, signCount });
    }
  }
}
```

- [ ] **Step 5: Add exports** — in `packages/core/src/index.ts`, add:

```ts
export {
  InMemoryCredentialStore
} from "./credential-store.js";
export type {
  CredentialRecord,
  CredentialStore
} from "./credential-store.js";
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @watasu/core exec vitest run src/credential-store.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add packages/core/package.json pnpm-lock.yaml packages/core/src/credential-store.ts packages/core/src/credential-store.test.ts packages/core/src/index.ts
git commit -m "feat(consent-gate): add CredentialStore + @simplewebauthn/server dep"
```

---

### Task 2: WebAuthn verify wrappers over SimpleWebAuthn

**Files:**
- Create: `packages/core/src/webauthn.ts`
- Create: `packages/core/src/webauthn.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `verifyConsentRegistration(input): Promise<ConsentWebAuthnResult>` where
    `input = { response: RegistrationResponseJSON, expectedChallenge: string, expectedOrigins: readonly string[], expectedRPID: string }` and
    `ConsentWebAuthnResult = { ok: true; credential: { credentialId: string; publicKey: Uint8Array; signCount: number; backupEligible: boolean; backupState: boolean; aaguid?: string; transports?: string[] } } | { ok: false; error: { code: string; message: string } }`.
  - `verifyConsentAuthentication(input): Promise<ConsentWebAuthnResult>` where
    `input = { response: AuthenticationResponseJSON, expectedChallenge: string, expectedOrigins: readonly string[], expectedRPID: string, credential: { id: string; publicKey: Uint8Array; counter: number; transports?: string[] } }` and on success returns `{ ok: true; credential: { credentialId; signCount(=newCounter); backupEligible; backupState } }` (publicKey omitted on auth path).
- `RegistrationResponseJSON` / `AuthenticationResponseJSON` are re-exported from `@simplewebauthn/server`.

- [ ] **Step 1: Write the failing test** — `packages/core/src/webauthn.test.ts`

> Fixtures: use `@simplewebauthn/server`'s own test helpers if present; otherwise capture one real `RegistrationResponseJSON` and one `AuthenticationResponseJSON` from a browser run of the local runner (Task 7) and paste them as constants. Do NOT hand-fabricate COSE bytes. The test below asserts the wrapper's *shape and challenge/RPID plumbing*; the crypto is SimpleWebAuthn's job.

```ts
import { describe, expect, test } from "vitest";
import { verifyConsentRegistration } from "./webauthn.js";

// REG_FIXTURE: a real RegistrationResponseJSON captured from a browser run,
// created with challenge = FIXTURE_CHALLENGE, origin = FIXTURE_ORIGIN, rpID = FIXTURE_RPID.
import { REG_FIXTURE, FIXTURE_CHALLENGE, FIXTURE_ORIGIN, FIXTURE_RPID } from "./webauthn.fixtures.js";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @watasu/core exec vitest run src/webauthn.test.ts`
Expected: FAIL — cannot find module `./webauthn.js` (and `./webauthn.fixtures.js`).

- [ ] **Step 3: Implement** — `packages/core/src/webauthn.ts`

```ts
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
  // NOTE: confirm field names against installed @simplewebauthn/server d.ts.
  // v13: verification.registrationInfo = { credential: { id, publicKey, counter, transports },
  //      credentialDeviceType, credentialBackedUp, aaguid }.
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
      transports: info.credential.transports
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
        publicKey: input.credential.publicKey,
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
```

- [ ] **Step 4: Create the fixtures** — `packages/core/src/webauthn.fixtures.ts`

Generate real fixtures rather than fabricate them. Two acceptable sources:
1. Preferred: run the local browser runner (Task 7) once, capture the POSTed `registration` and `authentication` bodies, and paste them here with the exact `FIXTURE_CHALLENGE`/`FIXTURE_ORIGIN`/`FIXTURE_RPID` used.
2. Alternative: use `@simplewebauthn/server`'s published example fixtures (see its repo `packages/server/src/**/*.test.ts`).

```ts
// Captured from a real browser run. See Task 7 for how to regenerate.
export const FIXTURE_ORIGIN = "http://127.0.0.1:8791";
export const FIXTURE_RPID = "127.0.0.1";
export const FIXTURE_CHALLENGE = "sha256:REPLACE_WITH_CAPTURED_CHALLENGE";
export const REG_FIXTURE = /* RegistrationResponseJSON */ { /* captured */ } as const;
export const AUTH_FIXTURE = /* AuthenticationResponseJSON */ { /* captured */ } as const;
```

- [ ] **Step 5: Add exports** — in `packages/core/src/index.ts`:

```ts
export {
  verifyConsentRegistration,
  verifyConsentAuthentication
} from "./webauthn.js";
export type {
  ConsentWebAuthnResult,
  ConsentWebAuthnCredential,
  RegistrationResponseJSON,
  AuthenticationResponseJSON
} from "./webauthn.js";
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @watasu/core exec vitest run src/webauthn.test.ts`
Expected: PASS. (If fixtures are not yet captured, mark this task blocked on Task 7's first browser run, then return.)

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/webauthn.ts packages/core/src/webauthn.test.ts packages/core/src/webauthn.fixtures.ts packages/core/src/index.ts
git commit -m "feat(consent-gate): SimpleWebAuthn register/authenticate verify wrappers"
```

---

### Task 3: Remove hand-rolled verifier; add assurance to the receipt

**Files:**
- Modify: `packages/core/src/consent.ts` (remove verifier block ~lines 170-272; extend receipt)
- Modify: `packages/core/src/index.ts` (drop removed exports)
- Modify: `packages/core/src/consent.test.ts` (drop tests of removed verifier)

**Interfaces:**
- Produces: `ConsentReceipt` and `MintConsentReceiptParams` gain `backup_eligible: boolean` and `backup_state: boolean`. `mintConsentReceipt` writes them into the JWS.
- Removes: `verifyWebAuthnAssertion`, `VerifyWebAuthnAssertionInput`, `WebAuthnAssertionError`, `WebAuthnAssertionResult`, `WebAuthnSignatureVerifier`, `es256SignatureVerifier`.

- [ ] **Step 1: Write the failing test** — add to `packages/core/src/consent.test.ts`

```ts
import { mintConsentReceipt, verifyConsentReceipt } from "./consent.js";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @watasu/core exec vitest run src/consent.test.ts -t assurance`
Expected: FAIL — object literal may only specify known properties (`backup_eligible`).

- [ ] **Step 3: Implement — extend the receipt**

In `packages/core/src/consent.ts`, add to `ConsentReceipt` and `MintConsentReceiptParams`:

```ts
  backup_eligible: boolean;
  backup_state: boolean;
```

In `mintConsentReceipt`, add to the `SignJWT({...})` body:

```ts
    backup_eligible: params.backup_eligible,
    backup_state: params.backup_state,
```

In `extractConsentReceipt` (the parser near the bottom of consent.ts), require and copy the two boolean fields (follow the existing string-field validation pattern; reject if not `typeof === "boolean"`).

- [ ] **Step 4: Remove the hand-rolled verifier block**

Delete from `consent.ts` the section from the `// WebAuthn assertion verification.` comment through the end of `verifyWebAuthnAssertion` and its helpers `parseWebAuthnClientData` / `assertionError` / `constantTimeEquals` **if unused elsewhere** (grep first: `grep -n "constantTimeEquals\|parseWebAuthnClientData\|assertionError" packages/core/src/consent.ts`). Remove now-unused imports (`createPublicKey`, `verify as cryptoVerify`) if no other consumer remains. Remove the corresponding exports from `index.ts`.

- [ ] **Step 5: Delete the obsolete verifier tests**

In `consent.test.ts`, delete tests that call `verifyWebAuthnAssertion` / `es256SignatureVerifier` (the crypto is now SimpleWebAuthn's, covered in `webauthn.test.ts`).

- [ ] **Step 6: Run the core suite**

Run: `pnpm --filter @watasu/core exec vitest run`
Expected: PASS (assurance test green; no references to removed symbols). Fix any lingering import errors.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/consent.ts packages/core/src/consent.test.ts packages/core/src/index.ts
git commit -m "refactor(consent-gate): drop hand-rolled ES256 verifier; add BE/BS to receipt"
```

---

### Task 4: Branch `approveConsent` on registration vs authentication

**Files:**
- Modify: `packages/http/src/hosted-consent.ts`
- Modify: `packages/http/src/hosted-consent.test.ts`

**Interfaces:**
- Consumes: `verifyConsentRegistration`, `verifyConsentAuthentication`, `CredentialStore`, `buildConsentChallenge`, `mintConsentReceipt` from core.
- Produces: `CreateHostedConsentAppInput` gains `credentialStore: CredentialStore` and `rpID: string`; drops `resolveCredentialPublicKey` and `verifier`. Approve body is now discriminated (see Step 3).

- [ ] **Step 1: Write the failing test** — `packages/http/src/hosted-consent.test.ts`

Add a registration-path test. Build the app with `InMemoryCredentialStore`, mint a consent token (as the existing tests do), and POST a `type:"registration"` body using the `REG_FIXTURE` (import from `@watasu/core` test fixtures or copy). Assert 200 + `status:"approved"` and that `credentialStore.findByCredentialId(...)` now returns a record with the fixture's BE/BS. Add an authentication-path test that pre-seeds the store then POSTs `type:"authentication"` with `AUTH_FIXTURE`.

> Because SimpleWebAuthn verification needs the fixture's exact challenge/origin/rpID, construct the consent token so `buildConsentChallenge(claims)` equals `FIXTURE_CHALLENGE`, and set `allowedOrigins=[FIXTURE_ORIGIN]`, `rpID=FIXTURE_RPID`. If that coupling is impractical, inject a stub verifier via a seam kept only for tests — but prefer real fixtures.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @watasu/http exec vitest run src/hosted-consent.test.ts -t registration`
Expected: FAIL — `credentialStore` not accepted / registration branch absent.

- [ ] **Step 3: Implement the discriminated body + branch**

Replace `ApproveBody` and `parseApproveBody` with a discriminated union:

```ts
type ApproveBody =
  | { type: "registration"; user_handle: string; response: RegistrationResponseJSON }
  | { type: "authentication"; response: AuthenticationResponseJSON };
```

`parseApproveBody` validates `type` and the presence of `response` (and `user_handle` for registration).

In `approveConsent`, after the idempotent-receipt short-circuit and body parse, compute `expectedChallenge = buildConsentChallenge(claims)` (unchanged). Then:

```ts
let assurance: { backupEligible: boolean; backupState: boolean };
let credentialId: string;

if (body.type === "registration") {
  const reg = await verifyConsentRegistration({
    response: body.response,
    expectedChallenge,
    expectedOrigins: input.allowedOrigins,
    expectedRPID: input.rpID
  });
  if (!reg.ok) return jsonResponse(401, { ok: false, status: "rejected", error: reg.error });
  credentialId = reg.credential.credentialId;
  assurance = { backupEligible: reg.credential.backupEligible, backupState: reg.credential.backupState };
  await input.credentialStore.save({
    credentialId,
    publicKey: reg.credential.publicKey!,
    signCount: reg.credential.signCount,
    backupEligible: reg.credential.backupEligible,
    backupState: reg.credential.backupState,
    userHandle: body.user_handle,
    transports: reg.credential.transports,
    aaguid: reg.credential.aaguid,
    createdAt: now.toISOString()
  });
} else {
  const parsedId = body.response.id;
  const stored = await input.credentialStore.findByCredentialId(parsedId);
  if (stored === undefined) {
    return jsonResponse(401, { ok: false, status: "rejected", error: { code: "credential_unknown", message: "Credential is not registered." } });
  }
  const auth = await verifyConsentAuthentication({
    response: body.response,
    expectedChallenge,
    expectedOrigins: input.allowedOrigins,
    expectedRPID: input.rpID,
    credential: { id: stored.credentialId, publicKey: stored.publicKey, counter: stored.signCount, transports: stored.transports }
  });
  if (!auth.ok) return jsonResponse(401, { ok: false, status: "rejected", error: auth.error });
  credentialId = stored.credentialId;
  assurance = { backupEligible: auth.credential.backupEligible, backupState: auth.credential.backupState };
  await input.credentialStore.updateSignCount(stored.credentialId, auth.credential.signCount);
}
```

Keep the existing `IdempotencyStore` single-use claim block. Then mint the receipt with the new fields:

```ts
const receipt = await mintConsentReceipt(
  {
    envelope_hash: claims.envelope_hash, consent_text_hash: claims.consent_text_hash,
    field_purposes_hash: claims.field_purposes_hash, destination_policy_hash: claims.destination_policy_hash,
    credential_id: credentialId, approved_at: now, nonce: claims.nonce,
    ttl_seconds: input.receiptTtlSeconds ?? defaultReceiptTtlSeconds,
    backup_eligible: assurance.backupEligible, backup_state: assurance.backupState
  },
  input.signingSecret
);
```

Update `CreateHostedConsentAppInput`: remove `resolveCredentialPublicKey` and `verifier`; add `credentialStore: CredentialStore` and `rpID: string`. Update imports.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @watasu/http exec vitest run src/hosted-consent.test.ts`
Expected: PASS (registration + authentication paths; existing page/status/expiry tests still green).

- [ ] **Step 5: Commit**

```bash
git add packages/http/src/hosted-consent.ts packages/http/src/hosted-consent.test.ts
git commit -m "feat(consent-gate): approve accepts registration or authentication"
```

---

### Task 5: Consent page — build create()/get() options and discriminated body

**Files:**
- Modify: `packages/http/src/hosted-consent.ts` (`renderConsentPage`, `consentPageHtml`)
- Modify: `packages/http/src/hosted-consent-gate.test.ts` (page-content assertions)

**Interfaces:**
- Consumes: the claims + a server-minted `userHandle`.
- Produces: the page bootstrap JSON gains `userHandle`, `rpId`, `pubKeyCredParams`; the page JS tries `get()` then `create()` and POSTs the discriminated body.

- [ ] **Step 1: Write the failing test**

Add to `hosted-consent-gate.test.ts`: GET the consent page and assert the body contains `"navigator.credentials.create"`, `"navigator.credentials.get"`, and a `userHandle` value in the bootstrap JSON.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @watasu/http exec vitest run src/hosted-consent-gate.test.ts`
Expected: FAIL — page has no `create()` call / `userHandle`.

- [ ] **Step 3: Implement**

In `renderConsentPage`, mint `const userHandle = randomBytes(16).toString("base64url");` and add to the bootstrap object: `userHandle`, `rpId: new URL(publicBaseUrl).hostname`, and `pubKeyCredParams: [{type:"public-key",alg:-7},{type:"public-key",alg:-257},{type:"public-key",alg:-8}]`.

In the page `<script>`, replace the single `get()` approval handler with:

```js
function b64urlToBuf(s){ return b64urlToBytes(s).buffer; }
async function approve(){
  var challenge = b64urlToBuf(cfg.challenge);
  try {
    // Return user: discoverable get()
    var asr = await navigator.credentials.get({ publicKey: { challenge, userVerification: "required", timeout: 120000 } });
    return post({ type: "authentication", response: authToJSON(asr) });
  } catch (e) {
    // First-time (no credential): register+consent in one gesture
    var cred = await navigator.credentials.create({ publicKey: {
      challenge, rp: { id: cfg.rpId, name: "watasu" },
      user: { id: b64urlToBytes(cfg.userHandle), name: "watasu user", displayName: "watasu user" },
      pubKeyCredParams: cfg.pubKeyCredParams,
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      attestation: "none", timeout: 120000
    }});
    return post({ type: "registration", user_handle: cfg.userHandle, response: regToJSON(cred) });
  }
}
```

Add `authToJSON` / `regToJSON` helpers producing the SimpleWebAuthn JSON shapes:
- `regToJSON(c)` → `{ id: c.id, rawId: bytesToB64url(c.rawId), type: c.type, response: { clientDataJSON: bytesToB64url(c.response.clientDataJSON), attestationObject: bytesToB64url(c.response.attestationObject), transports: c.response.getTransports ? c.response.getTransports() : [] }, clientExtensionResults: c.getClientExtensionResults() }`.
- `authToJSON(c)` → `{ id: c.id, rawId: bytesToB64url(c.rawId), type: c.type, response: { clientDataJSON: bytesToB64url(c.response.clientDataJSON), authenticatorData: bytesToB64url(c.response.authenticatorData), signature: bytesToB64url(c.response.signature), userHandle: c.response.userHandle ? bytesToB64url(c.response.userHandle) : undefined }, clientExtensionResults: c.getClientExtensionResults() }`.

`post(body)` does the existing `fetch(cfg.approveUrl, ...)` with the JSON body and the existing status handling. Wire the single "Approve with passkey" button to `approve()`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @watasu/http exec vitest run src/hosted-consent-gate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/http/src/hosted-consent.ts packages/http/src/hosted-consent-gate.test.ts
git commit -m "feat(consent-gate): consent page registers or asserts in one gesture"
```

---

### Task 6: Wire the CredentialStore in the bootstrap

**Files:**
- Modify: `packages/http/src/hosted-bootstrap.ts`
- Modify: `packages/http/src/hosted-bootstrap.test.ts` (if it asserts consent wiring)

**Interfaces:**
- Consumes: `InMemoryCredentialStore`, `CredentialStore` from core; the updated `createHostedConsentApp` input.
- Produces: `CreateHostedProductionBootstrapAppInput` gains optional `credentialStore?: CredentialStore` (default `new InMemoryCredentialStore()`); removes `resolveConsentCredentialPublicKey`.

- [ ] **Step 1: Write/adjust the failing test**

In `hosted-bootstrap.test.ts`, if there is a consent-gate integration test, extend it to drive a registration approve through the bootstrap app and assert the credential is stored. Otherwise add a minimal test that the bootstrap constructs with a default `InMemoryCredentialStore` and routes `/consent/...`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @watasu/http exec vitest run src/hosted-bootstrap.test.ts`
Expected: FAIL — `resolveConsentCredentialPublicKey` removed / `credentialStore` unknown.

- [ ] **Step 3: Implement**

In `hosted-bootstrap.ts`:
- Add import: `InMemoryCredentialStore, type CredentialStore` from `@watasu/core`.
- Add to input interface: `credentialStore?: CredentialStore | undefined;`
- Add local: `const credentialStore = input.credentialStore ?? new InMemoryCredentialStore();`
- Change the `consentApp: createHostedConsentApp({...})` call: remove `resolveCredentialPublicKey`; add `credentialStore` and `rpID: new URL(input.publicBaseUrl).hostname`.
- Remove the now-unused `resolveConsentCredentialPublicKey` field and its `ConsentCredentialResolverInput` import.

- [ ] **Step 4: Run the http suite**

Run: `pnpm --filter @watasu/http exec vitest run`
Expected: PASS.

- [ ] **Step 5: Full green gate**

Run: `pnpm test`
Expected: typecheck clean; all tests pass; 0 new failures vs baseline.

- [ ] **Step 6: Commit**

```bash
git add packages/http/src/hosted-bootstrap.ts packages/http/src/hosted-bootstrap.test.ts
git commit -m "feat(consent-gate): wire CredentialStore into the bootstrap"
```

---

### Task 7: End-to-end browser check

**Files:**
- Create: `scripts/consent-register-browser-check.mjs` (adapt the earlier `consent-browser-check.mjs`)

**Interfaces:**
- Consumes: the built `@watasu/http` + `@watasu/core` dist; `createHostedConsentApp` with an `InMemoryCredentialStore` and `rpID`.

- [ ] **Step 1: Adapt the runner**

Copy the earlier `consent-browser-check.mjs` (from scratchpad or reconstruct): stand up the real server delegating `/consent/...` to `createHostedConsentApp({ credentialStore: new InMemoryCredentialStore(), rpID: "127.0.0.1", allowedOrigins: [publicBaseUrl], ... })`, mint a consent token, print the URL.

- [ ] **Step 2: Run and open in a browser**

Run: `node scripts/consent-register-browser-check.mjs` (background), then open the printed URL.
Expected: the page renders the payload; tapping "Approve with passkey" registers a passkey (first run) and returns `approved`; the server logs a stored credential. Capture the POSTed `registration` body → paste into `webauthn.fixtures.ts` (Task 2) and re-run Task 2 + Task 4 tests if they were blocked on fixtures.

- [ ] **Step 3: Verify + full gate**

Run: `pnpm test`
Expected: all green including the now-unblocked fixture tests.

- [ ] **Step 4: Commit**

```bash
git add scripts/consent-register-browser-check.mjs packages/core/src/webauthn.fixtures.ts
git commit -m "test(consent-gate): end-to-end passkey registration browser check + fixtures"
```

---

## Notes for the implementer

- **Fixture bootstrapping order:** Tasks 2 and 4 need a real `RegistrationResponseJSON`/`AuthenticationResponseJSON`. If you cannot source them from SimpleWebAuthn's own repo fixtures, do Task 7's first browser run early to capture them, then complete Tasks 2/4. This is the one cross-task dependency.
- **SimpleWebAuthn field names:** v13 nests the registered key under `registrationInfo.credential.{id,publicKey,counter}` with sibling `credentialDeviceType`/`credentialBackedUp`/`aaguid`. Confirm against the installed `.d.ts`; adjust field access if the installed minor differs.
- **Do not** reintroduce a payload into any server-visible field — the plaintext stays in the URL fragment; only the WebAuthn response + challenge cross the wire.
