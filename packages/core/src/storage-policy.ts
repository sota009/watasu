import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { DeliveryLedger, DeliveryLedgerRow } from "./delivery.js";
import { canonicalizeJson } from "./request-definition.js";
import { sha256Hash } from "./hash.js";
import type { Sha256Hash } from "./hash.js";
import type {
  AsyncIdempotencyStore,
  AsyncSubmissionRateLimiter,
  CapabilityRecord,
  CapabilityStatus,
  IdempotencyValidationClaim,
  SubmissionCapability
} from "./submission.js";
import type { PublishedRequestVersion } from "./request-version.js";

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
  listDeliveryRows(): DeliveryLedgerRow[] | Promise<DeliveryLedgerRow[]>;
  deleteDeliveryRows(rows: DeliveryLedgerRow[]): void | Promise<void>;
}

export interface PersistentCapabilityRegistry {
  issueCapability(input: {
    published: PublishedRequestVersion;
    url: string;
    issuedAt?: string | undefined;
  }): SubmissionCapability | Promise<SubmissionCapability>;
  revokeCapability(
    capability: Pick<SubmissionCapability, "url">,
    revokedAt?: string | undefined
  ): void | Promise<void>;
  rotateCapability(input: {
    published: PublishedRequestVersion;
    previous: Pick<SubmissionCapability, "url">;
    url: string;
    rotatedAt?: string | undefined;
  }): SubmissionCapability | Promise<SubmissionCapability>;
  resolveCapability(url: string): SubmissionCapability | Promise<SubmissionCapability>;
  listRecords(): CapabilityRecord[] | Promise<CapabilityRecord[]>;
}

export interface MetadataLedgerRetentionResult {
  ok: true;
  dry_run?: true;
  scanned: number;
  deleted: number;
  retained: number;
  would_delete?: number;
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

export class PostgresDeliveryLedgerStore implements PersistentDeliveryLedgerStore, RetentionDeliveryLedgerStore {
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

  async listDeliveryRows(): Promise<DeliveryLedgerRow[]> {
    const result = await this.#queryClient.query(
      `select
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
      from watasu_delivery_ledger
      where tenant_id = $1
      order by delivered_at asc`,
      [
        this.#tenantId
      ]
    );

    return result.rows.map((row) => sanitizeDeliveryLedgerRow(row as DeliveryLedgerRow));
  }

  async deleteDeliveryRows(rows: DeliveryLedgerRow[]): Promise<void> {
    const sanitizedRows = rows.map((row) => sanitizeDeliveryLedgerRow(row));
    for (const row of sanitizedRows) {
      await this.#queryClient.query(
        `delete from watasu_delivery_ledger
        where tenant_id = $1
          and request_id = $2
          and request_version = $3
          and idempotency_key = $4
          and delivered_at = $5`,
        [
          this.#tenantId,
          row.request_id,
          row.request_version,
          row.idempotency_key,
          row.delivered_at
        ]
      );
    }
  }
}

export class PostgresCapabilityRegistry implements PersistentCapabilityRegistry {
  readonly #queryClient: PostgresQueryClient;
  readonly #tenantId: string;

  constructor(input: {
    queryClient: PostgresQueryClient;
    tenantId: string;
  }) {
    this.#queryClient = input.queryClient;
    this.#tenantId = input.tenantId;
  }

  async issueCapability(input: {
    published: PublishedRequestVersion;
    url: string;
    issuedAt?: string | undefined;
  }): Promise<SubmissionCapability> {
    const issuedAt = input.issuedAt ?? new Date().toISOString();
    await this.#queryClient.query(
      `insert into watasu_capabilities (
        tenant_id,
        request_id,
        request_version,
        capability_hash,
        status,
        issued_at,
        revoked_at
      ) values ($1, $2, $3, $4, $5, $6, $7)
      on conflict (tenant_id, capability_hash) do update set
        request_id = excluded.request_id,
        request_version = excluded.request_version,
        status = excluded.status,
        issued_at = excluded.issued_at,
        revoked_at = excluded.revoked_at`,
      [
        this.#tenantId,
        input.published.request_id,
        input.published.request_version,
        sha256Hash(input.url),
        "active",
        issuedAt,
        null
      ]
    );

    return {
      url: input.url,
      revoked: false
    };
  }

  async revokeCapability(
    capability: Pick<SubmissionCapability, "url">,
    revokedAt: string = new Date().toISOString()
  ): Promise<void> {
    await this.#queryClient.query(
      `update watasu_capabilities
      set status = $1,
        revoked_at = $2
      where tenant_id = $3
        and capability_hash = $4`,
      [
        "revoked",
        revokedAt,
        this.#tenantId,
        sha256Hash(capability.url)
      ]
    );
  }

  async rotateCapability(input: {
    published: PublishedRequestVersion;
    previous: Pick<SubmissionCapability, "url">;
    url: string;
    rotatedAt?: string | undefined;
  }): Promise<SubmissionCapability> {
    await this.revokeCapability(input.previous, input.rotatedAt);
    return await this.issueCapability({
      published: input.published,
      url: input.url,
      issuedAt: input.rotatedAt
    });
  }

  async resolveCapability(url: string): Promise<SubmissionCapability> {
    const result = await this.#queryClient.query(
      `select status
      from watasu_capabilities
      where tenant_id = $1
        and capability_hash = $2
      limit 1`,
      [
        this.#tenantId,
        sha256Hash(url)
      ]
    );
    const row = result.rows[0] as { status?: unknown } | undefined;

    return {
      url,
      revoked: row?.status !== "active"
    };
  }

  async listRecords(): Promise<CapabilityRecord[]> {
    const result = await this.#queryClient.query(
      `select
        request_id,
        request_version,
        capability_hash,
        status,
        issued_at,
        revoked_at
      from watasu_capabilities
      where tenant_id = $1
      order by issued_at asc`,
      [
        this.#tenantId
      ]
    );

    return result.rows.map((row) => sanitizeCapabilityRecord(row));
  }
}

