# watasu CLI/MCP MVP TDD implementation plan

Date: 2026-06-14

## Goal

Build the watasu CLI/MCP MVP in small, testable increments. Each increment must prove one behavior before the next layer is added.

The implementation order is inside-out:

```text
pure contracts
  -> request validation and hashes
  -> local publish store
  -> Agent Card and schemas
  -> submission validation
  -> webhook delivery
  -> short-lived state / optional ledger metadata
  -> CLI
  -> MCP
  -> reference fixtures
```

This keeps the risky surfaces testable before they are exposed through CLI, MCP, or HTTP.

## Latest-info gate

Before coding starts, verify and record current official versions and dependency vetting in `docs/protocol-baseline.md`:

| Area | Current checked source | Implementation decision |
| --- | --- | --- |
| Node.js | Node.js official releases page shows v24 as LTS and says production apps should use Active/Maintenance LTS | Use Node.js 24 LTS unless the local runtime blocks it |
| MCP | `https://modelcontextprotocol.io/specification/latest` currently redirects to version `2025-11-25` | Pin generated MCP metadata and tests to `2025-11-25` |
| A2A | A2A latest specification lists Send Message, Agent Card, `Part`, versioning, idempotency, and error handling sections | Pin tests to the chosen A2A v1.0 HTTP+JSON subset |
| Test runner | Vitest official docs position it as the Vite-native TS/JS test runner | Use Vitest for unit, contract, and snapshot tests |
| Runtime validation | Official package metadata and release notes for Zod | Use only if current stable release has acceptable maintenance and supply-chain posture |
| JSON Schema validation | Official package metadata and release notes for Ajv | Use only if current stable release supports draft 2020-12 and has acceptable maintenance and supply-chain posture |
| Crypto/JWE | Official package metadata and release notes for jose | Use only if current stable release supports the required JWE/JWK operations without custom crypto |
| CLI parser | Official package metadata for the selected lightweight parser | Use the smallest maintained parser that supports structured errors and help output |
| HTTP router | Official package metadata for Node.js built-ins or the selected router | Prefer Node.js built-ins or a thin maintained router; avoid framework weight before local contracts are green |

Do not add protocol SDKs, crypto packages, validation libraries, CLI parsers, HTTP routers, or test tooling until this baseline file exists. Package installation is a supply-chain boundary.

For every new package, record:

- official package name and import path
- latest stable version and release date
- maintenance status
- known vulnerability check result
- typosquatting check against similarly named packages
- install/postinstall script risk
- reason this dependency is needed instead of a built-in API

## Short Threat Model

This MVP touches personal-data transport, public endpoints, webhooks, cryptography, MCP tools, and LLM/agent workflows.

Primary assets:

- plaintext payload values, which watasu must never see or persist
- encrypted payload bodies, which must remain memory-only after delivery attempt
- request versions and consent receipt metadata, only when optional persistence is enabled
- service public keys, sender keys, capability URLs, webhook destinations
- ledger metadata, which can still become personal-related information and is default-off

Attack paths to test from the first sprint:

- malicious request definition hides high-sensitivity or prohibited fields under low sensitivity
- MCP/tool text or external docs attempt prompt injection against the implementation agent
- public capability URL is leaked or replayed
- sender reuses idempotency key or sends expired submission
- A2A request skips protocol headers and reaches envelope validation anyway
- webhook target is unsafe, downgraded, redirected, or SSRF-like
- logs, snapshots, temp files, or DB rows contain plaintext or encrypted payload bodies
- cross-tenant ledger inspection leaks existence

Security defaults:

- all code identifiers, tests, comments, docstrings, logs, and example error messages are English
- no custom crypto
- no plaintext payload persistence
- no encrypted payload body persistence after delivery attempt
- every public or semi-public endpoint validates before side effects
- every optional persistent metadata read writes an audit event

## Phase 0: Repository Foundation

Purpose: create a minimal TypeScript workspace where tests can run before product logic exists.

Red tests:

- `test_workspace_scripts_run_typecheck_and_tests`
- `test_package_exports_core_cli_and_fixtures_packages`
- `test_no_env_files_or_secret_like_values_are_committed`

Green implementation:

- Add `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, Vitest config, and packages:
  - `packages/core`
  - `packages/cli`
  - `packages/fixtures`
- Add `pnpm test`, `pnpm typecheck`, `pnpm lint` or a minimal placeholder lint command.
- Define the canonical local CLI invocation and use it throughout the docs. Preferred shape: `pnpm --filter @watasu/cli watasu ...`.
- Add a secret-scan check using a lightweight script first; replace with a real tool later if needed.

Verify:

```bash
pnpm install
pnpm typecheck
pnpm test
```

Human check:

- Confirm package boundaries feel right before we create many files.

## Phase 1: Request Definition Schema and Normalization

Purpose: validate YAML/JSON request definitions and produce canonical JSON.

Data flow:

```text
request YAML/JSON
  -> parse
  -> structural validation
  -> sensitivity inference
  -> canonical JSON
  -> validation result
