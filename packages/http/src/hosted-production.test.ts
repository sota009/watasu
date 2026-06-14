import { describe, expect, test } from "vitest";
import {
  InMemoryRequestVersionRepository,
  type RequestDefinition
} from "@watasu/core";
import {
  createHostedProductionApp,
  type HostedProductionRequest
} from "./hosted-production.js";

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

function createRequest(input: {
  method: string;
  path: string;
}): HostedProductionRequest {
  return {
    method: input.method,
    path: input.path,
    headers: {},
    body: ""
  };
}

function parseJson(body: string): unknown {
  return JSON.parse(body) as unknown;
}

describe("hosted production HTTP app", () => {
  test("test_health_route_returns_low_information_status", async () => {
    // Arrange
    const app = createHostedProductionApp({
      publishApp: {
        async handle() {
          throw new Error("publish app must not handle health route");
        }
      },
      publicBaseUrl: "https://api.watasu.ai",
      requestVersions: new InMemoryRequestVersionRepository(),
      metadataApp: {
        async handle() {
          throw new Error("metadata app must not handle health route");
        }
      }
    });

    // Act
    const response = await app.handle(createRequest({
      method: "GET",
      path: "/health"
    }));

    // Assert
    expect(response.status).toBe(200);
    expect(parseJson(response.body)).toEqual({
      ok: true,
      service: "watasu-hosted"
    });
    expect(response.body).not.toContain("tenant");
    expect(response.body).not.toContain("ledger");
    expect(response.body).not.toContain("postgres");
    expect(response.body).not.toContain("payload");
  });

  test("test_get_agent_card_route_returns_latest_published_request_card", async () => {
    // Arrange
    const requestVersions = new InMemoryRequestVersionRepository();
    requestVersions.publish("event-attendee-intake", definition);
    const app = createHostedProductionApp({
      publishApp: {
        async handle() {
          throw new Error("publish app must not handle agent card route");
        }
      },
      publicBaseUrl: "https://api.watasu.ai",
      requestVersions,
      metadataApp: {
        async handle() {
          throw new Error("metadata app must not handle agent card route");
        }
      }
    });

    // Act
    const response = await app.handle(createRequest({
      method: "GET",
      path: "/requests/event-attendee-intake/agent-card.json"
    }));

    // Assert
    expect(response.status).toBe(200);
    expect(parseJson(response.body)).toMatchObject({
      protocolVersion: "1.0",
      supportedInterfaces: [
        {
          url: "https://api.watasu.ai/requests/event-attendee-intake/submit",
          protocolBinding: "HTTP+JSON",
          protocolVersion: "1.0"
        }
      ],
      capabilities: {
        extensions: [
          {
            uri: "https://watasu.dev/extensions/encrypted-intake/v1",
            required: true,
            params: {
              request_id: "event-attendee-intake",
              request_version: "v1"
            }
          }
        ]
      }
    });
    expect(response.body).not.toContain("receiver.example.com/private");
  });

  test("test_get_agent_card_route_returns_not_found_for_unpublished_request", async () => {
    // Arrange
    const app = createHostedProductionApp({
      publishApp: {
        async handle() {
          throw new Error("publish app must not handle unpublished agent card route");
        }
      },
      publicBaseUrl: "https://api.watasu.ai",
      requestVersions: new InMemoryRequestVersionRepository(),
      metadataApp: {
        async handle() {
          throw new Error("metadata app must not handle unpublished agent card route");
        }
      }
    });

    // Act
    const response = await app.handle(createRequest({
      method: "GET",
      path: "/requests/missing/agent-card.json"
    }));

    // Assert
    expect(response.status).toBe(404);
    expect(parseJson(response.body)).toEqual({
      ok: false,
      error: {
        code: "request_version_not_found",
        message: "Published request was not found."
      }
    });
  });

  test("test_post_publish_route_is_delegated_to_hosted_publish_app", async () => {
    // Arrange
    const handledPaths: string[] = [];
    const app = createHostedProductionApp({
      publishApp: {
        async handle(request) {
          handledPaths.push(request.path);
          return {
            status: 201,
            headers: {
              "content-type": "application/json; charset=utf-8"
            },
            body: "{\"ok\":true,\"surface\":\"publish\"}\n"
          };
        }
      },
      publicBaseUrl: "https://api.watasu.ai",
      requestVersions: new InMemoryRequestVersionRepository(),
      metadataApp: {
        async handle() {
          throw new Error("metadata app must not handle publish route");
        }
      }
    });

    // Act
    const response = await app.handle(createRequest({
      method: "POST",
      path: "/requests/event-attendee-intake/publish"
    }));

    // Assert
    expect(response.status).toBe(201);
    expect(parseJson(response.body)).toEqual({
      ok: true,
      surface: "publish"
    });
    expect(handledPaths).toEqual(["/requests/event-attendee-intake/publish"]);
  });

  test("test_get_ledger_route_is_delegated_to_hosted_metadata_app", async () => {
    // Arrange
    const handledPaths: string[] = [];
    const app = createHostedProductionApp({
      publishApp: {
        async handle() {
          throw new Error("publish app must not handle metadata route");
        }
      },
      publicBaseUrl: "https://api.watasu.ai",
      requestVersions: new InMemoryRequestVersionRepository(),
      metadataApp: {
        async handle(request) {
          handledPaths.push(request.path);
          return {
            status: 200,
            headers: {
              "content-type": "application/json; charset=utf-8"
            },
            body: "{\"ok\":true,\"surface\":\"metadata\"}\n"
          };
        }
      }
    });

    // Act
    const response = await app.handle(createRequest({
      method: "GET",
      path: "/requests/event-attendee-intake/ledger"
    }));

    // Assert
    expect(response.status).toBe(200);
    expect(parseJson(response.body)).toEqual({
      ok: true,
      surface: "metadata"
    });
    expect(handledPaths).toEqual(["/requests/event-attendee-intake/ledger"]);
  });

  test("test_unknown_hosted_route_returns_not_found", async () => {
    // Arrange
    const app = createHostedProductionApp({
      publishApp: {
        async handle() {
          throw new Error("publish app must not handle unknown route");
        }
      },
      publicBaseUrl: "https://api.watasu.ai",
      requestVersions: new InMemoryRequestVersionRepository(),
      metadataApp: {
        async handle() {
          throw new Error("metadata app must not handle unknown route");
        }
      }
    });

    // Act
    const response = await app.handle(createRequest({
      method: "GET",
      path: "/"
    }));

    // Assert
    expect(response.status).toBe(404);
    expect(parseJson(response.body)).toEqual({
      ok: false,
      error: {
        code: "not_found",
        message: "Hosted production route was not found."
      }
    });
  });
});
