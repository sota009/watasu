import { describe, expect, test } from "vitest";
import {
  createHostedProductionApp,
  type HostedProductionRequest
} from "./hosted-production.js";

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
