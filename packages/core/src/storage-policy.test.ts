import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { sha256Hash } from "./hash.js";
import type { DeliveryLedger, DeliveryLedgerRow } from "./delivery.js";
import {
  createMetadataLedgerReader,
  createPolicyControlledDeliveryLedger,
  JsonlDeliveryLedgerStore,
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
  test("test_default_hosted_mode_does_not_persist_delivery_metadata", () => {
    const operationalLedger = createMemoryLedger();
    const persistentStore = createMemoryLedger();
    const ledger = createPolicyControlledDeliveryLedger({
      policy: {
        mode: "stateless_default"
      },
      operationalLedger,
      persistentStore
    });

    ledger.writeDeliveryAttempt(createLedgerRow());

    expect(operationalLedger.rows).toHaveLength(1);
    expect(persistentStore.rows).toHaveLength(0);
  });

  test("test_optional_metadata_ledger_persists_delivery_metadata", () => {
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

    ledger.writeDeliveryAttempt(row);

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
});
