import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parse as parseYaml } from "yaml";
import { findSecretLikeValues } from "../../../scripts/secret-scan.mjs";

const rootDir = new URL("../../../", import.meta.url);

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(new URL(path, rootDir), "utf8"));
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

describe("workspace foundation", () => {
  test("test_workspace_scripts_run_typecheck_and_tests", async () => {
    const packageJson = readJson("package.json") as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts).toMatchObject({
      "canary:hosted": "node scripts/hosted-canary.mjs",
      "cutover:plan": "node scripts/production-cutover-plan.mjs",
      "cutover:verify": "node scripts/production-cutover-verify.mjs",
      "demo:handoff": "pnpm typecheck && node scripts/local-handoff-demo.mjs",
      "deploy:preflight": "node scripts/render-deploy-preflight.mjs",
      lint: "node scripts/secret-scan.mjs --repo",
      loop: "node scripts/loop-engineer.mjs",
      "loop:full": "node scripts/loop-engineer.mjs --full",
      "pr:draft": "node scripts/create-draft-pr.mjs",
      "review:self": "node scripts/gstack-review-preflight.mjs",
      "secret:identity": "node scripts/generate-identity-secret.mjs",
      "smoke:hosted": "node scripts/hosted-start-smoke.mjs",
      test: "pnpm typecheck && vitest run",
      typecheck: "tsc -b packages/core packages/cli packages/fixtures packages/http packages/mcp packages/hosted"
    });
  });

  test("test_package_exports_core_cli_and_fixtures_packages", async () => {
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
        "pnpm --silent deploy:preflight",
        "pnpm --silent smoke:hosted",
        "pnpm --silent secret:identity --plain"
      ],
      after_deploy_commands: [
        "gh run list --workflow ci --branch main --limit 1 --json workflowName,status,conclusion,headSha,url,createdAt > ci.json",
        "pnpm canary:hosted -- https://api.watasu.ai",
        "pnpm --filter @watasu/hosted retention -- --dry-run"
      ]
    });
    expect(report.external_actions).toContain("Verify api.watasu.ai DNS and TLS in Render.");
    expect(report.required_evidence).toEqual([
      "deploy:preflight ok=true",
      "smoke:hosted checked_status=200",
      "GitHub Actions CI green on deployed commit",
      "canary checked_origin=https://api.watasu.ai",
      "canary checked_forbidden_fragments present",
      "retention dry_run=true",
      "no payload body retained or printed"
    ]);
    expect(result.stdout).not.toContain("WATASU_POSTGRES_URL=");
    expect(result.stdout).not.toContain("WATASU_SERVICE_IDENTITY_SIGNING_SECRET=");
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
    writeFileSync(canaryPath, JSON.stringify({
      ok: true,
      checked_origin: "https://api.watasu.ai",
      checked_forbidden_fragments: ["tenant", "ledger", "postgres", "payload", "secret", "WATASU_POSTGRES_URL"],
      go_no_go: {
        decision: "go"
      }
    }));
    writeFileSync(retentionPath, JSON.stringify({
      ok: true,
      dry_run: true,
      retention_days: 90,
      tenant_id: "watasu-private-alpha",
      would_delete: 0
    }));
    writeFileSync(ciPath, JSON.stringify({
      workflowName: "ci",
      status: "completed",
      conclusion: "success",
      headSha: "0123456789abcdef0123456789abcdef01234567"
    }));

    const result = spawnSync("pnpm", [
      "--silent",
      "cutover:verify",
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
      checked_evidence: ["preflight", "smoke", "canary", "retention", "ci"]
    });
    expect(result.stdout).not.toContain("WATASU_POSTGRES_URL=");
    expect(result.stdout).not.toContain("WATASU_SERVICE_IDENTITY_SIGNING_SECRET=");
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
    writeFileSync(canaryPath, JSON.stringify({
      ok: true,
      checked_origin: "https://api.watasu.ai",
      checked_forbidden_fragments: ["tenant", "ledger", "postgres", "payload", "secret", "WATASU_POSTGRES_URL"],
      leaked_example: {
        encrypted_payload: "must-not-appear"
      },
      go_no_go: {
        decision: "go"
      }
    }));
    writeFileSync(retentionPath, JSON.stringify({
      ok: true,
      dry_run: true,
      retention_days: 90,
      tenant_id: "watasu-private-alpha",
      would_delete: 0
    }));
    writeFileSync(ciPath, JSON.stringify({
      workflowName: "ci",
      status: "completed",
      conclusion: "success",
      headSha: "0123456789abcdef0123456789abcdef01234567"
    }));

    const result = spawnSync("pnpm", [
      "--silent",
      "cutover:verify",
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
    writeFileSync(canaryPath, JSON.stringify({
      ok: true,
      checked_origin: "https://api.watasu.ai",
      checked_forbidden_fragments: ["tenant", "ledger", "postgres", "payload", "WATASU_POSTGRES_URL"],
      go_no_go: {
        decision: "go"
      }
    }));
    writeFileSync(retentionPath, JSON.stringify({
      ok: true,
      dry_run: true,
      retention_days: 90,
      tenant_id: "watasu-private-alpha",
      would_delete: 0
    }));
    writeFileSync(ciPath, JSON.stringify({
      workflowName: "ci",
      status: "completed",
      conclusion: "success",
      headSha: "0123456789abcdef0123456789abcdef01234567"
    }));

    const result = spawnSync("pnpm", [
      "--silent",
      "cutover:verify",
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
    writeFileSync(canaryPath, JSON.stringify({
      ok: true,
      checked_origin: "https://api.watasu.ai",
      checked_forbidden_fragments: ["tenant", "ledger", "postgres", "payload", "secret", "WATASU_POSTGRES_URL"],
      go_no_go: {
        decision: "go"
      }
    }));
    writeFileSync(retentionPath, JSON.stringify({
      ok: true,
      dry_run: false,
      retention_days: 90,
      tenant_id: "watasu-private-alpha",
      deleted: 1,
      would_delete: 1
    }));
    writeFileSync(ciPath, JSON.stringify({
      workflowName: "ci",
      status: "completed",
      conclusion: "success",
      headSha: "0123456789abcdef0123456789abcdef01234567"
    }));

    const result = spawnSync("pnpm", [
      "--silent",
      "cutover:verify",
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
    writeFileSync(canaryPath, JSON.stringify({
      ok: true,
      checked_origin: "https://api.watasu.ai",
      checked_forbidden_fragments: ["tenant", "ledger", "postgres", "payload", "secret", "WATASU_POSTGRES_URL"],
      go_no_go: {
        decision: "go"
      }
    }));
    writeFileSync(retentionPath, JSON.stringify({
      ok: true,
      dry_run: true,
      retention_days: 90,
      tenant_id: "watasu-private-alpha",
      would_delete: 0
    }));
    writeFileSync(ciPath, JSON.stringify({
      workflowName: "ci",
      status: "completed",
      conclusion: "failure",
      headSha: "0123456789abcdef0123456789abcdef01234567"
    }));

    const result = spawnSync("pnpm", [
      "--silent",
      "cutover:verify",
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
      buildCommand: "corepack enable && pnpm install --frozen-lockfile && pnpm typecheck",
      startCommand: "pnpm --filter @watasu/hosted start",
      autoDeployTrigger: "checksPass",
      healthCheckPath: "/health",
      domains: ["api.watasu.ai"]
    });
    expect(webEnv.get("NODE_VERSION")).toMatchObject({ value: "24.14.1" });
    expect(webEnv.get("WATASU_PUBLIC_BASE_URL")).toMatchObject({ value: "https://api.watasu.ai" });
    expect(webEnv.get("WATASU_METADATA_LEDGER_STORE")).toMatchObject({ value: "disabled" });
    expect(webEnv.get("WATASU_SERVICE_IDENTITY_SIGNING_SECRET")).toMatchObject({ sync: false });
    expect(webEnv.has("WATASU_POSTGRES_URL")).toBe(false);
    expect(webEnv.has("WATASU_RETENTION_TENANT_ID")).toBe(false);

    expect(retention).toMatchObject({
      type: "cron",
      runtime: "node",
      plan: "starter",
      region: "singapore",
      branch: "main",
      schedule: "0 3 * * *",
      buildCommand: "corepack enable && pnpm install --frozen-lockfile && pnpm typecheck",
      startCommand: "pnpm --filter @watasu/hosted retention"
    });
    expect(retentionEnv.get("NODE_VERSION")).toMatchObject({ value: "24.14.1" });
    expect(retentionEnv.get("WATASU_METADATA_LEDGER_STORE")).toMatchObject({ value: "postgres" });
    expect(retentionEnv.has("WATASU_SERVICE_IDENTITY_SIGNING_SECRET")).toBe(false);
    expect(retentionEnv.has("WATASU_IDENTITY_PROVIDER")).toBe(false);
    expect(retentionEnv.has("WATASU_PUBLIC_BASE_URL")).toBe(false);
    expect(retentionEnv.get("WATASU_POSTGRES_SSL")).toMatchObject({ value: "require" });
    expect(retentionEnv.get("WATASU_POSTGRES_URL")).toMatchObject({
      fromDatabase: {
        name: "watasu-metadata",
        property: "connectionString"
      }
    });
    expect(retentionEnv.get("WATASU_POSTGRES_POOL_MAX")).toMatchObject({ value: "2" });

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
