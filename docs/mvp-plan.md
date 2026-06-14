# watasu MVP plan

Date: 2026-06-14

## Purpose

This is the single execution plan for watasu MVP work. It replaces the older split between the TDD implementation plan, action plan, and long use-case journey analysis.

Use this document to answer three questions:

- What can be tested locally today?
- What remains before hosted production use?
- Which user journeys are covered by each stage?

## MVP stages

### Local Protocol MVP

Status: implemented and manually testable.

Purpose: prove the core watasu promise on a developer machine.

This stage proves:

- request definitions can be validated and published locally
- Agent Card and schemas can be generated
- a sender fixture can read the contract
- a payload can be encrypted before submission
- watasu can deliver the encrypted envelope to a receiver fixture
- watasu does not keep plaintext payload values or encrypted payload bodies after delivery

Manual checks:

```bash
pnpm loop
pnpm demo:handoff
pnpm --filter @watasu/cli watasu validate packages/fixtures/requests/event-attendee.yaml
pnpm --filter @watasu/cli watasu publish packages/fixtures/requests/event-attendee.yaml --confirm
pnpm --filter @watasu/cli watasu agent-card packages/fixtures/requests/event-attendee.yaml --confirm
pnpm --filter @watasu/cli watasu schema packages/fixtures/requests/event-attendee.yaml
```

Expected results:

- `pnpm loop` passes typecheck, tests, secret scan, and self-review preflight.
- `pnpm demo:handoff` prints `ok: true`.
- demo output says `payload_values_sent_to_watasu: false`.
- demo output says `ledger_contains_payload_body: false`.
- demo output says `response_contains_plaintext_payload: false`.
- CLI commands return structured JSON and do not print payload values.

Extra payload-custody check:

```bash
rg "Alice Example|alice@example.test|sample-secret-value" .
rg "\"encrypted_payload\"|\"encrypted_key\"|\"ciphertext\"|\"protected\"|\"tag\"" .watasu-local logs tmp 2>/dev/null || true
```

Expected results:

- Known plaintext values appear only in intentional fixtures, tests, or docs.
- Delivery ledger rows may contain `encrypted_payload_hash`, but not `encrypted_payload` or JWE body fields.
- Missing `.watasu-local`, `logs`, or `tmp` paths are fine when no persistent local output exists.

### Hosted Production MVP

Status: repo-side protocol/runtime building blocks complete as of 2026-06-15. First deployment-facing slice is present for `api.watasu.ai`: health-checkable web service, default hosted API security headers, Blueprint-managed PostgreSQL, and scheduled metadata retention. External Render account, DNS, TLS, and secret setup remain follow-up work.

Purpose: let multiple service-side agents use watasu safely over a hosted surface.

Hosted production now has repo-side library and runtime artifacts for these trust boundaries:

- MCP publish and read resources, not just validation
- capability URL revoke and rotate
- service public key ownership verification
- webhook domain ownership verification
- hosted sender authentication for `verified_sender` and `private_invite`
- tenant and role authorization for hosted operations
- optional metadata-only ledger access controls
- audit logs for metadata reads
- retention jobs for ledger and operational metadata
- delivery hardening: timeout, concurrency caps, circuit breaker, and SSRF-safe redirect handling

Current verification evidence:

```bash
pnpm loop:full
pnpm demo:handoff
```

Both commands passed against the current implementation on 2026-06-15. The phase 2 through 6 behavior is covered by the current test suite and the listed manual checks below. A production binary, `render.yaml`, low-information `/health`, hosted security headers, hosted health canary, Blueprint-managed PostgreSQL, and retention cron wiring are now present for the first private-alpha deploy. Cloud account setup, DNS, TLS, and secret manager values remain deployment operations outside this repository.

### Deployment operations handoff

Default private-alpha target: Render.

Why this target:

