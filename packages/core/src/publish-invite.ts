import { sha256Hash, type Sha256Hash } from "./hash.js";
import type { HostedServiceIdentity, HostedServiceRole } from "./storage-policy.js";

export interface PublishInviteRecord {
  token_hash: Sha256Hash;
  owner_id: string;
  tenant_id: string;
  roles: HostedServiceRole[];
  expires_at: string;
  max_publish_count: number;
  used_count: number;
  revoked_at: string | null;
}

export type PublishInviteResolutionResult =
  | {
      ok: true;
      identity: HostedServiceIdentity;
    }
  | {
      ok: false;
      status: "auth_required" | "forbidden";
      error: {
        code: "invalid_invite_token" | "invite_expired" | "invite_revoked" | "invite_quota_exceeded";
        message: string;
      };
    };

export interface PublishInviteStore {
  resolveToken(token: string, now?: Date | undefined): PublishInviteResolutionResult;
  incrementPublishCount(token: string): void;
  listRecords(): PublishInviteRecord[];
}

export class InMemoryPublishInviteStore implements PublishInviteStore {
  readonly #recordsByHash = new Map<Sha256Hash, PublishInviteRecord>();

  issueInvite(input: {
    token: string;
    ownerId: string;
    tenantId: string;
    roles: HostedServiceRole[];
    expiresAt: string;
    maxPublishCount: number;
  }): PublishInviteRecord {
    const record: PublishInviteRecord = {
      token_hash: sha256Hash(input.token),
      owner_id: input.ownerId,
      tenant_id: input.tenantId,
      roles: [...input.roles],
      expires_at: input.expiresAt,
      max_publish_count: input.maxPublishCount,
      used_count: 0,
      revoked_at: null
    };
    this.#recordsByHash.set(record.token_hash, record);

    return { ...record, roles: [...record.roles] };
  }

  revokeToken(token: string, revokedAt: string): void {
    const record = this.#recordsByHash.get(sha256Hash(token));
    if (record !== undefined) {
      record.revoked_at = revokedAt;
    }
  }

  resolveToken(token: string, now: Date = new Date()): PublishInviteResolutionResult {
    const record = this.#recordsByHash.get(sha256Hash(token));
    if (record === undefined) {
      return {
        ok: false,
        status: "auth_required",
        error: {
          code: "invalid_invite_token",
          message: "Invite token is invalid."
        }
      };
    }

    if (record.revoked_at !== null) {
      return {
        ok: false,
        status: "forbidden",
        error: {
          code: "invite_revoked",
          message: "Invite token has been revoked."
        }
      };
    }

    if (new Date(record.expires_at).getTime() <= now.getTime()) {
      return {
        ok: false,
        status: "forbidden",
        error: {
          code: "invite_expired",
          message: "Invite token has expired."
        }
      };
    }

    if (record.used_count >= record.max_publish_count) {
      return {
        ok: false,
        status: "forbidden",
        error: {
          code: "invite_quota_exceeded",
          message: "Invite token publish quota has been exhausted."
        }
      };
    }

    return {
      ok: true,
      identity: {
        tenant_id: record.tenant_id,
        owner_id: record.owner_id,
        roles: [...record.roles]
      }
    };
  }

  incrementPublishCount(token: string): void {
    const record = this.#recordsByHash.get(sha256Hash(token));
    if (record !== undefined) {
      record.used_count += 1;
    }
  }

  listRecords(): PublishInviteRecord[] {
    return [...this.#recordsByHash.values()].map((record) => ({
      ...record,
      roles: [...record.roles]
    }));
  }
}
