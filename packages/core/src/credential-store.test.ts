import { describe, expect, test } from "vitest";
import { InMemoryCredentialStore, type CredentialRecord } from "./credential-store.js";

function record(overrides: Partial<CredentialRecord> = {}): CredentialRecord {
  return {
    credentialId: "cred-123",
    publicKey: new Uint8Array([1, 2, 3]),
    signCount: 0,
    backupEligible: true,
    backupState: true,
    userHandle: "user-abc",
    transports: ["internal", "hybrid"],
    aaguid: "00000000-0000-0000-0000-000000000000",
    createdAt: "2026-07-05T00:00:00.000Z",
    ...overrides
  };
}

describe("InMemoryCredentialStore", () => {
  test("test_save_then_find_returns_record", async () => {
    const store = new InMemoryCredentialStore();
    await store.save(record());
    expect(await store.findByCredentialId("cred-123")).toEqual(record());
  });

  test("test_find_unknown_returns_undefined", async () => {
    const store = new InMemoryCredentialStore();
    expect(await store.findByCredentialId("nope")).toBeUndefined();
  });

  test("test_update_sign_count_persists", async () => {
    const store = new InMemoryCredentialStore();
    await store.save(record({ signCount: 0 }));
    await store.updateSignCount("cred-123", 5);
    expect((await store.findByCredentialId("cred-123"))?.signCount).toBe(5);
  });
});
