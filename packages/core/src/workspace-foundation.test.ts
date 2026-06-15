import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parse as parseYaml } from "yaml";
import { findSecretLikeValues } from "../../../scripts/secret-scan.mjs";

const rootDir = new URL("../../../", import.meta.url);
const expectedCutoverHeadSha = "0123456789abcdef0123456789abcdef01234567";

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(new URL(path, rootDir), "utf8"));
}

function readText(path: string): string {
  return readFileSync(new URL(path, rootDir), "utf8");
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected a YAML object.");
  }

  return value as Record<string, unknown>;
}

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    throw new Error("Expected a YAML array.");
  }

  return value.map(asRecord);
}

function findNamedRecord(records: Array<Record<string, unknown>>, name: string): Record<string, unknown> {
  const record = records.find((candidate) => candidate["name"] === name);
  if (record === undefined) {
    throw new Error(`Expected YAML record named ${name}.`);
  }

  return record;
}

function envVarsByKey(service: Record<string, unknown>): Map<string, Record<string, unknown>> {
  return new Map(
    asRecordArray(service["envVars"]).map((envVar) => [String(envVar["key"]), envVar])
  );
}

function expectIdentitySecretOutput(result: ReturnType<typeof spawnSync>): void {
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  const output = JSON.parse(result.stdout as string) as {
    bytes: number;
    format: string;
    value: string;
    env: string;
  };
  expect(output).toMatchObject({
    bytes: 32,
    format: "base64url",
    env: "WATASU_SERVICE_IDENTITY_SIGNING_SECRET"
  });
  expect(output.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(Buffer.from(output.value, "base64url")).toHaveLength(32);
}

function buildCutoverCanaryEvidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    checked_origin: "https://api.watasu.ai",
    checked_not_found_routes: [
      "https://api.watasu.ai/",
      "https://api.watasu.ai/requests/__watasu%2Fcanary__/agent-card.json"
    ],
    checked_method_boundaries: [
      {
        url: "https://api.watasu.ai/.well-known/oauth-protected-resource",
        allowed_methods: ["GET"],
        rejected_methods: ["POST"]
      }
    ],
    checked_headers: [
      "cache-control",
      "content-security-policy",
      "referrer-policy",
      "x-content-type-options"
    ],
    checked_forbidden_fragments: ["tenant", "ledger", "postgres", "payload", "secret", "WATASU_POSTGRES_URL"],
    checked_timeout_ms: 10_000,
    go_no_go: {
      decision: "go"
    },
    ...overrides
  };
}

function buildCutoverRetentionEvidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    checked_at: "2026-06-15T00:00:00.000Z",
    dry_run: true,
    retention_days: 90,
    tenant_id: "watasu-private-alpha",
    scanned: 1,
    deleted: 0,
    retained: 1,
    would_delete: 0,
    ...overrides
  };
}

