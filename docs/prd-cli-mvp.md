# watasu PRD: Agent-native MCP/CLI encrypted personal data intake

## 1. 概要

watasu は、サービス側エージェントが個人データの要求定義と受け口を作り、利用ユーザー側エージェントがその要求に応じてデータを提供できるようにする、agent-native な個人データ intake ツールキット。

サービス開発者本人が手でフォーム項目をポチポチ入力するのではなく、サービス開発を支援しているエージェントが watasu の CLI または MCP tool surface を使って「このサービスはどの個人データを、何の目的で、どこに受け取りたいか」を定義する。watasu はその定義から、A2A 互換の Agent Card、JSON Schema、暗号化 envelope 仕様、配送設定を生成する。

利用ユーザー側の AI コンパニオンまたはデータエージェントは、その要求定義を読み、ユーザーに同意確認し、必要なデータを集め、サービス側公開鍵で payload を暗号化して watasu に送信する。

watasu は暗号化された envelope をサービス側 webhook に配送する。watasu は個人データを復号しない。payload 本文も保存しない。保存するのは配送台帳と最小限の接続メタデータだけ。

MVP では、人間用回答フォーム、回答一覧 DB、ユーザー vault、ログイン機能、非エンジニア向け dashboard は作らない。最初の価値検証に必要な作成、公開、送信、検証、配送確認は MCP tool surface と CLI で完結させる。主な利用者は人間ではなく、サービス開発側エージェントと利用ユーザー側エージェントである。

## 2. プロダクトの一文

サービス側エージェントが個人データの要求定義を作るだけで、利用ユーザー側エージェントが読める暗号化 intake endpoint を公開できる。

## 3. 背景と課題

これまでの Web では、サービスが個人データを集める場所は人間向けフォームだった。ユーザーはフォーム画面を開き、氏名、メール、住所、職歴、健康情報、希望条件などを手で入力していた。サービス側も、そのために毎回フォーム、入力 validation、一時 DB、CSV export、同意文、配送処理を作ってきた。

しかし、AI コンパニオンやデータエージェントがユーザーの代理として動くなら、データ受け渡しの中心は人間用フォームではなく、エージェントが読める要求定義と、エージェントが送れる受け取り口になる。

watasu が作りたいのは、人間が入力するフォームではない。サービス側エージェントが「必要な個人データの要求」を定義し、利用ユーザー側エージェントがその要求を理解して、ユーザーの同意のもとで必要なデータを集め、サービス側へ送れる場所である。

この受け口があることで、サービス側とユーザーの AI コンパニオンを便利に接続できる。サービスは「欲しいデータ」を機械可読に公開でき、ユーザー側エージェントは「何を、なぜ、どこへ渡すのか」を理解した上でデータ提供できる。

従来サービスが作っていた受領基盤:

- フォーム
- 一時 DB
- 同意文
- CSV export
- webhook routing
- 配送ログ
- 個人データのための場当たり的なセキュリティ設計

watasu はこれを agent-native な要求・受領レイヤーに置き換える。ただし、個人データ vault にはならない。

## 4. 目的

- サービス開発側エージェントが CLI または MCP tool surface から暗号化された個人データ受け口を作れるようにする。
- エージェントが A2A 互換メタデータ経由で要求内容を発見できるようにする。
- watasu が復号できない形で encrypted submission を受け付ける。
- encrypted submission をサービス側 webhook に配送する。
- payload 本文ではなく配送メタデータだけを保存する。
- ユーザー側エージェントとサービス側エージェントの挙動を検証できる reference agents を提供する。
- A2A、MCP、将来の WebMCP、auth.md に接続できる小さな protocol surface を定義する。

## 5. 設計原則

- Agent-native first: 人間が画面で入力する導線ではなく、エージェントが読める schema、tool contract、Agent Card を中心にする。
- MCP for service-side agents: サービス開発側エージェントが watasu を操作する入口は MCP を第一級 interface とする。CLI は同じ操作をローカルで検証するための実行基盤。
- A2A for user-side agents: 利用ユーザー側エージェントが受け口を発見し、要求内容を理解し、submission する入口は A2A 互換 Agent Card と message endpoint。
- No payload custody: watasu は plaintext payload も delivery attempt 後の encrypted payload body も保持しない。
- Immutable consent target: request version、consent text、field purpose、destination policy は submission 時点で再現できるように immutable にする。
- Explicit trust boundary: watasu は「ユーザーが法的に有効な同意をした」ことまでは保証しない。watasu が保証するのは、どの immutable request version に対して、どの consent receipt が添付されたかを検証・記録すること。
- Future UI remains agent-operable: 将来 UI を作る場合も、フォームビルダーではなく WebMCP-compatible な request builder / review surface として設計する。

