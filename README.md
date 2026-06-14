# watasu

watasu は、サービス側エージェントが個人データの要求定義を作り、外部のユーザー側エージェントが読める暗号化 intake endpoint を公開するための agent-native intake MVP です。

人間向けフォームを作るのではなく、「何を、なぜ、どこへ渡すか」を request definition / schema / Agent Card として機械可読にし、ユーザー同意にもとづく encrypted submission をサービス側 webhook へ配送する土台を作ります。

## Security Promise

watasu の境界は **no payload custody** です。

- watasu は plaintext payload を受け取らない、復号しない、保存しない、ログに出さない。
- watasu は service private key を持たない。
- watasu は encrypted payload body を delivery attempt 後に保持しない。
- webhook delivery に失敗しても payload retry queue は持たず、sender に `resubmit_later` を返す設計にする。
- 保存対象は request version、hash、delivery status、consent receipt metadata など、payload 値を含まない metadata に限定する。

metadata も個人関連情報になり得るため、tenant / role / retention / audit の対象として扱います。watasu は legal consent、本人確認、代理権限、規制対応、DSAR を保証しません。それらは service 側または別プロダクトの責務です。

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

通常ループ:

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

Implemented now:

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

Not in MVP yet:

- dashboard UI or human form builder
- user-side agent, personal vault, or consumer AI companion
- hosted production service
- production DB migrations and hosted retention jobs
- MCP server package
- real JWE encryption/decryption flow with service-owned private keys
- production retry queue for payload bodies

See `docs/prd-cli-mvp.md`, `docs/erd-cli-mvp.md`, and `docs/implementation-plan-tdd.md` for the deeper product and engineering contract.