- It keeps the first hosted deployment boring: one managed platform for a Node web service, managed PostgreSQL, cron jobs, custom domains, TLS, health checks, and Git-backed deploys.
- Its Blueprint model can later move deployment intent into `render.yaml`, so production setup is reviewable in PRs instead of hidden in a dashboard.
- Its paid PostgreSQL plans provide point-in-time recovery and logical exports, which fits watasu's metadata-only ledger better than a free or local database.
- It supports custom domains with automatic TLS, so the first public Agent Card URL can be a stable HTTPS subdomain.

Do this before asking the product owner for account actions:

1. Add a production entrypoint that composes the hosted HTTP app, hosted identity resolver, and optional PostgreSQL ledger runtime.
2. Add a hosting config, preferably `render.yaml`, with a web service, PostgreSQL database, and retention cron job.
3. Make the production server read the platform port safely. Render provides a platform port, while the current runtime config reads `WATASU_HOSTED_PORT`.
4. Add `/health` or an equivalent low-risk health endpoint that does not expose tenant, ledger, payload, or dependency details.
5. Run `pnpm loop:full`, `pnpm demo:handoff`, and a local smoke test of the production entrypoint.

Current repo-side status:

- Done: production Node entrypoint through `@watasu/hosted`.
- Done: Render web-service Blueprint for `api.watasu.ai`.
- Done: Render-managed PostgreSQL database wiring with `fromDatabase`.
- Done: scheduled metadata retention cron using `pnpm --filter @watasu/hosted retention`, with explicit rejection unless `WATASU_METADATA_LEDGER_STORE=postgres`.
- Done: retention dry-run mode using `pnpm --filter @watasu/hosted retention -- --dry-run` for pre-cutover checks without deleting rows; output records `checked_at`, `retention_days`, `tenant_id`, row counts, and `would_delete`.
- Done: web service keeps `WATASU_METADATA_LEDGER_STORE=disabled` and rejects accidental `postgres` mode until hosted read/write wiring intentionally needs DB access.
- Done: GitHub Actions CI gate for Render `checksPass`, with read-only permissions and pinned official actions.
- Done: Render platform `PORT` support while keeping `WATASU_HOSTED_PORT` for local runs.
- Done: low-information `/health` response.
- Done: default hosted API security headers: CSP deny-by-default, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and `Cache-Control: no-store`.
- Done: `pnpm canary:hosted` for deployed health, leak-fragment, checked forbidden fragment evidence, security-header, HTTPS production URL, URL-credential rejection, checked-origin evidence, root low-information 404, unpublished Agent Card / submit routes, hosted MCP authentication challenge checks, MCP protected-resource metadata checks, and `go_no_go` follow-up evidence. Local loopback HTTP remains allowed for smoke tests.
- Done: hosted runtime validates `WATASU_PUBLIC_BASE_URL` at startup and the Render Blueprint pins it to `https://api.watasu.ai`.
- Done: hosted production exposes request-specific Agent Card JSON for published request versions at `/requests/{request_id}/agent-card.json`.
- Done: hosted production exposes request-specific plaintext and encrypted envelope schemas for published request versions at `/requests/{request_id}/schemas/*.json`.
- Done: hosted production accepts A2A HTTP+JSON submissions at `/requests/{request_id}/submit`, validates envelope metadata, enforces idempotency/rate-limit hooks, and delivers encrypted envelopes without retaining payload bodies.
- Done: hosted submit can receive sender-trust resolution results before enforcing `verified_sender` / `private_invite` sender signatures.
- Done: `pnpm --silent deploy:preflight` reports repo-side Render readiness and remaining external actions without printing secret values or database URLs.
- Done: `pnpm --silent cutover:prepare` records the cutover head, deploy preflight, and hosted smoke JSON under the gitignored `cutover-evidence/` directory.
- Done: `pnpm --silent cutover:ci` records a completed successful GitHub Actions `ci` run that matches `cutover-evidence/cutover-head.txt`.
- Done: `pnpm --silent cutover:canary` records the deployed hosted canary result under `cutover-evidence/canary.json` without saving payload or secret-like output.
- Done: `pnpm --silent cutover:retention` records the hosted retention dry-run result under `cutover-evidence/retention.json` without saving payload or secret-like output.
- Done: `pnpm --silent cutover:status` reports present evidence, missing evidence, next repo-side commands, and remaining external actions without printing payload or secret-like output.
- Done: `pnpm --silent cutover:plan` reports before-Render commands, cutover evidence preparation, account-side actions, post-deploy checks, required evidence, and stop conditions as secret-safe JSON.
- Done: `pnpm --silent cutover:verify` validates saved preflight, smoke, canary, retention, and CI-green JSON evidence from `cutover-evidence/` for the recorded cutover head before a private-alpha go decision.
- Done: `pnpm --silent smoke:hosted` loads the compiled hosted runtime and verifies the low-information `/health` response without binding a network port.
- Remaining: production DNS verification, TLS issuance, real secret values, and post-deploy canary checks.