## 6. Protocol Baseline

このPRDは、2026-06-14 時点で確認した以下の仕様を前提にする。

- MCP: 2025-06-18 specification
- A2A: latest / v1.0 specification
- WebMCP: Chrome docs の WebMCP 概念
- auth.md: WorkOS auth.md

### 6.1 MCP 2025-06-18 で使うもの

MCP は、サービス開発側エージェントが watasu を操作するために使う。

使う機能:

- Tools: `validate_request`、`publish_request`、`run_test_submission` などを model-controlled tool として公開する。
- Resources: request version、Agent Card、schemas、delivery metadata を取得可能な URI として公開する。
- Prompts: request 作成 workflow や review workflow をテンプレート化する。
- Elicitation: publish 前の不足情報や承認確認にだけ使う。

使わない、または制限する機能:

- MCP elicitation で利用ユーザーの機微な個人データを集めない。
- MCP tool annotation は便利なヒントとして扱うが、それだけを信頼境界にしない。
- 外部状態を変える tool は watasu 側の dry-run と client 側の human confirmation を必須にする。

### 6.2 A2A v1.0 で使うもの

A2A は、利用ユーザー側エージェントが watasu intake endpoint を発見し、要求内容を理解し、encrypted submission を送るために使う。

使う機能:

- Agent Card
- AgentSkill
- AgentExtension
- SecurityScheme / SecurityRequirement
- Send Message operation
- structured `Part.data` with `mediaType: "application/json"`
- Extended Agent Card, 必要になった場合

A2A v1.0 では `Part` の型判別に legacy な `kind` field を使わない。structured payload は `{"data": {...}, "mediaType": "application/json"}` の current form に寄せる。

Agent Card discovery は以下を使い分ける。

- domain-level discovery: `https://{domain}/.well-known/agent-card.json`
- request-specific discovery: watasu が発行する Agent Card URL
- private/direct discovery: 招待リンク、QR、メール、アプリ内handoff
- future registry discovery: request type や skill tag で検索可能な registry

公開 Agent Card には機密情報を入れない。必要な場合は authenticated Extended Agent Card を使う。public card に入れてよいのは、要求の概要、schema hash、consent hash、public key fingerprint、submission constraints まで。内部 webhook URL、secret、service private config は入れない。

### 6.3 WebMCP と auth.md の位置づけ

WebMCP は MVP の core protocol ではない。将来、非エンジニア向け UI を出す場合に、その UI を agent-operable にするために使う。

auth.md は MVP では実装しない。ただし、将来の agentic login、verified agent、user-claimed flow、OAuth-style authorization に接続できるよう、agent identity と sender signature の設計を塞がない。

## 7. MVP の非目的

- 人間向け回答フォーム。
- 非エンジニア向けの hosted intake builder UI。
- watasu 内の回答テーブル、回答一覧、回答閲覧画面。
- ユーザー個人データ vault。
- 一般ユーザー向け AI companion。
- ログイン、アカウント連携、auth.md ベースの agentic registration。
- Google Sheets、Notion、Airtable、S3 destination。
- production plaintext intake。
- 完全な本人確認、代理権限、法的 DSAR workflow。
- watasu が payload を保持して後続再送する retry queue。

## 8. 対象ユーザー

### 8.1 サービス開発側エージェント

MVP の主対象。サービス開発者の代理または支援者として動き、個人データの要求定義、受け口作成、schema 生成、webhook 設定、テスト送信を実行するエージェント。

90% のユースケースでは、人間の開発者が watasu CLI を直接叩くのではなく、開発環境や coding agent が watasu を tool として呼び出す想定。

利用する interface:

- CLI command
- MCP tools
- YAML または JSON の要求定義
- webhook endpoint
- public/private key
- local validation script

### 8.2 サービス開発者

サービス側エージェントに初期指示を出す人間。たとえば「イベント参加者から氏名、メール、アレルギー情報を集める受け口を作って」と自然言語や音声で指示する。細かい項目入力や画面操作を人間が担う前提にはしない。

必要に応じて、生成された要求定義、同意文、配送先、保持方針を review する。

### 8.3 利用ユーザー側エージェント

