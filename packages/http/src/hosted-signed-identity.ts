import { createHmac, timingSafeEqual } from "node:crypto";
import type { TrustedServicePrincipal } from "./hosted-identity.js";
import type { HostedProductionRequest } from "./hosted-production.js";

export interface CreateSignedServiceIdentityHeadersInput {
  tenantId: string;
  roles: readonly string[];
  issuedAt: Date;
  signingSecret: string;
}

export interface CreateSignedServiceIdentityPrincipalResolverInput {
  signingSecret: string;
  now: () => Date;
  maxSkewSeconds: number;
}

const tenantHeader = "x-watasu-service-tenant";
const rolesHeader = "x-watasu-service-roles";
const issuedAtHeader = "x-watasu-service-issued-at";
const signatureHeader = "x-watasu-service-signature";

export function createSignedServiceIdentityHeaders(
  input: CreateSignedServiceIdentityHeadersInput
): Record<string, string> {
  const issuedAt = input.issuedAt.toISOString();
  const roles = input.roles.join(",");
  const signaturePayload = buildSignaturePayload({
    tenantId: input.tenantId,
    roles,
    issuedAt
  });

  return {
    [tenantHeader]: input.tenantId,
    [rolesHeader]: roles,
    [issuedAtHeader]: issuedAt,
    [signatureHeader]: `sha256=${signPayload(signaturePayload, input.signingSecret)}`
  };
}

export function createSignedServiceIdentityPrincipalResolver(
  input: CreateSignedServiceIdentityPrincipalResolverInput
): (request: HostedProductionRequest) => TrustedServicePrincipal | undefined {
  return (request) => {
    const tenantId = request.headers[tenantHeader]?.trim();
    const roles = request.headers[rolesHeader]?.trim();
    const issuedAt = request.headers[issuedAtHeader]?.trim();
    const signature = request.headers[signatureHeader]?.trim();
    if (
      tenantId === undefined ||
      tenantId.length === 0 ||
      roles === undefined ||
      issuedAt === undefined ||
      signature === undefined
    ) {
      return undefined;
    }

    if (!isFreshTimestamp({
      issuedAt,
      now: input.now(),
      maxSkewSeconds: input.maxSkewSeconds
    })) {
      return undefined;
    }

    const expectedSignature = `sha256=${signPayload(buildSignaturePayload({
      tenantId,
      roles,
      issuedAt
    }), input.signingSecret)}`;
    if (!timingSafeStringEqual(signature, expectedSignature)) {
      return undefined;
    }

    return {
      tenant_id: tenantId,
      roles: roles.split(",").map((role) => role.trim()).filter((role) => role.length > 0)
    };
  };
}

function buildSignaturePayload(input: {
  tenantId: string;
  roles: string;
  issuedAt: string;
}): string {
  return `${input.tenantId}\n${input.roles}\n${input.issuedAt}`;
}

function signPayload(payload: string, signingSecret: string): string {
  return createHmac("sha256", signingSecret).update(payload).digest("base64url");
}

function isFreshTimestamp(input: {
  issuedAt: string;
  now: Date;
  maxSkewSeconds: number;
}): boolean {
  const issuedAtMs = Date.parse(input.issuedAt);
  if (!Number.isFinite(issuedAtMs)) {
    return false;
  }

  const skewMs = Math.abs(input.now.getTime() - issuedAtMs);
  return skewMs <= input.maxSkewSeconds * 1000;
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}
