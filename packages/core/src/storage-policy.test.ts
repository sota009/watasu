import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { sha256Hash } from "./hash.js";
import type { DeliveryLedger, DeliveryLedgerRow } from "./delivery.js";
import {
  createMetadataLedgerReader,
  createPostgresDeliveryLedgerSchemaSql,
  createPolicyControlledDeliveryLedger,
  JsonlDeliveryLedgerStore,
  PostgresDeliveryLedgerStore,
  runHostedMetadataLedgerRetentionJob,
  runMetadataLedgerRetention,
  type MetadataLedgerAuditEvent
} from "./storage-policy.js";

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

  test("test_metadata_retention_deletes_expired_ledger_rows", () => {
    const deleted: DeliveryLedgerRow[] = [];
    const expired = createLedgerRow({
      idempotency_key: "expired-submit",
      delivered_at: "2026-06-01T12:00:00.000Z"
    });
    const active = createLedgerRow({
      idempotency_key: "active-submit",
      delivered_at: "2026-06-13T12:00:00.000Z"
    });

    const result = runMetadataLedgerRetention({
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

  test("test_metadata_retention_keeps_boundary_row", () => {
    const deleted: DeliveryLedgerRow[] = [];
    const boundary = createLedgerRow({
      delivered_at: "2026-06-07T12:00:00.000Z"
    });

    const result = runMetadataLedgerRetention({
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

  test("test_metadata_retention_summary_does_not_include_payload_body", () => {
    const expired = createLedgerRow({
      encrypted_payload_hash: sha256Hash("base64url-ciphertext"),
      delivered_at: "2026-06-01T12:00:00.000Z"
    });

    const result = runMetadataLedgerRetention({
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

  test("test_jsonl_delivery_ledger_store_supports_retention_deletes", () => {
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

      const result = runMetadataLedgerRetention({
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

  test("test_hosted_retention_job_requires_auditor_role", () => {
    const store = new JsonlDeliveryLedgerStore({
      filePath: join(mkdtempSync(join(tmpdir(), "watasu-ledger-")), "delivery-ledger.jsonl")
    });

    const result = runHostedMetadataLedgerRetentionJob({
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

  test("test_hosted_retention_job_deletes_expired_metadata_without_payload_body", () => {
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
      const result = runHostedMetadataLedgerRetentionJob({
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

  test("test_postgres_delivery_ledger_schema_is_metadata_only", () => {
    const schemaSql = createPostgresDeliveryLedgerSchemaSql();

    expect(schemaSql).toContain("create table if not exists watasu_delivery_ledger");
    expect(schemaSql).toContain("tenant_id text not null");
    expect(schemaSql).toContain("request_id text not null");
    expect(schemaSql).toContain("request_version text not null");
    expect(schemaSql).toContain("idempotency_key text not null");
    expect(schemaSql).toContain("encrypted_payload_hash text not null");
    expect(schemaSql).toContain("primary key (tenant_id, request_id, request_version, idempotency_key)");
    expect(schemaSql).toContain("create index if not exists watasu_delivery_ledger_request_idx");
    expect(schemaSql).toContain("create index if not exists watasu_delivery_ledger_delivered_at_idx");
    expect(schemaSql).not.toContain("encrypted_payload ");
    expect(schemaSql).not.toContain("ciphertext");
    expect(schemaSql).not.toContain("payload_body");
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
});
