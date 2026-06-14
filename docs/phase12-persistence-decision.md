# Phase 12 optional persistence decision list

Date: 2026-06-14

## Short answer

Default recommendation: do not add real persistent storage to the MVP unless we need ledger inspection, audit evidence, or hosted multi-tenant operations in the next demo or release.

Keep the current default as `stateless_default`. Add optional persistence only as an explicit opt-in feature with tenant, role, audit, and retention boundaries from day one.

## Why this decision matters

watasu's strongest promise is no payload custody:

- watasu does not see plaintext payload values.
- watasu does not persist encrypted payload bodies after delivery.
- watasu may keep only metadata that is needed for protocol safety, delivery status, consent receipt verification, and abuse controls.

Persistent metadata is still sensitive. A row that contains request type, field ids, submission time, sender pseudonym, consent receipt hash, and delivery status can reveal something about a person or service even without payload values.

So the choice is not "DB or no DB". The real choice is:

```text
Do we need durable metadata enough to justify new privacy, access-control,
retention, operational, and supply-chain risk?
```

## Decide with this checklist

Answer each item with `yes`, `no`, or `not yet`.

| Question | If yes | If no / not yet |
| --- | --- | --- |
| Do we need to inspect delivery history after the process restarts? | Persistence is useful. | Stay stateless. In-memory operational state is enough. |
| Do service owners need proof of which request version and consent text were used later? | Add metadata-only consent receipt storage. | Keep consent receipt verification in request/submission flow only. |
| Do we need a hosted multi-tenant ledger in the MVP? | Add tenant/role checks before any DB adapter. | Defer DB. Local demo can stay stateless. |
| Do support or debugging workflows require historical delivery metadata? | Add inspectable metadata with strict redaction. | Prefer logs/tests/demo output, not persistent ledger. |
| Do customers ask for auditability as a buying requirement? | Persistence may be product-critical. | Avoid adding storage just because it is normal for web apps. |
| Are we ready to implement retention deletion/anonymization now? | Persistence can be safe enough to start. | Do not persist yet. Retention debt is security debt. |
| Are we ready to enforce role separation server-side? | Add `ledger_viewer` / `auditor` flows. | Do not expose ledger reads. |
| Can cross-tenant lookups return `not_found` without existence leaks? | Add access-control tests first. | Do not build shared hosted ledger yet. |
| Is the next milestone local CLI/MCP contract confidence? | Persistence is probably unnecessary. | Stay focused on local contract quality. |
| Is the next milestone hosted beta or production-ish demo? | Persistence may become necessary. | Keep storage optional until hosting needs are real. |

## Strong reasons to add it now

Add optional persistence in Phase 12 if at least two of these are true:

- We want a hosted beta where service owners can inspect delivery metadata after restarts.
- The product story needs durable technical consent receipt evidence.
- We need support workflows like `watasu inspect-delivery <submission-id>` backed by historical data.
- We need to prove tenant/role/retention boundaries before talking to security-sensitive users.
- The next demo must show optional metadata-only ledger behavior, not only stateless delivery.

## Strong reasons to defer it

Defer real persistence if most of these are true:

- The immediate goal is a local CLI/MCP MVP, not a hosted service.
- No user has asked to inspect historical ledger rows yet.
- The main value being tested is agent-native intake and no-payload-custody, not audit reporting.
- We do not yet know the hosted identity model.
- We would add a DB before adding tenant, role, audit, and retention behavior.
- Adding storage would slow down the core protocol/demo loop.

## Risk comparison

| Option | What we build | Pros | Risks | Best when |
| --- | --- | --- | --- | --- |
| A. Stay stateless | Keep only short-lived operational state. | Safest privacy posture, simplest MVP, best fit for no-payload-custody. | No durable delivery history or audit evidence. | We are still validating core protocol and CLI/MCP UX. |
| B. Metadata-only optional ledger | Persist request/version/delivery/consent metadata, never payload bodies. | Supports audit, inspect-delivery, hosted beta, security demos. | Requires tenant/role checks, audit logs, retention jobs, leak tests. | We need hosted service-owner workflows soon. |
| C. Full operational store | Persist broad operational state, queue/retry payloads, rich logs. | Easier support and retries. | Conflicts with no-payload-custody and increases breach impact. | Not recommended for MVP. |

## My recommended gate

Use this rule:

```text
If the next milestone is local MVP confidence, choose A.
If the next milestone is hosted beta with service-owner inspection, choose B.
Do not choose C for the MVP.
```

For the current repo state, choose A for now and prepare B behind the existing `StoragePolicy` boundary. That means the next coding loop should be access-control behavior first, not a database adapter first.

## If we choose A: defer persistence

Do this:

- Keep `stateless_default` as the default everywhere.
- Keep the current future-store leak regression tests.
- Document that `ledger` and `inspect-delivery` are limited to short-lived local/demo state.
- Revisit this decision before hosted beta.

Acceptance:

- `pnpm loop` stays green.
- `pnpm demo:handoff` still proves no payload custody.
- Manual payload leak search only finds fixture values in fixture files.

## If we choose B: add optional metadata ledger

Implementation order:

1. Add pure access-control tests before storage:
   - `ledger_viewer` can inspect metadata.
   - `publisher` cannot inspect ledger metadata.
   - cross-tenant `submission_id` returns `not_found` or authorization error without existence leak.
   - metadata read creates an access audit event.
2. Add retention policy tests:
   - expired delivery metadata is deleted or anonymized.
   - active request versions are not deleted.
   - audit logs do not contain payload values or encrypted payload bodies.
3. Add storage interface expansion:
   - request versions append-only.
   - delivery rows metadata-only.
   - consent receipt rows metadata-only.
   - access audit rows metadata-only.
4. Only then choose a DB adapter.

DB direction if hosted persistence is needed:

- Prefer PostgreSQL-compatible storage for hosted multi-tenant mode because it supports mature role/permission patterns and Row-Level Security.
- SQLite can be acceptable for local demo only, but it should not become the hosted multi-tenant default.

Acceptance:

- `pnpm loop` passes.
- New Phase 12 tests pass.
- No persistent row stores plaintext payload, encrypted payload body, webhook secret, private key, or full capability token.
- Every ledger read is scoped by service identity, not by request body or MCP tool arguments.
- Retention behavior is tested with deterministic clocks.

## Non-negotiables if persistence is added

- Payload values are never persisted.
- Encrypted payload bodies are not persisted after delivery.
- Full webhook URLs are not stored in ledger rows; store hashes or routing metadata only.
- Full capability tokens are never logged or stored.
- `tenant_id` and roles come from service identity, not user-controlled inputs.
- Ledger inspection must not leak whether another tenant's submission exists.
- Metadata reads create audit events.
- Retention is implemented before calling the feature production-ready.

## Latest-info notes checked

- OWASP GenAI / LLM guidance continues to call out Sensitive Information Disclosure and Excessive Agency risks for LLM and agentic systems.
- NIST Privacy Framework is still positioned as a tool for managing privacy risk.
- PostgreSQL current docs describe Row-Level Security as per-user row restrictions, default-deny when enabled without policies, and policy controls for commands/roles.

Sources:

- https://owasp.org/www-project-top-10-for-large-language-model-applications/
- https://www.nist.gov/privacy-framework
- https://www.postgresql.org/docs/current/ddl-rowsecurity.html
