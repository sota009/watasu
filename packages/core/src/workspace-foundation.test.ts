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

describe("workspace foundation", () => {
  test("test_workspace_scripts_run_typecheck_and_tests", async () => {
    const packageJson = readJson("package.json") as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts).toMatchObject({
      "canary:hosted": "node scripts/hosted-canary.mjs",
      "demo:handoff": "pnpm typecheck && node scripts/local-handoff-demo.mjs",
      lint: "node scripts/secret-scan.mjs --repo",
      "pr:draft": "node scripts/create-draft-pr.mjs",
      "review:self": "node scripts/gstack-review-preflight.mjs",
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
    expect(retentionEnv.get("WATASU_POSTGRES_SSL")).toMatchObject({ value: "require" });
    expect(retentionEnv.get("WATASU_POSTGRES_URL")).toMatchObject({
      fromDatabase: {
        name: "watasu-metadata",
        property: "connectionString"
      }
    });

    expect(database).toMatchObject({
      region: "singapore",
      plan: "basic-256mb",
      databaseName: "watasu",
      user: "watasu_app",
      ipAllowList: []
    });
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