```

Red tests:

- `test_valid_event_request_returns_normalized_definition`
- `test_missing_required_fields_returns_invalid_request_definition`
- `test_unknown_trust_profile_is_rejected`
- `test_public_capability_with_high_sensitivity_field_is_rejected`
- `test_authentication_secret_field_is_prohibited`
- `test_sensitivity_inference_upgrades_allergies_address_tax_id_minor_age`
- `test_human_override_cannot_downgrade_to_public_capability`
- `test_canonical_json_sorts_object_keys_and_preserves_field_order`

Green implementation:

- Add Zod runtime schemas for request definitions.
- Add YAML and JSON parsing.
- Add deterministic canonical JSON function.
- Add sensitivity inference rules from ERD section 4.1.
- Return structured validation errors and warnings.

Refactor checkpoint:

- Keep validation rules as data tables where possible.
- Keep parser, schema validation, and policy validation separate.

Verify:

```bash
pnpm test -- --run packages/core/src/request
```

Human check:

- Review blocked-field classifications. This is a product/security policy call, not just code.

## Phase 2: Hashes, IDs, and Immutable Request Versions

Purpose: generate stable hashes and append-only request versions.

Data flow:

```text
normalized request
  -> request_version_hash
  -> schema_hash
  -> consent_text_hash
  -> field_purposes_hash
  -> destination_policy_hash
  -> public_key_fingerprint
```

Red tests:

- `test_sha256_hash_uses_base64url_without_padding`
- `test_same_canonical_request_produces_same_hashes`
- `test_field_order_changes_request_version_hash`
- `test_object_key_order_does_not_change_hash`
- `test_publish_creates_new_version_when_consent_changes`
- `test_published_request_version_cannot_be_mutated`

Green implementation:

- Implement hash helpers using Node.js Web Crypto or `crypto`.
- Implement local in-memory repository first.
- Add a filesystem, SQLite, or hosted repository only if optional persistence is explicitly needed after behavior is proven.

Refactor checkpoint:

- Define repository interfaces after two concrete use cases exist: validate-only and publish.

Verify:

```bash
pnpm test -- --run packages/core/src/hash packages/core/src/request-version
```

Human check:

- Confirm version naming: `v1`, `v2`, or timestamp-like versions.

## Phase 3: JSON Schema Generation

Purpose: generate plaintext payload schema and envelope schema without validating plaintext payload values inside watasu.

Red tests:

- `test_plaintext_schema_contains_requested_fields_without_examples`
- `test_required_fields_are_marked_required`
- `test_email_field_uses_email_format`
- `test_envelope_schema_requires_idempotency_and_consent_receipt_hash`
- `test_schema_hash_matches_generated_plaintext_schema`
- `test_generated_schema_is_valid_json_schema_2020_12`

Green implementation:

- Add schema generator from normalized request.
- Validate generated schemas with Ajv 2020-12.
- Snapshot schemas for stable contract output.

Refactor checkpoint:

- Keep schema generation pure and independent from storage.

Verify:

```bash
pnpm test -- --run packages/core/src/schema
```

## Phase 4: Local Publish and Agent Card

Purpose: publish a request locally and generate an A2A-compatible Agent Card.

Data flow:

```text
normalized request
  -> publish dry-run summary
  -> human confirmation flag
  -> local request version
  -> capability URL metadata
  -> Agent Card JSON
```

Red tests:

- `test_publish_without_confirmation_returns_publish_requires_confirmation`
- `test_local_demo_publish_allows_localhost_webhook`
- `test_hosted_publish_rejects_localhost_webhook`
- `test_agent_card_declares_http_json_supported_interface`
- `test_agent_card_declares_protocol_version`
- `test_agent_card_includes_watasu_extension_uri`
- `test_agent_card_does_not_include_webhook_secret_or_private_key`
- `test_agent_card_snapshot_matches_contract`

Green implementation:

- Add publish service with dry-run and confirmed modes.
- Add Agent Card builder.
- Add capability token generation with 256-bit entropy.
- Store only capability token hash in local repository.

Refactor checkpoint:

- Keep public Agent Card metadata allowlisted. Do not serialize the whole request.

Verify:

```bash
pnpm test -- --run packages/core/src/publish packages/core/src/agent-card
```

Human check:

- Inspect the generated Agent Card snapshot before building HTTP or MCP around it.

## Phase 5: Submission Protocol Gate

Purpose: reject invalid A2A HTTP+JSON submissions before envelope validation or side effects.

Data flow:

```text
HTTP request metadata
  -> method/content-type/body-size gate
  -> A2A-Version gate
  -> A2A-Extensions gate
  -> SendMessage shape gate
  -> envelope validation
