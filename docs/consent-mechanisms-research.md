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

## Install-free OID4VP in the browser (W3C Digital Credentials API) — RESOLVED

The "no browser path" claim was correctly refuted: the **W3C Digital Credentials API
shipped** — Chrome 141 (Oct 2025, default-on), Safari 26 (iOS/macOS 26), same-device on
Android, cross-device on desktop (QR + BLE/CTAP). It does OID4VP + ISO mdoc with selective
disclosure, and OID4VP-over-DC-API carries `transaction_data` (payload binding survives).

But it is **not a passkey replacement for a cold-start gate**:

- **Verifier/watasu (RP) side = install-free** — pure browser `navigator.credentials.get({digital})`, no app to ship.
- **User side needs a credential already provisioned in a wallet** — Google/Apple Wallet
  (pre-installed) or a 3rd-party wallet app. The DC API is a browser-mediated bridge *to a
  wallet the user already holds a credential in*, not a way to sign consent from nothing.

vs passkey: a passkey needs nothing pre-provisioned (create on the spot with Face ID). DC API
needs a pre-existing wallet credential. **Strategic upside:** it gives an install-free,
identity-bound presentation path in a plain browser — which could let watasu do regulated-data
consent **without shipping tap's PWA** (browser + platform wallet do the ceremony), once JP
wallet credentials (MyNumber-in-wallet, ~2026+) land. That belongs in the §12 tap-conversion
thinking.

## Attested vs self-asserted — the real reason passkey fits ordinary data

The line isn't "identity vs non-identity"; it's **attested/pre-issued vs self-asserted**:

- **OID4VP presents a Verifiable Credential** = data an issuer already signed and loaded into
  a wallet. Works for identity AND non-identity *if attested* (membership, employment,
  diploma). Does **not** work for arbitrary self-typed data — no issuer, and no-install
  platform wallets only hold a curated set (gov IDs, payment, passes), not app-defined blobs.
- **A passkey signs "a human approved *this arbitrary payload*"** — no issuer, no
  pre-provisioning. Correct tool for self-asserted form-fill data (watasu's `personal-info-mcp`
  content: name, email, address, preferences).

So they are **complementary**: passkey for ordinary self-asserted data (the form-fill wedge);
OID4VP/DC-API for attested/identity data (KYC, gov forms, 要配慮個人情報). `transaction_data`
can bind consent to arbitrary terms even when the *credential* is identity — but new attributes
still can't be minted on the spot; only the terms being authorized are free-form.

## Passkey adoption & UX (2025–2026 data)

The concern "passkeys are unfamiliar and block registration" is real but is a **prompt-design**
problem, not a fundamental blocker. The drop-off is concentrated at *enrollment*, worst in a
cold first-time prompt — exactly watasu's gate:

- **Forcing passkey creation at first interaction → 15–30% abandonment** (cross-vendor CIAM).
- **No fallback → 5–10× higher abandonment** on prompt cancellation.
- Mobile-browser **first-try** enrollment: iOS 49–83%, Android 41–67%, Windows desktop 25–39%.
- Post-success enrollment converts **2–3× higher** than first-registration; conditional-UI
  default-on → 30–50% adoption in 6 months vs 5–10% behind an explicit button.
- Once enrolled the gesture is strong: **93% success, 8.5s** (vs 63% / 31s for OTP/legacy).

**Japan is favorable ground:** passkeys are "mainstream" (FIDO Tokyo 2025); Mercari/DOCOMO/KDDI
>50% of smartphone auth; Yahoo! JAPAN 27M passkey users (~50% of smartphone auth); ~75% of
Japanese have ≥1 passkey; only 7% "don't know" (lowest surveyed). **Caveat:** those are
consumer-fintech power users — watasu's foreigner + elderly form-filler segment is
under-measured, so measure that cohort directly (Sota's real-user test).

**Guidance for the gate:**
1. **Never force it cold** — offer passkey, always allow skip → fallback (OTP/email). Avoids the 15–30% + 5–10× penalties.
2. **Frame as "Face IDで承認 / 指紋で承認," never "passkey."** The gesture is familiar; the word isn't.
3. **Tier it** — lightweight approval for demo/low-sensitivity, biometric only where §13's legal bar needs it.
4. **Measure your segment** — 5 real target users (a foreigner, an elderly person) beats any benchmark.

Note: the alternatives are worse on this exact axis — CIBA needs an authenticator app enrolled
(worse first-time friction); OTP is universally understood but legally weak.

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
- W3C Digital Credentials API: https://www.w3.org/TR/digital-credentials/
- Chrome DC API shipped (141): https://developer.chrome.com/blog/digital-credentials-api-shipped
- WebKit/Safari 26 DC API: https://webkit.org/blog/17431/online-identity-verification-with-the-digital-credentials-api/
- Corbado passkey enrollment benchmark 2026: https://www.corbado.com/passkey-benchmark-2026/passkey-enrollment-rate
- CIAM passkey adoption do's/don'ts: https://guptadeepak.com/ciam-compass/best-practices/passkey-adoption/
- FIDO Passkey Index 2025: https://fidoalliance.org/passkey-index-2025/
- FIDO Tokyo Seminar 2025 (Japan adoption): https://fidoalliance.org/recap-fido-tokyo-seminar-2025-toward-a-passwordless-world-deepening-japans-leadership-and-deployment/
- FIDO World Passkey Day 2025 consumer survey: https://fidoalliance.org/wpd-report-2025-consumer-password-passkey-trends/