ユーザー本人の代理として動く AI コンパニオンまたはデータエージェント。サービス側が公開した Agent Card と要求定義を読み、ユーザーに提示し、同意を取り、必要なデータを集め、ローカルで validation し、payload を暗号化して送信する。

### 8.4 利用ユーザー

個人データを提供する本人。watasu の回答フォームに入力するのではなく、自分の AI コンパニオンを通じて、何をどの目的で渡すかを確認し、同意する。

### 8.5 Reference Agents

watasu が提供する最小限の service-side reference agent と user-side reference agent。デモ、テスト、初期 integration 用。一般消費者向け companion product ではない。

## 9. MVP スコープ

### 9.1 Agent-native 要求定義

サービス開発側エージェントは、ユーザーからの初期指示、既存コード、サービス仕様、destination 設定などをもとに要求定義ファイルを作成する。人間が手で全項目を入力する前提にはしない。

```yaml
name: event-attendee-intake
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
  public_key: age1...
  algorithm: age-v1
metadata_retention:
  days: 90
```

要求定義に必要な項目:

- request name
- description
- fields
- 各 field の required / optional
- 各 field の purpose
- 各 field の sensitivity level
- consent text
- destination webhook
- destination retention policy
- schema version
- service public key
- encryption algorithm
- metadata retention period

CLI は要求定義を validation し、canonical request version を生成する。公開済みの request version は immutable とする。

MVP 決定事項:

- default encryption primitive は JWE とする。
- payload encryption は `ECDH-ES+A256KW` + `A256GCM` を標準にする。
- service public key は JWK 形式で登録する。
- key id は JWK thumbprint をもとに生成する。
- HPKE は将来候補として残すが MVP default にはしない。
- age は CLI local demo では使えてもよいが、agent interoperability の標準 surface にはしない。
- request publish は hosted control plane を標準にする。
- local-only publish は dev/test mode として提供する。
- production request URL は高 entropy の request access token を含む capability URL とする。
- Agent Card には service secret や webhook secret を含めない。

暗号化 payload の format:

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

サービス側 receiver は JWE を復号した後、plaintext JSON Schema と business rule validation を実行する。

### 9.2 CLI / MCP tool surface

MVP では CLI command を一次 interface とする。ただし、この CLI は人間が直接使うためだけのものではなく、coding agent や service-development agent が安全に呼び出せる tool surface として設計する。

MVP で提供する command:

```bash
watasu init
watasu keygen
watasu request validate request.yaml
watasu request publish request.yaml
watasu request inspect <request_id>
watasu agent-card get <request_id>
watasu schema get <request_id>
watasu submit --request <request_id> --payload payload.json
watasu ledger list --request <request_id>
watasu ledger inspect <submission_id>
watasu webhook verify --secret <secret>
```

`watasu submit` は reference sender と local test 用。production submission は、公開された Agent Card と submission endpoint を読んだユーザー側エージェントから送られる想定。

MCP は、サービス開発側エージェントが watasu を呼び出すための標準 interface として扱う。MVP では CLI を先に実装し、同じ操作を MCP tools として薄く公開できる構造にする。

MCP tool として公開しうる操作:

- `validate_request`
- `publish_request`
- `inspect_request`
- `get_agent_card`
- `get_schema`
- `run_test_submission`
- `list_ledger`
- `inspect_delivery`

MCP tool description は agent が読む入口になるため、prompt injection や tool poisoning を前提に、権限、入力 schema、破壊的操作の有無、payload 非保存の制約を明示する。

### 9.3 MCP Tool Contract

MVP では、MCP tool contract を PRD の実装契約として扱う。CLI command は同じ内部 API を呼ぶ。

必須 MCP tools:

| Tool | Input | Output | Confirmation |
| --- | --- | --- | --- |
| `validate_request` | request definition JSON/YAML | validation result, normalized definition, warnings | 不要 |
| `publish_request` | normalized request definition, destination config, service public key | request_id, request_version, hashes, URLs | 必要 |
| `inspect_request` | request_id, optional version | canonical request definition, status, hashes | 不要 |
| `get_agent_card` | request_id, version | A2A-compatible Agent Card | 不要 |
| `get_schema` | request_id, version | plaintext JSON Schema, envelope schema | 不要 |
| `run_test_submission` | request_id, sample payload, test key config | encrypted submission result, webhook result | 必要 |
| `list_ledger` | request_id, filters | delivery metadata list | 不要 |
| `inspect_delivery` | submission_id | delivery metadata, error category | 不要 |

すべての MCP tool は以下を持つ。

