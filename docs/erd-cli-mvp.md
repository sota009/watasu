# watasu ERD: エージェント向け MCP/CLI 暗号化 intake MVP

## 0. 読む前提

この文書は実装者向けの Engineering Requirements Document、つまり実装要件書である。プロダクトの目的、利用者、用語の短い説明は `docs/prd-cli-mvp.md` に置く。この ERD は、スキーマ、プロトコル、データモデル、セキュリティ不変条件、受け入れテスト、技術スタックを定義する。

## 1. 目的

この ERD は、watasu MVP をどう作るかを決める。PRD は「何を作るか」を定義し、ERD は「どう実装し、何を満たせば完成か」を定義する。

対象:

- 要求定義 schema
- MCP tools / resources / prompts
- A2A Agent Card / AgentExtension / submission operation
- JWE / JWK 暗号化方針
- webhook delivery
- delivery ledger
- データモデル
- replay protection
- 検証用コンポーネント
- contract tests
- 技術スタック

## 2. プロトコル前提

2026-06-14 時点の前提:

- MCP: 2025-11-25 specification (latest)
- A2A: latest / v1.0 specification
- WebMCP: Chrome docs の WebMCP 概念
- auth.md: WorkOS auth.md

生成物には、対応する A2A spec version と MCP spec version を含める。MCP は `/specification/latest` が指す版を確認してから更新し、contract tests は実装時に採用した固定 spec version に対して走らせる。

実装開始 gate:

- 実装着手日の公式 MCP latest URL、A2A latest URL、採用する protocol version、参照した schema commit または vendored schema hash を記録する。
- MCP TypeScript SDK は package name、major version、安定版 status、import path を実装着手日に確認し、lockfile に固定する。alpha / beta / pre-release を使う場合は production hosted release ではなく local demo に限定する。
- A2A Agent Card、AgentExtension、HTTP+JSON binding は公式 schema または vendored snapshot に対する contract test を必須にする。
- A2A HTTP+JSON binding は `application/a2a+json`、`A2A-Version`、`A2A-Extensions` の扱いを実装着手日に公式仕様で確認し、受信時 protocol gate と negative contract tests に固定する。
- MCP server は tool descriptions、resources、prompts、elicitation inputs を信頼済み命令として扱わない。MCP 仕様の Security and Trust & Safety に従い、tool 実行は人間の同意、最小権限、引数 validation、監査ログを前提にする。
- AI/LLM が request definition を生成または修正する箇所は、OWASP Top 10 for LLM Applications 2025 の Prompt Injection、Insecure Output Handling、Supply Chain Vulnerabilities、Sensitive Information Disclosure、Insecure Plugin Design、Excessive Agency を実装前脅威モデルに含める。

参考仕様:

- MCP: https://modelcontextprotocol.io/docs/getting-started/intro
- MCP latest specification: https://modelcontextprotocol.io/specification/latest
- MCP 2025-11-25 specification: https://modelcontextprotocol.io/specification/2025-11-25
- MCP TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk
- A2A overview: https://a2a-protocol.org/latest/topics/what-is-a2a/
- A2A and MCP comparison: https://a2a-protocol.org/latest/topics/a2a-and-mcp/
- A2A specification: https://a2a-protocol.org/latest/specification/

## 3. 技術スタック

MVP は「CLI / MCP で完結」「dashboard UI なし」「user-side agent 本体なし」「payload 非保持」を前提に、TypeScript 中心で実装する。

### 3.1 ランタイムと言語

| 項目 | 採用 | 理由 |
| --- | --- | --- |
| ランタイム | Node.js 24 LTS | 2026-06-14 時点で Node.js 24 は LTS。production application には Active LTS または Maintenance LTS を使うという Node.js の方針に合う。 |
| 言語 | TypeScript 5.x | MCP SDK、JWE/JWK、JSON Schema、CLI、HTTP endpoint を同じ型システムで扱える。エージェントに公開する schema と実装のズレを減らせる。 |
| module形式 | ESM | 現行の Node / TypeScript エコシステムと相性がよく、MCP SDK や jose と合わせやすい。 |
| package manager | pnpm workspace | CLI、MCP server、core library、contract fixtures を package 分割しやすい。 |

### 3.2 主要パッケージ

| 項目 | 採用 | 理由 |
| --- | --- | --- |
| MCP SDK | `@modelcontextprotocol/server` v1.x | 公式 TypeScript SDK。2026-06-14 時点で v2 は pre-alpha / 2026年Q3安定化予定なので、MVP の production 用途では v1.x を使う。 |
| HTTP endpoint | Node.js HTTP + thin router または Hono | A2A submission endpoint と Agent Card 配信に使う。MCP SDK には Node/Hono middleware があるため、薄いHTTP層に留める。 |
| JSON Schema validation | Ajv 2020-12 | JSON Schema draft 2020-12 をサポートし、公開済み schema と envelope schema の contract tests に使える。 |
| Runtime validation | Zod v4 | MCP tool input/output の実装側 validation に使う。MCP SDK の Standard Schema 方針と合わせやすい。 |
| JWE / JWK | `jose` | JWE、JWK、JWK thumbprint、Web Crypto runtime を扱える。暗号処理を自前実装しない。 |
| DB access | Optional | MVP default は persistent metadata store を必須にしない。必要になった場合だけ storage interface の背後に追加する。 |
| Local DB | Optional SQLite / Node SQLite | local demo や contract tests で metadata-only persistence を証明する場合だけ使う。default path は in-memory / short-lived state。 |
| Hosted DB | Optional PostgreSQL-compatible DB | hosted で persistent metadata ledger を明示的に有効化する場合だけ使う。大量利用や multi-tenant production では SQLite ではなく PostgreSQL-compatible DB を前提にする。 |
| CLI | Node.js CLI + commander系の軽量 parser | CLI command surface を薄く保ち、core library を MCP tools と共有する。 |
| test runner | Vitest | TypeScript の unit / contract / snapshot tests をまとめやすい。 |
| Logging | pino などの structured JSON logger | payload redaction、request_id、submission_id、delivery status を構造化して残せる。 |

### 3.3 採用しないもの

