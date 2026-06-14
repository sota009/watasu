# watasu MVP use-case journey analysis

## 1. Purpose

このレポートは、watasu CLI / MCP MVP が想定ユースケースのユーザージャーニーをどこまで解決できるかを検証する。

対象は `docs/prd-cli-mvp.md` と `docs/erd-cli-mvp.md` に定義された MVP である。watasu は「個人データ本文を持たない、見ない、保存しない」暗号化 intake transport であり、本人確認、法的同意、代理権限、DSAR、ユーザー側エージェント本体、一般ユーザー向けフォーム、回答一覧UIは提供しない。

## 2. Evaluation rubric

| 判定 | 意味 |
| --- | --- |
| Solved | MVP の責務だけで主要ジャーニーが成立する。追加システムはあっても一般的な receiver 実装や運用で足りる。 |
| Conditional | 暗号化配送、検証、ledger までは成立する。ただし本人確認、法的同意、規制対応、匿名性、可用性、外部UXなど、watasu 外の要件が成功条件になる。 |
| Not solved | ユースケースの中心価値が MVP の非目的と衝突する。watasu を使うなら別プロダクト、別レイヤー、将来版が必要。 |

## 3. Common journey model

ほぼすべての対応ユースケースは、この共通フローに乗る。

```text
Service developer
  -> service-side agent
  -> watasu MCP / CLI
  -> published request version
  -> Agent Card / schema / endpoint
  -> user-side agent
  -> user consent
  -> encrypted submission
  -> watasu validation
  -> service webhook receiver
  -> service-side decrypt / validate / act
```

### 3.1 Service-side setup journey

1. サービス開発者が「このサービスで受け取りたい個人データ」を自然言語や既存仕様で説明する。
2. サービス側エージェントが service context を読み、request definition を作る。
3. request definition には fields、purposes、sensitivity、consent text、destination webhook、retention、service public key、trust profile を含める。
4. エージェントが `validate_request` を呼び、watasu が構文、sensitivity、trust profile、暗号化方針を検証する。
5. production hosted request では service public key ownership と destination webhook domain ownership を検証する。
6. publish 前 summary で、人間が request name、fields、purposes、destination、retention、public key fingerprint、trust profile を確認する。
7. 人間が承認したら `publish_request` を呼び、request version、Agent Card、schema、submission endpoint、capability URL を発行する。
8. 以後、公開済み request version は immutable になる。fields、consent、destination policy、key、retention の変更は新 version で行う。

### 3.2 User-side submission journey

1. ユーザー側エージェントが Agent Card URL を受け取る。
2. Agent Card と schema を読み、request_id、request_version、schema_hash、consent_text_hash、field purposes、destination policy、encryption policy、trust profile を抽出する。
3. ユーザー側エージェントがユーザーへ「何を、なぜ、どこへ、どの保持方針で渡すか」を提示する。
4. ユーザーが同意、拒否、または一部データ不足を判断する。
5. 同意した場合、ユーザー側エージェントがローカルで payload を構築し、service public key で暗号化する。
6. envelope に idempotency key、submitted_at、expires_at、encrypted_payload_hash、consent_receipt、sender_auth、sender_signature を入れる。
7. `verified_sender` / `private_invite` では registered sender key で署名する。
8. watasu へ A2A submission を送る。
9. watasu は request version、schema hash、key id、payload size、hash、consent receipt hash、TTL、replay、rate limit、capability URL、sender key scope を検証する。
10. 検証に失敗したら webhook delivery 前に `rejected` または `auth_required` を返す。
11. 検証に成功したら encrypted envelope を service webhook に配送する。
12. webhook 5xx / timeout の場合、watasu は encrypted payload を保存せず `resubmit_later` を返す。
13. service receiver は watasu signature、timestamp、body digest、idempotency key を検証し、payload を復号して service-side schema validation を行う。

### 3.3 Ledger and inspection journey

