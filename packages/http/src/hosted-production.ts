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
  HostedRetireApp,
  HostedRetireRequest,
  HostedRetireResponse
} from "./hosted-retire.js";
import type {
  HostedSubmitApp,
  HostedSubmitRequest,
  HostedSubmitResponse,
  HostedRequestVersionReader
} from "./hosted-submit.js";
import type {
  HostedConsentApp,
  HostedConsentRequest,
  HostedConsentResponse
} from "./hosted-consent.js";
import { decodeHostedRequestIdSegment } from "./hosted-route.js";

export type HostedProductionRequest = HostedPublishRequest &
  HostedMetadataRequest &
  HostedSubmitRequest &
  HostedRetireRequest &
  HostedConsentRequest;
export type HostedProductionResponse = HostedPublishResponse &
  HostedMetadataResponse &
  HostedSubmitResponse &
  HostedRetireResponse &
  HostedConsentResponse;

export interface HostedProductionApp {
  handle(request: HostedProductionRequest): Promise<HostedProductionResponse>;
}

export interface CreateHostedProductionAppInput {
  publishApp: HostedPublishApp;
  retireApp?: HostedRetireApp | undefined;
  metadataApp: HostedMetadataApp;
  submitApp: HostedSubmitApp;
  consentApp?: HostedConsentApp | undefined;
  publicBaseUrl: string;
  requestVersions: HostedRequestVersionReader;
  isRequestRetired?: ((requestId: string) => boolean | Promise<boolean>) | undefined;
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

      const retireRequestId = matchActionPath(request, "POST", "retire");
      if (retireRequestId !== undefined) {
        return input.retireApp === undefined
          ? jsonResponse(404, {
              ok: false,
              error: {
                code: "not_found",
                message: "Hosted production route was not found."
              }
            })
          : input.retireApp.handle(request);
      }

      const submitRequestId = matchActionPath(request, "POST", "submit");
      if (submitRequestId !== undefined) {
        if (await isRetired(input, submitRequestId)) {
          return publishedRequestGoneResponse();
        }

        return input.submitApp.handle(request);
      }

      if (input.consentApp !== undefined && isConsentPath(request.path)) {
        return input.consentApp.handle(request);
      }

      const schemaRequest = matchSchemaPath(request);
      if (schemaRequest !== undefined) {
        if (await isRetired(input, schemaRequest.requestId)) {
          return publishedRequestGoneResponse();
        }

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
        if (await isRetired(input, agentCardRequestId)) {
          return publishedRequestGoneResponse();
        }

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
  action: "publish" | "submit" | "ledger" | "retire"
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

function isConsentPath(path: string): boolean {
  return /^\/requests\/[^/]+\/consent\/[^/]+(\/approve|\/status)?$/.test(path);
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

async function isRetired(
  input: CreateHostedProductionAppInput,
  requestId: string
): Promise<boolean> {
  return await input.isRequestRetired?.(requestId) ?? false;
}

function publishedRequestGoneResponse(): HostedProductionResponse {
  return jsonResponse(410, {
    ok: false,
    error: {
      code: "request_retired",
      message: "Published request has been retired."
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