| 技術 | MVPで採用しない理由 |
| --- | --- |
| dashboard framework | dashboard UI はMVPスコープ外。CLI / MCP ledger で十分。 |
| full web app framework | UI を持たないため Next.js / Remix などは不要。 |
| custom crypto implementation | JWE/JWK は `jose` に寄せ、自前暗号実装を避ける。 |
| user-side agent framework | user-side agent 本体は別プロダクト。watasu は A2A互換の intake interface と contract fixture だけを提供する。 |
| production retry queue for payload | No payload custody の原則に反するため、encrypted payload を保存して後続 retry しない。 |

## 4. 要求定義スキーマ

要求定義は YAML または JSON で受け付け、publish 時に canonical JSON へ正規化する。

例:

```yaml
name: event-attendee-intake
schema_version: "2026-06-14"
description: ExampleConf の参加者情報を受け取る
fields:
  - id: full_name
    type: string
    required: true
    purpose: 受付で参加者を確認するため
    sensitivity: low
  - id: email
    type: string
    format: email
    required: true
    purpose: イベント連絡を送るため
    sensitivity: moderate
  - id: allergies
    type: string
    required: false
    purpose: 食事提供時の安全確認のため
    sensitivity: high
consent:
  text: ExampleConf はこの情報をイベント運営のためだけに利用します。
destination:
  type: webhook
  url: https://example.com/watasu/intake
retention:
  destination_policy: イベント終了後 30 日以内に削除します。
encryption:
  mode: required
  algorithm: JWE
  key_management: ECDH-ES+A256KW
  content_encryption: A256GCM
  service_key_id: jwk-thumbprint:sha256:...
  public_key_jwk:
    kty: EC
    crv: P-256
    x: base64url...
    y: base64url...
metadata_retention:
  days: 90
trust_profile: verified_sender
```

必須項目:

- `name`
- `schema_version`
- `description`
- `fields`
- `fields[].id`
- `fields[].type`
- `fields[].required`
- `fields[].purpose`
- `fields[].sensitivity`
- `consent.text`
- `destination.type`
- `destination.url`
- `retention.destination_policy`
- `encryption.mode`
- `encryption.algorithm`
- `encryption.key_management`
- `encryption.content_encryption`
- `encryption.service_key_id`
- `encryption.public_key_jwk`
- `metadata_retention.days`
- `trust_profile`

公開済み request version は immutable とする。fields、consent text、destination policy、encryption key、retention policy のいずれかを変更する場合は、新しい request version を作る。

`trust_profile` は `public_capability`, `verified_sender`, `private_invite`, `local_demo` のいずれかとする。production hosted request の default は `verified_sender` である。`public_capability` は `sensitivity: high` を含む request では publish できない。`local_demo` は localhost と fixture のみで使い、hosted publish では拒否する。

### 4.1 sensitivity classification gate

`fields[].sensitivity` は service-side agent や service developer の自己申告だけを信頼しない。`validate_request` は field id、field label、purpose、format、examples、destination policy、requested use case から sensitivity を推定し、申告値より高い分類が必要な場合は publish 前に blocking error または human override を要求する。

最低分類:

| Category | Examples | Minimum sensitivity | Hosted publish rule |
| --- | --- | --- | --- |
| Contact | email, phone, name, social handle | moderate | `public_capability` 可。ただし high category と同居する場合は request 全体を high 扱いにする。 |
| Location / address | address, postal code, precise location, workplace location | high | `verified_sender` 以上。 |
| Health / safety | allergies, medication, symptoms, disability, emergency contact | high | `verified_sender` 以上。医療・生命安全用途は conditional scope として publish summary に外部責務を表示する。 |
| Financial / tax | bank account, income, tax id, invoice details, payment credentials | high | `private_invite` 推奨。少なくとも `verified_sender` 必須。 |
| Government / identity | government id, passport, driver license, national id, KYC document | high | `private_invite` 必須。 |
| Minor / guardian | age under 18, school, guardian consent, child profile | high | `private_invite` 必須。 |
| Authentication secret | password, token, API key, private key, recovery code | prohibited | hosted publish 拒否。watasu intake で収集しない。 |
| Special category / safety-sensitive metadata | political, religious, union, DV shelter, whistleblowing, anonymous source | prohibited for MVP | MVP publish 拒否。metadata ledger と相性が悪い。 |

Validation rules:

- `public_capability` は high または prohibited category を含む request で使えない。
- `verified_sender` は high category を扱えるが、identity proof、legal consent、regulated retention、DSAR、emergency access は watasu 外の責務として publish summary に表示する。
- `private_invite` は high category の default recommendation であり、government identity、minor data、financial/tax、限定 B2B onboarding では推奨ではなく必須にできる。
- Human override は `public_capability` への格下げには使えない。安全側への格上げ、field 削除、MVP non-goal として publish 拒否のいずれかだけを許可する。
- sensitivity inference rule は snapshot test し、`allergies`, `government_id`, `tax_id`, `address`, `minor_age`, `api_key`, `political_affiliation` が低分類で通らないことを受け入れ条件にする。

## 5. 正規化とハッシュ

watasu が生成する値:

- `request_id`
- `request_version`
- `request_version_hash`
- `schema_hash`
- `consent_text_hash`
- `field_purposes_hash`
- `destination_policy_hash`
- `public_key_fingerprint`

正規化要件:

- YAML は hashing 前に canonical JSON へ変換する。
- object key は並べ替える。
- fields の配列順は保持する。
- UTF-8 を使う。
- SHA-256 で hash する。
- hash は padding なしの base64url で encode する。
- hash 表記は `sha256:<base64url-no-padding>` に統一する。

この encoding は request versions、Agent Cards、JWE headers、delivery ledger rows、webhook signatures、contract test fixtures のすべてで必須とする。

## 6. 暗号化方針

MVP の標準暗号化形式は JWE とする。

デフォルト:

- `alg`: `ECDH-ES+A256KW`
- `enc`: `A256GCM`
- 公開鍵形式: JWK
- key id: JWK thumbprint 由来の識別子

JWE compact serialization または JSON serialization をサポートしてよい。ただし MVP examples は JSON serialization を使う。

```json
{
  "protected": "...",
  "encrypted_key": "...",
  "iv": "...",
  "ciphertext": "...",
  "tag": "..."
}
```

JWE protected header に含めるもの:

- `alg`
- `enc`
- `kid`
- `typ: "watasu+jwe"`
- `request_id`
- `request_version`
- `schema_hash`

HPKE は将来候補として残す。`age` は local demo 用にサポートしてもよいが、エージェント間の相互運用 interface にはしない。

