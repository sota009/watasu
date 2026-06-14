# watasu MVP use-case validation

## 1. Verdict

2026-06-14 時点の PRD / ERD 更新後、watasu CLI / MCP MVP は以下の条件つきで幅広いユースケースに通用する。

- Low-risk public intake は `public_capability` で対応できる。
- Production hosted request は `verified_sender` を default にすることで、中〜高リスク intake に対応できる。
- 高機微、限定配布、B2B onboarding は `private_invite` を選ぶことでリンク漏洩と未検証 sender のリスクを下げられる。
- watasu は legal consent、identity proof、delegated authority、DSAR workflow を保証しない。この範囲は service-side receiver または別プロダクトの責務として残す。

## 2. Threat model summary

守るもの:

- plaintext payload
- encrypted payload body after delivery attempt
- service private key
- webhook signing secret
- capability URL token
- ledger and consent receipt metadata

主な攻撃者:

- leaked capability URL を持つ第三者
- 悪意ある sender
- webhook DoS を狙う bot
- 偽 webhook destination を publish しようとする service-side actor
- ledger metadata を不正閲覧しようとする内部または侵害済み actor
- prompt injection を含む外部仕様、Issue、Agent Card、コードコメント

主な防御:

- payload 非保持
- sender signature
- service public key ownership verification
- destination webhook domain ownership verification
- high entropy capability URL with revoke / rotate
- pre-delivery rate limit
- timestamp, digest, signature, idempotency checks
- tenant-scoped ledger access and audit logs

## 3. Use-case matrix

| Use case | Recommended profile | Pass? | Reason | Remaining risk |
| --- | --- | --- | --- | --- |
| イベント受付 | `public_capability` or `verified_sender` | Pass | 低〜中リスク field なら capability URL、TTL、rate limit、idempotency で十分。アレルギーなど高機微 field がある場合は `verified_sender` に上げる。 | public URL の転送による想定外 submission。 |
| Waitlist / 資料請求 | `public_capability` | Pass | 低リスクかつ公開配布の性質に合う。high sensitivity field は publish 拒否される。 | bot submission は rate limit と ledger pollution 対策が必要。 |
| 採用 intake | `verified_sender` | Pass | 履歴書、職歴、住所などは sender signature と domain/key ownership が必要。watasu は payload を保存しない。 | 本人確認や代理権限は保証しない。 |
| 業務委託 / B2B onboarding | `verified_sender` or `private_invite` | Pass | 招待制や限定取引先には invite-bound capability URL が合う。 | 招待の本人性は外部 IdP または service 側で扱う。 |
| アレルギー / 健康情報 | `verified_sender` or `private_invite` | Conditional pass | payload custody を避け、署名必須にすれば配送レイヤーとしては成立する。 | legal consent、医療規制、本人確認は watasu MVP の範囲外。 |
| 金融 / 税務情報 | `private_invite` | Conditional pass | 未検証 sender を拒否し、ledger retention を短くすれば intake transport としては使える。 | 規制対応、KYC、監査要件は service 側に残る。 |
| QR / email handoff | `private_invite` | Pass | capability URL rotate / revoke が request version と分離されているため漏洩対応できる。 | ユーザーが古い QR / email を使う場合の案内 UX は今後設計。 |
| Local agent-to-agent demo | `local_demo` | Pass | localhost と fixture 限定にしたので実データ混入を避けられる。 | demo mode の hosted publish 拒否テストが必須。 |
| Webhook outage | any production profile | Pass | payload を保存せず `resubmit_later` を返し、同じ payload retry の idempotency contract を定義済み。 | sender が retry contract を実装しない場合は delivery failure が残る。 |
| Capability URL leak | any hosted profile | Pass | revoke / rotate、token hash storage、ledger `capability_id_hash` で影響範囲を追える。 | 漏洩検知と通知 channel は今後の UX 課題。 |
| Public endpoint abuse / DoS | any hosted profile | Pass | platform / request / sender buckets を webhook delivery 前に適用する。 | 大規模 bot 対策は追加の edge protection が必要になる可能性。 |
| Hosted multi-tenant ledger | hosted profiles | Pass | `tenant_id`、role check、audit log を要求化した。 | 具体的な IdP / token issuer は未選定。 |

## 4. Go / no-go

Implementation can start if these gates stay in scope:

- `trust_profile` validation is implemented before hosted publish.
- `verified_sender` is the production hosted default.
- high sensitivity fields cannot use `public_capability`.
- key ownership and webhook domain ownership checks block production publish.
- payload, encrypted payload body after delivery attempt, and full capability URLs are absent from DB and logs.
- contract tests cover `auth_required`, `rejected`, `delivered`, and `resubmit_later`.

Do not treat the MVP as ready for regulated production use until legal consent, identity proof, jurisdiction-specific retention, and DSAR ownership are handled outside watasu or in a later watasu version.
