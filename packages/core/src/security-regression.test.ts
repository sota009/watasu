import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { publishRequestVersion } from "./publish.js";
import { InMemoryRequestVersionRepository } from "./request-version.js";
import type { RequestDefinition } from "./request-definition.js";

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

  test("test_unsafe_webhook_url_is_rejected_in_hosted_mode", () => {
    // Arrange
    const definition: RequestDefinition = {
      name: "event-attendee-intake",
      schema_version: "2026-06-14",
      description: "Collect attendee details for ExampleConf.",
      fields: [
        {
          id: "email",
          type: "string",
          format: "email",
          required: true,
          purpose: "Send event updates.",
          sensitivity: "moderate"
        }
      ],
      consent: {
        text: "ExampleConf uses this information only for event operations."
      },
      destination: {
        type: "webhook",
        url: "http://127.0.0.1:8787/watasu/intake"
      },
      retention: {
        destination_policy: "Delete within 30 days after the event."
      },
      encryption: {
        mode: "required",
        algorithm: "JWE",
        key_management: "ECDH-ES+A256KW",
        content_encryption: "A256GCM",
        service_key_id: "jwk-thumbprint:sha256:service",
        public_key_jwk: {
          kty: "EC",
          crv: "P-256",
          x: "base64url-x",
          y: "base64url-y"
        }
      },
      metadata_retention: {
        days: 90
      },
      trust_profile: "verified_sender"
    };

    // Act
    const result = publishRequestVersion({
      requestId: "event-attendee-intake",
      definition,
      confirmed: true,
      mode: "hosted",
      repository: new InMemoryRequestVersionRepository()
    });

    // Assert
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "unsafe_destination",
        path: "destination.url"
      }
    });
  });

  test("test_dependency_lockfile_exists", () => {
    // Arrange / Act
    const lockfileExists = existsSync(new URL("pnpm-lock.yaml", rootDir));

    // Assert
    expect(lockfileExists).toBe(true);
  });
});