## 7. MCPインターフェース

MCP は service-side agents 向けの主要 interface である。

### 7.1 Tools

必須 tools:

| Tool | Input | Output | Confirmation |
| --- | --- | --- | --- |
| `validate_request` | request definition JSON/YAML | validation result、normalized definition、warnings | No |
| `publish_request` | normalized request definition、destination config、service public key | request_id、request_version、hashes、URLs | Yes |
| `inspect_request` | request_id、optional version | canonical request definition、status、hashes | No |
| `get_agent_card` | request_id、version | A2A-compatible Agent Card | No |
| `get_schema` | request_id、version | plaintext JSON Schema、envelope schema | No |
| `run_test_submission` | request_id、sample payload、test key config | encrypted submission result、webhook result | Yes |
| `list_ledger` | request_id、filters | delivery metadata list | No |
| `inspect_delivery` | submission_id | delivery metadata、error category | No |

すべての tools は以下を持つ。

- `name`
- `title`
- `description`
- `inputSchema`
- `outputSchema`
- side effect policy: `read_only`, `dry_run_available`, `requires_confirmation`, `external_delivery_attempt`
- payload handling policy: `no_plaintext_payload`, `no_payload_persistence`, `metadata_only`

Tool responses は `outputSchema` に合う structured content を返す。free text だけに依存しない。

### 7.2 Resources

必須 resources:

- `watasu://requests/{request_id}/versions/{version}`
- `watasu://requests/{request_id}/agent-card`
- `watasu://requests/{request_id}/schemas/plaintext`
- `watasu://requests/{request_id}/schemas/envelope`
- `watasu://deliveries/{submission_id}`

### 7.3 Prompts

必須 prompts:

- `draft_request_from_service_context`
- `review_request_before_publish`
- `debug_delivery_failure`
- `version_request_after_validation_error`

### 7.4 elicitation方針

MCP elicitation は、非機微な service-side 情報だけに使う。

- request name
- destination label
- retention days
- publish confirmation

MCP elicitation で利用ユーザーの個人データや高機微情報を要求してはいけない。利用ユーザーの個人データ収集は、外部 user-side agent の A2A intake flow と同意処理の責務である。

### 7.5 エラーコード

共通 error codes:

- `invalid_request_definition`
- `unsafe_destination`
- `missing_public_key`
- `key_ownership_unverified`
- `request_version_conflict`
- `publish_requires_confirmation`
- `payload_not_accepted_by_policy`
- `delivery_failed`
- `resubmit_later`

## 8. A2Aインターフェース

A2A は、外部 user-side agents 向けの互換 interface である。watasu MVP は intake Agent Card、schemas、submission endpoint を公開するが、user-side agent workflow 自体は実装しない。

### 8.1 Agent Cardプロファイル

watasu は intake request ごとに A2A-compatible Agent Card を公開する。

この card は、狭い intake agent/server として以下の skill を表す。

- `id`: `encrypted_personal_data_intake`
- input mode: `application/json`
- output mode: `application/json`
- endpoint: request-specific message endpoint

watasu固有の metadata は A2A AgentExtension として宣言する。top-level custom `x-*` fields は追加しない。

```json
{
  "name": "watasu encrypted intake for ExampleConf",
  "description": "Accepts encrypted personal data submissions bound to a published watasu request version.",
  "provider": {
    "organization": "watasu",
    "url": "https://watasu.dev"
  },
  "version": "1.0.0",
  "defaultInputModes": ["application/json"],
  "defaultOutputModes": ["application/json"],
  "supportedInterfaces": [
    {
      "url": "https://api.watasu.dev/a2a/requests/req_123/v1",
      "protocolBinding": "HTTP+JSON",
      "protocolVersion": "1.0"
    }
  ],
  "capabilities": {
    "streaming": false,
    "pushNotifications": false,
    "extendedAgentCard": false,
    "extensions": [
      {
        "uri": "https://watasu.dev/extensions/encrypted-intake/v1",
        "required": true,
        "params": {
          "request_id": "req_123",
          "request_version": "v1",
          "schema_hash": "sha256:...",
          "consent_text_hash": "sha256:...",
          "destination_policy_hash": "sha256:...",
          "encryption": {
            "required": true,
            "algorithm": "JWE",
            "key_management": "ECDH-ES+A256KW",
            "content_encryption": "A256GCM",
            "service_key_id": "jwk-thumbprint:sha256:...",
            "public_key_fingerprint": "sha256:..."
          },
          "submission": {
            "max_payload_bytes": 262144,
            "expires_in_seconds": 900,
            "idempotency_required": true
          }
        }
      }
    ]
  },
  "skills": [
    {
      "id": "encrypted_personal_data_intake",
      "name": "Encrypted personal data intake",
      "description": "Accepts encrypted personal data submissions bound to a published request version.",
      "inputModes": ["application/json"],
      "outputModes": ["application/json"],
      "tags": ["personal-data", "encrypted-intake", "watasu"]
    }
  ]
}
```

生成した Agent Card は、選択した `protocolVersion` の公式 A2A AgentCard schema を満たす必要がある。snapshot fixtures には watasu extension block だけでなく、A2A 必須 fields をすべて含める。

Public Agent Card に含めてよいもの:

- request_id
- request_version
- schema_hash
- consent_text_hash
- destination_policy_hash
- service public key fingerprint
- encryption algorithm
- max payload size
- submission TTL
- rate limit summary
- revocation status

Public Agent Card に含めてはいけないもの:

- service webhook secret
- service private key
- internal receiver URL
- raw sender identifier
- user personal data
- 実在する個人データを含む plaintext example payload

Public card では不足する場合だけ authenticated Extended Agent Card を使う。Extended Agent Card でも secrets や private keys は公開しない。

### 8.2 発見方法

サポートする discovery paths:

- domain-level discovery: `https://{domain}/.well-known/agent-card.json`
- request-specific discovery: watasu-issued Agent Card URL
- private/direct discovery: invite link、QR、email、app handoff
- future registry discovery: request type または skill tag search

### 8.3 submission操作

外部 user-side agents は A2A `Send Message` 経由で encrypted data を submit する。

MVP は HTTP+JSON/REST binding を優先する。内部 model は A2A operations と data model に近づけ、将来 JSON-RPC を追加しやすくする。

ルール:

