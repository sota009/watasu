import type { DeliveryLedger, DeliveryLedgerRow } from "./delivery.js";

export type StoragePolicyMode = "stateless_default" | "metadata_ledger_enabled";

export interface StoragePolicy {
  mode: StoragePolicyMode;
}

export interface PersistentDeliveryLedgerStore {
  writeDeliveryAttempt(row: DeliveryLedgerRow): void;
}

export interface RetentionDeliveryLedgerStore {
  listDeliveryRows(): DeliveryLedgerRow[];
  deleteDeliveryRows(rows: DeliveryLedgerRow[]): void;
}

export interface MetadataLedgerRetentionResult {
  ok: true;
  scanned: number;
  deleted: number;
  retained: number;
}

export type HostedServiceRole =
  | "publisher"
  | "request_admin"
  | "key_admin"
  | "ledger_viewer"
  | "auditor";

export interface HostedServiceIdentity {
  tenant_id: string;
  roles: HostedServiceRole[];
}

export interface MetadataLedgerAuditEvent {
  event: "watasu.metadata_ledger_read";
  tenant_id: string;
  request_id: string;
  role: "ledger_viewer" | "auditor";
  row_count: number;
}

export interface MetadataLedgerAuditLog {
  write(event: MetadataLedgerAuditEvent): void;
}

export type MetadataLedgerReadResult =
  | {
      ok: true;
      rows: DeliveryLedgerRow[];
    }
  | {
      ok: false;
      status: "forbidden" | "not_found";
      error: {
        code: "ledger_role_required" | "request_not_found";
        message: string;
      };
    };

export interface MetadataLedgerReader {
  readDeliveryMetadata(input: {
    serviceIdentity: HostedServiceIdentity;
    requestId: string;
  }): MetadataLedgerReadResult;
}

export function createPolicyControlledDeliveryLedger(input: {
  policy: StoragePolicy;
  operationalLedger: DeliveryLedger;
  persistentStore?: PersistentDeliveryLedgerStore | undefined;
}): DeliveryLedger {
  if (input.policy.mode === "metadata_ledger_enabled" && input.persistentStore === undefined) {
    throw new Error("Persistent delivery ledger store is required when metadata ledger is enabled.");
  }

  return {
    writeDeliveryAttempt(row) {
      input.operationalLedger.writeDeliveryAttempt(row);

      if (input.policy.mode === "metadata_ledger_enabled") {
        input.persistentStore?.writeDeliveryAttempt(row);
      }
    }
  };
}

export function createMetadataLedgerReader(input: {
  rows: DeliveryLedgerRow[];
  requestTenants: Record<string, string>;
  auditLog: MetadataLedgerAuditLog;
}): MetadataLedgerReader {
  return {
    readDeliveryMetadata({ serviceIdentity, requestId }) {
      const requestTenantId = input.requestTenants[requestId];
      if (requestTenantId === undefined || requestTenantId !== serviceIdentity.tenant_id) {
        return {
          ok: false,
          status: "not_found",
          error: {
            code: "request_not_found",
            message: "Request was not found."
          }
        };
      }

      const readerRole = serviceIdentity.roles.find(
        (role): role is "ledger_viewer" | "auditor" =>
          role === "ledger_viewer" || role === "auditor"
      );
      if (readerRole === undefined) {
        return {
          ok: false,
          status: "forbidden",
          error: {
            code: "ledger_role_required",
            message: "Reading metadata ledger rows requires ledger_viewer or auditor role."
          }
        };
      }

      const rows = input.rows
        .filter((row) => row.request_id === requestId)
        .map((row) => structuredClone(row));

      input.auditLog.write({
        event: "watasu.metadata_ledger_read",
        tenant_id: serviceIdentity.tenant_id,
        request_id: requestId,
        role: readerRole,
        row_count: rows.length
      });

      return {
        ok: true,
        rows
      };
    }
  };
}

export function runMetadataLedgerRetention(input: {
  now: Date;
  retentionDays: number;
  store: RetentionDeliveryLedgerStore;
}): MetadataLedgerRetentionResult {
  const rows = input.store.listDeliveryRows();
  const cutoffMs = input.now.getTime() - input.retentionDays * 24 * 60 * 60 * 1000;
  const expiredRows = rows.filter((row) => new Date(row.delivered_at).getTime() < cutoffMs);

  if (expiredRows.length > 0) {
    input.store.deleteDeliveryRows(expiredRows);
  }

  return {
    ok: true,
    scanned: rows.length,
    deleted: expiredRows.length,
    retained: rows.length - expiredRows.length
  };
}
