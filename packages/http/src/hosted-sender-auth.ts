import type {
  Sha256Hash,
  TrustedSenderPublicKey,
  TrustedInviteBinding
} from "@watasu/core";

export type HostedSenderTrustRecordStatus = "active" | "revoked" | "rotated";

export interface HostedSenderKeyRecord {
  tenant_id: string;
  request_id: string;
  request_version: string;
  sender_key_id: string;
  alg: TrustedSenderPublicKey["alg"];
  public_jwk: TrustedSenderPublicKey["public_jwk"];
  status: HostedSenderTrustRecordStatus;
  not_before: string;
  expires_at: string;
  created_at?: string | undefined;
  revoked_at?: string | undefined;
  rotated_from_sender_key_id?: string | undefined;
}

export interface HostedPrivateInviteRecord {
  tenant_id: string;
  request_id: string;
  request_version: string;
  invite_id: string;
  sender_key_id: string;
  capability_hash: Sha256Hash;
  status: "active" | "revoked";
  expires_at: string;
  revoked_at?: string | undefined;
}

export interface HostedSenderTrustInput {
  tenantId: string;
  requestId: string;
  requestVersion: string;
  capabilityHash: Sha256Hash;
  senderKeyId?: string | undefined;
  inviteId?: string | undefined;
  now: Date;
}

export interface HostedSenderTrustResult {
  trustedSenderKeyIds: string[];
  trustedSenderPublicKeys: TrustedSenderPublicKey[];
  trustedInvites: TrustedInviteBinding[];
}

export interface CreateHostedSenderTrustResolverInput {
  senderKeys: HostedSenderKeyRecord[];
  privateInvites: HostedPrivateInviteRecord[];
}

export type HostedSenderTrustResolver = (
  input: HostedSenderTrustInput
) => HostedSenderTrustResult;

export class InMemoryHostedSenderKeyRegistry {
  readonly #recordsByTenantAndKey = new Map<string, HostedSenderKeyRecord>();

  registerSenderKey(input: {
    tenant_id: string;
    request_id: string;
    request_version: string;
    sender_key_id: string;
    alg: TrustedSenderPublicKey["alg"];
    public_jwk: TrustedSenderPublicKey["public_jwk"];
    not_before: string;
    expires_at: string;
    created_at: string;
    rotated_from_sender_key_id?: string | undefined;
  }): HostedSenderKeyRecord {
    const record: HostedSenderKeyRecord = {
      tenant_id: input.tenant_id,
      request_id: input.request_id,
      request_version: input.request_version,
      sender_key_id: input.sender_key_id,
      alg: input.alg,
      public_jwk: input.public_jwk,
      status: "active",
      not_before: input.not_before,
      expires_at: input.expires_at,
      created_at: input.created_at,
      rotated_from_sender_key_id: input.rotated_from_sender_key_id
    };
    this.#recordsByTenantAndKey.set(recordKey(input.tenant_id, input.sender_key_id), record);

    return structuredClone(record);
  }

  revokeSenderKey(input: {
    tenant_id: string;
    sender_key_id: string;
    revoked_at: string;
  }): void {
    const key = recordKey(input.tenant_id, input.sender_key_id);
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

  rotateSenderKey(input: {
    tenant_id: string;
    previous_sender_key_id: string;
    next_sender_key_id: string;
    alg: TrustedSenderPublicKey["alg"];
    public_jwk: TrustedSenderPublicKey["public_jwk"];
    not_before: string;
    expires_at: string;
    rotated_at: string;
  }): HostedSenderKeyRecord | undefined {
    const previousKey = recordKey(input.tenant_id, input.previous_sender_key_id);
    const previous = this.#recordsByTenantAndKey.get(previousKey);
    if (previous === undefined) {
      return undefined;
    }

    this.#recordsByTenantAndKey.set(previousKey, {
      ...previous,
      status: "rotated",
      revoked_at: input.rotated_at
    });

    return this.registerSenderKey({
      tenant_id: previous.tenant_id,
      request_id: previous.request_id,
      request_version: previous.request_version,
      sender_key_id: input.next_sender_key_id,
      alg: input.alg,
      public_jwk: input.public_jwk,
      not_before: input.not_before,
      expires_at: input.expires_at,
      created_at: input.rotated_at,
      rotated_from_sender_key_id: previous.sender_key_id
    });
  }

  listSenderKeys(): HostedSenderKeyRecord[] {
    return [...this.#recordsByTenantAndKey.values()].map((record) => structuredClone(record));
  }
}

export function createHostedSenderTrustResolver(
  input: CreateHostedSenderTrustResolverInput
): HostedSenderTrustResolver {
  return (trustInput) => {
    const trustedSenderKeyIds = input.senderKeys
      .filter((record) => isTrustedSenderKey(record, trustInput))
      .map((record) => record.sender_key_id);
    const trustedSenderPublicKeys = input.senderKeys
      .filter((record) => isTrustedSenderKey(record, trustInput))
      .map((record) => ({
        sender_key_id: record.sender_key_id,
        alg: record.alg,
        public_jwk: record.public_jwk
      }));
    const trustedInvites = input.privateInvites
      .filter((record) => isTrustedInvite(record, trustInput, trustedSenderKeyIds))
      .map((record) => ({
        invite_id: record.invite_id,
        sender_key_id: record.sender_key_id
      }));

    return {
      trustedSenderKeyIds,
      trustedSenderPublicKeys,
      trustedInvites
    };
  };
}

function isTrustedSenderKey(
  record: HostedSenderKeyRecord,
  input: HostedSenderTrustInput
): boolean {
  return (
    record.tenant_id === input.tenantId &&
    record.request_id === input.requestId &&
    record.request_version === input.requestVersion &&
    record.status === "active" &&
    record.revoked_at === undefined &&
    isWithinValidityWindow(record.not_before, record.expires_at, input.now) &&
    (input.senderKeyId === undefined || record.sender_key_id === input.senderKeyId)
  );
}

function isTrustedInvite(
  record: HostedPrivateInviteRecord,
  input: HostedSenderTrustInput,
  trustedSenderKeyIds: string[]
): boolean {
  return (
    record.tenant_id === input.tenantId &&
    record.request_id === input.requestId &&
    record.request_version === input.requestVersion &&
    record.capability_hash === input.capabilityHash &&
    record.status === "active" &&
    record.revoked_at === undefined &&
    new Date(record.expires_at).getTime() > input.now.getTime() &&
    trustedSenderKeyIds.includes(record.sender_key_id) &&
    (input.senderKeyId === undefined || record.sender_key_id === input.senderKeyId) &&
    (input.inviteId === undefined || record.invite_id === input.inviteId)
  );
}

function isWithinValidityWindow(notBefore: string, expiresAt: string, now: Date): boolean {
  const nowMs = now.getTime();
  return new Date(notBefore).getTime() <= nowMs && nowMs < new Date(expiresAt).getTime();
}

function recordKey(tenantId: string, senderKeyId: string): string {
  return `${tenantId}:${senderKeyId}`;
}