- HTTP+JSON request は `Content-Type: application/a2a+json` を要求する。互換上 `application/json` を local demo で許す場合も hosted production では拒否する。
- HTTP+JSON request は `A2A-Version: 1.0` を要求する。unsupported、missing、downgrade、future version は envelope validation 前に structured protocol error として拒否する。
- Request が watasu extension に依存する場合、`A2A-Extensions` に `https://watasu.dev/extensions/encrypted-intake/v1` が含まれることを要求する。
- watasu extension の breaking change は URI を変える。`/v1` の semantics を mutate しない。
- `messageId` は `submission_id` または idempotency key に対応づける。
- `metadata` は `request_id`、`request_version`、`schema_hash` を含む。
- `parts` は `mediaType: "application/json"` の structured data を使う。
- legacy `kind` discriminator は使わない。
- Response は delivery acknowledgement または sender-actionable error を structured data として返す。
- default HTTP+JSON response は webhook delivery が成功、失敗、timeout するまで blocking とする。
- 将来 non-blocking mode を追加する場合、`accepted` は「sender から見える protocol state として validate 済み・queue 済み」を意味し、webhook delivery を意味しない。

Protocol gate order:

1. HTTP method、content type、body size、A2A version、A2A extension opt-in を検証する。
2. A2A `SendMessageRequest` schema、`message.role`、`parts[].mediaType`、`metadata` を検証する。
3. watasu envelope schema、request version、capability URL、hash、TTL、signature、rate limit を検証する。
4. 検証に成功した場合だけ webhook delivery を試行する。

Protocol gate で拒否された request は webhook delivery、ledger consent receipt 作成、idempotency terminal mark を行わない。ただし abuse investigation 用の短期 metadata は rate limit policy の範囲で記録してよい。

Response states:

- `accepted`
- `delivered`
- `rejected`
- `resubmit_later`
- `auth_required`

MVP state semantics:

- `delivered`: envelope validation が完了し、service webhook が delivery を受け入れた。
- `rejected`: validation、replay protection、capability URL status、rate policy、payload policy のいずれかで webhook delivery 前に拒否した。
- `resubmit_later`: webhook 5xx または timeout により delivery できず、watasu は encrypted payload を retry 用に保存しなかった。
- `auth_required`: request version が sender authentication または signature を要求しているが、不足または不正だった。
- `accepted`: 将来の non-blocking operation 用に予約する。default blocking MVP path では返さない。

## 9. 暗号化submission envelope

Envelope fields:

- `request_id`
- `request_version`
- `schema_hash`
- `submission_id`
- `idempotency_key`
- `encrypted_payload`
- `encrypted_payload_hash`
- `encryption_algorithm`
- `service_key_id`
- `consent_receipt_hash`
- `consent_receipt`
- `submitted_at`
- `expires_at`
- `sender_pseudonym`
- `sender_auth`
- `sender_signature`

`sender_auth` fields:

- `trust_profile`
- `sender_key_id`, required for `verified_sender` and `private_invite`
- `sender_jwk_thumbprint`, required for `verified_sender` and `private_invite`
- `sender_assertion_type`: `detached_jws`
- `signature_algorithm`: `EdDSA` preferred, `ES256` allowed for compatibility

Sender signature policy:

- `public_capability`: sender signature is optional, but `idempotency_key`, `submitted_at`, `expires_at`, payload size limit, capability URL, and rate limits are mandatory.
- `verified_sender`: sender signature is required. Unknown or invalid sender keys return `auth_required` before webhook delivery.
- `private_invite`: sender signature and invite-bound capability URL are both required.
- `local_demo`: sender signature may be disabled only when the server runs in explicit local demo mode and rejects non-localhost network origins.

Signature input is the canonical JSON serialization of immutable envelope metadata plus `encrypted_payload_hash`: `request_id`, `request_version`, `schema_hash`, `submission_id`, `idempotency_key`, `encrypted_payload_hash`, `service_key_id`, `consent_receipt_hash`, `submitted_at`, `expires_at`, and `sender_pseudonym`. The plaintext payload and encrypted payload body are not included directly in persistent records; signature verification uses the in-memory request body during the delivery attempt.

Sender trust registry minimum:

- `verified_sender` と `private_invite` は、request version に紐づく registered sender key だけを許可する。
- sender key は `sender_key_id`、JWK thumbprint、algorithm、tenant_id、request_id、request_version scope、status、not_before、expires_at、revoked_at、created_at を持つ。
- raw sender identifier は保存しない。運用上必要な表示名は service 側設定または encrypted configuration storage に置き、relational DB には hash / pseudonym だけを置く。
- unknown、revoked、expired、scope mismatch、algorithm mismatch、signature mismatch は webhook delivery 前に `auth_required` を返す。
- key rotation は新しい sender key row を追加し、旧 key を `rotated` または `revoked` にする。過去 ledger row は旧 key の hash / key id で検証可能にする。
- `private_invite` は sender key と invite-bound capability の両方を検証する。どちらか片方だけ一致しても delivery しない。
- MVP は global public sender trust registry を提供しない。service ごとの allowlist と invite binding を最小信頼モデルとし、federated registry は将来拡張にする。

watasu が検証するもの:

- request が存在し、publish 済みであること
- request version が immutable かつ active であること
- request固有の capability URL が有効で、revoke されていないこと
- `schema_hash` が request version と一致すること
- 暗号化 algorithm が許可されていること
- `service_key_id` が request version と一致すること
- encrypted payload size が上限内であること
- `encrypted_payload_hash` が encrypted payload と一致すること
- `consent_receipt_hash` が consent receipt と一致すること
- `submitted_at` が許容 clock skew 内であること
- `expires_at` が過ぎていないこと
- `idempotency_key` が terminal delivery record をすでに作っていないこと
- submission が replay ではないこと
- sender が request-level と IP-level の rate limit 内であること
- request version の trust profile が要求する sender authentication または sender signature が存在し正しいこと
- sender key が request version scope に登録済みで、active で、期限内で、revoked ではないこと
- `private_invite` の場合、capability URL と sender key が同じ invite binding に属すること
- destination webhook を試行できること

watasu は plaintext payload schema を検証しない。payload を復号できないためである。復号後の validation は service-side receiver が行う。

## 9.1 Capability URL lifecycle

Capability URL は request version の公開 discovery credential であり、request content の一部ではない。漏洩時の rotate / revoke で request version を変えずに済むよう、credential lifecycle は request version から分離する。

