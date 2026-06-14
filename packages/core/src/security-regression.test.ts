import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";

const rootDir = new URL("../../../", import.meta.url);

const forbiddenPayloadMarkers = [
  "Alice Example",
  "alice@example.com",
  "sample-secret-value",
  "base64url-ciphertext",
  "\"encrypted_payload\"",
  "\"protected\"",
  "\"tag\""
];

function runHandoffDemo(): { stdout: string; stderr: string; output: unknown; status: number | null } {
  const result = spawnSync("pnpm", ["demo:handoff"], {
    cwd: rootDir,
    encoding: "utf8"
  });
  const jsonStart = result.stdout.indexOf("{\n");

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    output: JSON.parse(result.stdout.slice(jsonStart)) as unknown,
    status: result.status
  };
}

describe("security regression suite", () => {
  test("test_no_payload_values_in_handoff_demo_output", () => {
    // Arrange / Act
    const result = runHandoffDemo();
    const combinedOutput = `${result.stdout}\n${result.stderr}`;

    // Assert
    expect(result.status).toBe(0);
    for (const marker of forbiddenPayloadMarkers) {
      expect(combinedOutput).not.toContain(marker);
    }
  });

  test("test_no_encrypted_payload_body_in_handoff_ledger_after_delivery", () => {
    // Arrange / Act
    const result = runHandoffDemo();

    // Assert
    expect(result.output).toMatchObject({
      ok: true,
      watasu: {
        ledger_rows: 1,
        ledger_contains_payload_body: false,
        response_contains_plaintext_payload: false
      }
    });
  });

  test("test_capability_url_full_token_is_never_logged", () => {
    // Arrange / Act
    const result = runHandoffDemo();
    const combinedOutput = `${result.stdout}\n${result.stderr}`;

    // Assert
    expect(combinedOutput).not.toContain("/capabilities/");
    expect(combinedOutput).not.toContain("local-demo");
  });

  test("test_dependency_lockfile_exists", () => {
    // Arrange / Act
    const lockfileExists = existsSync(new URL("pnpm-lock.yaml", rootDir));

    // Assert
    expect(lockfileExists).toBe(true);
  });
});
