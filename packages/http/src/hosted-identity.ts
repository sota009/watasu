import type {
  HostedServiceIdentity,
  HostedServiceRole
} from "@watasu/core";
import type { HostedMetadataRequest } from "./hosted-metadata.js";

export interface TrustedServicePrincipal {
  tenant_id: string;
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
      roles: normalizeRoles(principal.roles)
    };
  };
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
