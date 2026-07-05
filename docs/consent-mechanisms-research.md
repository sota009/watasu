# Consent-mechanism research — alternatives to the WebAuthn passkey gate

> Research note, 2026-07-05. Question: for watasu's no-install, legally-defensible,
> agent-mediated consent gate (§13 of `consent-gate-design.md`), what mechanisms other
> than a WebAuthn passkey can produce a verifiable human-consent artifact? Method: deep
> multi-source pass, 28 sources, 25 claims adversarially verified (23 confirmed, 2 refuted).

## The bar (from §13)

Any mechanism must: (1) prove a **human** (not the agent) consented; (2) cryptographically
**bind to the exact payload + terms**; (3) give **non-repudiation + attribution**; (4) ideally
need **no app install** (plain browser); (5) low friction; (6) satisfy **GDPR Art. 7(1)
"demonstrable consent"** and **Japan APPI 第三者提供 記録義務**.

## Headline findings

1. **The passkey sits in a genuine sweet spot.** Nothing else clears *no-install +
   payload-bound + non-repudiation* simultaneously today.
2. **The industry default (CIBA push) is WEAKER on payload-binding.** Auth0 "Auth for
   GenAI", the WorkOS/Descope/Stytch pattern, and the IETF agent-auth drafts all use OAuth
   **CIBA** — an out-of-band mobile push ("approve this action"). CIBA proves *device
   possession*; it does **not** bind approval to the exact payload. watasu's passkey
   (challenge = hash of envelope + consent text + purposes) **does** bind the payload — so on
   §13's core property, the passkey beats the industry standard, and CIBA is *more*
   install-heavy (needs an enrolled authenticator app).
3. **The genuinely stronger alternatives ARE tap's stack.** OID4VP + SD-JWT-VC + KB-JWT
   (via OID4VP's `transaction_data`) is the closest technical match that also binds to exact
   terms — i.e. `@tap/schema`. "Alternative to passkey" mostly points back at the tap
   credential path, or up to government eID / QES for regulated data.
4. **You still need a record layer regardless.** ISO/IEC TS 27560:2023 consent *receipts*
   (mapped to GDPR by Pandit et al., arXiv:2405.04528) are the portable, machine-readable
   "demonstrable consent" artifact — not a signing mechanism, but the record on top of
   whatever signs.

## Comparison

| Mechanism | Proves a human? | Binds to payload? | Non-repudiation | No install? | GDPR 7(1)/APPI | Status |
|---|---|---|---|---|---|---|
| **WebAuthn passkey** (current) | ✅ | ✅ challenge=hash | ✅ device-bound key | ✅ plain browser | ✅ ordinary data | shippable now |
| **CIBA push** (Auth0/industry) | ✅ | ❌ generic approve | ⚠️ device possession | ❌ authenticator app | ⚠️ weaker | shippable, weaker |
| **OID4VP + SD-JWT-VC + KB-JWT** | ✅ | ✅ transaction_data+sd_hash | ✅ + selective disclosure | ❌ wallet app (browser path unsettled) | ✅ strong | maturing (= tap) |
| **QES** (eIDAS qualified sig) | ✅ | ✅ signs doc hash | ✅✅ handwritten-sig equivalence (Art.25(2)) | ❌ wallet/QSCD | ✅✅ court-grade | shippable (EU) |
| **EUDI Wallet** | ✅ | ✅ | ✅✅ QES-grade | ❌ wallet app | ✅✅ | maturing thru 2026 |
| **Japan MyNumber sign API (JPKI)** | ✅ | ✅ 署名値+証明書 | ✅✅ | ❌ native NFC app | ✅ APPI record | ~summer 2026 |
| OTP / magic link / OIDC social / click-wrap | ⚠️ weak | ❌ | ❌ | ✅ | ❌ not defensible | unverified in this pass |

## Recommendation

- **watasu-solo, no-install, defensible gate → keep the passkey.** It's the best single
  choice today. Lighter options (OTP/magic-link/click-wrap) are fine for a *demo* but miss
  the §13 legal bar (and weren't verifiable in this pass — treat as weak).
- **CIBA is not an upgrade** for us: more install-heavy, no payload binding. Only wins if we
  want async approval from a *separate phone* and add our own payload-hash to the push.
- **The real next tier up is tap** (OID4VP/credential) — for regulated / identity-bound data
  (KYC, 要配慮個人情報, gov forms). That's §13's "scaling to regulated data", not a passkey
  replacement for ordinary data.
- **Adopt TS 27560 receipts** as the record layer regardless of signing mechanism.

## Open thread (highest-value follow-up)

A claim that *OID4VP has no plain-browser path* was **refuted (0–3)** — there may be an
install-free credential presentation via the **W3C Digital Credentials API** in the browser.
If real, it's the bridge from passkey → verifiable credential **without a wallet install** —
i.e. converge watasu-solo and tap on one no-install surface. Worth verifying before committing
to the passkey long-term. (See `consent-mechanisms-browser-credentials.md` once researched.)

## Caveats

- Lower-assurance mechanisms (OTP, magic link, OIDC social, click-wrap, DocuSign AES) produced
  no surviving verified claims — their (generally weaker) fit is unverified here.
- Only **Auth0** was evidenced among agent-auth vendors; Arcade.dev, Descope, WorkOS, Stytch
  produced no surviving claims.
- EUDI Wallet and Japan MyNumber signing both require an app today; Japan's signing API is
  only slated for ~summer 2026.

## Sources (load-bearing)

- OID4VP `transaction_data`: https://openid.net/specs/openid-4-verifiable-presentations-1_0-24.html
- SD-JWT (RFC 9901, Nov 2025): https://www.rfc-editor.org/rfc/rfc9901.html
- eIDAS Art. 25(2) (QES = handwritten equivalence): https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32014R0910
- Auth0 CIBA async authorization: https://auth0.com/ai/docs/get-started/asynchronous-authorization
- IETF draft-oauth-ai-agents-on-behalf-of-user: https://datatracker.ietf.org/doc/draft-oauth-ai-agents-on-behalf-of-user/01/
- ISO/IEC TS 27560 → GDPR (Pandit et al.): https://arxiv.org/pdf/2405.04528
- Japan MyNumber auth-and-sign: https://services.digital.go.jp/en/auth-and-sign/
- EUDI Wallet ARF 2.4.0: https://eu-digital-identity-wallet.github.io/eudi-doc-architecture-and-reference-framework/2.4.0/architecture-and-reference-framework-main/
