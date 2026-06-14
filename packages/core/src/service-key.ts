import type { JsonWebKey } from "node:crypto";
import type { OwnershipChallengeVerificationResult } from "./ownership.js";

export type ServiceKeyRecordStatus = "active" | "revoked" | "rotated";

export interface ServiceKeyRecord {
  tenant_id: string;
  service_key_id: string;
  public_jwk: JsonWebKey;
  status: ServiceKeyRecordStatus;
  not_before: string;
  expires_at: string;
  created_at: string;
  verified_at: string;
  revoked_at?: string | undefined;
  rotated_from_service_key_id?: string | undefined;
}

export type ServiceKeyRegistryResult =
  | {
      ok: true;
      record: ServiceKeyRecord;
    }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
      };
    };

export interface ServiceKeyOwnershipState {
  verifiedServiceKeyIds: string[];
}

export class InMemoryServiceKeyRegistry {
  readonly #recordsByTenantAndKey = new Map<string, ServiceKeyRecord>();

  registerServiceKey(input: {
    tenant_id: string;
    service_key_id: string;
    public_jwk: JsonWebKey;
    ownership: OwnershipChallengeVerificationResult;
    not_before: string;
    expires_at: string;
    created_at: string;
    rotated_from_service_key_id?: string | undefined;
  }): ServiceKeyRegistryResult {
    const ownershipError = validateOwnership(input);
    if (ownershipError !== undefined) {
      return ownershipError;
    }

    const record: ServiceKeyRecord = {
      tenant_id: input.tenant_id,
      service_key_id: input.service_key_id,
      public_jwk: sanitizePublicJwk(input.public_jwk),
      status: "active",
      not_before: input.not_before,
      expires_at: input.expires_at,
      created_at: input.created_at,
      verified_at: input.created_at,
      rotated_from_service_key_id: input.rotated_from_service_key_id
    };
    this.#recordsByTenantAndKey.set(recordKey(input.tenant_id, input.service_key_id), record);

    return {
      ok: true,
      record: structuredClone(record)
    };
  }

  revokeServiceKey(input: {
    tenant_id: string;
    service_key_id: string;
    revoked_at: string;
  }): void {
    const key = recordKey(input.tenant_id, input.service_key_id);
    const existing = this.#recordsByTenantAndKey.get(key);
    if (existing === undefined) {
      return;
    }

    this.#recordsByTenantAndKey.set(key, {
      ...existing,
      status: "revoked",
      revoked_at: input.revoked_at
    });
  }

  rotateServiceKey(input: {
    tenant_id: string;
    previous_service_key_id: string;
    next_service_key_id: string;
    public_jwk: JsonWebKey;
    ownership: OwnershipChallengeVerificationResult;
    not_before: string;
    expires_at: string;
    rotated_at: string;
  }): ServiceKeyRegistryResult {
    const previousKey = recordKey(input.tenant_id, input.previous_service_key_id);
    const previous = this.#recordsByTenantAndKey.get(previousKey);
    if (previous === undefined) {
      return serviceKeyError("service_key_not_found", "Previous service key was not found.");
    }

    const next = this.registerServiceKey({
      tenant_id: input.tenant_id,
      service_key_id: input.next_service_key_id,
      public_jwk: input.public_jwk,
      ownership: input.ownership,
      not_before: input.not_before,
      expires_at: input.expires_at,
      created_at: input.rotated_at,
      rotated_from_service_key_id: input.previous_service_key_id
    });
    if (!next.ok) {
      return next;
    }

    this.#recordsByTenantAndKey.set(previousKey, {
      ...previous,
      status: "rotated",
      revoked_at: input.rotated_at
    });

    return next;
  }

  listServiceKeys(): ServiceKeyRecord[] {
    return [...this.#recordsByTenantAndKey.values()].map((record) => structuredClone(record));
  }

  listActiveVerifiedServiceKeyIds(input: {
    tenant_id: string;
    now: Date;
  }): string[] {
    return this.listServiceKeys()
      .filter((record) =>
        record.tenant_id === input.tenant_id &&
        record.status === "active" &&
        new Date(record.not_before).getTime() <= input.now.getTime() &&
        input.now.getTime() < new Date(record.expires_at).getTime()
      )
      .map((record) => record.service_key_id);
  }
}

export function buildServiceKeyOwnershipVerification(input: {
  tenant_id: string;
  registry: InMemoryServiceKeyRegistry;
  now: Date;
}): ServiceKeyOwnershipState {
  return {
    verifiedServiceKeyIds: input.registry.listActiveVerifiedServiceKeyIds({
      tenant_id: input.tenant_id,
      now: input.now
    })
  };
}

function validateOwnership(input: {
  tenant_id: string;
  service_key_id: string;
  ownership: OwnershipChallengeVerificationResult;
}): ServiceKeyRegistryResult | undefined {
  if (!input.ownership.ok) {
    return serviceKeyError("service_key_ownership_required", "Service key registration requires verified ownership.");
  }

  if (
    input.ownership.tenant_id !== input.tenant_id ||
    input.ownership.service_key_id !== input.service_key_id
  ) {
    return serviceKeyError("service_key_ownership_mismatch", "Service key ownership result does not match registration.");
  }

  return undefined;
}

function sanitizePublicJwk(jwk: JsonWebKey): JsonWebKey {
  const sanitized = structuredClone(jwk);
  delete sanitized.d;
  return sanitized;
}

function recordKey(tenantId: string, serviceKeyId: string): string {
  return `${tenantId}:${serviceKeyId}`;
}

function serviceKeyError(code: string, message: string): ServiceKeyRegistryResult {
  return {
    ok: false,
    error: {
      code,
      message
    }
  };
}
