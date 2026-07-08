# watasu zero-install agent handoff — design spec

> Date: 2026-07-05. Extends watasu's consent gate so **any user-side agent** can complete a
> consent + submission with **no watasu-specific install**, while the agent still **auto-fills
> per-receiver varying data from the user's own context**, and watasu keeps its **no-custody**
> boundary. The receiver only has to *enable watasu* — it never cares which agent the user runs.
>
> Scope: **ordinary self-asserted personal data only.** The identity/regulated tier and all
> credential-wallet mechanisms (Digital Credentials API, OID4VP, SD-JWT-VC, mdoc) are **out of
> scope** and deliberately excluded from this design.

## 1. Goal & the three non-negotiables

A user-side agent (any vendor) submits the user's personal data to a service that has enabled
watasu. When consent is required, the human approves with a passkey. Three properties must hold
**simultaneously** — dropping any one makes an agent pointless (the user could just fill a form):

1. **Zero-install** — the agent runs no watasu-specific code; it uses only capabilities it
   already has.
2. **Agent auto-fill of varying data** — each receiver requests a different schema; the agent
   fills it from the user's own context/memory. No predefined fields, no wallet of fixed
   credentials.
3. **No-custody** — watasu never sees the plaintext payload.

## 2. The constraint that shapes everything (a real trilemma)

For **varying** data with **no-custody**, someone **at the browser** must encrypt, and
**something** must carry the agent's arbitrary payload into that browser. That forces one of
three arrangements — there is no 2026 standard that removes this:

| Arrangement | Requirement | Cost |
|---|---|---|
| **A. Agent is browser-resident (WebMCP)** | agent runs in/beside the tab and speaks `document.modelContext` | true zero-install + auto-fill — needs a WebMCP-capable browser agent (early, Chrome-only today) |
| **B. Agent is cloud/CLI** | a thin, standard-shaped shim to build the fragment URL + poll | ~15 lines = *not literally* zero-install |
| **C. No agent data transfer** | human enters/confirms the data in watasu's page | zero-install but **loses auto-fill** |

**Decision:** target **A as the north star** (it is the only arrangement that satisfies all
three non-negotiables), ship **B as the interim path** for cloud/CLI agents, and keep **C** as
the graceful-degradation fallback for agents that can do neither. All three drive the *same*
watasu page and the *same* receipt.

## 3. Architecture — watasu's consent page is a Trusted Surface exposed as a WebMCP tool

The consent page watasu already serves becomes the single **Trusted Surface**: the point where
the human sees the real payload, approves with a passkey, and where encryption happens
client-side. It is exposed to browser agents as a **WebMCP tool** whose input schema *is the
receiver's request schema*.

```
Receiver: enable watasu + publish request (schema + receiver pubkey)      [existing]
                                   │
                     watasu Agent Card advertises the request
                                   │
User-side agent (browser-resident, WebMCP):
   discovers the page tool → fills inputSchema from the user's context
                                   │
   document.modelContext tool.execute(payload):
     1. renderPayloadForReview(payload)   ← human sees the ACTUAL data
     2. await agent.requestUserInteraction(onApproveClick)  ← real gesture
     3. passkey get()/create() fired from within that gesture  (payload-bound challenge)
     4. encrypt(payload → receiver pubkey) client-side  (SubtleCrypto)
     5. POST encrypted envelope + consent receipt
                                   │
   watasu: sees ciphertext only → mints hash-only receipt → delivers to receiver
```

- **Varying data** rides `registerTool({ inputSchema, execute })`; the browser validates input
  against `inputSchema` before the handler runs, and `inputSchema` is the receiver's schema.
- **Auto-fill** is the agent filling that schema from the user's context and calling the tool.
- **No-custody** holds because `execute` encrypts in-page (SubtleCrypto) and watasu's server
  only receives ciphertext — identical posture to today's fragment approach.

## 4. Components

| Component | Change | Where |
|---|---|---|
| Consent page (Trusted Surface) | Render payload for review; run passkey + client-side encrypt in `execute` | `packages/http/src/hosted-consent.ts` |
| WebMCP tool registration | Register the consent/submit tool with `inputSchema` = receiver schema; `exposedTo` gated to trusted origins | new, page-side script |
| A2A shim (interim, Path B) | On `401 auth_required`, append plaintext fragment, open/print URL, poll, resubmit with receipt | new client helper (e.g. `watasu submit --wait`), NOT server |
| Consent receipt | Unchanged watasu-native JWS, hash-only, carries BE/BS assurance | `packages/core/src/consent.ts` |
| Submit gate | Unchanged: `consent_receipt_token` on envelope → deliver | `packages/http/src/hosted-submit.ts` |

## 5. Two design rules that are load-bearing

