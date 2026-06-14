# watasu protocol and tooling baseline

Checked at: 2026-06-14

This file records the current official sources and supply-chain decisions for the initial workspace foundation. It should be updated before adding protocol SDKs, crypto, runtime validation, JSON Schema validation, CLI parsers, HTTP routers, or production delivery dependencies.

## Official sources checked

| Area | Source checked | Decision |
| --- | --- | --- |
| Node.js runtime | Node.js releases page: v24 is LTS, v26 is Current, and production applications should use Active LTS or Maintenance LTS. | Target Node.js 24 LTS for the MVP runtime and use matching Node 24 type definitions. |
| pnpm workspace | pnpm workspace docs: a workspace must have `pnpm-workspace.yaml` in the root, and `workspace:` dependencies keep local package links explicit. | Use a root `pnpm-workspace.yaml` and `workspace:*` for internal packages. |
| TypeScript project layout | TypeScript project references docs: `tsc -b` builds referenced projects in dependency order. | Use per-package `tsconfig.json` files with `composite: true` and root `pnpm typecheck` via `tsc -b`. |
| Node package entry points | Node packages docs recommend `exports` for new packages and note that it encapsulates unexported subpaths. | Add explicit `exports` for `@watasu/core`, `@watasu/cli`, and `@watasu/fixtures`. |
| Test runner | Vitest guide: Vitest is a Vite-powered test framework, supports `vitest run`, and requires Node >= 20. | Use Vitest for the Phase 0 workspace behavior tests. |

## Dependencies added in this baseline

| Package | Version | Import / command | Maintenance check | Vulnerability check | Typosquatting check | Install script risk | Reason |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `typescript` | `6.0.3` | `tsc -b` | npm metadata reports latest `6.0.3`, modified 2026-04-16. | `pnpm audit --audit-level moderate`: no known vulnerabilities. | Official compiler package owned by the TypeScript project name. | No project-specific install script added. | Required for strict TypeScript package builds and project references. |
| `vitest` | `4.1.8` | `vitest run` | npm metadata reports latest `4.1.8`, modified 2026-06-12; official docs show Vitest 4 guide. | `pnpm audit --audit-level moderate`: no known vulnerabilities. | Official package name used by Vitest docs. | Transitive optional native packages are lockfile-pinned; no custom repo install script added. | Required for fast TS behavior tests. |
| `@types/node` | `24.13.2` | Node type declarations | npm metadata shows `24.13.2` as the latest Node 24 type line, modified 2026-06-10. | `pnpm audit --audit-level moderate`: no known vulnerabilities. | Official DefinitelyTyped scope and Node package name. | No project-specific install script added. | Required to typecheck Node.js 24 APIs without using DOM globals. |

## Current non-decisions

- MCP SDK, A2A schemas, Zod, Ajv, jose, CLI parser, HTTP router, database, and logger are not added in this baseline.
- `scripts/secret-scan.mjs` is intentionally a lightweight local gate, not a replacement for a full SAST or secret scanning service.
- The CLI implementation is a minimal executable smoke path only. Product behavior begins in the next TDD phases.

## Verification run

```bash
pnpm install --lockfile-only
pnpm typecheck
pnpm test
pnpm lint
pnpm review:self
pnpm --filter @watasu/cli watasu
pnpm audit --audit-level moderate
```

## Local workflow helpers

- `pnpm review:self` resolves the vendored or global gstack review checklist path and prints the standard validation and diff commands.
- `pnpm pr:draft` creates a draft PR with `gh` when authenticated. If `gh` is not authenticated, it prints `gh auth login -h github.com` and the exact GitHub PR URL for the current branch.
