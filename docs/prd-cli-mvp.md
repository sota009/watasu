# watasu PRD: Agent-native CLI-first encrypted personal data intake

## 1. 概要

watasu は、サービス側エージェントが個人データの要求定義と受け口を作り、利用ユーザー側エージェントがその要求に応じてデータを提供できるようにする、agent-native な個人データ intake ツールキット。

サービス開発者本人が手でフォーム項目をポチポチ入力するのではなく、サービス開発を支援しているエージェントが watasu の CLI または MCP tool surface を使って「このサービスはどの個人データを、何の目的で、どこに受け取りたいか」を定義する。watasu はその定義から、A2A 互換の Agent Card、JSON Schema、暗号化 envelope 仕様、配送設定を生成する。

利用ユーザー側の AI コンパニオンまたはデータエージェントは、その要求定義を読み、ユーザーに同意確認し、必要なデータを集め、サービス側公開鍵で payload を暗号化して watasu に送信する。

watasu は暗号化された envelope をサービス側 webhook に配送する。watasu は個人データを復号しない。payload 本文も保存しない。保存するのは配送台帳と最小限の接続メタデータだけ。

MVP では、人間用回答フォーム、回答一覧 DB、ユーザー vault、ログイン機能、非エンジニア向け dashboard は作らない。最初の価値検証に必要な作成、公開、送信、検証、配送確認はすべて CLI で完結させる。ただし主な利用者は人間ではなく、サービス開発側エージェントと利用ユーザー側エージェントである。

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
- ユーザー側エージェントが普及する前でも試せる reference sender を提供する。
- A2A、MCP、将来の WebMCP、auth.md に接続できる小さな protocol surface を定義する。

## 5. MVP の非目的

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

## 6. 対象ユーザー

### 6.1 サービス開発側エージェント

MVP の主対象。サービス開発者の代理または支援者として動き、個人データの要求定義、受け口作成、schema 生成、webhook 設定、テスト送信を実行するエージェント。

90% のユースケースでは、人間の開発者が watasu CLI を直接叩くのではなく、開発環境や coding agent が watasu を tool として呼び出す想定。

利用する interface:

- CLI command
- MCP tools
- YAML または JSON の要求定義
- webhook endpoint
- public/private key
- local validation script

### 6.2 サービス開発者

サービス側エージェントに初期指示を出す人間。たとえば「イベント参加者から氏名、メール、アレルギー情報を集める受け口を作って」と自然言語や音声で指示する。細かい項目入力や画面操作を人間が担う前提にはしない。

必要に応じて、生成された要求定義、同意文、配送先、保持方針を review する。

### 6.3 利用ユーザー側エージェント

ユーザー本人の代理として動く AI コンパニオンまたはデータエージェント。サービス側が公開した Agent Card と要求定義を読み、ユーザーに提示し、同意を取り、必要なデータを集め、ローカルで validation し、payload を暗号化して送信する。

### 6.4 利用ユーザー

個人データを提供する本人。watasu の回答フォームに入力するのではなく、自分の AI コンパニオンを通じて、何をどの目的で渡すかを確認し、同意する。

### 6.5 Reference Sender

watasu が提供する最小限の CLI sender。デモ、テスト、初期 integration 用。一般消費者向け companion product ではない。

## 7. MVP スコープ

### 7.1 Agent-native 要求定義

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

### 7.2 CLI / MCP tool surface

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

### 7.3 生成物

公開された request ごとに watasu が生成するもの:

- canonical request definition JSON
- plaintext payload 用 JSON Schema
- encrypted submission envelope schema
- A2A-compatible Agent Card
- submission endpoint URL
- request version hash
- consent receipt template
- webhook delivery contract

### 7.4 Agent Discovery

watasu は intake request ごとに A2A 互換の Agent Card を公開する。

Agent Card は、watasu を特定 skill を持つ intake agent/server として表現する。

例:

- skill id: `encrypted_personal_data_intake`
- input mode: JSON encrypted envelope
- output mode: JSON delivery acknowledgement
- endpoint: request-specific message endpoint
- security requirements: 初期は環境に応じて API token または unsigned test mode

A2A は独自フォーム投稿 API ではなく、agent interoperability surface として扱う。watasu は、狭い intake skill を受け付ける A2A-compatible remote endpoint である。

### 7.5 Encrypted Submission Envelope

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

### 7.6 Consent Receipt

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

### 7.7 Webhook Delivery

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

### 7.8 配送台帳

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

### 7.9 ローカル開発フロー

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

## 8. 将来の位置づけ