1. サービス側エージェントまたは開発者が CLI / MCP で ledger を確認する。
2. watasu は tenant / role check を行う。
3. `list_ledger` は delivery status、error category、request version、schema hash、consent receipt hash など metadata だけを返す。
4. `inspect_delivery` は plaintext payload、decrypted payload、encrypted payload body を返さない。
5. metadata read は access audit log に残る。
6. retention job が request retention policy に従い、ledger metadata、consent receipt metadata、rate limit events、raw network abuse logs を削除または anonymize する。

## 4. Use-case catalog

| ID | Use case | Primary actor | Data sensitivity | Recommended trust profile | Verdict |
| --- | --- | --- | --- | --- | --- |
| UC-01 | イベント受付 | event organizer | low to moderate | `public_capability` / `verified_sender` | Solved |
| UC-02 | waitlist / 資料請求 | growth / sales | low | `public_capability` | Solved |
| UC-03 | 問い合わせ前 intake | support / sales | low to moderate | `public_capability` / `verified_sender` | Solved |
| UC-04 | 採用応募 | recruiting team | moderate to high | `verified_sender` | Solved |
| UC-05 | 業務委託 onboarding | ops / legal | moderate to high | `verified_sender` / `private_invite` | Solved |
| UC-06 | B2B vendor registration | procurement / ops | moderate | `private_invite` | Solved |
| UC-07 | アレルギー / 健康情報 intake | event / healthcare-adjacent service | high | `verified_sender` / `private_invite` | Conditional |
| UC-08 | 医療問診 | clinic / healthcare service | high / regulated | `private_invite` | Conditional |
| UC-09 | 金融 / 税務 intake | fintech / accounting service | high / regulated | `private_invite` | Conditional |
| UC-10 | KYC / 政府ID提出 | regulated service | high / regulated | `private_invite` | Conditional |
| UC-11 | 未成年情報 / 保護者同意 | education / family service | high | `private_invite` | Conditional |
| UC-12 | QR / email handoff | field ops / event ops | low to high | `private_invite` | Solved with ops caveat |
| UC-13 | 大規模 public campaign | marketing / public sector | low to moderate | `public_capability` | Conditional |
| UC-14 | webhook outage and retry | any service | any | any production profile | Solved with sender dependency |
| UC-15 | capability URL leak | any service | any | any hosted profile | Solved with detection caveat |
| UC-16 | malicious sender / forged submission | attacker | any | `verified_sender` / `private_invite` | Solved for signed profiles |
| UC-17 | cross-tenant ledger access | malicious tenant / compromised token | metadata | hosted profiles | Solved if access tests pass |
| UC-18 | anonymous whistleblowing | whistleblower | high / safety-sensitive | none in MVP | Not solved |
| UC-19 | DV shelter / political / religious sensitive disclosure | vulnerable user | high / safety-sensitive | none in MVP | Not solved |
| UC-20 | emergency triage / disaster response | emergency service | high / life safety | none in MVP | Not solved |
| UC-21 | human web form replacement | non-agent user | varies | none in MVP | Not solved |
| UC-22 | response table / CSV export | internal operator | plaintext payload | none in MVP | Not solved |
| UC-23 | personal data vault | end user | high | none in MVP | Not solved |
| UC-24 | DSAR / legal consent system | compliance / legal | metadata + payload lifecycle | none in MVP | Not solved |

## 5. Detailed journeys

### UC-01: イベント受付

Definition:
イベント主催者が、参加者の氏名、メール、所属、任意の食事制限などを受け取りたい。

Recommended profile:
`public_capability` for low-risk fields. `verified_sender` if allergies or health-related fields are included.

Journey:

1. 主催者が「ExampleConf 参加者情報を受け取りたい」とサービス側エージェントへ依頼する。
2. エージェントが fields を作る: `full_name`, `email`, `company`, optional `meal_preference`。
3. allergies を含める場合、field sensitivity が high になる。
4. `public_capability` で high sensitivity がある場合、publish は拒否される。
5. 主催者は high sensitivity を外すか、`verified_sender` に上げる。
6. publish 前 summary で目的、保持期間、配送先、公開鍵 fingerprint を確認する。
7. Agent Card URL をイベント案内やQRに載せる。
8. 参加者のユーザー側エージェントが request を読み、参加者に提示する。
9. 参加者が同意し、payload が暗号化される。
10. watasu が hash、TTL、idempotency、rate limit、capability status を検証する。
11. service webhook が受け取り、参加者管理システムへ取り込む。

