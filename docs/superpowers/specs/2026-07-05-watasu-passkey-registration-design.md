# watasu passkey registration — design spec

> Date: 2026-07-05. Adds **passkey registration** to watasu's consent gate so a first-time
> user can register a passkey inline at the gate and approve, and a returning user is
> recognized with no login. watasu is now a **standalone product** (tap retired), so it owns
> its own credential store. Preserves the §13 payload-binding and the no-custody boundary.

## 1. Context & goal

The consent gate already does WebAuthn **assertion** (`get()`) via a hand-rolled,
**ES256-only** `verifyWebAuthnAssertion` in `@watasu/core`, but has **no registration**
(`create()`) — `resolveCredentialPublicKey` is a caller-supplied stub returning `undefined`,
so the approve button prompts a passkey and then fails. This spec adds registration and a
credential store, and migrates verification to a maintained library.

Goal: a **watasu-solo, no-install, legally-defensible** consent gate where a first-time user
registers a passkey inline and approves in one gesture, and returning users approve with one
tap. Ordinary self-asserted personal data (form-fill wedge).

## 2. Decisions (locked)

- **Persistence = B (persistent credential store + discoverable credentials).** The passkey
  *is* the identity — no accounts/username/login. First time: `create()` a discoverable
  passkey; return: `get()` with empty `allowCredentials`, look up by `credentialId`.
  `CredentialStore` is **in-memory now** (works for the demo and a single Render instance),
  swappable to **Postgres** later behind the interface with no flow change.
- **Assurance = A (record, never block).** Accept any authenticator; record the `BE`/`BS`
  flags on every consent receipt so it self-describes AAL2-synced vs AAL3-device-bound.
  Requiring device-bound for a high-sensitivity class is a later pure-policy addition.
- **Library = full migration to `@simplewebauthn/server` v13.3.2.** Remove the hand-rolled
  ES256 verifier; SimpleWebAuthn covers ES256 + RS256 + EdDSA for both register and assert.
- **WebAuthn Level 3** (W3C CR 2026-05-26). `userVerification: "required"`,
  `attestation: "none"` default, `residentKey: "required"`.

## 3. Key design: register + consent in ONE gesture

WebAuthn *registration* signs over the RP challenge (in `clientDataJSON`). Setting the
**registration challenge = the payload-bound consent challenge**
(`SHA-256(envelope_hash ‖ consent_text_hash ‖ field_purposes_hash ‖ destination_policy_hash ‖ nonce)`)
makes a first-time user's `create()` *itself* a payload-bound consent signature. No double-tap:

- **First-time:** one `create()` → registers a passkey **and** signs this consent (payload-bound).
- **Returning:** one `get()` → signs this consent with the existing watasu passkey.

The page shows a single "Face IDで承認" button; it tries `get()` (discoverable) first and falls
back to `create()` when the user has no watasu passkey. No separate "registration options"
endpoint is needed — the stateless consent token already carries the challenge.

**userHandle sourcing (removes a stateless-verify ambiguity):** a fresh random `userHandle` is
minted **server-side when rendering the consent page** and embedded in the `create()` options
(`user.id`). Because a WebAuthn *registration* (attestation) response does **not** echo
`user.id`, the client **echoes the `userHandle` back in the registration approve body**, and
the stateless verify stores it on the `CredentialRecord`. Returning users need no new
`userHandle` — their authenticator returns the one baked in at first registration via
`get()`'s `response.userHandle`, which watasu maps through `findByCredentialId`.

## 4. Components

| Component | Change | Where |
|---|---|---|
| `CredentialStore` (interface) + `InMemoryCredentialStore` | **New** | `packages/core/src/consent.ts` (or new `credential-store.ts`) |
| `CredentialRecord` (type) | **New** | core |
| `@simplewebauthn/server` v13.3.2 | **New dep** | `packages/core/package.json` |
| `verifyWebAuthnAssertion`, `WebAuthnSignatureVerifier`, `es256SignatureVerifier` | **Remove** (ES256-only hand-roll) | `consent.ts` |
| Registration + authentication verify | **New / replaced** via SimpleWebAuthn | `consent.ts` |
| `approveConsent` | Accept a **discriminated body** (registration vs authentication) | `hosted-consent.ts` |
| Consent page (`consentPageHtml`) | Emit `create()` params; try `get()` → fall back to `create()` | `hosted-consent.ts` |
| Bootstrap wiring | Replace `resolveConsentCredentialPublicKey` stub with `CredentialStore` | `hosted-bootstrap.ts` |

