import type {
  HostedServiceIdentity,
  PublishedRequestRegistry
} from "@watasu/core";
import { decodeHostedRequestIdSegment } from "./hosted-route.js";

export interface HostedRetireRequest {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  body: string;
}

export interface HostedRetireResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface HostedRetireApp {
  handle(request: HostedRetireRequest): Promise<HostedRetireResponse>;
}

export function createHostedRetireApp(input: {
  registry: PublishedRequestRegistry;
  resolveServiceIdentity(request: HostedRetireRequest): HostedServiceIdentity | undefined;
  clock: () => Date;
}): HostedRetireApp {
  return {
    async handle(request) {
      if (request.method !== "POST") {
        return jsonResponse(404, {
          ok: false,
          error: {
            code: "not_found",
            message: "Hosted retire route was not found."
          }
        });
      }

      const requestId = matchRetirePath(request.path);
      if (requestId === undefined) {
        return jsonResponse(404, {
          ok: false,
          error: {
            code: "not_found",
            message: "Hosted retire route was not found."
          }
        });
      }

      const serviceIdentity = input.resolveServiceIdentity(request);
      if (serviceIdentity === undefined) {
        return jsonResponse(401, {
          ok: false,
          status: "auth_required",
          error: {
            code: "service_identity_required",
            message: "Hosted retire requires an authenticated service identity."
          }
        });
      }

      const result = await input.registry.retireRequest({
        serviceIdentity,
        requestId,
        retiredAt: input.clock().toISOString()
      });
      if (!result.ok) {
        return jsonResponse(result.status === "not_found" ? 404 : 403, {
          ok: false,
          status: result.status,
          error: result.error
        });
      }

      return jsonResponse(200, {
        ok: true,
        retired: result.record
      });
    }
  };
}

function matchRetirePath(path: string): string | undefined {
  const match = /^\/requests\/([^/]+)\/retire$/.exec(path);
  if (match === null) {
    return undefined;
  }

  return decodeHostedRequestIdSegment(match[1]);
}

function jsonResponse(status: number, value: unknown): HostedRetireResponse {
  return {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8"
    },
    body: `${JSON.stringify(value)}\n`
  };
}
