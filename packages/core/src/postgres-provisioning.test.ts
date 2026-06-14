import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { createPostgresDeliveryLedgerSchemaSql } from "./storage-policy.js";

const rootDir = new URL("../../../", import.meta.url);

describe("PostgreSQL provisioning artifact", () => {
  test("test_metadata_ledger_sql_matches_runtime_schema_generator", () => {
    // Arrange
    const sql = readFileSync(new URL("infra/postgres/metadata-ledger.sql", rootDir), "utf8").trim();

    // Act / Assert
    expect(sql).toBe(createPostgresDeliveryLedgerSchemaSql());
  });

  test("test_metadata_ledger_sql_does_not_include_secrets_or_payload_body", () => {
    // Arrange
    const sql = readFileSync(new URL("infra/postgres/metadata-ledger.sql", rootDir), "utf8");

    // Act / Assert
    expect(sql).not.toContain("WATASU_POSTGRES_URL");
    expect(sql).not.toContain("postgres://");
    expect(sql).not.toContain("encrypted_payload ");
    expect(sql).not.toContain("ciphertext");
    expect(sql).not.toContain("payload_body");
  });
});