### CredentialRecord

```
CredentialRecord {
  credentialId: string        // base64url — primary key
  publicKey: Uint8Array        // COSE public key (from SimpleWebAuthn)
  signCount: number
  backupEligible: boolean      // BE flag — synced-capable
  backupState: boolean         // BS flag — currently synced
  userHandle: string           // watasu-minted opaque id for the discoverable credential
  transports?: string[]
  aaguid?: string              // authenticator model (analytics only)
  createdAt: string            // ISO 8601
}
```

### CredentialStore interface

```
interface CredentialStore {
  save(record: CredentialRecord): Promise<void>
  findByCredentialId(id: string): Promise<CredentialRecord | undefined>
  updateSignCount(id: string, signCount: number): Promise<void>
}
```

`InMemoryCredentialStore` implements it with a `Map`. `resolveConsentCredentialPublicKey`
becomes a thin adapter over `findByCredentialId` (or is removed in favor of the store directly).

## 5. Data flow

```
Agent submits → 401 auth_required + consent_url            (unchanged)
Browser opens consent_url#<payload>                        (payload stays in fragment)
  page: assert SHA-256(fragment) == envelope_hash; render what/why/where
User taps "Face IDで承認"
  try get({ challenge, allowCredentials: [] /* discoverable */ })
    ├─ has watasu passkey → authentication response
    └─ none (NotAllowedError) → create({ challenge=<same>, user:{id:userHandle}, ... })
POST /requests/{id}/consent/{token}/approve  { type: "registration" | "authentication", ... }
  SimpleWebAuthn verify:
    - expectedChallenge == consent challenge (payload binding preserved)
    - userVerification required
    ├─ registration → verifyRegistrationResponse → store CredentialRecord (pubkey, BE, userHandle)
    └─ authentication → findByCredentialId → verifyAuthenticationResponse → updateSignCount
  mint consent receipt (payload-bound + assurance level derived from BE/BS) → mark approved
Agent resumes (poll/completion) → deliver encrypted envelope (unchanged, no custody)
```

## 6. Invariants preserved

- **Payload binding (§13):** challenge is `hash(envelope+terms+nonce)` for BOTH register and assert.
- **No-custody:** plaintext rides only the URL fragment; watasu never receives it.
- **Stateless consent token:** unchanged; carries the challenge, so no new options endpoint.
- **Single-use / replay:** existing `IdempotencyStore` guard on the consent nonce.
- **CSP:** existing per-page nonce CSP already allows the inline passkey script.

## 7. Error handling

| Case | Behavior |
|---|---|
| `get()` returns no credential | fall back to `create()` (register-and-consent) |
| Registration/authentication verify fails | 401, **no** store write |
| Challenge ≠ consent challenge | reject (payload-binding violation) |
| Consent token already spent | 409 via existing idempotency guard |
| Unknown `credentialId` on authentication | 401 credential_unknown |
| Browser lacks WebAuthn | **OTP fallback — OUT OF SCOPE for this spec** (separate future spec; flow must not preclude it) |

## 8. Testing (TDD)

- `verifyRegistrationResponse`: happy path, wrong challenge, unsupported alg, spent token.
- `verifyAuthenticationResponse`: returning user happy path, unknown credential.
- `CredentialStore`: save + lookup + signCount update.
- Receipt records `BE`/`BS` → correct assurance level.
- Payload-binding: challenge mismatch is rejected on both paths.
- End-to-end browser check (reuse the local runner from the CSP work).
- SimpleWebAuthn ships COSE/attestation test fixtures; use them rather than hand-built keys.

## 9. Out of scope (explicit)

- OTP / email fallback for no-WebAuthn devices (separate spec).
- High-sensitivity device-bound enforcement (later pure-policy addition; `BE` already recorded).
- Durable Postgres `CredentialStore` backend (interface now; wire when going multi-instance).
- Account recovery / cross-device passkey management / Signal API sync.

## 10. Notes

- `docs/consent-gate-design.md` §1/§11/§12/§13 are **stale** post-tap-retirement (assume tap is
  the client half). Cleanup is separate from this spec.
- Migrating off the hand-rolled ES256 verifier broadens algorithm coverage
  (ES256 → ES256/RS256/EdDSA), improving real-device compatibility.