### 8.1 MCP

MCP は、サービス開発側エージェントが watasu の機能を呼び出すための主要な tool interface として扱う。

MCP の役割:

- サービス開発側エージェントに watasu の tools を公開する
- 要求定義の validation / publish / inspect を agent から実行できるようにする
- schema、Agent Card、delivery ledger を resources として取得できるようにする
- request 作成 workflow を prompts として提供する
- coding agent や IDE agent から watasu を自然に呼び出せるようにする

MVP では CLI を先に実装するが、CLI command と MCP tool は同じ内部 API を呼ぶ構造にする。これにより、人間が terminal で試すことも、エージェントが MCP 経由で自律的に実行することもできる。

MCP は強力な tool execution surface になるため、以下を初期から設計に含める。

- tool ごとの入力 schema
- tool ごとの権限境界
- destructive / irreversible operation の明示
- request publish 前の dry-run
- payload 非保存 invariant の明示
- tool metadata を信頼しすぎない client-side safety 前提
- agent がユーザーまたは開発者に確認すべきタイミングの machine-readable 表現

### 8.2 WebMCP

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

### 8.3 auth.md

auth.md は watasu と競合するものではなく、将来利用する方向で設計する。

将来の利用可能性:

- service developer account への agentic login
- service user の代理として agent を登録する
- trusted agent に scoped access token を発行する
- watasu request access を OAuth-style authorization に接続する
- verified-agent flow または user-claimed flow を支える

MVP では login も auth.md integration も実装しない。ただし、将来 auth.md を採用できなくなる設計にはしない。

### 8.4 A2A

A2A は agent-to-agent discovery と submission の主要な互換対象。

MVP では、利用ユーザー側エージェントが watasu の intake endpoint を発見し、要求内容を理解し、encrypted submission を送るために A2A concepts を使う。

- Agent Card
- skill description
- message endpoint
- input / output modes
- security scheme metadata

watasu 固有 extension が必要な場合を除き、A2A と互換しない独自 metadata は増やさない。

役割分担としては、MCP は「サービス開発側エージェントが watasu を操作するため」、A2A は「利用ユーザー側エージェントが watasu の受け口を発見し送信するため」に使う。

## 9. Security Invariants

production mode では以下を常に満たす。

- watasu は service private key を持たない。
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

## 10. 成功指標

### Activation

- install から初回 request publish までの時間。
- request file から successful webhook delivery までの時間。
- key generation 完了率。
- test submission 完了率。

目標:

- local encrypted delivery を 15 分以内に完了できる。
- hosted request publish を 30 分以内に完了できる。

### Usage

- published request count
- successful encrypted submissions
- successful webhook deliveries
- delivery failure rate
- resubmission success rate

目標:

- webhook が利用可能な場合の successful delivery 99%。
- delivery attempt latency p95 が 5 秒未満。

### Trust

- payload persistence incidents: 0
- unredacted payload logs: 0
- watasu-held private keys: 0
- plaintext payload stored in DB: 0
- production encrypted delivery adoption: 100%

## 11. Acceptance Tests

MVP は以下の test が通るまで完了扱いにしない。

- CLI から request definition を validate できる。
- request publish によって immutable request version が作られる。
- published request の Agent Card を取得できる。
- published request の JSON Schema を取得できる。
- reference sender は submission 前に payload を暗号化する。
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

## 12. MVP 実装順序

1. request definition schema を定義する。
2. canonical request version と hash を定義する。
3. service key generation と key id handling を実装する。
4. encrypted envelope schema を定義する。
5. CLI validation を実装する。
6. request publish を実装する。
7. JSON Schema と Agent Card の生成を実装する。
8. reference submit command を実装する。
9. webhook delivery を実装する。
10. webhook signature verification helper を実装する。
11. delivery ledger metadata を実装する。
12. no-payload-persistence と log-redaction tests を追加する。
13. service-side decrypt and validate template を追加する。

## 13. Open Questions

- default encryption primitive は age、JWE、HPKE、libsodium sealed boxes のどれにするか。
- request publish は最初 local-file based、hosted API based、または両方のどれにするか。
- 最小の A2A compatibility profile はどこまでか。
- sender signature は optional、production required、auth.md integration まで deferred のどれにするか。
- service public key ownership をどう検証するか。
- destination webhook domain ownership を publish 前に検証するか。
- 対象 jurisdiction でどの metadata が個人データまたは個人関連情報に該当するか。
- ledger metadata の default retention は何日が妥当か。
- reference sender は interactive consent prompt を持つべきか、scripted test submission だけにするか。