Product owner actions:

1. Create or choose the Render workspace and enable billing for paid web service and paid PostgreSQL. Do not use a free database for hosted metadata.
2. Connect the GitHub repository to Render with least necessary repository access.
3. Use the dedicated API subdomain `api.watasu.ai`. Prefer this subdomain over the apex domain for the first private alpha.
4. Let the Blueprint create the managed PostgreSQL database in the same region as the web service and retention cron.
5. Run `pnpm --silent cutover:plan` to review the command order, required evidence, and stop conditions.
6. Run `pnpm --silent cutover:prepare` before entering account-side values, then `pnpm --silent cutover:status`. Stop if it cannot record the exact cutover commit, deploy preflight, and hosted smoke evidence in the gitignored `cutover-evidence/` directory.
7. Run `pnpm --silent secret:identity --plain`, then enter the generated value only in the Render web service secret prompt. Real secret values must be entered in Render only, never committed to git.
8. Add or verify the custom domain in Render, copy the DNS record Render gives you, configure it with the DNS provider, then verify the domain in Render.
9. Run `pnpm --silent cutover:ci`, `pnpm --silent cutover:canary`, `pnpm --silent cutover:retention`, then run `pnpm --silent cutover:verify`.
10. Approve production exposure only after the health check, Agent Card URL, MCP endpoint, retention dry run, cutover verification, and no-payload-custody checks pass on the deployed URL.

Recommended production environment variables:

| Variable | Owner action | Notes |
| --- | --- | --- |
| `WATASU_IDENTITY_PROVIDER=signed_headers` | Codex can put the non-secret default in config. | Current hosted identity provider. |
| `WATASU_PUBLIC_BASE_URL=https://api.watasu.ai` | Codex can put the non-secret default in config. | Public origin for generated hosted URLs. Must stay HTTPS and must not include credentials, path, query, or fragment. |
| `WATASU_SERVICE_IDENTITY_SIGNING_SECRET` | Product owner creates the real secret in Render. | Generate it with `pnpm --silent secret:identity --plain`, enter it only in the web service, and rotate if exposed. Runtime rejects documented test or placeholder values, and the retention cron rejects this variable entirely. |
| `WATASU_SERVICE_IDENTITY_MAX_SKEW_SECONDS=60` | Codex can put the non-secret default in config. | Keeps signed service headers short-lived; runtime rejects values above 300 seconds. |
| `WATASU_METADATA_LEDGER_STORE=disabled` for web, `postgres` for retention cron | Codex can put the non-secret defaults in config. | Keep web DB access default-off until hosted read/write wiring intentionally needs DB access. The web runtime rejects `WATASU_POSTGRES_URL` even when the store is disabled. |
| `WATASU_POSTGRES_URL` | `render.yaml` wires from Render Postgres with `fromDatabase`. | Secret-equivalent. Never print in logs or PR text. |
| `WATASU_POSTGRES_SSL=require` | Codex can put the non-secret default in config. | Hosted database connections require TLS; `disable` is rejected unless the database URL is local loopback. |
| `WATASU_POSTGRES_POOL_MAX=2` | Codex can put the non-secret default in config. | Start small for the retention cron private-alpha workload; raise only with load evidence. |
| `WATASU_POSTGRES_RUN_MIGRATIONS=true` | Codex can put the non-secret default in config. | Keep true for the first deploy unless migrations move to a dedicated job. |
| `WATASU_RETENTION_TENANT_ID=watasu-private-alpha` | Codex can put the non-secret private-alpha tenant in config. | Retention cron scope. Move to per-tenant scheduling when multi-tenant operations need separate windows. |
| `WATASU_METADATA_RETENTION_DAYS=90` | Codex can put the non-secret default in config. | Matches the fixture default and can be lowered per request policy later. |

