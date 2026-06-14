import {
  publishRequestVersion,
  validateRequestDefinitionInput,
  type HostedServiceIdentity,
  type PublishOwnershipVerification,
  type RequestDefinition,
  type RequestVersionPublisher
} from "@watasu/core";
import { decodeHostedRequestIdSegment } from "./hosted-route.js";

export interface HostedPublishRequest {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  body: string;
}

export interface HostedPublishResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface HostedPublishApp {
  handle(request: HostedPublishRequest): Promise<HostedPublishResponse>;
}

export interface CreateHostedPublishAppInput {
  repository: RequestVersionPublisher;
  resolveServiceIdentity(request: HostedPublishRequest): HostedServiceIdentity | undefined;
  resolveOwnershipVerification(input: {
    serviceIdentity: HostedServiceIdentity;
    request: HostedPublishRequest;
    requestId: string;
    definition: RequestDefinition;
  }): PublishOwnershipVerification;
  generateCapabilityToken?: (() => string) | undefined;
}

export function createHostedPublishApp(input: CreateHostedPublishAppInput): HostedPublishApp {
  return {
    async handle(request) {
      if (request.method !== "POST") {
        return jsonResponse(404, {
          ok: false,
          error: {
            code: "not_found",
            message: "Hosted publish route was not found."
          }
        });
      }

      const requestId = matchPublishPath(request.path);
      if (requestId === undefined) {
        return jsonResponse(404, {
          ok: false,
          error: {
            code: "not_found",
            message: "Hosted publish route was not found."
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
            message: "Hosted publish requires an authenticated service identity."
          }
        });
      }

      if (!serviceIdentity.roles.includes("publisher")) {
        return jsonResponse(403, {
          ok: false,
          status: "forbidden",
          error: {
            code: "publisher_role_required",
            message: "Publishing hosted requests requires the publisher role."
          }
        });
      }

      const parsedBody = parseJsonBody(request.body);
      if (!parsedBody.ok || !isHostedPublishBody(parsedBody.value)) {
        return jsonResponse(400, {
          ok: false,
          status: "rejected",
          error: {
            code: "invalid_publish_body",
            message: "Hosted publish body must include definition and confirmed."
          }
        });
      }

      const definitionValidation = validateRequestDefinitionInput(
        JSON.stringify(parsedBody.value.definition)
      );
      if (!definitionValidation.ok) {
        return jsonResponse(400, {
          ok: false,
          status: "rejected",
          error: definitionValidation.errors[0]
        });
      }

      const result = publishRequestVersion({
        requestId,
        definition: definitionValidation.definition,
        confirmed: parsedBody.value.confirmed,
        mode: "hosted",
        repository: input.repository,
        ownership: input.resolveOwnershipVerification({
          serviceIdentity,
          request,
          requestId,
          definition: definitionValidation.definition
        }),
        generateCapabilityToken: input.generateCapabilityToken
      });

      if (!result.ok) {
        return jsonResponse(400, {
          ok: false,
          status: "rejected",
          error: result.error
        });
      }

      return jsonResponse(201, {
        ok: true,
        published: result.published
      });
    }
  };
}

function parseJsonBody(body: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: body.length === 0 ? {} : JSON.parse(body) };
  } catch {
    return { ok: false };
  }
}

function isHostedPublishBody(value: unknown): value is {
  definition: unknown;
  confirmed: boolean;
} {
  return (
    isRecord(value) &&
    "definition" in value &&
    typeof value.confirmed === "boolean"
  );
}

function matchPublishPath(path: string): string | undefined {
  const match = /^\/requests\/([^/]+)\/publish$/.exec(path);
  if (match === null) {
    return undefined;
  }

  return decodeHostedRequestIdSegment(match[1]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonResponse(status: number, value: unknown): HostedPublishResponse {
  return {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8"
    },
    body: `${JSON.stringify(value)}\n`
  };
}
