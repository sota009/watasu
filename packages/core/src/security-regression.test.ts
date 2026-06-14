import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { deliverAcceptedSubmission, type DeliveryClient, type DeliveryLedgerRow } from "./delivery.js";
import { sha256Hash } from "./hash.js";
import { publishRequestVersion } from "./publish.js";
import { canonicalizeJson } from "./request-definition.js";
import { createRequestVersionHashes, InMemoryRequestVersionRepository } from "./request-version.js";
import { createPolicyControlledDeliveryLedger } from "./storage-policy.js";
import type { PublishedRequestVersion } from "./request-version.js";
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

const baseDefinition: RequestDefinition = {
  name: "event-attendee-intake",
  schema_version: "2026-06-14",
  description: "Collect attendee details for ExampleConf.",
  fields: [
    {
      id: "full_name",
      type: "string",
      required: true,
      purpose: "Confirm attendees at reception.",
      sensitivity: "moderate"
    }
  ],
  consent: {
    text: "ExampleConf uses this information only for event operations."
  },
  destination: {
    type: "webhook",
    url: "https://receiver.example.com/watasu/intake"
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

const encryptedPayload = {
  protected: "base64url-protected",
  iv: "base64url-iv",
  ciphertext: "base64url-ciphertext",
  tag: "base64url-tag"
};

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

function createPublishedRequestVersion(): PublishedRequestVersion {
  return {
    request_id: "event-attendee-intake",
    request_version: "v1",
    definition: baseDefinition,
    hashes: createRequestVersionHashes(baseDefinition),
    published_at: "2026-06-14T11:00:00.000Z"
  };
}

function createDeliveryClient(status: number): DeliveryClient {
  return {
    async post() {
      return {
        status
      };
    }
  };
}

async function deliverToFuturePersistentStore(): Promise<DeliveryLedgerRow[]> {
  const published = createPublishedRequestVersion();
  const persistentRows: DeliveryLedgerRow[] = [];
  const ledger = createPolicyControlledDeliveryLedger({
    policy: {
      mode: "metadata_ledger_enabled"
    },
    operationalLedger: {
      writeDeliveryAttempt() {
        // Short-lived operational state is intentionally irrelevant to durable-store leak tests.
      }
    },
    persistentStore: {
      writeDeliveryAttempt(row) {
        persistentRows.push(row);
      }
    }
  });

  await deliverAcceptedSubmission({
    mode: "hosted",
    published,
    envelope: {
      request_id: published.request_id,
      request_version: published.request_version,
      schema_hash: published.hashes.schema_hash,
      consent_receipt_hash: published.hashes.consent_text_hash,
      idempotency_key: "submit-001",
      submitted_at: "2026-06-14T11:59:00.000Z",
      service_key_id: published.definition.encryption.service_key_id,
      encrypted_payload: encryptedPayload,
      encrypted_payload_hash: sha256Hash(canonicalizeJson(encryptedPayload))
    },
    submission: {
      request_id: published.request_id,
      request_version: published.request_version,
      idempotency_key: "submit-001",
      submitted_at: "2026-06-14T11:59:00.000Z",
      accepted_at: "2026-06-14T12:00:00.000Z",
      capability_hash: sha256Hash("https://example.com/.well-known/watasu/cap/abc")
    },
    client: createDeliveryClient(204),
    ledger,
    clock: () => new Date("2026-06-14T12:00:01.000Z"),
    signingSecret: "test-signing-secret"
  });

  return persistentRows;
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

  test("test_no_plaintext_payload_in_future_persistent_ledger_store", async () => {
    // Arrange / Act
    const persistentRows = await deliverToFuturePersistentStore();
    const serializedRows = canonicalizeJson(persistentRows);

    // Assert
    expect(persistentRows).toHaveLength(1);
    expect(serializedRows).not.toContain("Alice Example");
    expect(serializedRows).not.toContain("full_name");
  });

  test("test_no_encrypted_payload_body_in_future_persistent_ledger_store_after_delivery", async () => {
    // Arrange / Act
    const persistentRows = await deliverToFuturePersistentStore();
    const serializedRows = canonicalizeJson(persistentRows);

    // Assert
    expect(persistentRows).toHaveLength(1);
    expect(serializedRows).toContain("encrypted_payload_hash");
    expect(serializedRows).not.toContain("\"encrypted_payload\"");
    expect(serializedRows).not.toContain("base64url-ciphertext");
    expect(serializedRows).not.toContain("\"protected\"");
    expect(serializedRows).not.toContain("\"tag\"");
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