export class PostgresIdempotencyStore implements AsyncIdempotencyStore {
  readonly #queryClient: PostgresQueryClient;
  readonly #tenantId: string;

  constructor(input: {
    queryClient: PostgresQueryClient;
    tenantId: string;
  }) {
    this.#queryClient = input.queryClient;
    this.#tenantId = input.tenantId;
  }

  async claimValidation(
    recordKey: string,
    claim: IdempotencyValidationClaim
  ): Promise<boolean> {
    const result = await this.#queryClient.query(
      `insert into watasu_idempotency_claims (
        tenant_id,
        request_id,
        request_version,
        idempotency_key_hash,
        submitted_at,
        claimed_at,
        status
      ) values ($1, $2, $3, $4, $5, $6, $7)
      on conflict (tenant_id, request_id, request_version, idempotency_key_hash) do nothing
      returning idempotency_key_hash`,
      [
        this.#tenantId,
        claim.request_id,
        claim.request_version,
        sha256Hash(recordKey),
        claim.submitted_at,
        claim.claimed_at,
        claim.status
      ]
    );

    return result.rows.length > 0;
  }

  async releaseValidation(recordKey: string): Promise<void> {
    await this.#queryClient.query(
      `delete from watasu_idempotency_claims
      where tenant_id = $1
        and idempotency_key_hash = $2`,
      [
        this.#tenantId,
        sha256Hash(recordKey)
      ]
    );
  }
}

export class PostgresFixedWindowRateLimiter implements AsyncSubmissionRateLimiter {
  readonly #queryClient: PostgresQueryClient;
  readonly #tenantId: string;
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #clock: () => Date;

  constructor(input: {
    queryClient: PostgresQueryClient;
    tenantId: string;
    limit: number;
    windowMs: number;
    clock: () => Date;
  }) {
    this.#queryClient = input.queryClient;
    this.#tenantId = input.tenantId;
    this.#limit = input.limit;
    this.#windowMs = input.windowMs;
    this.#clock = input.clock;
  }

  async consume(key: string): Promise<boolean> {
    const windowStart = new Date(
      Math.floor(this.#clock().getTime() / this.#windowMs) * this.#windowMs
    ).toISOString();
    const keyHash = sha256Hash(key);

    await this.#queryClient.query(
      `delete from watasu_rate_limit_counters
      where tenant_id = $1
        and rate_limit_key_hash = $2
        and window_start < $3`,
      [
        this.#tenantId,
        keyHash,
        windowStart
      ]
    );

    const result = await this.#queryClient.query(
      `insert into watasu_rate_limit_counters (
        tenant_id,
        rate_limit_key_hash,
        window_start,
        hit_count
      ) values ($1, $2, $3, $4)
      on conflict (tenant_id, rate_limit_key_hash, window_start) do update set
        hit_count = watasu_rate_limit_counters.hit_count + 1,
        updated_at = now()
      where watasu_rate_limit_counters.hit_count < $5
      returning hit_count`,
      [
        this.#tenantId,
        keyHash,
        windowStart,
        1,
        this.#limit
      ]
    );

    return result.rows.length > 0;
  }
}

export function createPostgresFixedWindowRateLimiterSchemaSql(): string {
  return `create table if not exists watasu_rate_limit_counters (
  tenant_id text not null,
  rate_limit_key_hash text not null,
  window_start timestamptz not null,
  hit_count integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, rate_limit_key_hash, window_start)
);

create index if not exists watasu_rate_limit_counters_window_idx
  on watasu_rate_limit_counters (tenant_id, window_start);`;
}

export async function runPostgresFixedWindowRateLimiterMigration(input: {
  queryClient: PostgresQueryClient;
}): Promise<void> {
  await input.queryClient.query(createPostgresFixedWindowRateLimiterSchemaSql(), []);
}

export async function createMigratedPostgresFixedWindowRateLimiter(input: {
  tenantId: string;
  queryClient: PostgresQueryClient;
  limit: number;
  windowMs: number;
  clock: () => Date;
  runMigration?: boolean | undefined;
}): Promise<PostgresFixedWindowRateLimiter> {
  if (input.runMigration !== false) {
    await runPostgresFixedWindowRateLimiterMigration({
      queryClient: input.queryClient
    });
  }

  return new PostgresFixedWindowRateLimiter({
    tenantId: input.tenantId,
    queryClient: input.queryClient,
    limit: input.limit,
    windowMs: input.windowMs,
    clock: input.clock
  });
}

