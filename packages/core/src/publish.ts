import type { RequestDefinition, RequestDefinitionError } from "./request-definition.js";
import type { PublishedRequestVersion } from "./request-version.js";

export type PublishMode = "hosted" | "local_demo";

export interface RequestVersionPublisher {
  publish(requestId: string, definition: RequestDefinition): PublishedRequestVersion;
}

export type PublishRequestVersionResult =
  | {
      ok: true;
      published: PublishedRequestVersion;
    }
  | {
      ok: false;
      error: RequestDefinitionError;
    };

export function publishRequestVersion(input: {
  requestId: string;
  definition: RequestDefinition;
  confirmed: boolean;
  mode: PublishMode;
  repository: RequestVersionPublisher;
}): PublishRequestVersionResult {
  if (!input.confirmed) {
    return {
      ok: false,
      error: {
        code: "publish_requires_confirmation",
        path: "$",
        message: "Publishing requires explicit human confirmation."
      }
    };
  }

  const destinationError = validateDestinationForMode(input.definition, input.mode);
  if (destinationError !== undefined) {
    return {
      ok: false,
      error: destinationError
    };
  }

  return {
    ok: true,
    published: input.repository.publish(input.requestId, input.definition)
  };
}

function validateDestinationForMode(
  definition: RequestDefinition,
  mode: PublishMode
): RequestDefinitionError | undefined {
  if (mode === "hosted" && definition.trust_profile === "local_demo") {
    return {
      code: "local_demo_not_allowed_in_hosted_publish",
      path: "trust_profile",
      message: "Hosted publish cannot use the local_demo trust profile."
    };
  }

  const destinationUrl = new URL(definition.destination.url);

  if (mode === "hosted" && isLocalhost(destinationUrl.hostname)) {
    return {
      code: "unsafe_destination",
      path: "destination.url",
      message: "Hosted publish cannot deliver to localhost destinations."
    };
  }

  return undefined;
}

function isLocalhost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}