### 5.1 Fire the passkey from the human's gesture, never from the tool call
WebAuthn `navigator.credentials.get()/create()` requires a **transient user activation (real
gesture)**. Whether a bare WebMCP tool-call grants activation is **unresolved**
([webmcp#62](https://github.com/webmachinelearning/webmcp/issues/62)). So the passkey MUST fire
*inside* `agent.requestUserInteraction`'s human click — which is also what we want (the human
physically approves). This sidesteps the open question entirely.

### 5.2 Human review of the actual payload is mandatory (anti-misfill)
The real WebMCP threat is **not** watasu being injected (watasu never interprets the payload —
it encrypts and forwards). It is a **malicious receiver** whose tool schema/description tricks
the agent into pulling the *wrong* fields from the user's context and exfiltrating them
("Bad Tool" + consent-skip in Chrome's WebMCP guidance). The backstop is that **the consent
page renders the real payload for human review before the passkey.** This review step is
**never auto-approved** and never optional.

## 6. No-custody preservation

- Plaintext lives only where the encryption happens (URL fragment in Path B; in-page tool
  argument in Path A). watasu's server receives ciphertext + hashes only.
- The passkey challenge is `SHA-256(envelope_hash ‖ consent_text_hash ‖ field_purposes_hash ‖
  destination_policy_hash ‖ nonce)` — the biometric signs over *what the user saw* (unchanged
  from the current gate).
- Only the assertion, `credential_id`, and the derived hash-only receipt persist. No payload.

## 7. Receipt — unchanged, with conceptual alignment noted

The consent receipt stays watasu's existing **hash-only JWS** (payload-bound, single-use,
carries `backup_eligible`/`backup_state` assurance flags). No format change.

*Prior-art note (non-binding):* the shape here — user approves on a Trusted Surface → signed,
scoped Receipt the agent presents to a verifier — mirrors Google's **AP2 "Mandate → Trusted
Surface → Receipt"** authorization model. We align *conceptually* (vocabulary, human-present /
human-not-present split) but do **not** adopt AP2's SD-JWT/credential wire formats; those pull
in the excluded identity tier.

## 8. Maturity & rollout (do NOT ship WebMCP to production yet)

WebMCP is a **W3C Community Group Draft (Feb 2026), not on the standards track**, Chrome-only
early preview, and churning fast (`navigator.modelContext` → `document.modelContext` by Chrome
150; `provideContext` → `registerTool`). Chrome's own docs say don't ship to production.

Therefore:
1. **Build the tool surface now**, behind a flag, forward-compatible with the API as it lands.
2. **Route real traffic through the Path B A2A shim** (works today, any agent).
3. **Flip WebMCP on** for browser-resident agents as it stabilizes — no server change, since
   both paths drive the same page + receipt.

## 9. Error handling

| Case | Behavior |
|---|---|
| Agent can't reach the tool / not browser-resident | fall back to Path B (401 + consent_url + poll) |
| Tool input fails `inputSchema` validation | browser rejects before `execute`; agent told what was wrong |
| Human declines at review / cancels passkey | `execute` throws / Path B stays pending; no receipt minted |
| Challenge ≠ payload-bound challenge | reject (payload-binding violation) |
| Consent token already spent | 409 via existing idempotency guard |
| Browser lacks WebAuthn | OTP/email fallback — **out of scope here** (separate spec; flow must not preclude it) |

## 10. Testing

- WebMCP tool: `inputSchema` = receiver schema; input validated before `execute`; arbitrary
  agent-supplied payload reaches the handler.
- Passkey fires only from within `requestUserInteraction` (assert no ceremony on bare tool call).
- Human-review step is required before any receipt is minted.
- No-custody: server-visible fields are ciphertext + hashes only across both paths.
- Path B shim: `submit → 401 → open(url#payload) → poll → resubmit-with-receipt → delivered`,
  idempotent under retry.
- Origin gating: tool is not observable/callable from non-`exposedTo` origins.

## 11. Out of scope (explicit)

- **Identity/regulated tier** and all credential-wallet mechanisms: Digital Credentials API,
  OID4VP, SD-JWT-VC, mdoc, eID/QES/EUDI/JPKI. Not a future section of this spec.
- OTP / email fallback for no-WebAuthn devices (separate spec).
- CIBA push / remote-phone approval (separate; Path B "print URL / QR" covers the remote case
  without a server push channel).
- Durable multi-instance credential/consent stores (interface exists; wire later).

## 12. Open decisions

1. **First shim form for Path B:** a `watasu submit --wait` CLI vs an inline SDK helper vs raw
   glue in the agent. (Recommend a CLI + a documented ~15-line inline recipe.)
2. **WebMCP flag gating:** which origins get `exposedTo` the consent tool, and how the receiver
   allowlist is expressed.
3. **Remote-human UX in Path B:** auto-`open` when local vs print-URL/QR when headless — detect
   or configure?
4. **Whether Path C (human enters in page) is built for v1** or deferred until a real
   no-agent-transfer case appears.