要件:

- token は CSPRNG 由来の 256-bit 以上の entropy を持つ。
- DB には token 本文を保存せず、`capability_url_hash` と `capability_id` だけを保存する。
- URL は TLS 経由でのみ配布し、ログには full URL を出さない。
- revoke は即時反映し、revoked capability URL は webhook delivery 前に `rejected` を返す。
- rotate は同じ request version に新しい `capability_id` と Agent Card URL を発行し、旧 URL を revoke する。
- optional ledger を有効化した場合は `capability_id_hash` を保存し、後から漏洩影響範囲を調べられるようにする。

## 9.2 Rate limit defaults

MVP default:

- platform-level: network origin ごとに 60 submissions / minute。
- request-level: request version ごとに 30 submissions / minute。
- sender-pseudonym-level: verified sender ごとに 10 submissions / minute。
- burst: 各 bucket で短時間 burst 2x まで許容し、継続超過は webhook delivery 前に `rejected`。
- high sensitivity request: 上記の半分を default とし、publish summary に表示する。

Bucket keys は raw IP や raw sender identifier を保存せず、daily rotating pepper で hash する。abuse investigation 用の短期 raw network log は 7 日以内に削除する。

## 10. 同意receipt

Consent receipt fields:

- `request_id`
- `request_version`
- `consent_text_hash`
- `field_ids`
- `field_purposes_hash`
- `destination_policy_hash`
- `user_confirmation_method`
- `confirmed_at`
- `agent_disclosure`

保存方針:

- default path では consent receipt metadata を永続保存しない。
- optional persistent ledger を有効化した場合、すべての delivery ledger row に `consent_receipt_hash` を保存する。
- optional persistent ledger を有効化した場合、技術的証跡を再構成するための最小 metadata を保存する: `request_id`, `request_version`, `consent_text_hash`, `field_purposes_hash`, `destination_policy_hash`, `field_ids`, `user_confirmation_method`, `confirmed_at`, `agent_disclosure`。
- consent receipt の中に plaintext user payload values を保存しない。
- consent receipt の中に raw long-lived user identifier または raw long-lived agent identifier を保存しない。
- optional consent receipt metadata は optional delivery metadata と同じ期間保持する。ただし request version がより短い期間を指定する場合はそれに従う。

Trust boundary:

- watasu は user-side agent が完璧な consent UI を提示したことを保証しない。
- watasu は legal consent、identity proof、delegated authority を保証しない。
- watasu は request version、consent text、field purposes、destination policy の hash が submission と一致することを検証する。
- consent receipt は「何が提示されたか」を再構成するための証跡であり、完全な法的証明ではない。

## 11. Webhook配送

watasu は encrypted envelope を service webhook に配送する。

要件:

- HTTPS のみ
- watasu delivery signature header
- signature timestamp header
- body digest header
- idempotency key
- request_id
- submission_id
- request_version
- delivery timestamp
- encrypted envelope body

Webhook destination verification:

- hosted production では publish 前に domain ownership verification を必須にする。
- verification は HTTPS challenge `/.well-known/watasu-webhook-challenge/{challenge_id}` または DNS TXT `_watasu-challenge.{domain}` のどちらかで行う。
- HTTPS challenge fetch は `https:` origin のみ許可し、fetch 前に hostname の解決結果を検査して localhost、private IP、link-local、metadata service address を拒否する。redirect は自動追跡しない。
- DNS TXT challenge fetch は `_watasu-challenge.{domain}` の TXT record を解決し、複数chunk / 複数recordを正規化して expected token と照合する。HTTPS challenge と同じ domain ownership state に統合する。
- localhost、private IP、link-local、metadata service address、non-HTTPS URL は hosted production で拒否する。local demo mode だけ localhost を許可する。
- delivery 前には DNS rebinding と SSRF を避けるため、resolve 後 IP range を検証し、redirect 先も同じ制約で検証する。

Service public key ownership verification:

- publish 前に、service は `encryption.public_key_jwk` に対応する private key で watasu challenge を署名する。
- watasu は JWK thumbprint と challenge signature を検証し、`key_ownership_status: verified` でない request を production publish しない。
- key rotation は新しい request version を作る。旧 version は active のままにできるが、新規 submissions を止める場合は status を retired にする。

Delivery signature:

- watasu は service ごとの delivery signing key で、timestamp、request_id、request_version、submission_id、idempotency_key、body digest を署名する。
- receiver template は timestamp skew 300 秒以内、body digest 一致、signature 一致、idempotency key 未処理を検証する。
- signing secret または private key は secret store に保存し、relational DB には `signature_key_id` だけを保存する。

MVP templates:

- Node.js webhook receiver
- service-side decrypt and JSON Schema validate example

Webhook failure behavior:

- 5xx または timeout の場合、watasu は failed delivery metadata を記録する。
- watasu は retry のために encrypted payload を保持しない。
- watasu は sender に `resubmit_later` を返す。
- `resubmit_later` は idempotency key を terminal state として mark しない。sender は同じ payload を再送する場合、同じ `idempotency_key` と新しい `submission_id` / `submitted_at` / `expires_at` / signature を使う。payload を変更する場合は新しい `idempotency_key` を使う。
- `resubmit_later` response は `retry_after_seconds`、`retry_after_source`、`idempotency_key_policy: reuse_for_same_payload`、`payload_policy: sender_resubmits_payload`、`refresh_fields: ["submitted_at", "expires_at", "sender_signature"]` を含む。HTTP surface は同じ秒数を `Retry-After` header にも出す。

Delivery resilience defaults:

- hosted production の webhook delivery は connect timeout 2 秒、total timeout 5 秒を default とし、request definition で長くする場合も 10 秒を上限にする。
- request version ごとの concurrent deliveries は default 10、tenant ごとの concurrent deliveries は default 50 を上限にする。上限超過は webhook delivery 前に `resubmit_later` または rate-limit style error を返す。
- 同一 request version で連続 timeout / 5xx が閾値を超えた場合、short-lived circuit breaker を開き、breaker 中は encrypted payload を保持せず `resubmit_later` を返す。
- webhook redirect は最大 1 回までとし、redirect 先にも HTTPS、domain ownership、DNS rebinding / SSRF checks を再適用する。
- slow destination、breaker open、timeout、connection refused は `error_category` として区別し、payload body を含まない。
- delivery worker、HTTP client、APM trace、debug log は encrypted payload body を attribute や span event に含めない。

