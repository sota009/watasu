import type {
  HostedServiceIdentity,
  HostedServiceRole
} from "@watasu/core";
import type {
  PublishInviteResolutionResult,
  PublishInviteStore
} from "@watasu/core";
import type { HostedMetadataRequest } from "./hosted-metadata.js";

export interface TrustedServicePrincipal {
  tenant_id: string;
  owner_id?: string | undefined;
  roles: string[];
}

export interface CreateTrustedServiceIdentityResolverInput {
  resolvePrincipal(request: HostedMetadataRequest): TrustedServicePrincipal | undefined;
}

export type HostedServiceIdentityResolver = (
  request: HostedMetadataRequest
) => HostedServiceIdentity | undefined;

const hostedServiceRoles: readonly HostedServiceRole[] = [
  "publisher",
  "request_admin",
  "key_admin",
  "ledger_viewer",
  "auditor"
];

export function createTrustedServiceIdentityResolver(
  input: CreateTrustedServiceIdentityResolverInput
): HostedServiceIdentityResolver {
  return (request) => {
    const principal = input.resolvePrincipal(request);
    if (principal === undefined) {
      return undefined;
    }

    const tenantId = principal.tenant_id.trim();
    if (tenantId.length === 0) {
      return undefined;
    }

    if (!Array.isArray(principal.roles)) {
      return undefined;
    }

    return {
      tenant_id: tenantId,
      owner_id: principal.owner_id,
      roles: normalizeRoles(principal.roles)
    };
  };
}

export function createInviteServiceIdentityResolver(input: {
  inviteStore: PublishInviteStore;
  now?: (() => Date) | undefined;
  onResult?: ((result: PublishInviteResolutionResult, bearerCredential: string | undefined) => void) | undefined;
}): HostedServiceIdentityResolver {
  return (request) => {
    const bearerCredential = parseAuthorizationBearerToken(request.headers.authorization);
    if (bearerCredential === undefined) {
      input.onResult?.({
        ok: false,
        status: "auth_required",
        error: {
          code: "invalid_invite_token",
          message: "Invite token is invalid."
        }
      }, undefined);
      return undefined;
    }

    const result = input.inviteStore.resolveToken(bearerCredential, input.now?.());
    input.onResult?.(result, bearerCredential);

    return result.ok ? result.identity : undefined;
  };
}

export function parseAuthorizationBearerToken(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const match = /^Bearer ([A-Za-z0-9._~+/=-]+)$/.exec(value.trim());
  return match?.[1];
}

function normalizeRoles(roles: string[]): HostedServiceRole[] {
  const normalizedRoles: HostedServiceRole[] = [];

  for (const role of roles) {
    if (!isHostedServiceRole(role) || normalizedRoles.includes(role)) {
      continue;
    }

    normalizedRoles.push(role);
  }

  return normalizedRoles;
}

function isHostedServiceRole(role: string): role is HostedServiceRole {
  return hostedServiceRoles.includes(role as HostedServiceRole);
}
