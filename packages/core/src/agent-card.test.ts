import { describe, expect, test } from "vitest";
import type { RequestDefinition } from "./request-definition.js";
import { InMemoryRequestVersionRepository } from "./request-version.js";
import { buildAgentCard } from "./agent-card.js";

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
    url: "https://receiver.example.com/private/watasu/intake"
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

function publishedRequest() {
  const repository = new InMemoryRequestVersionRepository();

  return repository.publish("event-attendee-intake", definition);
}

describe("agent card generation", () => {
  test("test_agent_card_declares_http_json_supported_interface", () => {
    const card = buildAgentCard({
      published: publishedRequest(),
      endpointUrl: "https://api.watasu.dev/a2a/requests/event-attendee-intake/v1"
    });

    expect(card.supportedInterfaces).toEqual([
      {
        url: "https://api.watasu.dev/a2a/requests/event-attendee-intake/v1",
        protocolBinding: "HTTP+JSON",
        protocolVersion: "1.0"
      }
    ]);
  });

  test("test_agent_card_declares_protocol_version", () => {
    const card = buildAgentCard({
      published: publishedRequest(),
      endpointUrl: "https://api.watasu.dev/a2a/requests/event-attendee-intake/v1"
    });

    expect(card.protocolVersion).toBe("1.0");
  });

  test("test_agent_card_includes_watasu_extension_uri", () => {
    const card = buildAgentCard({
      published: publishedRequest(),
      endpointUrl: "https://api.watasu.dev/a2a/requests/event-attendee-intake/v1"
    });

    expect(card.capabilities.extensions).toContainEqual(
      expect.objectContaining({
        uri: "https://watasu.dev/extensions/encrypted-intake/v1",
        required: true
      })
    );
  });

  test("test_agent_card_includes_field_purposes_hash_for_confirmation_binding", () => {
    const published = publishedRequest();
    const card = buildAgentCard({
      published,
      endpointUrl: "https://api.watasu.dev/a2a/requests/event-attendee-intake/v1"
    });

    expect(card.capabilities.extensions[0]?.params).toMatchObject({
      field_purposes_hash: published.hashes.field_purposes_hash
    });
  });

  test("test_agent_card_does_not_include_webhook_secret_or_private_key", () => {
    const card = buildAgentCard({
      published: publishedRequest(),
      endpointUrl: "https://api.watasu.dev/a2a/requests/event-attendee-intake/v1"
    });
    const cardJson = JSON.stringify(card);

    expect(cardJson).not.toContain("receiver.example.com/private");
    expect(cardJson).not.toContain("private_key");
  });
});