## 12. Optional persistent data model

MVP default は DB 永続化を必須にしない。watasu が default で保持してよいのは、replay protection、rate limits、sender-actionable response のための short-lived operational state である。

Persistent metadata ledger は service owner が明示的に有効化した場合だけ使う optional feature とする。local / single-node 検証では metadata-only JSONL store を使える。multi-tenant hosted production では PostgreSQL-compatible DB と scheduled retention job を前提にし、node-postgres compatible `query(text, values)` client に対して parameterized INSERT だけを発行する metadata-only adapter を使う。production runtime は `WATASU_METADATA_LEDGER_STORE=postgres` のときだけ database URL と pool settings を読む。database URL は secret 相当として logs / MCP output / error responses に出さない。PostgreSQL delivery ledger schema は `tenant_id` を primary key に含め、`tenant_id` は hosted service identity から注入し、request body / MCP tool arguments / Agent Card metadata 由来の値を信頼しない。schema artifact は plaintext payload、encrypted payload body、ciphertext、JWE protected header / iv / tag を保存する列を持たない。optional ledger を有効化する場合の最小 persistent entities:

### `requests`

- `request_id`
- `tenant_id`
- `name`
- `description`
- `created_at`
- `status`
- `current_version`

### `request_versions`

- `request_id`
- `tenant_id`
- `request_version`
- `canonical_request_json`
- `request_version_hash`
- `schema_hash`
- `consent_text_hash`
- `field_purposes_hash`
- `destination_policy_hash`
- `public_key_fingerprint`
- `service_key_id`
- `agent_card_url`
- `submission_endpoint_url`
- `capability_url_hash`
- `capability_id_hash`
- `capability_revoked_at`, nullable
- `trust_profile`
- `sender_auth_required`
- `key_ownership_status`
- `metadata_retention_days`
- `created_at`

`request_versions` は append-only とする。fields、consent text、destination policy、encryption key、retention policy を変更する場合は、新しい row を作る。

### `webhook_destinations`

- `request_id`
- `tenant_id`
- `request_version`
- `destination_type`
- `url_hash`
- `domain`
- `ownership_status`
- `signature_key_id`
- `verification_method`
- `verified_at`
- `created_at`

完全な webhook URL は encrypted configuration storage にだけ保存する。persistent metadata ledger が有効な場合でも、relational row には audit と lookup 用の hash と routing metadata だけを保存する。

### `delivery_ledger`

- `submission_id`
- `request_id`
- `tenant_id`
- `request_version`
- `schema_hash`
- `encrypted_payload_hash`
- `sender_pseudonym_hash`
- `consent_receipt_hash`
- `received_at`
- `delivered_at`
- `destination_type`
- `delivery_status`
- `retry_instruction_status`
- `error_category`
- `idempotency_key_hash`
- `rate_policy_result`
- `capability_id_hash`
- `trust_profile`
- `sender_auth_result`

### `consent_receipts`

- `consent_receipt_hash`
- `request_id`
- `tenant_id`
- `request_version`
- `consent_text_hash`
- `field_ids`
- `field_purposes_hash`
- `destination_policy_hash`
- `user_confirmation_method`
- `confirmed_at`
- `agent_disclosure`
- `created_at`

### `idempotency_keys`

- `idempotency_key_hash`
- `request_id`
- `tenant_id`
- `request_version`
- `submission_id`
- `first_seen_at`
- `expires_at`
- `status`

### `sender_keys`

- `sender_key_id`
- `tenant_id`
- `request_id`
- `request_version`
- `sender_jwk_thumbprint_hash`
- `algorithm`
- `status`
- `not_before`
- `expires_at`
- `revoked_at`, nullable
- `rotated_from_sender_key_id`, nullable
- `created_at`

`sender_keys` は `verified_sender` と `private_invite` の allowlist である。raw sender identifier、raw long-lived user identifier、private key は保存しない。

### `private_invites`

- `invite_id`
- `tenant_id`
- `request_id`
- `request_version`
- `capability_id_hash`
- `sender_key_id`
- `status`
- `expires_at`
- `revoked_at`, nullable
- `created_at`

`private_invites` は invite-bound capability URL と registered sender key の binding を表す。`private_invite` request では、この binding が active でない submission を webhook delivery 前に拒否する。

### `access_audit_logs`

- `audit_id`
- `actor_type`
- `actor_id_hash`
- `tenant_id`
- `action`
- `resource_type`
- `resource_id_hash`
- `decision`
- `observed_at`

Optional ledger metadata access, publish, revoke, rotate, and delivery inspection create audit log rows. Audit logs must not contain plaintext payload or encrypted payload body.

### `rate_limit_events`

- `request_id`
- `tenant_id`
- `request_version`
- `bucket_key_hash`
- `event_type`
- `decision`
- `observed_at`

### `service_identities`

- `service_identity_id`
- `tenant_id`
- `issuer`
- `subject_hash`
- `status`
- `created_at`
- `expires_at`
- `revoked_at`, nullable

### `service_identity_roles`

- `service_identity_id`
- `tenant_id`
- `role`
- `resource_scope`
- `created_at`

Minimum hosted roles:

| Role | Allowed actions |
| --- | --- |
| `publisher` | validate request、dry-run publish、publish request after human confirmation |
| `request_admin` | retire request version、revoke / rotate capability URL、view request metadata |
| `key_admin` | register / rotate / revoke service public keys and sender keys |
| `ledger_viewer` | list ledger、inspect delivery metadata、read consent receipt metadata |
| `auditor` | read access audit logs and security events |

Role rules:

- `publisher` alone cannot register sender keys, rotate capability URLs, or read ledger metadata.
- `ledger_viewer` cannot publish, revoke, rotate, or change keys.
- `key_admin` cannot read ledger metadata unless it also has `ledger_viewer`.
- service public key registry は verified ownership result がある public JWK だけを登録し、private JWK field (`d`) や secret material を保存しない。rotate / revoke 後の key は hosted publish ownership state から外す。
- KMS/HSM-backed private key custody や secret manager integration は watasu の public-key registry の外側に置き、service 側責務として扱う。
- Break-glass admin is out of MVP unless it has explicit time-bound elevation and audit log entries.
- Every hosted MCP/CLI operation derives `tenant_id` from service identity, not from user-controlled request parameters.

