import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";

const rootDir = new URL("../../../", import.meta.url);

function runHostedSubmitStatus(env: Record<string, string | undefined> = {}) {
  return spawnSync("pnpm", ["--silent", "hosted-submit:status"], {
    cwd: rootDir,
    encoding: "utf8",
    env: {
      ...process.env,
      ...env
    }
  });
}

describe("hosted submit readiness status", () => {
  test("test_missing_operator_inputs_return_secret_safe_not_ready_status", () => {
    const result = runHostedSubmitStatus({
      WATASU_HOSTED_SUBMIT_AGENT_CARD_URL: "",
      WATASU_HOSTED_SUBMIT_SCHEMA_URL: "",
      WATASU_HOSTED_SUBMIT_PUBLIC_JWK: "",
      WATASU_HOSTED_SUBMIT_VALUES: ""
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
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

  test("test_configured_operator_inputs_return_secret_safe_ready_status", () => {
    const result = runHostedSubmitStatus({
      WATASU_HOSTED_SUBMIT_AGENT_CARD_URL:
        "https://api.watasu.ai/requests/private-alpha/agent-card.json",
      WATASU_HOSTED_SUBMIT_SCHEMA_URL:
        "https://api.watasu.ai/requests/private-alpha/schemas/plaintext.json",
      WATASU_HOSTED_SUBMIT_PUBLIC_JWK: "/tmp/service-public-jwk.json",
      WATASU_HOSTED_SUBMIT_VALUES: "/tmp/test-only-values.json",
      WATASU_HOSTED_SUBMIT_MAPPING: "/tmp/mapping.json"
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      ready: true,
      missing_inputs: [],
      configured_optional_inputs: ["WATASU_HOSTED_SUBMIT_MAPPING"],
      submit_command: {
        command: "pnpm",
        args: [
          "--filter",
          "@watasu/personal-info-adapter",
          "submit",
          "--agent-card",
          "$WATASU_HOSTED_SUBMIT_AGENT_CARD_URL",
          "--schema",
          "$WATASU_HOSTED_SUBMIT_SCHEMA_URL",
          "--mapping",
          "$WATASU_HOSTED_SUBMIT_MAPPING",
          "--personal-info-values",
          "$WATASU_HOSTED_SUBMIT_VALUES",
          "--public-jwk",
          "$WATASU_HOSTED_SUBMIT_PUBLIC_JWK",
          "--confirm"
        ]
      },
      next_command: "pnpm --filter @watasu/personal-info-adapter submit --confirm"
    });
    expect(result.stdout).not.toContain("https://api.watasu.ai/requests/private-alpha");
    expect(result.stdout).not.toContain("/tmp/service-public-jwk.json");
    expect(result.stdout).not.toContain("/tmp/test-only-values.json");
  });
});