Verdict:
Solved. 低リスク受付は MVP にかなり合う。

Remaining gaps:
アレルギーを含む場合は health-adjacent になる。ユーザー側agentが同意UIを適切に見せた保証は watasu 外。

### UC-02: waitlist / 資料請求

Definition:
公開ページやSNSから、名前、メール、会社名、関心カテゴリを集める。

Recommended profile:
`public_capability`.

Journey:

1. growth担当が「waitlist登録用のintakeを作って」と依頼する。
2. service-side agent が low sensitivity fields だけで request definition を作る。
3. `validate_request` が high sensitivity field 不在、payload size、retention を確認する。
4. `publish_request` 後、Agent Card URL をLP、SNS、メールに掲載する。
5. user-side agent が request を読み、ユーザーに「メール連絡と製品案内のため」と表示する。
6. ユーザーが同意し、暗号化 submission を送る。
7. watasu が rate limit と idempotency でbot重複を抑える。
8. receiver がCRMへ取り込む。

Verdict:
Solved.

Remaining gaps:
大規模bot、使い捨てメール、マーケティング同意の地域差は service 側で扱う。

### UC-03: 問い合わせ前 intake

Definition:
サポートや営業問い合わせの前に、問い合わせ内容、環境、連絡先、希望日時などを集める。

Recommended profile:
`public_capability` for generic inquiry. `verified_sender` if account-specific or confidential details are requested.

Journey:

1. サービス側が問い合わせ前に必要な情報を定義する。
2. request includes issue category, contact email, product area, optional account id.
3. account id や契約情報を含める場合、moderate以上の sensitivity にする。
4. user-side agent がユーザーへ提出先と利用目的を提示する。
5. ユーザーが必要情報を確認し、暗号化送信する。
6. watasu は plaintext を見ずに webhook delivery する。
7. receiver がticket systemへ登録する。

Verdict:
Solved for general intake. Conditional for account-specific data.

Remaining gaps:
本人の契約情報かどうかの確認、アカウント所有者確認は watasu 外。

### UC-04: 採用応募

Definition:
候補者が履歴書、職歴、ポートフォリオ、連絡先、希望条件を提出する。

Recommended profile:
`verified_sender`.

Journey:

1. 採用担当が応募者 intake を作る。
2. service-side agent が resume fields、work history、contact、portfolio URL、consent text を作る。
3. trust profile は `verified_sender` が必須になる。
4. 採用サービスまたは応募者側agentの sender key を登録する。
5. publish 前 summary で履歴書、職歴、保持期間、削除方針、配送先を確認する。
6. 候補者のuser-side agentがAgent Cardを読み、提出内容と保持方針を候補者へ表示する。
7. 候補者が同意し、payloadを暗号化する。
8. sender keyで署名する。
9. watasuが registered sender key、signature、request version scope を検証する。
10. receiverが復号し、ATSへ取り込む。

Verdict:
Solved as encrypted transport.

Remaining gaps:
応募者本人性、学歴・職歴の真正性、採用法務、差別的項目の除外は service 側。

### UC-05: 業務委託 onboarding

Definition:
業務委託者から、氏名、住所、契約情報、請求先、税務関連情報を受け取る。

Recommended profile:
`verified_sender` or `private_invite`.

Journey:

1. ops担当が招待制 onboarding request を作る。
2. service-side agent が住所、請求先、税務情報など high sensitivity fields を定義する。
3. trust profile を `private_invite` にする。
4. service が委託者の sender key を登録する。
5. watasu が invite-bound capability URL を発行し、sender key と binding する。
6. 委託者のuser-side agentが招待リンクを読み、提出先・目的・保持を表示する。
7. 委託者が同意し、payloadを暗号化して署名する。
8. watasuが capability URL と sender key binding の両方を検証する。
9. receiverが復号し、契約・経理システムへ取り込む。

Verdict:
Solved for transport and intake gating.

