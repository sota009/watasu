import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { sha256Hash } from "./hash.js";
import type { DeliveryLedger, DeliveryLedgerRow } from "./delivery.js";
import {
  createMetadataLedgerReader,
  createMigratedPostgresCapabilityRegistry,
  createPostgresCapabilityRegistrySchemaSql,
  createMigratedPostgresIdempotencyStore,
  createMigratedPostgresDeliveryLedgerStore,
  createMigratedPostgresFixedWindowRateLimiter,
  createPostgresDeliveryLedgerSchemaSql,
  createPostgresIdempotencyStoreSchemaSql,
  createPostgresFixedWindowRateLimiterSchemaSql,
  createPolicyControlledDeliveryLedger,
  JsonlDeliveryLedgerStore,
  PostgresCapabilityRegistry,
  PostgresDeliveryLedgerStore,
  PostgresIdempotencyStore,
  PostgresFixedWindowRateLimiter,
  runPostgresCapabilityRegistryMigration,
  runPostgresDeliveryLedgerMigration,
  runPostgresIdempotencyStoreMigration,
  runPostgresFixedWindowRateLimiterMigration,
  runHostedMetadataLedgerRetentionJob,
  runMetadataLedgerRetention,
  type MetadataLedgerAuditEvent
} from "./storage-policy.js";
import type { PublishedRequestVersion } from "./request-version.js";

function createLedgerRow(overrides: Partial<DeliveryLedgerRow> = {}): DeliveryLedgerRow {
  return {
    request_id: "event-attendee-intake",
    request_version: "v1",
    idempotency_key: "submit-001",
    submitted_at: "2026-06-14T11:59:00.000Z",
    delivered_at: "2026-06-14T12:00:00.000Z",
    delivery_status: "delivered",
    destination_url_hash: sha256Hash("https://receiver.example.com/watasu/intake"),
    encrypted_payload_hash: sha256Hash("encrypted-payload"),
    webhook_status: 204,
    ...overrides
  };
}

function createMemoryLedger(): DeliveryLedger & { rows: DeliveryLedgerRow[] } {
  const rows: DeliveryLedgerRow[] = [];

  return {
    rows,
    writeDeliveryAttempt(row) {
      rows.push(row);
    }
  };
}

function createPublishedRequest(): PublishedRequestVersion {
  return {
    request_id: "event-attendee-intake",
    request_version: "v1",
    definition: {
      name: "event-attendee-intake",
      schema_version: "2026-06-14",
      description: "Collect attendee details for ExampleConf.",
      fields: [],
      consent: {
        text: "ExampleConf uses this information only for event operations."
      },
      destination: {
        type: "webhook",
        url: "https://receiver.example.com/watasu/intake"
      },
      retention: {
        destination_policy: "Delete within 30 days after the event."
      },
      encryption: {
        mode: "required",
        algorithm: "JWE",
        key_management: "ECDH-ES+A256KW",
        content_encryption: "A256GCM",
        service_key_id: "jwk-thumbprint:sha256:example",
        public_key_jwk: {
          kty: "EC",
          crv: "P-256",
          x: "base64url-x",
          y: "base64url-y"
        }
      },
      metadata_retention: {
        days: 90
      },
      trust_profile: "public_capability"
    },
    hashes: {
      request_version_hash: sha256Hash("request-version"),
      schema_hash: sha256Hash("schema"),
      consent_text_hash: sha256Hash("consent"),
      field_purposes_hash: sha256Hash("field-purposes"),
      destination_policy_hash: sha256Hash("destination-policy"),
      public_key_fingerprint: sha256Hash("public-key")
    },
    published_at: "2026-06-14T12:00:00.000Z"
  };
}