describe("workspace foundation", () => {
  test("test_workspace_scripts_run_typecheck_and_tests", async () => {
    const packageJson = readJson("package.json") as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts).toMatchObject({
      "canary:hosted": "node scripts/hosted-canary.mjs",
      "cutover:canary": "node scripts/production-cutover-canary.mjs",
      "cutover:ci": "node scripts/production-cutover-ci.mjs",
      "cutover:plan": "node scripts/production-cutover-plan.mjs",
      "cutover:prepare": "node scripts/production-cutover-prepare.mjs",
      "cutover:retention": "node scripts/production-cutover-retention.mjs",
      "cutover:repo": "node scripts/production-cutover-repo.mjs",
      "cutover:status": "node scripts/production-cutover-status.mjs",
      "cutover:verify": "node scripts/production-cutover-verify.mjs",
      "demo:handoff": "pnpm typecheck && node scripts/local-handoff-demo.mjs",
      "demo:receiver-csv": "pnpm typecheck && node scripts/local-receiver-csv-demo.mjs",
      "deploy:preflight": "node scripts/render-deploy-preflight.mjs",
      lint: "node scripts/secret-scan.mjs --repo",
      loop: "node scripts/loop-engineer.mjs",
      "loop:full": "node scripts/loop-engineer.mjs --full",
      "pr:draft": "node scripts/create-draft-pr.mjs",
      "review:self": "node scripts/gstack-review-preflight.mjs",
      "render:brief": "node scripts/render-setup-brief.mjs",
      "secret:identity": "node scripts/generate-identity-secret.mjs",
      "smoke:hosted": "node scripts/hosted-start-smoke.mjs",
      test: "pnpm typecheck && vitest run",
      typecheck:
        "tsc -b packages/core packages/cli packages/fixtures packages/http packages/mcp packages/hosted packages/personal-info-adapter"
    });
  });

  test("test_package_exports_core_cli_fixtures_and_adapter_packages", async () => {
    const corePackageJson = readJson("packages/core/package.json") as {
      exports: Record<string, string>;
    };
    const cliPackageJson = readJson("packages/cli/package.json") as {
      bin: Record<string, string>;
      exports: Record<string, string>;
      scripts: Record<string, string>;
    };
    const fixturesPackageJson = readJson("packages/fixtures/package.json") as {
      exports: Record<string, string>;
    };
    const httpPackageJson = readJson("packages/http/package.json") as {
      exports: Record<string, string>;
    };
    const mcpPackageJson = readJson("packages/mcp/package.json") as {
      exports: Record<string, string>;
    };
    const hostedPackageJson = readJson("packages/hosted/package.json") as {
      exports: Record<string, string>;
    };
    const personalInfoAdapterPackageJson = readJson(
      "packages/personal-info-adapter/package.json"
    ) as {
      bin: Record<string, string>;
      exports: Record<string, string>;
      scripts: Record<string, string>;
    };

    expect(corePackageJson.exports).toHaveProperty(".");
    expect(cliPackageJson.exports).toHaveProperty(".");
    expect(cliPackageJson.bin).toEqual({ watasu: "./dist/bin.js" });
    expect(cliPackageJson.scripts).toHaveProperty(
      "watasu",
      "pnpm --dir ../.. typecheck && node dist/bin.js"
    );
    expect(fixturesPackageJson.exports).toHaveProperty(".");
    expect(httpPackageJson.exports).toHaveProperty(".");
    expect(mcpPackageJson.exports).toHaveProperty(".");
    expect(hostedPackageJson.exports).toHaveProperty(".");
    expect(personalInfoAdapterPackageJson.exports).toHaveProperty(".");
    expect(personalInfoAdapterPackageJson.bin).toEqual({
      "watasu-personal-info-adapter": "./dist/bin.js"
    });
    expect(personalInfoAdapterPackageJson.scripts).toHaveProperty(
      "dry-run",
      "pnpm --dir ../.. typecheck && node dist/bin.js dry-run"
    );
    expect(personalInfoAdapterPackageJson.scripts).toHaveProperty(
      "submit",
      "pnpm --dir ../.. typecheck && node dist/bin.js submit"
    );
  });

  test("test_no_env_files_or_secret_like_values_are_committed", () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "watasu-secret-scan-"));
    writeFileSync(join(fixtureDir, "safe.md"), "API key guidance without a value is safe.");

    expect(findSecretLikeValues(fixtureDir)).toEqual([]);
  });

  test("secret_scan_reports_env_files_and_secret_like_assignments", () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "watasu-secret-scan-"));
    writeFileSync(join(fixtureDir, ".env"), "TOKEN=not-used-in-repo\n");
    const keyName = ["api", "key"].join("_");
    const fakeValue = "abcdefghijklmnopqrstuvwxyz" + "123456";
    writeFileSync(join(fixtureDir, "config.txt"), `${keyName} = ${fakeValue}\n`);

    expect(findSecretLikeValues(fixtureDir)).toEqual([
      {
        path: ".env",
        reason: "env files must not be committed"
      },
      {
        path: "config.txt",
        reason: "secret-like assignment detected"
      }
    ]);
  });

  test("test_identity_secret_generator_outputs_32_byte_base64url_secret", () => {
    const direct = spawnSync(process.execPath, ["scripts/generate-identity-secret.mjs"], {
      cwd: rootDir,
      encoding: "utf8"
    });
    const viaPnpm = spawnSync("pnpm", ["--silent", "secret:identity"], {
      cwd: rootDir,
      encoding: "utf8"
    });

    expectIdentitySecretOutput(direct);
    expectIdentitySecretOutput(viaPnpm);
  });

  test("test_identity_secret_generator_plain_output_is_secret_value_only", () => {
    const direct = spawnSync(process.execPath, ["scripts/generate-identity-secret.mjs", "--plain"], {
      cwd: rootDir,
      encoding: "utf8"
    });
    const viaPnpm = spawnSync("pnpm", ["--silent", "secret:identity", "--plain"], {
      cwd: rootDir,
      encoding: "utf8"
    });

    for (const result of [direct, viaPnpm]) {
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toMatch(/^[A-Za-z0-9_-]{43}\n$/);
      expect(Buffer.from(result.stdout.trim(), "base64url")).toHaveLength(32);
    }
  });

  test("test_identity_secret_generator_rejects_unknown_arguments", () => {
    const result = spawnSync(process.execPath, ["scripts/generate-identity-secret.mjs", "--bad"], {
      cwd: rootDir,
      encoding: "utf8"
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Usage: pnpm --silent secret:identity [--plain]");
  });

  test("test_render_deploy_preflight_reports_repo_side_readiness_without_secrets", () => {
    const result = spawnSync("pnpm", ["--silent", "deploy:preflight"], {
      cwd: rootDir,
      encoding: "utf8"
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      checked_domain: string;
      checked_render_services: string[];
      checked_runtime_commands: string[];
      checked_secret_command: string;
      remaining_external_actions: string[];
    };
    expect(report).toMatchObject({
      ok: true,
      checked_domain: "api.watasu.ai",
      checked_render_services: ["watasu-hosted", "watasu-metadata-retention", "watasu-metadata"],
      checked_runtime_commands: [
        "pnpm --filter @watasu/hosted start",
        "pnpm --filter @watasu/hosted retention"
      ],
      checked_secret_command: "pnpm --silent secret:identity --plain"
    });
    expect(report.remaining_external_actions).toEqual([
      "Render workspace and billing enabled",
      "GitHub repository connected to Render",
      "Render secret value entered",
      "api.watasu.ai DNS and TLS verified",
      "post-deploy hosted canary passed"
    ]);
    expect(result.stdout).not.toContain("WATASU_POSTGRES_URL=");
    expect(result.stdout).not.toContain("WATASU_SERVICE_IDENTITY_SIGNING_SECRET=");
  });

  test("test_render_setup_brief_reports_account_steps_without_secret_values", () => {
    const result = spawnSync("pnpm", ["--silent", "render:brief"], {
      cwd: rootDir,
      encoding: "utf8"
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      target_domain: string;
      render_services: string[];
      render_database: string;
      secret_command: string;
      manual_secret_names: string[];
      dns_origin: string;
      external_actions: string[];
      status_command: string;
      before_render_commands: string[];
      after_render_commands: string[];
    };
    expect(report).toMatchObject({
      ok: true,
      target_domain: "api.watasu.ai",
      render_services: ["watasu-hosted", "watasu-metadata-retention"],
      render_database: "watasu-metadata",
      secret_command: "pnpm --silent secret:identity --plain",
      status_command: "pnpm --silent cutover:status",
      manual_secret_names: ["WATASU_SERVICE_IDENTITY_SIGNING_SECRET", "WATASU_MCP_BEARER_TOKEN"],
      dns_origin: "https://api.watasu.ai",
      before_render_commands: [
        "pnpm --silent cutover:repo",
        "pnpm --silent cutover:status",
        "pnpm --silent secret:identity --plain"
      ],
      after_render_commands: [
        "pnpm --silent cutover:status",
        "pnpm --silent cutover:canary",
        "pnpm --silent cutover:retention",
        "pnpm --silent cutover:verify"
      ]
    });
    expect(report.external_actions).toContain("Create the Render Blueprint from render.yaml.");
    expect(report.external_actions).toContain("Run pnpm --silent cutover:status before and after Render setup.");
    expect(result.stdout).not.toContain("WATASU_SERVICE_IDENTITY_SIGNING_SECRET=");
    expect(result.stdout).not.toContain("WATASU_POSTGRES_URL=");
    expect(result.stdout).not.toContain("postgres://");
  });

  test("test_hosted_start_smoke_runs_compiled_entrypoint_and_health_check", () => {
    const result = spawnSync("pnpm", ["--silent", "smoke:hosted"], {
      cwd: rootDir,
      encoding: "utf8",
      timeout: 20_000
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      checked_command: string;
      checked_mode: string;
      checked_url: string;
      checked_status: number;
      checked_body: unknown;
    };
    expect(report).toMatchObject({
      ok: true,
      checked_command: "pnpm --filter @watasu/hosted start",
      checked_mode: "closed_server_health_request",
      checked_status: 200,
      checked_body: {
        ok: true,
        service: "watasu-hosted"
      }
    });
    expect(report.checked_url).toBe("http://127.0.0.1:1/health");
    expect(result.stdout).not.toContain("WATASU_SERVICE_IDENTITY_SIGNING_SECRET=");
  });

  test("test_production_cutover_prepare_writes_secret_safe_local_evidence", () => {
    const evidenceDir = mkdtempSync(join(tmpdir(), "watasu-cutover-prepare-"));

    const result = spawnSync("pnpm", ["--silent", "cutover:prepare", "--dir", evidenceDir], {
      cwd: rootDir,
      encoding: "utf8",
      timeout: 20_000
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      evidence_dir: string;
      checked_head_sha: string;
      wrote: string[];
    };
    expect(report).toMatchObject({
      ok: true,
      evidence_dir: evidenceDir,
      wrote: [
        join(evidenceDir, "cutover-head.txt"),
        join(evidenceDir, "preflight.json"),
        join(evidenceDir, "smoke.json")
      ]
    });
    expect(report.checked_head_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(readFileSync(join(evidenceDir, "cutover-head.txt"), "utf8").trim()).toBe(report.checked_head_sha);
    expect(JSON.parse(readFileSync(join(evidenceDir, "preflight.json"), "utf8"))).toMatchObject({
      ok: true,
      checked_domain: "api.watasu.ai"
    });
    expect(JSON.parse(readFileSync(join(evidenceDir, "smoke.json"), "utf8"))).toMatchObject({
      ok: true,
      checked_status: 200
    });
    expect(result.stdout).not.toContain("WATASU_POSTGRES_URL=");
    expect(result.stdout).not.toContain("WATASU_SERVICE_IDENTITY_SIGNING_SECRET=");
    expect(result.stdout).not.toContain("WATASU_MCP_BEARER_TOKEN=");
  });

  test("test_production_cutover_ci_writes_matching_head_evidence", () => {
    const evidenceDir = mkdtempSync(join(tmpdir(), "watasu-cutover-ci-"));
    const sourcePath = join(evidenceDir, "gh-runs.json");
    writeFileSync(join(evidenceDir, "cutover-head.txt"), `${expectedCutoverHeadSha}\n`);
    writeFileSync(sourcePath, JSON.stringify([
      {
        workflowName: "ci",
        status: "completed",
        conclusion: "success",
        headSha: expectedCutoverHeadSha,
        url: "https://github.com/sota009/watasu/actions/runs/1",
        createdAt: "2026-06-15T00:00:00Z"
      }
    ]));

    const result = spawnSync("pnpm", [
      "--silent",
      "cutover:ci",
      "--dir",
      evidenceDir,
      "--source",
      sourcePath
    ], {
      cwd: rootDir,
      encoding: "utf8"
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      checked_head_sha: string;
      wrote: string;
    };
    expect(report).toMatchObject({
      ok: true,
      checked_head_sha: expectedCutoverHeadSha,
      wrote: join(evidenceDir, "ci.json")
    });
    expect(JSON.parse(readFileSync(join(evidenceDir, "ci.json"), "utf8"))).toMatchObject({
      workflowName: "ci",
      status: "completed",
      conclusion: "success",
      headSha: expectedCutoverHeadSha
    });
    expect(result.stdout).not.toContain("GITHUB_TOKEN=");
  });

  test("test_production_cutover_repo_refreshes_prepare_and_ci_evidence", () => {
    const evidenceDir = mkdtempSync(join(tmpdir(), "watasu-cutover-repo-"));
    const sourcePath = join(evidenceDir, "gh-runs.json");
    const currentHead = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: rootDir,
      encoding: "utf8"
    }).stdout.trim();
    writeFileSync(sourcePath, JSON.stringify([
      {
        workflowName: "ci",
        status: "completed",
        conclusion: "success",
        headSha: currentHead,
        url: "https://github.com/sota009/watasu/actions/runs/1",
        createdAt: "2026-06-15T00:00:00Z"
      }
    ]));

    const result = spawnSync("pnpm", [
      "--silent",
      "cutover:repo",
      "--dir",
      evidenceDir,
      "--ci-source",
      sourcePath
    ], {
      cwd: rootDir,
      encoding: "utf8",
      timeout: 20_000
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      checked_head_sha: string;
      wrote: string[];
      next_commands: string[];
    };
    expect(report).toMatchObject({
      ok: true,
      checked_head_sha: currentHead,
      wrote: [
        join(evidenceDir, "cutover-head.txt"),
        join(evidenceDir, "preflight.json"),
        join(evidenceDir, "smoke.json"),
        join(evidenceDir, "ci.json")
      ],
      next_commands: [
        "pnpm --silent cutover:canary",
        "pnpm --silent cutover:retention"
      ]
    });
    expect(JSON.parse(readFileSync(join(evidenceDir, "ci.json"), "utf8"))).toMatchObject({
      workflowName: "ci",
      conclusion: "success",
      headSha: currentHead
    });
    expect(result.stdout).not.toContain("WATASU_POSTGRES_URL=");
  });

  test("test_production_cutover_canary_writes_secret_safe_evidence", () => {
    const evidenceDir = mkdtempSync(join(tmpdir(), "watasu-cutover-canary-"));
    const sourcePath = join(evidenceDir, "canary-source.json");
    writeFileSync(sourcePath, JSON.stringify(buildCutoverCanaryEvidence()));

    const result = spawnSync("pnpm", [
      "--silent",
      "cutover:canary",
      "--dir",
      evidenceDir,
      "--source",
      sourcePath
    ], {
      cwd: rootDir,
      encoding: "utf8"
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      checked_origin: string;
      wrote: string;
    };
    expect(report).toMatchObject({
      ok: true,
      checked_origin: "https://api.watasu.ai",
      wrote: join(evidenceDir, "canary.json")
    });
    expect(JSON.parse(readFileSync(join(evidenceDir, "canary.json"), "utf8"))).toMatchObject({
      ok: true,
      checked_origin: "https://api.watasu.ai",
      go_no_go: {
        decision: "go"
      }
    });
    expect(result.stdout).not.toContain("WATASU_POSTGRES_URL=");
  });

  test("test_production_cutover_canary_rejects_secret_like_evidence", () => {
    const evidenceDir = mkdtempSync(join(tmpdir(), "watasu-cutover-canary-"));
    const sourcePath = join(evidenceDir, "canary-source.json");
    writeFileSync(sourcePath, `${JSON.stringify(buildCutoverCanaryEvidence())}\nWATASU_POSTGRES_URL=postgres://example\n`);

    const result = spawnSync("pnpm", [
      "--silent",
      "cutover:canary",
      "--dir",
      evidenceDir,
      "--source",
      sourcePath
    ], {
      cwd: rootDir,
      encoding: "utf8"
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("contains secret-like assignment output");
  });

  test("test_production_cutover_retention_writes_secret_safe_evidence", () => {
    const evidenceDir = mkdtempSync(join(tmpdir(), "watasu-cutover-retention-"));
    const sourcePath = join(evidenceDir, "retention-source.json");
    writeFileSync(sourcePath, JSON.stringify(buildCutoverRetentionEvidence()));

    const result = spawnSync("pnpm", [
      "--silent",
      "cutover:retention",
      "--dir",
      evidenceDir,
      "--source",
      sourcePath
    ], {
      cwd: rootDir,
      encoding: "utf8"
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      dry_run: boolean;
      wrote: string;
    };
    expect(report).toMatchObject({
      ok: true,
      dry_run: true,
      wrote: join(evidenceDir, "retention.json")
    });
    expect(JSON.parse(readFileSync(join(evidenceDir, "retention.json"), "utf8"))).toMatchObject({
      ok: true,
      dry_run: true,
      tenant_id: "watasu-private-alpha"
    });
    expect(result.stdout).not.toContain("WATASU_POSTGRES_URL=");
  });

  test("test_production_cutover_retention_rejects_secret_like_evidence", () => {
    const evidenceDir = mkdtempSync(join(tmpdir(), "watasu-cutover-retention-"));
    const sourcePath = join(evidenceDir, "retention-source.json");
    writeFileSync(sourcePath, `${JSON.stringify(buildCutoverRetentionEvidence())}\nWATASU_POSTGRES_URL=postgres://example\n`);

    const result = spawnSync("pnpm", [
      "--silent",
      "cutover:retention",
      "--dir",
      evidenceDir,
      "--source",
      sourcePath
    ], {
      cwd: rootDir,
      encoding: "utf8"
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("contains secret-like assignment output");
  });

  test("test_production_cutover_plan_outputs_ordered_secret_safe_commands", () => {
    const result = spawnSync("pnpm", ["--silent", "cutover:plan"], {
      cwd: rootDir,
      encoding: "utf8"
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      target_origin: string;
      before_render_commands: string[];
      after_deploy_commands: string[];
      external_actions: string[];
      required_evidence: string[];
    };
    expect(report).toMatchObject({
      ok: true,
      target_origin: "https://api.watasu.ai",
      before_render_commands: [
        "pnpm --silent cutover:repo",
        "pnpm --silent cutover:status",
        "pnpm --silent secret:identity --plain"
      ],
      after_deploy_commands: [
        "pnpm --silent cutover:ci",
        "pnpm --silent cutover:canary",
        "pnpm --silent cutover:retention",
        "pnpm --silent cutover:verify"
      ]
    });
    expect(report.external_actions).toContain("Verify api.watasu.ai DNS and TLS in Render.");
    expect(report.required_evidence).toEqual([
      "cutover-evidence/cutover-head.txt records the deployed commit SHA",
      "deploy:preflight ok=true",
      "smoke:hosted checked_status=200",
      "GitHub Actions CI green on the cutover head",
      "canary checked_origin=https://api.watasu.ai",
      "canary checked_not_found_routes present",
      "canary checked_method_boundaries present",
      "canary checked_headers present",
      "canary checked_forbidden_fragments present",
      "canary checked_timeout_ms present",
      "retention checked_at present",
      "retention dry_run=true",
      "retention row counts present",
      "no payload body retained or printed"
    ]);
    expect(result.stdout).not.toContain("WATASU_POSTGRES_URL=");
    expect(result.stdout).not.toContain("WATASU_SERVICE_IDENTITY_SIGNING_SECRET=");
  });

  test("test_production_cutover_status_reports_missing_evidence_and_next_commands", () => {
    const evidenceDir = mkdtempSync(join(tmpdir(), "watasu-cutover-status-"));
    writeFileSync(join(evidenceDir, "cutover-head.txt"), `${expectedCutoverHeadSha}\n`);
    writeFileSync(join(evidenceDir, "preflight.json"), JSON.stringify({
      ok: true
    }));
    writeFileSync(join(evidenceDir, "smoke.json"), JSON.stringify({
      ok: true
    }));

    const result = spawnSync("pnpm", [
      "--silent",
      "cutover:status",
      "--dir",
      evidenceDir,
      "--head",
      expectedCutoverHeadSha
    ], {
      cwd: rootDir,
      encoding: "utf8"
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      ready_for_verify: boolean;
      present_evidence: string[];
      missing_evidence: string[];
      next_commands: string[];
      remaining_external_actions: string[];
    };
    expect(report).toMatchObject({
      ok: true,
      ready_for_verify: false,
      present_evidence: ["cutover-head", "preflight", "smoke"],
      missing_evidence: ["ci", "canary", "retention"],
      next_commands: [
        "pnpm --silent cutover:ci",
        "pnpm --silent cutover:canary",
        "pnpm --silent cutover:retention"
      ]
    });
    expect(report.remaining_external_actions).toContain("Verify api.watasu.ai DNS and TLS in Render.");
    expect(result.stdout).not.toContain("WATASU_POSTGRES_URL=");
  });

  test("test_production_cutover_status_reports_prepare_first_without_local_evidence", () => {
    const evidenceDir = mkdtempSync(join(tmpdir(), "watasu-cutover-status-"));

    const result = spawnSync("pnpm", [
      "--silent",
      "cutover:status",
      "--dir",
      evidenceDir,
      "--head",
      expectedCutoverHeadSha
    ], {
      cwd: rootDir,
      encoding: "utf8"
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      ready_for_verify: false,
      present_evidence: [],
      missing_evidence: ["cutover-head", "preflight", "smoke", "ci", "canary", "retention"],
      next_commands: ["pnpm --silent cutover:prepare"]
    });
  });

  test("test_production_cutover_status_reports_ready_when_all_evidence_exists", () => {
    const evidenceDir = mkdtempSync(join(tmpdir(), "watasu-cutover-status-"));
    for (const name of ["cutover-head.txt", "preflight.json", "smoke.json", "ci.json", "canary.json", "retention.json"]) {
      writeFileSync(join(evidenceDir, name), name === "cutover-head.txt" ? `${expectedCutoverHeadSha}\n` : "{\"ok\":true}\n");
    }

    const result = spawnSync("pnpm", [
      "--silent",
      "cutover:status",
      "--dir",
      evidenceDir,
      "--head",
      expectedCutoverHeadSha
    ], {
      cwd: rootDir,
      encoding: "utf8"
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      ready_for_verify: true,
      head_matches_current: true,
      missing_evidence: [],
      next_commands: ["pnpm --silent cutover:verify"],
      remaining_external_actions: []
    });
  });

  test("test_production_cutover_status_reports_stale_head_evidence", () => {
    const evidenceDir = mkdtempSync(join(tmpdir(), "watasu-cutover-status-"));
    const staleHeadSha = "fedcba9876543210fedcba9876543210fedcba98";
    for (const name of ["cutover-head.txt", "preflight.json", "smoke.json", "ci.json", "canary.json", "retention.json"]) {
      writeFileSync(join(evidenceDir, name), name === "cutover-head.txt" ? `${staleHeadSha}\n` : "{\"ok\":true}\n");
    }

    const result = spawnSync("pnpm", [
      "--silent",
      "cutover:status",
      "--dir",
      evidenceDir,
      "--head",
      expectedCutoverHeadSha
    ], {
      cwd: rootDir,
      encoding: "utf8"
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      ready_for_verify: false,
      checked_head_sha: staleHeadSha,
      current_head_sha: expectedCutoverHeadSha,
      head_matches_current: false,
      stale_evidence: ["cutover-head", "preflight", "smoke", "ci", "canary", "retention"],
      next_commands: ["pnpm --silent cutover:prepare"]
    });
  });

  test("test_cutover_evidence_directory_is_gitignored", () => {
    const gitignore = readText(".gitignore");

    expect(gitignore).toContain("cutover-evidence/");
  });

  test("test_japanese_readme_includes_production_cutover_commands", () => {
    const japaneseReadme = readText("README.ja.md");

    expect(japaneseReadme).toContain("pnpm --silent deploy:preflight");
    expect(japaneseReadme).toContain("pnpm --silent cutover:plan");
    expect(japaneseReadme).toContain("pnpm --silent cutover:prepare");
    expect(japaneseReadme).toContain("pnpm --silent cutover:repo");
    expect(japaneseReadme).toContain("pnpm --silent cutover:status");
    expect(japaneseReadme).toContain("pnpm --silent cutover:canary");
    expect(japaneseReadme).toContain("pnpm --silent cutover:retention");
    expect(japaneseReadme).toContain("pnpm --silent smoke:hosted");
    expect(japaneseReadme).toContain("pnpm --silent secret:identity --plain");
    expect(japaneseReadme).toContain("cutover-evidence/cutover-head.txt");
    expect(japaneseReadme).toContain("cutover-evidence/preflight.json");
    expect(japaneseReadme).toContain("cutover-evidence/smoke.json");
    expect(japaneseReadme).toContain("pnpm --silent cutover:verify");
    expect(japaneseReadme).not.toContain("pnpm --silent cutover:verify --head");
    expect(japaneseReadme).toContain("cutover-evidence/ci.json");
  });

  test("test_production_cutover_verify_accepts_required_secret_safe_evidence", () => {
    const evidenceDir = mkdtempSync(join(tmpdir(), "watasu-cutover-evidence-"));
    const preflightPath = join(evidenceDir, "preflight.json");
    const smokePath = join(evidenceDir, "smoke.json");
    const canaryPath = join(evidenceDir, "canary.json");
    const retentionPath = join(evidenceDir, "retention.json");
    const ciPath = join(evidenceDir, "ci.json");
    writeFileSync(preflightPath, JSON.stringify({
      ok: true,
      checked_domain: "api.watasu.ai",
      checked_secret_command: "pnpm --silent secret:identity --plain"
    }));
    writeFileSync(smokePath, JSON.stringify({
      ok: true,
      checked_command: "pnpm --filter @watasu/hosted start",
      checked_status: 200
    }));
    writeFileSync(canaryPath, JSON.stringify(buildCutoverCanaryEvidence()));
    writeFileSync(retentionPath, JSON.stringify(buildCutoverRetentionEvidence()));
    writeFileSync(ciPath, JSON.stringify({
      workflowName: "ci",
      status: "completed",
      conclusion: "success",
      headSha: expectedCutoverHeadSha
    }));

    const result = spawnSync("pnpm", [
      "--silent",
      "cutover:verify",
      "--head",
      expectedCutoverHeadSha,
      "--preflight",
      preflightPath,
      "--smoke",
      smokePath,
      "--canary",
      canaryPath,
      "--retention",
      retentionPath,
      "--ci",
      ciPath
    ], {
      cwd: rootDir,
      encoding: "utf8"
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      decision: "go",
      checked_origin: "https://api.watasu.ai",
      checked_head_sha: expectedCutoverHeadSha,
      checked_evidence: ["preflight", "smoke", "canary", "retention", "ci"]
    });
    expect(result.stdout).not.toContain("WATASU_POSTGRES_URL=");
    expect(result.stdout).not.toContain("WATASU_SERVICE_IDENTITY_SIGNING_SECRET=");
  });

  test("test_production_cutover_verify_uses_default_evidence_directory", () => {
    const runDir = mkdtempSync(join(tmpdir(), "watasu-cutover-default-"));
    const evidenceDir = join(runDir, "cutover-evidence");
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(join(evidenceDir, "cutover-head.txt"), `${expectedCutoverHeadSha}\n`);
    writeFileSync(join(evidenceDir, "preflight.json"), JSON.stringify({
      ok: true,
      checked_domain: "api.watasu.ai",
      checked_secret_command: "pnpm --silent secret:identity --plain"
    }));
    writeFileSync(join(evidenceDir, "smoke.json"), JSON.stringify({
      ok: true,
      checked_command: "pnpm --filter @watasu/hosted start",
      checked_status: 200
    }));
    writeFileSync(join(evidenceDir, "canary.json"), JSON.stringify(buildCutoverCanaryEvidence()));
    writeFileSync(join(evidenceDir, "retention.json"), JSON.stringify(buildCutoverRetentionEvidence()));
    writeFileSync(join(evidenceDir, "ci.json"), JSON.stringify({
      workflowName: "ci",
      status: "completed",
      conclusion: "success",
      headSha: expectedCutoverHeadSha
    }));

    const result = spawnSync(process.execPath, [new URL("scripts/production-cutover-verify.mjs", rootDir).pathname], {
      cwd: runDir,
      encoding: "utf8"
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      decision: "go",
      checked_origin: "https://api.watasu.ai",
      checked_head_sha: expectedCutoverHeadSha,
      checked_evidence: ["preflight", "smoke", "canary", "retention", "ci"]
    });
  });

  test("test_production_cutover_verify_rejects_payload_body_evidence", () => {
    const evidenceDir = mkdtempSync(join(tmpdir(), "watasu-cutover-evidence-"));
    const preflightPath = join(evidenceDir, "preflight.json");
    const smokePath = join(evidenceDir, "smoke.json");
    const canaryPath = join(evidenceDir, "canary.json");
    const retentionPath = join(evidenceDir, "retention.json");
    const ciPath = join(evidenceDir, "ci.json");
    writeFileSync(preflightPath, JSON.stringify({
      ok: true,
      checked_domain: "api.watasu.ai",
      checked_secret_command: "pnpm --silent secret:identity --plain"
    }));
    writeFileSync(smokePath, JSON.stringify({
      ok: true,
      checked_command: "pnpm --filter @watasu/hosted start",
      checked_status: 200
    }));
    writeFileSync(canaryPath, JSON.stringify(buildCutoverCanaryEvidence({
      leaked_example: {
        encrypted_payload: "must-not-appear"
      }
    })));
    writeFileSync(retentionPath, JSON.stringify(buildCutoverRetentionEvidence()));
    writeFileSync(ciPath, JSON.stringify({
      workflowName: "ci",
      status: "completed",
      conclusion: "success",
      headSha: expectedCutoverHeadSha
    }));

    const result = spawnSync("pnpm", [
      "--silent",
      "cutover:verify",
      "--head",
      expectedCutoverHeadSha,
      "--preflight",
      preflightPath,
      "--smoke",
      smokePath,
      "--canary",
      canaryPath,
      "--retention",
      retentionPath,
      "--ci",
      ciPath
    ], {
      cwd: rootDir,
      encoding: "utf8"
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("contains payload body evidence");
    expect(result.stderr).not.toContain("must-not-appear");
  });

  test("test_production_cutover_verify_rejects_incomplete_canary_fragment_evidence", () => {
    const evidenceDir = mkdtempSync(join(tmpdir(), "watasu-cutover-evidence-"));
    const preflightPath = join(evidenceDir, "preflight.json");
    const smokePath = join(evidenceDir, "smoke.json");
    const canaryPath = join(evidenceDir, "canary.json");
    const retentionPath = join(evidenceDir, "retention.json");
    const ciPath = join(evidenceDir, "ci.json");
    writeFileSync(preflightPath, JSON.stringify({
      ok: true,
      checked_domain: "api.watasu.ai",
      checked_secret_command: "pnpm --silent secret:identity --plain"
    }));
    writeFileSync(smokePath, JSON.stringify({
      ok: true,
      checked_command: "pnpm --filter @watasu/hosted start",
      checked_status: 200
    }));
    writeFileSync(canaryPath, JSON.stringify(buildCutoverCanaryEvidence({
      checked_forbidden_fragments: ["tenant", "ledger", "postgres", "payload", "WATASU_POSTGRES_URL"]
    })));
    writeFileSync(retentionPath, JSON.stringify(buildCutoverRetentionEvidence()));
    writeFileSync(ciPath, JSON.stringify({
      workflowName: "ci",
      status: "completed",
      conclusion: "success",
      headSha: expectedCutoverHeadSha
    }));

    const result = spawnSync("pnpm", [
      "--silent",
      "cutover:verify",
      "--head",
      expectedCutoverHeadSha,
      "--preflight",
      preflightPath,
      "--smoke",
      smokePath,
      "--canary",
      canaryPath,
      "--retention",
      retentionPath,
      "--ci",
      ciPath
    ], {
      cwd: rootDir,
      encoding: "utf8"
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("hosted canary must record forbidden fragment secret");
  });

  test("test_production_cutover_verify_rejects_incomplete_canary_method_boundary_evidence", () => {
    const evidenceDir = mkdtempSync(join(tmpdir(), "watasu-cutover-evidence-"));
    const preflightPath = join(evidenceDir, "preflight.json");
    const smokePath = join(evidenceDir, "smoke.json");
    const canaryPath = join(evidenceDir, "canary.json");
    const retentionPath = join(evidenceDir, "retention.json");
    const ciPath = join(evidenceDir, "ci.json");
    writeFileSync(preflightPath, JSON.stringify({
      ok: true,
      checked_domain: "api.watasu.ai",
      checked_secret_command: "pnpm --silent secret:identity --plain"
    }));
    writeFileSync(smokePath, JSON.stringify({
      ok: true,
      checked_command: "pnpm --filter @watasu/hosted start",
      checked_status: 200
    }));
    const canaryEvidence = buildCutoverCanaryEvidence();
    delete canaryEvidence["checked_method_boundaries"];
    writeFileSync(canaryPath, JSON.stringify(canaryEvidence));
    writeFileSync(retentionPath, JSON.stringify(buildCutoverRetentionEvidence()));
    writeFileSync(ciPath, JSON.stringify({
      workflowName: "ci",
      status: "completed",
      conclusion: "success",
      headSha: expectedCutoverHeadSha
    }));

    const result = spawnSync("pnpm", [
      "--silent",
      "cutover:verify",
      "--head",
      expectedCutoverHeadSha,
      "--preflight",
      preflightPath,
      "--smoke",
      smokePath,
      "--canary",
      canaryPath,
      "--retention",
      retentionPath,
      "--ci",
      ciPath
    ], {
      cwd: rootDir,
      encoding: "utf8"
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("hosted canary must record protected-resource method boundary evidence");
  });

  test("test_production_cutover_verify_rejects_non_dry_run_retention_evidence", () => {
    const evidenceDir = mkdtempSync(join(tmpdir(), "watasu-cutover-evidence-"));
    const preflightPath = join(evidenceDir, "preflight.json");
    const smokePath = join(evidenceDir, "smoke.json");
    const canaryPath = join(evidenceDir, "canary.json");
    const retentionPath = join(evidenceDir, "retention.json");
    const ciPath = join(evidenceDir, "ci.json");
    writeFileSync(preflightPath, JSON.stringify({
      ok: true,
      checked_domain: "api.watasu.ai",
      checked_secret_command: "pnpm --silent secret:identity --plain"
    }));
    writeFileSync(smokePath, JSON.stringify({
      ok: true,
      checked_command: "pnpm --filter @watasu/hosted start",
      checked_status: 200
    }));
    writeFileSync(canaryPath, JSON.stringify(buildCutoverCanaryEvidence()));
    writeFileSync(retentionPath, JSON.stringify(buildCutoverRetentionEvidence({
      dry_run: false,
      deleted: 1,
      retained: 0,
      would_delete: 1
    })));
    writeFileSync(ciPath, JSON.stringify({
      workflowName: "ci",
      status: "completed",
      conclusion: "success",
      headSha: expectedCutoverHeadSha
    }));

    const result = spawnSync("pnpm", [
      "--silent",
      "cutover:verify",
      "--head",
      expectedCutoverHeadSha,
      "--preflight",
      preflightPath,
      "--smoke",
      smokePath,
      "--canary",
      canaryPath,
      "--retention",
      retentionPath,
      "--ci",
      ciPath
    ], {
      cwd: rootDir,
      encoding: "utf8"
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("retention evidence must be a dry run");
  });

  test("test_production_cutover_verify_rejects_retention_evidence_without_checked_at", () => {
    const evidenceDir = mkdtempSync(join(tmpdir(), "watasu-cutover-evidence-"));
    const preflightPath = join(evidenceDir, "preflight.json");
    const smokePath = join(evidenceDir, "smoke.json");
    const canaryPath = join(evidenceDir, "canary.json");
    const retentionPath = join(evidenceDir, "retention.json");
    const ciPath = join(evidenceDir, "ci.json");
    writeFileSync(preflightPath, JSON.stringify({
      ok: true,
      checked_domain: "api.watasu.ai",
      checked_secret_command: "pnpm --silent secret:identity --plain"
    }));
    writeFileSync(smokePath, JSON.stringify({
      ok: true,
      checked_command: "pnpm --filter @watasu/hosted start",
      checked_status: 200
    }));
    writeFileSync(canaryPath, JSON.stringify(buildCutoverCanaryEvidence()));
    const retentionEvidence = buildCutoverRetentionEvidence();
    delete retentionEvidence["checked_at"];
    writeFileSync(retentionPath, JSON.stringify(retentionEvidence));
    writeFileSync(ciPath, JSON.stringify({
      workflowName: "ci",
      status: "completed",
      conclusion: "success",
      headSha: expectedCutoverHeadSha
    }));

    const result = spawnSync("pnpm", [
      "--silent",
      "cutover:verify",
      "--head",
      expectedCutoverHeadSha,
      "--preflight",
      preflightPath,
      "--smoke",
      smokePath,
      "--canary",
      canaryPath,
      "--retention",
      retentionPath,
      "--ci",
      ciPath
    ], {
      cwd: rootDir,
      encoding: "utf8"
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("retention evidence must include checked_at");
  });

  test("test_production_cutover_verify_rejects_failed_ci_evidence", () => {
    const evidenceDir = mkdtempSync(join(tmpdir(), "watasu-cutover-evidence-"));
    const preflightPath = join(evidenceDir, "preflight.json");
    const smokePath = join(evidenceDir, "smoke.json");
    const canaryPath = join(evidenceDir, "canary.json");
    const retentionPath = join(evidenceDir, "retention.json");
    const ciPath = join(evidenceDir, "ci.json");
    writeFileSync(preflightPath, JSON.stringify({
      ok: true,
      checked_domain: "api.watasu.ai",
      checked_secret_command: "pnpm --silent secret:identity --plain"
    }));
    writeFileSync(smokePath, JSON.stringify({
      ok: true,
      checked_command: "pnpm --filter @watasu/hosted start",
      checked_status: 200
    }));
    writeFileSync(canaryPath, JSON.stringify(buildCutoverCanaryEvidence()));
    writeFileSync(retentionPath, JSON.stringify(buildCutoverRetentionEvidence()));
    writeFileSync(ciPath, JSON.stringify({
      workflowName: "ci",
      status: "completed",
      conclusion: "failure",
      headSha: expectedCutoverHeadSha
    }));

    const result = spawnSync("pnpm", [
      "--silent",
      "cutover:verify",
      "--head",
      expectedCutoverHeadSha,
      "--preflight",
      preflightPath,
      "--smoke",
      smokePath,
      "--canary",
      canaryPath,
      "--retention",
      retentionPath,
      "--ci",
      ciPath
    ], {
      cwd: rootDir,
      encoding: "utf8"
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("CI evidence must include a completed successful ci run");
  });

  test("test_production_cutover_verify_rejects_ci_evidence_for_different_head", () => {
    const evidenceDir = mkdtempSync(join(tmpdir(), "watasu-cutover-evidence-"));
    const preflightPath = join(evidenceDir, "preflight.json");
    const smokePath = join(evidenceDir, "smoke.json");
    const canaryPath = join(evidenceDir, "canary.json");
    const retentionPath = join(evidenceDir, "retention.json");
    const ciPath = join(evidenceDir, "ci.json");
    writeFileSync(preflightPath, JSON.stringify({
      ok: true,
      checked_domain: "api.watasu.ai",
      checked_secret_command: "pnpm --silent secret:identity --plain"
    }));
    writeFileSync(smokePath, JSON.stringify({
      ok: true,
      checked_command: "pnpm --filter @watasu/hosted start",
      checked_status: 200
    }));
    writeFileSync(canaryPath, JSON.stringify(buildCutoverCanaryEvidence()));
    writeFileSync(retentionPath, JSON.stringify(buildCutoverRetentionEvidence()));
    writeFileSync(ciPath, JSON.stringify({
      workflowName: "ci",
      status: "completed",
      conclusion: "success",
      headSha: "89abcdef0123456789abcdef0123456789abcdef"
    }));

    const result = spawnSync("pnpm", [
      "--silent",
      "cutover:verify",
      "--head",
      expectedCutoverHeadSha,
      "--preflight",
      preflightPath,
      "--smoke",
      smokePath,
      "--canary",
      canaryPath,
      "--retention",
      retentionPath,
      "--ci",
      ciPath
    ], {
      cwd: rootDir,
      encoding: "utf8"
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("CI evidence must include a completed successful ci run for the expected head");
  });

  test("test_handoff_demo_outputs_metadata_only_summary", () => {
    const result = spawnSync(process.execPath, ["scripts/local-handoff-demo.mjs"], {
      cwd: rootDir,
      encoding: "utf8"
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("\"ok\": true");
    expect(result.stdout).toContain("\"ledger_contains_payload_body\": false");
    expect(result.stdout).toContain("\"response_contains_plaintext_payload\": false");
    expect(result.stdout).not.toContain("Alice Example");
    expect(result.stdout).not.toContain("alice@example.com");
    expect(result.stdout).not.toContain("base64url-ciphertext");
    expect(result.stdout).not.toContain("\"encrypted_payload\"");
  }, 60_000);

  test("test_receiver_csv_demo_writes_to_ignored_output_directory", () => {
    const rootCsvPath = new URL("collected-submissions.csv", rootDir);
    const outputDirectory = `receiver-demo-output/test-${process.pid}-${Date.now()}`;
    const outputDir = new URL(`${outputDirectory}/`, rootDir);
    const outputCsvPath = `${outputDirectory}/collected-submissions.csv`;
    rmSync(rootCsvPath, { force: true });
    rmSync(outputDir, { force: true, recursive: true });

    const result = spawnSync(process.execPath, ["scripts/local-receiver-csv-demo.mjs"], {
      cwd: rootDir,
      encoding: "utf8",
      env: {
        ...process.env,
        WATASU_RECEIVER_DEMO_OUTPUT_DIR: outputDirectory
      }
    });

    expect(result.status).toBe(0);
    expect(existsSync(rootCsvPath)).toBe(false);
    expect(readText(outputCsvPath)).toBe(
      "full_name,email\nAlice Example,alice@example.com\n"
    );
    expect(result.stdout).toContain(`"output_path": "${outputCsvPath}"`);
    expect(result.stdout).toContain("\"response_contains_plaintext_payload\": false");
    expect(result.stdout).toContain("\"ledger_contains_plaintext_payload\": false");
    expect(result.stdout).not.toContain("Alice Example");
    expect(result.stdout).not.toContain("alice@example.com");
    expect(result.stdout).not.toContain("base64url-ciphertext");

    rmSync(outputDir, { force: true, recursive: true });
  }, 60_000);

  test("test_hosted_submit_readiness_reports_missing_operator_inputs_without_secrets", () => {
    const result = spawnSync("pnpm", ["--silent", "hosted-submit:status"], {
      cwd: rootDir,
      encoding: "utf8",
      env: {
        ...process.env,
        WATASU_HOSTED_SUBMIT_AGENT_CARD_URL: "",
        WATASU_HOSTED_SUBMIT_SCHEMA_URL: "",
        WATASU_HOSTED_SUBMIT_PUBLIC_JWK: "",
        WATASU_HOSTED_SUBMIT_VALUES: ""
      }
    });

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout) as {
      ok: boolean;
      ready: boolean;
      missing_inputs: string[];
      next_command: string;
    };
    expect(output).toMatchObject({
      ok: true,
      ready: false,
      missing_inputs: [
        "WATASU_HOSTED_SUBMIT_AGENT_CARD_URL",
        "WATASU_HOSTED_SUBMIT_SCHEMA_URL",
        "WATASU_HOSTED_SUBMIT_PUBLIC_JWK",
        "WATASU_HOSTED_SUBMIT_VALUES"
      ],
      next_command: "pnpm --silent hosted-submit:status"
    });
    expect(result.stdout).not.toContain("SECRET");
    expect(result.stdout).not.toContain("PRIVATE");
    expect(result.stdout).not.toContain("WATASU_MCP_BEARER_TOKEN");
  });

  test("test_package_json_exposes_hosted_submit_readiness_status_command", () => {
    const packageJson = readJson("package.json") as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts["hosted-submit:status"]).toBe(
      "node scripts/hosted-submit-status.mjs"
    );
  });

  test("test_render_blueprint_uses_reviewable_private_alpha_boundaries", () => {
    const blueprint = asRecord(parseYaml(readFileSync(new URL("render.yaml", rootDir), "utf8")));
    const services = asRecordArray(blueprint["services"]);
    const databases = asRecordArray(blueprint["databases"]);
    const web = findNamedRecord(services, "watasu-hosted");
    const retention = findNamedRecord(services, "watasu-metadata-retention");
    const database = findNamedRecord(databases, "watasu-metadata");
    const webEnv = envVarsByKey(web);
    const retentionEnv = envVarsByKey(retention);

    expect(web).toMatchObject({
      type: "web",
      runtime: "node",
      plan: "starter",
      region: "singapore",
      branch: "main",
      buildCommand: "pnpm install --frozen-lockfile && pnpm typecheck",
      startCommand: "pnpm --filter @watasu/hosted start",
      autoDeployTrigger: "checksPass",
      healthCheckPath: "/health",
      domains: ["api.watasu.ai"]
    });
    expect(webEnv.get("NODE_VERSION")).toMatchObject({ value: "24.14.1" });
    expect(webEnv.get("WATASU_PUBLIC_BASE_URL")).toMatchObject({ value: "https://api.watasu.ai" });
    expect(webEnv.get("WATASU_METADATA_LEDGER_STORE")).toMatchObject({ value: "disabled" });
    expect(webEnv.get("WATASU_SERVICE_IDENTITY_SIGNING_SECRET")).toMatchObject({ sync: false });
    expect(webEnv.get("WATASU_MCP_BEARER_TOKEN")).toMatchObject({ sync: false });
    expect(webEnv.has("WATASU_POSTGRES_URL")).toBe(false);
    expect(webEnv.has("WATASU_RETENTION_TENANT_ID")).toBe(false);

    expect(retention).toMatchObject({
      type: "cron",
      runtime: "node",
      plan: "starter",
      region: "singapore",
      branch: "main",
      schedule: "0 3 * * *",
      buildCommand: "pnpm install --frozen-lockfile && pnpm typecheck",
      startCommand: "pnpm --filter @watasu/hosted retention"
    });
    expect(retentionEnv.get("NODE_VERSION")).toMatchObject({ value: "24.14.1" });
    expect(retentionEnv.get("WATASU_METADATA_LEDGER_STORE")).toMatchObject({ value: "postgres" });
    expect(retentionEnv.has("WATASU_SERVICE_IDENTITY_SIGNING_SECRET")).toBe(false);
    expect(retentionEnv.has("WATASU_IDENTITY_PROVIDER")).toBe(false);
    expect(retentionEnv.has("WATASU_PUBLIC_BASE_URL")).toBe(false);
    expect(retentionEnv.get("WATASU_POSTGRES_SSL")).toMatchObject({ value: "disable" });
    expect(retentionEnv.get("WATASU_POSTGRES_URL")).toMatchObject({
      fromDatabase: {
        name: "watasu-metadata",
        property: "connectionString"
      }
    });
    expect(retentionEnv.get("WATASU_POSTGRES_POOL_MAX")).toMatchObject({ value: "2" });
    expect(retentionEnv.get("WATASU_POSTGRES_RUN_MIGRATIONS")).toMatchObject({ value: "true" });
    expect(retentionEnv.get("WATASU_RETENTION_TENANT_ID")).toMatchObject({ value: "watasu-private-alpha" });
    expect(retentionEnv.get("WATASU_METADATA_RETENTION_DAYS")).toMatchObject({ value: "90" });
    expect(retentionEnv.get("WATASU_RETENTION_DRY_RUN")).toMatchObject({ value: "true" });

    expect(database).toMatchObject({
      region: "singapore",
      plan: "basic-256mb",
      databaseName: "watasu",
      user: "watasu_app",
      ipAllowList: []
    });
  });

  test("test_private_alpha_plan_matches_render_postgres_pool_limit", () => {
    const plan = readFileSync(new URL("docs/mvp-plan.md", rootDir), "utf8");

    expect(plan).toContain("`WATASU_POSTGRES_POOL_MAX=2`");
    expect(plan).not.toContain("`WATASU_POSTGRES_POOL_MAX=5`");
  });

  test("test_private_alpha_plan_records_hosted_canary_timeout_evidence", () => {
    const plan = readFileSync(new URL("docs/mvp-plan.md", rootDir), "utf8");

    expect(plan).toContain("`checked_timeout_ms`");
  });

  test("test_ci_workflow_runs_loop_with_read_only_permissions", () => {
    const ciYaml = readFileSync(new URL(".github/workflows/ci.yml", rootDir), "utf8");

    expect(ciYaml).toContain("permissions:");
    expect(ciYaml).toContain("contents: read");
    expect(ciYaml).toContain("pull_request:");
    expect(ciYaml).not.toContain("pull_request_target");
    expect(ciYaml).toContain("actions/checkout@9f698171ed81b15d1823a05fc7211befd50c8ae0");
    expect(ciYaml).toContain("persist-credentials: false");
    expect(ciYaml).toContain("actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e");
    expect(ciYaml).toContain("node-version: 24.14.1");
    expect(ciYaml).toContain("pnpm install --frozen-lockfile");
    expect(ciYaml).toContain("pnpm loop");
    expect(ciYaml).toContain("pnpm audit --audit-level moderate");
  });
});
