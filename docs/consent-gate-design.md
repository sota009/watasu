# Consent Gate — Design Note (v1)

> Status: proposal, 2026-07-04. Adds a **runtime human-consent gate** to watasu's submit
> flow: an agent's submission pauses, a human approves it in a plain browser with a
> passkey signature bound to the exact payload, watasu stores a hash-only receipt, and the
> agent's request resumes. No app install on the user side; no change to the no-custody
> boundary.

## 1. Decision: watasu is tap's relay half; the gate spans both

**Resolved 2026-07-04: watasu is the server-side/relay half of Sota's `tap` (Nexepia) — not
an independent take.** So the choice isn't "watasu vs tap." It's: the consent gate is a
*bridge across both halves*, each doing the half it's shaped for:

- **watasu (server):** agent-pause trigger, no-custody relay, receipt store, delivery.
- **tap (client):** the consent UI (its PWA) + the passkey ceremony.
- **The seam:** watasu's `consent_url` opens tap's consent surface. One integration closes
  all three gaps — watasu gains a consent UI, tap gains the agent-pause trigger, and the
  passkey added to that shared surface upgrades tap's *own* flow (its "no passkey in v1"
  becomes v1). Receipts are tap's credential format (`@tap/schema`), shared by both halves.

This is Nexepia product work, jointly with Sota — see coordination note in §11.

Investigated both repos before this framing (2026-07-04).

- **watasu already owns the hard 80%** the feature sits on: A2A 1.0 HTTP+JSON intake, the
  no-custody relay, envelope validation, hashing, idempotency, SSRF-guarded delivery, the
  metadata ledger, and the MCP + CLI operator surface — all deployed on Render. The consent
  gate is a **single insertion** at a known point in `hosted-submit.ts`, plus one new table.