Remaining gaps:
税法、本人確認、反社チェック、契約署名は watasu 外。

### UC-06: B2B vendor registration

Definition:
取引先企業から担当者、会社情報、請求情報、セキュリティ窓口などを受け取る。

Recommended profile:
`private_invite`.

Journey:

1. procurement担当が取引先ごとの invite request を作る。
2. request version に destination policy と retention を固定する。
3. 取引先の sender key を登録し、private invite を発行する。
4. 取引先agentがAgent Cardを読み、社内担当者へ確認する。
5. 担当者が会社情報の提出を承認する。
6. agent が payload を暗号化し、登録済みsender keyで署名する。
7. watasu が invite binding、signature、replay、rate limit を検証する。
8. receiver がvendor masterへ登録する。

Verdict:
Solved.

Remaining gaps:
会社代表権限、取引先審査、制裁リストチェックは service 側。

### UC-07: アレルギー / 健康情報 intake

Definition:
イベントや旅行などで、食事提供・安全確認のためにアレルギーや健康上の注意を受け取る。

Recommended profile:
`verified_sender` or `private_invite`.

Journey:

1. 主催者が allergies / medical notes を含む request を作る。
2. `sensitivity: high` に分類される。
3. `public_capability` では publish が拒否される。
4. 主催者は `verified_sender` または `private_invite` を選ぶ。
5. user-side agent が「食事提供時の安全確認」など field purpose を表示する。
6. ユーザーが同意し、必要項目だけを送る。
7. watasu が sender signature と request version binding を検証する。
8. receiver が復号し、必要なスタッフだけが見られるシステムへ取り込む。

Verdict:
Conditional.

What watasu solves:
暗号化配送、payload非保持、同意対象hash、sender制限。

What remains outside:
医療情報としての法的扱い、閲覧権限、緊急時利用、削除依頼、スタッフ教育。

### UC-08: 医療問診

Definition:
クリニックや医療サービスが症状、服薬、既往歴、保険情報などを受け取る。

Recommended profile:
`private_invite`.

Journey:

1. 医療サービスが患者ごとの問診requestを作る。
2. service public key と webhook domain ownership を検証する。
3. patient-side agent または医療ポータルagent の sender key を登録する。
4. private invite を患者に渡す。
5. user-side agent が問診項目、利用目的、提出先、保持方針を提示する。
6. 患者が同意し、payloadを暗号化して送る。
7. watasu は sender key と invite binding を検証する。
8. receiver が復号し、医療システム側で診療前 validation を行う。

Verdict:
Conditional.

What watasu solves:
患者データ本文をwatasuが持たない transport、delivery metadata、改ざん検証。

Why not fully solved:
医療同意、医療記録管理、本人確認、保険資格、緊急時アクセス、法域ごとの保持義務はMVP外。

### UC-09: 金融 / 税務 intake

Definition:
収入情報、銀行口座、税務番号、請求先住所などを受け取る。

Recommended profile:
`private_invite`.

Journey:

1. service-side agent が金融・税務fieldを high sensitivity として定義する。
2. service が sender key allowlist を作る。
3. private invite を特定ユーザーまたは取引先に発行する。
4. user-side agent が提出目的、保持、受領サービスを表示する。
5. ユーザーが同意し、payloadを暗号化する。
6. watasuが registered sender key、signature、invite binding、TTL、replayを検証する。
7. receiverが復号し、金融/税務システムで追加検証する。

Verdict:
Conditional.

What watasu solves:
未検証senderの拒否、payload非保持、delivery signature、ledger metadata。

What remains outside:
KYC、AML、税法、監査証跡、法定保存、本人確認、金融ライセンス要件。

### UC-10: KYC / 政府ID提出

Definition:
本人確認のためにパスポート、運転免許、マイナンバー相当、住所証明などを受け取る。

Recommended profile:
`private_invite`.

Journey:

