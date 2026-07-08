import { describe, expect, test } from "vitest";
import {
  InMemoryPublishedRequestRegistry,
  InMemoryRequestVersionRepository,
  type RequestDefinition
} from "@watasu/core";
import { createHostedRetireApp } from "./hosted-retire.js";
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
  trust_profile: "human_consent"
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

function createUnexpectedSubmitApp(routeName: string) {
  return {
    async handle() {
      throw new Error(`submit app must not handle ${routeName} route`);
    }
  };
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
      submitApp: createUnexpectedSubmitApp("health"),
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
      submitApp: createUnexpectedSubmitApp("agent card"),
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

  test("test_get_agent_card_route_awaits_async_request_version_list", async () => {
    // Arrange
    const requestVersions = new InMemoryRequestVersionRepository();
    requestVersions.publish("event-attendee-intake", definition);
    const app = createHostedProductionApp({
      publishApp: {
        async handle() {
          throw new Error("publish app must not handle async agent card route");
        }
      },
      submitApp: createUnexpectedSubmitApp("async agent card"),
      publicBaseUrl: "https://api.watasu.ai",
      requestVersions: {
        async list(requestId) {
          await Promise.resolve();

          return requestVersions.list(requestId);
        }
      },
      metadataApp: {
        async handle() {
          throw new Error("metadata app must not handle async agent card route");
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
      supportedInterfaces: [
        {
          url: "https://api.watasu.ai/requests/event-attendee-intake/submit"
        }
      ]
    });
  });

  test("test_get_agent_card_route_returns_not_found_for_unpublished_request", async () => {
    // Arrange
    const app = createHostedProductionApp({
      publishApp: {
        async handle() {
          throw new Error("publish app must not handle unpublished agent card route");
        }
      },
      submitApp: createUnexpectedSubmitApp("unpublished agent card"),
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

  test("test_get_schema_routes_return_published_request_schemas_without_private_destination", async () => {
    // Arrange
    const requestVersions = new InMemoryRequestVersionRepository();
    requestVersions.publish("event-attendee-intake", definition);
    const app = createHostedProductionApp({
      publishApp: {
        async handle() {
          throw new Error("publish app must not handle schema routes");
        }
      },
      submitApp: createUnexpectedSubmitApp("schemas"),
      publicBaseUrl: "https://api.watasu.ai",
      requestVersions,
      metadataApp: {
        async handle() {
          throw new Error("metadata app must not handle schema routes");
        }
      }
    });

    // Act
    const plaintextResponse = await app.handle(createRequest({
      method: "GET",
      path: "/requests/event-attendee-intake/schemas/plaintext.json"
    }));
    const envelopeResponse = await app.handle(createRequest({
      method: "GET",
      path: "/requests/event-attendee-intake/schemas/envelope.json"
    }));

    // Assert
    expect(plaintextResponse.status).toBe(200);
    expect(parseJson(plaintextResponse.body)).toMatchObject({
      type: "object",
      properties: {
        email: {
          type: "string",
          format: "email"
        }
      },
      required: ["email"]
    });
    expect(envelopeResponse.status).toBe(200);
    expect(parseJson(envelopeResponse.body)).toMatchObject({
      type: "object",
      properties: {
        schema_hash: {
          const: requestVersions.list("event-attendee-intake")[0]?.hashes.schema_hash
        },
        service_key_id: {
          const: "jwk-thumbprint:sha256:example"
        },
        encrypted_payload: {
          type: "object"
        }
      }
    });
    expect(plaintextResponse.body).not.toContain("receiver.example.com/private");
    expect(envelopeResponse.body).not.toContain("receiver.example.com/private");
  });

  test("test_get_schema_route_awaits_async_request_version_list", async () => {
    // Arrange
    const requestVersions = new InMemoryRequestVersionRepository();
    const published = requestVersions.publish("event-attendee-intake", definition);
    const app = createHostedProductionApp({
      publishApp: {
        async handle() {
          throw new Error("publish app must not handle async schema route");
        }
      },
      submitApp: createUnexpectedSubmitApp("async schema"),
      publicBaseUrl: "https://api.watasu.ai",
      requestVersions: {
        async list(requestId) {
          await Promise.resolve();

          return requestVersions.list(requestId);
        }
      },
      metadataApp: {
        async handle() {
          throw new Error("metadata app must not handle async schema route");
        }
      }
    });

    // Act
    const response = await app.handle(createRequest({
      method: "GET",
      path: "/requests/event-attendee-intake/schemas/envelope.json"
    }));

    // Assert
    expect(response.status).toBe(200);
    expect(parseJson(response.body)).toMatchObject({
      properties: {
        schema_hash: {
          const: published.hashes.schema_hash
        }
      }
    });
  });

  test("test_get_schema_route_returns_not_found_for_unpublished_request", async () => {
    // Arrange
    const app = createHostedProductionApp({
      publishApp: {
        async handle() {
          throw new Error("publish app must not handle unpublished schema route");
        }
      },
      submitApp: createUnexpectedSubmitApp("unpublished schema"),
      publicBaseUrl: "https://api.watasu.ai",
      requestVersions: new InMemoryRequestVersionRepository(),
      metadataApp: {
        async handle() {
          throw new Error("metadata app must not handle unpublished schema route");
        }
      }
    });

    // Act
    const response = await app.handle(createRequest({
      method: "GET",
      path: "/requests/missing/schemas/plaintext.json"
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
      submitApp: createUnexpectedSubmitApp("publish"),
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

  test("test_post_submit_route_is_delegated_to_hosted_submit_app", async () => {
    // Arrange
    const handledPaths: string[] = [];
    const app = createHostedProductionApp({
      publishApp: {
        async handle() {
          throw new Error("publish app must not handle submit route");
        }
      },
      submitApp: {
        async handle(request) {
          handledPaths.push(request.path);
          return {
            status: 202,
            headers: {
              "content-type": "application/json; charset=utf-8"
            },
            body: "{\"ok\":true,\"surface\":\"submit\"}\n"
          };
        }
      },
      publicBaseUrl: "https://api.watasu.ai",
      requestVersions: new InMemoryRequestVersionRepository(),
      metadataApp: {
        async handle() {
          throw new Error("metadata app must not handle submit route");
        }
      }
    });

    // Act
    const response = await app.handle(createRequest({
      method: "POST",
      path: "/requests/event-attendee-intake/submit"
    }));

    // Assert
    expect(response.status).toBe(202);
    expect(parseJson(response.body)).toEqual({
      ok: true,
      surface: "submit"
    });
    expect(handledPaths).toEqual(["/requests/event-attendee-intake/submit"]);
  });

  test("test_retired_agent_card_and_schema_and_submit_routes_return_gone", async () => {
    // Arrange
    const requestVersions = new InMemoryRequestVersionRepository();
    const published = requestVersions.publish("event-attendee-intake", definition);
    const registry = new InMemoryPublishedRequestRegistry();
    registry.recordPublished({
      tenant_id: "tenant-a",
      owner_id: "owner-a",
      request_id: published.request_id,
      request_version: published.request_version,
      published_at: published.published_at,
      retired_at: null
    });
    registry.retireRequest({
      serviceIdentity: {
        tenant_id: "tenant-a",
        owner_id: "owner-a",
        roles: ["publisher"]
      },
      requestId: "event-attendee-intake",
      retiredAt: "2026-06-16T00:00:00.000Z"
    });
    const app = createHostedProductionApp({
      publishApp: {
        async handle() {
          throw new Error("publish app must not handle retired routes");
        }
      },
      submitApp: createUnexpectedSubmitApp("retired submit"),
      publicBaseUrl: "https://api.watasu.ai",
      requestVersions,
      isRequestRetired: registry.isRetired.bind(registry),
      metadataApp: {
        async handle() {
          throw new Error("metadata app must not handle retired routes");
        }
      }
    });

    // Act
    const agentCardResponse = await app.handle(createRequest({
      method: "GET",
      path: "/requests/event-attendee-intake/agent-card.json"
    }));
    const schemaResponse = await app.handle(createRequest({
      method: "GET",
      path: "/requests/event-attendee-intake/schemas/plaintext.json"
    }));
    const submitResponse = await app.handle(createRequest({
      method: "POST",
      path: "/requests/event-attendee-intake/submit"
    }));

    // Assert
    expect(agentCardResponse.status).toBe(410);
    expect(schemaResponse.status).toBe(410);
    expect(submitResponse.status).toBe(410);
    expect(parseJson(agentCardResponse.body)).toEqual({
      ok: false,
      error: {
        code: "request_retired",
        message: "Published request has been retired."
      }
    });
  });

  test("test_post_retire_route_is_delegated_to_hosted_retire_app", async () => {
    // Arrange
    const registry = new InMemoryPublishedRequestRegistry();
    registry.recordPublished({
      tenant_id: "tenant-a",
      owner_id: "owner-a",
      request_id: "event-attendee-intake",
      request_version: "v1",
      published_at: "2026-06-16T00:00:00.000Z",
      retired_at: null
    });
    const app = createHostedProductionApp({
      publishApp: {
        async handle() {
          throw new Error("publish app must not handle retire route");
        }
      },
      retireApp: createHostedRetireApp({
        registry,
        resolveServiceIdentity: () => ({
          tenant_id: "tenant-a",
          owner_id: "owner-a",
          roles: ["publisher"]
        }),
        clock: () => new Date("2026-06-16T01:00:00.000Z")
      }),
      submitApp: createUnexpectedSubmitApp("retire"),
      publicBaseUrl: "https://api.watasu.ai",
      requestVersions: new InMemoryRequestVersionRepository(),
      metadataApp: {
        async handle() {
          throw new Error("metadata app must not handle retire route");
        }
      }
    });

    // Act
    const response = await app.handle(createRequest({
      method: "POST",
      path: "/requests/event-attendee-intake/retire"
    }));

    // Assert
    expect(response.status).toBe(200);
    expect(parseJson(response.body)).toMatchObject({
      ok: true,
      retired: {
        request_id: "event-attendee-intake",
        retired_at: "2026-06-16T01:00:00.000Z"
      }
    });
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
      submitApp: createUnexpectedSubmitApp("metadata"),
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

  test.each([
    ["GET", "/requests/event%2Funsafe/agent-card.json"],
    ["GET", "/requests/event%2Funsafe/schemas/plaintext.json"],
    ["GET", "/requests/event%2Funsafe/schemas/envelope.json"],
    ["POST", "/requests/event%2Funsafe/publish"],
    ["POST", "/requests/event%2Funsafe/submit"],
    ["GET", "/requests/event%2Funsafe/ledger"]
  ])("test_hosted_routes_reject_encoded_slash_request_id", async (method, path) => {
    // Arrange
    const requestVersions = new InMemoryRequestVersionRepository();
    requestVersions.publish("event/unsafe", definition);
    const app = createHostedProductionApp({
      publishApp: {
        async handle() {
          throw new Error("publish app must not handle unsafe request id route");
        }
      },
      submitApp: createUnexpectedSubmitApp("unsafe request id"),
      publicBaseUrl: "https://api.watasu.ai",
      requestVersions,
      metadataApp: {
        async handle() {
          throw new Error("metadata app must not handle unsafe request id route");
        }
      }
    });

    // Act
    const response = await app.handle(createRequest({
      method,
      path
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

  test("test_unknown_hosted_route_returns_not_found", async () => {
    // Arrange
    const app = createHostedProductionApp({
      publishApp: {
        async handle() {
          throw new Error("publish app must not handle unknown route");
        }
      },
      submitApp: createUnexpectedSubmitApp("unknown"),
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
