import { describe, expect, test } from "vitest";
import { sha256Hash } from "./hash.js";
import type { DeliveryLedger, DeliveryLedgerRow } from "./delivery.js";
import { createPolicyControlledDeliveryLedger } from "./storage-policy.js";

function createLedgerRow(): DeliveryLedgerRow {
  return {
    request_id: "event-attendee-intake",
    request_version: "v1",
    idempotency_key: "submit-001",
    submitted_at: "2026-06-14T11:59:00.000Z",
    delivered_at: "2026-06-14T12:00:00.000Z",
    delivery_status: "delivered",
    destination_url_hash: sha256Hash("https://receiver.example.com/watasu/intake"),
    encrypted_payload_hash: sha256Hash("encrypted-payload"),
    webhook_status: 204
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
});