```

Red tests:

- `test_missing_content_type_is_rejected_before_envelope_validation`
- `test_wrong_content_type_is_rejected_before_envelope_validation`
- `test_missing_a2a_version_is_rejected`
- `test_unsupported_a2a_version_is_rejected`
- `test_missing_required_extension_is_rejected`
- `test_legacy_kind_discriminator_is_rejected`
- `test_invalid_part_media_type_is_rejected`
- `test_protocol_rejection_does_not_create_ledger_or_idempotency_record`

Green implementation:

- Implement protocol gate as a pure function over request metadata and body.
- Return structured error states.
- Add call-order tests using fake repositories.

Refactor checkpoint:

- Keep HTTP framework adapters thin. The protocol gate should be testable without a server.

Verify:

```bash
pnpm test -- --run packages/core/src/a2a
```

## Phase 6: Envelope Validation, Replay, and Rate Limit

Purpose: validate encrypted submission envelope without decrypting payload.

Red tests:

- `test_valid_public_capability_envelope_is_accepted`
- `test_schema_hash_mismatch_is_rejected`
- `test_service_key_id_mismatch_is_rejected`
- `test_encrypted_payload_hash_mismatch_is_rejected`
- `test_consent_receipt_hash_mismatch_is_rejected`
- `test_expired_submission_is_rejected`
- `test_replayed_idempotency_key_is_rejected`
- `test_revoked_capability_url_is_rejected`
- `test_verified_sender_without_signature_returns_auth_required`
- `test_private_invite_requires_sender_key_and_invite_binding`
- `test_rate_limited_submission_is_rejected_before_webhook_delivery`

Green implementation:

- Add envelope validator.
- Add idempotency store abstraction.
- Add in-memory rate limiter with deterministic clock injection.
- Add sender trust policy checks.

Refactor checkpoint:

- Make clock, random, and repositories injectable. Tests should not sleep.

Verify:

```bash
pnpm test -- --run packages/core/src/submission
```

Human check:

- Review response semantics: `rejected` vs `auth_required` vs `resubmit_later`.

## Phase 7: Webhook Delivery and No-Payload-Custody Ledger

Purpose: deliver encrypted envelope to webhook and persist metadata only.

Data flow:

```text
accepted envelope
  -> delivery request signing
  -> webhook POST
  -> delivery result
  -> metadata-only ledger row
  -> sender response
