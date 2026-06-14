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

export type HostedProductionRequest = HostedPublishRequest & HostedMetadataRequest;
export type HostedProductionResponse = HostedPublishResponse & HostedMetadataResponse;

export interface HostedProductionApp {
  handle(request: HostedProductionRequest): Promise<HostedProductionResponse>;
}

export interface CreateHostedProductionAppInput {
  publishApp: HostedPublishApp;
  metadataApp: HostedMetadataApp;
}

export function createHostedProductionApp(input: CreateHostedProductionAppInput): HostedProductionApp {
  return {
    async handle(request) {
      if (request.method === "POST" && /^\/requests\/[^/]+\/publish$/.test(request.path)) {
        return input.publishApp.handle(request);
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

function jsonResponse(status: number, value: unknown): HostedProductionResponse {
  return {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8"
    },
    body: `${JSON.stringify(value)}\n`
  };
}