1. regulated service が本人確認requestを作る。
2. fields は government_id_type、document image reference、address proof など high sensitivity。
3. request は `private_invite` のみで publish する。
4. sender key と invite-bound capability をユーザーごとに発行する。
5. user-side agent が提出先と利用目的を表示する。
6. ユーザーが同意し、payloadを暗号化する。
7. watasuはtransport検証だけを行う。
8. receiverは復号後にKYC vendorまたは本人確認フローへ渡す。

Verdict:
Conditional.

What watasu solves:
安全な提出経路、capability leak時のrevoke/rotate、metadata-only ledger。

What remains outside:
本人確認精度、偽造検出、規制監査、法定保存、削除制限、年齢確認。

### UC-11: 未成年情報 / 保護者同意

Definition:
教育、イベント、家族向けサービスが未成年の氏名、年齢、保護者連絡先、緊急連絡先を受け取る。

Recommended profile:
`private_invite`.

Journey:

1. service-side agent が minor-related fields を high sensitivity として定義する。
2. request には保護者確認が必要であることを consent text に明記する。
3. watasu は request と consent hash を固定する。
4. user-side agent が保護者または代理者へ提出内容を提示する。
5. payload は暗号化され、sender keyで署名される。
6. watasu がsender keyとinvite bindingを検証する。
7. receiverが復号し、保護者同意・本人確認をservice側で処理する。

Verdict:
Conditional.

What watasu solves:
暗号化配送、request version固定、未検証sender拒否。

What remains outside:
保護者であることの証明、年齢確認、同意撤回、教育/児童関連法令。

### UC-12: QR / email handoff

Definition:
現地スタッフやメールから、特定requestのAgent Card URLを渡して提出してもらう。

Recommended profile:
`private_invite` for anything sensitive. `public_capability` only for low-risk public flows.

Journey:

1. service-side agent が request を publish する。
2. watasu が capability URL を発行する。
3. QRまたはemailにURLを入れる。
4. user-side agent がURLを読み、Agent Cardを取得する。
5. ユーザーが同意し、暗号化submissionを送る。
6. URL漏洩が判明した場合、operatorが capability URL を revoke / rotate する。
7. 旧URLからのsubmissionは webhook delivery 前に rejected される。
8. 新URLは同じrequest versionを指す。

Verdict:
Solved with ops caveat.

Remaining gaps:
漏洩検知、古いQRを見たユーザーへの案内、email転送時の意図しない共有はUX/運用課題。

### UC-13: 大規模 public campaign

Definition:
多数の一般ユーザーから低リスク情報を受け取る。例: キャンペーン応募、自治体アンケート前登録、プロダクトβ登録。

Recommended profile:
`public_capability`.

Journey:

1. service-side agent が low-risk fields だけで request を作る。
2. publish 前 summary で public sender を受け入れる理由、rate limit、retention、revoke手順を表示する。
3. URLを広く配布する。
4. 大量のuser-side agentやbotがアクセスする。
5. watasuがplatform-level、request-level、sender-pseudonym-level rate limitを適用する。
6. payload size limit 超過やrate limit超過は webhook delivery 前に rejected する。
7. receiverにはrate policy内のsubmissionだけ届く。

Verdict:
Conditional.

What watasu solves:
基本的なrate limit、payload size limit、ledger pollutionの軽減。

What remains outside:
大規模bot、DDoS、WAF、captcha相当、abuse通知、コスト上限、edge shielding。

### UC-14: webhook outage and retry

Definition:
service webhook が5xxまたはtimeoutし、submissionを配送できない。

Recommended profile:
Any production profile.

Journey:

1. user-side agent が正常な encrypted submission を送る。
2. watasu が envelope validation を通す。
3. watasu が service webhook に配送する。
4. webhook が5xxまたはtimeoutする。
5. watasu は encrypted payload body を保存しない。
6. delivery metadata だけを failed として記録する。
7. sender に `resubmit_later` を返す。
8. sender は同じ payload なら同じ idempotency key、新しい submission_id / timestamp / expires_at / signature で再送する。
9. payloadを変更する場合は新しい idempotency key を使う。

Verdict:
Solved with sender dependency.

Remaining gaps:
senderがretry contractを実装しない場合、配送は復旧しない。watasuはpayload retry queueを持たない設計なので、ここは意図的な制約。