- The gate adds a distinct runtime field **`consent_receipt_token`** on the envelope
  (`packages/core/src/submission.ts`). **Post-rebase note (2026-07-05):** upstream separately
  shipped a *static* `consent_receipt` / `consent_receipt_hash` attestation (Sota's
  personal-info adapter, PRs #81–87). Same-ish name, different mechanism — the runtime token
  and the static receipt are explicitly distinct (`submission.ts:24-30`). See §13 for the
  reconciliation; this is the most consequential finding in this doc.
- **`tap` (Nexepia / Sota) is the wrong home for the *trigger*.** Its only entry point is a
  synchronous physical NFC/QR tap resolved in-PWA; it has no agent-pause, no consent-URL
  handoff, and no A2A task states — so the pause/relay belongs on watasu. But tap *is* the
  right home for the *ceremony*: it already has the consent PWA and the credential-grade
  receipt stack (OID4VP 1.0 + SD-JWT-VC + KB-JWT + `transaction_data`) that both halves
  should share via `@tap/schema`.
- The genuinely new part — **browser passkey/WebAuthn signing over a payload** — is absent
  from *both* halves; it lands on the shared consent surface (tap's PWA), where it also
  upgrades tap's existing lite-wallet approval.

Stack note: watasu is the lone Node/Render project in an otherwise Cloudflare-Workers
portfolio (tap included). If the two stacks merge onto Workers, the relay moves to Workers
alongside tap — decide as part of the conversion, not after.

### Full conversion — no demo shortcut

Decided 2026-07-05: **do the full conversion, not a throwaway demo page.** tap's PWA is the
consent surface; watasu is the relay; receipts are `@tap/schema`. This collapses the two
previously-parallel stacks into one agent-mediated pipeline, which means **deleting the
old-model machinery that no longer serves it** — the physical-NFC entry and the client-side
lite-wallet. Full KEEP / DELETE / CHANGE ledger in §12.

## 2. Scope of v1

In scope:

- One consent-gated trust profile (new `trust_profile` value, e.g. `human_consent`), so
  existing `public_capability` / `verified_sender` / `private_invite` flows are untouched.
- Pause via A2A `auth_required` + an RFC 8628-style device-flow body.
- A hosted consent web page (static, no install) that renders what/why/where, takes a plain
  WebAuthn assertion, and posts it back.
- A hash-only consent receipt persisted alongside the delivery ledger, ISO 27560-shaped.
- Resume via completion signal **and** poll fallback.

Out of scope for v1 (tracked in §9): OID4VP/KB-JWT credential receipts, MCP URL-mode
elicitation client integration, CIBA/push, tiered "consent once vs every time" policy.

## 3. Flow

```mermaid
sequenceDiagram
    autonumber
    participant UA as User-side agent (any vendor)
    participant W as watasu (submit)
    participant DB as Postgres (pending_consent)
    participant Br as User browser (consent page)
    participant Auth as Passkey (Face ID / Touch ID)
    participant R as Service receiver (webhook)

    UA->>W: POST /requests/{id}/submit (A2A envelope, encrypted_payload)
    W->>W: gate + validate envelope (unchanged)
    Note over W: trust_profile = human_consent → consent required
    W->>DB: insert pending_consent {status: pending, challenge, envelope_hash, TTL}
    W-->>UA: 401 auth_required + {consent_url, poll_url, expires_in}

    UA->>Br: surface consent_url to the human (link / open)
    Br->>W: GET consent_url  (plaintext rides in URL #fragment, never sent to server)
    W-->>Br: consent page + server-held envelope_hash + challenge
    Br->>Br: hash fragment plaintext, assert == envelope_hash, render what/why/where
    Br->>Auth: navigator.credentials.get({ challenge = H(envelope‖terms‖nonce) })
    Auth-->>Br: WebAuthn assertion (signs clientDataJSON containing challenge)
    Br->>W: POST assertion + credentialId
    W->>W: verify assertion vs stored challenge + registered pubkey
    W->>DB: update pending_consent {status: approved, receipt_hash}
    W-->>Br: approved

    UA->>W: (poll) GET poll_url  — or receives completion signal
    W-->>UA: approved → resubmit hint (same idempotency_key)
    UA->>W: POST /requests/{id}/submit (same envelope)
    W->>DB: pending_consent = approved → gate passes
    W->>R: deliver encrypted envelope (unchanged, no-custody)
    R-->>W: delivered
    W-->>UA: 202 delivered + ledger
```

Note on resume: the MCP URL-mode elicitation spec (SEP-1036) itself does **not** guarantee
the completion notification is delivered, so polling is not optional — it is the floor. The
completion signal is only the fast path.

## 4. Insertion points (real references)

| Concern | File | What changes |
| --- | --- | --- |
| Gate the submit flow | `packages/http/src/hosted-submit.ts:180` | Between `validateSubmissionEnvelope` (`:172`) and `deliverAcceptedSubmission` (`:180`), branch on consent state. |
| Runtime receipt field | `packages/core/src/submission.ts` (`consent_receipt_token`) | New field, distinct from upstream's static `consent_receipt` / `consent_receipt_hash` (§13). |
| New trust profile | `packages/core/src/submission.ts` (`trust_profile`), `resolveSenderTrust` in `hosted-submit.ts:225` | Add `human_consent`; short-circuit sender-trust the way `public_capability`/`local_demo` already do at `:236`. |
| Persistence pattern to copy | `infra/postgres/metadata-ledger.sql`, `packages/core/src/delivery.ts` (ledger row types), `packages/hosted/src/index.ts` (Postgres wiring + retention) | Add a parallel `pending_consent` table + store + retention. |
| Consent surface (new) | new `packages/http` routes + a static page | `GET /requests/{id}/consent/{token}`, `POST …/consent/{token}/approve`. |
| WebAuthn verify (new) | new `packages/core/src/webauthn.ts` | Verify assertion; `jose`/`node:crypto` already present, no new heavy dep. |

## 5. Concrete gate sketch (`hosted-submit.ts`)

Illustrative, not final — inserted right after the existing `validationResult` block
(current `:172–178`) and before `deliverAcceptedSubmission` (`:180`):

```ts
// ... after validateSubmissionEnvelope succeeds (hosted-submit.ts:172-178) ...

if (published.definition.trust_profile === "human_consent") {
  const consent = await input.consentStore.lookup({
    tenantId,
    requestId: published.request_id,
    idempotencyKey: gateResult.envelopeCandidate.idempotency_key,
    now: input.clock()
  });

  if (consent.status !== "approved") {
    // First hit (or still pending): create/refresh the pending row and pause the agent.
    const pending = await input.consentStore.upsertPending({
      tenantId,
      requestId: published.request_id,
      idempotencyKey: gateResult.envelopeCandidate.idempotency_key,
      envelopeHash: gateResult.envelopeCandidate.encrypted_payload_hash,
      consentTextHash: published.consent_text_hash,
      now: input.clock()
    });
    return jsonResponse(401, {
      ok: false,
      status: "auth_required",
      consent: {
        consent_url: `${input.publicBaseUrl}/requests/${encodeURIComponent(
          published.request_id
        )}/consent/${pending.token}`,
        poll_url: `${input.publicBaseUrl}/requests/${encodeURIComponent(
          published.request_id
        )}/consent/${pending.token}/status`,
        expires_in: pending.expires_in_seconds
      }
    });
  }

  // Approved: bind the runtime receipt to the envelope the human actually saw.
  if (consent.receiptEnvelopeHash !== gateResult.envelopeCandidate.encrypted_payload_hash) {
    return jsonResponse(400, {
      ok: false,
      status: "rejected",
      error: {
        code: "consent_envelope_mismatch",
        message: "Approved consent does not match this payload.",
        path: "body.message.parts[0].data.encrypted_payload_hash"
      }
    });
  }
  // fall through to deliverAcceptedSubmission unchanged
}

const deliveryResult = await deliverAcceptedSubmission({ /* unchanged */ });
```

`auth_required` (HTTP 401) is already a first-class status here (`hosted-submit.ts:173`), so
the pause path reuses existing plumbing rather than inventing a new status.

## 6. Pending-consent state — stateless signed token (NOT a table)

**Correction (2026-07-05): the deployed web tier is DB-less by construction.**
`createHostedProductionServerFromEnv` (`packages/hosted/src/index.ts:202-207`) forces the
metadata ledger `disabled` and forbids `WATASU_POSTGRES_URL`; the bootstrap defaults to
`InMemoryRequestVersionRepository` / `InMemoryIdempotencyStore` / noop ledger. Postgres is
only wired in the separate retention-job process. A `watasu_pending_consent` table would be
watasu's first web-tier database and fights that posture. Prefer the stateless approach.

**Preferred: encode the pending consent as a signed, opaque token.** No table; watasu holds
nothing between pause and approval.

- On pause, watasu mints `consent_token = JWS/JWE({ tenant_id, request_id, request_version,
  idempotency_key, envelope_hash, consent_text_hash, nonce, exp })` signed with the existing
  service-identity secret (reuse `deliverySigningSecret`; `jose` already a dep). The agent
  carries it in `consent_url`; the token *is* the row.
- On approval, watasu verifies the token signature + `exp`, checks the WebAuthn assertion
  against `challenge = SHA-256(envelope_hash ‖ consent_text_hash ‖ nonce)` (all recovered
  from the token — no lookup), and mints a signed `consent_receipt_token` (in `@tap/schema`
  KB-JWT shape, §9) that the agent presents on resume.
- The only durable need is **single-use / replay protection** ("has this consent_token been
  spent"), which rides the existing `IdempotencyStore` abstraction
  (`packages/http/src/hosted-submit.ts:48`). Single Render instance: in-memory is adequate
  for v1; multi-instance later: swap a durable `IdempotencyStore` impl (the one seam that may
  eventually want Redis/KV — nothing else).

(A server-side `watasu_pending_consent` Postgres table was considered and dropped — it would
be watasu's first web-tier database and fights the DB-less posture. The signed token replaces it.)

## 7. No-custody preservation (the load-bearing detail)

The consent page must *show* the data, but watasu must never see plaintext. Resolution:

- The user-side agent puts the plaintext in the **URL fragment** (`consent_url#<payload>`).
  Fragments are never sent to the server by browsers, so watasu's request logs and handlers
  never receive it.
- The page hashes the fragment client-side and asserts it equals the `envelope_hash` the
  server *does* hold (from the encrypted envelope). Mismatch ⇒ refuse to render.
- The WebAuthn challenge is `SHA-256(envelope_hash ‖ consent_text_hash ‖ server_nonce)`, so
  the biometric signs over *what the user saw*, not a bare random challenge.
- Only the assertion + `credential_id` + a derived `receipt_hash` are persisted. No payload,
  no plaintext — identical posture to `watasu_delivery_ledger`.

This keeps the PRD/ERD invariant intact (`docs/prd-cli-mvp.md` "No payload custody";
`docs/erd-cli-mvp.md` no-custody clauses).

## 8. Spec versions pinned (verified mid-2026)

- **A2A 1.0.1** (2026-05-28; major 1.0.0 was 2026-03-12, breaking). watasu already targets
  `"1.0"` (`packages/core/src/a2a.ts`) — confirm alignment to the 1.0.x line.
- **MCP URL-mode elicitation: SEP-1036, Final**, spec revision 2025-11-25; next revision is a
  2026-07-28 release candidate. (Integration is v2 — §9.)
- **WebAuthn Level 3**: W3C Candidate Recommendation Snapshot, 2026-01-13 (not yet final REC).
  Plain `navigator.credentials.get()` challenge-binding is the sound v1 practice; there is
  **no** browser-native non-payment transaction-display extension (`txAuthSimple` deferred to
  L4), and **Secure Payment Confirmation is payments-only** and cannot be called directly via
  `navigator.credentials.get()` — so SPC is a design template, not a component.
- **ISO/IEC TS 27560** consent-record format: W3C DPVCG implementation guide reached Final
  Community Group Report 2026-02-15 — the citable schema for the receipt.

## 9. Upgrade path & deferred work

- **Credential-grade receipts — converge now, not later.** Since watasu is tap's relay half
  (§1), the stored receipt should be tap's format from v1: depend on `@tap/schema` (pure TS:
  OID4VP 1.0 `transaction_data` + SD-JWT-VC KB-JWT per RFC 9901) so both halves share one
  receipt ledger. Separation of concerns: the **passkey assertion** is the signing gesture
  (plain WebAuthn — no browser-native OID4VP signing exists yet, §8); the **receipt** is the
  record, wrapped in tap's KB-JWT credential shape. `receipt_hash` in the table (§6) points at
  a `@tap/schema` receipt object, not a bespoke ISO-27560 blob. EUDI KB-JWT mandate: 2026-12-24.
- **MCP-native trigger:** emit `URLElicitationRequiredError` (-32042) for MCP clients that
  advertise URL-mode elicitation, in addition to the A2A/device-flow body.
- **Push resume (CIBA):** later; requires an authenticator app → violates no-install for v1.
  Track IETF `draft-klrc-aiagent-auth-01` (Ping/OpenAI/AWS/Zscaler, 2026-03).
- **Tiered consent** ("core once vs per-visit"): borrow EUDI "overasking protection"
  vocabulary; explicitly deferred — v1 confirms every submission.

## 10. Competitive note

**Arcade.dev** (authored SEP-1036; $60M Series A 2026-06-15) owns the agent-authorization
*trigger* primitive but does OAuth token brokerage for agents accessing *services* — not
payload-signed consent for personal-data *submission*. **Auth0 Auth for AI Agents** ships
CIBA async approval, enterprise/push-shaped. Neither does hosted, passkey-signed,
no-custody consent for agent-mediated personal data — the slot this gate targets. The wedge
is the **signed receipt + no-custody relay**, not the trigger (which the spec + Arcade
commoditize).

## 11. Open decisions

1. **Ownership seam — RESOLVED 2026-07-04:** watasu is the server-side/relay half of Sota's
   `tap` (Nexepia), not an independent take. Consequences: (a) this is joint Nexepia work —
   **coordinate with Sota before building**, especially as `tap` is under a Loop-1 code
   freeze (new solution features on hold pending customer validation); confirm the consent
   gate counts as core-mechanism work, not a frozen feature. (b) The two halves must
   interoperate: **confirm A2A wire alignment** — `tap` pins `1.0.0`, watasu pins `"1.0"`
   (`packages/core/src/a2a.ts`); verify identical `application/a2a+json` + TaskStatus shape.
   (c) Receipts share `@tap/schema` (§9).
2. **Passkey registration UX:** first approval requires creating a passkey (one tap, still no
   install). Belongs in the demo script so it isn't discovered live. Note this also gives
   tap's PWA its first passkey (STATE.md: "no passkey in v1").
3. **Desktop agent / phone passkey:** rely on WebAuthn hybrid (QR/CTAP2) transport; adds a
   hop — acceptable for v1?
4. **Consent surface — RESOLVED 2026-07-05:** full conversion — tap's PWA is the consent
   surface (not a standalone watasu page). See §12 ledger.
5. **Verifier dissolution (needs Sota):** in full conversion, tap's verifier Worker loses its
   sticker entry, lite-wallet mint, and fanout; its remaining job (verify presentation + sign
   receipt) moves into watasu (calling tap's sealed signing-worker). Confirm the verifier
   Worker dissolves rather than persists.
6. **One service-onboarding surface (needs Sota):** watasu `publish` (CLI/MCP request
   definitions) vs tap `console` template authoring — same "service declares what it wants"
   job. Pick one; the other's authoring path is deleted.
7. **Migrate to Workers?** Only if watasu and tap fully merge onto one stack — decide as part
   of the conversion.

## 12. Full-conversion ledger (KEEP / DELETE / CHANGE)

Target flow: **agent → watasu (A2A submit, pause) → tap PWA (review + passkey) →
`@tap/schema` receipt → watasu (deliver to service webhook, no custody).** This collapses
the two parallel stacks into one pipeline. **Every DELETE below is in `tap` (Sota's repo,
under a Loop-1 freeze) — none execute without his sign-off.** watasu is additive: nothing to
delete there.

### KEEP

- **watasu** — entire relay (A2A intake, no-custody delivery, ledger, idempotency, publish,
  MCP/CLI) + the new consent gate (§4–§7).
- **tap `packages/schema`** — the protocol brain (`oid4vp/*`: sd-jwt-vc, kb-jwt,
  transaction-data, receipt, terms, federation). This is the convergence target; watasu
  depends on it.
- **tap `apps/signing-worker`** — sealed Ed25519 receipt/credential signer. watasu calls it.
- **tap PWA consent UI** — `pages/TapLandingPage.tsx`, `components/ticket/*` (hold-to-stamp
  gesture), `claims/CaptureInterpreter.tsx` (on-the-spot capture when a field isn't in the
  agent's context). Rewired, not rebuilt.

### DELETE — physical-NFC entry (no stickers in an agent-mediated flow)

- `apps/verifier/scripts/gen-sticker.ts` + `gen:sticker` script + `qrcode` / `@types/qrcode` deps
- `apps/verifier/src/authoring/` (`stickers.ts`, `templates.ts`, `repo.ts`, guards)
- `apps/verifier/src/routes/tenant-context.ts` (the sticker→AR entry route)
- D1 tables `templates`, `stickers`; R2 `STICKERS` bucket

### DELETE — client-side lite-wallet (the agent is the wallet now)

- `apps/pwa/src/infra/notebook-store.ts`, `idb-db.ts`, `receipts-store.ts`
- `apps/pwa/src/queries/notebook.ts`
- `apps/pwa/src/pages/NotebookPage.tsx`, `ReceiptsPage.tsx`, `WelcomePage.tsx`
- `apps/pwa/src/flows/dcql-resolver.ts` (matched DCQL against the local notebook — the agent
  now decides what to send)
- `apps/verifier/src/routes/lite-wallet-mint.ts` (minted single-use creds into the wallet)

### DELETE — fanout (watasu owns delivery to the service)

- `apps/verifier/src/fanout/` (`a2a-jsonrpc.ts`, `dispatch.ts`, `target-validation.ts`)
- D1 table `fanout_peers`; the `peer:add/list/disable` operator CLI

### CHANGE / MOVE

- `apps/verifier/src/routes/oid4vp-response.ts` — verify-presentation + sign-receipt logic
  **moves into watasu** (calling the signing-worker). If nothing else remains, the verifier
  Worker dissolves (decision §11.5).
- `apps/verifier/src/routes/{agent-card,federation}.ts` — consolidate with watasu's Agent
  Card / discovery (one card, not two).
- tap `apps/console` template authoring — consolidate with watasu `publish` (decision §11.6);
  keep console's org/auth/passkey only if it becomes the institution-account layer.
- `apps/pwa/src/flows/tap-flow.ts` + `pages/TapLandingPage.tsx` — new entry mode: hydrate
  from a watasu consent handoff (token + fragment) instead of a sticker AR.
- **ADD** `apps/pwa/src/webauthn/` — passkey assertion (PWA has none today; crib from
  console-side Better Auth).

### Magnitude

This is not cleanup — it deletes tap's **physical-NFC product** and its **client wallet**,
and dissolves the **verifier Worker** into watasu. It is the "merge the two halves into one
agent-mediated product" decision. Execute as a reviewable branch/PR on `tap` for Sota, not
piecemeal.

## 13. Reconciliation with upstream's `consent_receipt` (surfaced by the rebase)

Rebasing onto current `main` collided on the name `consent_receipt` — because **Sota already
built a consent mechanism on watasu** (PRs #81–87, 2026-06-15, the personal-info adapter).
The branch's runtime field was renamed to `consent_receipt_token` to coexist. But the
collision is not just a name clash; it exposes **two different philosophies of where consent
lives**, and that is the real thing to reconcile with Sota before this merges.

### The two mechanisms

| | Upstream `consent_receipt` (Sota, shipped) | This gate `consent_receipt_token` (proposed) |
|---|---|---|
| Type | `ConsentReceiptMetadata` (`submission.ts:33-39`): request_version + 3 hashes + `confirmed_at` | Compact JWS runtime token (`consent.ts`) |
| Who confirms | The **user's agent / adapter**, before submitting | The **human**, live, at the watasu boundary |
| Where consent happens | **Client-side**, pre-submission (a local `--confirm` CLI flag in the adapter) | **Server-mediated**, at submission (browser passkey) |
| What watasu checks | Hash-equality only — receipt matches the published version's hashes (`validateConsentReceiptMetadata`, `submission.ts:466-519`) | WebAuthn signature over the payload-bound challenge |
| Proves a human consented? | **No** — no signature; anyone with the public Agent Card can forge a structurally-valid receipt. It proves *freshness / version-pinning*, not consent. | **Yes** — passkey signature bound to `envelope_hash` |
| Pauses the agent? | No — validated inline, fully automated | Yes — `auth_required` → approve → resume |

### The conflict to resolve

Sota's own integration brief (`docs/personal-info-mcp-integration-brief.md`, lines 72-78)
**explicitly scopes human consent OUT of watasu**: watasu does *not* own "user consent UI,"
"human dashboard UI," or "model-calling loops for user decisions" — the sender-side adapter
owns "asking the user to confirm." This consent gate does the **opposite**: it puts a live,
enforceable human-approval surface *inside* watasu's boundary.

So the two aren't redundant — they're a genuine architectural disagreement:

- **Sota's model** is simpler and keeps watasu thin, but its consent signal is
  **unenforceable** — watasu cannot prove a human ever confirmed (the `--confirm` flag is
  invisible to watasu; the receipt is forgeable).
- **This gate** is heavier (watasu hosts a consent surface) but produces an **enforceable,
  signed** consent receipt.

### Decision (2026-07-05): tiebreaker is legal validity → the signed runtime mechanism

The chosen criterion is **which mechanism actually works for legally-valid personal-data
collection between agents.** On that axis the signed runtime mechanism wins decisively, and
the static receipt is *not* a substitute.

**Why the static `consent_receipt` fails as consent evidence.** Legal consent must be
**demonstrable** (GDPR Art. 7(1)) and **recorded** for third-party provision (Japan APPI
第三者提供 記録義務 — watasu relaying user data to a service is exactly this). The static
receipt is attached by the **sending agent itself**, unsigned, unwitnessed, and forgeable
(all inputs are public hashes + a timestamp). It proves the *terms were current*
(version-pinning) — it does **not** prove a human consented, nor attribute the act to the data
subject. In an agent-mediated flow, no neutral party witnessed the consent, so the service
(the controller) cannot demonstrate it. That is not legally sufficient consent evidence.

**Why the signed mechanism works.** A **neutral surface witnesses and records** the data
subject's approval at submission, with a **passkey signature** for non-repudiation and
attribution. That is a defensible consent artifact.

**Do NOT keep both — the signed receipt subsumes the static one.** The static receipt's only
genuine legal contribution is *terms integrity* (specific/informed binding to the exact
consent text, field purposes, destination policy). Fold those three hashes into the signed
challenge, and the single signed receipt proves *both* "consent was to the correct terms" and
"a human consented." One mechanism; the static path is retired for the personal-data case.

**This settles the architectural conflict.** You cannot obtain legally-robust, service-
trustable consent purely client-side via an unenforceable `--confirm` — there is no neutral
witness and no attribution. So Sota's "consent UI is out of watasu's scope" position does not
meet the legal bar. The neutral consent surface may live in **watasu** OR **tap's PWA**
(either satisfies the law, preserving room for Sota's boundary) — what is ruled out is the
static self-asserted receipt as the consent basis.

**Scaling to regulated data.** A passkey proves "a controlling human consented" + non-
repudiation, but not "verified legal identity X." For identity-bound consent (KYC,
要配慮個人情報, government forms — the Japan mdoc/National-ID wedge), bind the credential to a
**verified identity credential**: OID4VP + SD-JWT-VC KB-JWT tied to an EUDI wallet or Japan's
mdoc National ID (the §9 upgrade path).

> **Not legal advice.** Confirm per jurisdiction (GDPR vs APPI 記録義務 vs US state laws; sensitive
> data raises the bar) before relying on this. Concrete question for Sota's legal contacts:
> *"For agent-mediated collection of personal data, is an unsigned agent-attached receipt
> sufficient consent evidence, or is a signed/witnessed approval required?"*

### Implemented (2026-07-05, commit `137e7cb`)

The consolidation is done on this branch, green (only the 4 known-pre-existing upstream
failures, zero new):

- **Removed** the static path: `ConsentReceiptMetadata`, `validateConsentReceiptMetadata`, the
  optional `consent_receipt` envelope field + schema property, and their tests.
- **Token now binds all three term-hashes.** `buildConsentChallenge` hashes
  `envelope_hash ‖ consent_text_hash ‖ field_purposes_hash ‖ destination_policy_hash ‖ nonce`,
  so the passkey signs over the exact terms + purposes + destination + payload. The gate
  re-pauses if a resume receipt's term-hashes don't match the published version.
- **`consent_receipt_hash` kept** as a *minimal required terms echo* (must equal the published
  `consent_text_hash`) — it's load-bearing (sender-signature coverage, type guard, schema,
  ~20 files), and it only pins terms; it is explicitly **not** consent evidence (that's the
  token). Full removal was out of scope for this pass.
- **`personal-info-adapter` (Sota's) — removed entirely.** Rather than rewire the adapter to
  mint/carry a `consent_receipt_token` through the interactive passkey gate, the whole
  `personal-info-adapter` package was deleted from this fork — it was a zero-dependent leaf with
  no callers, and its headless submit path could no longer produce an enforceable consent
  artifact under the token-based gate anyway. There is no adapter left to rewire; a
  headless→interactive `human_consent` client would need to be built fresh against the token
  gate if that path is ever wanted again.