- `name`
- `title`
- `description`
- `inputSchema`
- `outputSchema`
- side effect policy: `read_only`、`dry_run_available`、`requires_confirmation`、`external_delivery_attempt` のいずれか
- payload handling policy: `no_plaintext_payload`、`no_payload_persistence`、`metadata_only`

`outputSchema` は agent が後続 action を自動判断できる粒度にする。text-only response に依存しない。

MCP resources:

- `watasu://requests/{request_id}/versions/{version}`
- `watasu://requests/{request_id}/agent-card`
- `watasu://requests/{request_id}/schemas/plaintext`
- `watasu://requests/{request_id}/schemas/envelope`
- `watasu://deliveries/{submission_id}`

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

`publish_request` と `run_test_submission` は外部状態を変えるため、MCP tool metadata で confirmation required と明示する。エージェントは publish 前に、人間のサービス開発者へ request name、fields、purposes、destination、retention、public key fingerprint を提示する。

MCP prompts:

- `draft_request_from_service_context`: サービス仕様や既存コードから要求定義を作る。
- `review_request_before_publish`: publish 前に fields、purposes、consent、destination、retention、public key fingerprint を確認する。
- `debug_delivery_failure`: ledger metadata と receiver error から修正候補を作る。
- `version_request_after_validation_error`: 復号後 validation failure から新しい request version を作る。

MCP elicitation policy:

- watasu MCP server は、service developer から不足している非機微情報を確認するためにだけ elicitation を使う。
- 例: request name、destination label、retention days、publish confirmation。
- watasu MCP server は、利用ユーザーの個人データや高機微情報を elicitation で要求しない。
- 利用ユーザーの個人データ収集は、MCP ではなく A2A intake request とユーザー側エージェントの consent flow で扱う。

### 9.4 生成物

公開された request ごとに watasu が生成するもの:

- canonical request definition JSON
- plaintext payload 用 JSON Schema
- encrypted submission envelope schema
- A2A-compatible Agent Card
- submission endpoint URL
- request version hash
- consent receipt template
- webhook delivery contract

### 9.5 A2A Agent Card Profile

watasu は intake request ごとに A2A 互換の Agent Card を公開する。

Agent Card は、watasu を特定 skill を持つ intake agent/server として表現する。

例:

- skill id: `encrypted_personal_data_intake`
- input mode: JSON encrypted envelope
- output mode: JSON delivery acknowledgement
- endpoint: request-specific message endpoint
- security requirements: 初期は環境に応じて API token または unsigned test mode

A2A は独自フォーム投稿 API ではなく、agent interoperability surface として扱う。watasu は、狭い intake skill を受け付ける A2A-compatible remote endpoint である。

Agent Card には、A2A v1.0 の AgentExtension として watasu-specific extension を宣言する。トップレベルに独自 `x-*` field を増やさない。

