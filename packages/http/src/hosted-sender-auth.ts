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
  alg: "ES256";
  public_jwk: TrustedSenderPublicKey["public_jwk"];
  status: HostedSenderTrustRecordStatus;
  not_before: string;
  expires_at: string;
  revoked_at?: string | undefined;
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
