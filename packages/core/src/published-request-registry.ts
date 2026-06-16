import type { HostedServiceIdentity } from "./storage-policy.js";

export interface PublishedRequestRecord {
  tenant_id: string;
  owner_id: string;
  request_id: string;
  request_version: string;
  published_at: string;
  retired_at: string | null;
}

export type RequestRetireResult =
  | {
      ok: true;
      record: PublishedRequestRecord;
    }
  | {
      ok: false;
      status: "forbidden" | "not_found";
      error: {
        code: "request_owner_required" | "request_not_found";
        message: string;
      };
    };

export interface PublishedRequestRegistry {
  recordPublished(input: PublishedRequestRecord): void | Promise<void>;
  retireRequest(input: {
    serviceIdentity: HostedServiceIdentity;
    requestId: string;
    retiredAt: string;
  }): RequestRetireResult | Promise<RequestRetireResult>;
  isRetired(requestId: string): boolean | Promise<boolean>;
  listRecords(): PublishedRequestRecord[] | Promise<PublishedRequestRecord[]>;
}

export class InMemoryPublishedRequestRegistry implements PublishedRequestRegistry {
  readonly #recordsByRequestId = new Map<string, PublishedRequestRecord>();

  recordPublished(input: PublishedRequestRecord): void {
    this.#recordsByRequestId.set(input.request_id, { ...input });
  }

  retireRequest(input: {
    serviceIdentity: HostedServiceIdentity;
    requestId: string;
    retiredAt: string;
  }): RequestRetireResult {
    const record = this.#recordsByRequestId.get(input.requestId);
    if (record === undefined) {
      return {
        ok: false,
        status: "not_found",
        error: {
          code: "request_not_found",
          message: "Published request was not found."
        }
      };
    }

    const isOwner = input.serviceIdentity.owner_id === record.owner_id &&
      input.serviceIdentity.tenant_id === record.tenant_id;
    const isAdmin = input.serviceIdentity.roles.includes("request_admin");
    if (!isOwner && !isAdmin) {
      return {
        ok: false,
        status: "forbidden",
        error: {
          code: "request_owner_required",
          message: "Retiring this request requires the owner or request_admin role."
        }
      };
    }

    record.retired_at = input.retiredAt;

    return {
      ok: true,
      record: { ...record }
    };
  }

  isRetired(requestId: string): boolean {
    return this.#recordsByRequestId.get(requestId)?.retired_at !== null &&
      this.#recordsByRequestId.get(requestId)?.retired_at !== undefined;
  }

  listRecords(): PublishedRequestRecord[] {
    return [...this.#recordsByRequestId.values()].map((record) => ({ ...record }));
  }
}