### UC-15: capability URL leak

Definition:
Agent Card URLまたはcapability URLが意図しない相手に共有される。

Recommended profile:
Any hosted profile. Sensitive flows should use `private_invite`.

Journey:

1. operator がURL漏洩を検知する。
2. `revoke` を実行する。
3. watasu は capability status を revoked にする。
4. 旧URLからのsubmissionは webhook delivery 前に rejected される。
5. `rotate` を実行すると同じ request version に新しい capability_id と Agent Card URL が発行される。
6. ledger の capability_id_hash で影響範囲を確認できる。

Verdict:
Solved with detection caveat.

Remaining gaps:
漏洩検知と通知channelはMVPの中心機能ではない。高リスク用途では `private_invite` と sender key binding が必要。

### UC-16: malicious sender / forged submission

Definition:
攻撃者が偽のsubmission、古いidempotency key、改ざんpayload hash、未知のsender keyで送信する。

Recommended profile:
`verified_sender` or `private_invite`.

Journey:

1. 攻撃者が公開Agent Cardを取得する。
2. 攻撃者がschema_hashやconsent_receipt_hashを改ざんしたsubmissionを送る。
3. watasuがhash mismatchで rejected する。
4. 攻撃者が未知のsender keyで署名する。
5. `verified_sender` / `private_invite` では registered sender key allowlist にないため `auth_required` になる。
6. 攻撃者がreplay済みidempotency keyを使う。
7. watasuが replay protection で rejected する。
8. 攻撃者がrevoked capability URLを使う。
9. watasuが webhook delivery 前に rejected する。

Verdict:
Solved for signed profiles.

Remaining gaps:
`public_capability` は未認証senderを受け入れる設計なので、低リスク用途に限定する必要がある。

### UC-17: cross-tenant ledger access

Definition:
あるtenantのサービス側agentまたは侵害済みtokenが、別tenantのdelivery metadataを見ようとする。

Recommended profile:
Hosted profiles with tenant / role enforcement.

Journey:

1. attacker が別tenantの request_id または submission_id を推測する。
2. `list_ledger` または `inspect_delivery` を呼ぶ。
3. watasu は service identity と tenant_id を検証する。
4. cross-tenant の場合、authorization error または existence leak のない `not_found` を返す。
5. access attempt は audit log に残る。
6. consent receipt metadata の read も audit log に残る。

Verdict:
Solved if access tests pass.

Remaining gaps:
具体的な IdP / token issuer / role model は未選定。実装時に最小権限と監査が必要。

### UC-18: anonymous whistleblowing

Definition:
内部通報者や情報源が、身元を知られずに情報を送る。

Recommended profile:
None in MVP.

Journey that users need:

1. 通報者が自分の身元、ネットワーク、端末、提出時刻、提出内容をunlinkableにしたい。
2. 受領者は通報内容を受け取りたいが、通報者を特定できてはいけない。
3. 通報者は報復リスクから守られる必要がある。
4. 受領者は証拠保全、法的保護、双方向連絡をしたい場合がある。

What watasu would do today:

1. request metadata、submission time、sender pseudonym hash、capability_id_hash、consent receipt metadata を持つ。
2. payload は保持しないが、metadata correlation は残る。
3. mix network、unlinkability、legal shield、anonymous reply channel はない。

Verdict:
Not solved.

Reason:
ユースケースの中心価値は匿名性保証。watasu MVP の metadata ledger と相性が悪い。別設計が必要。

### UC-19: DV shelter / political / religious sensitive disclosure

Definition:
居場所、支援先、政治・宗教・労組活動など、metadataだけでも危険な情報を扱う。

Recommended profile:
None in MVP.

Journey that users need:

1. ユーザーは提出内容だけでなく、提出先、時刻、頻度、関係性も秘匿したい。
2. 受領者は必要最小限の人だけに情報を見せたい。
3. 万一の侵害時も、提出者と提出先の関係を追えない必要がある。

What watasu would do today:

1. payload本文は守れる。
2. ただし request type、submission time、sender pseudonym、destination type のmetadataが残る。
3. anonymous/unlinkable transport ではない。

