import {
  buildAgentCard,
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
  HostedSubmitResponse
} from "./hosted-submit.js";

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
  requestVersions: {
    list(requestId: string): PublishedRequestVersion[];
  };
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

      if (request.method === "POST" && /^\/requests\/[^/]+\/publish$/.test(request.path)) {
        return input.publishApp.handle(request);
      }

      if (request.method === "POST" && /^\/requests\/[^/]+\/submit$/.test(request.path)) {
        return input.submitApp.handle(request);
      }

      const agentCardRequestId = matchAgentCardPath(request);
      if (agentCardRequestId !== undefined) {
        const published = latestPublishedRequest(input.requestVersions.list(agentCardRequestId));
        if (published === undefined) {
          return jsonResponse(404, {
            ok: false,
            error: {
              code: "request_version_not_found",
              message: "Published request was not found."
            }
          });
        }

        return jsonResponse(200, buildAgentCard({
          published,
          endpointUrl: `${input.publicBaseUrl}/requests/${encodeURIComponent(published.request_id)}/submit`
        }));
      }

      if (request.method === "GET" && /^\/requests\/[^/]+\/ledger$/.test(request.path)) {
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

function matchAgentCardPath(request: HostedProductionRequest): string | undefined {
  if (request.method !== "GET") {
    return undefined;
  }

  const match = /^\/requests\/([^/]+)\/agent-card\.json$/.exec(request.path);
  if (match === null) {
    return undefined;
  }

  try {
    const requestId = decodeURIComponent(match[1] ?? "");
    return requestId.length === 0 ? undefined : requestId;
  } catch {
    return undefined;
  }
}

function latestPublishedRequest(versions: PublishedRequestVersion[]): PublishedRequestVersion | undefined {
  return versions.at(-1);
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