```json
{
  "capabilities": {
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
            "algorithm": "age-v1",
            "service_key_id": "key_123",
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

利用ユーザー側エージェントは、この profile を読めば以下を判断できる必要がある。

- どのデータが要求されているか
- それぞれの field purpose は何か
- どの destination policy に同意するのか
- payload をどの鍵で暗号化するのか
- submission の有効期限と replay protection 条件は何か
- watasu が復号できないこと

公開 Agent Card に入れる情報:

- request_id
- request_version
- schema_hash
- consent_text_hash
- destination_policy_hash
- service public key fingerprint
- encryption algorithm
- max payload size
- submission TTL

公開 Agent Card に入れない情報:

- service webhook secret
- service private key
- internal receiver URL
- raw sender identifier
- user personal data
- plaintext example payload containing real personal data

将来、公開 card では不十分な場合は `capabilities.extendedAgentCard: true` を使い、認証済み client にだけ Extended Agent Card を返す。Extended Agent Card でも secret や private key は返さない。

### 9.6 A2A Submission Operation

利用ユーザー側エージェントは、A2A `Send Message` operation で encrypted submission を送る。

MVP では HTTP+JSON/REST binding を優先する。JSON-RPC binding も将来対応できるよう、内部 model は A2A operation と data model に寄せる。

Submission message の規則:

- `messageId` は `submission_id` または idempotency key と対応させる。
- `metadata` に `request_id`、`request_version`、`schema_hash` を入れる。
- `parts` には `mediaType: "application/json"` の structured data を使う。
- legacy `kind` discriminator は使わない。
- response は delivery acknowledgement または sender-actionable error を structured data で返す。

例:

```json
{
  "message": {
    "messageId": "sub_123",
    "role": "user",
    "metadata": {
      "request_id": "req_123",
      "request_version": "v1",
      "schema_hash": "sha256:..."
    },
    "parts": [
      {
        "mediaType": "application/json",
        "data": {
          "envelope_type": "watasu.encrypted_submission.v1",
          "submission_id": "sub_123",
          "idempotency_key": "idem_123",
          "encrypted_payload": "base64...",
          "encrypted_payload_hash": "sha256:...",
          "consent_receipt_hash": "sha256:...",
          "consent_receipt": {
            "request_id": "req_123",
            "request_version": "v1"
          }
        }
      }
    ]
  },
  "configuration": {
    "acceptedOutputModes": ["application/json"],
    "returnImmediately": false
  }
}
```

Response states:

- accepted: watasu accepted the envelope and attempted delivery.
- delivered: webhook delivery completed.
- rejected: envelope validation failed and sender should not retry unchanged.
- resubmit_later: watasu did not persist payload and sender should resubmit later.
- auth_required: request requires authenticated or extended Agent Card flow.

MVP の A2A security:

- public Agent Card は secret を含まない。
- request-specific Agent Card URL は high entropy URL とする。
- submission endpoint は rate limit、payload size limit、idempotency、replay protection を必須にする。
- production では service 側が `sender_signature_required` を選べる。
- sender signature なしの submission は anonymous/pseudonymous submission として扱う。
- auth.md / OAuth / verified-agent は post-MVP の認可強化として扱う。

### 9.7 Encrypted Submission Envelope

ユーザーエージェントは、encrypted payload と検証可能な metadata を含む envelope を送る。

Envelope fields:

- request_id
- request_version
- schema_hash
- submission_id
- idempotency_key
- encrypted_payload
- encrypted_payload_hash
- encryption_algorithm
- service_key_id
- consent_receipt_hash
- consent_receipt
- submitted_at
- expires_at
- sender_pseudonym
- sender_signature, MVP では optional

watasu が validation するもの:

- request が存在し published であること
- request version が immutable かつ active であること
- schema_hash が request version と一致すること
- encryption algorithm が許可されていること
- service_key_id が request version と一致すること
- encrypted payload size が上限以内であること
- encrypted_payload_hash が encrypted payload と一致すること
- consent_receipt_hash が consent receipt と一致すること
- timestamp が許容 clock skew 内であること
- expires_at を過ぎていないこと
- idempotency_key が未受理であること
- replay submission ではないこと
- destination webhook が配送試行できる状態であること

watasu は payload を復号できないため、plaintext schema validation は行わない。復号後の schema validation はサービス側責務。

### 9.8 Consent Receipt

MVP では canonical consent receipt format を定義する。hash だけでは、後から同意内容を検証できない。

Consent receipt fields:

- request_id
- request_version
- consent_text_hash
- field_ids
- field_purposes_hash
- destination_policy_hash
- user_confirmation_method
- confirmed_at
- agent_disclosure

ユーザー側エージェントは、要求内容をユーザーに提示し、同意を取得する責務を持つ。watasu は、送信された consent receipt が immutable request version に対応していることだけを検証する。

MVP の trust boundary:

- watasu は、ユーザー側エージェントが本当に適切な同意 UI を出したことまでは保証しない。
- watasu は、法的に完全な同意、本人確認、代理権限を保証しない。
- watasu は、request version、consent text、field purposes、destination policy の hash が submission と一致することを検証する。
- sender signature は MVP では optional。将来 auth.md と verified-agent flow に接続する。
- consent receipt は、法的同意の完全証明ではなく、提示内容を後から再現するための証跡である。

### 9.9 Webhook Delivery

watasu は encrypted envelope をサービス側 webhook に配送する。

Webhook requirements:

- HTTPS only
- watasu delivery signature header
- idempotency key
- request_id
- submission_id
- request_version
- delivery timestamp
- encrypted envelope body

watasu は webhook signature verification helper と template receiver を提供する。

MVP の receiver template:

- Node.js webhook receiver
- service-side decrypt and JSON Schema validate example

### 9.10 配送台帳

watasu が保存するのは配送 metadata のみ。

保存する fields:

- request_id
- request_version
- submission_id
- schema_hash
- encrypted_payload_hash
- sender_pseudonym
- consent_receipt_hash
- received_at
- delivered_at
- destination type
- delivery status
- retry instruction status
- error category
- idempotency_key hash

watasu が保存しないもの:

- plaintext payload
- decrypted payload
- delivery attempt 後の encrypted payload body
- raw long-lived agent identifier
- service private key

webhook が 5xx を返した、または timeout した場合、watasu は後続 replay のために encrypted payload を保存しない。失敗試行を台帳に記録し、sender に `resubmit_later` response を返す。

### 9.11 Agent-to-agent happy path

MVP の最重要成功シナリオは、人間が CLI を叩けることではなく、サービス側エージェントと利用ユーザー側エージェントが end-to-end に接続できること。

1. サービス開発者が coding agent に「イベント参加者情報の受け口を作って」と指示する。
2. サービス開発側エージェントが既存コード、サービス仕様、webhook receiver、保持方針を読み取る。
3. サービス開発側エージェントが MCP `validate_request` を呼び、要求定義を生成・検証する。
4. サービス開発側エージェントが publish 前 summary を人間に提示する。
5. 人間が承認する。
6. サービス開発側エージェントが MCP `publish_request` を呼ぶ。
7. watasu が immutable request version、Agent Card、schemas、submission endpoint を公開する。
8. 利用ユーザー側エージェントが A2A Agent Card を発見する。
9. 利用ユーザー側エージェントが要求 fields、purposes、consent text、destination policy をユーザーに提示する。
10. ユーザーが同意する。
11. 利用ユーザー側エージェントが必要データを集め、plaintext JSON Schema で local validation する。
12. 利用ユーザー側エージェントが service public key で payload を暗号化する。
13. 利用ユーザー側エージェントが encrypted submission envelope を watasu に送る。
14. watasu が envelope を検証し、サービス webhook に配送する。
15. サービス側 receiver が watasu signature を検証し、payload を復号し、schema validation する。
16. watasu ledger には delivery metadata だけが残る。

### 9.12 Service-side agent feedback loop

復号後 validation や business rule validation はサービス側責務。失敗した場合、サービス側エージェントが修正 loop を回せる必要がある。

想定 flow:

1. webhook receiver が復号後 validation に失敗する。
2. receiver は service-side validation error を内部ログまたは service agent 向け channel に記録する。
3. サービス側エージェントが error を読み、要求定義、JSON Schema、field purpose、business rule のどこがズレているかを判断する。
4. 既存 request version は変更せず、新しい request version を作る。
5. サービス側エージェントが MCP `validate_request` と `publish_request` を再実行する。
6. 新しい Agent Card / schema が公開される。

watasu は過去 version を immutable に保ち、どの submission がどの version に紐づいたかを ledger で追跡できるようにする。

### 9.13 ローカル開発フロー

MVP は 1 terminal で demo できる必要がある。

例:

```bash
watasu keygen --out .watasu/service-key
watasu request validate examples/event.yaml
watasu request publish examples/event.yaml
watasu agent-card get req_123
watasu submit --request req_123 --payload examples/attendee.json
watasu ledger list --request req_123
```

期待状態:

- request が publish されている
- Agent Card と schema が取得できる
- payload は submission 前に暗号化される
- watasu は payload を復号できない
- webhook が encrypted envelope を受け取る
- service-side template が復号し JSON Schema validation できる
- ledger には配送 metadata だけが表示される

### 9.14 Reference Agent Scope

MVP では full AI companion を作らない。ただし、agent-native product として検証するために、最小限の reference agent を 2 種類提供する。

Service-side reference agent:

- MCP tools を discovery する。
- service fixture から request definition を生成する。
- `validate_request` を呼ぶ。
- publish 前 summary を出す。
- `publish_request` を呼ぶ。
- Agent Card URL と schemas を取得する。

User-side reference agent:

- Agent Card URL を読む。
- A2A AgentExtension を解釈する。
- plaintext JSON Schema から必要 fields を抽出する。
- consent presentation summary を生成する。
- sample user data fixture から payload を作る。
- local validation する。
- service public key で JWE encrypt する。
- A2A Send Message operation で submission する。

Reference agent がやらないこと:

- ユーザーの本物の personal vault を持つ。
- Gmail、Calendar、Drive などから実データを集める。
- 法的同意の完全性を保証する。
- 本人確認や代理権限を保証する。
- 汎用 AI companion として振る舞う。

### 9.15 Protocol Drift Guardrails

A2A と MCP は変化が速い前提で、実装とPRDに drift guardrails を入れる。

- A2A spec version と MCP spec version を generated artifacts に含める。
- Agent Card generation は snapshot test で固定する。
- A2A `Part` は current data model に合わせ、legacy `kind` discriminator を使わない。
- A2A AgentExtension は `uri` と `required` と `params` を使う。
- MCP tools は `inputSchema` と `outputSchema` を必須にする。
- MCP tool result は structured content を返し、free text だけにしない。
- MCP elicitation は機微な個人データ収集に使わない。
- CI で公式 schema または vendored schema snapshot に対する contract test を走らせる。
- spec upgrade 時は `protocol-baseline` section と generated fixture を同時に更新する。

## 10. 標準技術の位置づけ

### 10.1 MCP

MCP は、MVP からサービス開発側エージェントが watasu の機能を呼び出すための主要な tool interface として扱う。

MCP の役割:

- サービス開発側エージェントに watasu の tools を公開する
- 要求定義の validation / publish / inspect を agent から実行できるようにする
- schema、Agent Card、delivery ledger を resources として取得できるようにする
- request 作成 workflow を prompts として提供する
- coding agent や IDE agent から watasu を自然に呼び出せるようにする

MVP では CLI を先に実装してよいが、CLI command と MCP tool は同じ内部 API を呼ぶ構造にする。これにより、人間が terminal で試すことも、エージェントが MCP 経由で自律的に実行することもできる。

MCP は強力な tool execution surface になるため、以下を初期から設計に含める。

- tool ごとの入力 schema
- tool ごとの権限境界
- destructive / irreversible operation の明示
- request publish 前の dry-run
- payload 非保存 invariant の明示
- tool metadata を信頼しすぎない client-side safety 前提
- agent がユーザーまたは開発者に確認すべきタイミングの machine-readable 表現

### 10.2 WebMCP

WebMCP は CLI MVP には含めない。

ただし、将来の非エンジニア向け UI では重要になりうる。watasu が browser-based request builder や review page を提供する場合、WebMCP によってその UI を agent-operable にできる。

将来 WebMCP tool として公開しうる操作:

- create request
- inspect fields
- update consent text
- configure destination
- publish request
- run test submission

WebMCP は core intake protocol ではなく、visible UI に対する progressive enhancement として扱う。将来、UI が dynamic software interface としてエージェントから直接操作される形になるなら、WebMCP の重要度は上がる。ただし MVP は browser context に依存しない。

### 10.3 auth.md

auth.md は watasu と競合するものではなく、将来利用する方向で設計する。

将来の利用可能性:

- service developer account への agentic login
- service user の代理として agent を登録する
- trusted agent に scoped access token を発行する
- watasu request access を OAuth-style authorization に接続する
- verified-agent flow または user-claimed flow を支える

MVP では login も auth.md integration も実装しない。ただし、将来 auth.md を採用できなくなる設計にはしない。

### 10.4 A2A

A2A は agent-to-agent discovery と submission の主要な互換対象。

MVP では、利用ユーザー側エージェントが watasu の intake endpoint を発見し、要求内容を理解し、encrypted submission を送るために A2A concepts を使う。

- Agent Card
- skill description
- message endpoint
- input / output modes
- security scheme metadata

watasu 固有 extension が必要な場合を除き、A2A と互換しない独自 metadata は増やさない。

役割分担としては、MCP は「サービス開発側エージェントが watasu を操作するため」、A2A は「利用ユーザー側エージェントが watasu の受け口を発見し送信するため」に使う。

## 11. Security Invariants

production mode では以下を常に満たす。

- watasu は service private key を持たない。
- watasu は JWE payload を復号できない。
- watasu は plaintext payload を保存しない。
- watasu は plaintext payload を log に出さない。
- watasu は delivery attempt 後に encrypted payload body を保持しない。
- published request version は immutable。
- すべての submission は request version に bind される。
- すべての submission に replay protection がある。
- すべての webhook delivery は watasu によって署名される。
- service webhook receiver は watasu signature を検証できる。
- metadata retention が明示されている。
- ledger metadata への内部アクセスは audit log 対象。
- public Agent Card に secret、private URL、private key、raw user data を含めない。
- request-specific capability URL は high entropy で、revocation 可能にする。
- MCP elicitation で利用ユーザーの個人データや高機微情報を要求しない。
- MCP publish tool は dry-run と human confirmation を持つ。
- A2A structured submission は current v1.0 data model に従い、legacy field に依存しない。

## 12. 成功指標

### Activation

- install から初回 request publish までの時間。
- request file から successful webhook delivery までの時間。
- key generation 完了率。
- test submission 完了率。
- service-side agent が MCP 経由で request publish できる率。
- publish 前 summary を人間が確認できる率。

目標:

- local encrypted delivery を 15 分以内に完了できる。
- hosted request publish を 30 分以内に完了できる。

### Usage

- published request count
- successful encrypted submissions
- successful webhook deliveries
- delivery failure rate
- resubmission success rate
- A2A Agent Card discovery success rate
- user-side agent submission success rate

目標:

- webhook が利用可能な場合の successful delivery 99%。
- delivery attempt latency p95 が 5 秒未満。

### Trust

- payload persistence incidents: 0
- unredacted payload logs: 0
- watasu-held private keys: 0
- plaintext payload stored in DB: 0
- production encrypted delivery adoption: 100%

### Agent Experience

- agent-generated request validity rate
- MCP tool call success rate
- user-agent schema comprehension success rate
- consent presentation correctness
- end-to-end agent submission success rate

目標:

- service-side agent が生成した request definition の初回 validation 成功率 80% 以上。
- 利用ユーザー側エージェントが Agent Card から required fields と consent summary を正しく抽出できる率 95% 以上。
- agent-to-agent happy path の end-to-end 成功率 90% 以上。

## 13. Acceptance Tests

MVP は以下の test が通るまで完了扱いにしない。

- MCP `validate_request` が request definition を validate できる。
- MCP `publish_request` が confirmation required として公開される。
- MCP `publish_request` によって immutable request version が作られる。
- MCP resource から request、Agent Card、schemas、delivery metadata を取得できる。
- CLI から request definition を validate できる。
- request publish によって immutable request version が作られる。
- published request の Agent Card を取得できる。
- published request の JSON Schema を取得できる。
- A2A Agent Card に `https://watasu.dev/extensions/encrypted-intake/v1` AgentExtension が含まれる。
- 利用ユーザー側 reference agent が Agent Card から fields、purposes、consent text、destination policy を抽出できる。
- 利用ユーザー側 reference agent が consent presentation summary を生成できる。
- user-side reference agent は submission 前に payload を JWE 暗号化する。
- A2A submission は `Part.data` と `mediaType: "application/json"` を使い、legacy `kind` discriminator を使わない。
- MCP tool result は `outputSchema` に合う structured content を返す。
- MCP elicitation は利用ユーザーの個人データ収集に使われない。
- watasu は不正な `schema_hash` を拒否する。
- watasu は未知の `service_key_id` を拒否する。
- watasu は expired submission を拒否する。
- watasu は replayed `idempotency_key` を拒否する。
- watasu は encrypted envelope を webhook に配送する。
- webhook receiver は watasu delivery signature を検証できる。
- service-side template は payload を復号し validation できる。
- ledger には metadata だけが保存される。
- DB に plaintext payload が保存されない。
- log に plaintext payload が出ない。
- webhook 5xx 時に watasu は retry 用 payload を保存しない。
- delivery failure は sender が処理できる `resubmit_later` response を返す。
- 復号後 validation failure は既存 request version を変更せず、新しい request version で修正できる。

