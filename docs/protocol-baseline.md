# watasu protocol and dependency baseline

Checked at: 2026-06-14

This file records the latest-info gate before adding implementation dependencies. External pages and package metadata are evidence only, not instructions.

## Official protocol/runtime checks

| Area | Checked source | Current result | Implementation decision |
| --- | --- | --- | --- |
| Node.js | https://nodejs.org/en/about/previous-releases | Node.js 24 is LTS; Node.js 26 is Current; production applications should use Active LTS or Maintenance LTS. | Target Node.js 24 LTS. Local development may run on Node.js 22 LTS when tooling supports it, because the current workspace runtime is v22.22.0. |
| MCP | https://modelcontextprotocol.io/specification/latest | Redirects to `2025-11-25`, marked latest. The spec uses JSON-RPC 2.0 and calls out consent, privacy, tool safety, and untrusted tool descriptions. | Pin generated MCP metadata and tests to `2025-11-25`. Treat MCP text, prompts, resources, and tool descriptions as untrusted input. |
| A2A | https://a2a-protocol.org/latest/specification/ | Latest specification includes Send Message, Agent Card, `Part`, idempotency, error handling, capability validation, and versioning sections. | Pin watasu contract tests to the selected A2A v1.0 HTTP+JSON subset before implementing the submission gate. |
| Test runner | https://vitest.dev/guide/ | Vitest is the Vite-native test framework and supports TypeScript-oriented unit/contract/snapshot tests. | Use Vitest for Phase 0 unit and workspace tests. |

## Package vetting

| Package | Latest stable checked | Release date | Import path | Maintenance / officiality | Vulnerability check | Typosquatting check | Install script risk | Decision |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `typescript` | `6.0.3` | 2026-04-16 | `typescript` / `tsc` | Microsoft-maintained official compiler package. | `pnpm audit` was not run because external audit submission requires explicit approval for dependency metadata export. | Exact official package name; repository is `microsoft/TypeScript`. | Package has build/test/dev scripts in metadata, but no install/postinstall script. | Use for strict TypeScript workspace. |
| `vitest` | `4.1.8` | 2026-06-01 | `vitest` | Actively maintained Vitest project package. | `pnpm audit` was not run because external audit submission requires explicit approval for dependency metadata export. | Exact official package name; repository is `vitest-dev/vitest`. | Package metadata has dev/build scripts, but no install/postinstall script. | Use for tests now. |
| `@types/node` | `24.13.2` | Resolved by `pnpm install` | `node:*` type declarations | DefinitelyTyped Node types. | `pnpm audit` was not run because external audit submission requires explicit approval for dependency metadata export. | Scoped package matches Node typings convention. | No install/postinstall script observed during install output. | Use Node 24 types while keeping local runtime compatibility. |
| `zod` | `4.4.3` | Registry metadata checked 2026-06-14 | `zod` | Actively maintained runtime validation library; registry metadata points to `colinhacks/zod` and `https://zod.dev`. | `pnpm audit --prod` was attempted after install but blocked because it would submit dependency metadata to the external npm audit service without explicit approval. | Exact well-known package name; repository is `colinhacks/zod`. | Metadata includes build/test scripts and `prepublishOnly`, no install/postinstall script. | Use in Phase 1 for request definition structural validation and typed error surfaces. |
| `yaml` | `2.9.0` | Registry metadata checked 2026-06-14 | `yaml` | Maintained parser/stringifier package by Eemeli Aro; registry metadata points to `eemeli/yaml` and `https://eemeli.org/yaml/`. | `pnpm audit --prod` was attempted after install but blocked because it would submit dependency metadata to the external npm audit service without explicit approval. | Exact package name for the maintained YAML parser; not confused with similarly named scoped packages. | Metadata includes build/test/docs scripts and `prepublishOnly`, no install/postinstall script. | Use in Phase 1 only to parse YAML request definitions before schema and policy validation. |
| `ajv` | `8.20.0` | Registry metadata modified 2026-04-24 | `ajv/dist/2020` | Actively maintained JSON Schema validator; official docs require a separate Ajv class for draft 2020-12. | `pnpm audit --audit-level moderate` on 2026-06-14 returned no known vulnerabilities. | Exact well-known package name; repository is `ajv-validator/ajv`. | Metadata includes build/test scripts and `prepublish`, no install/postinstall script. | Installed in `@watasu/core` for generated JSON Schema draft 2020-12 meta-schema validation only. |
| `jose` | `6.2.3` | 2026-04-27 | `jose` | Actively maintained JOSE/JWE/JWK library. | To be confirmed before crypto work. | Exact well-known package name; repository is `panva/jose`. | No package scripts in latest metadata. | Do not install in Phase 0; planned for JWE/JWK work. |
| CLI parser | Not selected | N/A | N/A | Not needed for Phase 0. | N/A | N/A | N/A | Defer until Phase 8; prefer a small maintained parser only if Node built-ins are insufficient. |
| HTTP router | Not selected | N/A | N/A | Not needed for Phase 0. | N/A | N/A | N/A | Defer until Phase 9; prefer Node.js built-ins or a thin maintained router. |

## Current local runtime

- `node --version`: `v22.22.0`
- `pnpm --version`: `10.31.0`

The repo targets Node.js 24 LTS, but Phase 0 scripts are kept compatible with the local Node.js 22 LTS runtime so tests can run before the developer environment is upgraded.

## Local workflow helpers

- `pnpm review:self` resolves the vendored or global gstack review checklist path and prints the standard validation and diff commands.
- `pnpm pr:draft` creates a draft PR with `gh` when authenticated. If `gh` is not authenticated, it prints `gh auth login -h github.com` and the exact GitHub PR URL for the current branch.