Verdict:
Not solved.

Reason:
metadata自体が危険なユースケースでは、payload非保持だけでは足りない。

### UC-20: emergency triage / disaster response

Definition:
災害、救急、医療トリアージで、生命安全に関わる情報を即時に集める。

Recommended profile:
None in MVP.

Journey that users need:

1. 現場または患者が低通信環境でも情報を送れる。
2. 本人確認や同意例外の法的根拠が必要になる。
3. 受領側は高可用性、優先度制御、重複排除、監査、緊急アクセスを持つ。
4. 配送失敗時に、人命に関わる再送や代替経路が必要になる。

What watasu would do today:

1. blocking delivery を試みる。
2. webhook failure では payload を保存せず `resubmit_later` を返す。
3. offline mode、emergency override、life-safety SLA はない。

Verdict:
Not solved.

Reason:
MVP は安全なtransportであり、生命安全システムではない。

### UC-21: human web form replacement

Definition:
ユーザーがブラウザでフォーム入力し、送信・確認・修正する。

Recommended profile:
None in MVP.

Journey that users need:

1. ユーザーがURLを開く。
2. 人間向けフォームを見る。
3. 入力、validation、保存、確認、修正を行う。
4. 提出履歴や控えを見る。

What watasu would do today:

1. Agent Card と schema を公開する。
2. user-side agent が読む前提で、人間向け回答フォームはない。

Verdict:
Not solved.

Reason:
MVP は agent-native intake であり、フォームビルダーではない。

### UC-22: response table / CSV export

Definition:
サービス運用者が回答一覧を見て、検索、CSV出力、手動編集したい。

Recommended profile:
None in MVP.

Journey that users need:

1. operator がdashboardを開く。
2. 回答一覧を検索する。
3. plaintext payload を閲覧する。
4. CSV export する。
5. 手動で修正や削除をする。

What watasu would do today:

1. ledger metadata だけを保存する。
2. plaintext payload、decrypted payload、encrypted payload body は見られない。

Verdict:
Not solved.

Reason:
No payload custody と正面衝突する。必要なら service receiver 側の別管理画面で作る。

### UC-23: personal data vault

Definition:
ユーザーが自分の個人データを保存し、複数サービスへ再利用する。

Recommended profile:
None in MVP.

Journey that users need:

1. ユーザーが個人データをvaultに登録する。
2. vaultが最新性、正確性、削除、共有履歴を管理する。
3. ユーザーがサービスごとに開示範囲を選ぶ。
4. vaultが各サービスへ提出する。

What watasu would do today:

1. request と submission endpoint を提供する。
2. payload保存、ユーザーアカウント、データ更新、共有履歴はない。

Verdict:
Not solved.

Reason:
watasuは受け口であり、ユーザー側データ保管庫ではない。

### UC-24: DSAR / legal consent system

Definition:
法的な同意管理、開示請求、削除請求、処理停止、監査対応まで完結する。

Recommended profile:
None in MVP.

Journey that users need:

1. ユーザーが自分の提出データと処理目的を確認する。
2. 開示、訂正、削除、処理停止などを請求する。
3. service が法域ごとの期限で応答する。
4. 例外、法定保存、削除不能理由を管理する。
5. 監査証跡を法務・DPOが確認する。

What watasu would do today:

1. request version と consent receipt metadata を記録する。
2. payloadは持たない。
3. legal consentの完全性、DSAR workflow、payload削除はservice側に残る。

Verdict:
Not solved.

Reason:
MVPのconsent receiptは技術的証跡であり、法務ワークフローではない。

## 6. Cross-use-case failure paths

### 6.1 User refuses consent

1. user-side agent が要求内容を提示する。
2. ユーザーが拒否する。
3. user-side agent は submission しない。
4. watasu には delivery ledger row は作られない。

Result:
Correct behavior. watasu は refusal workflow を管理しない。

### 6.2 User-side agent cannot produce a required field

1. Agent Card / schema から required field を読む。
2. user-side agent が必要データを持っていない。
3. ユーザーへ不足を確認する。
4. データが揃わなければ submission しない、または service 側で optional version を作る。

