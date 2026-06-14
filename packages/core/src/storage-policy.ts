import type { DeliveryLedger, DeliveryLedgerRow } from "./delivery.js";

export type StoragePolicyMode = "stateless_default" | "metadata_ledger_enabled";

export interface StoragePolicy {
  mode: StoragePolicyMode;
}

export interface PersistentDeliveryLedgerStore {
  writeDeliveryAttempt(row: DeliveryLedgerRow): void;
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