## 13. Optional delivery ledger

Default hosted path は persistent delivery ledger を作らない。短期 operational state は TTL 付きで保持し、期限後に削除する。以下は optional persistent ledger を明示的に有効化した場合だけ保存してよい fields:

- request_id
- request_version
- submission_id
- schema_hash
- encrypted_payload_hash
- sender_pseudonym_hash
- consent_receipt_hash
- consent receipt metadata。別テーブルに保存し、`consent_receipt_hash` で join する
- received_at
- delivered_at
- destination type
- delivery status
- retry instruction status
- error category
- idempotency_key hash

保存しないもの:

- plaintext payload
- decrypted payload
- delivery attempt 後の encrypted payload body
- HTTP body parser temp files, debug dumps, crash reports, APM traces, metrics labels, queue payloads, and structured logs containing plaintext payload or encrypted payload body
- raw long-lived agent identifier
- 短期運用ログを超える raw sender network identifier
- service private key

Ledger metadata は、組み合わせによって personal data または personal-related information になり得る。そのため persistent ledger は default-off とし、有効化する場合は retention、access control、audit logging を適用する。

Default short-lived state and optional ledger retention:

- default idempotency / replay state: request policyに従う短期TTL。MVP default は 24 hours 以下を目標にする。
- default rate limit events: 24 hours 以下を目標にする。
- optional delivery ledger and consent receipt metadata: default 7 days、service owner が明示した場合でも request policy の上限を超えない。
- high sensitivity request metadata in optional ledger: 30 days maximum unless the request explicitly requires a shorter period.
- raw network abuse logs, if enabled: 7 days maximum.
- optional access audit logs: 180 days maximum, metadata only.

Hosted ledger access control:

- CLI / MCP hosted access requires a service API token or OAuth-style service identity.
- deployment identity provider integration may pass service identity through short-lived signed headers. Signed headers must include tenant id, roles, issued_at, and HMAC-SHA256 signature; watasu verifies timestamp skew and signature before converting them into trusted service identity.
- requests, request_versions, deliveries, and audit logs are scoped by `tenant_id`.
- `list_ledger` and `inspect_delivery` enforce tenant and role checks server-side.
- role は `service_identities` と `service_identity_roles` から解決し、request body、MCP tool arguments、Agent Card metadata に含まれる tenant / role は信頼しない。
- read access to consent receipt metadata is logged in `access_audit_logs`.
- retention job は auditor role を持つ hosted service identity からだけ実行できる。tenant_id と request_version scope を保ったまま ledger、consent receipt、rate limit events、raw network abuse logs を期限通り削除または anonymize し、job result には payload body や encrypted payload body を含めない。
- cross-tenant request_id、submission_id、consent_receipt_hash、idempotency_key_hash を指定した inspection は `not_found` または authorization error になり、存在有無を漏らさない。

Payload persistence controls:

- request body は size limit 後に memory-only stream として処理し、disk-backed multipart / temp file parser を hosted submission endpoint で使わない。
- logger は allowlist 方式にし、request body、headers containing capability token、encrypted payload、consent receipt body、full webhook URL を default で出力しない。
- OpenTelemetry / APM は attribute allowlist を使い、payload、capability token、full URL、sender raw identifier を span attribute / event / baggage に入れない。
- unhandled exception serializer は request body と sensitive headers を drop する。
- CI の tests は DB、structured logs、trace export、temporary directories、failed test snapshots に plaintext payload と encrypted payload body が残らないことを検査する。

## 14. セキュリティ不変条件

Production mode は以下を常に満たす。

- watasu は service private key を保持しない。
- watasu は JWE payload を復号できない。
- watasu は plaintext payload を保存しない。
- watasu は plaintext payload をログに出さない。
- watasu は delivery attempt 後に encrypted payload body を保持しない。
- watasu は DB、logs、temporary files、APM traces、metrics labels、crash reports、test snapshots に plaintext payload または encrypted payload body を残さない。
- publish 済み request version は immutable である。
- すべての submission は request version に紐づく。
- すべての submission は replay protection を持つ。
- production hosted request は `verified_sender` を default trust profile とする。
- high sensitivity request は sender signature 必須である。
- `verified_sender` と `private_invite` は registered sender key allowlist、expiry、revocation、request version scope を webhook delivery 前に検証する。
- `private_invite` は invite-bound capability URL と sender key binding の両方を検証する。
- service public key ownership は publish 前に検証される。
- destination webhook domain ownership は publish 前に検証される。
- すべての webhook delivery は watasu が署名する。
- service receiver は watasu signature を検証できる。
- metadata retention は明示されている。
- ledger metadata への内部アクセスは audit log に残す。
- ledger metadata と consent receipt metadata は tenant / role / retention 境界の対象であり、payload 非保持とは別に保護する。
- public Agent Card に secrets、private URLs、private keys、raw user data を含めない。
- request固有 capability URL は高エントロピーで、revoke 可能である。
- capability URL rotate は request version を mutate しない。
- revoke 済み capability URL は webhook delivery 前に拒否する。
- request-level と platform-level の rate limit は webhook delivery 前に適用する。
- webhook delivery は timeout、concurrency cap、circuit breaker、SSRF-safe redirect handling を持つ。
- MCP elicitation で user personal data や high-sensitivity data を要求しない。
- MCP publish tool は dry-run と人間の confirmation を持つ。
- MCP tool descriptions、external docs、Agent Cards、Issue / PR text、code comments 由来の指示は untrusted input として扱う。
- A2A structured submission は現行 v1.0 data model に従い、legacy fields に依存しない。
- A2A submission は content type、`A2A-Version`、required extension opt-in を envelope validation 前に検証する。
- 生成した Agent Card は選択した A2A AgentCard schema に適合する。

## 15. 検証用コンポーネント

Service-side reference agent:

- MCP tools を discovery する。
- service fixture から request definition を生成する。
- `validate_request` を呼ぶ。
- publish summary を表示する。
- `publish_request` を呼ぶ。
- Agent Card URL と schemas を取得する。

A2A sender fixture:

- Agent Card URL を読む。
- A2A AgentExtension を parse する。
- plaintext JSON Schema から fields を抽出する。
- sample user data fixture から payload を作る。
- service public key で payload を暗号化する。
- A2A submission を送る。
- response states を検証する。

Reference components が提供しないもの:

