import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { sha256Hash, type Sha256Hash } from "./hash.js";
import type { RequestDefinition, RequestDefinitionError } from "./request-definition.js";
import type { PublishedRequestVersion } from "./request-version.js";

export type PublishMode = "hosted" | "local_demo";

export interface RequestVersionPublisher {
  publish(requestId: string, definition: RequestDefinition): PublishedRequestVersion;
}

export interface AsyncRequestVersionPublisher {
  publish(
    requestId: string,
    definition: RequestDefinition
  ): PublishedRequestVersion | Promise<PublishedRequestVersion>;
}

export interface PublishOwnershipVerification {
  verifiedServiceKeyIds: string[];
  verifiedWebhookOrigins: string[];
}

export type PublishRequestVersionResult =
  | {
      ok: true;
      published: PublishedRequestVersionWithCapability;
    }
  | {
      ok: false;
      error: RequestDefinitionError;
    };

export interface PublishedRequestVersionWithCapability extends PublishedRequestVersion {
  capability: {
    token_hash: Sha256Hash;
  };
}

export function publishRequestVersion(input: {
  requestId: string;
  definition: RequestDefinition;
  confirmed: boolean;
  mode: PublishMode;
  repository: RequestVersionPublisher;
  generateCapabilityToken?: (() => string) | undefined;
  ownership?: PublishOwnershipVerification | undefined;
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

  const destinationError = validateDestinationForMode(input.definition, input.mode, input.ownership);
  if (destinationError !== undefined) {
    return {
      ok: false,
      error: destinationError
    };
  }

  const capabilityToken = input.generateCapabilityToken?.() ?? generateCapabilityToken();
  const published = input.repository.publish(input.requestId, input.definition);

  return {
    ok: true,
    published: {
      ...published,
      capability: {
        token_hash: sha256Hash(capabilityToken)
      }
    }
  };
}

export async function publishRequestVersionAsync(input: {
  requestId: string;
  definition: RequestDefinition;
  confirmed: boolean;
  mode: PublishMode;
  repository: AsyncRequestVersionPublisher;
  generateCapabilityToken?: (() => string) | undefined;
  ownership?: PublishOwnershipVerification | undefined;
}): Promise<PublishRequestVersionResult> {
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

  const destinationError = validateDestinationForMode(input.definition, input.mode, input.ownership);
  if (destinationError !== undefined) {
    return {
      ok: false,
      error: destinationError
    };
  }

  const capabilityToken = input.generateCapabilityToken?.() ?? generateCapabilityToken();
  const published = await input.repository.publish(input.requestId, input.definition);

  return {
    ok: true,
    published: {
      ...published,
      capability: {
        token_hash: sha256Hash(capabilityToken)
      }
    }
  };
}

function validateDestinationForMode(
  definition: RequestDefinition,
  mode: PublishMode,
  ownership: PublishOwnershipVerification | undefined
): RequestDefinitionError | undefined {
  if (mode === "hosted" && definition.trust_profile === "local_demo") {
    return {
      code: "local_demo_not_allowed_in_hosted_publish",
      path: "trust_profile",
      message: "Hosted publish cannot use the local_demo trust profile."
    };
  }

  const destinationUrl = new URL(definition.destination.url);

  if (mode === "hosted" && destinationUrl.protocol !== "https:") {
    return {
      code: "unsafe_destination",
      path: "destination.url",
      message: "Hosted publish requires an HTTPS webhook destination."
    };
  }

  if (mode === "hosted" && isUnsafeHostedDestination(destinationUrl.hostname)) {
    return {
      code: "unsafe_destination",
      path: "destination.url",
      message: "Hosted publish cannot deliver to localhost, private IP, or metadata service destinations."
    };
  }

  if (
    mode === "hosted" &&
    !ownership?.verifiedServiceKeyIds.includes(definition.encryption.service_key_id)
  ) {
    return {
      code: "service_key_not_verified",
      path: "encryption.service_key_id",
      message: "Hosted publish requires service public key ownership verification."
    };
  }

  if (
    mode === "hosted" &&
    !ownership?.verifiedWebhookOrigins.includes(destinationUrl.origin)
  ) {
    return {
      code: "webhook_origin_not_verified",
      path: "destination.url",
      message: "Hosted publish requires destination webhook origin ownership verification."
    };
  }

  return undefined;
}

function isUnsafeHostedDestination(hostname: string): boolean {
  const normalizedHostname = hostname.replace(/^\[|\]$/g, "");
  if (normalizedHostname === "localhost") {
    return true;
  }

  if (isIP(normalizedHostname) === 0) {
    return false;
  }

  if (normalizedHostname === "::1" || normalizedHostname.toLowerCase().startsWith("fe80:")) {
    return true;
  }

  const octets = normalizedHostname.split(".").map((part) => Number.parseInt(part, 10));
  if (octets.length !== 4 || octets.some((octet) => Number.isNaN(octet))) {
    return false;
  }

  const first = octets[0] ?? -1;
  const second = octets[1] ?? -1;
  return (
    first === 10 ||
    first === 127 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254) ||
    first === 0
  );
}

function generateCapabilityToken(): string {
  return `cap_${randomBytes(32).toString("base64url")}`;
}
