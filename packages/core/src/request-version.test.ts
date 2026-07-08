import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { RequestDefinition } from "./request-definition.js";
import {
  FileSystemRequestVersionRepository,
  InMemoryRequestVersionRepository,
  createRequestVersionHashes
} from "./request-version.js";

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
    },
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
    url: "https://example.com/watasu/intake"
  },
  retention: {
    destination_policy: "Delete within 30 days after the event."
  },
  encryption: {
    mode: "required",
    algorithm: "JWE",
    key_management: "ECDH-ES+A256KW",
    content_encryption: "A256GCM",
    service_key_id: "jwk-thumbprint:sha256:example",
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
  trust_profile: "human_consent"
};

function definitionWith(overrides: Partial<RequestDefinition>): RequestDefinition {
  return {
    ...structuredClone(baseDefinition),
    ...overrides
  };
}

describe("request version hashes", () => {
  test("test_same_canonical_request_produces_same_hashes", () => {
    const left = definitionWith({
      destination: { url: "https://example.com/watasu/intake", type: "webhook" }
    });
    const right = definitionWith({
      destination: { type: "webhook", url: "https://example.com/watasu/intake" }
    });

    const leftHashes = createRequestVersionHashes(left);
    const rightHashes = createRequestVersionHashes(right);

    expect(leftHashes.request_version_hash).toBe(rightHashes.request_version_hash);
  });

  test("test_field_order_changes_request_version_hash", () => {
    const reversedFields = definitionWith({
      fields: [...baseDefinition.fields].reverse()
    });

    const baseHashes = createRequestVersionHashes(baseDefinition);
    const reversedHashes = createRequestVersionHashes(reversedFields);

    expect(reversedHashes.request_version_hash).not.toBe(baseHashes.request_version_hash);
  });

  test("test_hashes_include_consent_purpose_destination_and_public_key_fingerprint", () => {
    const hashes = createRequestVersionHashes(baseDefinition);

    expect(Object.keys(hashes).sort()).toEqual([
      "consent_text_hash",
      "destination_policy_hash",
      "field_purposes_hash",
      "public_key_fingerprint",
      "request_version_hash",
      "schema_hash"
    ]);
  });
});

describe("request version repository", () => {
  test("test_publish_creates_new_version_when_consent_changes", () => {
    const repository = new InMemoryRequestVersionRepository();
    const changedConsent = definitionWith({
      consent: {
        text: "ExampleConf uses this information for event operations and emergency contact."
      }
    });

    const first = repository.publish("event-attendee-intake", baseDefinition);
    const second = repository.publish("event-attendee-intake", changedConsent);

    expect([first.request_version, second.request_version]).toEqual(["v1", "v2"]);
  });

  test("test_published_request_version_cannot_be_mutated", () => {
    const repository = new InMemoryRequestVersionRepository();

    const published = repository.publish("event-attendee-intake", baseDefinition);

    expect(() => {
      published.definition.consent.text = "mutated after publish";
    }).toThrow(TypeError);
  });
});

describe("filesystem request version repository", () => {
  test("test_filesystem_repository_persists_versions_by_request_id", async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), "watasu-request-versions-"));
    const firstRepository = new FileSystemRequestVersionRepository(storeRoot);
    const secondRepository = new FileSystemRequestVersionRepository(storeRoot);
    const changedConsent = definitionWith({
      consent: {
        text: "ExampleConf uses this information for event operations and emergency contact."
      }
    });

    const first = await firstRepository.publish("event-attendee-intake", baseDefinition);
    const second = await firstRepository.publish("event-attendee-intake", changedConsent);
    const persisted = await secondRepository.list("event-attendee-intake");

    expect(persisted.map((version) => version.request_version)).toEqual([
      first.request_version,
      second.request_version
    ]);
  });

  test("test_filesystem_repository_reuses_same_version_for_same_definition", async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), "watasu-request-versions-"));
    const repository = new FileSystemRequestVersionRepository(storeRoot);

    const first = await repository.publish("event-attendee-intake", baseDefinition);
    const second = await repository.publish("event-attendee-intake", baseDefinition);

    expect([first.request_version, second.request_version]).toEqual(["v1", "v1"]);
  });

  test("test_filesystem_repository_writes_index_without_plaintext_payload", async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), "watasu-request-versions-"));
    const repository = new FileSystemRequestVersionRepository(storeRoot);

    await repository.publish("event-attendee-intake", baseDefinition);
    const indexJson = await readFile(
      join(storeRoot, "requests", "event-attendee-intake", "index.json"),
      "utf8"
    );

    expect(indexJson).toContain("request_version_hash");
    expect(indexJson).not.toContain("payload");
  });

  test("test_filesystem_repository_rejects_unsafe_request_id", async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), "watasu-request-versions-"));
    const repository = new FileSystemRequestVersionRepository(storeRoot);

    await expect(repository.publish("../escape", baseDefinition)).rejects.toThrow(
      "request_id must use only letters, numbers, dots, underscores, and hyphens"
    );
  });
});