```

Red tests:

- `test_delivery_uses_https_for_hosted_mode`
- `test_hosted_delivery_rejects_private_ip_and_metadata_service_targets`
- `test_delivery_signature_covers_timestamp_body_digest_and_ids`
- `test_webhook_2xx_returns_delivered`
- `test_webhook_5xx_returns_resubmit_later`
- `test_timeout_returns_resubmit_later`
- `test_resubmit_later_does_not_terminally_mark_idempotency_key`
- `test_ledger_row_does_not_store_plaintext_payload`
- `test_ledger_row_does_not_store_encrypted_payload_body`
- `test_debug_logs_do_not_include_payload_bodies`

Green implementation:

- Add delivery client interface and fake client tests first.
- Add real HTTP client after behavior is locked.
- Add metadata-only ledger writer.
- Add structured logger with payload redaction tests.

Refactor checkpoint:

- Keep network code behind one adapter.
- Do not introduce retry queue for payload.

Verify:

```bash
pnpm test -- --run packages/core/src/delivery packages/core/src/ledger
```

Human check:

- Inspect one failed-delivery ledger row and one delivered row.

## Phase 8: CLI Surface

Purpose: expose validated core behavior through local commands.

CLI commands:

- `watasu validate <file>`
- `watasu publish <file> --confirm`
- `watasu agent-card <request-id> --version <version>`
- `watasu schema <request-id> --version <version>`
- `watasu submit-fixture <request-id> --payload <file>`
- `watasu ledger <request-id>`
- `watasu inspect-delivery <submission-id>`

Red tests:

- `test_cli_validate_outputs_structured_json`
- `test_cli_validate_exits_nonzero_for_invalid_request`
- `test_cli_publish_requires_confirm_flag`
- `test_cli_agent_card_outputs_snapshot`
- `test_cli_ledger_never_prints_payload_body`
- `test_cli_errors_are_machine_readable`

Green implementation:

- Add thin CLI package using a lightweight parser.
- CLI calls core services only.
- Use fixtures from `packages/fixtures`.

Verify:

```bash
pnpm test -- --run packages/cli
pnpm --filter @watasu/cli watasu validate packages/fixtures/requests/event-attendee.yaml
```

Human check:

- Run the happy-path CLI manually and decide whether command names feel natural.

## Phase 9: HTTP Local Demo

Purpose: serve Agent Card, schemas, and submission endpoint locally for contract tests.

Red tests:

- `test_get_agent_card_returns_published_card`
- `test_get_plaintext_schema_returns_schema`
- `test_get_envelope_schema_returns_schema`
- `test_post_submission_requires_a2a_content_type`
- `test_post_submission_delivers_to_receiver_fixture`
- `test_post_submission_failure_returns_resubmit_later`

Green implementation:

- Add thin HTTP server.
- Keep handlers as adapters around core services.
- Add receiver fixture for delivery verification.

Verify:

```bash
pnpm test -- --run packages/http
pnpm demo:local
```

Human check:

- Manual curl flow:
  - fetch Agent Card
  - fetch schema
  - submit encrypted fixture
  - inspect ledger metadata

## Phase 10: MCP Server

Purpose: expose service-side agent tools without making MCP text a trusted instruction source.

Red tests:

- `test_mcp_tools_have_input_and_output_schema`
- `test_validate_request_tool_returns_structured_content`
- `test_publish_request_tool_requires_confirmation`
- `test_tool_descriptions_are_not_executed_as_instructions`
- `test_mcp_elicitation_never_requests_user_personal_data`
- `test_mcp_resources_return_metadata_only`
- `test_mcp_tool_results_match_output_schema`

Green implementation:

- Add MCP server package only after core and CLI behavior is stable.
- Register tools/resources/prompts from ERD sections 7.1 to 7.3.
- Keep MCP handlers thin.

Verify:

```bash
pnpm test -- --run packages/mcp
```

Human check:

- Use a service-side agent to discover tools and run `validate_request`.

## Phase 11: Reference Sender and Receiver Fixtures

Purpose: prove another agent-like client can read contracts and submit encrypted data.

Red tests:

- `test_sender_fixture_reads_agent_card_and_schema`
- `test_sender_fixture_encrypts_payload_before_submission`
- `test_sender_fixture_uses_part_data_and_application_json_media_type`
- `test_receiver_fixture_verifies_delivery_signature`
- `test_receiver_fixture_rejects_stale_timestamp`
- `test_receiver_fixture_decrypts_and_validates_payload`

Green implementation:

- Add sender fixture, not a real user-side agent.
- Add receiver template with signature, digest, idempotency, decrypt, and JSON Schema validation.

Verify:

```bash
pnpm test -- --run packages/fixtures
pnpm demo:handoff
```

Human check:

- Review demo output for the core promise: watasu did not log or persist payload values.

## Phase 12: Optional Persistence, Access Control, Retention

Purpose: keep watasu stateless by default, then add optional metadata-only persistence only when a service owner explicitly enables it.

Red tests:

- `test_default_hosted_mode_does_not_persist_delivery_metadata`
- `test_optional_store_persists_request_versions_append_only`
- `test_cross_tenant_ledger_inspection_returns_not_found_without_existence_leak`
- `test_ledger_viewer_can_read_metadata`
- `test_publisher_cannot_read_ledger_without_ledger_viewer_role`
- `test_metadata_read_creates_access_audit_log`
- `test_retention_job_deletes_or_anonymizes_expired_metadata`
- `test_retention_job_does_not_touch_active_request_versions`

Green implementation:

- Add a storage policy layer with `stateless_default` and `metadata_ledger_enabled` modes.
- Keep default hosted delivery on short-lived operational state only.
- Add optional metadata-only storage adapter after behavior is proven.
- Add repository implementations behind existing interfaces.
- Add role and tenant boundary checks server-side.

Current progress:

- `stateless_default` / `metadata_ledger_enabled` delivery ledger policy boundary is implemented in core.
- Local HTTP demo uses `stateless_default` by default, even if a persistent store is present.
- SQLite or hosted DB adapters are not implemented yet; future adapters should sit behind this policy boundary.
- Phase 13 now includes durable-store leak regression tests that exercise the future persistent-store boundary without requiring a DB adapter.

Refactor checkpoint:

- No service should accept `tenant_id` or `role` from user-controlled request bodies.

Verify:

```bash
pnpm test -- --run packages/core/src/storage packages/core/src/access-control
```

Human check:

- In default mode, verify no persistent ledger rows are written after a demo run.
- If optional ledger mode is enabled, inspect DB rows after a demo run and confirm they contain metadata only.

## Phase 13: Security Regression Suite

Purpose: prevent the core trust promises from regressing.

Required tests:

- `test_no_plaintext_payload_in_database`
- `test_no_encrypted_payload_body_in_database_after_delivery`
- `test_no_payload_values_in_logs`
- `test_no_payload_values_in_failed_snapshots`
- `test_capability_url_full_token_is_never_logged`
- `test_unsafe_webhook_url_is_rejected_in_hosted_mode`
- `test_prompt_injection_text_in_request_definition_is_treated_as_data`
- `test_external_agent_card_instructions_are_not_executed`
- `test_dependency_lockfile_exists`

Verify:

```bash
pnpm test -- --run security
pnpm audit
```

Human check:

- Run a manual payload-leak search after demo:

```bash
rg "Alice Example|alice@example.com|sample-secret-value" .
```

Only fixture files should match known plaintext fixture values. DB, logs, temp files, and snapshots should not.

Check encrypted payload body persistence separately by searching storage and log outputs for JWE body fields after delivery:

```bash
rg "\"encrypted_payload\"|\"encrypted_key\"|\"ciphertext\"|\"protected\"|\"tag\"" .watasu-local logs tmp
```

Only intentionally retained fixture files or in-memory test inputs should contain encrypted payload body fields. Delivery ledger rows may store `encrypted_payload_hash`, but not `encrypted_payload` or JWE body fields.

## Acceptance Map

```text
ERD acceptance area                 Phase
--------------------------------------------------
validate_request                    1, 8, 10
publish_request confirmation         4, 8, 10
immutable request versions           2, 12
Agent Card + schemas                 3, 4, 9
A2A protocol gate                    5, 9, 11
encrypted submission envelope         6, 11
replay/rate/capability protection     6
webhook delivery                     7, 11
metadata-only ledger                 7, 12, 13
tenant/role access control            12
retention                            12
no payload custody                   7, 13
MCP schemas/resources/prompts         10
reference sender/receiver             11
```

## Manual Checkpoints

Ask for human review at these points:

1. After Phase 0: package boundaries and commands.
2. After Phase 1: sensitivity/prohibited-field policy.
3. After Phase 4: generated Agent Card snapshot.
4. After Phase 6: response semantics and auth policy.
5. After Phase 8: CLI names and local developer experience.
6. After Phase 11: full demo output and payload custody claim.
7. Before Phase 12: whether optional persistence is needed at all; if hosted scale is required, prefer PostgreSQL-compatible storage over SQLite.

## NOT in scope

- Dashboard UI: MVP is CLI/MCP first.
- Real user-side agent: only sender fixture is built.
- Legal consent engine: watasu records technical consent receipt metadata only.
- Identity proof / KYC / delegated authority: service-side responsibility.
- Production retry queue for encrypted payload: conflicts with no payload custody.
- Custom crypto or HPKE-first design: JWE/JWK through established libraries is enough for MVP.
- Full hosted deployment pipeline: defer until local CLI/MCP contract is green.

## Parallelization Strategy

Sequential core first, then parallel outer layers.

| Lane | Work | Depends on | Conflict risk |
| --- | --- | --- | --- |
| A | Phases 0-4 core request/publish/schema/card | none | high if split too early |
| B | Phase 5 A2A protocol gate | Phase 3 types | medium |
| C | Phase 6 submission validation | Phase 4 publish metadata | high with B if shared envelope types move |
| D | Phase 7 delivery/ledger | Phase 6 accepted envelope result | medium |
| E | Phase 8 CLI | Phase 4, partial Phase 7 | low |
| F | Phase 10 MCP | Phase 8 command semantics | low |
| G | Phase 11 fixtures | Phase 9 HTTP local demo | low |
| H | Phase 12 persistence/access/retention | Phase 7 interfaces | medium |

Recommended order:

```text
A sequential
  -> B + C after shared envelope types settle
  -> D
  -> E + F in parallel
  -> G
  -> H
  -> security regression pass
```

## Definition of Done

Each phase is done only when:

- the listed Red tests fail first
- the Green implementation makes only those tests pass
- refactor keeps all tests green
- test names and code are English
- no plaintext payload or encrypted payload body is persisted unless the phase explicitly works on a fixture file
- `pnpm test` passes
- any human checkpoint for the phase has been resolved