Result:
Partially handled. watasu は plaintext schema validation をしないため、submission前のUXは user-side agent の責務。

### 6.3 Receiver rejects decrypted payload

1. watasu delivery は成功する。
2. receiver が復号後 schema validation に失敗する。
3. service は既存 request version を変更しない。
4. service-side agent が修正版 request version を作る。

Result:
Handled by versioning model. watasu は plaintext payload を見ない。

### 6.4 Sender retries after timeout

1. watasu が webhook timeout を受ける。
2. `resubmit_later` を返す。
3. sender が同じ payload を再送する場合、同じ idempotency key と新しい submission_id / timestamp / signature を使う。
4. payloadを変える場合は新しい idempotency key を使う。

Result:
Handled if sender follows contract.

### 6.5 Protocol drift

1. MCP / A2A / SDK が更新される。
2. generated Agent Card または tool schema が現行実装とズレる。
3. CI の vendored schema / official schema contract test が失敗する。
4. ERD、fixtures、SDK lock を同時更新する。

Result:
Handled by ERD gate if implemented.

## 7. Product implications

### 7.1 Best early wedge

最初に強いのは以下。

- event / waitlist / inquiry intake
- recruiting intake
- contractor onboarding
- B2B vendor registration
- QR / email handoff for private invite

理由:
これらは「フォームの代わりに、エージェントが読めるrequestを公開し、暗号化された提出を受ける」というMVPの価値にまっすぐ乗る。

### 7.2 Risky but important later wedge

条件付きで価値が出るが、周辺要件が重いもの。

- healthcare-adjacent allergies / medical notes
- medical intake
- financial / tax intake
- KYC / government ID
- minor data

理由:
watasu の payload非保持と sender key model は効く。ただし、導入時に「watasu が業務全体を満たす」と誤解されると危ない。

### 7.3 Avoid for MVP positioning

MVPの表現から明確に外したほうがいいもの。

- anonymous whistleblowing
- DV shelter / political / religious sensitive disclosure
- emergency triage / disaster response
- human web forms
- CSV export / answer database
- personal vault
- DSAR platform

理由:
これらは watasu の中心設計である no payload custody、metadata ledger、agent-native surface と正面からズレる。

## 8. Recommended implementation checkpoints

1. `public_capability` happy path: low-risk event / waitlist intake。
2. `verified_sender` happy path: recruiting or contractor onboarding。
3. `private_invite` happy path: B2B onboarding with invite-bound sender key。
4. Protocol gate path: hosted A2A HTTP+JSON で `application/a2a+json`、`A2A-Version: 1.0`、watasu extension opt-in、legacy `kind` rejection を envelope validation 前に検証する。
5. Sensitivity classification path: health、financial、government identity、minor、auth secret、safety-sensitive metadata が低分類や `public_capability` で通らないことを検証する。
6. Abuse path: rate limit、payload size、revoked capability、replayed idempotency。
7. Auth path: unknown、revoked、expired、scope mismatch sender key。
8. Outage path: webhook timeout、concurrency cap、circuit breaker、`resubmit_later` without payload persistence。
9. Metadata path: service identity derived tenant / role check、access audit、retention job、cross-tenant existence leak prevention。
10. No-persistence path: DB、logs、temporary files、APM traces、metrics labels、crash reports、test snapshots に plaintext payload / encrypted payload body が残らない。
11. Drift path: generated Agent Card / schema fixtures against vendored A2A and MCP schema snapshot。

## 9. Bottom line

watasu MVP は「agent-native な個人データ提出の安全な受け口」としてはかなり筋がいい。特に、低リスクpublic intake、採用、業務委託、B2B onboarding、限定QR/email handoff は MVP のままでも成立する。

一方で、高リスク領域では watasu は transport と技術的証跡だけを担当する。本人確認、法的同意、規制対応、匿名性保証、生命安全SLA、payload閲覧UI、personal vault は解かない。この境界を営業、README、SDK examples、publish summary のすべてで一貫させることが、プロダクトの安全性そのものになる。
