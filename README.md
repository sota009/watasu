# watasu

watasu is an agent-native intake MVP for service-side agents to define requests for personal data and publish encrypted intake endpoints that external user-side agents can read.

Instead of building human-facing forms, watasu makes "what is being sent, why it is needed, and where it goes" machine-readable as a request definition, schema, and Agent Card. It provides the foundation for delivering encrypted submissions, based on user consent, to a service-side webhook.

## Security Promise

watasu's boundary is **no payload custody**.

- watasu does not receive, decrypt, store, or log plaintext payloads.
- watasu does not hold the service private key.
- watasu does not retain encrypted payload bodies after a delivery attempt.
- If webhook delivery fails, watasu is designed to avoid keeping a payload retry queue and instead return `resubmit_later` to the sender.
- Stored data is limited to metadata that does not contain payload values, such as request version, hashes, delivery status, and consent receipt metadata.

Because metadata can still be personal-related information, it is treated as subject to tenant, role, retention, and audit controls. watasu does not guarantee legal consent, identity verification, delegated authority, regulatory compliance, or DSAR handling. Those remain the responsibility of the service side or another product.

## Workspace Layout

```text
docs/
  prd-cli-mvp.md              Product requirements and scope
  erd-cli-mvp.md              Engineering requirements, protocol, data model
  protocol-baseline.md        Latest-info and dependency vetting record
  implementation-plan-tdd.md  TDD phase plan
packages/
  core/                       Request validation, hashes, publish, schemas, A2A, delivery
  cli/                        File-based watasu CLI wrapper
  fixtures/                   Sample request definitions
  http/                       Local HTTP demo server
scripts/                      Loop, review, PR, and secret-scan helpers
```

## Quick Start

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm loop
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
pnpm --filter @watasu/http test
```

`pnpm lint` currently runs the repository secret-scan helper. It is intentionally narrow: passing tests is not treated as a security proof.

## Current MVP Status

Currently implemented:

- pnpm workspace foundation for `@watasu/core`, `@watasu/cli`, `@watasu/fixtures`, and `@watasu/http`
- request definition parsing and validation
- sensitivity policy checks for high-risk and prohibited fields
- canonical JSON and SHA-256 hash helpers
- immutable in-memory request version publishing
- plaintext payload schema and encrypted envelope schema generation
- A2A-compatible Agent Card generation
- A2A HTTP+JSON protocol gate
- submission envelope validation, replay/idempotency/rate-limit hooks, and payload hash checks
- webhook delivery helper with signed headers and metadata-only ledger rows
- file-based CLI wrappers and a local HTTP demo

Not yet in the MVP:

- dashboard UI or human form builder
- user-side agent, personal vault, or consumer AI companion
- hosted production service
- production DB migrations and hosted retention jobs
- MCP server package
- real JWE encryption/decryption flow with service-owned private keys
- production retry queue for payload bodies

See `docs/prd-cli-mvp.md`, `docs/erd-cli-mvp.md`, and `docs/implementation-plan-tdd.md` for the deeper product and engineering contract.
