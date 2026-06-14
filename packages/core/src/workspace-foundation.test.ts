import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { findSecretLikeValues } from "../../../scripts/secret-scan.mjs";

const rootDir = new URL("../../../", import.meta.url);

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(new URL(path, rootDir), "utf8"));
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

  test("test_render_blueprint_uses_health_check_and_unsynced_secrets", () => {
    const renderYaml = readFileSync(new URL("render.yaml", rootDir), "utf8");

    expect(renderYaml).toContain("name: watasu-hosted");
    expect(renderYaml).toContain("autoDeployTrigger: checksPass");
    expect(renderYaml).toContain("healthCheckPath: /health");
    expect(renderYaml).toContain("api.watasu.ai");
    expect(renderYaml).toContain("value: 24.14.1");
    expect(renderYaml).toContain("key: WATASU_SERVICE_IDENTITY_SIGNING_SECRET");
    expect(renderYaml).toContain("sync: false");
    expect(renderYaml).not.toContain("WATASU_POSTGRES_URL: postgres://");
  });
});
