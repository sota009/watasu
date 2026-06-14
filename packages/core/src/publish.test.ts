import { describe, expect, test } from "vitest";
import type { RequestDefinition } from "./request-definition.js";
import { InMemoryRequestVersionRepository } from "./request-version.js";
import { publishRequestVersion } from "./publish.js";

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
  trust_profile: "verified_sender"
};

function definitionWith(overrides: Partial<RequestDefinition>): RequestDefinition {
  return {
    ...structuredClone(baseDefinition),
    ...overrides
  };
}

describe("request publishing", () => {
  test("test_publish_without_confirmation_returns_publish_requires_confirmation", () => {
    const repository = new InMemoryRequestVersionRepository();

    const result = publishRequestVersion({
      requestId: "event-attendee-intake",
      definition: baseDefinition,
      confirmed: false,
      mode: "hosted",
      repository
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "publish_requires_confirmation"
      }
    });
    expect(repository.list("event-attendee-intake")).toHaveLength(0);
  });

  test("test_local_demo_publish_allows_localhost_webhook", () => {
    const repository = new InMemoryRequestVersionRepository();
    const definition = definitionWith({
      destination: {
        type: "webhook",
        url: "http://localhost:8787/watasu/intake"
      },
      trust_profile: "local_demo"
    });

    const result = publishRequestVersion({
      requestId: "event-attendee-intake",
      definition,
      confirmed: true,
      mode: "local_demo",
      repository
    });

    expect(result).toMatchObject({
      ok: true,
      published: {
        request_id: "event-attendee-intake",
        request_version: "v1"
      }
    });
  });

  test("test_hosted_publish_rejects_localhost_webhook", () => {
    const repository = new InMemoryRequestVersionRepository();
    const definition = definitionWith({
      destination: {
        type: "webhook",
        url: "http://localhost:8787/watasu/intake"
      },
      trust_profile: "verified_sender"
    });

    const result = publishRequestVersion({
      requestId: "event-attendee-intake",
      definition,
      confirmed: true,
      mode: "hosted",
      repository
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "unsafe_destination",
        path: "destination.url"
      }
    });
    expect(repository.list("event-attendee-intake")).toHaveLength(0);
  });

  test("test_hosted_publish_rejects_local_demo_trust_profile", () => {
    const repository = new InMemoryRequestVersionRepository();
    const definition = definitionWith({
      trust_profile: "local_demo"
    });

    const result = publishRequestVersion({
      requestId: "event-attendee-intake",
      definition,
      confirmed: true,
      mode: "hosted",
      repository
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "local_demo_not_allowed_in_hosted_publish",
        path: "trust_profile"
      }
    });
    expect(repository.list("event-attendee-intake")).toHaveLength(0);
  });

  test("test_publish_stores_capability_token_hash_only", () => {
    const repository = new InMemoryRequestVersionRepository();

    const result = publishRequestVersion({
      requestId: "event-attendee-intake",
      definition: baseDefinition,
      confirmed: true,
      mode: "hosted",
      repository,
      generateCapabilityToken: () => "cap_test_abcdefghijklmnopqrstuvwxyz1234567890"
    });

    expect(result).toMatchObject({
      ok: true,
      published: {
        capability: {
          token_hash: expect.stringMatching(/^sha256:/)
        }
      }
    });
    expect(JSON.stringify(result)).not.toContain("cap_test_abcdefghijklmnopqrstuvwxyz1234567890");
    expect(JSON.stringify(repository.list("event-attendee-intake"))).not.toContain(
      "cap_test_abcdefghijklmnopqrstuvwxyz1234567890"
    );
  });
});
