import {
  buildAgentCard,
  generateEncryptedEnvelopeSchema,
  generatePlaintextPayloadSchema,
  type PublishedRequestVersion
} from "@watasu/core";
import type {
  HostedMetadataApp,
  HostedMetadataRequest,
  HostedMetadataResponse
} from "./hosted-metadata.js";
import type {
  HostedPublishApp,
  HostedPublishRequest,
  HostedPublishResponse
} from "./hosted-publish.js";
import type {
  HostedSubmitApp,
  HostedSubmitRequest,
  HostedSubmitResponse,
  HostedRequestVersionReader
} from "./hosted-submit.js";
import { decodeHostedRequestIdSegment } from "./hosted-route.js";

export type HostedProductionRequest = HostedPublishRequest & HostedMetadataRequest & HostedSubmitRequest;
export type HostedProductionResponse = HostedPublishResponse & HostedMetadataResponse & HostedSubmitResponse;

export interface HostedProductionApp {
  handle(request: HostedProductionRequest): Promise<HostedProductionResponse>;
}

export interface CreateHostedProductionAppInput {
  publishApp: HostedPublishApp;
  metadataApp: HostedMetadataApp;
  submitApp: HostedSubmitApp;
  publicBaseUrl: string;
  requestVersions: HostedRequestVersionReader;
}

export function createHostedProductionApp(input: CreateHostedProductionAppInput): HostedProductionApp {
  return {
    async handle(request) {
      if (request.method === "GET" && request.path === "/health") {
        return jsonResponse(200, {
          ok: true,
          service: "watasu-hosted"
        });
      }

      if (matchActionPath(request, "POST", "publish") !== undefined) {
        return input.publishApp.handle(request);
      }

      if (matchActionPath(request, "POST", "submit") !== undefined) {
        return input.submitApp.handle(request);
      }

      const schemaRequest = matchSchemaPath(request);
      if (schemaRequest !== undefined) {
        const published = latestPublishedRequest(await input.requestVersions.list(schemaRequest.requestId));
        if (published === undefined) {
          return publishedRequestNotFoundResponse();
        }

        return jsonResponse(
          200,
          schemaRequest.schema === "plaintext"
            ? generatePlaintextPayloadSchema(published.definition)
            : generateEncryptedEnvelopeSchema(published.definition, published.hashes)
        );
      }

      const agentCardRequestId = matchAgentCardPath(request);
      if (agentCardRequestId !== undefined) {
        const published = latestPublishedRequest(await input.requestVersions.list(agentCardRequestId));
        if (published === undefined) {
          return publishedRequestNotFoundResponse();
        }

        return jsonResponse(200, buildAgentCard({
          published,
          endpointUrl: `${input.publicBaseUrl}/requests/${encodeURIComponent(published.request_id)}/submit`
        }));
      }

      if (matchActionPath(request, "GET", "ledger") !== undefined) {
        return input.metadataApp.handle(request);
      }

      return jsonResponse(404, {
        ok: false,
        error: {
          code: "not_found",
          message: "Hosted production route was not found."
        }
      });
    }
  };
}

function matchActionPath(
  request: HostedProductionRequest,
  method: string,
  action: "publish" | "submit" | "ledger"
): string | undefined {
  if (request.method !== method) {
    return undefined;
  }

  const match = new RegExp(`^/requests/([^/]+)/${action}$`).exec(request.path);
  if (match === null) {
    return undefined;
  }

  return decodeHostedRequestIdSegment(match[1]);
}

function matchSchemaPath(request: HostedProductionRequest): {
  requestId: string;
  schema: "plaintext" | "envelope";
} | undefined {
  if (request.method !== "GET") {
    return undefined;
  }

  const match = /^\/requests\/([^/]+)\/schemas\/(plaintext|envelope)\.json$/.exec(request.path);
  if (match === null) {
    return undefined;
  }

  const requestId = decodeHostedRequestIdSegment(match[1]);
  const schema = match[2];
  if (requestId === undefined || (schema !== "plaintext" && schema !== "envelope")) {
    return undefined;
  }

  return {
    requestId,
    schema
  };
}

function matchAgentCardPath(request: HostedProductionRequest): string | undefined {
  if (request.method !== "GET") {
    return undefined;
  }

  const match = /^\/requests\/([^/]+)\/agent-card\.json$/.exec(request.path);
  if (match === null) {
    return undefined;
  }

  return decodeHostedRequestIdSegment(match[1]);
}

function latestPublishedRequest(versions: PublishedRequestVersion[]): PublishedRequestVersion | undefined {
  return versions.at(-1);
}

function publishedRequestNotFoundResponse(): HostedProductionResponse {
  return jsonResponse(404, {
    ok: false,
    error: {
      code: "request_version_not_found",
      message: "Published request was not found."
    }
  });
}

function jsonResponse(status: number, value: unknown): HostedProductionResponse {
  return {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8"
    },
    body: `${JSON.stringify(value)}\n`
  };
}
