# watasu

watasu is an agent-native intake MVP for service-side agents to define requests for personal data and publish encrypted intake endpoints that external user-side agents can read.

Instead of building human-facing forms, watasu makes "what is being sent, why it is needed, and where it goes" machine-readable as a request definition, schema, and Agent Card. It provides the foundation for delivering encrypted submissions, based on user consent, to a service-side webhook.

## Security Promise

watasu's boundary is **no payload custody**.

- watasu does not receive, decrypt, store, or log plaintext payloads.
- watasu does not hold the service private key.
- watasu does not retain encrypted payload bodies after a delivery attempt.
- If webhook delivery fails, watasu is designed to avoid keeping a payload retry queue and instead return `resubmit_later` to the sender.
- By default, watasu should avoid persistent custody even for metadata. Short-lived operational state may be kept for replay protection, rate limits, and sender-actionable delivery responses. Optional persistent ledgers must be metadata-only and explicitly enabled.

Because metadata can still be personal-related information, any optional persistent metadata is treated as subject to tenant, role, retention, and audit controls. watasu does not guarantee legal consent, identity verification, delegated authority, regulatory compliance, or DSAR handling. Those remain the responsibility of the service side or another product.

## Workspace Layout

```text
docs/
  prd-cli-mvp.md              Product requirements and scope
  erd-cli-mvp.md              Engineering requirements, protocol, data model
  protocol-baseline.md        Latest-info and dependency vetting record
  mvp-plan.md                 MVP stages, manual checks, execution phases
  loop-engineering.md         Codex loop template and verification rules
packages/
  core/                       Request validation, hashes, publish, schemas, A2A, delivery
  cli/                        File-based watasu CLI wrapper
  fixtures/                   Sample request definitions
  http/                       Local HTTP demo server
  mcp/                        MCP server package
scripts/                      Loop, review, PR, and secret-scan helpers
```

## Quick Start

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm loop
pnpm demo:handoff
```

CLI examples:

```bash
pnpm --filter @watasu/cli watasu validate packages/fixtures/requests/event-attendee.yaml
pnpm --filter @watasu/cli watasu schema packages/fixtures/requests/event-attendee.yaml
pnpm --filter @watasu/cli watasu publish packages/fixtures/requests/event-attendee.yaml --confirm
pnpm --filter @watasu/cli watasu agent-card packages/fixtures/requests/event-attendee.yaml --confirm
pnpm --filter @watasu/cli watasu ledger packages/fixtures/requests/event-attendee.yaml --confirm
pnpm --filter @watasu/cli watasu inspect-delivery packages/fixtures/requests/event-attendee.yaml --confirm
```

To submit a local JSON payload through the sender fixture without printing payload values:

```bash
printf '{"full_name":"Alice Example","email":"alice@example.test"}' > /tmp/watasu-payload.json
pnpm --filter @watasu/cli watasu submit-fixture packages/fixtures/requests/event-attendee.yaml --payload /tmp/watasu-payload.json --confirm
```

## Local Demo

Build first, then start the local HTTP demo:

```bash
pnpm typecheck
pnpm --filter @watasu/http demo
```

Default server:

- `http://127.0.0.1:8787/.well-known/agent-card.json`
- `http://127.0.0.1:8787/schemas/plaintext.json`
- `http://127.0.0.1:8787/schemas/envelope.json`
- `POST http://127.0.0.1:8787/submit`
- `http://127.0.0.1:8787/ledger`

Manual checks:

```bash
curl http://127.0.0.1:8787/.well-known/agent-card.json
curl http://127.0.0.1:8787/schemas/plaintext.json
curl http://127.0.0.1:8787/schemas/envelope.json
```

For `POST /submit`, the local demo validates the A2A HTTP+JSON protocol gate, checks the encrypted envelope against the published fixture, delivers to a receiver fixture, and records metadata-only ledger rows. Use `Content-Type: application/a2a+json`, `A2A-Version: 1.0`, and `A2A-Extensions: https://watasu.dev/extensions/encrypted-intake/v1`.

For a no-server end-to-end handoff check, run:

```bash
pnpm demo:handoff
```

The handoff demo connects the local Agent Card, sender fixture, HTTP demo handler, receiver fixture, and metadata-only ledger in one process. Its JSON output should show `ok: true`, `ledger_contains_payload_body: false`, and `response_contains_plaintext_payload: false`.

## Verification Loop

Standard loop:

```bash
pnpm loop
```

`pnpm loop` runs `pnpm typecheck`, `pnpm test`, `pnpm lint`, and `pnpm review:self`.

Dependency, release-gate, or supply-chain changes require:

```bash
pnpm loop:full
```

Targeted checks:

```bash
pnpm typecheck
pnpm test
pnpm lint
pnpm review:self
pnpm exec vitest run packages/core/src/security-regression.test.ts
pnpm --filter @watasu/http test
```

`pnpm lint` currently runs the repository secret-scan helper. It is intentionally narrow: passing tests is not treated as a security proof.

## Current MVP Status

See `docs/mvp-plan.md` for the recommended next actions, including manual checks you can run locally.

Local Protocol MVP is implemented and manually testable.

Currently implemented:

- pnpm workspace foundation for `@watasu/core`, `@watasu/cli`, `@watasu/fixtures`, and `@watasu/http`
- request definition parsing and validation
- sensitivity policy checks for high-risk and prohibited fields
- canonical JSON and SHA-256 hash helpers
- immutable in-memory request version publishing
- hosted publish ownership checks for service keys, webhook origins, HTTPS, and unsafe destination hosts
- plaintext payload schema and encrypted envelope schema generation
- A2A-compatible Agent Card generation
- A2A HTTP+JSON protocol gate
- submission envelope validation, replay/idempotency/rate-limit hooks, and payload hash checks
- in-memory capability registry for revoke and rotate without mutating request versions
- webhook delivery helper with signed headers, a fetch-based HTTP adapter, and metadata-only ledger rows
- delivery timeout classification that returns `resubmit_later` without retaining payload bodies
- in-memory delivery circuit breaker for fail-fast `resubmit_later` after repeated webhook failures
- in-memory delivery concurrency limiter for request and tenant caps
- storage policy boundary for stateless-by-default delivery and opt-in metadata ledger writes
- metadata ledger read authorization helper with tenant, role, and audit checks
- metadata ledger retention helper for deleting expired delivery metadata without exposing payload bodies
- flattened JWE JSON payload encryption/decryption wrapper with fixed algorithm allowlist
- MCP server package with a read-only request definition validation tool
- MCP publish tool plus read tools and resources for Agent Card, plaintext schema, envelope schema, and metadata-only ledger rows
- sender and receiver fixtures for local A2A handoff checks
- file-based CLI wrappers and a local HTTP demo

Still remaining for Hosted Production MVP:

- dashboard UI or human form builder
- user-side agent, personal vault, or consumer AI companion
- hosted production service
- optional persistent metadata store and hosted retention jobs
- MCP hosted production surface beyond local in-memory publish and read tools
- service-owned key management beyond the local JWE wrapper
- production retry queue for payload bodies

See `docs/prd-cli-mvp.md`, `docs/erd-cli-mvp.md`, and `docs/mvp-plan.md` for the deeper product and engineering contract.
