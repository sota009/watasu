import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runCli } from "./index.js";

const fixtureFile = new URL(
  "../../fixtures/requests/event-attendee.yaml",
  import.meta.url
).pathname;
const cliPackageDirectory = new URL("../", import.meta.url).pathname;
const workspaceDirectory = new URL("../../../", import.meta.url).pathname;

function parseJsonLine(output: string): unknown {
  return JSON.parse(output.trim());
}

function writeTempFile(contents: string): string {
  const directory = mkdtempSync(join(tmpdir(), "watasu-cli-test-"));
  const file = join(directory, "request.yaml");
  writeFileSync(file, contents);
  return file;
}

describe("watasu cli first slice", () => {
  test("test_cli_validate_outputs_structured_json", async () => {
    const result = await runCli(["validate", fixtureFile]);

    expect(result.exitCode).toBe(0);
    expect(parseJsonLine(result.stdout)).toMatchObject({
      ok: true,
      command: "validate",
      request: {
        name: "event-attendee-intake",
        field_count: 2
      }
    });
  });

  test("test_cli_dist_bin_executes_from_package_directory_with_workspace_relative_file", () => {
    const result = spawnSync(
      process.execPath,
      ["dist/bin.js", "validate", "packages/fixtures/requests/event-attendee.yaml"],
      {
        cwd: cliPackageDirectory,
        encoding: "utf8",
        env: {
          ...process.env,
          INIT_CWD: workspaceDirectory
        }
      }
    );

    expect(result.status).toBe(0);
    expect(parseJsonLine(result.stdout)).toMatchObject({
      ok: true,
      command: "validate",
      request: {
        name: "event-attendee-intake"
      }
    });
  });

  test("test_cli_validate_exits_nonzero_for_invalid_request", async () => {
    const invalidFile = writeTempFile("name: incomplete-request\n");

    const result = await runCli(["validate", invalidFile]);

    expect(result.exitCode).toBe(1);
    expect(parseJsonLine(result.stderr)).toMatchObject({
      ok: false,
      error: {
        code: "invalid_request_definition"
      }
    });
  });

  test("test_cli_publish_requires_confirm_flag", async () => {
    const result = await runCli(["publish", fixtureFile]);

    expect(result.exitCode).toBe(1);
    expect(parseJsonLine(result.stderr)).toMatchObject({
      ok: false,
      command: "publish",
      error: {
        code: "publish_requires_confirmation"
      }
    });
  });

  test("test_cli_publish_with_confirm_outputs_in_memory_summary", async () => {
    const result = await runCli(["publish", fixtureFile, "--confirm"]);

    expect(result.exitCode).toBe(0);
    expect(parseJsonLine(result.stdout)).toMatchObject({
      ok: true,
      command: "publish",
      storage: "in_memory",
      published: {
        request_id: "event-attendee-intake",
        request_version: "v1",
        hashes: {
          request_version_hash: expect.any(String),
          schema_hash: expect.any(String)
        }
      }
    });
  });

  test("test_cli_agent_card_file_based_wrapper_outputs_stable_structured_json", async () => {
    const result = await runCli(["agent-card", fixtureFile, "--confirm"]);

    expect(result.exitCode).toBe(0);
    expect(parseJsonLine(result.stdout)).toMatchObject({
      ok: true,
      command: "agent-card",
      mode: "file_based_phase_4_wrapper",
      agent_card: {
        protocolVersion: "1.0",
        provider: {
          organization: "watasu"
        },
        capabilities: {
          extensions: [
            {
              uri: "https://watasu.dev/extensions/encrypted-intake/v1",
              required: true
            }
          ]
        }
      }
    });
  });

  test("test_cli_agent_card_encodes_request_id_path_segments", async () => {
    const requestFile = writeTempFile(
      readFileSync(fixtureFile, "utf8").replace(
        "name: event-attendee-intake",
        "name: event attendee/intake"
      )
    );

    const result = await runCli(["agent-card", requestFile, "--confirm"]);

    expect(result.exitCode).toBe(0);
    expect(parseJsonLine(result.stdout)).toMatchObject({
      agent_card: {
        supportedInterfaces: [
          {
            url: "https://api.watasu.dev/a2a/requests/event%20attendee%2Fintake/v1"
          }
        ]
      }
    });
  });

  test("test_cli_schema_outputs_plaintext_and_envelope_schema", async () => {
    const result = await runCli(["schema", fixtureFile]);

    expect(result.exitCode).toBe(0);
    expect(parseJsonLine(result.stdout)).toMatchObject({
      ok: true,
      command: "schema",
      schemas: {
        plaintext: {
          properties: {
            full_name: { type: "string" },
            email: { type: "string", format: "email" }
          },
          required: ["full_name", "email"]
        },
        envelope: {
          properties: {
            schema_hash: {
              type: "string"
            }
          }
        }
      }
    });
  });

  test("test_cli_errors_are_machine_readable", async () => {
    const result = await runCli(["unknown-command"]);

    expect(result.exitCode).toBe(1);
    expect(parseJsonLine(result.stderr)).toMatchObject({
      ok: false,
      error: {
        code: "unknown_command",
        path: "$.command"
      }
    });
  });
});