## 14. MVP 実装順序

1. request definition schema を定義する。
2. canonical request version と hash を定義する。
3. MCP tool contract と resource URI を定義する。
4. service key generation と key id handling を実装する。
5. encrypted envelope schema を定義する。
6. CLI validation を実装する。
7. MCP `validate_request` を実装する。
8. request publish を実装する。
9. MCP `publish_request` を実装する。
10. JSON Schema と Agent Card の生成を実装する。
11. A2A encrypted-intake AgentExtension profile を実装する。
12. reference submit command を実装する。
13. 利用ユーザー側 reference agent の Agent Card 読み取りを実装する。
14. webhook delivery を実装する。
15. webhook signature verification helper を実装する。
16. delivery ledger metadata を実装する。
17. no-payload-persistence と log-redaction tests を追加する。
18. service-side decrypt and validate template を追加する。
19. service-side agent feedback loop の sample を追加する。

## 15. Open Questions

- 最小の A2A interoperability test suite はどこまで必要か。
- sender signature は optional、production required、auth.md integration まで deferred のどれにするか。
- service public key ownership をどう検証するか。
- destination webhook domain ownership を publish 前に検証するか。
- 対象 jurisdiction でどの metadata が個人データまたは個人関連情報に該当するか。
- ledger metadata の default retention は何日が妥当か。
- MCP server を watasu CLI に同梱するか、別 package として配布するか。
- JWE key rotation と request version rotation を同時に行うか、別 lifecycle にするか。
- capability URL が漏れた場合の revocation UX をどうするか。