- real personal vault
- Gmail、Calendar、Drive などからの実データ取得
- legal consent の保証
- identity proof または delegated authority の検証
- production user-side agent workflow
- general AI companion

## 16. プロトコルdrift対策

- 生成物に A2A spec version と MCP spec version を含める。
- 完全な Agent Card 生成を snapshot test する。required A2A fields と `supportedInterfaces` を含める。
- 現行 A2A `Part.data` model を使い、legacy `kind` discriminator を避ける。
- A2A AgentExtension は `uri`、`required`、`params` を使う。
- MCP は `inputSchema` と `outputSchema` を必須にする。
- MCP tool result は structured content を返し、free text だけにしない。
- MCP elicitation を sensitive personal data に使わない。
- CI で official schema または vendored schema snapshot に対する contract tests を走らせる。
- SDK package name、major version、import path、protocol schema hash は lockfile と generated fixtures に固定し、依存更新時に drift diff をレビューする。
- protocol upgrade 時は、この ERD と generated fixtures を同時に更新する。

## 17. 受け入れテスト

- MCP `validate_request` が request definition を validate できる。
- MCP `publish_request` が confirmation required である。
- MCP `publish_request` が immutable request version を作る。
- MCP resources から request、Agent Card、schemas、delivery metadata を取得できる。
- CLI が request definition を validate できる。
- publish 済み request が Agent Card と JSON Schema を公開する。
- publish 済み Agent Card が選択した A2A AgentCard schema に合う。
- publish 済み Agent Card が `supportedInterfaces` と `HTTP+JSON` と `protocolVersion` を宣言する。
- A2A Agent Card が `https://watasu.dev/extensions/encrypted-intake/v1` を含む。
- A2A sender fixture が Agent Card と schema を読める。
- A2A sender fixture が sample payload を submission 前に JWE 暗号化する。
- A2A submission が `Part.data` と `mediaType: "application/json"` を使う。
- hosted A2A HTTP+JSON endpoint が `Content-Type: application/a2a+json` を要求し、missing / wrong content type を envelope validation 前に拒否する。
- hosted A2A HTTP+JSON endpoint が `A2A-Version: 1.0` を要求し、missing / unsupported / downgrade / future version を envelope validation 前に拒否する。
- hosted A2A HTTP+JSON endpoint が required `A2A-Extensions: https://watasu.dev/extensions/encrypted-intake/v1` を要求し、missing extension opt-in を envelope validation 前に拒否する。
- A2A submission が legacy `kind` discriminator に依存している場合は拒否する。
- MCP tool results が `outputSchema` に合う。
- MCP elicitation が user personal data collection に使われない。
- MCP tool descriptions、resources、external docs、Agent Cards、Issue / PR text、code comments に含まれる instructions を system instructions として実行しない。
- `validate_request` が `allergies`, `government_id`, `tax_id`, `address`, `minor_age`, `api_key`, `political_affiliation` を low / moderate の自己申告だけで通さない。
- `public_capability` request が health、financial、government identity、minor、auth secret、safety-sensitive metadata を含む場合 publish を拒否する。
- watasu が invalid `schema_hash` を拒否する。
- watasu が unknown `service_key_id` を拒否する。
- watasu が expired submissions を拒否する。
- watasu が replayed `idempotency_key` を拒否する。
- watasu が revoked capability URLs を webhook delivery 前に拒否する。
- watasu が rate-limited submissions を webhook delivery 前に拒否する。
- watasu が encrypted envelope を webhook に配送する。
- watasu が `verified_sender` / `private_invite` request で missing or invalid sender signature を `auth_required` として webhook delivery 前に拒否する。
- watasu が unknown、revoked、expired、scope mismatch の sender key を `auth_required` として webhook delivery 前に拒否する。
- watasu が `private_invite` request で capability URL と sender key の invite binding mismatch を webhook delivery 前に拒否する。
- watasu が `public_capability` request に high sensitivity field が含まれる場合 publish を拒否する。
- service public key ownership challenge が成功しない request は production publish できない。
- destination webhook domain ownership challenge が成功しない request は production publish できない。
- hosted production は localhost、private IP、metadata service address、non-HTTPS destination を拒否する。
- leaked capability URL rotate 後、旧 URL は webhook delivery 前に拒否され、新 URL は同じ request version を指す。
- rate limit buckets が platform-level、request-level、sender-pseudonym-level で適用される。
- webhook delivery が connect timeout、total timeout、request / tenant concurrency cap、short-lived circuit breaker を適用し、slow destination で worker を枯渇させない。
- webhook redirect は最大 1 回までで、redirect 先にも HTTPS、ownership、DNS rebinding / SSRF checks が再適用される。
- webhook receiver が watasu delivery signature を検証できる。
- webhook receiver が timestamp skew、body digest、idempotency key を検証できる。
- service-side template が payload を復号し、validate できる。
- default hosted path が persistent ledger を作らない。
- optional ledger が有効な場合、metadata only で保存される。
- optional consent receipt metadata が plaintext payload values なしで保存される。
- optional ledger access が service identity 由来の tenant / role で制御され、metadata read が audit log に残る。
- `publisher`, `request_admin`, `key_admin`, `ledger_viewer`, `auditor` の権限境界が server-side で enforced される。
- cross-tenant ledger、consent receipt、idempotency key、sender key inspection が existence leak なしで拒否される。
- optional retention job が ledger metadata、consent receipt metadata、rate limit events、raw network abuse logs を request retention policy 通りに削除または anonymize する。
- DB が plaintext payload を保存しない。
- logs が plaintext payload を含まない。
- temporary files、APM traces、metrics labels、crash reports、failed test snapshots が plaintext payload と encrypted payload body を含まない。
- webhook 5xx が watasu payload retry persistence を発生させない。
- failed delivery が sender-actionable `resubmit_later` を返し、同じ payload retry では同じ `idempotency_key` と新しい `submission_id` / timestamp / signature を要求する。
- service-side validation failure は既存 request version を mutate せず、新しい request version で修正する。

## 18. 未決の技術課題

- 最小 A2A interoperability test suite の範囲。
- A2A verified sender discovery and federated trust registry の将来拡張。
- jurisdiction ごとの ledger metadata の legal classification。
- MCP server を watasu CLI に同梱するか、別 package として配布するか。
- hosted secret store の具体サービス選定。
- revoke / rotate 通知を A2A extension でどう表現するか。