describe("storage policy controlled delivery ledger", () => {
  test("test_default_hosted_mode_does_not_persist_delivery_metadata", async () => {
    const operationalLedger = createMemoryLedger();
    const persistentStore = createMemoryLedger();
    const ledger = createPolicyControlledDeliveryLedger({
      policy: {
        mode: "stateless_default"
      },
      operationalLedger,
      persistentStore
    });

    await ledger.writeDeliveryAttempt(createLedgerRow());

    expect(operationalLedger.rows).toHaveLength(1);
    expect(persistentStore.rows).toHaveLength(0);
  });

  test("test_optional_metadata_ledger_persists_delivery_metadata", async () => {
    const operationalLedger = createMemoryLedger();
    const persistentStore = createMemoryLedger();
    const row = createLedgerRow();
    const ledger = createPolicyControlledDeliveryLedger({
      policy: {
        mode: "metadata_ledger_enabled"
      },
      operationalLedger,
      persistentStore
    });

    await ledger.writeDeliveryAttempt(row);

    expect(persistentStore.rows).toEqual([row]);
  });

  test("test_optional_metadata_ledger_requires_persistent_store", () => {
    const operationalLedger = createMemoryLedger();

    expect(() =>
      createPolicyControlledDeliveryLedger({
        policy: {
          mode: "metadata_ledger_enabled"
        },
        operationalLedger
      })
    ).toThrow("Persistent delivery ledger store is required when metadata ledger is enabled.");
  });

  test("test_metadata_ledger_read_requires_ledger_viewer_role", () => {
    const auditEvents: MetadataLedgerAuditEvent[] = [];
    const reader = createMetadataLedgerReader({
      rows: [createLedgerRow()],
      requestTenants: {
        "event-attendee-intake": "tenant-a"
      },
      auditLog: {
        write(event) {
          auditEvents.push(event);
        }
      }
    });

    const result = reader.readDeliveryMetadata({
      serviceIdentity: {
        tenant_id: "tenant-a",
        roles: ["publisher"]
      },
      requestId: "event-attendee-intake"
    });

    expect(result).toMatchObject({
      ok: false,
      status: "forbidden",
      error: {
        code: "ledger_role_required"
      }
    });
    expect(auditEvents).toHaveLength(0);
  });

  test("test_metadata_ledger_read_hides_cross_tenant_existence", () => {
    const auditEvents: MetadataLedgerAuditEvent[] = [];
    const reader = createMetadataLedgerReader({
      rows: [createLedgerRow()],
      requestTenants: {
        "event-attendee-intake": "tenant-a"
      },
      auditLog: {
        write(event) {
          auditEvents.push(event);
        }
      }
    });

    const result = reader.readDeliveryMetadata({
      serviceIdentity: {
        tenant_id: "tenant-b",
        roles: ["ledger_viewer"]
      },
      requestId: "event-attendee-intake"
    });

    expect(result).toMatchObject({
      ok: false,
      status: "not_found",
      error: {
        code: "request_not_found"
      }
    });
    expect(auditEvents).toHaveLength(0);
  });

  test("test_metadata_ledger_viewer_reads_rows_and_writes_audit_event", () => {
    const row = createLedgerRow();
    const auditEvents: MetadataLedgerAuditEvent[] = [];
    const reader = createMetadataLedgerReader({
      rows: [row],
      requestTenants: {
        "event-attendee-intake": "tenant-a"
      },
      auditLog: {
        write(event) {
          auditEvents.push(event);
        }
      }
    });

    const result = reader.readDeliveryMetadata({
      serviceIdentity: {
        tenant_id: "tenant-a",
        roles: ["ledger_viewer"]
      },
      requestId: "event-attendee-intake"
    });

    expect(result).toEqual({
      ok: true,
      rows: [row]
    });
    expect(auditEvents).toEqual([
      {
        event: "watasu.metadata_ledger_read",
        tenant_id: "tenant-a",
        request_id: "event-attendee-intake",
        role: "ledger_viewer",
        row_count: 1
      }
    ]);
  });

  test("test_metadata_retention_deletes_expired_ledger_rows", async () => {
    const deleted: DeliveryLedgerRow[] = [];
    const expired = createLedgerRow({
      idempotency_key: "expired-submit",
      delivered_at: "2026-06-01T12:00:00.000Z"
    });
    const active = createLedgerRow({
      idempotency_key: "active-submit",
      delivered_at: "2026-06-13T12:00:00.000Z"
    });

    const result = await runMetadataLedgerRetention({
      now: new Date("2026-06-14T12:00:00.000Z"),
      retentionDays: 7,
      store: {
        listDeliveryRows() {
          return [expired, active];
        },
        deleteDeliveryRows(rows) {
          deleted.push(...rows);
        }
      }
    });

    expect(result).toEqual({
      ok: true,
      scanned: 2,
      deleted: 1,
      retained: 1
    });
    expect(deleted).toEqual([expired]);
  });

  test("test_metadata_retention_dry_run_reports_expired_rows_without_deleting", async () => {
    const deleted: DeliveryLedgerRow[] = [];
    const expired = createLedgerRow({
      idempotency_key: "expired-submit",
      delivered_at: "2026-06-01T12:00:00.000Z"
    });
    const active = createLedgerRow({
      idempotency_key: "active-submit",
      delivered_at: "2026-06-13T12:00:00.000Z"
    });

    const result = await runMetadataLedgerRetention({
      dryRun: true,
      now: new Date("2026-06-14T12:00:00.000Z"),
      retentionDays: 7,
      store: {
        listDeliveryRows() {
          return [expired, active];
        },
        deleteDeliveryRows(rows) {
          deleted.push(...rows);
        }
      }
    });

    expect(result).toEqual({
      ok: true,
      dry_run: true,
      scanned: 2,
      deleted: 0,
      retained: 2,
      would_delete: 1
    });
    expect(deleted).toHaveLength(0);
  });

  test("test_metadata_retention_keeps_boundary_row", async () => {
    const deleted: DeliveryLedgerRow[] = [];
    const boundary = createLedgerRow({
      delivered_at: "2026-06-07T12:00:00.000Z"
    });

    const result = await runMetadataLedgerRetention({
      now: new Date("2026-06-14T12:00:00.000Z"),
      retentionDays: 7,
      store: {
        listDeliveryRows() {
          return [boundary];
        },
        deleteDeliveryRows(rows) {
          deleted.push(...rows);
        }
      }
    });

    expect(result).toMatchObject({
      ok: true,
      deleted: 0,
      retained: 1
    });
    expect(deleted).toHaveLength(0);
  });

  test("test_metadata_retention_summary_does_not_include_payload_body", async () => {
    const expired = createLedgerRow({
      encrypted_payload_hash: sha256Hash("base64url-ciphertext"),
      delivered_at: "2026-06-01T12:00:00.000Z"
    });

    const result = await runMetadataLedgerRetention({
      now: new Date("2026-06-14T12:00:00.000Z"),
      retentionDays: 7,
      store: {
        listDeliveryRows() {
          return [expired];
        },
        deleteDeliveryRows() {}
      }
    });
    const resultJson = JSON.stringify(result);

    expect(resultJson).not.toContain("base64url-ciphertext");
    expect(resultJson).not.toContain("encrypted_payload");
    expect(resultJson).not.toContain("full_name");
  });

  test("test_jsonl_delivery_ledger_store_persists_metadata_only_rows", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "watasu-ledger-"));
    const filePath = join(tempDir, "delivery-ledger.jsonl");
    const store = new JsonlDeliveryLedgerStore({
      filePath
    });
    const rowWithUnexpectedPayload = {
      ...createLedgerRow(),
      encrypted_payload: {
        ciphertext: "base64url-ciphertext"
      }
    } as DeliveryLedgerRow;

    try {
      store.writeDeliveryAttempt(rowWithUnexpectedPayload);

      expect(store.listDeliveryRows()).toEqual([createLedgerRow()]);
      expect(readFileSync(filePath, "utf8")).not.toContain("\"encrypted_payload\"");
      expect(readFileSync(filePath, "utf8")).not.toContain("base64url-ciphertext");
    } finally {
      rmSync(tempDir, {
        recursive: true,
        force: true
      });
    }
  });

  test("test_jsonl_delivery_ledger_store_supports_retention_deletes", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "watasu-ledger-"));
    const filePath = join(tempDir, "delivery-ledger.jsonl");
    const store = new JsonlDeliveryLedgerStore({
      filePath
    });
    const expired = createLedgerRow({
      idempotency_key: "expired-submit",
      delivered_at: "2026-06-01T12:00:00.000Z"
    });
    const active = createLedgerRow({
      idempotency_key: "active-submit",
      delivered_at: "2026-06-13T12:00:00.000Z"
    });

    try {
      store.writeDeliveryAttempt(expired);
      store.writeDeliveryAttempt(active);

      const result = await runMetadataLedgerRetention({
        now: new Date("2026-06-14T12:00:00.000Z"),
        retentionDays: 7,
        store
      });

      expect(result).toMatchObject({
        ok: true,
        deleted: 1,
        retained: 1
      });
      expect(store.listDeliveryRows()).toEqual([active]);
    } finally {
      rmSync(tempDir, {
        recursive: true,
        force: true
      });
    }
  });

  test("test_hosted_retention_job_requires_auditor_role", async () => {
    const store = new JsonlDeliveryLedgerStore({
      filePath: join(mkdtempSync(join(tmpdir(), "watasu-ledger-")), "delivery-ledger.jsonl")
    });

    const result = await runHostedMetadataLedgerRetentionJob({
      serviceIdentity: {
        tenant_id: "tenant-a",
        roles: ["publisher"]
      },
      now: new Date("2026-06-14T12:00:00.000Z"),
      retentionDays: 7,
      store
    });

    expect(result).toMatchObject({
      ok: false,
      status: "forbidden",
      error: {
        code: "retention_auditor_role_required"
      }
    });
  });

  test("test_hosted_retention_job_deletes_expired_metadata_without_payload_body", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "watasu-ledger-"));
    const store = new JsonlDeliveryLedgerStore({
      filePath: join(tempDir, "delivery-ledger.jsonl")
    });
    store.writeDeliveryAttempt(createLedgerRow({
      idempotency_key: "expired-submit",
      encrypted_payload_hash: sha256Hash("base64url-ciphertext"),
      delivered_at: "2026-06-01T12:00:00.000Z"
    }));
    store.writeDeliveryAttempt(createLedgerRow({
      idempotency_key: "active-submit",
      delivered_at: "2026-06-13T12:00:00.000Z"
    }));

    try {
      const result = await runHostedMetadataLedgerRetentionJob({
        serviceIdentity: {
          tenant_id: "tenant-a",
          roles: ["auditor"]
        },
        now: new Date("2026-06-14T12:00:00.000Z"),
        retentionDays: 7,
        store
      });
      const resultJson = JSON.stringify(result);

      expect(result).toEqual({
        ok: true,
        tenant_id: "tenant-a",
        scanned: 2,
        deleted: 1,
        retained: 1
      });
      expect(resultJson).not.toContain("base64url-ciphertext");
      expect(resultJson).not.toContain("\"encrypted_payload\"");
      expect(store.listDeliveryRows()).toMatchObject([
        {
          idempotency_key: "active-submit"
        }
      ]);
    } finally {
      rmSync(tempDir, {
        recursive: true,
        force: true
      });
    }
  });

  test("test_postgres_delivery_ledger_store_writes_parameterized_metadata_only_row", async () => {
    const queries: Array<{
      text: string;
      values: readonly unknown[];
    }> = [];
    const store = new PostgresDeliveryLedgerStore({
      tenantId: "tenant-a",
      queryClient: {
        async query(text, values) {
          queries.push({
            text,
            values
          });
          return {
            rows: []
          };
        }
      }
    });
    const rowWithUnexpectedPayload = {
      ...createLedgerRow(),
      encrypted_payload: {
        ciphertext: "base64url-ciphertext"
      }
    } as DeliveryLedgerRow;

    await store.writeDeliveryAttempt(rowWithUnexpectedPayload);

    expect(queries).toHaveLength(1);
    expect(queries[0]?.text).toContain("insert into watasu_delivery_ledger");
    expect(queries[0]?.text).toContain("$1");
    expect(JSON.stringify(queries)).not.toContain("\"encrypted_payload\"");
    expect(JSON.stringify(queries)).not.toContain("base64url-ciphertext");
    expect(queries[0]?.values).toEqual([
      "tenant-a",
      "event-attendee-intake",
      "v1",
      "submit-001",
      "2026-06-14T11:59:00.000Z",
      "2026-06-14T12:00:00.000Z",
      "delivered",
      createLedgerRow().destination_url_hash,
      createLedgerRow().encrypted_payload_hash,
      204,
      null
    ]);
  });

  test("test_postgres_delivery_ledger_store_supports_retention_reads_and_deletes", async () => {
    const queries: Array<{
      text: string;
      values: readonly unknown[];
    }> = [];
    const active = createLedgerRow({
      idempotency_key: "active-submit",
      delivered_at: "2026-06-14T12:00:00.000Z"
    });
    const expired = createLedgerRow({
      idempotency_key: "expired-submit",
      delivered_at: "2026-06-01T12:00:00.000Z"
    });
    const store = new PostgresDeliveryLedgerStore({
      tenantId: "tenant-a",
      queryClient: {
        async query(text, values) {
          queries.push({
            text,
            values
          });
          return {
            rows: text.includes("select")
              ? [expired, active]
              : []
          };
        }
      }
    });

    const result = await runMetadataLedgerRetention({
      now: new Date("2026-06-15T00:00:00.000Z"),
      retentionDays: 7,
      store
    });

    expect(result).toEqual({
      ok: true,
      scanned: 2,
      deleted: 1,
      retained: 1
    });
    expect(queries[0]?.text).toContain("where tenant_id = $1");
    expect(queries[0]?.values).toEqual(["tenant-a"]);
    expect(queries[1]?.text).toContain("delete from watasu_delivery_ledger");
    expect(queries[1]?.text).toContain("tenant_id = $1");
    expect(queries[1]?.values).toEqual([
      "tenant-a",
      "event-attendee-intake",
      "v1",
      "expired-submit",
      "2026-06-01T12:00:00.000Z"
    ]);
    expect(JSON.stringify(queries)).not.toContain("\"encrypted_payload\"");
    expect(JSON.stringify(queries)).not.toContain("base64url-ciphertext");
  });

  test("test_postgres_delivery_ledger_schema_is_metadata_only", () => {
    const schemaSql = createPostgresDeliveryLedgerSchemaSql();

    expect(schemaSql).toContain("create table if not exists watasu_delivery_ledger");
    expect(schemaSql).toContain("tenant_id text not null");
    expect(schemaSql).toContain("request_id text not null");
    expect(schemaSql).toContain("request_version text not null");
    expect(schemaSql).toContain("idempotency_key text not null");
    expect(schemaSql).toContain("encrypted_payload_hash text not null");
    expect(schemaSql).toContain("primary key (tenant_id, request_id, request_version, idempotency_key, delivered_at)");
    expect(schemaSql).toContain("create index if not exists watasu_delivery_ledger_request_idx");
    expect(schemaSql).toContain("create index if not exists watasu_delivery_ledger_idempotency_idx");
    expect(schemaSql).toContain("create index if not exists watasu_delivery_ledger_delivered_at_idx");
    expect(schemaSql).not.toContain("encrypted_payload ");
    expect(schemaSql).not.toContain("ciphertext");
    expect(schemaSql).not.toContain("payload_body");
  });

  test("test_postgres_delivery_ledger_migration_runs_schema_sql_once", async () => {
    const queries: Array<{
      text: string;
      values: readonly unknown[];
    }> = [];

    await runPostgresDeliveryLedgerMigration({
      queryClient: {
        async query(text, values) {
          queries.push({
            text,
            values
          });
          return {
            rows: []
          };
        }
      }
    });

    expect(queries).toEqual([
      {
        text: createPostgresDeliveryLedgerSchemaSql(),
        values: []
      }
    ]);
    expect(JSON.stringify(queries)).not.toContain("\"encrypted_payload\"");
    expect(JSON.stringify(queries)).not.toContain("base64url-ciphertext");
  });

  test("test_create_migrated_postgres_delivery_ledger_store_runs_migration_before_write", async () => {
    const queries: Array<{
      text: string;
      values: readonly unknown[];
    }> = [];
    const store = await createMigratedPostgresDeliveryLedgerStore({
      tenantId: "tenant-a",
      queryClient: {
        async query(text, values) {
          queries.push({
            text,
            values
          });
          return {
            rows: []
          };
        }
      }
    });

    await store.writeDeliveryAttempt(createLedgerRow());

    expect(queries[0]).toEqual({
      text: createPostgresDeliveryLedgerSchemaSql(),
      values: []
    });
    expect(queries[1]?.values[0]).toBe("tenant-a");
  });

  test("test_policy_controlled_ledger_awaits_async_persistent_store", async () => {
    const writes: string[] = [];
    const ledger = createPolicyControlledDeliveryLedger({
      policy: {
        mode: "metadata_ledger_enabled"
      },
      operationalLedger: {
        writeDeliveryAttempt(row) {
          writes.push(`operational:${row.idempotency_key}`);
        }
      },
      persistentStore: {
        async writeDeliveryAttempt(row) {
          await Promise.resolve();
          writes.push(`persistent:${row.idempotency_key}`);
        }
      }
    });

    await ledger.writeDeliveryAttempt(createLedgerRow());

    expect(writes).toEqual([
      "operational:submit-001",
      "persistent:submit-001"
    ]);
  });

  test("test_postgres_capability_registry_stores_hash_only_and_resolves_revocation", async () => {
    const queries: Array<{
      text: string;
      values: readonly unknown[];
    }> = [];
    const capabilityUrl = "https://api.watasu.ai/requests/event-attendee-intake/submit?capability=secret-token";
    const store = new PostgresCapabilityRegistry({
      tenantId: "tenant-a",
      queryClient: {
        async query(text, values) {
          queries.push({
            text,
            values
          });
          return {
            rows: text.includes("select")
              ? [
                  {
                    request_id: "event-attendee-intake",
                    request_version: "v1",
                    capability_hash: sha256Hash(capabilityUrl),
                    status: "revoked",
                    issued_at: "2026-06-14T12:00:00.000Z",
                    revoked_at: "2026-06-14T12:05:00.000Z"
                  }
                ]
              : []
          };
        }
      }
    });

    const issued = await store.issueCapability({
      published: createPublishedRequest(),
      url: capabilityUrl,
      issuedAt: "2026-06-14T12:00:00.000Z"
    });
    await store.revokeCapability(issued, "2026-06-14T12:05:00.000Z");
    const resolved = await store.resolveCapability(capabilityUrl);

    expect(issued).toEqual({
      url: capabilityUrl,
      revoked: false
    });
    expect(resolved).toEqual({
      url: capabilityUrl,
      revoked: true
    });
    expect(queries[0]?.text).toContain("insert into watasu_capabilities");
    expect(queries[0]?.values).toContain(sha256Hash(capabilityUrl));
    expect(queries[1]?.text).toContain("update watasu_capabilities");
    expect(queries[2]?.text).toContain("select");
    expect(JSON.stringify(queries)).not.toContain("secret-token");
    expect(JSON.stringify(queries)).not.toContain(capabilityUrl);
  });

  test("test_postgres_capability_registry_schema_is_tokenless_metadata", () => {
    const schemaSql = createPostgresCapabilityRegistrySchemaSql();

    expect(schemaSql).toContain("create table if not exists watasu_capabilities");
    expect(schemaSql).toContain("tenant_id text not null");
    expect(schemaSql).toContain("capability_hash text not null");
    expect(schemaSql).toContain("status text not null");
    expect(schemaSql).toContain("primary key (tenant_id, capability_hash)");
    expect(schemaSql).toContain("create index if not exists watasu_capabilities_request_idx");
    expect(schemaSql).not.toContain("capability_url");
    expect(schemaSql).not.toContain("token");
    expect(schemaSql).not.toContain("encrypted_payload");
  });

  test("test_create_migrated_postgres_capability_registry_runs_migration_before_issue", async () => {
    const queries: Array<{
      text: string;
      values: readonly unknown[];
    }> = [];
    const store = await createMigratedPostgresCapabilityRegistry({
      tenantId: "tenant-a",
      queryClient: {
        async query(text, values) {
          queries.push({
            text,
            values
          });
          return {
            rows: []
          };
        }
      }
    });

    await store.issueCapability({
      published: createPublishedRequest(),
      url: "https://api.watasu.ai/requests/event-attendee-intake/submit",
      issuedAt: "2026-06-14T12:00:00.000Z"
    });

    expect(queries[0]).toEqual({
      text: createPostgresCapabilityRegistrySchemaSql(),
      values: []
    });
    expect(queries[1]?.values[0]).toBe("tenant-a");
  });

  test("test_postgres_capability_registry_migration_runs_schema_sql_once", async () => {
    const queries: Array<{
      text: string;
      values: readonly unknown[];
    }> = [];

    await runPostgresCapabilityRegistryMigration({
      queryClient: {
        async query(text, values) {
          queries.push({
            text,
            values
          });
          return {
            rows: []
          };
        }
      }
    });

    expect(queries).toEqual([
      {
        text: createPostgresCapabilityRegistrySchemaSql(),
        values: []
      }
    ]);
  });

  test("test_postgres_idempotency_store_claims_hash_only_validation_metadata", async () => {
    const queries: Array<{
      text: string;
      values: readonly unknown[];
    }> = [];
    const store = new PostgresIdempotencyStore({
      tenantId: "tenant-a",
      queryClient: {
        async query(text, values) {
          queries.push({
            text,
            values
          });
          return {
            rows: [
              {
                idempotency_key_hash: sha256Hash("event-attendee-intake:v1:submit-001")
              }
            ]
          };
        }
      }
    });

    const claimed = await store.claimValidation("event-attendee-intake:v1:submit-001", {
      request_id: "event-attendee-intake",
      request_version: "v1",
      idempotency_key: "submit-001",
      submitted_at: "2026-06-14T11:59:00.000Z",
      claimed_at: "2026-06-14T12:00:00.000Z",
      status: "validation_accepted"
    });

    expect(claimed).toBe(true);
    expect(queries[0]?.text).toContain("insert into watasu_idempotency_claims");
    expect(queries[0]?.text).toContain("on conflict");
    expect(queries[0]?.values).toEqual([
      "tenant-a",
      "event-attendee-intake",
      "v1",
      sha256Hash("event-attendee-intake:v1:submit-001"),
      "2026-06-14T11:59:00.000Z",
      "2026-06-14T12:00:00.000Z",
      "validation_accepted"
    ]);
    expect(JSON.stringify(queries)).not.toContain("submit-001");
    expect(JSON.stringify(queries)).not.toContain("\"encrypted_payload\"");
  });

  test("test_postgres_idempotency_store_rejects_existing_claim_and_releases_by_hash", async () => {
    const queries: Array<{
      text: string;
      values: readonly unknown[];
    }> = [];
    const store = new PostgresIdempotencyStore({
      tenantId: "tenant-a",
      queryClient: {
        async query(text, values) {
          queries.push({
            text,
            values
          });
          return {
            rows: text.includes("insert") ? [] : []
          };
        }
      }
    });

    const claimed = await store.claimValidation("event-attendee-intake:v1:submit-001", {
      request_id: "event-attendee-intake",
      request_version: "v1",
      idempotency_key: "submit-001",
      submitted_at: "2026-06-14T11:59:00.000Z",
      claimed_at: "2026-06-14T12:00:00.000Z",
      status: "validation_accepted"
    });
    await store.releaseValidation("event-attendee-intake:v1:submit-001");

    expect(claimed).toBe(false);
    expect(queries[1]?.text).toContain("delete from watasu_idempotency_claims");
    expect(queries[1]?.values).toEqual([
      "tenant-a",
      sha256Hash("event-attendee-intake:v1:submit-001")
    ]);
    expect(JSON.stringify(queries)).not.toContain("submit-001");
  });

  test("test_postgres_idempotency_store_schema_is_hash_only_metadata", () => {
    const schemaSql = createPostgresIdempotencyStoreSchemaSql();

    expect(schemaSql).toContain("create table if not exists watasu_idempotency_claims");
    expect(schemaSql).toContain("tenant_id text not null");
    expect(schemaSql).toContain("idempotency_key_hash text not null");
    expect(schemaSql).toContain("status text not null");
    expect(schemaSql).toContain("primary key (tenant_id, request_id, request_version, idempotency_key_hash)");
    expect(schemaSql).toContain("create index if not exists watasu_idempotency_claims_request_idx");
    expect(schemaSql).not.toContain("idempotency_key text");
    expect(schemaSql).not.toContain("encrypted_payload");
    expect(schemaSql).not.toContain("payload_body");
  });

  test("test_create_migrated_postgres_idempotency_store_runs_migration_before_claim", async () => {
    const queries: Array<{
      text: string;
      values: readonly unknown[];
    }> = [];
    const store = await createMigratedPostgresIdempotencyStore({
      tenantId: "tenant-a",
      queryClient: {
        async query(text, values) {
          queries.push({
            text,
            values
          });
          return {
            rows: text.includes("insert") ? [{ idempotency_key_hash: "sha256:any" }] : []
          };
        }
      }
    });

    await store.claimValidation("event-attendee-intake:v1:submit-001", {
      request_id: "event-attendee-intake",
      request_version: "v1",
      idempotency_key: "submit-001",
      submitted_at: "2026-06-14T11:59:00.000Z",
      claimed_at: "2026-06-14T12:00:00.000Z",
      status: "validation_accepted"
    });

    expect(queries[0]).toEqual({
      text: createPostgresIdempotencyStoreSchemaSql(),
      values: []
    });
    expect(queries[1]?.values[0]).toBe("tenant-a");
  });

  test("test_postgres_idempotency_store_migration_runs_schema_sql_once", async () => {
    const queries: Array<{
      text: string;
      values: readonly unknown[];
    }> = [];

    await runPostgresIdempotencyStoreMigration({
      queryClient: {
        async query(text, values) {
          queries.push({
            text,
            values
          });
          return {
            rows: []
          };
        }
      }
    });

    expect(queries).toEqual([
      {
        text: createPostgresIdempotencyStoreSchemaSql(),
        values: []
      }
    ]);
  });

  test("test_postgres_fixed_window_rate_limiter_consumes_hash_only_counter", async () => {
    const queries: Array<{
      text: string;
      values: readonly unknown[];
    }> = [];
    const limiter = new PostgresFixedWindowRateLimiter({
      tenantId: "tenant-a",
      limit: 2,
      windowMs: 60_000,
      clock: () => new Date("2026-06-14T12:00:30.000Z"),
      queryClient: {
        async query(text, values) {
          queries.push({
            text,
            values
          });
          return {
            rows: text.includes("insert") ? [{ hit_count: 1 }] : []
          };
        }
      }
    });

    const consumed = await limiter.consume("event-attendee-intake:v1:secret-capability");

    expect(consumed).toBe(true);
    expect(queries[0]?.text).toContain("delete from watasu_rate_limit_counters");
    expect(queries[1]?.text).toContain("insert into watasu_rate_limit_counters");
    expect(queries[1]?.text).toContain("on conflict");
    expect(queries[1]?.text).toContain("updated_at = now()");
    expect(queries[1]?.text).toContain("where watasu_rate_limit_counters.hit_count < $5");
    expect(queries[1]?.values).toEqual([
      "tenant-a",
      sha256Hash("event-attendee-intake:v1:secret-capability"),
      "2026-06-14T12:00:00.000Z",
      1,
      2
    ]);
    expect(JSON.stringify(queries)).not.toContain("secret-capability");
    expect(JSON.stringify(queries)).not.toContain("\"encrypted_payload\"");
  });

  test("test_postgres_fixed_window_rate_limiter_rejects_when_atomic_upsert_returns_no_row", async () => {
    const limiter = new PostgresFixedWindowRateLimiter({
      tenantId: "tenant-a",
      limit: 2,
      windowMs: 60_000,
      clock: () => new Date("2026-06-14T12:00:30.000Z"),
      queryClient: {
        async query(text) {
          return {
            rows: text.includes("insert") ? [] : []
          };
        }
      }
    });

    const consumed = await limiter.consume("event-attendee-intake:v1:secret-capability");

    expect(consumed).toBe(false);
  });

  test("test_postgres_fixed_window_rate_limiter_schema_is_hash_only_metadata", () => {
    const schemaSql = createPostgresFixedWindowRateLimiterSchemaSql();

    expect(schemaSql).toContain("create table if not exists watasu_rate_limit_counters");
    expect(schemaSql).toContain("tenant_id text not null");
    expect(schemaSql).toContain("rate_limit_key_hash text not null");
    expect(schemaSql).toContain("hit_count integer not null");
    expect(schemaSql).toContain("primary key (tenant_id, rate_limit_key_hash, window_start)");
    expect(schemaSql).not.toContain("rate_limit_key text");
    expect(schemaSql).not.toContain("capability_url");
    expect(schemaSql).not.toContain("encrypted_payload");
  });

  test("test_create_migrated_postgres_fixed_window_rate_limiter_runs_migration_before_consume", async () => {
    const queries: Array<{
      text: string;
      values: readonly unknown[];
    }> = [];
    const limiter = await createMigratedPostgresFixedWindowRateLimiter({
      tenantId: "tenant-a",
      limit: 2,
      windowMs: 60_000,
      clock: () => new Date("2026-06-14T12:00:30.000Z"),
      queryClient: {
        async query(text, values) {
          queries.push({
            text,
            values
          });
          return {
            rows: text.includes("insert") ? [{ hit_count: 1 }] : []
          };
        }
      }
    });

    await limiter.consume("event-attendee-intake:v1:secret-capability");

    expect(queries[0]).toEqual({
      text: createPostgresFixedWindowRateLimiterSchemaSql(),
      values: []
    });
    expect(queries[2]?.values[0]).toBe("tenant-a");
  });

  test("test_postgres_fixed_window_rate_limiter_migration_runs_schema_sql_once", async () => {
    const queries: Array<{
      text: string;
      values: readonly unknown[];
    }> = [];

    await runPostgresFixedWindowRateLimiterMigration({
      queryClient: {
        async query(text, values) {
          queries.push({
            text,
            values
          });
          return {
            rows: []
          };
        }
      }
    });

    expect(queries).toEqual([
      {
        text: createPostgresFixedWindowRateLimiterSchemaSql(),
        values: []
      }
    ]);
  });
});
