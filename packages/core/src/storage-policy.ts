import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { DeliveryLedger, DeliveryLedgerRow } from "./delivery.js";
import { canonicalizeJson } from "./request-definition.js";

export type StoragePolicyMode = "stateless_default" | "metadata_ledger_enabled";

export interface StoragePolicy {
  mode: StoragePolicyMode;
}

export interface PersistentDeliveryLedgerStore {
  writeDeliveryAttempt(row: DeliveryLedgerRow): void | Promise<void>;
}

export interface PostgresQueryClient {
  query(
    text: string,
    values: readonly unknown[]
  ): Promise<{
    rows: unknown[];
  }>;
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

export type HostedMetadataLedgerRetentionJobResult =
  | (MetadataLedgerRetentionResult & {
      tenant_id: string;
    })
  | {
      ok: false;
      status: "forbidden";
      error: {
        code: "retention_auditor_role_required";
        message: string;
      };
    };

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

export class JsonlDeliveryLedgerStore implements PersistentDeliveryLedgerStore, RetentionDeliveryLedgerStore {
  readonly #filePath: string;

  constructor(input: {
    filePath: string;
  }) {
    this.#filePath = input.filePath;
    mkdirSync(dirname(input.filePath), {
      recursive: true
    });
    if (!existsSync(input.filePath)) {
      writeFileSync(input.filePath, "");
    }
  }

  writeDeliveryAttempt(row: DeliveryLedgerRow): void {
    appendFileSync(this.#filePath, `${canonicalizeJson(sanitizeDeliveryLedgerRow(row))}\n`);
  }

  listDeliveryRows(): DeliveryLedgerRow[] {
    const content = readFileSync(this.#filePath, "utf8");
    return content
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => sanitizeDeliveryLedgerRow(JSON.parse(line) as DeliveryLedgerRow));
  }

  deleteDeliveryRows(rows: DeliveryLedgerRow[]): void {
    const deletionKeys = new Set(rows.map((row) => canonicalizeJson(sanitizeDeliveryLedgerRow(row))));
    const retainedRows = this.listDeliveryRows()
      .filter((row) => !deletionKeys.has(canonicalizeJson(row)));
    const nextContent = retainedRows.length === 0
      ? ""
      : `${retainedRows.map((row) => canonicalizeJson(row)).join("\n")}\n`;
    writeFileSync(this.#filePath, nextContent);
  }
}

export class PostgresDeliveryLedgerStore implements PersistentDeliveryLedgerStore {
  readonly #queryClient: PostgresQueryClient;
  readonly #tenantId: string;

  constructor(input: {
    queryClient: PostgresQueryClient;
    tenantId: string;
  }) {
    this.#queryClient = input.queryClient;
    this.#tenantId = input.tenantId;
  }

  async writeDeliveryAttempt(row: DeliveryLedgerRow): Promise<void> {
    const metadata = sanitizeDeliveryLedgerRow(row);
    await this.#queryClient.query(
      `insert into watasu_delivery_ledger (
        tenant_id,
        request_id,
        request_version,
        idempotency_key,
        submitted_at,
        delivered_at,
        delivery_status,
        destination_url_hash,
        encrypted_payload_hash,
        webhook_status,
        error_code
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        this.#tenantId,
        metadata.request_id,
        metadata.request_version,
        metadata.idempotency_key,
        metadata.submitted_at,
        metadata.delivered_at,
        metadata.delivery_status,
        metadata.destination_url_hash,
        metadata.encrypted_payload_hash,
        metadata.webhook_status ?? null,
        metadata.error_code ?? null
      ]
    );
  }
}

export function createPostgresDeliveryLedgerSchemaSql(): string {
  return `create table if not exists watasu_delivery_ledger (
  tenant_id text not null,
  request_id text not null,
  request_version text not null,
  idempotency_key text not null,
  submitted_at timestamptz not null,
  delivered_at timestamptz not null,
  delivery_status text not null,
  destination_url_hash text not null,
  encrypted_payload_hash text not null,
  webhook_status integer,
  error_code text,
  created_at timestamptz not null default now(),
  primary key (tenant_id, request_id, request_version, idempotency_key, delivered_at)
);

create index if not exists watasu_delivery_ledger_request_idx
  on watasu_delivery_ledger (tenant_id, request_id, request_version);

create index if not exists watasu_delivery_ledger_idempotency_idx
  on watasu_delivery_ledger (tenant_id, request_id, request_version, idempotency_key);

create index if not exists watasu_delivery_ledger_delivered_at_idx
  on watasu_delivery_ledger (tenant_id, delivered_at);`;
}

export async function runPostgresDeliveryLedgerMigration(input: {
  queryClient: PostgresQueryClient;
}): Promise<void> {
  await input.queryClient.query(createPostgresDeliveryLedgerSchemaSql(), []);
}

export async function createMigratedPostgresDeliveryLedgerStore(input: {
  tenantId: string;
  queryClient: PostgresQueryClient;
  runMigration?: boolean | undefined;
}): Promise<PostgresDeliveryLedgerStore> {
  if (input.runMigration !== false) {
    await runPostgresDeliveryLedgerMigration({
      queryClient: input.queryClient
    });
  }

  return new PostgresDeliveryLedgerStore({
    tenantId: input.tenantId,
    queryClient: input.queryClient
  });
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
    async writeDeliveryAttempt(row) {
      await input.operationalLedger.writeDeliveryAttempt(row);

      if (input.policy.mode === "metadata_ledger_enabled") {
        await input.persistentStore?.writeDeliveryAttempt(row);
      }
    }
  };
}

function sanitizeDeliveryLedgerRow(row: DeliveryLedgerRow): DeliveryLedgerRow {
  return {
    request_id: row.request_id,
    request_version: row.request_version,
    idempotency_key: row.idempotency_key,
    submitted_at: row.submitted_at,
    delivered_at: row.delivered_at,
    delivery_status: row.delivery_status,
    destination_url_hash: row.destination_url_hash,
    encrypted_payload_hash: row.encrypted_payload_hash,
    webhook_status: row.webhook_status,
    error_code: row.error_code
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

export function runHostedMetadataLedgerRetentionJob(input: {
  serviceIdentity: HostedServiceIdentity;
  now: Date;
  retentionDays: number;
  store: RetentionDeliveryLedgerStore;
}): HostedMetadataLedgerRetentionJobResult {
  if (!input.serviceIdentity.roles.includes("auditor")) {
    return {
      ok: false,
      status: "forbidden",
      error: {
        code: "retention_auditor_role_required",
        message: "Hosted metadata retention jobs require the auditor role."
      }
    };
  }

  return {
    tenant_id: input.serviceIdentity.tenant_id,
    ...runMetadataLedgerRetention({
      now: input.now,
      retentionDays: input.retentionDays,
      store: input.store
    })
  };
}
