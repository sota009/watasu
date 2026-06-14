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

Status: not complete.

Purpose: let multiple service-side agents use watasu safely over a hosted surface.

Hosted production requires additional trust boundaries:

- MCP publish and read resources, not just validation
- capability URL revoke and rotate
- service public key ownership verification
- webhook domain ownership verification
- hosted sender authentication for `verified_sender` and `private_invite`
- tenant and role authorization for hosted operations
- optional metadata-only ledger access controls
- audit logs for metadata reads and admin actions
- retention jobs for ledger and operational metadata
- delivery hardening: timeout, concurrency caps, circuit breaker, and SSRF-safe redirect handling

Do not call Hosted Production MVP complete until:

```bash
pnpm loop:full
pnpm demo:handoff
```

both pass, and the manual checks for phases 2 through 6 below have run against the current implementation.

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

Status: done for the local in-memory MCP workspace.

Goal: service-side agents can finish the local workflow through MCP, not only CLI.

Implementation:

- Add MCP `publish_request`.
- Add MCP resources or read tools for Agent Card, plaintext schema, envelope schema, and metadata-only ledger.
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

Status: done for the core hosted publish gate.

Goal: prevent a service from publishing an intake for a key or webhook it does not control.

Implementation:

- Add service public key ownership challenge.
- Add webhook domain ownership challenge.
- Require both challenges before hosted publish.
- Allow explicit local demo bypass only in `local_demo` mode.

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

Status: done for the core/local hardening helpers.

Goal: hosted delivery does not pile up unsafe data or let slow destinations exhaust watasu workers.

Implementation:

- Add retention job for optional ledger metadata, consent receipt metadata, rate limit events, and abuse logs.
- Add request-level and tenant-level delivery concurrency caps.
- Add short-lived circuit breaker for repeated webhook failures.
- Re-check HTTPS, ownership, and SSRF constraints on redirects.
- Keep the no payload retry queue rule.

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
| Recruiting intake | Partial core checks only | Hosted service identity integration |
| Contractor or B2B onboarding | Partial core checks only | Hosted service identity integration |
| QR or email private handoff | Partial core checks only | Hosted service identity integration |
| Leaked capability URL recovery | Partial core checks only | Hosted service identity integration |
| Verified sender or private invite intake | Partial core checks only | Hosted service identity integration |
| Hosted high-sensitivity intake | No | Phases 4-6 |
| Tenant-scoped ledger inspection | No | Phase 5 |
| Retention-backed hosted metadata ledger | No | Phase 6 |

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
| MCP publish and resources | Local Protocol MVP |
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
- Production retry queue for encrypted payload.
- Custom crypto or HPKE-first design.
- Full hosted deployment pipeline.