export function createPostgresIdempotencyStoreSchemaSql(): string {
  return `create table if not exists watasu_idempotency_claims (
  tenant_id text not null,
  request_id text not null,
  request_version text not null,
  idempotency_key_hash text not null,
  submitted_at timestamptz not null,
  claimed_at timestamptz not null,
  status text not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, request_id, request_version, idempotency_key_hash)
);

create index if not exists watasu_idempotency_claims_request_idx
  on watasu_idempotency_claims (tenant_id, request_id, request_version);

create index if not exists watasu_idempotency_claims_claimed_at_idx
  on watasu_idempotency_claims (tenant_id, claimed_at);`;
}

export async function runPostgresIdempotencyStoreMigration(input: {
  queryClient: PostgresQueryClient;
}): Promise<void> {
  await input.queryClient.query(createPostgresIdempotencyStoreSchemaSql(), []);
}

export async function createMigratedPostgresIdempotencyStore(input: {
  tenantId: string;
  queryClient: PostgresQueryClient;
  runMigration?: boolean | undefined;
}): Promise<PostgresIdempotencyStore> {
  if (input.runMigration !== false) {
    await runPostgresIdempotencyStoreMigration({
      queryClient: input.queryClient
    });
  }

  return new PostgresIdempotencyStore({
    tenantId: input.tenantId,
    queryClient: input.queryClient
  });
}

export function createPostgresCapabilityRegistrySchemaSql(): string {
  return `create table if not exists watasu_capabilities (
  tenant_id text not null,
  request_id text not null,
  request_version text not null,
  capability_hash text not null,
  status text not null,
  issued_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (tenant_id, capability_hash)
);

create index if not exists watasu_capabilities_request_idx
  on watasu_capabilities (tenant_id, request_id, request_version);

create index if not exists watasu_capabilities_status_idx
  on watasu_capabilities (tenant_id, status);`;
}

export async function runPostgresCapabilityRegistryMigration(input: {
  queryClient: PostgresQueryClient;
}): Promise<void> {
  await input.queryClient.query(createPostgresCapabilityRegistrySchemaSql(), []);
}

export async function createMigratedPostgresCapabilityRegistry(input: {
  tenantId: string;
  queryClient: PostgresQueryClient;
  runMigration?: boolean | undefined;
}): Promise<PostgresCapabilityRegistry> {
  if (input.runMigration !== false) {
    await runPostgresCapabilityRegistryMigration({
      queryClient: input.queryClient
    });
  }

  return new PostgresCapabilityRegistry({
    tenantId: input.tenantId,
    queryClient: input.queryClient
  });
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

function sanitizeCapabilityRecord(row: unknown): CapabilityRecord {
  const record = row as {
    request_id?: unknown;
    request_version?: unknown;
    capability_hash?: unknown;
    status?: unknown;
    issued_at?: unknown;
    revoked_at?: unknown;
  };
  const status: CapabilityStatus = record.status === "active" ? "active" : "revoked";
  const capabilityRecord: CapabilityRecord = {
    request_id: String(record.request_id ?? ""),
    request_version: String(record.request_version ?? ""),
    capability_hash: String(record.capability_hash ?? "") as Sha256Hash,
    status,
    issued_at: String(record.issued_at ?? "")
  };

  if (record.revoked_at !== undefined && record.revoked_at !== null) {
    capabilityRecord.revoked_at = String(record.revoked_at);
  }

  return capabilityRecord;
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

export async function runMetadataLedgerRetention(input: {
  dryRun?: boolean | undefined;
  now: Date;
  retentionDays: number;
  store: RetentionDeliveryLedgerStore;
}): Promise<MetadataLedgerRetentionResult> {
  const rows = await input.store.listDeliveryRows();
  const cutoffMs = input.now.getTime() - input.retentionDays * 24 * 60 * 60 * 1000;
  const expiredRows = rows.filter((row) => new Date(row.delivered_at).getTime() < cutoffMs);

  if (input.dryRun === true) {
    return {
      ok: true,
      dry_run: true,
      scanned: rows.length,
      deleted: 0,
      retained: rows.length,
      would_delete: expiredRows.length
    };
  }

  if (expiredRows.length > 0) {
    await input.store.deleteDeliveryRows(expiredRows);
  }

  return {
    ok: true,
    scanned: rows.length,
    deleted: expiredRows.length,
    retained: rows.length - expiredRows.length
  };
}

export async function runHostedMetadataLedgerRetentionJob(input: {
  dryRun?: boolean | undefined;
  serviceIdentity: HostedServiceIdentity;
  now: Date;
  retentionDays: number;
  store: RetentionDeliveryLedgerStore;
}): Promise<HostedMetadataLedgerRetentionJobResult> {
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
    ...await runMetadataLedgerRetention({
      dryRun: input.dryRun,
      now: input.now,
      retentionDays: input.retentionDays,
      store: input.store
    })
  };
}