Owner checklist for the first production cutover:

```text
[ ] Render workspace selected and billing enabled.
[ ] GitHub repository connected to Render.
[ ] Paid Render Postgres database created in the same region as the web service.
[ ] Secrets entered in Render, not committed to git.
[x] Domain acquired and dedicated API subdomain chosen: `api.watasu.ai`.
[ ] DNS record configured and Render domain verification passed.
[ ] Production URL shared back with Codex for canary and published Agent Card checks.
[x] Repo-side production cutover plan command exists: `pnpm --silent cutover:plan`.
[x] Repo-side production cutover prepare command exists: `pnpm --silent cutover:prepare`.
[x] Repo-side production cutover CI evidence command exists: `pnpm --silent cutover:ci`.
[x] Repo-side production cutover canary evidence command exists: `pnpm --silent cutover:canary`.
[x] Repo-side production cutover retention evidence command exists: `pnpm --silent cutover:retention`.
[x] Repo-side production cutover status command exists: `pnpm --silent cutover:status`.
[x] Repo-side production cutover verifier command exists: `pnpm --silent cutover:verify`.
[x] Repo-side Render deploy preflight command exists: `pnpm --silent deploy:preflight`.
[x] Repo-side hosted runtime smoke command exists: `pnpm --silent smoke:hosted`.
[ ] `cutover-evidence/cutover-head.txt` records the exact deployed commit SHA.
[ ] GitHub Actions CI is green on the deployed commit.
[ ] `pnpm canary:hosted -- https://api.watasu.ai` passes and records `checked_at`, `checked_origin`, `checked_not_found_routes`, `checked_method_boundaries`, `checked_headers`, `checked_forbidden_fragments`, `checked_timeout_ms`, and `go_no_go`.
[ ] `pnpm --filter @watasu/hosted retention -- --dry-run` passes on the deployed environment and records `checked_at`, `retention_days`, `tenant_id`, and `would_delete`.
[ ] `pnpm --silent cutover:verify` reports `decision=go`.
[ ] Go/no-go decision made after canary and no-payload-custody checks.
```

Do not put in the owner's manual checklist:

- running database migrations by hand when the deployment config can run them
- copying SQL into the dashboard if `render.yaml` and the runtime migration runner can own it
- editing generated Agent Card JSON manually
- placing private keys, database URLs, or service identity signing secrets in README, PR text, shell history, or issue comments

## Execution phases

Each phase should be implemented TDD-style when it changes behavior:

1. Write the narrow failing test first.
2. Confirm it fails for the expected reason.
3. Implement the smallest behavior that passes.
4. Refactor with all tests green.
5. Run the listed manual checks.
6. Commit at one behavior boundary.

### Phase 1: Document the MVP split

Status: done.

Goal: make completion language honest.

Manual checks:

```bash
rg -n "Local Protocol MVP|Hosted Production MVP|mvp-plan" README.md docs
pnpm loop
```

Done when:

- a new reader can tell which use cases work locally today
- a new reader can tell which use cases require hosted production work
- `pnpm loop` passes

### Phase 2: MCP publish and resources

Status: done for the local in-memory MCP workspace, hosted production app delegation, hosted MCP transport service-header authentication boundary, OAuth protected-resource metadata helpers, and hosted Streamable HTTP entrypoint guard.

Goal: service-side agents can finish the local workflow through MCP, not only CLI.

Implementation:

- Add MCP `publish_request`.
- Add MCP resources or read tools for Agent Card, plaintext schema, envelope schema, and metadata-only ledger.
- Add hosted MCP tools that delegate publish and ledger reads to the hosted production app instead of local in-memory state.
- Resolve hosted MCP service headers from authenticated transport context and reject unauthenticated hosted tool calls before hosted app delegation.
- Add OAuth protected-resource metadata and `WWW-Authenticate` challenge helpers for hosted MCP HTTP deployment.
- Add hosted MCP Streamable HTTP entrypoint guard for the selected platform adapter: endpoint path, Origin, Bearer auth, and protocol version checks before SDK transport delegation.
- Require explicit confirmation for publish.
- Keep MCP outputs machine-readable.
- Never expose payload values through MCP.

Manual checks:

```bash
pnpm exec vitest run packages/mcp/src/mcp.test.ts
pnpm loop
```

Suggested interactive check:

```text
Connect an MCP client, list watasu tools, call validate_request_definition, call publish_request with confirmation, then read the generated Agent Card and schemas.
```

Done when:

- MCP can validate and publish the fixture request.
- MCP can return Agent Card and schemas for the published local request.
- MCP ledger output is metadata-only.
- hosted MCP tools do not call the hosted production app without authenticated transport service headers.
- hosted MCP deployment metadata exposes authorization servers and scope hints without query-string tokens.
- hosted MCP HTTP entrypoint rejects missing Bearer credentials and disallowed Origins before transport delegation.
- tests prove MCP tool descriptions and request text are treated as data, not instructions.

### Phase 3: Capability revoke and rotate

Status: done for the in-memory core capability registry.

Goal: leaked capability URLs can be stopped without mutating the request version.

Implementation:

- Model capability status separately from request version.
- Add revoke operation.
- Add rotate operation that issues a new capability for the same request version.
- Reject revoked capability submissions before webhook delivery.

Manual checks:

```bash
pnpm exec vitest run packages/core/src/submission.test.ts packages/core/src/publish.test.ts
pnpm demo:handoff
pnpm loop
```

Done when:

- revoked capability submissions return structured rejection
- rotated capability submissions work with the same request version
- old capability URLs fail before webhook delivery
- no full capability token appears in logs, ledger rows, or CLI/MCP output

### Phase 4: Ownership verification

Status: done for the core hosted publish gate, ownership challenge lifecycle, service public key registry, and HTTP adapter wiring.

Goal: prevent a service from publishing an intake for a key or webhook it does not control.

Implementation:

- Add service public key ownership challenge.
- Add verified service public key registry for register / rotate / revoke without private key custody.
- Add webhook domain ownership challenge.
- Require both challenges before hosted publish.
- Allow explicit local demo bypass only in `local_demo` mode.
- Wire hosted HTTP publish to server-side service identity and verified ownership state.

Manual checks:

```bash
pnpm exec vitest run packages/core/src/publish.test.ts packages/core/src/delivery.test.ts
pnpm loop
```

Suggested manual negative checks:

```text
Try hosted publish with localhost webhook: it must fail.
Try hosted publish with an unverified HTTPS domain: it must fail.
Try hosted publish with an unverified public key: it must fail.
Try local_demo publish with localhost fixture: it should still work.
```

Done when:

- hosted publish rejects unverified service keys
- rotated or revoked service public keys are removed from hosted publish ownership state
- hosted publish rejects unverified webhook domains
- hosted publish rejects localhost, private IPs, metadata service IPs, and non-HTTPS destinations
- local demo behavior remains fast and simple

### Phase 5: Hosted authorization and metadata ledger

Status: done for the core metadata ledger read authorization helper.

Goal: hosted metadata can be inspected only by the right service identity.

Implementation:

- Add service identity and tenant scope.
- Add roles: `publisher`, `request_admin`, `key_admin`, `ledger_viewer`, `auditor`.
- Gate ledger reads by server-side tenant and role.
- Write audit logs for ledger and consent metadata reads.
- Return not found or authorization errors without cross-tenant existence leaks.

Manual checks:

```bash
pnpm exec vitest run packages/core/src/storage-policy.test.ts
pnpm exec vitest run packages/core/src/security-regression.test.ts
pnpm loop
```

Suggested manual negative checks:

```text
Try reading ledger metadata as publisher only: it must fail.
Try reading another tenant's delivery metadata: it must fail without confirming the record exists.
Try reading ledger metadata as ledger_viewer: it should succeed and write an audit event.
```

Done when:

- tenant id is derived from service identity, not request body or tool arguments
- role checks are enforced server-side
- metadata reads create audit rows
- ledger rows remain metadata-only

### Phase 6: Retention and delivery hardening

Status: done for the core/local hardening helpers, local JSONL metadata store, PostgreSQL-compatible metadata adapter, PostgreSQL metadata schema SQL, provisioning artifact, and migration runner, hosted PostgreSQL runtime config, hosted Node/PostgreSQL pool adapter package, hosted retention job runner, and local HTTP demo hook wiring.

Goal: hosted delivery does not pile up unsafe data or let slow destinations exhaust watasu workers.

Implementation:

- Add retention job for optional ledger metadata, consent receipt metadata, rate limit events, and abuse logs.
- Add metadata-only persistent store for local/single-node validation.
- Add PostgreSQL-compatible metadata adapter using parameterized queries.
- Add PostgreSQL metadata ledger schema SQL with tenant-scoped primary key and no payload body columns.
- Add PostgreSQL metadata ledger provisioning SQL artifact for hosted infrastructure setup.
- Add PostgreSQL metadata ledger migration runner for injected hosted query clients.
- Add hosted PostgreSQL runtime config and migrated store factory so production can inject a managed pool.
- Add hosted Node/PostgreSQL package with bounded pool config, `pool.query` adapter, migration bootstrap, and clean shutdown.
- Add hosted retention job runner gated by auditor role.
- Add request-level and tenant-level delivery concurrency caps.
- Add short-lived circuit breaker for repeated webhook failures.
- Re-check HTTPS, ownership, and SSRF constraints on redirects.
- Keep the no payload retry queue rule.
- Return sender-actionable `resubmit_later` guidance and `Retry-After` without storing payload bodies.

Manual checks:

```bash
pnpm exec vitest run packages/core/src/delivery.test.ts packages/core/src/storage-policy.test.ts
pnpm exec vitest run packages/core/src/security-regression.test.ts
pnpm loop:full
```

Suggested manual negative checks:

```text
Send repeated webhook timeouts: watasu should return resubmit_later without retaining payload bodies.
Send enough failures to open the circuit breaker: new attempts should fail fast without storing payload bodies.
Create expired metadata rows: retention should delete or anonymize them.
Try redirecting to a private IP: delivery must reject the redirected target.
```

Done when:

- timeouts return `resubmit_later`
- idempotency claims are released after delivery failure so senders can resubmit
- resubmission responses tell senders when to retry, which idempotency key rule applies, and which envelope fields to refresh
- concurrency caps protect request and tenant workers
- retention removes expired metadata without touching active request versions
- no plaintext payload or encrypted payload body is persisted

## Use-case coverage

| Use case | Local Protocol MVP | Hosted Production MVP needed |
| --- | --- | --- |
| Local encrypted handoff demo | Yes | No |
| Fixture-based A2A contract check | Yes | No |
| CLI request validation and local publish | Yes | No |
| MCP service-side validate only | Yes | No |
| MCP validate and publish workflow | Yes | No |
| Event, waitlist, or inquiry intake prototype | Partial | Phases 2-4 |
| Recruiting intake | Repo-side hosted surface, server runtime, bootstrap composition, runtime config, signed identity provider wiring, and Postgres provisioning artifact | Cloud account deployment operations |
| Contractor or B2B onboarding | Repo-side hosted surface, server runtime, bootstrap composition, runtime config, signed identity provider wiring, and Postgres provisioning artifact | Cloud account deployment operations |
| QR or email private handoff | Repo-side hosted surface, server runtime, bootstrap composition, runtime config, signed identity provider wiring, and Postgres provisioning artifact | Cloud account deployment operations |
| Leaked capability URL recovery | Repo-side capability revoke and rotate plus hosted surface wiring | Cloud account deployment operations |
| Verified sender or private invite intake | Repo-side hosted sender auth, private invite binding, signed identity wiring, and hosted surface wiring | Cloud account deployment operations |
| Hosted high-sensitivity intake | Partial hosted HTTP surface and private JWK rejection | Service-side KMS/HSM operations outside watasu |
| Tenant-scoped ledger inspection | Repo-side hosted metadata adapter, signed identity wiring, authorization helper, and schema artifact | Cloud account deployment operations |
| Retention-backed hosted metadata ledger | Repo-side core/local JSONL, PostgreSQL-compatible adapter, schema SQL, migration runner, runtime config, hosted pool package, provisioning artifact, and hosted job runner | Cloud database creation, credentials, and scheduler outside repo |

## Positioning boundaries

Good early wedges:

- event, waitlist, and inquiry intake
- recruiting intake
- contractor onboarding
- B2B vendor registration
- QR or email handoff for private invites

Conditional later wedges:

- healthcare-adjacent allergy or medical note intake
- medical intake
- financial or tax intake
- KYC or government ID
- minor data

Avoid for MVP positioning:

- anonymous whistleblowing
- DV shelter, political, religious, or union-sensitive disclosure
- emergency triage or disaster response
- human web forms
- CSV export or answer database
- personal vault
- DSAR or legal consent platform

## Acceptance map

| ERD acceptance area | Phase |
| --- | --- |
| validate request | Local Protocol MVP |
| publish request confirmation | Local Protocol MVP, Phase 2 |
| immutable request versions | Local Protocol MVP |
| Agent Card and schemas | Local Protocol MVP, Phase 2 |
| A2A protocol gate | Local Protocol MVP |
| encrypted submission envelope | Local Protocol MVP |
| replay, rate, and capability protection | Local Protocol MVP, Phase 3 |
| webhook delivery | Local Protocol MVP, Phase 6 |
| metadata-only ledger | Local Protocol MVP, Phase 5 |
| tenant and role access control | Phase 5 |
| retention | Phase 6 |
| no payload custody | Local Protocol MVP, all hosted phases |
| MCP publish and resources | Local Protocol MVP, hosted app delegation |
| reference sender and receiver | Local Protocol MVP |

## Manual review checkpoints

Ask for human review at these points:

1. After Phase 2: MCP command names, publish confirmation, and agent experience.
2. After Phase 3: capability revoke and rotate semantics.
3. After Phase 4: ownership verification UX and local-demo bypass wording.
4. After Phase 5: hosted roles, tenant boundaries, and metadata access behavior.
5. After Phase 6: retention behavior and delivery failure semantics.

## Not in scope

- Dashboard UI.
- Real user-side agent.
- Legal consent engine.
- Identity proof, KYC, or delegated authority.
- Production retry queue that stores encrypted payload bodies inside watasu.
- Custom crypto or HPKE-first design.
- Push-button production exposure before Render account setup, DNS verification, real secrets, and post-deploy canary evidence exist.
